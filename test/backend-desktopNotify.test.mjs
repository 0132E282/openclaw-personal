import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './_load.mjs';
const {createDesktopNotify,cleanText,buildOsascriptArgs,MAX_BODY}=await loadTs('src/connectors/backend/desktopNotify.ts');
test('truyền title/body như argv riêng, không nối vào script',async()=>{
 const calls=[];const n=createDesktopNotify({platform:'darwin',run:async(f,a,o)=>{calls.push([f,a,o]);}});
 const evil='x" & do shell script "id" & "\n$(id);`id`';
 assert.deepEqual(await n('Tin mới',evil),{ok:true});
 const [file,args]=calls[0];assert.equal(file,'osascript');
 const scriptParts=args.filter((_,i)=>i%2===1&&i<6);
 assert.doesNotMatch(scriptParts.join('\n'),/do shell script|\$\(|Tin mới/);
 assert.equal(args.at(-2),'Tin mới');assert.equal(args.at(-1),'x" & do shell script "id" & " $(id);`id`');
});
test('không phải darwin / input sai / runner lỗi',async()=>{
 assert.deepEqual(await createDesktopNotify({platform:'linux',run:async()=>{throw 1;}})('a','b'),{ok:false,reason:'unsupported-platform'});
 const n=createDesktopNotify({platform:'darwin',run:async()=>{throw new Error('SECRET');}});
 assert.deepEqual(await n('','b'),{ok:false,reason:'invalid-input'});
 assert.deepEqual(await n(5,'b'),{ok:false,reason:'invalid-input'});
 const r=await n('a','b');assert.deepEqual(r,{ok:false,reason:'failed'});
});
test('cleanText: cắt độ dài, bỏ control, chặn tiền tố -',()=>{
 assert.equal(cleanText('a'.repeat(1000),MAX_BODY).length,MAX_BODY);
 assert.equal(cleanText('a\u0000b\tc',50),'a b c');
 assert.equal(cleanText('-e foo',50).startsWith('-'),false);
 assert.deepEqual(buildOsascriptArgs('t','b').slice(-2),['t','b']);
});
