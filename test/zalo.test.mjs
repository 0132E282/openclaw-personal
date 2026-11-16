import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {loadTs} from './_load.mjs';
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:false});
const zalo=await loadTs('src/connectors/zalo.ts');
const ui=await loadTs('src/control-ui.tsx');
const {deriveZaloStatus,ZALO_STATE_COPY,RISK_NOTICE}=zalo;
const tick=(ms=120)=>new Promise(r=>setTimeout(r,ms));
const acc=(extra={},id='default')=>({accountId:id,enabled:true,configured:true,linked:true,running:true,lastError:null,...extra});
const result=(accounts,extra={})=>({channelOrder:['zalouser'],channelAccounts:{zalouser:accounts},channelDefaultAccountId:{zalouser:'default'},statusIssues:[],...extra});
test('AC-001 not linked, kể cả khi Gateway kèm statusIssues auth',()=>{
 const r=result([acc({linked:false,running:false})],{statusIssues:[{channel:'zalouser',kind:'auth',message:'Not authenticated'}]});
 assert.equal(deriveZaloStatus(r).state,'not-linked');
 assert.match(ZALO_STATE_COPY['not-linked'].hint,/openclaw channels login --channel zalouser/);
});
test('AC-002/003/004 bảng trạng thái',()=>{
 const cases=[
  [result([acc()]),'running'],
  [result([acc({connected:false})]),'unknown'],
  [{channelAccounts:{}},'not-installed'],
  [{channelAccounts:{zalo:[acc()],'openclaw-zaloclawbot':[acc()]}},'not-installed'],
  [result([acc({enabled:false})]),'disabled'],
  [result([acc({configured:false})]),'not-configured'],
  [result([acc({running:false})]),'stopped'],
  [result([acc({lastError:'boom'})]),'error'],
  [result([acc()],{statusIssues:[{channel:'zalouser'}]}),'error'],
  [null,'unknown'],['x','unknown'],[{channelAccounts:'x'},'unknown'],
 ];
 for(const [input,state] of cases) assert.equal(deriveZaloStatus(input).state,state,JSON.stringify(input));
 assert.match(ZALO_STATE_COPY['not-installed'].hint,/openclaw plugins install @openclaw\/zalouser/);
 assert.equal(deriveZaloStatus(result([acc(),acc({},'b')])).otherAccountCount,1);
});
test('đầu ra không chứa trường nhạy cảm',()=>{
 const out=JSON.stringify(deriveZaloStatus(result([acc({lastError:'SECRET-ERR',allowFrom:['SECRET-ID'],credentialSource:'SECRET-SRC'})])));
 assert.doesNotMatch(out,/SECRET/);
});
async function mount(host,context={}){
 const container=document.createElement('main');document.body.append(container);
 const view=ui.mountInbox(container,{host,...context});await tick();return {container,view};
}
const zaloCard=c=>[...c.querySelectorAll('article')].find(a=>a.textContent.includes('Zalo cá nhân'));
test('AC-006 chỉ gọi channels.status, không probe; hiển thị Chưa liên kết + cảnh báo, giữ link và không lộ lỗi thô',async()=>{
 const calls=[];const r=result([acc({linked:false,running:false,lastError:'SECRET-ERR',allowFrom:['SECRET-ID']})]);
 const host={request:async(m,p)=>{calls.push([m,p]);return r;}};
 const {container,view}=await mount(host);
 const card=zaloCard(container);
 assert.deepEqual([...new Set(calls.filter(c=>c[0]!=='plugins.sessionAction').map(c=>c[0]))],['channels.status']);
 assert.ok(calls.every(c=>c[1]?.probe===undefined));
 assert.ok(card.textContent.includes('Chưa liên kết'));assert.ok(card.textContent.includes(RISK_NOTICE));assert.ok(card.textContent.includes('Zalo OA'));
 assert.doesNotMatch(container.textContent,/SECRET/);
 const link=card.querySelector('a');assert.equal(link.href,'https://chat.zalo.me/');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
 assert.equal(container.querySelectorAll('iframe,input,textarea,script').length,0);
 view.dispose();await tick();
});
test('AC-005 lỗi RPC -> Thử lại gọi đúng 1 lần nữa',async()=>{
 let n=0;let failing=true;const host={request:async m=>{if(m==='channels.status'){n++;if(failing)throw new Error('down');return result([acc({linked:false,running:false})]);}return {ok:false};}};
 const {container}=await mount(host);const card=zaloCard(container);
 assert.ok(card.textContent.includes('Không đọc được trạng thái'));
 const btn=card.querySelector('button.openclaw-personal__zalo-refresh');assert.equal(btn.textContent,'Thử lại');assert.ok(btn.getAttribute('aria-label'));assert.equal(btn.type,'button');
 failing=false;const before=n;btn.click();await tick();assert.equal(n,before+1);assert.ok(zaloCard(container).textContent.includes('Chưa liên kết'));
});
test('dispose trước khi RPC trả về -> không ghi DOM, container rỗng',async()=>{
 let resolve;const host={request:m=>m==='channels.status'?new Promise(r=>{resolve=r;}):Promise.resolve({ok:false})};
 const container=document.createElement('main');document.body.append(container);
 const view=ui.mountInbox(container,{host});await tick();view.dispose();await tick();
 resolve(result([acc()]));await tick();assert.equal(container.children.length,0);
});
test('không có host -> hành vi cũ, nhãn tĩnh',async()=>{
 const {container}=await mount(undefined);
 assert.equal([...container.querySelectorAll('.openclaw-personal__status')].filter(n=>n.textContent==='Chưa kết nối vào trang').length,3);
});
