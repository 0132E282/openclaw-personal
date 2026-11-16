import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './_load.mjs';
const C=await loadTs('src/connectors/backend/gmail/gmailClient.ts');
const {createTokenStore}=await loadTs('src/connectors/backend/gmail/tokenStore.ts');
const {gmailOperations,GMAIL_OPERATION_IDS}=await loadTs('src/connectors/backend/gmail/contract.ts');
const SECRET_ACCESS='ACCESSSECRET',SECRET_REFRESH='REFRESHSECRET';
const mem=()=>{const files=new Map();return {read:async p=>files.get(p),create:async(p,c)=>{files.set(p,c);},remove:async p=>{files.delete(p);}};};
const jres=(status,body,headers={})=>({ok:status>=200&&status<300,status,headers:{get:n=>headers[n.toLowerCase()]??null},json:async()=>body});
const b64u=s=>Buffer.from(s).toString('base64url');
async function setup(handler,opts={}){
 const store=createTokenStore({io:mem(),dir:'/s',now:()=>0});
 const {id}=await store.save({address:'me@gmail.com',clientId:'cid',refreshToken:SECRET_REFRESH,accessToken:SECRET_ACCESS,expiresAt:Date.now()+3600e3});
 const calls=[];const sleeps=[];
 const fetch=async(url,init={})=>{calls.push({url,init,body:init.body&&init.body[0]==='{'?JSON.parse(init.body):undefined,params:new URL(url).searchParams});return handler({url,init,n:calls.length,calls});};
 const client=C.createGmailClient({fetch,store,now:()=>Date.now(),sleep:async ms=>{sleeps.push(ms);},random:k=>new Uint8Array(k),...opts});
 return {id,store,client,calls,sleeps};
}
const decodeRaw=raw=>Buffer.from(raw,'base64url').toString('utf8');

test('folder -> nhãn; stranger/blocked không gọi API và báo supported:false',async()=>{
 assert.deepEqual(C.FOLDER_LABELS.unread,['INBOX','UNREAD']);assert.deepEqual(C.FOLDER_LABELS.spam,['SPAM']);assert.deepEqual(C.FOLDER_LABELS.trash,['TRASH']);
 const t=await setup(async()=>jres(200,{}));
 for(const f of ['stranger','blocked'])assert.deepEqual(await t.client.listMessages(t.id,{folder:f}),{messages:[],nextPageToken:null,supported:false});
 assert.equal(t.calls.length,0);
 await assert.rejects(t.client.moveToFolder(t.id,['m1'],'block'),e=>e.code==='unsupported');
 await assert.rejects(t.client.moveToFolder(t.id,['m1'],'deletePermanent'),e=>e.code==='unsupported');
});

test('listMessages: nhãn truy vấn, giới hạn, ánh xạ Message, tiêu đề mã hóa',async()=>{
 const t=await setup(async({url,calls})=>{
  if(url.includes('/messages?'))return jres(200,{messages:[{id:'m1'},{id:'m2'}]});
  return jres(200,{id:url.includes('/m1?')?'m1':'m2',labelIds:url.includes('/m1?')?['INBOX','UNREAD']:['SPAM'],snippet:'sn',internalDate:'1700000000000',payload:{headers:[{name:'From',value:'=?UTF-8?B?'+Buffer.from('Nguyễn A').toString('base64')+'?= <a@x.com>'},{name:'To',value:'b@x.com, c@x.com'},{name:'Subject',value:'=?UTF-8?Q?caf=C3=A9?='}]}});
 });
 const r=await t.client.listMessages(t.id,{folder:'unread',limit:5000});
 const q=t.calls[0].params;
 assert.deepEqual(q.getAll('labelIds'),['INBOX','UNREAD']);assert.equal(q.get('maxResults'),'100');
 assert.equal(t.calls[0].init.headers.Authorization,'Bearer '+SECRET_ACCESS);
 assert.equal(r.messages.length,2);assert.equal(r.nextPageToken,null);
 const m=r.messages[0];
 assert.deepEqual([m.id,m.unread,m.box,m.subject,m.from.name,m.from.address,m.to,m.date],['m1',true,'inbox','café','Nguyễn A','a@x.com',['b@x.com','c@x.com'],'2023-11-14T22:13:20.000Z']);
 assert.equal(r.messages[1].box,'spam');
 const s=await setup(async({url})=>jres(200,url.includes('/messages?')?{messages:[]}:{}));
 await s.client.listMessages(s.id,{folder:'trash'});assert.equal(s.calls[0].params.get('includeSpamTrash'),'true');
});

