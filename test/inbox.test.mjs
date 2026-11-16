import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><main id="app"></main>',{url:'https://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement});
const {default:plugin,services,mountInbox}=await import('../dist/control-ui/index.js');
const tick=()=>new Promise(r=>setTimeout(r,120));
function fresh(){const c=document.createElement('main');document.body.append(c);return c;}
test('exact official service links, no custom redirect or credentials',()=>{
 assert.deepEqual(services.flatMap(s=>s.links.map(l=>l.href)),['https://mail.google.com/','https://outlook.live.com/mail/','https://chat.zalo.me/','https://www.messenger.com/']);
});
test('renders three truthful cards, accessible external links and disposes',async()=>{
 const container=fresh();const view=mountInbox(container);await tick();
 assert.equal(container.querySelectorAll('article').length,3);
 const chips=[...container.querySelectorAll('.openclaw-personal__status')];
 assert.equal(chips.filter(n=>n.textContent==='Chưa kết nối vào trang').length,3);
 const links=[...container.querySelectorAll('a')];assert.equal(links.length,4);
 for(const link of links){assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.ok(link.getAttribute('aria-label'));}
 assert.ok(container.textContent.includes('Chưa đồng bộ nội dung'));
 assert.equal(container.querySelectorAll('iframe,input,textarea,script').length,0);
 view.dispose();await tick();assert.equal(container.children.length,0);
});
test('registers a single navigation item, no replacement or RPC',()=>{
 const calls=[];const disposed=[];
 const host={ui:{registerPage(p){calls.push(['page',p]);return ()=>disposed.push('page:'+p.id);},registerNavigation(n){calls.push(['nav',n]);return ()=>disposed.push('nav:'+n.id);}}};
 const dispose=plugin.activate(host);
 const pages=calls.filter(c=>c[0]==='page').map(c=>c[1].id),navs=calls.filter(c=>c[0]==='nav').map(c=>c[1]);
 assert.deepEqual(pages,['personal']);
 assert.deepEqual(navs.map(n=>[n.id,n.parent]),[['personal',undefined]]);
 assert.ok(navs.every(n=>n.page.id===n.id));
 dispose();assert.equal(disposed.length,2);
});
test('trang con chỉ hiển thị một dịch vụ',async()=>{
 const container=fresh();const view=mountInbox(container,undefined,'zalo');await tick();
 assert.equal(container.querySelectorAll('article').length,1);assert.ok(container.querySelector('h1').textContent==='Zalo cá nhân');
 view.dispose();await tick();
});
