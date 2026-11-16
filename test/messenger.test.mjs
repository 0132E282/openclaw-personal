import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {loadTs} from './_load.mjs';
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement});
const m=await loadTs('src/connectors/messenger.ts');
const ui=await loadTs('src/control-ui.tsx');
const {normalizeMessengerStatus:norm,readMessengerStatus:read,MESSENGER_DISCLAIMER}=m;
const tick=(ms=120)=>new Promise(r=>setTimeout(r,ms));
const acct=(extra={})=>({accountId:'default',enabled:true,configured:true,running:false,lastError:'channel exited without an error',...extra});
const raw=(accounts,order=['fb-messenger'])=>({channelOrder:order,channelAccounts:accounts===undefined?{}:{'fb-messenger':accounts}});
const WHITELIST=['channelId','scope','state','accountCount','runningCount','reason','label','disclaimer'].sort();
test('AC-001 bảng trạng thái',()=>{
 assert.deepEqual([norm(raw([acct({running:true}),acct()])).state,norm(raw([acct({running:true}),acct()])).accountCount,norm(raw([acct({running:true}),acct()])).runningCount],['running',2,1]);
 assert.equal(norm(raw([acct()])).state,'configured');
 assert.equal(norm(raw([])).state,'installed');
 assert.equal(norm(raw(undefined)).state,'installed');
 assert.equal(norm({channelOrder:['zalouser'],channelAccounts:{zalouser:[acct()]}}).state,'unavailable');
 assert.equal(norm({channelAccounts:{messenger:[acct({running:true})]}}).state,'unavailable');
 for(const bad of [null,'x',{},{channelAccounts:'x'}]) assert.equal(norm(bad).state,'unknown');
});
test('AC-004/005 whitelist, không lộ bí mật, scope và disclaimer',()=>{
 const out=norm(raw([acct({pageAccessToken:'S1',appSecret:'S2',botKey:'S3',verifyToken:'S4',lastError:'S5'})]));
 assert.deepEqual(Object.keys(out).sort(),WHITELIST);
 assert.doesNotMatch(JSON.stringify(out),/S[1-5]/);
 assert.equal(out.scope,'facebook-page');assert.match(out.disclaimer,/không phải Messenger cá nhân/);
});
test('AC-002/003 chỉ gọi channels.status; lỗi/thiếu request/timeout/sai dạng -> unknown, không ném',async()=>{
 const calls=[];const ok={request:async(method,p)=>{calls.push([method,p]);return raw([acct()]);}};
 assert.equal((await read(ok)).state,'configured');assert.deepEqual(calls,[['channels.status',{}]]);
 assert.equal((await read({})).state,'unknown');assert.equal((await read(undefined)).state,'unknown');
 assert.equal((await read({request:async()=>{throw new Error('SECRET-ERR');}})).state,'unknown');
 const r=await read({request:async()=>{throw new Error('SECRET-ERR');}});assert.doesNotMatch(JSON.stringify(r),/SECRET/);
 assert.equal((await read({request:()=>new Promise(()=>{})},{timeoutMs:20})).state,'unknown');
 assert.equal((await read({request:async()=>'x'})).state,'unknown');
});
test('AC-006 abort -> reject, không trả trạng thái',async()=>{
 const c=new AbortController();const p=read({request:()=>new Promise(r=>setTimeout(()=>r(raw([acct()])),30))},{signal:c.signal});c.abort();
 await assert.rejects(p);
});
test('AC-007 module không export send/reply/connect/start',()=>{
 for(const k of Object.keys(m)) assert.doesNotMatch(k,/send|reply|connect|start/i);
});
async function mount(host){const c=document.createElement('main');document.body.append(c);const v=ui.mountInbox(c,{host});await tick();return {c,v};}
const card=c=>[...c.querySelectorAll('article')].find(a=>a.textContent.includes('Messenger cá nhân'));
test('UI: thẻ Messenger hiện chip + disclaimer, giữ link messenger.com, không có điều khiển gửi',async()=>{
 const calls=[];const host={request:async(method)=>{calls.push(method);return method==='channels.status'?raw([acct()]):{ok:false};}};
 const {c}=await mount(host);const el=card(c);
 assert.ok(el.textContent.includes('Đã cấu hình, chưa chạy'));assert.ok(el.textContent.includes(MESSENGER_DISCLAIMER));
 assert.equal(el.querySelector('a').href,'https://www.messenger.com/');
 assert.equal(c.querySelectorAll('iframe,input,textarea,script').length,0);
 assert.ok(!/gửi tin|Gửi/.test([...el.querySelectorAll('button')].map(b=>b.textContent).join('')));
});
test('UI: lỗi -> Không xác định + Thử lại gọi lại đúng 1 lần; dispose sạch',async()=>{
 let n=0;let failing=true;const host={request:async method=>{if(method==='channels.status'){n++;if(failing)throw new Error('x');return raw([acct({running:true})]);}return {ok:false};}};
 const {c,v}=await mount(host);let el=card(c);assert.ok(el.textContent.includes('Không xác định'));
 const b=el.querySelector('button.openclaw-personal__messenger-retry');assert.equal(b.type,'button');
 failing=false;const before=n;b.click();await tick();
 assert.equal(n,before+1);assert.ok(card(c).textContent.includes('Đang hoạt động'));v.dispose();await tick();assert.equal(c.children.length,0);
});
test('UI: không có host -> nhãn tĩnh cũ, launcher vẫn render',async()=>{
 const {c}=await mount(undefined);const el=card(c);
 assert.ok(el.textContent.includes('Chưa kết nối vào trang'));assert.equal(el.querySelectorAll('a').length,1);
});