test('phân trang giới hạn: dừng ở MAX_PAGES và khi đủ limit',async()=>{
 let page=0;
 const t=await setup(async({url})=>{if(url.includes('/messages?')){page++;return jres(200,{messages:[{id:'p'+page}],nextPageToken:'T'+page});}return jres(200,{id:'x'});});
 const r=await t.client.listMessages(t.id,{folder:'all',limit:50});
 assert.equal(t.calls.filter(c=>c.url.includes('/messages?')).length,C.MAX_PAGES);
 assert.equal(r.nextPageToken,'T'+C.MAX_PAGES);
});

test('getMessage full: giải mã text/html từ payload nhiều phần',async()=>{
 const t=await setup(async()=>jres(200,{id:'m1',labelIds:['INBOX'],payload:{mimeType:'multipart/alternative',headers:[{name:'From',value:'a@x.com'}],parts:[{mimeType:'text/plain',body:{data:b64u('xin chào')}},{mimeType:'text/html',body:{data:b64u('<b>hi</b>')}}]}}));
 const m=await t.client.getMessage(t.id,'m1');
 assert.equal(m.text,'xin chào');assert.equal(m.html,'<b>hi</b>');assert.equal(t.calls[0].params.get('format'),'full');
 await assert.rejects(t.client.getMessage(t.id,'../x'),e=>e.code==='invalid-input');
});

test('401 -> refresh đúng 1 lần rồi retry; 401 lần hai -> reauth-required',async()=>{
 const t=await setup(async({url,n})=>{
  if(url.startsWith('https://oauth2.googleapis.com'))return jres(200,{access_token:'FRESH',expires_in:3600});
  return n===1?jres(401,{}):jres(200,{emailAddress:'me@gmail.com',messagesTotal:3});
 });
 assert.deepEqual(await t.client.getProfile(t.id),{address:'me@gmail.com',messagesTotal:3});
 const refreshes=t.calls.filter(c=>c.url.includes('oauth2'));assert.equal(refreshes.length,1);
 assert.equal(t.calls[2].init.headers.Authorization,'Bearer FRESH');
 assert.equal((await t.store.load(t.id)).accessToken,'FRESH');
 const u=await setup(async({url})=>url.includes('oauth2')?jres(200,{access_token:'F',expires_in:3600}):jres(401,{}));
 await assert.rejects(u.client.getProfile(u.id),e=>e.code==='reauth-required');
 assert.equal(u.calls.filter(c=>c.url.includes('oauth2')).length,1);
});

test('refresh trả invalid_grant -> reauth-required và đánh dấu needsReauth, lỗi không lộ token',async()=>{
 const t=await setup(async({url})=>url.includes('oauth2')?jres(400,{error:'invalid_grant'}):jres(401,{}));
 await assert.rejects(t.client.getProfile(t.id),e=>{assert.equal(e.code,'reauth-required');assert.doesNotMatch(JSON.stringify(e)+e.message+e.stack,/SECRET/);return true;});
 assert.equal((await t.store.list())[0].needsReauth,true);
});

