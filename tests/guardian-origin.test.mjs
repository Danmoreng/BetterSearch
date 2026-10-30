import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync} from 'node:child_process';
import {zstdCompressSync} from 'node:zlib';
import path from 'node:path';
import {nativeBinary} from './helpers/platform.mjs';

async function fixture(){
 const root=await mkdtemp(path.resolve('.runtime/guardian-origin-'));
 const home=path.join(root,'data'),source=path.join(root,'source');await mkdir(home);await mkdir(source);await mkdir(path.join(source,'sessions'));
 const state=new DatabaseSync(path.join(source,'state_5.sqlite'));
 state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,source TEXT,thread_source TEXT)');
 const add=(id,title,origin='cli',threadSource='cli')=>state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id,title,'/synthetic',1,2,0,origin,threadSource);
 await writeFile(path.join(home,'config.json'),JSON.stringify({model:'google/embeddinggemma-2',model_file:'missing-for-origin-test.gguf',model_sha256:'68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216',dimensions:768,sources:[{id:'fixture',label:'Synthetic origins',kind:'local',codex_home:source}]}));
 const rollout=async(id,origin,compressed=false)=>{
  const content=JSON.stringify({type:'session_meta',payload:{id,cwd:'/synthetic',source:origin}})+'\n'+JSON.stringify({type:'response_item',payload:{type:'message',id:'msg-'+id,role:'user',content:[{type:'input_text',text:'Synthetic source message '+id}]}})+'\n';
  await writeFile(path.join(source,'sessions',id+'.jsonl'+(compressed?'.zst':'')),compressed?zstdCompressSync(Buffer.from(content)):content);
 };
 const run=()=>JSON.parse(execFileSync(nativeBinary,['--data',home,'--index-only'],{encoding:'utf8'}));
 const rows=()=>{const db=new DatabaseSync(path.join(home,'search.sqlite'),{readOnly:true});const result=db.prepare('SELECT thread_id,title FROM threads ORDER BY thread_id').all();db.close();return result;};
 return {root,home,source,state,add,rollout,run,rows};
}

test('Guardian origin is excluded in state and plain/compressed rollouts without title filtering',async()=>{
 const f=await fixture();
 f.add('guardian','Renamed internal audit',JSON.stringify({subagent:{other:'guardian'}}),'subagent');
 f.add('explicit','Internal review','cli','guardian_review');
 f.add('human-title','Guardian review');
 f.add('normal-agent','Regular delegated task',JSON.stringify({subagent:{other:'regular-agent'}}),'subagent');
 f.add('unknown-origin','Keep unknown origins','{malformed');
 f.state.close();
 await f.rollout('guardian','cli'); // A legacy rollout must not resurrect an excluded state row.
 await f.rollout('rollout-guardian',{subagent:{other:'guardian'}});
 await f.rollout('compressed-guardian',{subagent:{other:'guardian'}},true);
 await f.rollout('legacy-human','cli',true);
 const before=await readFile(path.join(f.source,'state_5.sqlite'));f.run();
 assert.deepEqual(f.rows().map(x=>x.thread_id),['human-title','legacy-human','normal-agent','unknown-origin']);
 assert.equal(f.rows().find(x=>x.thread_id==='human-title').title,'Guardian review');
 assert.deepEqual(await readFile(path.join(f.source,'state_5.sqlite')),before);
});

test('already indexed Guardian reviews are backed up and removed even when an unrelated rollout warns',async()=>{
 const f=await fixture();f.add('becomes-guardian','Old visible review');f.add('kept','Keep this ordinary chat');
 await f.rollout('becomes-guardian','cli');await f.rollout('kept','cli');
 f.run();
 const old=new DatabaseSync(path.join(f.home,'search.sqlite'),{readOnly:true});
 const before=old.prepare("SELECT id,digest,embedded FROM chunks WHERE thread_key='fixture:kept' ORDER BY id").all();old.close();
 f.state.prepare('UPDATE threads SET source=?,thread_source=? WHERE id=?').run(JSON.stringify({subagent:{other:'guardian'}}),'subagent','becomes-guardian');f.state.close();
 await writeFile(path.join(f.source,'sessions','unrelated-broken.jsonl.zst'),'invalid compressed rollout');
 const sourceBefore=await readFile(path.join(f.source,'state_5.sqlite'));const status=f.run();
 assert.deepEqual(f.rows().map(x=>x.thread_id),['kept']);assert.ok(status.sources.some(x=>x.warnings!=='[]'));
 const db=new DatabaseSync(path.join(f.home,'search.sqlite'),{readOnly:true});
 assert.equal(db.prepare("SELECT count(*) n FROM chunks WHERE thread_key='fixture:becomes-guardian'").get().n,0);
 assert.deepEqual(db.prepare("SELECT id,digest,embedded FROM chunks WHERE thread_key='fixture:kept' ORDER BY id").all(),before);db.close();
 const backup=(await readdir(path.join(f.home,'backups'))).find(x=>x.startsWith('search-origin-exclusions-'));assert.ok(backup);
 const saved=new DatabaseSync(path.join(f.home,'backups',backup),{readOnly:true});assert.equal(saved.prepare("SELECT count(*) n FROM threads WHERE thread_id='becomes-guardian'").get().n,1);saved.close();
 assert.deepEqual(await readFile(path.join(f.source,'state_5.sqlite')),sourceBefore);
 const backupsBefore=await readdir(path.join(f.home,'backups'));f.run();assert.deepEqual(await readdir(path.join(f.home,'backups')),backupsBefore);
});
