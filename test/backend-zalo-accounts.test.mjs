import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './_load.mjs';
const {createZaloCli,ZaloCliError}=await loadTs('src/connectors/backend/zalo/cli.ts');
const {createZaloStore,createAccountMarker,createDirectorySnapshot,zaloAccountPaths}=await loadTs('src/connectors/backend/zalo/store.ts');
const {createAvatarStore}=await loadTs('src/connectors/backend/zalo/avatars.ts');
const {createZaloService,normalizeInbound,normalizeOutbound}=await loadTs('src/connectors/backend/zalo/service.ts');
const {zaloOperations,zaloEvents}=await loadTs('src/connectors/backend/zalo/contract.ts');
const {Value}=await import('typebox/value');
const mem=()=>{const f=new Map();return {f,io:{read:async p=>f.get(p),write:async(p,c)=>{f.set(p,c);}}};};
const ROOT='/state/openclaw-personal';

test('đường dẫn: default giữ file cũ, tài khoản khác nằm thư mục riêng, id lạ bị từ chối',()=>{
 const d=zaloAccountPaths(ROOT);
 assert.deepEqual(d,{dir:`${ROOT}/zalo`,history:`${ROOT}/zalo/history.json`,marker:`${ROOT}/zalo/account.json`,snapshot:`${ROOT}/zalo/directory.json`,avatars:`${ROOT}/zalo/avatars`,access:`${ROOT}/zalo/access.json`});
 assert.deepEqual(zaloAccountPaths(ROOT,'default'),d);
 const a=zaloAccountPaths(ROOT,'acc-1x');
 assert.equal(a.history,`${ROOT}/zalo/accounts/acc-1x/history.json`);assert.equal(a.avatars,`${ROOT}/zalo/accounts/acc-1x/avatars`);
 for(const bad of ['../x','a/b','a.b','','x'.repeat(41),'a b'])assert.throws(()=>zaloAccountPaths(ROOT,bad),/invalid-account/);
});

test('store, marker, snapshot, avatars tách theo tài khoản: xóa một bên không chạm bên kia',async()=>{
 const m=mem();
 const mk=id=>{const p=zaloAccountPaths(ROOT,id);return {p,store:createZaloStore({io:m.io,file:p.history}),marker:createAccountMarker(p.marker,m.io),snap:createDirectorySnapshot(p.snapshot,m.io)};};
 const A=mk('default'),B=mk('acc-b');
 const msg=(t)=>({conversationId:'1',kind:'direct',message:{id:t,at:'2026-01-01T00:00:00Z',text:t,fromMe:false}});
 await A.store.append(msg('của A'));await B.store.append(msg('của B'));
 await A.marker.save('uA');await B.marker.save('uB');
 await A.snap.save([{id:'1',name:'An A',kind:'direct'}]);await B.snap.save([{id:'1',name:'An B',kind:'direct'}]);
 assert.equal((await A.store.messages('1'))[0].text,'của A');assert.equal((await B.store.messages('1'))[0].text,'của B');
 assert.equal(await A.marker.load(),'uA');assert.equal(await B.marker.load(),'uB');
 assert.equal((await A.snap.load())[0].name,'An A');assert.equal((await B.snap.load())[0].name,'An B');
 await B.store.clear();
 assert.equal((await B.store.messages('1')).length,0);assert.equal((await A.store.messages('1')).length,1);
 // mở lại từ file: vẫn tách
 assert.equal((await mk('default').store.messages('1'))[0].text,'của A');
 const {mkdtemp,readdir}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'acc-'));
 const fetchImage=async()=>({type:'image/png',bytes:new Uint8Array([9,9])});
 const av=id=>createAvatarStore({dir:zaloAccountPaths(root,id).avatars,fetchImage});
 const a=av('default'),b=av('acc-b');
 await a.ensure([{id:'1',avatarUrl:'https://a.zadn.vn/1'}]);
 assert.ok(a.get('1'));assert.equal(b.get('1'),undefined);
 await b.ensure([{id:'2',avatarUrl:'https://a.zadn.vn/2'}]);await b.clear();
 assert.equal(b.get('2'),undefined);assert.ok(a.get('1'));
 assert.deepEqual(await readdir(zaloAccountPaths(root,'default').avatars),['1.png']);
 assert.deepEqual(await readdir(zaloAccountPaths(root,'acc-b').avatars),[]);
});

