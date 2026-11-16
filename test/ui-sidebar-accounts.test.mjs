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

/** Host giả: 2 Gmail (mỗi tài khoản 1 thư), 2 Zalo, Messenger đã kết nối. */
function fakeHost(account={ok:true,name:'Nguyễn Phúc',avatar:'https://scontent.x.fbcdn.net/a.jpg'}){
 const calls=[];const gmail=[{id:'a1',address:'katri@gmail.com'},{id:'a2',address:'work@company.com'}];
 const zalo=[{accountId:'default',enabled:true,configured:true,linked:true,running:true,connected:true,profile:{displayName:'An'}},{accountId:'acc-b',enabled:true,configured:true,linked:true,running:true,connected:true,profile:{displayName:'Bình'}}];
 return {calls,host:{request:async(method,params)=>{
  calls.push([method,params]);
  if(method==='channels.status')return {channelAccounts:{zalouser:zalo},channelDefaultAccountId:{zalouser:'default'}};
  if(method==='channels.logout')return {cleared:true};
  if(method==='plugins.sessionAction'){
   const {actionId,payload}=params;
   if(actionId==='gmail.accounts.list')return {ok:true,result:{accounts:gmail.map(x=>({...x,savedAt:1,needsReauth:false}))}};
   if(actionId==='gmail.accounts.remove')return {ok:true,result:{ok:true}};
   if(actionId==='gmail.messages.list'){const g=gmail.find(x=>x.id===payload.accountId);return {ok:true,result:{messages:[{id:'m-'+g.id,accountId:g.id,box:'inbox',from:{name:'X',address:'x@x.com'},to:[g.address],subject:'Thư của '+g.id,snippet:'',date:new Date().toISOString(),unread:false}]}};}
   if(actionId==='messenger.status')return {ok:true,result:{state:'connected'}};
   if(actionId==='messenger.account')return {ok:true,result:account};
   if(actionId==='messenger.conversations')return {ok:true,result:{ok:true,conversations:[]}};
   if(actionId==='messenger.cookies.clear')return {ok:true,result:{ok:true}};
   if(actionId==='setup.check')return {ok:true,result:{browser:'available',desktopNotify:'supported',messengerCookies:{present:true,savedAt:null}}};
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
 await tick(80);
 return {c,unmount:()=>view.dispose()};
}
const group=(c,name)=>c.querySelector(`[role=group][aria-label="Tài khoản ${name}"]`);
const names=g=>[...g.querySelectorAll('.op-shell__accrow button.op-shell__acc')].map(b=>b.lastChild.textContent);
const op=(f,id)=>f.calls.filter(c=>c[0]==='plugins.sessionAction'&&c[1].actionId===id).map(c=>c[1].payload);

test('Email: chỉ bấm chevron mới mở/đóng danh sách tài khoản (bấm "Tất cả" không mở), chevron là SVG',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 assert.equal(group(c,'Email'),null);
 const all=btn(c,'Tất cả');assert.equal(all.querySelector('svg.op-shell__subchev')===null,true);
 const tog=btn(c,'Mở danh sách tài khoản Email');assert.ok(tog.querySelector('svg.op-shell__subchev'));assert.equal(tog.textContent.includes('⌄'),false);
 assert.ok(c.querySelector('.op-shell__chev svg.op-shell__chevsvg'));
 click(all);await tick(40);
 assert.equal(group(c,'Email'),null);
 click(tog);await tick(40);
 assert.deepEqual(names(group(c,'Email')),['katri@gmail.com','work@company.com']);
 assert.equal(group(c,'Email').querySelector('[data-active=true]'),null);
 click(btn(c,'Thu gọn danh sách tài khoản Email'));await tick(40);
 assert.equal(group(c,'Email'),null);unmount();
});
test('Email: chọn tài khoản chỉ xem thư của tài khoản đó; bấm lại tài khoản đang chọn thì gộp tất cả',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 assert.ok(c.textContent.includes('Thư của a1')&&c.textContent.includes('Thư của a2'));
 click(btn(c,'Mở danh sách tài khoản Email'));await tick(40);
 click([...group(c,'Email').querySelectorAll('.op-shell__accrow button.op-shell__acc')][1]);await tick(120);
 assert.ok(c.textContent.includes('Thư của a2'));assert.ok(!c.textContent.includes('Thư của a1'));
 assert.ok(c.textContent.includes('đang xem 1/2 tài khoản'));
 assert.equal(group(c,'Email').querySelector('[data-active=true]').lastChild.textContent,'work@company.com');
 click([...group(c,'Email').querySelectorAll('.op-shell__accrow button.op-shell__acc')][1]);await tick(120);
 assert.ok(c.textContent.includes('Thư của a1')&&c.textContent.includes('Thư của a2'));
 assert.ok(c.textContent.includes('đang xem 2/2 tài khoản'));
 unmount();
});
test('Email: nút đăng xuất theo tài khoản mở hộp thoại chỉ có tài khoản đó, chưa đăng xuất ngay',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 click(btn(c,'Mở danh sách tài khoản Email'));await tick(40);
 assert.ok(btn(group(c,'Email'),'Thêm tài khoản'));
 click(btn(group(c,'Email'),'Đăng xuất work@company.com'));await tick(60);
 const d=dialog();assert.ok(d);
 assert.ok(d.textContent.includes('work@company.com'));assert.ok(!d.textContent.includes('katri@gmail.com'));
 assert.equal(op(f,'gmail.accounts.remove').length,0);
 click(btn(d,'Hủy'));await tick();assert.equal(dialog(),null);
 click(btn(group(c,'Email'),'Đăng xuất katri@gmail.com'));await tick(60);
 click(btn(dialog(),'Đăng xuất katri@gmail.com'));await tick(80);
 assert.deepEqual(op(f,'gmail.accounts.remove'),[{accountId:'a1'}]);
 unmount();
});
test('Messenger: bấm "Tất cả tin nhắn" mở/đóng danh sách 1 tài khoản; đăng xuất mở hộp thoại xác nhận',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 click(btn(c,'Messenger'));await tick(80);
 assert.equal(group(c,'Messenger'),null);
 click(btn(c,'Mở danh sách tài khoản Messenger'));await tick(40);
 assert.deepEqual(names(group(c,'Messenger')),['Nguyễn Phúc']);
 assert.equal(group(c,'Messenger').querySelector('[data-active=true]').lastChild.textContent,'Nguyễn Phúc');
 click(btn(group(c,'Messenger'),'Đăng xuất Nguyễn Phúc'));await tick(40);
 const d=dialog();assert.ok(d);assert.match(d.textContent,/Đăng xuất Messenger/);
 assert.equal(op(f,'messenger.cookies.clear').length,0);
 click(btn(d,'Hủy'));await tick();
 click(btn(c,'Thu gọn danh sách tài khoản Messenger'));await tick(40);
 assert.equal(group(c,'Messenger'),null);unmount();
});
test('Zalo: nút đăng xuất theo tài khoản chỉ xác nhận đúng tài khoản đó',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 click(btn(c,'Zalo'));await tick(80);
 click(btn(c,'Mở danh sách tài khoản Zalo'));await tick(40);
 click(btn(group(c,'Zalo'),'Đăng xuất Bình'));await tick(40);
 const d=dialog();assert.ok(d);assert.ok(!d.textContent.includes('Chọn tài khoản'));
 assert.equal(f.calls.filter(x=>x[0]==='channels.logout').length,0);
 click([...d.querySelectorAll('button')].filter(b=>b.textContent==='Đăng xuất').at(-1));await tick(80);
 assert.deepEqual(f.calls.filter(x=>x[0]==='channels.logout'),[['channels.logout',{channel:'zalouser',accountId:'acc-b'}]]);
 unmount();
});

