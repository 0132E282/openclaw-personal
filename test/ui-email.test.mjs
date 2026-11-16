import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement});
// gói chung react-dom và EmailApp để dùng cùng một bản React
const root=new URL('../',import.meta.url).pathname;
const out=await build({stdin:{contents:`export {createRoot} from 'react-dom/client';export * from './src/ui/email/index.ts';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',target:'es2022',logLevel:'silent'});
const file=join(await mkdtemp(join(tmpdir(),'op-')),'m.mjs');await writeFile(file,out.outputFiles[0].text);
const {createRoot,EmailApp,sanitizeHtml,applySelection,selectAll,filterMessages,groupMessages,EMPTY_SELECTION}=await import(pathToFileURL(file).href);
const tick=(ms=30)=>new Promise(r=>setTimeout(r,ms));
const NOW=new Date('2026-11-15T15:00:00');
const accounts=[{id:'a',address:'katri@gmail.com',color:'#e11',signature:'Katri'},{id:'b',address:'work@company.com',color:'#08f'}];
const msg=(id,box,over={})=>({id,accountId:'a',box,from:{name:'Người '+id,address:id+'@x.com'},to:['katri@gmail.com'],subject:'Chủ đề '+id,snippet:'tóm tắt '+id,text:'nội dung '+id,date:'2026-11-15T09:00:00',unread:false,...over});
const ALL=[msg('m1','inbox',{unread:true}),msg('m2','inbox'),msg('m3','inbox'),msg('s1','stranger'),msg('p1','spam'),msg('p2','spam'),msg('b1','blocked'),msg('t1','trash')];
function fake(over={}){
 const calls={move:[],read:[],send:[]};
 return {calls,listAccounts:async()=>accounts,listMessages:async({folder})=>filterMessages(ALL,folder),getMessage:async id=>ALL.find(m=>m.id===id),
  send:async d=>{calls.send.push(d);},moveToFolder:async(ids,a)=>{calls.move.push([[...ids],a]);},markRead:async(ids,r)=>{calls.read.push([[...ids],r]);},...over};
}
async function mount(props){
 const c=document.createElement('div');document.body.append(c);const r=createRoot(c);
 r.render({$$typeof:Symbol.for('react.transitional.element'),type:EmailApp,key:null,ref:null,props:{now:()=>NOW,...props}});
 for(let i=0;i<40&&(!c.textContent||c.textContent.includes('Đang tải'));i++)await tick(25);
 await tick();return {c,unmount:()=>r.unmount()};
}
const click=(el,init={})=>el.dispatchEvent(new window.MouseEvent('click',{bubbles:true,...init}));
const btn=(c,label)=>[...c.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
const labels=c=>[...c.querySelectorAll('.op-email__toolbar button')].map(b=>b.textContent.trim());
const setVal=(el,v)=>{const proto=el instanceof window.HTMLTextAreaElement?window.HTMLTextAreaElement:window.HTMLInputElement;Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(el,v);el.dispatchEvent(new window.Event('input',{bubbles:true}));};

test('chưa kết nối: không provider hoặc không có tài khoản',async()=>{
 for(const provider of [undefined,fake({listAccounts:async()=>[]})]){
  const {c,unmount}=await mount({provider});
  assert.ok(c.textContent.includes('Chưa kết nối Gmail'));
  assert.equal(c.querySelector('.op-email__list'),null);
  assert.ok(btn(c,'Kết nối Gmail').disabled);
  unmount();
 }
});
test('Soạn thư chỉ ở thư mục all; chip tài khoản hiện "2 tài khoản"',async()=>{
 const a=await mount({provider:fake(),folder:'all'});
 assert.ok(btn(a.c,'Soạn thư'));assert.ok(a.c.textContent.includes('2 tài khoản'));a.unmount();
 const b=await mount({provider:fake(),folder:'unread'});assert.equal(btn(b.c,'Soạn thư'),undefined);b.unmount();
});
const EXPECT={stranger:['Chấp nhận','Chặn','Báo spam'],spam:['Không phải spam','Xóa vĩnh viễn','Chặn'],blocked:['Bỏ chặn','Xóa'],trash:['Khôi phục','Xóa vĩnh viễn']};
const FIRST={stranger:['s1','accept'],spam:['p1','unspam'],blocked:['b1','unblock'],trash:['t1','restore']};
for(const folder of Object.keys(EXPECT)){
 test('thao tác thư mục '+folder,async()=>{
  const p=fake();const {c,unmount}=await mount({provider:p,folder});
  click(c.querySelector('[role=option]'));await tick();
  assert.deepEqual(labels(c),EXPECT[folder]);
  click(btn(c,EXPECT[folder][0]));await tick();
  assert.deepEqual(p.calls.move,[[[FIRST[folder][0]],FIRST[folder][1]]]);
  unmount();
 });
}
test('thư mục chính có Trả lời/Chuyển tiếp và đánh dấu đã đọc khi mở',async()=>{
 const p=fake();const {c,unmount}=await mount({provider:p,folder:'all'});
 click(c.querySelector('[role=option]'));await tick();
 assert.deepEqual(labels(c),['Trả lời','Chuyển tiếp','Báo spam','Chặn']);
 assert.ok(p.calls.read.length<=1);unmount();
});
test('chọn nhiều bằng Shift và Ctrl, thanh Đã chọn N, Chọn tất cả, ×',async()=>{
 const p=fake();const {c,unmount}=await mount({provider:p,folder:'spam'});
 const rows=()=>[...c.querySelectorAll('[role=option]')];
 click(rows()[0],{ctrlKey:true});await tick();
 assert.ok(c.textContent.includes('Đã chọn 1'));
 click(rows()[1],{shiftKey:true});await tick();
 assert.ok(c.textContent.includes('Đã chọn 2'));
 assert.ok(c.textContent.includes('Shift + click'));
 click(btn(c,'Chọn tất cả'));await tick();
 click(btn(c,'Không phải spam'));await tick();
 assert.deepEqual(p.calls.move.at(-1)[0].sort(),['p1','p2']);assert.equal(p.calls.move.at(-1)[1],'unspam');
 click(rows()[0],{metaKey:true});await tick();
 click(c.querySelector('[aria-label="Bỏ chọn"]'));await tick();
 assert.equal(c.textContent.includes('Đã chọn'),false);
 unmount();
});
test('helpers chọn dải/ctrl và lọc thư mục',()=>{
 const o=['a','b','c','d','e'];
 let s=applySelection(o,EMPTY_SELECTION,'b');
 s=applySelection(o,s,'d',{shift:true});assert.deepEqual([...s.selected],['b','c','d']);assert.equal(s.anchor,'b');
 s=applySelection(o,s,'a',{shift:true});assert.deepEqual([...s.selected],['a','b']);
 s=applySelection(o,s,'e',{meta:true});assert.deepEqual([...s.selected].sort(),['a','b','e']);
 s=applySelection(o,s,'a',{meta:true});assert.deepEqual([...s.selected].sort(),['b','e']);
 assert.deepEqual([...selectAll(o).selected],o);
 assert.deepEqual(filterMessages(ALL,'unread').map(m=>m.id),['m1']);
 assert.deepEqual(filterMessages(ALL,'all').map(m=>m.id),['m1','m2','m3']);
 assert.deepEqual(filterMessages(ALL,'spam').map(m=>m.id),['p1','p2']);
 const g=groupMessages([msg('x','inbox',{pinned:true}),msg('y','inbox',{date:'2026-11-14T10:00:00'}),msg('z','inbox')],'all',NOW);
 assert.deepEqual(g.map(x=>x.title),['Đã ghim','Hôm nay','Hôm qua']);
});
test('soạn thư: gửi với người nhận, nội dung được lọc, thiếu người nhận báo lỗi',async()=>{
 const p=fake();const {c,unmount}=await mount({provider:p,folder:'all'});
 click(btn(c,'Soạn thư'));await tick();
 assert.ok(c.querySelector('[aria-label="Thư mới"]'));
 click(btn(c,'Gửi'));await tick();
 assert.ok(c.querySelector('[role=alert]').textContent.includes('người nhận'));assert.equal(p.calls.send.length,0);
 const to=c.querySelector('input[aria-label="Đến"]');setVal(to,'dianne@example.com');
 to.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();
 assert.ok(c.textContent.includes('dianne@example.com'));
 setVal(c.querySelector('input[aria-label="Chủ đề"]'),'Báo giá');
 c.querySelector('[aria-label="Nội dung thư"]').innerHTML='<p>Chào</p><img src=x onerror="alert(1)"><script>alert(2)</script>';
 click(btn(c,'Gửi'));await tick();
 assert.equal(p.calls.send.length,1);
 const d=p.calls.send[0];
 assert.deepEqual(d.to,['dianne@example.com']);assert.equal(d.subject,'Báo giá');assert.equal(d.accountId,'a');
 assert.equal(d.html,'<p>Chào</p>');assert.equal(c.querySelector('[aria-label="Thư mới"]'),null);
 unmount();
});
test('hẹn giờ gửi qua menu và đính kèm tệp',async()=>{
 const p=fake();const {c,unmount}=await mount({provider:p,folder:'all'});
 click(btn(c,'Soạn thư'));await tick();
 const to=c.querySelector('input[aria-label="Đến"]');setVal(to,'a@b.co');to.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await tick();
 const input=c.querySelector('input[type=file]');
 Object.defineProperty(input,'files',{value:[new window.File(['x'],'bao-gia.pdf')],configurable:true});
 input.dispatchEvent(new window.Event('change',{bubbles:true}));await tick();
 assert.ok(c.textContent.includes('bao-gia.pdf'));
 click(c.querySelector('[aria-label="Lịch gửi"]'));await tick();
 click(btn(c,'Gửi sau 1 giờ'));await tick();
 assert.equal(p.calls.send[0].attachments.length,1);assert.ok(Date.parse(p.calls.send[0].scheduleAt)>Date.now());
 unmount();
});
test('sanitizeHtml: allow-list, bỏ script/handler/URL nguy hiểm',()=>{
 assert.equal(sanitizeHtml('<p onclick="x()">Hi <b>there</b></p><script>alert(1)</script>'),'<p>Hi <b>there</b></p>');
 assert.equal(sanitizeHtml('<img src=x onerror=alert(1)><iframe src=//e></iframe><style>*{}</style>ok'),'ok');
 assert.equal(sanitizeHtml('<a href="javascript:alert(1)" onclick="x">bad</a>'),'bad');
 assert.equal(sanitizeHtml('<a href="https://ex.com/?a=1&b=2" style="x">go</a>'),'<a href="https://ex.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">go</a>');
 assert.equal(sanitizeHtml('<a href="https://ex.com">go</a>',{links:false}),'go');
 assert.equal(sanitizeHtml('<font color=red><u>x</u></font>'),'<u>x</u>');
 assert.equal(sanitizeHtml('&lt;script&gt;'),'&lt;script&gt;');
});
test('khung đọc render HTML đã lọc, thư mục Đã chặn ẩn nội dung',async()=>{
 const evil=msg('m1','inbox',{html:'<p>An toàn</p><img src=x onerror=alert(1)><script>window.__x=1</script>'});
 const {c,unmount}=await mount({provider:fake({getMessage:async()=>evil}),folder:'all'});
 click(c.querySelector('[role=option]'));await tick();
 const body=c.querySelector('.op-email__content .op-email__html');
 assert.equal(body.innerHTML,'<p>An toàn</p>');assert.equal(window.__x,undefined);unmount();
 const b=await mount({provider:fake({getMessage:async()=>msg('b1','blocked',{text:'bí mật'})}),folder:'blocked'});
 click(b.c.querySelector('[role=option]'));await tick();
 assert.equal(b.c.textContent.includes('bí mật'),false);assert.ok(b.c.textContent.includes('Nội dung bị ẩn'));b.unmount();
});

test('polling: thư mới hiện sau vài tick, không đóng thư đang đọc, dừng sau unmount',async()=>{
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});
 let list=[msg('m1','inbox'),msg('m2','inbox')];let listCalls=0;
 const p=fake({listMessages:async({folder})=>{listCalls++;return filterMessages(list,folder);}});
 const {c,unmount}=await mount({provider:p,pollMs:20});
 click(c.querySelector('[role=option]'));await tick(60);
 assert.ok(c.textContent.includes('nội dung m1'));
 list=[msg('m9','inbox',{subject:'Thư mới về'}),...list];
 await tick(150);
 assert.ok(c.textContent.includes('Thư mới về'));
 assert.ok(c.textContent.includes('nội dung m1'));// thư đang đọc vẫn mở
 unmount();await tick(30);
 const n=listCalls;await tick(100);
 assert.equal(listCalls,n);
});
