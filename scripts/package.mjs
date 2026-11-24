import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync, renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if (execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim()) {
  throw Error('Commit source changes and validation evidence before packaging.');
}
function walk(dir,prefix='') {
  return readdirSync(dir).sort().flatMap(name=>{
    const sub=path.join(dir,name);
    return statSync(sub).isDirectory()?walk(sub,prefix+name+'/'):[prefix+name];
  });
}
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const inventory=()=>Object.fromEntries(walk('dist').map(name=>[name,hash(path.join('dist',name))]));
const tested=inventory();
execFileSync(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});
const current=inventory();
if(JSON.stringify(tested)!==JSON.stringify(current)) {
  throw Error('Rebuilding this commit changed the production bytes. Validate this build before packaging it.');
}
const manifest=JSON.parse(readFileSync('dist/manifest.json','utf8'));
const prefix='Trace-'+manifest.version;
mkdirSync('release',{recursive:true});
const draft='.'+prefix+'-'+process.pid+'.zip';
try {
  execFileSync('zip',['-q','-X','../release/'+draft,'-@'],{cwd:'dist',input:Object.keys(current).join('\n')+'\n'});
  renameSync('release/'+draft,'release/'+prefix+'.zip');
} finally {rmSync('release/'+draft,{force:true});}
execFileSync('git',['archive','--format=zip','--prefix='+prefix+'-source/','-o','release/'+prefix+'-source.zip',commit]);
writeFileSync('release/SHA256SUMS',[prefix+'.zip',prefix+'-source.zip'].map(name=>hash('release/'+name)+'  '+name).join('\n')+'\n');
writeFileSync('release/build.json',JSON.stringify({commit,version:manifest.version,files:current},null,2)+'\n');
