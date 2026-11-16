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
const root0=fileURLToPath(new URL('..',import.meta.url));
const out=await build({stdin:{contents:`export {ChatApp,createHostMessengerProvider,messengerTimeToIso,ChatError} from './src/ui/chat/index.ts';export {default as React} from 'react';export {createRoot} from 'react-dom/client';`,resolveDir:root0,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',target:'es2022',logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'}});
const file=join(await mkdtemp(join(tmpdir(),'op-chat-')),'m.mjs');
await writeFile(file,out.outputFiles[0].text);
const {ChatApp,createHostMessengerProvider,messengerTimeToIso,ChatError,React,createRoot}=await import(pathToFileURL(file).href);
const {act}=React;
const tick=()=>act(async()=>{await new Promise(r=>setTimeout(r,10));});
async function mount(props){
 const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
 await act(async()=>{root.render(React.createElement(ChatApp,{onFolderChange(){},...props}));});
 await tick();await tick();
 return {el,unmount:()=>act(()=>root.unmount())};
}
const btn=(el,text)=>[...el.querySelectorAll('button')].find(b=>b.textContent===text);
const click=(node)=>act(async()=>{node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));});
const setVal=(node,v)=>act(async()=>{
 Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(node,v);node.dispatchEvent(new window.Event('input',{bubbles:true}));
});
function fakeHost(results){
 const calls=[];
 return {calls,host:{request:async(method,params)=>{
  assert.equal(method,'plugins.sessionAction');assert.equal(params.pluginId,'openclaw-personal');
  calls.push([params.actionId,params.payload]);
  const r=results[params.actionId];
  return {ok:true,result:typeof r==='function'?r(params.payload):r};
 }}};
}
const CONVS={ok:true,e2eeHidden:1,conversations:[
 {id:'111',title:'An',snippet:'chào bạn',time:'5 phút',unread:true,isGroup:false},
 {id:'222',title:'Nhóm A',snippet:'Bình: ok',time:'12:30',unread:false,isGroup:true}]};
const MSGS={ok:true,messages:[{id:'m0',from:'them',senderName:'An',text:'xin chào',time:''},{id:'m1',from:'me',senderName:'',text:'chào An',time:''}]};

test('messengerTimeToIso: giờ, tương đối, không hiểu thì rỗng',()=>{
 const now=new Date(2026,10,15,15,0,0);
 assert.equal(new Date(messengerTimeToIso('12:30',now)).getHours(),12);
 assert.equal(messengerTimeToIso('17:00',now)<now.toISOString(),true);
 assert.equal(messengerTimeToIso('5 phút',now),new Date(now.getTime()-300_000).toISOString());
 assert.equal(messengerTimeToIso('2h',now),new Date(now.getTime()-7_200_000).toISOString());
 assert.equal(messengerTimeToIso('3 ngày',now),new Date(now.getTime()-3*86_400_000).toISOString());
 for(const x of ['','Thứ Hai','vừa xong','5 năm'])assert.equal(messengerTimeToIso(x,now),'');
});
test('provider: ánh xạ messenger.* và không hỗ trợ tệp/hành động',async()=>{
 const f=fakeHost({'messenger.conversations':CONVS,'messenger.messages':MSGS,'messenger.send':{ok:true}});
 const p=createHostMessengerProvider(f.host);
 assert.deepEqual(await p.listAccounts(),[{id:'messenger',name:'Messenger'}]);
 const l=await p.listConversations({folder:'group'});
 assert.deepEqual(f.calls[0],['messenger.conversations',{folder:'group'}]);
 assert.deepEqual([l[0].id,l[0].accountId,l[0].name,l[0].kind,l[0].preview,l[0].unread],['111','messenger','An','direct','chào bạn',1]);
 assert.equal(l[1].kind,'group');assert.equal(l[1].unread,0);
 const m=await p.getMessages('111');
 assert.deepEqual([m[0].fromMe,m[0].author,m[0].text,m[1].fromMe,m[1].author],[false,'An','xin chào',true,undefined]);
 await p.send('111','hi');assert.deepEqual(f.calls.at(-1),['messenger.send',{conversationId:'111',text:'hi'}]);
 assert.equal(p.sendFile,undefined);
 await assert.rejects(p.block('1'),/unsupported/);
});
test('provider: lý do có cấu trúc -> ChatError tiếng Việt; hết hạn gọi onAuthLost',async()=>{
 let lost=0;
 const f=fakeHost({'messenger.conversations':{ok:false,reason:'not-logged-in',conversations:[],e2eeHidden:0},'messenger.messages':{ok:false,reason:'e2ee-locked',messages:[]},'messenger.send':{ok:false,reason:'rate-limited'}});
 const p=createHostMessengerProvider(f.host,{onAuthLost:()=>{lost++;}});
 await assert.rejects(p.listConversations({folder:'all'}),e=>e instanceof ChatError&&e.code==='not-logged-in'&&/hết hạn/.test(e.message));
 assert.equal(lost,1);
 await assert.rejects(p.getMessages('1'),e=>e instanceof ChatError&&e.code==='e2ee-locked'&&/PIN/.test(e.message));
 await assert.rejects(p.send('1','x'),e=>e.code==='rate-limited');
 assert.equal(lost,1);
 const c=createHostMessengerProvider(fakeHost({'messenger.conversations':{ok:false,reason:'checkpoint',conversations:[],e2eeHidden:0}}).host,{onAuthLost:()=>{lost++;}});
 await assert.rejects(c.listConversations({folder:'all'}),/xác minh/);assert.equal(lost,2);
});
test('UI Messenger: danh sách, tin nhắn, gửi tin và hiện lý do khi đọc lỗi',async()=>{
 const f=fakeHost({'messenger.conversations':CONVS,'messenger.messages':MSGS,'messenger.send':{ok:true}});
 const m=await mount({channel:'messenger',folder:'all',provider:createHostMessengerProvider(f.host),pollMs:{messages:0,conversations:0}});
 assert.ok(m.el.textContent.includes('Nhóm A'));
 assert.ok(m.el.textContent.includes('xin chào'));
 assert.ok(!m.el.textContent.includes('Chưa kết nối Messenger'));
 assert.equal(m.el.querySelector('[aria-label="Đính kèm"]'),null);
 await setVal(m.el.querySelector('textarea'),'chào An');
 await click(btn(m.el,'Gửi'));await tick();
 assert.deepEqual(f.calls.filter(c=>c[0]==='messenger.send').at(-1),['messenger.send',{conversationId:'111',text:'chào An'}]);
 await m.unmount();
 const bad=fakeHost({'messenger.conversations':{ok:false,reason:'selector-broken',conversations:[],e2eeHidden:0}});
 const m2=await mount({channel:'messenger',folder:'all',provider:createHostMessengerProvider(bad.host),pollMs:{messages:0,conversations:0}});
 assert.ok(m2.el.querySelector('[role=alert]').textContent.includes('đổi giao diện'));
 await m2.unmount();
});
test('UI Messenger: polling nhẹ gọi lại theo chu kỳ',async()=>{
 const f=fakeHost({'messenger.conversations':CONVS,'messenger.messages':MSGS});
 const m=await mount({channel:'messenger',folder:'all',provider:createHostMessengerProvider(f.host),pollMs:{messages:30,conversations:30}});
 const n0=f.calls.filter(c=>c[0]==='messenger.messages').length;
 await act(async()=>{await new Promise(r=>setTimeout(r,120));});
 assert.ok(f.calls.filter(c=>c[0]==='messenger.messages').length>n0);
 await m.unmount();
});
