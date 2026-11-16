import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './_load.mjs';
const {createCookieStore,sanitizeCookies}=await loadTs('src/connectors/backend/cookieStore.ts');
const mem=()=>{const files=new Map();return {files,io:{read:async p=>files.get(p),create:async(p,c)=>{if(files.has(p))throw new Error('exists');files.set(p,c);},remove:async p=>{files.delete(p);}}};};
const SECRET_A='SECRETCUSER123',SECRET_B='SECRETXS456';
const good=()=>[{name:'c_user',value:SECRET_A,domain:'.facebook.com'},{name:'xs',value:SECRET_B,domain:'.facebook.com',httpOnly:true},{name:'junk',value:'zzz'}];
test('save/status/load/clear round-trip, ghi đè được, lọc cookie lạ',async()=>{
 const m=mem();const s=createCookieStore({io:m.io,dir:'/s/',now:()=>42});
 assert.deepEqual(await s.save('default',good()),{ok:true});
 assert.deepEqual(await s.save('default',good()),{ok:true});
 assert.deepEqual(await s.status('default'),{present:true,savedAt:42});
 const loaded=await s.load('default');assert.deepEqual(loaded.map(c=>c.name).sort(),['c_user','xs']);
 assert.ok(m.files.has('/s/messenger-default.json'));
 assert.deepEqual(await s.clear('default'),{ok:true});
 assert.deepEqual(await s.status('default'),{present:false,savedAt:null});
});
test('từ chối: account sai, thiếu c_user/xs, sai dạng; lỗi không chứa giá trị',async()=>{
 const m=mem();const s=createCookieStore({io:m.io,dir:'/s'});
 assert.equal((await s.save('../x',good())).reason,'invalid-account');
 assert.equal((await s.save('a',[{name:'c_user',value:SECRET_A}])).reason,'missing-required');
 assert.equal((await s.save('a','x')).reason,'invalid-cookies');
 assert.equal((await s.save('a',[{name:'xs',value:'a b'}])).reason,'invalid-cookies');
 for(const r of [await s.save('a',[{name:'c_user',value:SECRET_A}])]) assert.doesNotMatch(JSON.stringify(r),/SECRET/);
 assert.equal(m.files.size,0);
});
test('io lỗi -> io-error không ném, không lộ giá trị; file hỏng -> present:false',async()=>{
 const bad={read:async()=>{throw new Error('boom '+SECRET_A);},create:async()=>{throw new Error('boom '+SECRET_A);},remove:async()=>{}};
 const s=createCookieStore({io:bad,dir:'/s'});
 const r=await s.save('a',good());assert.equal(r.reason,'io-error');
 assert.doesNotMatch(JSON.stringify(r),/SECRET/);
 assert.equal((await s.status('a')).present,false);
 const m=mem();m.files.set('/s/messenger-a.json','{not json');
 assert.equal((await createCookieStore({io:m.io,dir:'/s'}).status('a')).present,false);
});
test('sanitizeCookies: domain ngoài facebook bị bỏ',()=>{
 const out=sanitizeCookies([{name:'xs',value:'v',domain:'evil.com'}]);
 assert.equal(out[0].domain,undefined);
});
