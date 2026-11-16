import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './_load.mjs';
const {extractJson,parseDirectory,createZaloCli,ZaloCliError}=await loadTs('src/connectors/backend/zalo/cli.ts');
const {createZaloStore,MAX_MESSAGES_PER_CONVERSATION}=await loadTs('src/connectors/backend/zalo/store.ts');
const {createZaloService,detectHistoryAccess,normalizeInbound,normalizeOutbound}=await loadTs('src/connectors/backend/zalo/service.ts');
const {zaloOperations}=await loadTs('src/connectors/backend/zalo/contract.ts');
const {Value}=await import('typebox/value');

const NOISE='[plugins] fb-messenger: OpenClaw can\'t verify where this plugin came from. reason=x\nConfig warnings:\n- foo\n';
const mem=()=>{const f=new Map();return {f,io:{read:async p=>f.get(p),write:async(p,c)=>{f.set(p,c);}}};};

test('cli: extractJson bỏ qua dòng [plugins] và cảnh báo; lỗi khi không có JSON',()=>{
 assert.deepEqual(extractJson(NOISE+'[\n {"id":"1"}\n]\n'),[{id:'1'}]);
 assert.deepEqual(extractJson(NOISE+'{"a":1}\nrác sau'),{a:1});
 assert.throws(()=>extractJson(NOISE),e=>e instanceof ZaloCliError);
});
test('cli: parseDirectory chuẩn hóa user/group, bỏ phần tử hỏng',()=>{
 const u=parseDirectory([{kind:'user',id:'123',name:'An'},{id:'bad id!',name:'x'},{name:'noid'},{id:'456'}],'direct');
 assert.deepEqual(u,[{id:'123',name:'An',kind:'direct'},{id:'456',name:'456',kind:'direct'}]);
 const g=parseDirectory([{kind:'group',id:'group:9',name:'Nhóm',raw:{memberCount:18}}],'group');
 assert.deepEqual(g,[{id:'group:9',name:'Nhóm',kind:'group',memberCount:18}]);
 assert.throws(()=>parseDirectory({},'direct'));
});
test('cli: gọi bằng mảng đối số, thử bin kế khi thiếu, ánh xạ lỗi, send dạng --opt=value',async()=>{
 const calls=[];
 const run=async(file,args)=>{calls.push([file,args]);if(file==='a')return {code:null,stdout:'',stderr:'',missing:true};return {code:0,stdout:NOISE+'[{"id":"1","name":"An"}]',stderr:''};};
 const cli=createZaloCli({run,bins:['a','b']});
 assert.equal((await cli.list('direct')).length,1);
 assert.deepEqual(calls[1],['b',['directory','peers','list','--channel','zalouser','--json']]);
 await cli.send('group:5','-x $(rm) hi');
 assert.deepEqual(calls.at(-1)[1],['message','send','--channel','zalouser','--target=group:5','--message=-x $(rm) hi','--json']);
 const fail=code=>createZaloCli({run:async()=>code});
 await assert.rejects(fail({code:null,missing:true}).list('group'),{code:'cli-missing'});
 await assert.rejects(fail({code:1,stdout:'',stderr:'',timedOut:true}).list('group'),{code:'timeout'});
 await assert.rejects(fail({code:2,stdout:'',stderr:''}).send('1','x'),{code:'failed'});
 await assert.rejects(createZaloCli({run}).send('bad id','x'));
});

test('store: lưu, khử trùng, giới hạn, sắp xếp, phục hồi từ file hỏng',async()=>{
 const m=mem();const s=createZaloStore({io:m.io,file:'/z/h.json'});
 const msg=(id,at,t='hi')=>({conversationId:'1',kind:'direct',name:'An',message:{id,at,text:t,fromMe:false}});
 assert.equal(await s.append(msg('a','2026-01-01T00:00:02Z')),true);
 assert.equal(await s.append(msg('a','2026-01-01T00:00:02Z')),false);
 assert.equal(await s.append(msg('b','2026-01-01T00:00:01Z')),true);
 assert.equal(await s.append(msg('c','2026-01-01T00:00:03Z','   ')),false);
 assert.deepEqual((await s.messages('1')).map(x=>x.id),['b','a']);
 assert.equal((await s.summaries())[0].preview,'hi');
 await Promise.all(Array.from({length:MAX_MESSAGES_PER_CONVERSATION+20},(_,i)=>s.append(msg('n'+i,new Date(2026,1,1,0,0,i).toISOString()))));
 assert.equal((await s.messages('1')).length,MAX_MESSAGES_PER_CONVERSATION);
 const s2=createZaloStore({io:m.io,file:'/z/h.json'});
 assert.equal((await s2.messages('1')).length,MAX_MESSAGES_PER_CONVERSATION);
 const bad=createZaloStore({io:{read:async()=>'{rác',write:async()=>{}},file:'/x'});
 assert.deepEqual(await bad.messages('1'),[]);
});

