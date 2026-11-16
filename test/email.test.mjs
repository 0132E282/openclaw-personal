import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {loadTs} from './_load.mjs';
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement});
const email=await loadTs('src/connectors/email.ts');
const ui=await loadTs('src/control-ui.tsx');
const {readEmailStatus,createEmailStatusHandler,EMAIL_STATUS_OPERATION_ID}=email;
const tick=(ms=120)=>new Promise(r=>setTimeout(r,ms));
const SECRETS=['P@ss','IMAP_PASSWORD','HT-token','PT-push'];
test('AC-001 Gmail PubSub',()=>{
 const ok={hooks:{enabled:true,presets:['gmail'],gmail:{account:'a@x.com'}}};
 assert.equal(readEmailStatus(ok).gmailPubSub.state,'configured');
 assert.equal(readEmailStatus({hooks:{presets:['gmail'],gmail:{account:'a@x.com'}}}).gmailPubSub.state,'not-configured');
 assert.equal(readEmailStatus({hooks:{enabled:true,presets:['gmail'],gmail:{}}}).gmailPubSub.state,'not-configured');
 assert.equal(readEmailStatus({}).gmailPubSub.state,'not-configured');
});
test('AC-002 IMAP',()=>{
 const accounts={a:{password:'P@ss'},b:{password:{source:'store',provider:'default',id:'IMAP_PASSWORD'}}};
 assert.deepEqual(readEmailStatus({plugins:{entries:{imap:{enabled:true,config:{accounts}}}}}).imap,{state:'configured',accountCount:2});
 assert.equal(readEmailStatus({plugins:{entries:{imap:{enabled:false}}}}).imap.state,'disabled');
 assert.equal(readEmailStatus({}).imap.state,'not-configured');
});
test('AC-003 không lộ bí mật, không có khóa nhạy cảm',()=>{
 const cfg={hooks:{enabled:true,token:'HT-token',presets:['gmail'],gmail:{account:'a@x.com',pushToken:'PT-push'}},plugins:{entries:{imap:{enabled:true,config:{accounts:{a:{password:'P@ss'},b:{password:{id:'IMAP_PASSWORD'}}}}}}}};
 const out=JSON.stringify(readEmailStatus(cfg));
 for(const s of SECRETS)assert.ok(!out.includes(s),s);
 assert.doesNotMatch(out,/password|token|secret|a@x\.com/i);
});
test('config lỗi/getter ném -> unknown, không ném',()=>{
 const bad={get hooks(){throw new Error('x');},get plugins(){throw new Error('y');}};
 const s=readEmailStatus(bad);assert.equal(s.gmailPubSub.state,'unknown');assert.equal(s.imap.state,'unknown');assert.equal(s.outlook.state,'launcher-only');
});
test('handler ưu tiên runtime.config.current rồi api.config',async()=>{
 const a={hooks:{enabled:true,presets:['gmail'],gmail:{account:'x'}}};
 assert.equal((await createEmailStatusHandler({runtime:{config:{current:()=>a}},config:{}})()).gmailPubSub.state,'configured');
 assert.equal((await createEmailStatusHandler({config:a})()).gmailPubSub.state,'configured');
 assert.equal(EMAIL_STATUS_OPERATION_ID,'email.status');
});
test('AC-004 contract: query, không tool, tools manifest rỗng, build backend nạp được',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../openclaw.plugin.json',import.meta.url)));
 assert.deepEqual(manifest.contracts.tools,[]);
 const src=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
 assert.match(src,/kind:'query'/);assert.doesNotMatch(src,/tool:\s*\{/);assert.doesNotMatch(src,/kind:'action'/);
 const backend=await import('../dist/index.js');assert.ok(backend.default);
});
async function mount(host){const c=document.createElement('main');document.body.append(c);const v=ui.mountInbox(c,{host});await tick();return {c,v};}
const emailCard=c=>[...c.querySelectorAll('article')].find(a=>a.textContent.includes('Gmail PubSub'));
test('AC-005/006 render 3 dòng, Outlook luôn launcher, link giữ nguyên, gọi đúng operation',async()=>{
 const calls=[];const status={gmailPubSub:{state:'not-configured',hooksEnabled:false,presetEnabled:false},imap:{state:'configured',accountCount:2},outlook:{state:'launcher-only'}};
 const host={request:async(m,p)=>{calls.push([m,p]);return m==='plugins.sessionAction'?{ok:true,result:status}:{};}};
 const {c}=await mount(host);const card=emailCard(c);
 assert.equal(card.querySelectorAll('.openclaw-personal__email-status li').length,3);
 assert.ok(card.textContent.includes('Chưa cấu hình — xem: openclaw webhooks gmail setup'));
 assert.ok(card.textContent.includes('2 tài khoản'));
 assert.ok(card.textContent.includes('Chưa có tích hợp OpenClaw đã xác minh'));
 assert.deepEqual(calls.find(x=>x[1]?.actionId),['plugins.sessionAction',{pluginId:'openclaw-personal',actionId:'email.status',payload:{}}]);
 assert.deepEqual([...card.querySelectorAll('a')].map(a=>a.href),['https://mail.google.com/','https://outlook.live.com/mail/']);
 assert.equal(c.querySelectorAll('iframe,input,textarea,script').length,0);
});
test('AC-007 lỗi RPC -> Không xác định được trạng thái; dispose không ném',async()=>{
 const host={request:async m=>{if(m==='plugins.sessionAction')throw new Error('x');return {};}};
 const {c,v}=await mount(host);assert.ok(emailCard(c).textContent.includes('Không xác định được trạng thái'));
 v.dispose();await tick();assert.equal(c.children.length,0);
});
test('AC-008 mã nguồn email không có gửi/ghi config/fetch',async()=>{
 for(const f of ['src/connectors/email.ts','src/connectors/EmailStatus.tsx']){
  const t=await readFile(new URL('../'+f,import.meta.url),'utf8');
  for(const bad of ['send','config.patch','config.set','fetch('])assert.ok(!t.includes(bad),f+' chứa '+bad);
 }
});
