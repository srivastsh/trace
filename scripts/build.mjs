import {build} from 'vite';
import {mkdir,readFile,writeFile,cp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const outDir = path.resolve('dist');
const watch = process.argv.includes('--watch') ? {} : null;
await rm(outDir,{recursive:true,force:true});
await mkdir(outDir,{recursive:true});
const common = {configFile:false,root,base:'./',publicDir:false,mode:'production',
  define:{'process.env.NODE_ENV':JSON.stringify('production')}};
for (const [name,entry] of Object.entries({observer:'src/observe/main.ts',content:'src/runtime/content.ts',background:'src/runtime/background.ts'})) {
  await build({...common,build:{outDir,emptyOutDir:false,watch,target:'chrome120',minify:true,
    lib:{entry,name:'Trace'+name,formats:[name==='background'?'es':'iife'],fileName:()=>name+'.js'},
    rolldownOptions:{output:{codeSplitting:false}}}});
}
await build({...common,worker:{format:'es'},build:{outDir,emptyOutDir:false,watch,target:'chrome120',rolldownOptions:{input:{library:'library.html',popup:'popup.html'}}}});
await cp('public',outDir,{recursive:true});
await cp('src/host/host.css',path.join(outDir,'host.css'));
const licenseDir=path.join(outDir,'licenses');
await mkdir(licenseDir,{recursive:true});
for(const name of ['idb','minisearch','preact']) {
  const {readdir}=await import('node:fs/promises');
  const folder=path.resolve('node_modules',name);
  const asset=(await readdir(folder)).find(f=>/^licen[cs]e(\.|$)/i.test(f));
  if(!asset) throw Error('Missing distribution license for '+name);
  await cp(path.join(folder,asset),path.join(licenseDir,name+'.txt'));
}
await cp('NOTICE',path.join(outDir,'NOTICE.txt'));
await cp('LICENSE',path.join(outDir,'LICENSE.txt'));
const manifest = JSON.parse(await readFile('manifest.json','utf8'));
const pkg = JSON.parse(await readFile('package.json','utf8'));
if(manifest.version!==pkg.version) throw Error('Manifest version mismatch');
await writeFile(path.join(outDir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
