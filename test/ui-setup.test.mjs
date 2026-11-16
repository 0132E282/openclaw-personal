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
const {SetupGuide,React,createRoot}=await loadWithReact('src/ui/setup/index.ts');
const {act}=React;
const items=[
 {id:'plugin',title:'Plugin Personal',description:'d',status:'ok',statusLabel:'Đã cài'},
 {id:'zalo',title:'Zalo — zalouser',description:'d',status:'warn',statusLabel:'Chưa liên kết'},
 {id:'gmail',title:'Email — Gmail API',description:'d',status:'todo',statusLabel:'Chưa cài',command:'cmd-gmail --x'},
 {id:'pw',title:'Messenger — Playwright + Chromium',description:'d',status:'todo',statusLabel:'Chưa cài',command:'cmd-pw'}
];
async function mount(){
 const log={act:[],conf:[]};const c=document.createElement('div');document.body.append(c);
 await act(async()=>createRoot(c).render(React.createElement(SetupGuide,{items,onAction:(i,k)=>log.act.push([i,k]),onConfirmInstall:(i,cmd)=>log.conf.push([i,cmd])})));
 return {c,log};
}
const btn=(c,t)=>[...c.querySelectorAll('button')].find(b=>b.textContent===t||b.getAttribute('aria-label')===t);
test('renders rows, chips, steps and warning',async()=>{
 const {c}=await mount();
 assert.equal(c.querySelectorAll('.op-setup__row').length,4);
 assert.ok(c.textContent.includes('3 mục cần làm trước khi dùng đầy đủ'));
 assert.ok(c.textContent.includes('CÁC BƯỚC')&&c.textContent.includes('rủi ro khóa tài khoản'));
 assert.equal(c.querySelectorAll('.op-setup__step').length,4);
});
test('install shows command and does not confirm until user confirms',async()=>{
 const {c,log}=await mount();
 await act(async()=>btn(c,'Cài đặt — Email — Gmail API').click());
 assert.equal(log.conf.length,0);
 assert.ok(c.querySelector('[role=dialog] code').textContent==='cmd-gmail --x');
 await act(async()=>btn(c,'Hủy').click());
 assert.equal(c.querySelector('[role=dialog]'),null);assert.equal(log.conf.length,0);
 await act(async()=>btn(c,'Cài đặt — Email — Gmail API').click());
 await act(async()=>btn(c,'Xác nhận cài đặt').click());
 assert.deepEqual(log.conf,[['gmail','cmd-gmail --x']]);
});
test('install all lists all commands, confirms each only after confirm',async()=>{
 const {c,log}=await mount();
 await act(async()=>btn(c,'Cài tất cả còn thiếu').click());
 assert.deepEqual([...c.querySelectorAll('[role=dialog] code')].map(x=>x.textContent),['cmd-gmail --x','cmd-pw']);
 assert.equal(log.conf.length,0);
 await act(async()=>btn(c,'Xác nhận cài đặt').click());
 assert.deepEqual(log.conf.map(x=>x[0]),['gmail','pw']);
});
test('non-install actions call onAction directly; recheck all',async()=>{
 const {c,log}=await mount();
 await act(async()=>btn(c,'Liên kết — Zalo — zalouser').click());
 await act(async()=>btn(c,'Kiểm tra lại — Plugin Personal').click());
 await act(async()=>btn(c,'Kiểm tra lại tất cả').click());
 assert.deepEqual(log.act,[['zalo','connect'],['plugin','check'],['all','recheck-all']]);
 assert.equal(log.conf.length,0);
});
test('item without command cannot be confirmed',async()=>{
 const c=document.createElement('div');document.body.append(c);const conf=[];
 await act(async()=>createRoot(c).render(React.createElement(SetupGuide,{items:[{id:'x',title:'X',description:'d',status:'todo',statusLabel:'Chưa cài'}],onAction(){},onConfirmInstall:(...a)=>conf.push(a)})));
 await act(async()=>btn(c,'Cài đặt — X').click());
 const ok=btn(c,'Xác nhận cài đặt');assert.equal(ok.disabled,true);
 await act(async()=>ok.click());assert.equal(conf.length,0);
});
test.after(()=>{setTimeout(()=>process.exit(process.exitCode??0),200).unref?.();setTimeout(()=>process.exit(process.exitCode??0),300);});
