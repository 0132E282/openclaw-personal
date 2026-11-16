import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './_load.mjs';
const {runMessengerLogin,createLoginController}=await loadTs('src/connectors/backend/messengerLogin.ts');
const fb=(name,value='V')=>({name,value,domain:'.facebook.com',path:'/'});
function fakePw({batches,launchFails=false}){
 const st={closed:false,gotos:[],polls:0};
 const ctx={newPage:async()=>({goto:async(u)=>{st.gotos.push(u);}}),cookies:async()=>batches[Math.min(st.polls++,batches.length-1)]};
 return {st,mod:{chromium:{launch:async o=>{if(launchFails)throw new Error('x');st.opts=o;return {newContext:async()=>ctx,close:async()=>{st.closed=true;}};}}}};
}
const fast={sleep:async()=>{},pollMs:1};
test('thiếu Playwright -> playwright-missing (import ném hoặc sai dạng)',async()=>{
 assert.deepEqual(await runMessengerLogin({importPlaywright:async()=>{throw new Error('Cannot find package');}}),{ok:false,reason:'playwright-missing'});
 assert.deepEqual(await runMessengerLogin({importPlaywright:async()=>({})}),{ok:false,reason:'playwright-missing'});
});
test('chờ c_user+xs rồi trả cookie, mở facebook.com, đóng browser',async()=>{
 const {st,mod}=fakePw({batches:[[],[fb('datr')],[fb('c_user'),fb('xs'),fb('datr')]]});
 const r=await runMessengerLogin({importPlaywright:async()=>mod,...fast});
 assert.equal(r.ok,true);assert.equal(r.cookies.length,3);
 assert.deepEqual(st.gotos,['https://www.facebook.com/']);assert.equal(st.opts.headless,false);assert.equal(st.closed,true);
});
test('hỗ trợ default export; bỏ qua cookie domain khác',async()=>{
 const {mod}=fakePw({batches:[[{name:'c_user',value:'v',domain:'evil.com'},{name:'xs',value:'v',domain:'evil.com'}],[fb('c_user'),fb('xs')]]});
 const r=await runMessengerLogin({importPlaywright:async()=>({default:mod}),...fast});
 assert.equal(r.ok,true);
});
test('timeout, launch-failed, cancelled',async()=>{
 const {st,mod}=fakePw({batches:[[]]});let t=0;
 assert.deepEqual(await runMessengerLogin({importPlaywright:async()=>mod,now:()=>t+=100,timeoutMs:300,...fast}),{ok:false,reason:'timeout'});assert.equal(st.closed,true);
 assert.deepEqual(await runMessengerLogin({importPlaywright:async()=>fakePw({batches:[[]],launchFails:true}).mod}),{ok:false,reason:'launch-failed'});
 const ac=new AbortController();ac.abort();
 assert.deepEqual(await runMessengerLogin({importPlaywright:async()=>fakePw({batches:[[]]}).mod,...fast},ac.signal),{ok:false,reason:'cancelled'});
});
test('controller: cookie không nằm trong status; cancel; start khi đang chạy không tạo phiên mới',async()=>{
 const {mod}=fakePw({batches:[[fb('c_user','SECRETVAL'),fb('xs','SECRETVAL')]]});
 let got;const c=createLoginController({importPlaywright:async()=>mod,...fast,onCookies:async ck=>{got=ck;return true;}});
 assert.deepEqual(c.status(),{phase:'idle',reason:null});
 c.start();
 await new Promise(r=>setTimeout(r,20));
 assert.deepEqual(c.status(),{phase:'succeeded',reason:null});assert.equal(got.length,2);
 assert.doesNotMatch(JSON.stringify(c.status()),/SECRET/);
 const never=createLoginController({importPlaywright:async()=>fakePw({batches:[[]]}).mod,sleep:()=>new Promise(r=>setTimeout(r,5)),onCookies:async()=>true});
 never.start();assert.equal(never.start().phase,'running');
 assert.equal(never.cancel().phase,'cancelled');
 const miss=createLoginController({importPlaywright:async()=>{throw new Error('x');},onCookies:async()=>true});
 miss.start();await new Promise(r=>setTimeout(r,10));assert.deepEqual(miss.status(),{phase:'failed',reason:'playwright-missing'});
 const failStore=createLoginController({importPlaywright:async()=>mod,...fast,onCookies:async()=>false});
 failStore.start();await new Promise(r=>setTimeout(r,20));assert.equal(failStore.status().phase,'failed');
});
