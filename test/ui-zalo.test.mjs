import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><main id="app"></main>',{url:'https://localhost/'});
Object.assign(globalThis,{FileReader:dom.window.FileReader,window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true});
import {build} from 'esbuild';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
/** Gói ChatApp cùng một bản React/ReactDOM duy nhất để hooks hoạt động trong Node. */
const root0=fileURLToPath(new URL('..',import.meta.url));
const out=await build({stdin:{contents:`export {ChatApp,ZaloQr,createHostZaloProvider} from './src/ui/chat/index.ts';export {default as React} from 'react';export {createRoot} from 'react-dom/client';`,resolveDir:root0,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',target:'es2022',logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'}});
const file=join(await mkdtemp(join(tmpdir(),'op-chat-')),'m.mjs');
await writeFile(file,out.outputFiles[0].text);
const {ChatApp,ZaloQr,createHostZaloProvider,React,createRoot}=await import(pathToFileURL(file).href);
const {act}=React;
const tick=()=>act(async()=>{await new Promise(r=>setTimeout(r,10));});
const nowIso=new Date().toISOString();
async function mount(props){
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 await act(async()=>{root.render(React.createElement(ChatApp,{onFolderChange(){},...props}));});
 await tick();await tick();
 return {el,root,unmount:()=>act(()=>root.unmount())};
}
const btn=(el,text)=>[...el.querySelectorAll('button')].find(b=>b.textContent===text);
const click=(node,init={})=>act(async()=>{node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,...init}));});
const setVal=(node,v)=>act(async()=>{
 const proto=node instanceof window.HTMLTextAreaElement?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,'value').set.call(node,v);node.dispatchEvent(new window.Event('input',{bubbles:true}));
});

function fakeHost(opts={}){
 const calls=[];
 return {calls,host:{request:async(method,params)=>{
  if(method==='send'){
   assert.equal(typeof params.idempotencyKey,'string');
   const {idempotencyKey,...rest}=params;calls.push(['gateway.send',rest]);
   if(opts.sendFails)throw new Error('gateway');
   return {ok:true};
  }
  if(method==='channels.status')return {};
  assert.equal(method,'plugins.sessionAction');assert.equal(params.pluginId,'openclaw-personal');
  calls.push([params.actionId,params.payload]);
  const r=opts[params.actionId];
  return {ok:true,result:typeof r==='function'?r(params.payload):r};
 }}};
}
const CMD='openclaw config set plugins.entries.openclaw-personal.hooks.allowConversationAccess true --strict-json';
const defaults={
 'zalo.status':{historyAccess:'disabled',enableCommand:CMD},
 'zalo.conversations':({folder})=>({supported:true,conversations:[{id:'1',name:'An',kind:'direct',preview:'',lastAt:''},{id:'group:9',name:'Nhóm A',kind:'group',preview:'hi',lastAt:nowIso,subtitle:'3 thành viên'}].filter(c=>folder!=='group'||c.kind==='group')}),
 'zalo.messages':{messages:[],unavailable:'conversation-access-disabled'},
 'zalo.send':{ok:true},
};
test('provider: ánh xạ operation zalo.*',async()=>{
 const f=fakeHost(defaults);const p=createHostZaloProvider(f.host);
 assert.deepEqual(await p.listAccounts(),[{id:'zalo',name:'Zalo'}]);
 const all=await p.listConversations({folder:'all'});
 assert.equal(all.length,2);assert.equal(all[0].accountId,'zalo');assert.equal(all[0].unread,0);
 assert.equal((await p.listConversations({folder:'group'})).length,1);
 for(const folder of ['unread','stranger','blocked','spam'])assert.deepEqual(await p.listConversations({folder}),[]);
 assert.equal(f.calls.filter(c=>c[0]==='zalo.conversations').length,2);
 await p.send('1','xin chào');assert.deepEqual(f.calls.filter(c=>c[0]==='gateway.send').at(-1),['gateway.send',{channel:'zalouser',to:'1',message:'xin chào'}]);
 assert.deepEqual(f.calls.at(-1),['zalo.message.record',{conversationId:'1',text:'xin chào'}]);
 const n=await p.getHistoryNotice();assert.equal(n.command,CMD);
 const ok=createHostZaloProvider(fakeHost({'zalo.status':{historyAccess:'enabled',enableCommand:CMD}}).host);
 assert.equal(await ok.getHistoryNotice(),null);
 await assert.rejects(createHostZaloProvider(fakeHost({sendFails:true}).host).send('1','x'),/Gateway không gửi được/);
 await assert.rejects(p.block('1'),/unsupported/);
});
test('UI Zalo: danh sách, empty state hướng dẫn bật quyền, vẫn gửi được',async()=>{
 const f=fakeHost(defaults);
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host)});
 assert.ok(m.el.textContent.includes('Nhóm A'));
 const note=m.el.querySelector('.op-chat__notice');
 assert.ok(note);assert.equal(note.querySelector('code').textContent,CMD);
 assert.ok(m.el.textContent.includes('Chưa có tin nhắn nào được lưu'));
 await setVal(m.el.querySelector('textarea'),'chào An');
 await click(btn(m.el,'Gửi'));await tick();
 assert.deepEqual(f.calls.filter(c=>c[0]==='gateway.send').at(-1),['gateway.send',{channel:'zalouser',to:'1',message:'chào An'}]);
 await m.unmount();
});
test('UI Zalo: quyền đã bật thì không hiện hướng dẫn; thư mục chưa hỗ trợ giải thích rõ',async()=>{
 const f=fakeHost({...defaults,'zalo.status':{historyAccess:'enabled',enableCommand:CMD},'zalo.messages':{messages:[{id:'m',at:nowIso,text:'tin đã lưu',fromMe:false}],unavailable:null}});
 const p=createHostZaloProvider(f.host);
 const m=await mount({channel:'zalo',folder:'all',provider:p});
 assert.equal(m.el.querySelector('.op-chat__notice'),null);
 assert.ok(m.el.textContent.includes('tin đã lưu'));
 await m.unmount();
 const u=await mount({channel:'zalo',folder:'spam',provider:p});
 assert.ok(u.el.textContent.includes('Thư mục “Spam” chưa được hỗ trợ'));
 await u.unmount();
 const g=await mount({channel:'zalo',folder:'group',provider:p});
 assert.ok(g.el.textContent.includes('Nhóm A'));assert.ok(!g.el.textContent.includes('An3'));
 await g.unmount();
});
test.after(()=>{dom.window.close();setTimeout(()=>process.exit(process.exitCode??0),50).unref?.();});

