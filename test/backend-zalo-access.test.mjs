import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './_load.mjs';
const {createAccessStore,createZaloStore,zaloAccountPaths}=await loadTs('src/connectors/backend/zalo/store.ts');
const {createZaloService,conversationOfDispatch,conversationOfSending}=await loadTs('src/connectors/backend/zalo/service.ts');
const {zaloOperations,ZALO_OPERATION_IDS:ID}=await loadTs('src/connectors/backend/zalo/contract.ts');
const {Value}=await import('typebox/value');
const mem=()=>{const f=new Map();return {f,io:{read:async p=>f.get(p),write:async(p,c)=>{f.set(p,c);}}};};
const cli={list:async()=>[],send:async()=>{},enableHistory:async()=>{},addAccount:async()=>{},removeAccount:async()=>{}};
function svc(access,t={v:1000}){
 const store=createZaloStore({io:mem().io,file:'/h'});
 return createZaloService({cli,store,access,getConfig:()=>undefined,now:()=>t.v});
}
const OPS=[ID.accessGet,ID.accessSet,ID.sendAllow];

test('id operation hợp lệ và đã nằm trong contract',()=>{
 for(const id of OPS){assert.match(id,/^[a-z][a-z0-9._-]{0,127}$/);assert.ok(zaloOperations[id]);}
});
test('contract: schema chặt cho conversationId và access',()=>{
 const set=zaloOperations[ID.accessSet].input;
 assert.ok(Value.Check(set,{conversationId:'123',access:'read'}));
 assert.ok(Value.Check(set,{conversationId:'group:9',access:'none',accountId:'acc-1'}));
 for(const bad of [{conversationId:'123',access:'admin'},{conversationId:'../x',access:'read'},{conversationId:'123'},{conversationId:'123',access:'read',x:1}])assert.ok(!Value.Check(set,bad));
 assert.ok(Value.Check(zaloOperations[ID.accessGet].output,{access:'write'}));
 assert.ok(!Value.Check(zaloOperations[ID.accessGet].output,{access:'x'}));
});
test('store: mặc định write, chỉ lưu khi khác mặc định, bền qua khởi động lại',async()=>{
 const m=mem();const a=createAccessStore('/a.json',m.io);
 assert.equal(await a.get('1'),'write');
 await a.set('1','read');await a.set('group:2','none');
 assert.equal(await a.get('1'),'read');
 assert.deepEqual(JSON.parse(m.f.get('/a.json')),{v:1,access:{'1':'read','group:2':'none'}});
 await a.set('1','write');
 assert.deepEqual(JSON.parse(m.f.get('/a.json')).access,{'group:2':'none'});
 const b=createAccessStore('/a.json',m.io);
 assert.equal(await b.get('group:2'),'none');assert.equal(await b.get('1'),'write');
 assert.equal(await createAccessStore('/x',{read:async()=>'{rác',write:async()=>{}}).get('1'),'write');
 assert.match(zaloAccountPaths('/r','acc-1').access,/accounts\/acc-1\/access\.json$/);
});
test('store: ghi lỗi thì giữ giá trị cũ',async()=>{
 const m=mem();let fail=false;
 const a=createAccessStore('/a.json',{read:m.io.read,write:async(p,c)=>{if(fail)throw new Error('disk');m.f.set(p,c);}});
 await a.set('1','read');fail=true;
 await assert.rejects(a.set('1','none'));
 assert.equal(await a.get('1'),'read');
});
test('op get/set: kiểm tra input, theo từng tài khoản',async()=>{
 const stores={};
 const store=createZaloStore({io:mem().io,file:'/h'});
 const s=createZaloService({cli,forAccount:id=>({store,access:(stores[id]??=createAccessStore('/'+id,mem().io))}),getConfig:()=>undefined});
 const h=s.handlers;
 assert.deepEqual(await h[ID.accessGet]({conversationId:'1'}),{access:'write'});
 assert.deepEqual(await h[ID.accessSet]({conversationId:'1',access:'read'}),{ok:true});
 assert.deepEqual(await h[ID.accessGet]({conversationId:'1'}),{access:'read'});
 assert.deepEqual(await h[ID.accessGet]({conversationId:'1',accountId:'b'}),{access:'write'});
 for(const bad of [{conversationId:'1',access:'x'},{conversationId:'bad id',access:'none'},{conversationId:'1',access:'none',accountId:'../'},null])assert.deepEqual(await h[ID.accessSet](bad),{ok:false});
 assert.deepEqual(await h[ID.accessGet]({conversationId:'1'}),{access:'read'});
});
test('op set: lỗi ghi store -> ok:false', async()=>{
 const s=svc({get:async()=>'write',set:async()=>{throw new Error('x');}});
 assert.deepEqual(await s.handlers[ID.accessSet]({conversationId:'1',access:'none'}),{ok:false});
});