test('Messenger: tên + ảnh thật của tài khoản Facebook (img tròn, lỗi tải ảnh về chữ cái đầu); op chỉ gọi khi đã kết nối',async()=>{
 const f=fakeHost();const {c,unmount}=await mount(f);
 click(btn(c,'Messenger'));await tick(80);
 click(btn(c,'Mở danh sách tài khoản Messenger'));await tick(40);
 const g=group(c,'Messenger');
 const img=g.querySelector('img.op-shell__acc-ava');
 assert.equal(img?.getAttribute('src'),'https://scontent.x.fbcdn.net/a.jpg');
 assert.equal(op(f,'messenger.account').length>=1,true);
 img.dispatchEvent(new window.Event('error'));await tick(30);
 assert.equal(group(c,'Messenger').querySelector('img.op-shell__acc-ava'),null);
 assert.equal(group(c,'Messenger').querySelector('span.op-shell__acc-ava').textContent,'N');
 unmount();
});

test('Messenger: không lấy được tên (op lỗi hoặc thiếu tên) thì giữ nhãn "Messenger" và chữ M',async()=>{
 for(const acc of [{ok:false,name:'',avatar:'',reason:'selector-broken'},{}]){
  const f=fakeHost(acc);const {c,unmount}=await mount(f);
  click(btn(c,'Messenger'));await tick(80);
  click(btn(c,'Mở danh sách tài khoản Messenger'));await tick(40);
  assert.deepEqual(names(group(c,'Messenger')),['Messenger']);
  assert.equal(group(c,'Messenger').querySelector('span.op-shell__acc-ava').textContent,'M');
  assert.ok(btn(group(c,'Messenger'),'Đăng xuất Messenger'));
  unmount();
 }
});

test.after(()=>{setTimeout(()=>process.exit(),100).unref();});
