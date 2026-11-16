import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,getComputedStyle:dom.window.getComputedStyle.bind(dom.window)});
const root=new URL('../',import.meta.url).pathname;
const out=await build({stdin:{contents:`export {mountPersonal} from './src/ui/pages.tsx';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',target:'es2022',logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'}});
const file=join(await mkdtemp(join(tmpdir(),'op-')),'m.mjs');await writeFile(file,out.outputFiles[0].text);
const {mountPersonal}=await import(pathToFileURL(file).href);
const tick=(ms=30)=>new Promise(r=>setTimeout(r,ms));
const click=el=>el.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
const btn=(c,label)=>[...c.querySelectorAll('button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);
const dialog=()=>document.querySelector('[role=dialog]');

/** Host giả: không gọi gì ra ngoài, ghi lại mọi request. */
function fakeHost({gmail=[{id:'a1',address:'katri@gmail.com'},{id:'a2',address:'work@company.com'}],logoutFails=false,removeFails=false}={}){
 const calls=[];let zaloLinked=true;const accounts=gmail.map(x=>({...x,savedAt:1,needsReauth:false}));
 return {calls,host:{request:async(method,params)=>{
  calls.push([method,params]);
  if(method==='channels.status')return {channelAccounts:{zalouser:[{accountId:'default',enabled:true,configured:true,linked:zaloLinked,running:zaloLinked,connected:zaloLinked}]},channelDefaultAccountId:{zalouser:'default'}};
  if(method==='channels.logout'){if(logoutFails)throw new Error('gateway-down');zaloLinked=false;return {cleared:true};}
  if(method==='plugins.sessionAction'){
   const {actionId,payload}=params;
   if(actionId==='gmail.accounts.list')return {ok:true,result:{accounts}};
   if(actionId==='gmail.accounts.remove'){if(removeFails)return {ok:true,result:{ok:false,reason:'io-error'}};const i=accounts.findIndex(a=>a.id===payload.accountId);if(i>=0)accounts.splice(i,1);return {ok:true,result:{ok:true}};}
   if(actionId==='gmail.messages.list')return {ok:true,result:{messages:[]}};
   if(actionId==='setup.check')return {ok:true,result:{browser:'available',desktopNotify:'supported',messengerCookies:{present:false,savedAt:null}}};
   if(actionId==='zalo.conversations')return {ok:true,result:{supported:true,conversations:[]}};
   if(actionId==='zalo.status')return {ok:true,result:{historyAccess:'enabled',enableCommand:'x'}};
   return {ok:true,result:{}};
  }
  throw new Error('unexpected '+method);
 }}};
}
async function mount(f){
 const c=document.createElement('div');document.body.append(c);
 const view=mountPersonal(c,f.host);
 await tick(60);
 return {c,unmount:()=>view.dispose()};
}
const calls=(f,m)=>f.calls.filter(c=>c[0]===m||(c[0]==='plugins.sessionAction'&&c[1].actionId===m));

test('Email: xác nhận nêu hệ quả, Hủy không gọi remove',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 click(btn(c,'Đăng xuất'));await tick();
 const d=dialog();assert.ok(d);
 assert.match(d.textContent,/myaccount\.google\.com\/permissions/);assert.match(d.textContent,/trên máy này/);
 assert.ok(d.textContent.includes('katri@gmail.com')&&d.textContent.includes('work@company.com'));
 click(btn(d,'Hủy'));await tick();
 assert.equal(dialog(),null);assert.equal(calls(f,'gmail.accounts.remove').length,0);unmount();
});
test('Email: đăng xuất từng tài khoản gọi đúng payload; hết tài khoản quay về chưa kết nối',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 click(btn(c,'Đăng xuất'));await tick();
 click(btn(dialog(),'Đăng xuất work@company.com'));await tick(80);
 assert.deepEqual(calls(f,'gmail.accounts.remove').map(x=>x[1].payload),[{accountId:'a2'}]);
 assert.ok(dialog());assert.ok(!dialog().textContent.includes('work@company.com'));
 click(btn(dialog(),'Đăng xuất katri@gmail.com'));await tick(100);
 assert.deepEqual(calls(f,'gmail.accounts.remove').map(x=>x[1].payload),[{accountId:'a2'},{accountId:'a1'}]);
 assert.equal(dialog(),null);
 assert.ok(c.textContent.includes('Chưa kết nối Gmail'));unmount();
});
test('Email: lỗi xóa hiển thị thông báo và giữ tài khoản',async()=>{
 const f=fakeHost({removeFails:true});const {c,unmount}=await mount(f);
 click(btn(c,'Đăng xuất'));await tick();
 click(btn(dialog(),'Đăng xuất katri@gmail.com'));await tick(80);
 assert.match(dialog().querySelector('[role=alert]').textContent,/Không đăng xuất được katri@gmail\.com/);
 assert.ok(dialog().textContent.includes('katri@gmail.com'));unmount();
});
const zaloLogout=c=>[...c.querySelectorAll('button.op-shell__cat')].filter(b=>b.textContent==='Đăng xuất').at(-1);
async function openZalo(c){
 click(btn(c,'Zalo'));await tick(60);
}
test('Zalo: Hủy không gọi channels.logout; xác nhận gọi đúng method/payload rồi về màn liên kết',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 await openZalo(c);
 click(zaloLogout(c));await tick();
 let d=dialog();assert.ok(d);assert.match(d.textContent,/quét lại mã QR/);
 click(btn(d,'Hủy'));await tick();
 assert.equal(dialog(),null);assert.equal(f.calls.filter(x=>x[0]==='channels.logout').length,0);
 click(zaloLogout(c));await tick();
 click(btn(dialog(),'Đăng xuất'));await tick(100);
 assert.deepEqual(f.calls.filter(x=>x[0]==='channels.logout'),[['channels.logout',{channel:'zalouser'}]]);
 assert.equal(dialog(),null);
 assert.ok(c.textContent.includes('Chưa liên kết'));unmount();
});
test('Zalo: lỗi Gateway hiển thị trong hộp thoại, không đóng',async()=>{
 const f=fakeHost({logoutFails:true});const {c,unmount}=await mount(f);
 await openZalo(c);
 click(zaloLogout(c));await tick();
 click(btn(dialog(),'Đăng xuất'));await tick(80);
 assert.match(dialog().querySelector('[role=alert]').textContent,/Không đăng xuất được Zalo.*gateway-down/);
 unmount();
});