test('token hết hạn được làm mới trước khi gọi; 429/5xx retry có giới hạn với backoff',async()=>{
 const store=createTokenStore({io:mem(),dir:'/s'});
 const {id}=await store.save({address:'a@b.c',clientId:'cid',refreshToken:'R',accessToken:'OLD',expiresAt:1});
 const calls=[];const sleeps=[];
 const client=C.createGmailClient({store,now:()=>1000,sleep:async ms=>sleeps.push(ms),fetch:async url=>{calls.push(url);return url.includes('oauth2')?jres(200,{access_token:'NEW',expires_in:3600}):jres(200,{emailAddress:'a@b.c'});}});
 await client.getProfile(id);assert.ok(calls[0].includes('oauth2'));
 let n=0;const t=await setup(async()=>(++n<3?jres(429,{},{'retry-after':'2'}):jres(200,{emailAddress:'a@b.c'})));
 await t.client.getProfile(t.id);assert.deepEqual(t.sleeps,[2000,2000]);
 const e5=await setup(async()=>jres(503,{}));
 await assert.rejects(e5.client.getProfile(e5.id),e=>e.code==='server-error'&&e.status===503);
 assert.equal(e5.calls.length,4);assert.deepEqual(e5.sleeps,[500,1000,2000]);
 const e4=await setup(async()=>jres(429,{}));await assert.rejects(e4.client.getProfile(e4.id),e=>e.code==='rate-limited');
 const e404=await setup(async()=>jres(404,{}));await assert.rejects(e404.client.getMessage(e404.id,'m1'),e=>e.code==='not-found');assert.equal(e404.calls.length,1);
 const net=await setup(async()=>{throw new Error(SECRET_ACCESS);});
 await assert.rejects(net.client.getProfile(net.id),e=>e.code==='network'&&!e.message.includes('SECRET'));
});

test('markRead/move dùng modify (1 thư) hoặc batchModify (nhiều), nhãn đúng',async()=>{
 const t=await setup(async()=>jres(200,{}));
 await t.client.markRead(t.id,['m1','m2'],true);
 assert.ok(t.calls[0].url.endsWith('/messages/batchModify'));assert.deepEqual(t.calls[0].body,{ids:['m1','m2'],addLabelIds:[],removeLabelIds:['UNREAD']});
 await t.client.markRead(t.id,['m1'],false);
 assert.ok(t.calls[1].url.endsWith('/messages/m1/modify'));assert.deepEqual(t.calls[1].body.addLabelIds,['UNREAD']);
 await t.client.moveToFolder(t.id,['m1','m2'],'spam');assert.deepEqual([t.calls[2].body.addLabelIds,t.calls[2].body.removeLabelIds],[['SPAM'],['INBOX']]);
 await t.client.moveToFolder(t.id,['m1','m1'],'restore');assert.deepEqual([t.calls[3].body.addLabelIds,t.calls[3].body.removeLabelIds],[['INBOX'],['TRASH']]);
 await t.client.moveToFolder(t.id,['m1','m2'],'trash');assert.deepEqual(t.calls[4].body.addLabelIds,['TRASH']);
 await assert.rejects(t.client.markRead(t.id,['bad id'],true),e=>e.code==='invalid-input');
});

test('buildRawMessage: tiêu đề non-ASCII mã hóa RFC 2047, thân base64 UTF-8',()=>{
 const raw=C.buildRawMessage({to:['a@x.com','Tên <b@x.com>'],cc:['c@x.com'],subject:'Xin chào thế giới — kiểm tra tiêu đề rất dài để chia nhiều encoded-word',text:'Nội dung'},{now:()=>0});
 const [head,body]=raw.split('\r\n\r\n');
 assert.match(head,/^MIME-Version: 1\.0\r\n/);
 const subj=head.split('\r\nSubject: ')[1].split(/\r\n(?! )/)[0];
 const words=subj.split('\r\n ');assert.ok(words.length>1);
 for(const w of words){assert.match(w,/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);assert.ok(w.length<=75);}
 assert.equal(words.map(w=>Buffer.from(w.slice(10,-2),'base64').toString('utf8')).join(''),'Xin chào thế giới — kiểm tra tiêu đề rất dài để chia nhiều encoded-word');
 assert.match(head,/To: a@x\.com, =\?UTF-8\?B\?[^?]+\?= <b@x\.com>/);
 assert.match(head,/Content-Type: text\/plain; charset="UTF-8"/);
 assert.equal(Buffer.from(body.replace(/\r\n/g,''),'base64').toString('utf8'),'Nội dung');
 assert.equal(C.buildRawMessage({to:['a@x.com'],subject:'plain',text:'t'},{now:()=>0}).includes('Subject: plain\r\n'),true);
 const alt=C.buildRawMessage({to:['a@x.com'],subject:'s',text:'t',html:'<p>h</p>'},{now:()=>0,random:k=>new Uint8Array(k)});
 assert.match(alt,/multipart\/alternative; boundary="=_op_0+"/);assert.match(alt,/text\/html/);
});

