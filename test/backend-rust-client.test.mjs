import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {loadTs} from './_load.mjs';
const {createCoreProcess,resolveCoreBinary,CoreError}=await loadTs('src/connectors/backend/rust/client.ts');
const {createRustHandlers}=await loadTs('src/connectors/backend/rust/handlers.ts');
const TOKEN='t'.repeat(40);
function fakeEnv({lines=['{"ready":true,"port":4321}\n'],health=true,rpc}={}){
 const spawned=[];const calls=[];
 const spawn=(file,args,options)=>{
  const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),killed:[],kill(sig){this.killed.push(sig);}});
  spawned.push({file,args,options,child});
  queueMicrotask(()=>{for(const l of lines)child.stdout.emit('data',Buffer.from(l));});
  return child;
 };
 const fetch=async(url,init)=>{
  calls.push({url,init});
  if(url.endsWith('/health'))return {json:async()=>({ok:health})};
  return {json:async()=>rpc?rpc(JSON.parse(init.body)):{ok:true,result:{echo:JSON.parse(init.body)}}};
 };
 return {spawn,fetch,spawned,calls};
}
const mk=(env,extra={})=>createCoreProcess({binaryPath:'/bin/core',stateDir:'/st',spawn:env.spawn,fetch:env.fetch,randomToken:()=>TOKEN,env:{PATH:'/x'},...extra});

