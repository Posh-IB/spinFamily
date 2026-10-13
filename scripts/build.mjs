import {cp,mkdir,rm} from 'node:fs/promises';
import {build} from 'esbuild';
await rm('dist',{recursive:true,force:true});await mkdir('dist');
await cp('index.html','dist/index.html');await cp('assets','dist/assets',{recursive:true});
await build({entryPoints:['client/household.mjs'],bundle:true,format:'esm',platform:'browser',outfile:'dist/household.js',minify:true});
