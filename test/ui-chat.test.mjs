import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><main id="app"></main>',{url:'https://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Node:dom.window.Node,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true});
import {build} from 'esbuild';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
/** Gói ChatApp cùng một bản React/ReactDOM duy nhất để hooks hoạt động trong Node. */
const root0=fileURLToPath(new URL('..',import.meta.url));
const out=await build({stdin:{contents:`export {ChatApp} from './src/ui/chat/index.ts';export {default as React} from 'react';export {createRoot} from 'react-dom/client';`,resolveDir:root0,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',target:'es2022',logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'}});
const file=join(await mkdtemp(join(tmpdir(),'op-chat-')),'m.mjs');
await writeFile(file,out.outputFiles[0].text);
const {ChatApp,React,createRoot}=await import(pathToFileURL(file).href);
const {act}=React;
const tick=()=>act(async()=>{await new Promise(r=>setTimeout(r,10));});
const nowIso=new Date().toISOString();
function conv(id,name,extra={}){return {id,accountId:'a',name,kind:'direct',preview:'Xin chào '+name,lastAt:nowIso,unread:0,...extra};}
function fake(data={}){
 const calls=[];
 const rec=n=>async(...a)=>{calls.push([n,...a]);};
 const p={calls,
  listAccounts:async()=>data.accounts??[{id:'a',name:'Cá nhân'},{id:'b',name:'Công việc'}],
  listConversations:async({folder})=>(data.convs??{})[folder]??[conv('c1','Lê Khoa',{unread:2}),conv('c2','Nguyễn Vy'),conv('c3','Thanh Hà'),conv('c4','Quốc Đạt')],
  getMessages:async id=>[{id:'m1',at:nowIso,text:'Chào bạn '+id,fromMe:false},{id:'m2',at:nowIso,text:'Dạ chào',fromMe:true}],
  send:rec('send'),acceptStranger:rec('acceptStranger'),block:rec('block'),unblock:rec('unblock'),markSpam:rec('markSpam'),notSpam:rec('notSpam'),deleteConversation:rec('deleteConversation')};
 return p;
}
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

test('zalo chưa kết nối: QR + cảnh báo kênh không chính thức',async()=>{
 let qr=0;const m=await mount({channel:'zalo',folder:'all',onLinkQr:()=>qr++});
 assert.ok(m.el.textContent.includes('Chưa liên kết Zalo'));
 assert.ok(m.el.textContent.includes('có rủi ro bị khóa tài khoản'));
 await click(btn(m.el,'Liên kết bằng mã QR'));assert.equal(qr,1);
 await m.unmount();
});
test('không có tài khoản cũng là chưa kết nối',async()=>{
 const m=await mount({channel:'messenger',folder:'all',provider:fake({accounts:[]})});
 assert.ok(m.el.textContent.includes('Chưa kết nối Messenger'));await m.unmount();
});
test('messenger: modal cookie, 2 tab, callback và che giá trị',async()=>{
 let started=0;const got=[];
 const m=await mount({channel:'messenger',folder:'all',onStartBrowserLogin:()=>started++,onSubmitCookies:c=>{got.push(c);}});
 assert.equal(m.el.querySelector('[role=dialog]'),null);
 await click(btn(m.el,'Nhập cookie'));
 assert.ok(m.el.querySelector('[role=dialog]'));assert.equal(started,1);
 assert.ok(m.el.textContent.includes('Đang chờ bạn đăng nhập'));
 await click(btn(m.el,'Mở lại cửa sổ'));assert.equal(started,2);
 await click(btn(m.el,'Dán cookie thủ công'));
 const xs=m.el.querySelector('input[name=xs]');assert.equal(xs.type,'password');
 await click(btn(m.el,'Kiểm tra và kết nối'));
 assert.equal(got.length,0);assert.ok(m.el.querySelector('[role=alert]'));
 await setVal(m.el.querySelector('input[name=c_user]'),'615550001');
 await setVal(xs,'SECRET-XS');
 await setVal(m.el.querySelector('textarea'),'{"raw":"SECRET-RAW"}');
 await click(btn(m.el,'Kiểm tra và kết nối'));await tick();
 assert.deepEqual(got,[{cUser:'615550001',xs:'SECRET-XS',raw:'{"raw":"SECRET-RAW"}'}]);
 assert.equal(m.el.querySelector('[role=dialog]'),null);
 assert.ok(!m.el.innerHTML.includes('SECRET'));
 await m.unmount();
});
test('stranger: composer khóa và nút thao tác',async()=>{
 const p=fake();const m=await mount({channel:'zalo',folder:'stranger',provider:p});
 assert.equal(m.el.querySelector('textarea'),null);
 assert.ok(m.el.textContent.includes('Chấp nhận người này để trả lời'));
 for(const l of ['Chấp nhận','Chặn','Báo spam'])assert.ok(btn(m.el,l),l);
 await click(btn(m.el,'Chấp nhận'));
 assert.deepEqual(p.calls.at(-1),['acceptStranger','c1']);
 await m.unmount();
});
test('spam và blocked: nút đúng thư mục',async()=>{
 let m=await mount({channel:'messenger',folder:'spam',provider:fake()});
 for(const l of ['Không phải spam','Xóa vĩnh viễn','Chặn'])assert.ok(btn(m.el,l),l);
 assert.equal(m.el.querySelector('textarea'),null);await m.unmount();
 const p=fake();m=await mount({channel:'zalo',folder:'blocked',provider:p});
 for(const l of ['Bỏ chặn','Xóa'])assert.ok(btn(m.el,l),l);
 await click(btn(m.el,'Xóa'));assert.deepEqual(p.calls.at(-1),['deleteConversation','c1']);await m.unmount();
});
test('thư mục thường: composer gửi tin',async()=>{
 const p=fake();const m=await mount({channel:'zalo',folder:'all',provider:p});
 const ta=m.el.querySelector('textarea');assert.ok(ta);
 assert.equal(btn(m.el,'Gửi').disabled,true);
 await setVal(ta,'Chào');await click(btn(m.el,'Gửi'));
 assert.deepEqual(p.calls.at(-1),['send','c1','Chào']);
 assert.ok(m.el.querySelector('.op-chat__sep'));
 await m.unmount();
});
test('chọn nhiều: Ctrl/Cmd, Shift, Chọn tất cả và thao tác hàng loạt',async()=>{
 const p=fake();const m=await mount({channel:'zalo',folder:'stranger',provider:p});
 const rows=()=>[...m.el.querySelectorAll('.op-chat__row')];
 await click(rows()[1],{ctrlKey:true});
 assert.ok(m.el.textContent.includes('Đã chọn 1'));
 await click(rows()[3],{shiftKey:true});
 assert.ok(m.el.textContent.includes('Đã chọn 3'));
 await click(rows()[0],{metaKey:true});
 assert.ok(m.el.textContent.includes('Đã chọn 4'));
 await click(btn(m.el,'Bỏ chọn'));assert.ok(!m.el.textContent.includes('Đã chọn'));
 await click(rows()[0],{ctrlKey:true});
 await click(btn(m.el,'Chọn tất cả'));assert.ok(m.el.textContent.includes('Đã chọn 4'));
 await click(btn(m.el,'Chặn'));
 assert.deepEqual(p.calls.map(c=>c[0]),['block','block','block','block']);
 await m.unmount();
});
// React scheduler (MessageChannel) giữ tiến trình sống sau khi test xong.
test.after(()=>{dom.window.close();setTimeout(()=>process.exit(process.exitCode??0),50).unref?.();});
