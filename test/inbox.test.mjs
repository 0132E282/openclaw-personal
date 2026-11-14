import test from 'node:test';
import assert from 'node:assert/strict';
import plugin,{services,mountInbox} from '../src/control-ui.js';
class Element {
 constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.attrs={};this.dataset={};this.textContent='';}
 setAttribute(k,v){this.attrs[k]=v;}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
 remove(){this.parent.children=this.parent.children.filter(x=>x!==this);}
}
function tree(){const doc={createElement(tag){return new Element(tag,doc);}};return new Element('main',doc);}
function all(n){return [n,...n.children.flatMap(all)];}
test('exact official service links, no custom redirect or credentials',()=>{
 assert.deepEqual(services.flatMap(s=>s.links.map(l=>l.href)),['https://mail.google.com/','https://outlook.live.com/mail/','https://chat.zalo.me/','https://www.messenger.com/']);
});
test('renders three truthful cards, accessible external links and disposes',()=>{
 const container=tree();const view=mountInbox(container);const nodes=all(container);
 assert.equal(nodes.filter(n=>n.tagName==='article').length,3);
 assert.equal(nodes.filter(n=>n.className==='openclaw-personal__status'&&n.textContent==='Chưa kết nối vào trang').length,3);
 const links=nodes.filter(n=>n.tagName==='a');assert.equal(links.length,4);
 for(const link of links){assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.ok(link.attrs['aria-label']);}
 assert.ok(nodes.some(n=>n.textContent.includes('Chưa đồng bộ nội dung')));
 assert.equal(nodes.filter(n=>['iframe','input','textarea','script'].includes(n.tagName)).length,0);
 view.dispose();assert.equal(container.children.length,0);
});
test('registers only isolated page/navigation, no replacement or RPC',()=>{
 const calls=[];const disposed=[];
 const host={ui:{registerPage(p){calls.push(['page',p]);return ()=>disposed.push('page');},registerNavigation(n){calls.push(['nav',n]);return ()=>disposed.push('nav');}}};
 const dispose=plugin.activate(host);assert.equal(calls.length,2);assert.equal(calls[0][1].id,'inbox');assert.equal(calls[1][1].page.id,'inbox');dispose();assert.deepEqual(disposed,['nav','page']);
});
