import {mkdir,cp,readFile,writeFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {nodeVersion} from './runtime.mjs';
const root=process.cwd(),out=path.resolve('artifacts');
const manifest=JSON.parse(await readFile('plugin.json','utf8'));
const info=JSON.parse(await readFile('dist/build-info.json','utf8'));
if(!info.portable_cpu||info.version!==manifest.version)throw Error('Manual release requires the matching portable CPU build');
if(info.node!==nodeVersion)throw Error('Release requires the pinned Node.js LTS runtime');
if(manifest.extensions['com.openai'].interface.shortDescription.length>30)throw Error('Plugin subtitle exceeds 30 characters');
await mkdir('.runtime/package',{recursive:true});await mkdir(out,{recursive:true});
const staging=await mkdtemp(path.resolve('.runtime/package/release-'));
const plugin=path.join(staging,'better-search');await mkdir(plugin);
for(const item of ['plugin.json','mcp.json','.mcp.json','.codex-plugin','skills','package.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','PRIVACY.md','docs','CONTRIBUTING.md'])await cp(path.join(root,item),path.join(plugin,item),{recursive:true});
// Copy only runtime components; stale build outputs and editable assets stay out.
for(const item of ['dist/mcp.js','dist/launcher.js','dist/build-info.json','dist/ui/index.html','dist/native/better-search.exe','dist/runtime/node.exe','dist/runtime/NODE_LICENSE.txt',
  ...['light','dark'].flatMap(theme=>[`assets/better-search-tab-${theme}.png`,`assets/better-search-tab-mask-${theme}.png`])]){
  await mkdir(path.dirname(path.join(plugin,item)),{recursive:true});
  await cp(path.join(root,item),path.join(plugin,item));
}
const catalog={name:'better-search-local',interface:{displayName:'BetterSearch local'},plugins:[{name:'better-search',source:{source:'local',path:'./'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]};
await mkdir(path.join(plugin,'.agents/plugins'),{recursive:true});
await writeFile(path.join(plugin,'.agents/plugins/marketplace.json'),JSON.stringify(catalog,null,2)+'\n');
await mkdir(path.join(plugin,'scripts'));
for(const item of ['model.mjs','model-cache.mjs','setup-model.mjs','stop.mjs','status.mjs'])await cp(path.join(root,'scripts',item),path.join(plugin,'scripts',item));
for(const [name,target] of [['setup','scripts\\setup-model.mjs'],['start','dist\\launcher.js'],['stop','scripts\\stop.mjs'],['status','scripts\\status.mjs']])await writeFile(path.join(plugin,`${name}.cmd`),`@echo off\r\n"%~dp0dist\\runtime\\node.exe" "%~dp0${target}" %*\r\n`);
await mkdir(path.join(plugin,'licenses'));
for(const [source,name] of [['third_party/llama.cpp/LICENSE','llama.cpp.txt'],['.runtime/vendor/zstd/LICENSE','zstandard.txt'],['.runtime/vendor/zstd/COPYING','zstandard-copying.txt']])await cp(source,path.join(plugin,'licenses',name));
// Include complete license notices for every bundled npm package, including transitives.
const dependencies=JSON.parse(await readFile('package-lock.json','utf8'));
for(const location of Object.keys(dependencies.packages).filter(key=>key.startsWith('node_modules/')&&!dependencies.packages[key].dev)){
  for(const file of await readdir(location).catch(()=>[]))if(/^(licen[cs]e|notice|copying)(\.|$)/i.test(file))
    await cp(path.join(location,file),path.join(plugin,'licenses',location.replaceAll('/','_')+'_'+file));
}
for(const file of ['plugin.json','mcp.json','.mcp.json','.codex-plugin/plugin.json'])JSON.parse(await readFile(path.join(plugin,file),'utf8'));
const archive=path.join(out,`better-search-${manifest.version}-windows-x64.zip`);
execFileSync('cmake',['-E','tar','cf',archive,'--format=zip','.'],{cwd:plugin,stdio:'inherit'});
const entries=execFileSync('cmake',['-E','tar','tf',archive],{encoding:'utf8'}).trim().split(/\r?\n/);
if(entries.some(p=>/(^|\/)(?:node_modules|\.git|\.runtime)\/|\.sqlite|access-token|\.gguf|\.part$|service\.log/.test(p)))throw Error('Unexpected private data or generated surface in release');
for(const file of ['dist/native/better-search.exe','dist/runtime/node.exe','dist/ui/index.html'])if(!entries.some(p=>p.endsWith(file)))throw Error(`Missing release component: ${file}`);
const marketplace=path.join(out,'marketplace');await mkdir(path.join(marketplace,'plugins'),{recursive:true});
// Replace only this version's generated package through a fresh, dedicated directory.
const published=path.join(marketplace,'plugins',`better-search-${manifest.version}`);
if(!published.startsWith(path.resolve(out,'marketplace/plugins')+path.sep))throw Error('Invalid generated package directory');
await rm(published,{recursive:true,force:true});
await cp(plugin,published,{recursive:true});
await mkdir(path.join(marketplace,'.agents/plugins'),{recursive:true});
catalog.plugins[0].source.path=`./plugins/better-search-${manifest.version}`;
await writeFile(path.join(marketplace,'.agents/plugins/marketplace.json'),JSON.stringify(catalog,null,2)+'\n');
const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive+'.sha256',`${sha256}  ${path.basename(archive)}\n`);
await writeFile(path.join(out,'release.json'),JSON.stringify({version:manifest.version,archive,marketplace,plugin:published,sha256,files:entries.length},null,2)+'\n');
console.log(JSON.stringify({archive,marketplace,files:entries.length,sha256},null,2));