test('chống CRLF injection ở To/Cc/Bcc/Subject/reply headers',()=>{
 const ok={to:['a@x.com'],subject:'s',text:'t'};const b=m=>C.buildRawMessage({...ok,...m},{now:()=>0});
 const bad=['x\r\nBcc: evil@x.com','x\nBcc: e@x.com','x\rY','a b','a\0b'];
 for(const v of bad){
  assert.throws(()=>b({subject:v}),e=>e.code==='invalid-input');
  assert.throws(()=>b({to:['a@x.com'+v]}),e=>e.code==='invalid-input');
  assert.throws(()=>b({cc:[v]}),e=>e.code==='invalid-input');
  assert.throws(()=>b({bcc:[v]}),e=>e.code==='invalid-input');
  assert.throws(()=>b({to:[`${v} <a@x.com>`]}),e=>e.code==='invalid-input');
  assert.throws(()=>b({inReplyTo:v}),e=>e.code==='invalid-input');
 }
 for(const v of ['not-an-address','a@x.com, b@x.com','<a@x.com','"Q" <a@x.com>>','A"B <a@x.com>'])assert.throws(()=>b({to:[v]}),e=>e.code==='invalid-input');
 assert.throws(()=>b({to:[]}),e=>e.code==='invalid-input');
 assert.throws(()=>b({text:'',html:''}),e=>e.code==='invalid-input');
});

test('send: raw base64url gửi tới messages/send; reply thêm In-Reply-To/References/threadId',async()=>{
 const t=await setup(async({url})=>{
  if(url.includes('/messages/orig'))return jres(200,{threadId:'TH1',payload:{headers:[{name:'Message-ID',value:'<m1@x>'},{name:'References',value:'<m0@x>'}]}});
  return jres(200,{id:'sent1',threadId:'TH1'});
 });
 const r=await t.client.send(t.id,{to:['a@x.com'],subject:'Re: chào',text:'ok',replyToId:'orig'});
 assert.deepEqual(r,{id:'sent1',threadId:'TH1'});
 const post=t.calls[1];assert.ok(post.url.endsWith('/messages/send'));assert.equal(post.body.threadId,'TH1');
 const raw=decodeRaw(post.body.raw);
 assert.match(raw,/In-Reply-To: <m1@x>\r\n/);assert.match(raw,/References: <m0@x> <m1@x>\r\n/);assert.match(raw,/Subject: =\?UTF-8\?B\?/);
 await assert.rejects(t.client.send(t.id,{to:['a@x.com\r\nBcc: e@x.com'],subject:'s',text:'t'}),e=>e.code==='invalid-input');
 assert.equal(t.calls.length,2);
});

test('contract: đủ 9 operation, không có trường token trong output',()=>{
 assert.deepEqual(Object.keys(gmailOperations).sort(),Object.values(GMAIL_OPERATION_IDS).sort());
 assert.equal(Object.keys(gmailOperations).length,9);
 for(const [id,op] of Object.entries(gmailOperations)){
  assert.ok(['query','action'].includes(op.kind),id);
  assert.doesNotMatch(JSON.stringify(op.output).match(/"properties":\{[^}]*/g)?.join()??"",/"(access|refresh)?[tT]oken"|[sS]ecret/,id);
 }
});
