import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {dataDirectory,platformConfig,mcpTransport,buildProfile} from '../scripts/platform.mjs';
import {runtimeSpecs} from '../scripts/runtime.mjs';

test('Windows keeps its portable CPU preset, executable names and original transport',async()=>{
 const target=platformConfig('win32','x64');
 assert.equal(target.preset,'windows-cpu');assert.equal(target.nativeBuild,'build/cpu/Release/better-search.exe');
 assert.equal(target.nodeName,'node.exe');assert.equal(target.target,'windows-x64');
 const original=JSON.parse(await readFile('.mcp.json','utf8')).mcpServers['better-search'];
 assert.deepEqual(mcpTransport('win32','x64'),original);
 assert.equal(runtimeSpecs['windows-x64'].sha256,'14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5');
});
test('Linux selects its own portable build and package-local executable transport',()=>{
 const target=platformConfig('linux','x64');
 assert.equal(target.preset,'linux-cpu');assert.equal(target.nativeBuild,'build/linux-cpu/better-search');
 assert.equal(target.nodeName,'node');assert.equal(target.target,'linux-x64');
 assert.deepEqual(mcpTransport('linux','x64'),{command:'./dist/runtime/node',args:['./dist/mcp.js'],cwd:'./'});
 assert.throws(()=>platformConfig('linux','arm64'),/Unsupported target/);
 assert.throws(()=>platformConfig('darwin','x64'),/Unsupported target/);
});
test('data paths preserve existing defaults and respect per-platform overrides',()=>{
 assert.equal(dataDirectory({BETTER_SEARCH_HOME:'/explicit'},'linux','/user'),'/explicit');
 assert.equal(dataDirectory({HOME:'/user'},'linux','/user'),path.join('/user','.local/share/BetterSearch'));
 assert.equal(dataDirectory({HOME:'/user',XDG_DATA_HOME:'/data',LOCALAPPDATA:'/ignored'},'linux','/user'),path.join('/data','BetterSearch'));
 assert.equal(dataDirectory({LOCALAPPDATA:'/windows-data',XDG_DATA_HOME:'/ignored'},'win32','/user'),path.join('/windows-data','BetterSearch'));
});
test('both release presets disable machine-specific CPU and GPU requirements',async()=>{
 const presets=JSON.parse(await readFile('CMakePresets.json','utf8'));
 for(const name of ['windows-cpu','linux-cpu']){
  const preset=presets.configurePresets.find(p=>p.name===name);
  assert.equal(preset.cacheVariables.BETTER_SEARCH_BUILD_PROFILE,name);
  for(const flag of ['GGML_NATIVE','GGML_CUDA','GGML_AVX','GGML_AVX2','GGML_AVX512','GGML_FMA','GGML_F16C','GGML_BMI2','GGML_SSE42','GGML_OPENMP'])assert.equal(preset.cacheVariables[flag],'OFF',`${name}: ${flag}`);
 }
});

test('packaging rejects GPU, foreign-platform and unverified runtime inputs',async()=>{
 const {mkdtemp,mkdir,writeFile}=await import('node:fs/promises');
 const {execFileSync}=await import('node:child_process');
 const scratch=await mkdtemp(path.resolve('.runtime/package-guard-'));
 await mkdir(path.join(scratch,'dist/runtime'),{recursive:true});
 const manifest=JSON.parse(await readFile('plugin.json','utf8'));
 await writeFile(path.join(scratch,'plugin.json'),JSON.stringify(manifest));
 const target=platformConfig();
 const script=path.resolve('scripts/package.mjs');
 const info={version:manifest.version,node:'v26.13.0',profile:target.preset,target:target.target,portable_cpu:true};
 for(const invalid of [{...info,profile:'windows-rtx5080'},{...info,portable_cpu:false},{...info,target:'foreign-x64'}]){
  await writeFile(path.join(scratch,'dist/build-info.json'),JSON.stringify(invalid));
  assert.throws(()=>execFileSync(process.execPath,[script],{cwd:scratch,stdio:'pipe'}),e=>e.stderr.toString().includes('matching portable CPU build'));
 }
 await writeFile(path.join(scratch,'dist/build-info.json'),JSON.stringify(info));
 await writeFile(path.join(scratch,'dist/runtime',target.nodeName),'unverified runtime');
 assert.throws(()=>execFileSync(process.execPath,[script],{cwd:scratch,stdio:'pipe'}),e=>e.stderr.toString().includes('pinned Node.js LTS runtime'));
});

test('CUDA builds are explicit development profiles on both platforms',()=>{
 assert.deepEqual(buildProfile('windows-cuda','win32','x64'),{preset:'windows-cuda',binary:'build/cuda/Release/better-search.exe',accelerator:'cuda'});
 assert.deepEqual(buildProfile('linux-cuda','linux','x64'),{preset:'linux-cuda',binary:'build/linux-cuda/better-search',accelerator:'cuda'});
 assert.equal(buildProfile('windows-rtx5080','win32','x64').binary,'build/rtx5080/Release/better-search.exe');
 assert.throws(()=>buildProfile('windows-cuda','linux','x64'),/Unsupported build preset/);
 assert.throws(()=>buildProfile('linux-cuda','win32','x64'),/Unsupported build preset/);
});
