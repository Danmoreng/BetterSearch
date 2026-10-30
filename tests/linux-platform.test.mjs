import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,symlink,access} from 'node:fs/promises';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {nativeBinary} from './helpers/platform.mjs';

const linux={skip:process.platform!=='linux'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){
 const scratch=await mkdtemp(path.resolve('.runtime/linux platform '));
 // Spaces, quotes and shell metacharacters must be literal path characters.
 const root=path.join(scratch,"plugin ' $literal"),home=path.join(root,"data ' $literal");
 for(const dir of ['dist/native','dist/runtime','scripts','locales'])await mkdir(path.join(root,dir),{recursive:true});
 await mkdir(home);
 const executable=path.join(root,'dist/native/better-search');await copyFile(nativeBinary,executable);
 await symlink(process.execPath,path.join(root,'dist/runtime/node'));
 await copyFile('locales/en.json',path.join(root,'locales/en.json'));
 const token='synthetic-platform-token-000000000000';await writeFile(path.join(home,'access-token'),token);
 await writeFile(path.join(home,'config.json'),JSON.stringify({model:'google/embeddinggemma-2',model_file:'missing.gguf',model_sha256:'68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216',dimensions:768,sources:[]}));
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(executable,['--data',home,'--token-file',path.join(home,'access-token'),'--port',String(port),'--no-watch'],{stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',s=>errors+=s);
 const closed=new Promise(resolve=>child.once('close',resolve));
 const api=async(method,params={})=>{
  const res=await fetch(`http://127.0.0.1:${port}/api`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({method,params}),signal:AbortSignal.timeout(5000)});
  return res.json();
 };
 t.after(async()=>{if(child.exitCode===null){await api('shutdown').catch(()=>{});const timer=setTimeout(()=>child.kill('SIGKILL'),4000);await closed;clearTimeout(timer);}});
 let ready=false;for(let i=0;i<100;i++){if(await fetch(`http://127.0.0.1:${port}/health`).then(r=>r.ok,()=>false)){ready=true;break;}if(child.exitCode!==null)break;await wait(30);}assert.ok(ready,errors);
 return {root,home,child,closed,api};
}

test('native Linux and JS use the same XDG data directory',linux,async()=>{
 const base=await mkdtemp(path.resolve('.runtime/xdg-test-'));
 const env={...process.env,XDG_DATA_HOME:base};delete env.BETTER_SEARCH_HOME;
 execFileSync(nativeBinary,['--status'],{env});
 await access(path.join(base,'BetterSearch/search.sqlite'));
});

test('Linux file selection preserves paths, cancellation, source validation and diagnostic privacy',linux,async t=>{
 const f=await fixture(t);
 const source=path.join(f.root,"source ' $literal");await mkdir(source);
 const db=new DatabaseSync(path.join(source,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER)');db.close();
 const helper=path.join(f.root,'dist/native/better-search-dialog');
 const selected=path.join(f.root,'selected-path');
 // Replace only this fixture's dialog process to exercise the service boundary headlessly.
 await writeFile(helper,`#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nconst spec=JSON.parse(readFileSync(${JSON.stringify(selected)},'utf8'));\nif(spec.cancel)process.exit(1);\nprocess.stdout.write(spec.path);\n`,{mode:0o755});
 await writeFile(selected,JSON.stringify({cancel:true}));
 assert.equal((await f.api('settings_action',{action:'add_source'})).result.cancelled,true);
 await writeFile(selected,JSON.stringify({path:source}));
 const added=await f.api('settings_action',{action:'add_source'});assert.equal(added.result.sources[0].codex_home,source);
 // Wait for the empty source's background scan before testing a duplicate.
 for(let i=0;i<100;i++){if(!(await f.api('search_status')).result.indexing)break;await wait(20);}
 assert.equal((await f.api('settings_action',{action:'add_source'})).code,'SOURCE_EXISTS');
 const exported=path.join(f.root,"diagnostics ' $.json");await writeFile(selected,JSON.stringify({path:exported}));
 assert.equal((await f.api('settings_action',{action:'export_diagnostics'})).result.saved,true);
 const report=await readFile(exported,'utf8');assert.ok(!report.includes(source));assert.ok(!report.includes('access-token'));
 await writeFile(selected,JSON.stringify({path:path.join(f.root,'not-a-profile')}));
 assert.equal((await f.api('settings_action',{action:'add_source'})).code,'INVALID_SOURCE');
});

test('Linux model helper receives exact argv, activates success and is reaped on shutdown',linux,async t=>{
 const f=await fixture(t),script=path.join(f.root,'scripts/setup-model.mjs');
 await writeFile(script,`import {writeFileSync} from 'node:fs';\nimport path from 'node:path';\nconst home=process.argv[process.argv.indexOf('--home')+1];\nwriteFileSync(path.join(home,'model-setup.json'),JSON.stringify({phase:'ready',model_file:path.join(home,'synthetic.gguf')}));`);
 assert.equal((await f.api('settings_action',{action:'install_model'})).result.started,true);
 for(let i=0;i<100;i++){if(!(await f.api('read_settings')).result.model.busy)break;await wait(30);}
 const config=JSON.parse(await readFile(path.join(f.home,'config.json'),'utf8'));assert.equal(config.model_file,path.join(f.home,'synthetic.gguf'));
 await writeFile(script,'process.exit(17);');
 assert.equal((await f.api('settings_action',{action:'install_model'})).result.started,true);
 let failed;
 for(let i=0;i<100;i++){failed=(await f.api('read_settings')).result;if(!failed.model.busy)break;await wait(30);}
 assert.equal(failed.model.code,'MODEL_SETUP_FAILED');
 assert.equal(JSON.parse(await readFile(path.join(f.home,'config.json'),'utf8')).model_file,config.model_file);
 const pidFile=path.join(f.home,'helper-pid');
 await writeFile(script,`import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)},String(process.pid));\nsetInterval(()=>{},1000);`);
 await f.api('settings_action',{action:'install_model'});
 let pid;for(let i=0;i<100;i++){try{pid=Number(await readFile(pidFile,'utf8'));break;}catch{await wait(30);}}assert.ok(pid>0);
 await f.api('shutdown');await f.closed;
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