function twoAccounts({list}={}){
 const mems={};const listCalls=[],sendCalls=[],cleared=[];
 const forAccount=id=>{const m=mem();mems[id]=m;return {
  store:createZaloStore({io:m.io,file:'/h.json'}),
  account:createAccountMarker('/a.json',m.io),
  snapshot:createDirectorySnapshot('/d.json',m.io),
  avatars:{ready:async()=>{},ensure:async()=>{},get:()=>undefined,clear:async()=>{cleared.push(id);}},
 };};
 const cli={list:async(k,acc)=>{listCalls.push([k,acc]);return list?list(k,acc):(k==='group'?[]:[{id:acc==='acc-b'?'20':'10',name:acc==='acc-b'?'Người B':'Người A',kind:'direct'}]);},send:async(id,t,acc)=>{sendCalls.push([id,t,acc]);}};
 let t=Date.parse('2026-01-01T00:00:00Z');
 const s=createZaloService({cli,forAccount,getConfig:()=>({plugins:{entries:{'openclaw-personal':{hooks:{allowConversationAccess:true}}}}}),now:()=>t++});
 return {s,h:s.handlers,listCalls,sendCalls,cleared,mems};
}

test('hook: ghi đúng tài khoản theo ctx.accountId (thiếu = default), trả accountId cho sự kiện, bỏ id lạ',async()=>{
 const f=twoAccounts();
 const ctx=accountId=>({channelId:'zalouser',...(accountId===undefined?{}:{accountId})});
 assert.deepEqual(await f.s.record({content:'gửi default',senderId:'1',messageId:'m1'},ctx()),{conversationId:'1',accountId:'default'});
 assert.deepEqual(await f.s.record({content:'gửi B',senderId:'1',messageId:'m2'},ctx('acc-b')),{conversationId:'1',accountId:'acc-b'});
 assert.deepEqual(await f.s.recordSent({content:'trả lời B',to:'1',messageId:'o1'},ctx('acc-b')),{conversationId:'1',accountId:'acc-b'});
 assert.equal(await f.s.record({content:'x',senderId:'1',messageId:'m3'},ctx('../evil')),undefined);
 const a=await f.h['zalo.messages']({conversationId:'1'});
 const b=await f.h['zalo.messages']({conversationId:'1',accountId:'acc-b'});
 assert.deepEqual(a.messages.map(m=>m.text),['gửi default']);
 assert.deepEqual(b.messages.map(m=>m.text).sort(),['gửi B','trả lời B']);
 assert.equal(normalizeInbound({content:'x',senderId:'1'},ctx('acc-b'),0).accountId,'acc-b');
 assert.equal(normalizeOutbound({content:'x',to:'1'},ctx(),0).accountId,'default');
 // schema sự kiện mới
 assert.equal(Value.Check(zaloEvents['zalo-message'],{conversationId:'1',accountId:'acc-b'}),true);
 assert.equal(Value.Check(zaloEvents['zalo-message'],{conversationId:'1'}),true);
 assert.equal(Value.Check(zaloEvents['zalo-message'],{conversationId:'1',accountId:'../x'}),false);
});

