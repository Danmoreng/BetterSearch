import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import path from 'node:path';
import {nativeBinary} from './helpers/platform.mjs';
import {testModelFile} from './helpers/model.mjs';

test('first build and explicit rebuild may use GPU; subsequent updates and queries use CPU',
 {skip:!existsSync(testModelFile),timeout:180000},async t=>{
 const root=await mkdtemp(path.resolve('.runtime/embedding-policy-'));
 const home=path.join(root,'data'),source=path.join(root,'source');await mkdir(home);await mkdir(source);
 const state=new DatabaseSync(path.join(source,'state_5.sqlite'));
 state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER)');
 state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('policy','Synthetic authentication policy','/synthetic',1,2,0);state.close();
 const history=new DatabaseSync(path.join(source,'thread_history_1.sqlite'));
 history.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_type TEXT,item_json TEXT)');
 const add=ordinal=>history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run('policy','turn','item-'+ordinal,ordinal,1,'userMessage',JSON.stringify({type:'userMessage',content:[{type:'text',text:`Synthetic authentication policy passage ${ordinal}.`}]}));add(0);
 const token='synthetic-embedding-policy-token-00000';await writeFile(path.join(home,'access-token'),token);
 await writeFile(path.join(home,'config.json'),JSON.stringify({model:'google/embeddinggemma-2',model_file:testModelFile,model_sha256:'68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216',dimensions:768,sources:[{id:'policy',label:'Synthetic policy',kind:'local',codex_home:source}]}));
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(nativeBinary,['--data',home,'--token-file',path.join(home,'access-token'),'--port',String(port),'--no-watch'],{stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',x=>stderr+=x);const closed=new Promise(r=>child.once('close',r));
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const api=async(method,params={})=>{
  const res=await fetch(`http://127.0.0.1:${port}/api`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({method,params}),signal:AbortSignal.timeout(180000)});
  const body=await res.json();assert.ok(res.ok,JSON.stringify(body));return body.result;
 };
 t.after(async()=>{history.close();if(child.exitCode===null){await api('shutdown').catch(()=>{});const timer=setTimeout(()=>child.kill(),3000);await closed;clearTimeout(timer);}});
 let ready=false;for(let i=0;i<100;i++){if(await fetch(`http://127.0.0.1:${port}/health`).then(r=>r.ok,()=>false)){ready=true;break;}await wait(30);}assert.ok(ready,stderr);
 const idle=async()=>{for(let i=0;i<3000;i++){const s=await api('search_status');if(!s.indexing&&!s.embedding){assert.equal(s.progress.error,null,JSON.stringify(s.progress));return s;}await wait(30);}assert.fail('Embedding policy job timed out');};
 const complete=async()=>{await idle();assert.equal((await api('manage_index',{action:'resume'})).started,true);return idle();};
 await api('manage_index',{action:'refresh'});const first=await complete();
 assert.equal(first.embedded,first.chunks);assert.ok(first.embedded>0);
 const accelerated=process.env.BETTER_SEARCH_TEST_REQUIRE_GPU==='1';
 assert.equal(first.performance.backend,accelerated?'gpu':'cpu');
 const inspect=new DatabaseSync(path.join(home,'search.sqlite'),{readOnly:true});
 const completeFlag=()=>inspect.prepare("SELECT value FROM settings WHERE key='initial_embedding_complete'").get().value;
 assert.equal(completeFlag(),'1');
 await api('search_panel',{query:'authentication',mode:'semantic'});
 assert.equal((await api('search_status')).performance.query_backend,'cpu');
 add(1);await api('manage_index',{action:'refresh'});const incremental=await complete();
 assert.equal(incremental.performance.backend,'cpu');assert.equal(incremental.embedded,incremental.chunks);
 await api('settings_action',{action:'rebuild',confirmed:true});await idle();assert.equal(completeFlag(),'0');
 const rebuilt=await complete();assert.equal(rebuilt.performance.backend,accelerated?'gpu':'cpu');assert.equal(completeFlag(),'1');inspect.close();
});
