import {build} from 'esbuild';
import {mkdir,copyFile,cp,rm} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});
await mkdir('dist/assets',{recursive:true});
await copyFile('index.html','dist/index.html');
await cp('assets','dist/assets',{recursive:true,force:true});
await build({entryPoints:['src/plus-client.js'],bundle:true,minify:true,format:'esm',platform:'browser',
 target:['es2022'],outfile:'dist/assets/plus-client.js'});
