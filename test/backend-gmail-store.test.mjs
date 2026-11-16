import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './_load.mjs';
const {createTokenStore,gmailAccountId}=await loadTs('src/connectors/backend/gmail/tokenStore.ts');
const mem=()=>{const files=new Map();return {files,io:{read:async p=>files.get(p),create:async(p,c)=>{if(files.has(p))throw new Error('exists');files.set(p,c);},remove:async p=>{files.delete(p);}}};};
const R='REFRESHSECRET',A='ACCESSSECRET',CS='CLIENTSECRET';
const rec=(address='me@gmail.com')=>({address,clientId:'cid',clientSecret:CS,refreshToken:R,accessToken:A,expiresAt:5});
test('save/load/list/updateAccess/markReauth/remove; list không chứa token',async()=>{
 const m=mem();const s=createTokenStore({io:m.io,dir:'/s/',now:()=>7});
 const r=await s.save(rec());assert.equal(r.ok,true);assert.match(r.id,/^g-[0-9a-f]{12}$/);
 assert.equal(r.id,await gmailAccountId(' ME@gmail.com '));
 assert.ok(m.files.has(`/s/gmail-${r.id}.json`));
 assert.equal((await s.save(rec())).ok,true);
 assert.equal((await s.load(r.id)).refreshToken,R);
 assert.deepEqual(await s.list(),[{id:r.id,address:'me@gmail.com',savedAt:7,needsReauth:false}]);
 await s.updateAccess(r.id,{accessToken:'NEW',expiresAt:99});
 const l=await s.load(r.id);assert.equal(l.accessToken,'NEW');assert.equal(l.refreshToken,R);
 await s.markReauth(r.id);assert.equal((await s.list())[0].needsReauth,true);
 await s.save(rec());assert.equal((await s.list())[0].needsReauth,false);
 for(const out of [await s.list(),await s.save(rec('b@x.com'))])assert.doesNotMatch(JSON.stringify(out),/SECRET/);
 assert.equal((await s.list()).length,2);
 assert.deepEqual(await s.remove(r.id),{ok:true});
 assert.equal(await s.load(r.id),undefined);assert.equal((await s.list()).length,1);
});
test('id sai bị từ chối; IO lỗi -> io-error không lộ bí mật',async()=>{
 const m=mem();const s=createTokenStore({io:m.io,dir:'/s'});
 assert.equal((await s.remove('../x')).reason,'invalid-account');assert.equal(await s.load('../x'),undefined);
 assert.equal((await s.save({address:'',clientId:'c',refreshToken:'r'})).reason,'invalid-record');
 const bad={read:async()=>{throw new Error(R);},create:async()=>{throw new Error(R);},remove:async()=>{}};
 const r=await createTokenStore({io:bad,dir:'/s'}).save(rec());assert.deepEqual(r,{ok:false,reason:'io-error'});
 assert.deepEqual(await createTokenStore({io:bad,dir:'/s'}).list(),[]);
});
test('ghi song song không làm mất tài khoản trong chỉ mục',async()=>{
 const m=mem();const s=createTokenStore({io:m.io,dir:'/s'});
 await Promise.all(['a@x.com','b@x.com','c@x.com'].map(a=>s.save(rec(a))));
 assert.equal((await s.list()).length,3);
});