test('khởi động lười, token chỉ qua env, không có trong argv',async()=>{
 const env=fakeEnv();const c=mk(env);
 assert.equal(env.spawned.length,0);
 await c.call('setup.check',{});
 assert.equal(env.spawned.length,1);
 const s=env.spawned[0];
 assert.deepEqual(s.args,[]);
 assert.equal(s.options.env.OPCORE_TOKEN,TOKEN);assert.equal(s.options.env.OPCORE_STATE_DIR,'/st');assert.equal(s.options.env.OPCORE_EXIT_ON_STDIN_CLOSE,'1');assert.deepEqual(s.options.stdio,['pipe','pipe','ignore']);
 assert.ok(!JSON.stringify([s.file,s.args]).includes(TOKEN));
 assert.equal(env.calls.at(-1).init.headers['x-opcore-token'],TOKEN);
 assert.equal(env.calls.at(-1).url,'http://127.0.0.1:4321/rpc');
 await c.call('x',{});assert.equal(env.spawned.length,1);
});
test('ready bị chia nhiều chunk vẫn parse đúng',async()=>{
 const env=fakeEnv({lines:['{"ready":tr','ue,"port":99}\n']});
 await mk(env).call('a',{});assert.match(env.calls[0].url,/:99\/health/);
});
test('hết giờ chờ ready -> core-start-timeout và kill SIGTERM',async()=>{
 const env=fakeEnv({lines:[]});
 await assert.rejects(mk(env,{startTimeoutMs:20}).call('a',{}),e=>e.code==='core-start-timeout');
 assert.deepEqual(env.spawned[0].child.killed,['SIGTERM']);
});
test('dòng ready sai -> core-start-failed; health sai -> core-unhealthy',async()=>{
 await assert.rejects(mk(fakeEnv({lines:['{"ready":true,"port":"x"}\n']})).call('a',{}),e=>e.code==='core-start-failed');
 await assert.rejects(mk(fakeEnv({health:false})).call('a',{}),e=>e.code==='core-unhealthy');
});
test('tiến trình chết: khởi động lại đúng một lần',async()=>{
 const env=fakeEnv();const c=mk(env);
 await c.call('a',{});
 env.spawned[0].child.emit('exit',1);
 await c.call('a',{});
 assert.equal(env.spawned.length,2);
 env.spawned[1].child.emit('exit',1);
 await assert.rejects(c.call('a',{}),e=>e.code==='core-died');
 assert.equal(env.spawned.length,2);
});
test('ánh xạ lỗi {ok:false} và không rò token',async()=>{
 const env=fakeEnv({rpc:()=>({ok:false,error:{code:'reauth-required',message:'bad '+TOKEN}})});
 await assert.rejects(mk(env).call('a',{}),e=>{
  assert.ok(e instanceof CoreError);assert.equal(e.code,'reauth-required');
  assert.ok(!e.message.includes(TOKEN)&&!String(e.stack).includes(TOKEN));return true;});
});
test('lỗi mạng/timeout không chứa token',async()=>{
 const env=fakeEnv();
 const fetch=async(url,init)=>{if(url.endsWith('/health'))return env.fetch(url,init);return new Promise((_,rej)=>init.signal.addEventListener('abort',()=>rej(new Error('abort '+TOKEN))));};
 await assert.rejects(mk({...env,fetch},{callTimeoutMs:20}).call('a',{}),e=>e.code==='core-timeout'&&!e.message.includes(TOKEN));
});
test('resolveCoreBinary: env > release > debug > undefined',()=>{
 const all=()=>true;
 assert.equal(resolveCoreBinary({env:{OPENCLAW_PERSONAL_CORE_BIN:'/e'},pluginRoot:'/r',exists:all}),'/e');
 assert.equal(resolveCoreBinary({env:{},pluginRoot:'/r',exists:all}),'/r/core/target/release/openclaw-personal-core');
 assert.equal(resolveCoreBinary({env:{},pluginRoot:'/r',exists:p=>p.includes('/debug/')}),'/r/core/target/debug/openclaw-personal-core');
 assert.equal(resolveCoreBinary({env:{},pluginRoot:'/r',exists:()=>false}),undefined);
});
test('thiếu binary -> core-missing, không spawn',async()=>{
 const env=fakeEnv();
 await assert.rejects(createCoreProcess({binaryPath:undefined,stateDir:'/s',spawn:env.spawn,fetch:env.fetch}).call('a',{}),e=>e.code==='core-missing');
 assert.equal(env.spawned.length,0);
});
test('stop() gửi SIGTERM cho tiến trình con',async()=>{
 const env=fakeEnv();const c=mk(env);await c.call('a',{});c.stop();
 assert.deepEqual(env.spawned[0].child.killed,['SIGTERM']);
});
test('handlers: chuyển nguyên input, đủ 21 op',async()=>{
 const env=fakeEnv();const h=createRustHandlers({core:mk(env)});
 assert.equal(Object.keys(h).length,22);
 const input={account:'a1',cookies:[{name:'xs',value:'v'}]};
 const r=await h['messenger.cookies.set'](input);
 const rpc=env.calls.find(c=>c.url.endsWith('/rpc'));
 assert.deepEqual(JSON.parse(rpc.init.body),{op:'messenger.cookies.set',input});
 assert.deepEqual(r.echo.input,input);
});
test('handlers: core-missing dùng fallback TS cho gmail, giá trị an toàn cho messenger/notify, lỗi khác thì ném',async()=>{
 const env=fakeEnv();
 const missing=createCoreProcess({binaryPath:undefined,stateDir:'/s',spawn:env.spawn,fetch:env.fetch});
 const seen=[];
 const h=createRustHandlers({core:missing,fallback:{'gmail.accounts.list':async(i)=>{seen.push(i);return {accounts:[]};}}});
 assert.deepEqual(await h['gmail.accounts.list']({}),{accounts:[]});assert.deepEqual(seen,[{}]);
 await assert.rejects(h['gmail.auth.status']({}),e=>e.code==='core-missing');
 assert.deepEqual(await h['notify.send']({title:'a',body:'b'}),{ok:false,reason:'failed'});
 assert.equal((await h['messenger.login.start']({})).phase,'failed');
 assert.equal((await h['setup.check']({})).browser,'missing');
 assert.deepEqual(await h['messenger.status']({}),{state:'no-cookies',reason:null});
 assert.equal((await h['messenger.conversations']({})).ok,false);
 assert.equal((await h['messenger.messages']({conversationId:'1'})).ok,false);
 assert.deepEqual(await h['messenger.send']({conversationId:'1',text:'x'}),{ok:false,reason:'launch-failed'});
 const err=createRustHandlers({core:mk(fakeEnv({rpc:()=>({ok:false,error:{code:'network',message:'m'}})})),fallback:{'gmail.accounts.list':async()=>({accounts:[]})}});
 await assert.rejects(err['gmail.accounts.list']({}),e=>e.code==='network');
});