test('nút "Bật lưu tin nhắn" gọi zalo.enableHistory rồi tải lại thông báo; lỗi hiện thông báo',async()=>{
 let enabled=false;
 const f=fakeHost({...defaults,'zalo.status':()=>({historyAccess:enabled?'enabled':'disabled',enableCommand:CMD}),'zalo.history.enable':()=>{enabled=true;return {ok:true};}});
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host)});
 await click(m.el.querySelector('.op-chat__row,li button,li')); await tick();
 const b=btn(m.el,'Bật lưu tin nhắn');assert.ok(b);
 await click(b);await tick();await tick();
 assert.ok(f.calls.some(c=>c[0]==='zalo.history.enable'));
 assert.equal(btn(m.el,'Bật lưu tin nhắn'),undefined);
 await m.unmount();
 const bad=fakeHost({...defaults,'zalo.history.enable':{ok:false,reason:'failed'}});
 const m2=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(bad.host)});
 await click(m2.el.querySelector('.op-chat__row,li button,li')); await tick();
 await click(btn(m2.el,'Bật lưu tin nhắn'));await tick();await tick();
 assert.match(m2.el.querySelector('[role=alert]').textContent,/Không bật được quyền/);
 await m2.unmount();
});

// jsdom không có URL.createObjectURL: giả lập, ghi lại blob đã tạo/thu hồi
const blobs=new Map();let blobSeq=0;const revoked=[];
URL.createObjectURL=b=>{const u=`blob:test/${++blobSeq}`;blobs.set(u,b);return u;};
URL.revokeObjectURL=u=>{revoked.push(u);};
const blobBytes=async b=>[...new Uint8Array(await b.arrayBuffer())];

