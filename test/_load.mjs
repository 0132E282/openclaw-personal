import {build} from 'esbuild';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
/** Biên dịch một file TS trong src/ thành ESM tạm rồi import (Node không tự chạy TS có JSX). */
export async function loadTs(entry){
 const out=await build({entryPoints:[new URL('../'+entry,import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',target:'es2022',logLevel:'silent',external:['openclaw/*']});
 const file=join(await mkdtemp(join(tmpdir(),'op-')),'m.mjs');
 await writeFile(file,out.outputFiles[0].text);
 return import(pathToFileURL(file).href);
}
