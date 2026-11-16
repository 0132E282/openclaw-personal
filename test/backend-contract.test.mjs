import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './_load.mjs';
const {backendOperations:ops,BACKEND_OPERATION_IDS:ids}=await loadTs('src/connectors/backend/contract.ts');
test('đủ 11 operation với kind đúng và input/output là schema',()=>{
 const kinds={'setup.check':'query','notify.send':'action','messenger.login.start':'action','messenger.login.status':'query','messenger.login.cancel':'action','messenger.cookies.set':'action','messenger.cookies.clear':'action','messenger.status':'query','messenger.conversations':'query','messenger.messages':'query','messenger.send':'action'};
 assert.deepEqual(Object.keys(ops).sort(),Object.keys(kinds).sort());
 for(const [id,k] of Object.entries(kinds)){assert.equal(ops[id].kind,k);assert.equal(ops[id].input.type,'object');assert.equal(ops[id].output.type,'object');assert.equal(ops[id].input.additionalProperties,false);}
 assert.equal(ids.messengerCookiesSet,'messenger.cookies.set');
});
test('không output nào có trường cookie/value/token',()=>{
 for(const op of Object.values(ops)) assert.doesNotMatch(JSON.stringify(op.output),/"(cookies?|value|token)"/);
});
const {Value}=await import('typebox/value');
test('messenger.status/conversations/messages/send: schema nhận mẫu đúng, từ chối mẫu sai',()=>{
 const ok=(id,part,v)=>Value.Check(ops[id][part],v);
 assert.ok(ok('messenger.status','output',{state:'expired',reason:'not-logged-in'}));
 assert.ok(ok('messenger.status','output',{state:'connected',reason:null}));
 assert.ok(!ok('messenger.status','output',{state:'lạ',reason:null}));
 assert.ok(ok('messenger.conversations','input',{}));
 assert.ok(ok('messenger.conversations','input',{folder:'unread'}));
 assert.ok(!ok('messenger.conversations','input',{folder:'../x'}));
 const c={id:'1',title:'An',snippet:'hi',time:'5 phút',unread:true,isGroup:false};
 assert.ok(ok('messenger.conversations','output',{ok:true,conversations:[c],e2eeHidden:0}));
 assert.ok(ok('messenger.conversations','output',{ok:false,reason:'selector-broken',conversations:[],e2eeHidden:0}));
 assert.ok(!ok('messenger.conversations','output',{ok:true,conversations:[{...c,cookie:'x'}],e2eeHidden:0}));
 assert.ok(!ok('messenger.messages','input',{conversationId:'a/b'}));
 assert.ok(ok('messenger.messages','output',{ok:true,messages:[{id:'m0',from:'me',senderName:'',text:'x',time:''}]}));
 assert.ok(!ok('messenger.messages','output',{ok:true,messages:[{id:'m0',from:'ai',senderName:'',text:'x',time:''}]}));
 assert.ok(ok('messenger.send','input',{conversationId:'12',text:'xin chào'}));
 assert.ok(!ok('messenger.send','input',{conversationId:'12',text:''}));
 assert.ok(!ok('messenger.send','input',{conversationId:'12',text:'x'.repeat(4001)}));
 assert.ok(ok('messenger.send','output',{ok:false,reason:'rate-limited'}));
});