test('ảnh đại diện: base64 -> blob URL (không data URI), thu hồi khi unmount, còn lại dùng chữ cái đầu',async()=>{
 blobs.clear();revoked.length=0;
 const f=fakeHost({...defaults,'zalo.conversations':{supported:true,conversations:[{id:'1',name:'An Bình',kind:'direct',preview:'',lastAt:'',hasAvatar:true},{id:'2',name:'Cường',kind:'direct',preview:'',lastAt:''}]},'zalo.avatar':({conversationId})=>conversationId==='1'?{avatar:'AQID',type:'image/jpeg'}:{avatar:null}});
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host)});
 await tick();
 const imgs=m.el.querySelectorAll('img.op-chat__avatar');
 assert.ok(imgs.length>=1);
 const src=imgs[0].getAttribute('src');assert.match(src,/^blob:test\//);
 assert.doesNotMatch(m.el.innerHTML,/data:image/);
 assert.equal(blobs.get(src).type,'image/jpeg');assert.deepEqual(await blobBytes(blobs.get(src)),[1,2,3]);
 assert.deepEqual([...new Set(f.calls.filter(c=>c[0]==='zalo.avatar').map(c=>c[1].conversationId))],['1']);
 assert.equal(blobs.size,1);// một URL dùng chung cho mọi chỗ hiển thị của cùng id
 assert.ok([...m.el.querySelectorAll('span.op-chat__avatar')].some(s=>s.textContent==='C'));
 await m.unmount();
 assert.deepEqual(revoked,[src]);
});
test('ảnh đại diện: mime lạ hoặc base64 hỏng thì dùng chữ cái đầu',async()=>{
 for(const bad of [{avatar:'AQID',type:'text/html'},{avatar:'***',type:'image/png'}]){
  const f=fakeHost({...defaults,'zalo.conversations':{supported:true,conversations:[{id:'1',name:'An Bình',kind:'direct',preview:'',lastAt:'',hasAvatar:true}]},'zalo.avatar':bad});
  const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host)});await tick();
  assert.equal(m.el.querySelectorAll('img.op-chat__avatar').length,0);
  assert.ok(m.el.querySelector('span.op-chat__avatar'));await m.unmount();
 }
});

// ---- Polling "realtime" ----
let visibility='visible';
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
const wait=ms=>act(async()=>{await new Promise(r=>setTimeout(r,ms));});
test('polling: tin mới xuất hiện sau vài tick, không mất nội dung đang soạn, dừng sau unmount',async()=>{
 visibility='visible';
 let msgs=[{id:'a',at:nowIso,text:'tin một',fromMe:false}];
 const f=fakeHost({...defaults,'zalo.messages':()=>({messages:msgs})});
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host),pollMs:{messages:20,conversations:40}});
 const ta=m.el.querySelector('textarea');await setVal(ta,'đang gõ dở');
 assert.ok(m.el.textContent.includes('tin một'));
 msgs=[...msgs,{id:'b',at:nowIso,text:'tin hai mới',fromMe:false}];
 await wait(120);
 assert.ok(m.el.textContent.includes('tin hai mới'));
 assert.equal(m.el.querySelector('textarea').value,'đang gõ dở');
 assert.ok(f.calls.filter(c=>c[0]==='zalo.conversations').length>=2);// danh sách cũng được làm mới
 await m.unmount();
 const n=f.calls.length;await wait(100);
 assert.equal(f.calls.length,n);
});
test('polling: dừng khi tab ẩn, không chồng request khi lượt trước chưa xong',async()=>{
 visibility='hidden';
 let inflight=0,maxInflight=0;
 const f=fakeHost({...defaults,'zalo.messages':async()=>{inflight++;maxInflight=Math.max(maxInflight,inflight);await new Promise(r=>setTimeout(r,70));inflight--;return {messages:[]};}});
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host),pollMs:{messages:10,conversations:0}});
 const base=f.calls.filter(c=>c[0]==='zalo.messages').length;
 await wait(80);
 assert.equal(f.calls.filter(c=>c[0]==='zalo.messages').length,base);// ẩn: không poll
 visibility='visible';
 await wait(200);
 assert.equal(maxInflight,1);
 assert.ok(f.calls.filter(c=>c[0]==='zalo.messages').length>base);
 await m.unmount();
});