const dispatch=(over={},ctx={})=>[{content:'hi',body:'hi',channel:'zalouser',isGroup:false,senderId:'42',...over},{channelId:'zalouser',accountId:'default',conversationId:'zalouser:99',senderId:'42',...ctx}];
const sending=(to,content='trả lời',ctx={})=>[{to,content,metadata:{channel:'zalouser',accountId:'default'}},{channelId:'zalouser',accountId:'default',conversationId:to,...ctx}];

test('suy ra hội thoại từ event/ctx hook; kênh khác bị bỏ qua',()=>{
 assert.deepEqual(conversationOfDispatch(...dispatch()),{accountId:'default',conversationId:'42'});
 assert.deepEqual(conversationOfDispatch(...dispatch({isGroup:true},{conversationId:'zalouser:group:7'})),{accountId:'default',conversationId:'group:7'});
 assert.deepEqual(conversationOfDispatch(...dispatch({isGroup:true},{conversationId:'7',accountId:'acc-1'})),{accountId:'acc-1',conversationId:'group:7'});
 assert.equal(conversationOfDispatch(...dispatch({channel:'telegram'},{channelId:'telegram'})),undefined);
 assert.equal(conversationOfDispatch(...dispatch({},{accountId:'../x'})),undefined);
 assert.deepEqual(conversationOfSending(...sending('zalouser:42')),{accountId:'default',conversationId:'42',content:'trả lời'});
 assert.deepEqual(conversationOfSending(...sending('group:7')),{accountId:'default',conversationId:'group:7',content:'trả lời'});
 assert.equal(conversationOfSending({to:'42',content:'x'},{channelId:'telegram'}),undefined);
});
test('hook before_dispatch: chỉ none mới handled; mặc định/read/write cho qua',async()=>{
 const a=createAccessStore('/a',mem().io);const s=svc(a);
 assert.equal(await s.beforeDispatch(...dispatch()),undefined);
 await a.set('42','read');assert.equal(await s.beforeDispatch(...dispatch()),undefined);
 await a.set('42','none');assert.deepEqual(await s.beforeDispatch(...dispatch()),{handled:true});
 assert.equal(await s.beforeDispatch(...dispatch({senderId:'43'},{senderId:'43'})),undefined);
 assert.equal(await s.beforeDispatch(...dispatch({channel:'telegram'},{channelId:'telegram'})),undefined);
 await a.set('group:7','none');
 assert.deepEqual(await s.beforeDispatch(...dispatch({isGroup:true},{conversationId:'group:7'})),{handled:true});
});
test('hook message_sending: write cho qua; read/none chặn; kênh khác không bị đụng',async()=>{
 const a=createAccessStore('/a',mem().io);const s=svc(a);
 assert.equal(await s.messageSending(...sending('42')),undefined);
 await a.set('42','read');
 assert.equal((await s.messageSending(...sending('42'))).cancel,true);
 await a.set('42','none');
 assert.equal((await s.messageSending(...sending('zalouser:42'))).cancel,true);
 assert.equal(await s.messageSending(...sending('43')),undefined);
 assert.equal(await s.messageSending({to:'42',content:'x'},{channelId:'telegram',conversationId:'42'}),undefined);
});
test('hook fail-open: lỗi đọc store hoặc không có store không chặn và không ném',async()=>{
 const boom=svc({get:async()=>{throw new Error('io');},set:async()=>{}});
 assert.equal(await boom.beforeDispatch(...dispatch()),undefined);
 assert.equal(await boom.messageSending(...sending('42')),undefined);
 assert.deepEqual(await boom.handlers[ID.accessGet]({conversationId:'42'}),{access:'write'});
 const none=svc(undefined);
 assert.equal(await none.messageSending(...sending('42')),undefined);
 assert.equal(await boom.beforeDispatch(null,undefined),undefined);
 assert.equal(await boom.messageSending(undefined,null),undefined);
});
test('tin người dùng tự gửi từ Hộp thư được cho qua khi đã báo trước, hết hạn thì chặn lại',async()=>{
 const t={v:1000};const a=createAccessStore('/a',mem().io);const s=svc(a,t);
 await a.set('42','read');
 assert.deepEqual(await s.handlers[ID.sendAllow]({conversationId:'42',text:' chào '}),{ok:true});
 assert.equal(await s.messageSending(...sending('42','chào')),undefined);
 assert.equal((await s.messageSending(...sending('42','lời của AI'))).cancel,true);
 assert.equal(await s.messageSending(...sending('43','chào')),undefined);
 await s.handlers[ID.sendAllow]({conversationId:'42'}); // tệp không chú thích: khớp mọi nội dung
 assert.equal(await s.messageSending(...sending('42','')),undefined);
 t.v+=31_000;
 assert.equal((await s.messageSending(...sending('42','chào'))).cancel,true);
 assert.deepEqual(await s.handlers[ID.sendAllow]({conversationId:'bad id'}),{ok:false});
});
