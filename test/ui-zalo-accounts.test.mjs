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
const out=await build({stdin:{contents:`export {mountPersonal} from './src/ui/pages.tsx';export {createHostZaloProvider} from './src/ui/chat/index.ts';export {deriveZaloAccounts} from './src/connectors/zalo.ts';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',target:'es2022',logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'}});
const file=join(await mkdtemp(join(tmpdir(),'op-')),'m.mjs');await writeFile(file,out.outputFiles[0].text);
const {mountPersonal,createHostZaloProvider,deriveZaloAccounts}=await import(pathToFileURL(file).href);
const tick=(ms=30)=>new Promise(r=>setTimeout(r,ms));
const click=el=>el.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));
const btn=(c,label)=>[...c.querySelectorAll('button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);
const dialog=()=>document.querySelector('[role=dialog]');
const QR='data:image/png;base64,AAAA';
const acct=(accountId,displayName,linked=true,avatar)=>({accountId,enabled:true,configured:true,linked,running:linked,connected:linked,profile:{userId:'u-'+accountId,displayName,...(avatar?{avatar}:{})}});

/** Host giả nhiều tài khoản; `web.login.wait` của tài khoản đang đăng nhập sẽ đánh dấu đã liên kết. */
function fakeHost({accounts=[acct('default','An'),acct('acc-b','Bình')],addFails=false}={}){
 const calls=[];const state=accounts.map(a=>({...a}));
 const host={request:async(method,params)=>{
  calls.push([method,params]);
  if(method==='channels.status')return {channelAccounts:{zalouser:state},channelDefaultAccountId:{zalouser:'default'}};
  if(method==='channels.logout'){const a=state.find(x=>x.accountId===(params.accountId??'default'));if(a)a.linked=a.running=a.connected=false;return {cleared:true};}
  if(method==='web.login.start')return {qrDataUrl:QR,sessionKey:'s'};
  if(method==='web.login.wait'){const a=state.find(x=>x.accountId===params.accountId);if(a)a.linked=a.running=a.connected=true;return {connected:true};}
  if(method==='plugins.sessionAction'){
   const {actionId,payload}=params;
   if(actionId==='zalo.accounts.add'){if(addFails)return {ok:true,result:{ok:false,reason:'failed'}};state.push({...acct('acc-new','Mới',false),profile:{}});return {ok:true,result:{ok:true,accountId:'acc-new'}};}
   if(actionId==='gmail.accounts.list')return {ok:true,result:{accounts:[]}};
   if(actionId==='setup.check')return {ok:true,result:{browser:'available',desktopNotify:'supported'}};
   if(actionId==='zalo.conversations'){const b=payload.accountId==='acc-b';return {ok:true,result:{supported:true,conversations:[{id:b?'20':'10',name:b?'Người B':'Người A',kind:'direct',preview:'',lastAt:''}]}};}
   if(actionId==='zalo.messages')return {ok:true,result:{messages:[],unavailable:null}};
   if(actionId==='zalo.status')return {ok:true,result:{historyAccess:'enabled',enableCommand:'x'}};
   return {ok:true,result:{ok:true,reset:false}};
  }
  throw new Error('unexpected '+method);
 }};
 return {calls,host,state};
}
async function mount(f){
 const c=document.createElement('div');document.body.append(c);
 const view=mountPersonal(c,f.host);
 await tick(60);
 click(btn(c,'Zalo'));await tick(80);
 return {c,unmount:()=>view.dispose()};
}
const op=(f,id)=>f.calls.filter(c=>c[0]==='plugins.sessionAction'&&c[1].actionId===id).map(c=>c[1].payload);
const accountGroup=c=>c.querySelector('[role=group][aria-label="Tài khoản Zalo"]');

test('deriveZaloAccounts: chỉ tài khoản đã liên kết, default đứng đầu, ảnh chỉ nhận https CDN Zalo',()=>{
 const r=deriveZaloAccounts({channelAccounts:{zalouser:[acct('acc-b','Bình',true,'https://s.zadn.vn/a.jpg'),acct('acc-c','Chưa',false),{...acct('x','Tắt'),enabled:false},acct('default','An',true,'https://evil.com/a.jpg'),acct('bad id','Lạ')]}});
 assert.deepEqual(r,[{accountId:'default',name:'An'},{accountId:'acc-b',name:'Bình',avatar:'https://s.zadn.vn/a.jpg'}]);
 assert.deepEqual(deriveZaloAccounts({}),[]);
 assert.deepEqual(deriveZaloAccounts({channelAccounts:{zalouser:[{linked:true,running:true}]}}),[{accountId:'default',name:'Zalo'}]);
});

test('bộ chọn tài khoản chỉ hiện khi có từ 2 tài khoản; đổi tài khoản tải lại theo accountId',async()=>{
 const one=fakeHost({accounts:[acct('default','An')]});
 const m1=await mount(one);
 assert.equal(accountGroup(m1.c),null);
 assert.deepEqual(op(one,'zalo.conversations')[0],{folder:'all'}); // default: payload cũ, không accountId
 m1.unmount();
 const f=fakeHost();const {c,unmount}=await mount(f);
 const g=accountGroup(c);assert.ok(g);
 const items=[...g.querySelectorAll('button')];
 assert.deepEqual(items.map(b=>b.lastChild.textContent),['An','Bình']);
 assert.equal(items[0].getAttribute('aria-pressed'),'true');
 assert.ok(c.textContent.includes('Người A'));assert.ok(!c.textContent.includes('Người B'));
 click(items[1]);await tick(80);
 assert.equal(accountGroup(c).querySelectorAll('button')[1].getAttribute('aria-pressed'),'true');
 assert.ok(c.textContent.includes('Người B'));assert.ok(!c.textContent.includes('Người A'));
 assert.ok(op(f,'zalo.conversations').some(p=>p.accountId==='acc-b'));
 // đồng bộ userId theo đúng tài khoản
 assert.ok(op(f,'zalo.account.sync').some(p=>p.accountId==='acc-b'&&p.userId==='u-acc-b'));
 click(accountGroup(c).querySelectorAll('button')[0]);await tick(80);
 assert.ok(c.textContent.includes('Người A'));
 unmount();
});

test('Thêm tài khoản: chỉ gọi zalo.accounts.add khi bấm, rồi mở QR với accountId mới và chọn tài khoản đó',async()=>{
 const f=fakeHost({accounts:[acct('default','An')]});const {c,unmount}=await mount(f);
 assert.equal(op(f,'zalo.accounts.add').length,0);
 click(btn(c,'Thêm tài khoản'));await tick(150);
 assert.deepEqual(op(f,'zalo.accounts.add'),[{}]);
 const start=f.calls.find(x=>x[0]==='web.login.start');
 assert.deepEqual(start[1],{channel:'zalouser',accountId:'acc-new',timeoutMs:30_000});
 const wait=f.calls.find(x=>x[0]==='web.login.wait');
 assert.equal(wait[1].accountId,'acc-new');assert.equal(wait[1].channel,'zalouser');
 await tick(150);
 assert.equal(f.state.find(a=>a.accountId==='acc-new').linked,true);
 // QR xong: bộ chọn xuất hiện (2 tài khoản) và tài khoản mới đang được xem
 const items=[...accountGroup(c).querySelectorAll('button')];
 assert.equal(items.length,2);
 const sel=items.find(b=>b.getAttribute('aria-pressed')==='true');assert.ok(sel.textContent.includes('acc-new')||sel.textContent.includes('Mới')||sel.textContent.length>0);
 assert.ok(op(f,'zalo.conversations').some(p=>p.accountId==='acc-new'));
 unmount();
});

test('Thêm tài khoản lỗi: báo lỗi, không mở QR',async()=>{
 const f=fakeHost({addFails:true,accounts:[acct('default','An')]});const {c,unmount}=await mount(f);
 click(btn(c,'Thêm tài khoản'));await tick(100);
 assert.match(c.querySelector('[role=alert]').textContent,/Không tạo được tài khoản Zalo mới/);
 assert.equal(dialog(),null);assert.equal(f.calls.filter(x=>x[0]==='web.login.start').length,0);
 unmount();
});

test('Đăng xuất nhiều tài khoản: chọn đúng tài khoản, channels.logout kèm accountId; tài khoản còn lại giữ nguyên',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 click([...c.querySelectorAll('button.op-shell__cat')].filter(b=>b.textContent==='Đăng xuất').at(-1));await tick();
 const d=dialog();assert.ok(d);assert.ok(d.textContent.includes('An')&&d.textContent.includes('Bình'));
 click(btn(d,'Hủy')||btn(d,'Đóng'));await tick();
 assert.equal(dialog(),null);assert.equal(f.calls.filter(x=>x[0]==='channels.logout').length,0);
 click([...c.querySelectorAll('button.op-shell__cat')].filter(b=>b.textContent==='Đăng xuất').at(-1));await tick();
 click(btn(dialog(),'Đăng xuất Bình'));await tick(100);
 assert.deepEqual(f.calls.filter(x=>x[0]==='channels.logout'),[['channels.logout',{channel:'zalouser',accountId:'acc-b'}]]);
 assert.equal(f.state.find(a=>a.accountId==='default').linked,true);
 assert.equal(accountGroup(c),null); // còn 1 tài khoản: bộ chọn biến mất, đang xem An
 assert.ok(c.textContent.includes('Người A'));
 unmount();
});

test('provider theo tài khoản: gửi/ghi/ảnh/tin kèm accountId, sự kiện của tài khoản khác bị bỏ qua',async()=>{
 const calls=[];let listener;
 const host={request:async(method,params)=>{calls.push([method,params]);if(method==='channels.status')return {};return {ok:true,result:{ok:true,avatar:null,messages:[]}};},onEvent:(n,cb)=>{listener=cb;return()=>{listener=undefined;};}};
 const p=createHostZaloProvider(host,'acc-b');
 await p.send('20','chào');
 const gs=calls.find(c=>c[0]==='send')[1];
 assert.equal(gs.accountId,'acc-b');assert.equal(gs.to,'20');assert.equal(gs.channel,'zalouser');
 await p.sendFile('20',{name:'a.txt',type:'text/plain',base64:'QQ=='},'');
 assert.equal(calls.filter(c=>c[0]==='send').at(-1)[1].accountId,'acc-b');
 await p.getMessages('20');await p.getAvatar('20');
 const pay=id=>calls.filter(c=>c[0]==='plugins.sessionAction'&&c[1].actionId===id).map(c=>c[1].payload);
 assert.deepEqual(pay('zalo.message.record').map(x=>x.accountId),['acc-b','acc-b']);
 assert.deepEqual(pay('zalo.messages'),[{conversationId:'20',accountId:'acc-b'}]);
 assert.deepEqual(pay('zalo.avatar'),[{conversationId:'20',accountId:'acc-b'}]);
 let n=0;const off=p.onNewMessage(()=>n++);
 listener({conversationId:'1',accountId:'default'});listener({conversationId:'1'});assert.equal(n,0);
 listener({conversationId:'20',accountId:'acc-b'});assert.equal(n,1);
 off();
 // default: không thêm accountId vào gateway send
 const d=createHostZaloProvider(host);await d.send('1','x');
 assert.equal('accountId' in calls.filter(c=>c[0]==='send').at(-1)[1],false);
 let m=0;createHostZaloProvider(host).onNewMessage(()=>m++);listener({conversationId:'1'});listener({conversationId:'1',accountId:'acc-b'});assert.equal(m,1);
});
test.after(()=>{dom.window.close();setTimeout(()=>process.exit(process.exitCode??0),50).unref?.();});