test('nhóm không có ảnh hiện biểu tượng nhóm, người dùng không ảnh hiện chữ cái đầu',async()=>{
 const f=fakeHost({...defaults,'zalo.conversations':{supported:true,conversations:[{id:'group:9',name:'[JAM x A] Dự án',kind:'group',preview:'',lastAt:''},{id:'2',name:'Cường',kind:'direct',preview:'',lastAt:''}]}});
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host)});
 assert.ok(m.el.querySelector('.op-chat__avatar--group svg'));
 assert.ok(![...m.el.querySelectorAll('span.op-chat__avatar--group')].some(s=>s.textContent.includes('JA')));
 assert.ok([...m.el.querySelectorAll('span.op-chat__avatar:not(.op-chat__avatar--group)')].some(s=>s.textContent==='C'));
 await m.unmount();
});

test('ZaloQr: lệnh chờ lỗi nhưng kênh đã liên kết -> vẫn báo đã liên kết, không báo lỗi',async()=>{
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 let linked=0,calls=0;
 await act(async()=>{root.render(React.createElement(ZaloQr,{start:async()=>({qrDataUrl:'data:image/png;base64,AAAA',sessionKey:'s'}),wait:async()=>{calls++;throw new Error('timeout');},check:async()=>calls>=2,retryMs:1,onLinked:()=>linked++,onClose(){}}));});
 for(let i=0;i<10&&!linked;i++)await tick();
 assert.equal(linked,1);
 assert.ok(!el.textContent.includes('Không tạo được mã QR'));
 await act(()=>root.unmount());
});
test('ZaloQr: chờ lỗi mãi và chưa liên kết -> báo thất bại có nút Thử lại',async()=>{
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 const realNow=Date.now;let t=realNow();Date.now=()=>{t+=60_000;return t;};
 try{
  await act(async()=>{root.render(React.createElement(ZaloQr,{start:async()=>({qrDataUrl:'data:image/png;base64,AAAA'}),wait:async()=>{throw new Error('x');},check:async()=>false,retryMs:1,onLinked(){},onClose(){}}));});
  for(let i=0;i<10;i++)await tick();
  assert.ok(btn(el,'Thử lại'));
 }finally{Date.now=realNow;}
 await act(()=>root.unmount());
});

test('provider: đồng bộ tài khoản Zalo hiện tại (channels.status) trước khi liệt kê, chỉ khi id đổi',async()=>{
 const calls=[];let uid='111';
 const host={request:async(method,params)=>{
  if(method==='channels.status')return {channelAccounts:{zalouser:[{profile:{userId:uid}}]}};
  calls.push([params.actionId,params.payload]);
  return {ok:true,result:params.actionId==='zalo.conversations'?{supported:true,conversations:[]}:{ok:true,reset:true}};
 }};
 const p=createHostZaloProvider(host);
 await p.listConversations({folder:'all'});await p.listConversations({folder:'all'});
 assert.deepEqual(calls.filter(c=>c[0]==='zalo.account.sync'),[['zalo.account.sync',{userId:'111'}]]);
 assert.equal(calls[0][0],'zalo.account.sync'); // đồng bộ trước khi đọc danh sách
 uid='222';await p.listConversations({folder:'all'});
 assert.deepEqual(calls.filter(c=>c[0]==='zalo.account.sync').map(c=>c[1].userId),['111','222']);
});

