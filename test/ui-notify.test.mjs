import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
/** Gói module + react/react-dom chung một bản (tránh hai bản React khác nhau). */
async function loadWithReact(entry){
 const root=new URL('../',import.meta.url).pathname;
 const out=await build({stdin:{contents:`export * from './${entry}';export {default as React} from 'react';export {createRoot} from 'react-dom/client';`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',target:'es2022',logLevel:'silent'});
 const file=join(await mkdtemp(join(tmpdir(),'op-')),'m.mjs');await writeFile(file,out.outputFiles[0].text);
 return import(pathToFileURL(file).href);
}
// React giữ MessagePort mở sau khi render; thoát tiến trình sau khi báo cáo xong (xem test.after cuối file).
const dom=new JSDOM('<!doctype html><main id="app"></main>',{url:'https://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const m=await loadWithReact('src/ui/notify/index.ts');
const {React,createRoot}=m;
const {act}=React;
const at=(h,mi=0)=>new Date(2026,0,5,h,mi);
const ev=(o={})=>({id:'1',channel:'zalo',title:'A',body:'bí mật',sender:'known',...o});
const S=(o={})=>({...m.DEFAULT_SETTINGS,channels:{...m.DEFAULT_SETTINGS.channels},showContent:true,...o});
async function mount(el){const c=document.createElement('div');document.body.append(c);const r=createRoot(c);await act(async()=>r.render(el));return {c,r};}

test('quiet hours wrap past midnight, boundaries',()=>{
 for(const [h,mi,q] of [[22,0,true],[23,59,true],[0,0,true],[6,59,true],[7,0,false],[12,0,false],[21,59,false]])
  assert.equal(m.shouldNotify(ev(),S(),at(h,mi)).notify,!q,`${h}:${mi}`);
 const d=m.shouldNotify(ev(),S(),at(23));assert.equal(d.reason,'quiet-hours');
 assert.equal(m.shouldNotify(ev(),S({quietHours:false}),at(23)).notify,true);
});
test('channel toggles and stranger/spam/blocked filter',()=>{
 assert.equal(m.shouldNotify(ev({channel:'messenger'}),S(),at(12)).reason,'channel-off');
 for(const k of ['stranger','spam','blocked']){
  assert.equal(m.shouldNotify(ev({sender:k}),S(),at(12)).reason,'filtered');
  assert.equal(m.shouldNotify(ev({sender:k}),S({filterUnknown:false}),at(12)).notify,true);
 }
});
test('content hiding and no display target',()=>{
 assert.equal(m.shouldNotify(ev(),S({showContent:false}),at(12)).body,'Tin nhắn mới');
 assert.equal(m.shouldNotify(ev(),S(),at(12)).body,'bí mật');
 assert.equal(m.shouldNotify(ev(),S({inApp:false,system:false}),at(12)).notify,false);
});
test('settings validation and round trip',()=>{
 assert.deepEqual(m.parseSettings('not json'),m.DEFAULT_SETTINGS);
 assert.deepEqual(m.parseSettings(null),m.DEFAULT_SETTINGS);
 assert.deepEqual(m.parseSettings([1]),m.DEFAULT_SETTINGS);
 const p=m.parseSettings({channels:{email:false,zalo:'x'},sound:0,inApp:false,evil:1});
 assert.equal(p.channels.email,false);assert.equal(p.channels.zalo,true);assert.equal(p.sound,true);assert.equal(p.inApp,false);assert.ok(!('evil' in p));
 const s=S({sound:false});assert.deepEqual(m.parseSettings(m.serializeSettings(s)),s);
 const mem={};const st={getItem:k=>mem[k]??null,setItem:(k,v)=>{mem[k]=v;}};
 m.saveSettings(s,st);assert.deepEqual(m.loadSettings(st),s);
 assert.deepEqual(m.loadSettings(undefined),m.DEFAULT_SETTINGS);
 assert.doesNotThrow(()=>m.saveSettings(s,{getItem(){return null},setItem(){throw new Error('full')}}));
});
function fakeN(perm,result){
 const shown=[];
 class N{constructor(t,o){shown.push([t,o]);this.onclick=null;this.closed=false;}close(){this.closed=true;}}
 N.permission=perm;N.requestPermission=async()=>{N.permission=result;return result;};N.shown=shown;return N;
}
test('desktop wrapper never throws without Notification',async()=>{
 const d=m.createDesktopNotifier(null);
 assert.equal(d.permission(),'unsupported');assert.equal(await d.request(),'unsupported');assert.equal(d.show('a','b'),false);
 assert.doesNotThrow(()=>m.createDesktopNotifier().permission());
});
test('permission flow: default -> request -> granted -> show; denied does not show',async()=>{
 const N=fakeN('default','granted');const d=m.createDesktopNotifier(N);
 assert.equal(d.show('t','b'),false);
 assert.equal(await d.request(),'granted');
 let opened=0;assert.equal(d.show('t','b',{onClick:()=>opened++}),true);
 const inst=N.shown.length;assert.equal(inst,1);
 const D=fakeN('default','denied');const dd=m.createDesktopNotifier(D);await dd.request();assert.equal(dd.show('t','b'),false);
 const T=fakeN('default','granted');T.requestPermission=async()=>{throw new Error('x');};
 assert.equal(await m.createDesktopNotifier(T).request(),'default');
});
test('PermissionBar: Cho phép / Để sau, hidden once decided',async()=>{
 const calls=[];
 const {c}=await mount(React.createElement(m.PermissionBar,{permission:'default',onAllow:()=>calls.push('allow'),onLater:()=>calls.push('later')}));
 const [later,allow]=[...c.querySelectorAll('button')];
 assert.equal(later.textContent,'Để sau');assert.equal(allow.textContent,'Cho phép');
 await act(async()=>{allow.click();later.click();});assert.deepEqual(calls,['allow','later']);
 const g=await mount(React.createElement(m.PermissionBar,{permission:'granted',onAllow(){},onLater(){}}));
 assert.equal(g.c.children.length,0);
});
test('ToastStack Mở/Đã đọc, bell badge, settings toggles',async()=>{
 const calls=[];
 const t=await mount(React.createElement(m.ToastStack,{toasts:[{id:'a',channel:'zalo',app:'Zalo',title:'Lộc',body:'hi',time:'vừa xong'}],onOpen:i=>calls.push('o'+i),onRead:i=>calls.push('r'+i)}));
 const b=[...t.c.querySelectorAll('button')];assert.deepEqual(b.map(x=>x.textContent),['Mở','Đã đọc']);
 await act(async()=>b.forEach(x=>x.click()));assert.deepEqual(calls,['oa','ra']);
 const bell=await mount(React.createElement(m.NotificationBell,{count:3}));assert.equal(bell.c.querySelector('.op-notify__badge').textContent,'3');
 const z=await mount(React.createElement(m.NotificationBell,{count:0}));assert.equal(z.c.querySelector('.op-notify__badge'),null);
 let next;const sp=await mount(React.createElement(m.NotificationSettings,{settings:m.DEFAULT_SETTINGS,onChange:s=>{next=s;}}));
 const sw=[...sp.c.querySelectorAll('[role=switch]')];assert.equal(sw.length,9);
 await act(async()=>sw[2].click());assert.equal(next.channels.messenger,true);
 assert.ok(sp.c.textContent.includes('Tin nhắn mới'));
});
test.after(()=>{setTimeout(()=>process.exit(process.exitCode??0),200).unref?.();setTimeout(()=>process.exit(process.exitCode??0),300);});