test('service: detectHistoryAccess và normalizeInbound',()=>{
 assert.equal(detectHistoryAccess(undefined),'unknown');
 assert.equal(detectHistoryAccess({plugins:{entries:{}}}),'disabled');
 assert.equal(detectHistoryAccess({plugins:{entries:{'openclaw-personal':{hooks:{allowConversationAccess:true}}}}}),'enabled');
 assert.equal(normalizeInbound({content:'x'},{channelId:'telegram'},0),undefined);
 const d=normalizeInbound({content:'chào',senderId:'zalouser:77',messageId:'m1',timestamp:1700000000,metadata:{senderName:'An'}},{channelId:'zalouser'},0);
 assert.equal(d.conversationId,'77');assert.equal(d.name,'An');assert.equal(d.message.at,'2023-11-14T22:13:20.000Z');
 const g=normalizeInbound({content:'hi',senderId:'5',threadId:'group:9',metadata:{senderName:'Bo'}},{channelId:'zalouser'},0);
 assert.equal(g.conversationId,'group:9');assert.equal(g.kind,'group');assert.equal(g.message.author,'Bo');
});

function svc({access=true,list,sendFn}={}){
 const m=mem();const sent=[];
 const cli={list:async k=>{if(list)return list(k);return k==='group'?[{id:'group:9',name:'Nhóm A',kind:'group',memberCount:3}]:[{id:'1',name:'An',kind:'direct'},{id:'2',name:'Bình',kind:'direct'}];},send:async(id,t)=>{if(sendFn)return sendFn(id,t);sent.push([id,t]);}};
 const store=createZaloStore({io:m.io,file:'/z/h.json'});
 let t=Date.parse('2026-01-01T00:00:00Z');
 const s=createZaloService({cli,store,getConfig:()=>access===undefined?undefined:{plugins:{entries:{'openclaw-personal':{hooks:{allowConversationAccess:access}}}}},now:()=>t++});
 return {s,sent,store,h:s.handlers};
}
test('service: conversations hợp nhất danh bạ + tin đã lưu, lọc nhóm, thư mục chưa hỗ trợ',async()=>{
 const {s,h}=svc();
 await s.record({content:'xin chào',senderId:'2',messageId:'m'},{channelId:'zalouser'});
 await s.record({content:'người lạ',senderId:'99',messageId:'m9'},{channelId:'zalouser'});
 const first=await h['zalo.conversations']({folder:'all'});
 assert.equal(first.reason,'loading'); // lần đầu: danh bạ tải nền, không chặn
 await new Promise(r=>setTimeout(r,20));
 const all=await h['zalo.conversations']({folder:'all'});
 assert.equal(all.supported,true);
 assert.deepEqual(all.conversations.map(c=>c.id).slice(0,2).sort(),['2','99']);
 assert.equal(all.conversations.find(c=>c.id==='2').preview,'xin chào');
 assert.equal(all.conversations.find(c=>c.id==='group:9').subtitle,'3 thành viên');
 const g=await h['zalo.conversations']({folder:'group'});
 assert.deepEqual(g.conversations.map(c=>c.id),['group:9']);
 for(const f of ['unread','stranger','blocked','spam'])assert.deepEqual(await h['zalo.conversations']({folder:f}),{conversations:[],supported:false});
 for(const out of [all,g])assert.equal(Value.Check(zaloOperations['zalo.conversations'].output,out),true);
});
test('service: danh bạ lỗi toàn bộ -> reason; một nhánh lỗi vẫn trả nhánh kia; có cache',async()=>{
 const f=svc({list:async()=>{throw new ZaloCliError('timeout');}});
 assert.equal((await f.h['zalo.conversations']({folder:'all'})).reason,'loading');
 await new Promise(r=>setTimeout(r,20));
 assert.equal((await f.h['zalo.conversations']({folder:'all'})).reason,'timeout');
 let n=0;const p=svc({list:async k=>{n++;if(k==='group')throw new ZaloCliError('failed');return [{id:'1',name:'An',kind:'direct'}];}});
 await p.h['zalo.conversations']({folder:'all'});await new Promise(r=>setTimeout(r,20));
 const r=await p.h['zalo.conversations']({folder:'all'});assert.equal(r.conversations.length,1);assert.equal(r.reason,undefined);
 await p.h['zalo.conversations']({folder:'all'});assert.equal(n,2); // còn tươi: không gọi lại CLI
});
test('service: messages báo conversation-access-disabled; status trả lệnh bật',async()=>{
 const off=svc({access:false});
 assert.deepEqual(await off.h['zalo.messages']({conversationId:'1'}),{messages:[],unavailable:'conversation-access-disabled'});
 const st=await off.h['zalo.status']({});
 assert.equal(st.historyAccess,'disabled');
 assert.match(st.enableCommand,/^openclaw config set plugins\.entries\.openclaw-personal\.hooks\.allowConversationAccess true/);
 assert.equal(Value.Check(zaloOperations['zalo.status'].output,st),true);
 const on=svc({access:true});
 await on.s.record({content:'a',senderId:'1',messageId:'x'},{channelId:'zalouser'});
 const r=await on.h['zalo.messages']({conversationId:'1'});
 assert.equal(r.unavailable,null);assert.equal(r.messages.length,1);
 assert.equal(Value.Check(zaloOperations['zalo.messages'].output,r),true);
});
test('service: send lưu tin đi, ánh xạ lỗi, từ chối input sai',async()=>{
 const f=svc();
 assert.deepEqual(await f.h['zalo.send']({conversationId:'1',text:'hello'}),{ok:true});
 assert.deepEqual(f.sent,[['1','hello']]);
 const m=await f.h['zalo.messages']({conversationId:'1'});
 assert.equal(m.messages[0].fromMe,true);
 assert.deepEqual(await f.h['zalo.send']({conversationId:'a b',text:'x'}),{ok:false,reason:'invalid-input'});
 assert.deepEqual(await f.h['zalo.send']({conversationId:'1',text:'  '}),{ok:false,reason:'invalid-input'});
 const bad=svc({sendFn:async()=>{throw new ZaloCliError('timeout');}});
 assert.deepEqual(await bad.h['zalo.send']({conversationId:'1',text:'x'}),{ok:false,reason:'timeout'});
 assert.equal((await bad.h['zalo.messages']({conversationId:'1'})).messages.length,0);
});
test('service: enableHistory gọi CLI config set và ánh xạ lỗi',async()=>{
 const calls=[];
 const cli=createZaloCli({run:async(f,a)=>{calls.push(a);return {code:0,stdout:'',stderr:''};},bins:['openclaw']});
 await cli.enableHistory();
 assert.deepEqual(calls[0],['config','set','plugins.entries.openclaw-personal.hooks.allowConversationAccess','true','--strict-json']);
 const store=createZaloStore({io:mem().io,file:'/z/h.json'});
 const ok=createZaloService({cli,store,getConfig:()=>undefined});
 assert.deepEqual(await ok.handlers['zalo.history.enable']({}),{ok:true});
 const bad=createZaloService({cli:{enableHistory:async()=>{throw new ZaloCliError('timeout');}},store,getConfig:()=>undefined});
 const r=await bad.handlers['zalo.history.enable']({});
 assert.deepEqual(r,{ok:false,reason:'timeout'});
 assert.equal(Value.Check(zaloOperations['zalo.history.enable'].output,r),true);
});
test('avatars: chỉ tải https CDN Zalo, lưu file ảnh thật, dùng lại sau khi mở lại, đổi .txt cũ',async()=>{
 const {createAvatarStore,isZaloImageUrl}=await loadTs('src/connectors/backend/zalo/avatars.ts');
 assert.equal(isZaloImageUrl('https://s120-26-ava-talk.zadn.vn/a.jpg'),true);
 for(const u of ['http://x.zadn.vn/a','https://evil.com/a','https://zadn.vn.evil.com/a','file:///etc/passwd','x'])assert.equal(isZaloImageUrl(u),false);
 const {mkdtemp,readdir,readFile,writeFile,stat}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=join(await mkdtemp(join(tmpdir(),'av-')),'avatars');
 let n=0;const fetchImage=async()=>{n++;return {type:'image/jpeg',bytes:new Uint8Array([1,2,3])};};
 const s=createAvatarStore({dir,fetchImage});
 await s.ensure([{id:'1',avatarUrl:'https://a.zadn.vn/1'},{id:'2'}]);
 assert.deepEqual(s.get('1'),{type:'image/jpeg',base64:'AQID'});assert.equal(s.get('2'),undefined);assert.equal(n,1);
 assert.deepEqual(await readdir(dir),['1.jpg']);
 assert.deepEqual([...await readFile(join(dir,'1.jpg'))],[1,2,3]);
 assert.equal((await stat(join(dir,'1.jpg'))).mode&0o777,0o600);assert.equal((await stat(dir)).mode&0o777,0o700);
 const again=createAvatarStore({dir,fetchImage});await again.ensure([{id:'1',avatarUrl:'https://a.zadn.vn/1'}]);
 assert.equal(n,1);assert.deepEqual(again.get('1'),{type:'image/jpeg',base64:'AQID'});
 // tương thích: .txt data URI cũ được đổi thành ảnh rồi xóa
 await writeFile(join(dir,'7.txt'),'data:image/png;base64,AQID');await writeFile(join(dir,'8.txt'),'rác');
 const old=createAvatarStore({dir,fetchImage});await old.ready();
 assert.deepEqual(old.get('7'),{type:'image/png',base64:'AQID'});assert.equal(old.get('8'),undefined);
 assert.deepEqual((await readdir(dir)).sort(),['1.jpg','7.png']);
});
test('zalo.avatar trả base64 thuần + mime theo contract, không có tiền tố data:',async()=>{
 const avatars={ready:async()=>{},get:id=>id==='1'?{type:'image/png',base64:'AQID'}:undefined};
 const svc=createZaloService({cli:{},store:{},getConfig:()=>undefined,avatars});
 const hit=await svc.handlers['zalo.avatar']({conversationId:'1'});
 assert.deepEqual(hit,{avatar:'AQID',type:'image/png'});assert.equal(Value.Check(zaloOperations['zalo.avatar'].output,hit),true);
 const miss=await svc.handlers['zalo.avatar']({conversationId:'2'});
 assert.deepEqual(miss,{avatar:null});assert.equal(Value.Check(zaloOperations['zalo.avatar'].output,miss),true);
 assert.equal(Value.Check(zaloOperations['zalo.avatar'].output,{avatar:'data:image/png;base64,AQID'}),false);
});
test('service: đổi tài khoản Zalo xóa danh bạ, ảnh và lịch sử cũ; cùng tài khoản thì giữ',async()=>{
 const m=mem();let marker;const cleared=[];
 const store=createZaloStore({io:m.io,file:'/z/h.json'});
 const cli={list:async k=>k==='group'?[]:[{id:'1',name:'An',kind:'direct'}],send:async()=>{}};
 const s=createZaloService({cli,store,getConfig:()=>({plugins:{entries:{'openclaw-personal':{hooks:{allowConversationAccess:true}}}}}),
  account:{load:async()=>marker,save:async id=>{marker=id;}},
  avatars:{ready:async()=>{},ensure:async()=>{},get:()=>undefined,clear:async()=>{cleared.push('avatars');}},
  snapshot:{load:async()=>undefined,save:async e=>{cleared.push(e.length);}}});
 await s.record({content:'cũ',senderId:'1',messageId:'a'},{channelId:'zalouser'});
 assert.deepEqual(await s.handlers['zalo.account.sync']({userId:'111'}),{ok:true,reset:true}); // lần đầu: chưa biết -> xóa
 assert.equal((await store.messages('1')).length,0);
 await s.record({content:'mới',senderId:'1',messageId:'b'},{channelId:'zalouser'});
 assert.deepEqual(await s.handlers['zalo.account.sync']({userId:'111'}),{ok:true,reset:false});
 assert.equal((await store.messages('1')).length,1);
 assert.deepEqual(await s.handlers['zalo.account.sync']({userId:'222'}),{ok:true,reset:true}); // đổi tài khoản
 assert.equal((await store.messages('1')).length,0);
 assert.ok(cleared.includes('avatars'));assert.ok(cleared.includes(0));
 assert.deepEqual(await s.handlers['zalo.account.sync']({userId:'bad id'}),{ok:false,reset:false});
 assert.equal(Value.Check(zaloOperations['zalo.account.sync'].output,{ok:true,reset:true}),true);
});
test('outbound: message_sent lưu tin của agent (fromMe), bỏ tin lỗi/kênh khác, khử trùng với tin gửi từ app',async()=>{
 assert.equal(normalizeOutbound({content:'x',to:'5'},{channelId:'telegram'},0),undefined);
 assert.equal(normalizeOutbound({content:'x',to:'5',success:false},{channelId:'zalouser'},0),undefined);
 assert.equal(normalizeOutbound({content:'  ',to:'5'},{channelId:'zalouser'},0),undefined);
 const o=normalizeOutbound({content:'xin chào',to:'zalouser:77',messageId:'m1'},{channelId:'zalouser'},1700000000000);
 assert.equal(o.conversationId,'77');assert.equal(o.message.fromMe,true);assert.equal(o.message.id,'m1');
 const g=normalizeOutbound({text:'hi',target:'group:9'},{channelId:'zalouser'},0);
 assert.equal(g.conversationId,'group:9');assert.equal(g.kind,'group');
 const {s,store,h}=svc();
 await h['zalo.message.record']({conversationId:'77',text:'xin chào'}); // gửi từ app
 assert.equal(await s.recordSent({content:'xin chào',to:'77',messageId:'zz'},{channelId:'zalouser'}),undefined); // hook trùng -> bỏ
 assert.equal((await store.messages('77')).length,1);
 assert.deepEqual(await s.recordSent({content:'agent trả lời',to:'77',messageId:'a1'},{channelId:'zalouser'}),{conversationId:'77',accountId:'default'});
 assert.equal((await store.messages('77')).filter(m=>m.fromMe).length,2);
});