test('gửi tệp: nút đính kèm, chip tên tệp, gateway send kèm buffer/filename/contentType, lưu bản ghi',async()=>{
 const f=fakeHost(defaults);
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host)});
 await click(m.el.querySelector('.op-chat__row,li button,li'));await tick();
 assert.ok(m.el.querySelector('button[aria-label="Đính kèm tệp"]'));
 const input=m.el.querySelector('input[type=file]');
 const file=new window.File([new Uint8Array([1,2,3])],'bao-gia.pdf',{type:'application/pdf'});
 Object.defineProperty(input,'files',{value:[file],configurable:true});
 await act(async()=>{input.dispatchEvent(new window.Event('change',{bubbles:true}));});
 for(let i=0;i<10&&!m.el.querySelector('[data-testid=attached-file]');i++)await tick();
 assert.match(m.el.querySelector('[data-testid=attached-file]').textContent,/bao-gia\.pdf/);
 await setVal(m.el.querySelector('textarea'),'Gửi anh');
 await click(btn(m.el,'Gửi'));await tick();await tick();
 const g=f.calls.find(c=>c[0]==='gateway.send');
 assert.equal(g[1].filename,'bao-gia.pdf');assert.equal(g[1].contentType,'application/pdf');assert.equal(g[1].buffer,'AQID');assert.equal(g[1].message,'Gửi anh');
 assert.ok(f.calls.some(c=>c[0]==='zalo.message.record'&&/bao-gia\.pdf/.test(c[1].text)));
 assert.equal(m.el.querySelector('[data-testid=attached-file]'),null);
 await m.unmount();
});
test('sự kiện đẩy tin mới: tải lại hội thoại ngay',async()=>{
 let listener;let n=0;
 const f=fakeHost({...defaults,'zalo.messages':()=>{n++;return {messages:[],unavailable:null};}});
 f.host.onEvent=(name,cb)=>{assert.equal(name,'plugin.openclaw-personal.zalo-message');listener=cb;return()=>{listener=undefined;};};
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host),pollMs:{messages:0,conversations:0}});
 await click(m.el.querySelector('.op-chat__row,li button,li'));await tick();
 const before=n;assert.ok(listener);
 await act(async()=>{listener({conversationId:'1'});});await tick();await tick();
 assert.ok(n>before);
 await m.unmount();assert.equal(listener,undefined);
});

const ACCESS_LABELS=['Trợ lý AI: đọc và viết','Trợ lý AI: chỉ đọc','Trợ lý AI: không truy cập'];
const selectOf=el=>el.querySelector('select[aria-label="Quyền của trợ lý AI"]');
const pick=(node,v)=>act(async()=>{node.value=v;node.dispatchEvent(new window.Event('change',{bubbles:true}));});

test('quyền trợ lý AI: tải khi mở hội thoại, đổi là lưu ngay theo hội thoại, báo trước khi gửi',async()=>{
 let stored={};
 const f=fakeHost({...defaults,'zalo.access.get':({conversationId})=>({access:stored[conversationId]??'write'}),'zalo.access.set':({conversationId,access})=>{stored[conversationId]=access;return {ok:true};}});
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host)});
 const sel=selectOf(m.el);
 assert.ok(sel);assert.deepEqual([...sel.options].map(o=>o.textContent),ACCESS_LABELS);
 assert.equal(sel.value,'write');
 assert.deepEqual(f.calls.find(c=>c[0]==='zalo.access.get'),['zalo.access.get',{conversationId:'1'}]);
 await pick(sel,'read');await tick();
 assert.equal(selectOf(m.el).value,'read');
 assert.deepEqual(f.calls.filter(c=>c[0]==='zalo.access.set').at(-1),['zalo.access.set',{conversationId:'1',access:'read'}]);
 await setVal(m.el.querySelector('textarea'),'chào');await click(btn(m.el,'Gửi'));await tick();
 const names=f.calls.map(c=>c[0]);
 assert.ok(names.indexOf('zalo.send.allow')<names.indexOf('gateway.send'));
 assert.deepEqual(f.calls.find(c=>c[0]==='zalo.send.allow'),['zalo.send.allow',{conversationId:'1',text:'chào'}]);
 await m.unmount();
});
test('quyền trợ lý AI: lưu lỗi thì hoàn tác và báo lỗi; tải lỗi thì ẩn ô chọn; provider không hỗ trợ thì không hiện',async()=>{
 const f=fakeHost({...defaults,'zalo.access.get':{access:'none'},'zalo.access.set':{ok:false}});
 const m=await mount({channel:'zalo',folder:'all',provider:createHostZaloProvider(f.host)});
 assert.equal(selectOf(m.el).value,'none');
 await pick(selectOf(m.el),'write');await tick();
 assert.equal(selectOf(m.el).value,'none');
 assert.ok(m.el.querySelector('[role=alert]').textContent.includes('Không đổi được quyền'));
 await m.unmount();
 const base=createHostZaloProvider(fakeHost(defaults).host);
 const bad=await mount({channel:'zalo',folder:'all',provider:{...base,getAccess:async()=>{throw new Error('x');}}});
 assert.equal(selectOf(bad.el),null);await bad.unmount();
 const none=await mount({channel:'zalo',folder:'all',provider:{...base,getAccess:undefined,setAccess:undefined}});
 assert.equal(selectOf(none.el),null);await none.unmount();
});
