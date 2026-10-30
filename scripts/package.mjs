import {mkdir,cp,readFile,writeFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {nodeVersion,runtimeSpecs} from './runtime.mjs';
import {platformConfig,mcpTransport,buildProfile} from './platform.mjs';
import {fileHash} from './model-cache.mjs';
const target=platformConfig();
const local=process.argv.includes('--local');
const root=process.cwd(),out=path.resolve('artifacts');
const manifest=JSON.parse(await readFile('plugin.json','utf8'));
const info=JSON.parse(await readFile('dist/build-info.json','utf8'));
if(info.target!==target.target||info.version!==manifest.version||(!local&&(!info.portable_cpu||info.profile!==target.preset)))throw Error('Manual release requires the matching portable CPU build');
buildProfile(info.profile);
if(info.node!==nodeVersion||await fileHash(path.join('dist/runtime',target.nodeName))!==runtimeSpecs[target.target].sha256)throw Error('Release requires the pinned Node.js LTS runtime');
if(manifest.extensions['com.openai'].interface.shortDescription.length>30)throw Error('Plugin subtitle exceeds 30 characters');
await mkdir('.runtime/package',{recursive:true});await mkdir(out,{recursive:true});
const staging=await mkdtemp(path.resolve('.runtime/package/release-'));
const plugin=path.join(staging,'better-search');await mkdir(plugin);
for(const item of ['plugin.json','mcp.json','.mcp.json','.codex-plugin','skills','package.json','README.md','LICENSE','THIRD_PARTY_NOTICES.md','PRIVACY.md','docs','CONTRIBUTING.md'])await cp(path.join(root,item),path.join(plugin,item),{recursive:true});
// Copy only runtime components; stale build outputs and editable assets stay out.
for(const item of ['dist/mcp.js','dist/launcher.js','dist/build-info.json','dist/ui/index.html',`dist/native/${target.nativeName}`,`dist/runtime/${target.nodeName}`,'dist/runtime/NODE_LICENSE.txt',
  ...(!target.windows?['dist/native/better-search-dialog']:[]),'locales/en.json',
  ...['light','dark'].flatMap(theme=>[`assets/better-search-tab-${theme}.png`,`assets/better-search-tab-mask-${theme}.png`])]){
  await mkdir(path.dirname(path.join(plugin,item)),{recursive:true});
  await cp(path.join(root,item),path.join(plugin,item));
}
const catalog={name:'better-search-local',interface:{displayName:'BetterSearch local'},plugins:[{name:'better-search',source:{source:'local',path:'./'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]};
await mkdir(path.join(plugin,'.agents/plugins'),{recursive:true});
await writeFile(path.join(plugin,'.agents/plugins/marketplace.json'),JSON.stringify(catalog,null,2)+'\n');
await mkdir(path.join(plugin,'scripts'));
for(const item of ['model.mjs','model-cache.mjs','platform.mjs','setup-model.mjs','stop.mjs','status.mjs'])await cp(path.join(root,'scripts',item),path.join(plugin,'scripts',item));
const transport=mcpTransport();
await writeFile(path.join(plugin,'.mcp.json'),JSON.stringify({mcpServers:{'better-search':transport}},null,2)+'\n');
await writeFile(path.join(plugin,'mcp.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{'better-search':{type:'stdio',...transport}}},null,2)+'\n');
for(const [name,script] of [['setup','scripts/setup-model.mjs'],['start','dist/launcher.js'],['stop','scripts/stop.mjs'],['status','scripts/status.mjs']]){
  if(target.windows)await writeFile(path.join(plugin,`${name}.cmd`),`@echo off\r\n"%~dp0dist\\runtime\\node.exe" "%~dp0${script.replaceAll('/','\\')}" %*\r\n`);
  else await writeFile(path.join(plugin,`${name}.sh`),`#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$root/dist/runtime/node" "$root/${script}" "$@"\n`,{mode:0o755});
}
await mkdir(path.join(plugin,'licenses'));
for(const [source,name] of [['third_party/llama.cpp/LICENSE','llama.cpp.txt'],['.runtime/vendor/zstd/LICENSE','zstandard.txt'],['.runtime/vendor/zstd/COPYING','zstandard-copying.txt']])await cp(source,path.join(plugin,'licenses',name));
// Include complete license notices for every bundled npm package, including transitives.
const dependencies=JSON.parse(await readFile('package-lock.json','utf8'));
for(const location of Object.keys(dependencies.packages).filter(key=>key.startsWith('node_modules/')&&!dependencies.packages[key].dev)){
  for(const file of await readdir(location).catch(()=>[]))if(/^(licen[cs]e|notice|copying)(\.|$)/i.test(file))
    await cp(path.join(location,file),path.join(plugin,'licenses',location.replaceAll('/','_')+'_'+file));
}
for(const file of ['plugin.json','mcp.json','.mcp.json','.codex-plugin/plugin.json'])JSON.parse(await readFile(path.join(plugin,file),'utf8'));
if(local){
  // Development-only installation. CUDA libraries remain provided by the local toolkit.
  const marketplace=path.join(out,'local',info.profile);
  const pluginName=`better-search-${manifest.version}-${info.profile}`;
  const published=path.join(marketplace,'plugins',pluginName);
  await mkdir(path.dirname(published),{recursive:true});
  await rm(published,{recursive:true,force:true});
  await cp(plugin,published,{recursive:true});
  catalog.plugins[0].source.path=`./plugins/${pluginName}`;
  await mkdir(path.join(marketplace,'.agents/plugins'),{recursive:true});
  await writeFile(path.join(marketplace,'.agents/plugins/marketplace.json'),JSON.stringify(catalog,null,2)+'\n');
  console.log(JSON.stringify({developmentOnly:true,profile:info.profile,marketplace,plugin:published},null,2));
}else{
const archive=path.join(out,`better-search-${manifest.version}-${target.target}.${target.windows?'zip':'tar.gz'}`);
execFileSync('cmake',['-E','tar',target.windows?'cf':'czf',archive,...(target.windows?['--format=zip']:[]),'.'],{cwd:plugin,stdio:'inherit'});
const entries=execFileSync('cmake',['-E','tar','tf',archive],{encoding:'utf8'}).trim().split(/\r?\n/);
if(entries.some(p=>/(^|\/)(?:node_modules|\.git|\.runtime)\/|\.sqlite|access-token|\.gguf|\.part$|service\.log/.test(p)))throw Error('Unexpected private data or generated surface in release');
for(const file of [`dist/native/${target.nativeName}`,`dist/runtime/${target.nodeName}`,'dist/ui/index.html'])if(!entries.some(p=>p.endsWith(file)))throw Error(`Missing release component: ${file}`);
const marketplace=path.join(out,'marketplace',target.target);await mkdir(path.join(marketplace,'plugins'),{recursive:true});
// Replace only this version's generated package through a fresh, dedicated directory.
const published=path.join(marketplace,'plugins',`better-search-${manifest.version}-${target.target}`);
if(!published.startsWith(path.resolve(marketplace,'plugins')+path.sep))throw Error('Invalid generated package directory');
await rm(published,{recursive:true,force:true});
await cp(plugin,published,{recursive:true});
await mkdir(path.join(marketplace,'.agents/plugins'),{recursive:true});
catalog.plugins[0].source.path=`./plugins/better-search-${manifest.version}-${target.target}`;
await writeFile(path.join(marketplace,'.agents/plugins/marketplace.json'),JSON.stringify(catalog,null,2)+'\n');
const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive+'.sha256',`${sha256}  ${path.basename(archive)}\n`);
await writeFile(path.join(out,`release-${target.target}.json`),JSON.stringify({version:manifest.version,target:target.target,archive,marketplace,plugin:published,sha256,files:entries.length},null,2)+'\n');
console.log(JSON.stringify({archive,marketplace,files:entries.length,sha256},null,2));
}
