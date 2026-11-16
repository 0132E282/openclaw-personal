import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {loadTs} from './_load.mjs';
const O=await loadTs('src/connectors/backend/gmail/oauth.ts');
const SECRET='TOPSECRETTOKEN';
const seq=()=>{let n=0;return k=>Uint8Array.from({length:k},(_,i)=>(n+i*7+1)&255);};
const recServer=()=>{const calls=[];let srv;return {calls,get srv(){return srv;},createServer:h=>{srv=http.createServer(h);return {listen:(p,host,cb)=>{calls.push([p,host]);srv.listen(p,host,cb);},once:(e,f)=>srv.once(e,f),address:()=>srv.address(),close:cb=>srv.close(cb)};}};};
const get=async u=>{const r=await fetch(u,{headers:{connection:'close'}});await r.text();return r.status;};
const jres=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('PKCE S256 đúng và URL đủ tham số/scope',async()=>{
 const {verifier,challenge}=await O.createPkce(seq());
 assert.match(verifier,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(challenge,createHash('sha256').update(verifier).digest('base64url'));
 const u=new URL(O.buildAuthUrl({clientId:'cid-123456',redirectUri:'http://127.0.0.1:5555/callback',state:'st',challenge}));
 const q=u.searchParams;
 assert.equal(u.origin+u.pathname,'https://accounts.google.com/o/oauth2/v2/auth');
 assert.equal(q.get('code_challenge_method'),'S256');assert.equal(q.get('code_challenge'),challenge);
 assert.equal(q.get('access_type'),'offline');assert.equal(q.get('prompt'),'consent');assert.equal(q.get('state'),'st');
 assert.equal(q.get('response_type'),'code');assert.equal(q.get('client_id'),'cid-123456');
 assert.deepEqual(q.get('scope').split(' ').map(s=>s.split('/').pop()),['gmail.readonly','gmail.modify','gmail.send']);
 assert.equal(q.get('code_verifier'),null);
});

test('loopback chỉ bind 127.0.0.1, nhận code khi state đúng, đóng server',async()=>{
 const s=recServer();
 const lb=await O.startLoopback({createServer:s.createServer,expectedState:'good'});
 assert.deepEqual(s.calls,[[0,'127.0.0.1']]);
 assert.equal(s.srv.address().address,'127.0.0.1');
 assert.match(lb.redirectUri,/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
 assert.equal(await get(lb.redirectUri.replace('/callback','/other')),404);
 assert.equal(await get(lb.redirectUri+'?state=good&code=abc'),200);
 assert.equal(await lb.code,'abc');
 await new Promise(r=>setTimeout(r,50));assert.equal(s.srv.listening,false);
});

test('state sai bị từ chối (state-mismatch), thiếu state cũng vậy',async()=>{
 for(const qs of ['?state=evil&code=abc','?code=abc']){
  const s=recServer();const lb=await O.startLoopback({createServer:s.createServer,expectedState:'good'});
  assert.equal(await get(lb.redirectUri+qs),400);
  await assert.rejects(lb.code,e=>e.code==='state-mismatch');
 }
 const s=recServer();const lb=await O.startLoopback({createServer:s.createServer,expectedState:'good'});
 await get(lb.redirectUri+'?state=good&error=access_denied');
 await assert.rejects(lb.code,e=>e.code==='access-denied');
});

test('loopback hết giờ và hủy được; server đóng',async()=>{
 const s=recServer();const lb=await O.startLoopback({createServer:s.createServer,expectedState:'x',timeoutMs:20});
 await assert.rejects(lb.code,e=>e.code==='timeout');
 await new Promise(r=>setTimeout(r,30));assert.equal(s.srv.listening,false);
 const s2=recServer();const lb2=await O.startLoopback({createServer:s2.createServer,expectedState:'x'});
 lb2.cancel();await assert.rejects(lb2.code,e=>e.code==='cancelled');
 // timer tiêm được
 let fire;const s3=recServer();const lb3=await O.startLoopback({createServer:s3.createServer,expectedState:'x',setTimer:f=>{fire=f;return 1;},clearTimer:()=>{}});
 fire();await assert.rejects(lb3.code,e=>e.code==='timeout');
});

test('bind lỗi -> bind-failed',async()=>{
 const createServer=()=>({listen:()=>{},once:(e,f)=>f(new Error('EADDRINUSE')),address:()=>null,close:()=>{}});
 await assert.rejects(O.startLoopback({createServer,expectedState:'x'}),e=>e.code==='bind-failed');
});

test('exchange/refresh: tham số đúng, clientSecret tùy chọn, giữ refresh token cũ',async()=>{
 const seen=[];
 const fetch=async(url,init)=>{seen.push([url,new URLSearchParams(init.body)]);return jres(200,{access_token:'A1',refresh_token:'R1',expires_in:3600,scope:'s'});};
 const t=await O.exchangeCode({fetch,now:()=>1000,clientId:'cid',code:'c',verifier:'v',redirectUri:'http://127.0.0.1:1/callback'});
 assert.equal(seen[0][0],'https://oauth2.googleapis.com/token');
 assert.equal(seen[0][1].get('grant_type'),'authorization_code');assert.equal(seen[0][1].get('code_verifier'),'v');assert.equal(seen[0][1].has('client_secret'),false);
 assert.deepEqual(t,{accessToken:'A1',refreshToken:'R1',expiresAt:3601000,scope:'s'});
 await O.exchangeCode({fetch,now:()=>0,clientId:'cid',clientSecret:'sec',code:'c',verifier:'v',redirectUri:'r'});
 assert.equal(seen[1][1].get('client_secret'),'sec');
 const f2=async()=>jres(200,{access_token:'A2',expires_in:10});
 const r=await O.refreshAccessToken({fetch:f2,now:()=>0,clientId:'cid',refreshToken:'OLD'});
 assert.equal(r.refreshToken,'OLD');assert.equal(r.accessToken,'A2');
});

test('invalid_grant -> reauth-required; lỗi khác không lộ body/token',async()=>{
 const f=async()=>jres(400,{error:'invalid_grant',error_description:SECRET});
 await assert.rejects(O.refreshAccessToken({fetch:f,now:()=>0,clientId:'c',refreshToken:SECRET}),e=>{assert.equal(e.code,'reauth-required');assert.doesNotMatch(JSON.stringify(e)+e.message+e.stack,new RegExp(SECRET));return true;});
 const f2=async()=>jres(400,{error:'invalid_client',error_description:SECRET});
 await assert.rejects(O.refreshAccessToken({fetch:f2,now:()=>0,clientId:'c',refreshToken:SECRET}),e=>e.code==='exchange-failed'&&!e.message.includes(SECRET));
 const f3=async()=>{throw new Error('net '+SECRET);};
 await assert.rejects(O.refreshAccessToken({fetch:f3,now:()=>0,clientId:'c',refreshToken:'r'}),e=>e.code==='network'&&!e.message.includes(SECRET));
 const f4=async()=>jres(200,{access_token:'A',expires_in:5});
 await assert.rejects(O.exchangeCode({fetch:f4,now:()=>0,clientId:'c',code:'c',verifier:'v',redirectUri:'r'}),e=>e.code==='no-refresh-token');
});

test('controller: luồng thành công, status/cancel không chứa token',async()=>{
 const s=recServer();let opened;let saved;
 const c=O.createAuthController({random:seq(),now:()=>0,createServer:s.createServer,
  fetch:async()=>jres(200,{access_token:SECRET,refresh_token:SECRET+'R',expires_in:60}),
  openBrowser:async u=>{opened=u;},
  onTokens:async(t,ctx)=>{saved={t,ctx};return {accountId:'g-aaaaaaaaaaaa',address:'a@b.c'};}});
 assert.deepEqual(c.start({clientId:'client-id-1'}),{state:'waiting'});
 assert.equal(c.status().state,'waiting');
 for(let i=0;i<50&&!opened;i++)await new Promise(r=>setTimeout(r,5));
 const q=new URL(opened).searchParams;
 assert.equal(await get(`${q.get('redirect_uri')}?state=${q.get('state')}&code=thecode`),200);
 await c.whenSettled();
 assert.deepEqual(c.status(),{state:'succeeded',reason:null,accountId:'g-aaaaaaaaaaaa',address:'a@b.c'});
 assert.equal(saved.t.accessToken,SECRET);
 assert.doesNotMatch(JSON.stringify(c.status()),new RegExp(SECRET));
});

test('controller: hủy, trình duyệt lỗi, state sai',async()=>{
 const s=recServer();
 const mk=(openBrowser)=>O.createAuthController({random:seq(),now:()=>0,createServer:s.createServer,fetch:async()=>jres(500,{}),openBrowser,onTokens:async()=>({accountId:'x',address:'y'})});
 const c=mk(async()=>{});c.start({clientId:'client-id-1'});
 assert.equal(c.cancel().state,'cancelled');await c.whenSettled();assert.equal(c.status().state,'cancelled');
 const c2=mk(async()=>{throw new Error('no browser');});c2.start({clientId:'client-id-1'});await c2.whenSettled();
 assert.deepEqual([c2.status().state,c2.status().reason],['failed','browser-failed']);
 let opened;const c3=mk(async u=>{opened=u;});c3.start({clientId:'client-id-1'});
 for(let i=0;i<50&&!opened;i++)await new Promise(r=>setTimeout(r,5));
 await get(`${new URL(opened).searchParams.get('redirect_uri')}?state=wrong&code=x`);await c3.whenSettled();
 assert.equal(c3.status().reason,'state-mismatch');
 assert.equal(mk(async()=>{}).start({clientId:'x'}).state,'failed');
});
