import {mkdir,copyFile} from 'node:fs/promises';
await mkdir(new URL('dist/control-ui/',import.meta.url),{recursive:true});
for(const [src,dest] of [['src/index.js','dist/index.js'],['src/control-ui.js','dist/control-ui/index.js'],['src/control-ui.css','dist/control-ui/index.css']])await copyFile(new URL(src,import.meta.url),new URL(dest,import.meta.url));
console.log('Built dependency-free precompiled native UI.');
