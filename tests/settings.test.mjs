import {nativeBinary} from './helpers/platform.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:net';
import {once} from 'node:events';
import path from 'node:path';
const root = process.env.BETTER_SEARCH_TEST_ROOT || process.cwd();
const exe = nativeBinary;
const fixture = await mkdtemp(path.resolve('.runtime/settings fixture '));
const home = path.join(fixture, 'data'), source = path.join(fixture, 'source');
await mkdir(home); await mkdir(source);
const original = new DatabaseSync(path.join(source, 'state_5.sqlite'));
original.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER);');
original.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('current', 'Synthetic settings needle', 'C:\\fixture', 100, 200, 0);
original.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('archive', 'Synthetic settings needle archived', 'C:\\fixture', 100, 200, 1);
original.close();
const sourceBefore = await readFile(path.join(source, 'state_5.sqlite'));
import {testModelFile as model} from './helpers/model.mjs';
await writeFile(path.join(home, 'config.json'), JSON.stringify({version:1,model:'google/embeddinggemma-2',model_file:existsSync(model)?model:'missing.gguf',model_sha256:'68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216',dimensions:768,sources:[{id:'fixture',label:'Private source label',kind:'local',codex_home:source}]}));
await writeFile(path.join(home, 'access-token'), 'synthetic-settings-token-with-32-characters');
execFileSync(exe, ['--data', home, '--index-only'], {stdio:'pipe'});
const listener = createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening');
const port=listener.address().port; await new Promise(resolve=>listener.close(resolve));
let child;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(){
 child=spawn(exe,['--data',home,'--token-file',path.join(home,'access-token'),'--port',String(port),'--no-watch'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let stderr=''; child.stderr.on('data',part=>stderr+=part);
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw Error('Fixture service exited: '+stderr);
  if(await fetch(`http://127.0.0.1:${port}/health`).then(r=>r.ok,()=>false))return;
  await delay(50);
 }
 throw Error('Fixture service did not start');
}
async function api(method,params={}){
 const response=await fetch(`http://127.0.0.1:${port}/api`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-settings-token-with-32-characters'},body:JSON.stringify({method,params})});
 const body=await response.json();if(!response.ok)throw Error(body.code);return body.result;
}
async function waitIdle(){for(let i=0;i<200;i++){const s=await api('search_status');if(!s.indexing&&!s.embedding)return;await delay(30);}throw Error('Index did not finish');}
async function stop(){const exited=once(child,'exit');await api('shutdown');await exited;}

test('GUI settings persist, control retrieval and preserve originals through index maintenance', async t=>{
 await start();t.after(async()=>{if(child.exitCode===null)await stop();});
 const initial=await api('read_settings');assert.equal(initial.preferences.density,'comfortable');assert.equal(initial.sources[0].enabled,true);assert.equal(initial.status.threads,2);
 await assert.rejects(api('update_settings',{profile:'unbounded'}),/INVALID_SETTING/);
 await assert.rejects(api('update_settings',{disabled_sources:[]}),/INVALID_SETTING/);
 await assert.rejects(api('settings_action',{action:'rename_source',id:'fixture',label:' '}),/INVALID_LABEL/);
 const edited=await api('update_settings',{include_archived:false,density:'compact',automatic_updates:false,profile:'efficient',language:'en',agent_access:false,paused:true});
 assert.equal(edited.preferences.agent_access,false);assert.equal(edited.preferences.paused,true);
 await assert.rejects(api('search_chats',{query:'needle',mode:'keyword',presentation:'palette-v1'}),/AGENT_ACCESS_DISABLED/);
 assert.equal((await api('search_panel',{query:'needle',mode:'keyword',include_archived:false})).results.length,1);
 assert.equal((await api('search_panel',{query:'needle',mode:'keyword',include_archived:true})).results.length,2);
 await api('settings_action',{action:'source_enabled',id:'fixture',enabled:false});
 assert.deepEqual((await api('search_filters')).projects,[]);
 assert.deepEqual((await api('search_filters')).sources,[]);
 assert.deepEqual((await api('search_panel',{query:'needle',mode:'keyword',_disabled_sources:[]})).results,[]);
 await api('settings_action',{action:'source_enabled',id:'fixture',enabled:true});
 assert.equal((await api('search_panel',{query:'needle',mode:'keyword'})).results.length,2);
 await api('settings_action',{action:'rename_source',id:'fixture',label:'Fixture renamed'});
 assert.equal((await api('read_settings')).sources[0].label,'Fixture renamed');
 const diagnostics=await api('settings_action',{action:'diagnostics'});
 const serialized=JSON.stringify(diagnostics);
 for(const value of [source,home,'Fixture renamed','needle','synthetic-settings-token'])assert.ok(!serialized.includes(value));
 assert.equal(diagnostics.threads,2);assert.equal(diagnostics.profile,'efficient');
 await stop();await start();
 const restored=await api('read_settings');assert.equal(restored.preferences.density,'compact');assert.equal(restored.preferences.automatic_updates,false);assert.equal(restored.preferences.paused,true);assert.equal(restored.sources[0].label,'Fixture renamed');
 await assert.rejects(api('settings_action',{action:'clear'}),/CONFIRMATION_REQUIRED/);
 assert.equal((await api('search_status')).threads,2);
 await api('settings_action',{action:'clear',confirmed:true});
 assert.equal((await api('search_status')).threads,0);
 const policy=new DatabaseSync(path.join(home,'search.sqlite'),{readOnly:true});
 assert.equal(policy.prepare("SELECT value FROM settings WHERE key='initial_embedding_complete'").get().value,'0');policy.close();assert.equal((await api('read_settings')).preferences.paused,true);
 assert.ok((await readdir(path.join(home,'backups'))).some(file=>file.startsWith('search-clear-')));
 await api('settings_action',{action:'rebuild',confirmed:true});await waitIdle();
 assert.equal((await api('search_status')).threads,2);
 assert.ok((await readdir(path.join(home,'backups'))).some(file=>file.startsWith('search-rebuild-')));
 // Explicit Resume also works when automatic updates are off.
 await api('update_settings',{paused:true});await api('update_settings',{paused:false});await waitIdle();
 assert.equal((await api('read_settings')).preferences.paused,false);
 assert.deepEqual(await readFile(path.join(source,'state_5.sqlite')),sourceBefore);
});

test('model verification runs in the independent service and reuses compatible weights', {skip:!existsSync(model)}, async t=>{
 await start();t.after(async()=>{if(child.exitCode===null)await stop();});
 await api('update_settings',{paused:true});
 const result=await api('settings_action',{action:'install_model'});assert.equal(result.started,true);
 let settings;
 for(let i=0;i<200;i++){settings=await api('read_settings');if(!settings.model.busy)break;await delay(50);}
 assert.equal(settings.model.busy,false);assert.equal(settings.model.phase,'ready');assert.equal(settings.status.model_ready,true);
 const state=JSON.parse(await readFile(path.join(home,'model-setup.json'),'utf8'));assert.equal(state.model_file,model);
 assert.deepEqual(await readFile(path.join(source,'state_5.sqlite')),sourceBefore);
});
