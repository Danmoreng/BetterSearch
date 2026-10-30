import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {hubCache,cachedModel} from '../scripts/model-cache.mjs';
const root=await mkdtemp(path.resolve('.runtime/model-setup-test-'));
process.env.BETTER_SEARCH_HOME=root;
process.env.HF_HUB_CACHE=path.join(root,'hub');
const {ensureModel,modelName,modelRevision,modelRepository}=await import('../scripts/model.mjs');
const content=Buffer.from('synthetic model fixture');
const spec={repository:'synthetic/model',revision:'a'.repeat(40),filename:'fixture.gguf',sha256:createHash('sha256').update(content).digest('hex')};

async function mockFetch(implementation,work){
 const original=globalThis.fetch;globalThis.fetch=implementation;
 try{return await work();}finally{globalThis.fetch=original;}
}

test('Hub cache follows the standard environment variable precedence',()=>{
 assert.equal(hubCache({},'C:/user'),path.resolve('C:/user/.cache/huggingface/hub'));
 assert.equal(hubCache({XDG_CACHE_HOME:'C:/xdg'},'C:/user'),path.resolve('C:/xdg/huggingface/hub'));
 assert.equal(hubCache({HF_HOME:'C:/hf',XDG_CACHE_HOME:'C:/xdg'}),path.resolve('C:/hf/hub'));
 assert.equal(hubCache({HF_HUB_CACHE:'C:/hub',HF_HOME:'C:/hf'}),path.resolve('C:/hub'));
});

test('a corrupt download is never activated and setup releases locks for retry',async()=>{
 const home=path.join(root,'download');await mkdir(home);
 await mockFetch(async()=>new Response('not a valid model'),async()=>{
  await assert.rejects(ensureModel(home),/checksum mismatch/);
  const target=path.join(process.env.HF_HUB_CACHE,`models--${modelRepository.replace('/','--')}`,'snapshots',modelRevision,modelName);
  assert.equal(existsSync(target),false);
  assert.equal(existsSync(path.join(home,'models')),false);
  assert.equal(existsSync(path.join(home,'model-setup.lock')),false);
  assert.equal(JSON.parse(await readFile(path.join(home,'model-setup.json'),'utf8')).phase,'error');
  await assert.rejects(ensureModel(home),/checksum mismatch/);
 });
});

test('download uses the pinned revision, verifies bytes and reuses the shared snapshot offline',async()=>{
 const cache=path.join(root,'valid cache');let requests=0;
 const options={...spec,cache};
 let snapshot;
 await mockFetch(async url=>{
  requests++;assert.equal(url,`https://huggingface.co/${spec.repository}/resolve/${spec.revision}/${spec.filename}`);
  return new Response(content);
 },async()=>{snapshot=await cachedModel(options);});
 assert.equal(requests,1);assert.deepEqual(await readFile(snapshot),content);
 const blob=path.join(cache,'models--synthetic--model','blobs',spec.sha256);
 assert.deepEqual(await readFile(blob),content);
 await mockFetch(async()=>{throw Error('Unexpected download');},async()=>assert.equal(await cachedModel(options),snapshot));
 assert.deepEqual(await readdir(path.join(cache,'.locks','models--synthetic--model')),[]);
 assert.deepEqual((await readdir(path.dirname(blob))).filter(file=>file.endsWith('.incomplete')),[]);
});

test('an existing Hub blob creates the pinned snapshot without downloading',async()=>{
 const cache=path.join(root,'blob cache'),blob=path.join(cache,'models--synthetic--model','blobs',spec.sha256);
 await mkdir(path.dirname(blob),{recursive:true});await writeFile(blob,content);
 await mockFetch(async()=>{throw Error('Unexpected download');},async()=>{
  assert.deepEqual(await readFile(await cachedModel({...spec,cache})),content);
 });
});

test('simultaneous installations share one verified cache download',async()=>{
 const cache=path.join(root,'shared cache');let requests=0;
 await mockFetch(async()=>{requests++;return new Response(content);},async()=>{
  const values=await Promise.all([cachedModel({...spec,cache}),cachedModel({...spec,cache})]);
  assert.equal(values[0],values[1]);assert.equal(requests,1);
 });
});

test('a broken download is cleaned and a later attempt repairs the cache',async()=>{
 const cache=path.join(root,'repair cache');
 await mockFetch(async()=>new Response('corrupt'),async()=>assert.rejects(cachedModel({...spec,cache}),/checksum mismatch/));
 await mockFetch(async()=>new Response(content),async()=>assert.deepEqual(await readFile(await cachedModel({...spec,cache})),content));
});

test('repair replaces a corrupt cached model only after verifying its replacement',async()=>{
 const cache=path.join(root,'corrupt snapshot cache');let target;
 await mockFetch(async()=>new Response(content),async()=>{target=await cachedModel({...spec,cache});});
 await writeFile(target,'damaged cache bytes');
 await mockFetch(async()=>new Response('bad replacement'),async()=>assert.rejects(cachedModel({...spec,cache}),/checksum mismatch/));
 assert.equal(await readFile(target,'utf8'),'damaged cache bytes');
 await mockFetch(async()=>new Response(content),async()=>assert.deepEqual(await readFile(await cachedModel({...spec,cache})),content));
});