test('service: conversations/send/messageRecord/avatar theo tài khoản, không lẫn dữ liệu; CLI nhận account (default thì không)',async()=>{
 const f=twoAccounts();
 await f.s.record({content:'tin A',senderId:'10',messageId:'a'},{channelId:'zalouser'});
 await f.s.record({content:'tin B',senderId:'20',messageId:'b'},{channelId:'zalouser',accountId:'acc-b'});
 await f.h['zalo.conversations']({folder:'all'});await f.h['zalo.conversations']({folder:'all',accountId:'acc-b'});
 await new Promise(r=>setTimeout(r,20));
 const A=await f.h['zalo.conversations']({folder:'all'});
 const B=await f.h['zalo.conversations']({folder:'all',accountId:'acc-b'});
 assert.deepEqual(A.conversations.map(c=>[c.id,c.name]),[['10','Người A']]);
 assert.deepEqual(B.conversations.map(c=>[c.id,c.name]),[['20','Người B']]);
 assert.equal(A.conversations[0].preview,'tin A');assert.equal(B.conversations[0].preview,'tin B');
 assert.ok(f.listCalls.some(c=>c[1]===undefined)&&f.listCalls.some(c=>c[1]==='acc-b'));
 assert.equal(f.listCalls.filter(c=>c[1]==='acc-b').length,2); // group + direct, cache riêng
 for(const o of [A,B])assert.equal(Value.Check(zaloOperations['zalo.conversations'].output,o),true);
 assert.deepEqual(await f.h['zalo.send']({conversationId:'20',text:'chào',accountId:'acc-b'}),{ok:true});
 assert.deepEqual(await f.h['zalo.send']({conversationId:'10',text:'chào'}),{ok:true});
 assert.deepEqual(f.sendCalls,[['20','chào','acc-b'],['10','chào',undefined]]);
 assert.equal((await f.h['zalo.messages']({conversationId:'20'})).messages.length,0);
 assert.equal((await f.h['zalo.messages']({conversationId:'20',accountId:'acc-b'})).messages.length,2);
 assert.deepEqual(await f.h['zalo.message.record']({conversationId:'20',text:'từ app',accountId:'acc-b'}),{ok:true});
 assert.equal((await f.h['zalo.messages']({conversationId:'20',accountId:'acc-b'})).messages.length,3);
 assert.equal((await f.h['zalo.messages']({conversationId:'20'})).messages.length,0);
 // id tài khoản sai dạng bị từ chối, không rơi về default
 assert.deepEqual(await f.h['zalo.send']({conversationId:'10',text:'x',accountId:'../x'}),{ok:false,reason:'invalid-input'});
 assert.deepEqual(await f.h['zalo.messages']({conversationId:'10',accountId:'a b'}),{messages:[],unavailable:null});
 assert.deepEqual(await f.h['zalo.conversations']({folder:'all',accountId:'a/b'}),{conversations:[],supported:false});
 assert.deepEqual(await f.h['zalo.avatar']({conversationId:'10',accountId:'a/b'}),{avatar:null});
 assert.deepEqual(await f.h['zalo.message.record']({conversationId:'1',text:'x',accountId:'a/b'}),{ok:false});
});

test('service: zalo.account.sync chỉ reset dữ liệu của đúng tài khoản',async()=>{
 const f=twoAccounts();
 await f.s.record({content:'A',senderId:'1',messageId:'a'},{channelId:'zalouser'});
 await f.s.record({content:'B',senderId:'1',messageId:'b'},{channelId:'zalouser',accountId:'acc-b'});
 assert.deepEqual(await f.h['zalo.account.sync']({userId:'uA'}),{ok:true,reset:true});
 assert.deepEqual(await f.h['zalo.account.sync']({accountId:'acc-b',userId:'uB'}),{ok:true,reset:true});
 assert.deepEqual(f.cleared,['default','acc-b']);
 await f.s.record({content:'A2',senderId:'1',messageId:'a2'},{channelId:'zalouser'});
 await f.s.record({content:'B2',senderId:'1',messageId:'b2'},{channelId:'zalouser',accountId:'acc-b'});
 assert.deepEqual(await f.h['zalo.account.sync']({accountId:'acc-b',userId:'uB'}),{ok:true,reset:false});
 assert.deepEqual(await f.h['zalo.account.sync']({accountId:'acc-b',userId:'uB2'}),{ok:true,reset:true}); // đổi người đăng nhập của acc-b
 assert.deepEqual(f.cleared,['default','acc-b','acc-b']);
 assert.equal((await f.h['zalo.messages']({conversationId:'1',accountId:'acc-b'})).messages.length,0);
 assert.deepEqual((await f.h['zalo.messages']({conversationId:'1'})).messages.map(m=>m.text),['A2']); // default còn nguyên
 assert.deepEqual(await f.h['zalo.account.sync']({accountId:'../x',userId:'u'}),{ok:false,reset:false});
 assert.deepEqual(await f.h['zalo.account.sync']({accountId:'acc-b',userId:'bad id'}),{ok:false,reset:false});
 assert.equal(Value.Check(zaloOperations['zalo.account.sync'].input,{accountId:'acc-b',userId:'1'}),true);
});

test('cli: --account chỉ khi khác default; accounts.add/remove dùng đúng lệnh config set/unset',async()=>{
 const calls=[];
 const cli=createZaloCli({run:async(file,args,opts)=>{calls.push({file,args,opts});return {code:0,stdout:'[]',stderr:''};},bins:['openclaw']});
 await cli.list('direct');await cli.list('group','default');await cli.list('direct','acc-b');
 assert.deepEqual(calls[0].args,['directory','peers','list','--channel','zalouser','--json']);
 assert.deepEqual(calls[1].args,['directory','groups','list','--channel','zalouser','--json']);
 assert.deepEqual(calls[2].args,['directory','peers','list','--channel','zalouser','--account','acc-b','--json']);
 await cli.send('5','hi','acc-b');
 assert.deepEqual(calls[3].args,['message','send','--channel','zalouser','--account','acc-b','--target=5','--message=hi','--json']);
 await assert.rejects(cli.list('direct','a b'),{code:'failed'});
 await cli.addAccount('acc-1x');
 const add=calls.at(-1);
 assert.deepEqual(add.args,['config','set','channels.zalouser.accounts.acc-1x','{"enabled":true,"profile":"acc-1x","dmPolicy":"open","allowFrom":["*"]}','--strict-json']);
 assert.equal(add.opts.timeoutMs,120_000);
 await cli.removeAccount('acc-1x');
 assert.deepEqual(calls.at(-1).args,['config','unset','channels.zalouser.accounts.acc-1x']);
 const n=calls.length;
 for(const bad of ['../x','a.b','ACC','a b','','x'.repeat(41),'acc;rm','default'])await assert.rejects(cli.addAccount(bad),e=>e instanceof ZaloCliError,`add ${bad}`);
 for(const bad of ['../x','a.b','','default','a b'])await assert.rejects(cli.removeAccount(bad),e=>e instanceof ZaloCliError,`remove ${bad}`);
 assert.equal(calls.length,n); // không chạy lệnh nào cho id lạ
});

test('service: zalo.accounts.add tạo id an toàn, không trùng, ánh xạ lỗi; accounts.remove từ chối default/id lạ',async()=>{
 const calls=[];
 const cli=createZaloCli({run:async(f,args)=>{calls.push(args);return {code:0,stdout:'',stderr:''};},bins:['openclaw']});
 const store=createZaloStore({io:mem().io,file:'/h.json'});
 const s=createZaloService({cli,store,getConfig:()=>undefined,now:()=>1_700_000_000_000});
 const r1=await s.handlers['zalo.accounts.add']({}),r2=await s.handlers['zalo.accounts.add']({});
 assert.equal(r1.ok,true);assert.equal(r1.accountId,`acc-${(1_700_000_000_000).toString(36)}`);
 assert.notEqual(r1.accountId,r2.accountId);
 for(const r of [r1,r2]){assert.match(r.accountId,/^[a-z0-9-]{1,40}$/);assert.equal(Value.Check(zaloOperations['zalo.accounts.add'].output,r),true);}
 assert.equal(calls[0][2],`channels.zalouser.accounts.${r1.accountId}`);
 assert.equal(JSON.parse(calls[0][3]).profile,r1.accountId);
 const bad=createZaloService({cli:{addAccount:async()=>{throw new ZaloCliError('timeout');}},store,getConfig:()=>undefined});
 const f=await bad.handlers['zalo.accounts.add']({});
 assert.deepEqual(f,{ok:false,reason:'timeout'});assert.equal(Value.Check(zaloOperations['zalo.accounts.add'].output,f),true);
 const n=calls.length;
 assert.deepEqual(await s.handlers['zalo.accounts.remove']({accountId:'default'}),{ok:false,reason:'invalid-input'});
 assert.deepEqual(await s.handlers['zalo.accounts.remove']({accountId:'../x'}),{ok:false,reason:'invalid-input'});
 assert.equal(calls.length,n);
 assert.deepEqual(await s.handlers['zalo.accounts.remove']({accountId:r1.accountId}),{ok:true});
 assert.deepEqual(calls.at(-1),['config','unset',`channels.zalouser.accounts.${r1.accountId}`]);
 assert.equal(Value.Check(zaloOperations['zalo.accounts.remove'].input,{accountId:'x'}),true);
 assert.equal(Value.Check(zaloOperations['zalo.accounts.remove'].input,{accountId:'a/b'}),false);
});
