import {constants} from 'node:fs';
// Exercise the actual extracted runtime with synthetic data and an isolated profile.
import {readFile,mkdtemp,mkdir,writeFile,readdir,access} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync,spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileHash} from './model-cache.mjs';
import {nodeVersion,runtimeSpecs} from './runtime.mjs';
import {platformConfig} from './platform.mjs';
const target=platformConfig();
const release=JSON.parse(await readFile(`artifacts/release-${target.target}.json`,'utf8'));
assert.equal(release.target,target.target,'Verify the release on its target platform');
assert.equal(await fileHash(release.archive),release.sha256,'Release archive checksum must match');
const scratch=await mkdtemp(path.resolve('.runtime/release-check-'));
const unpack=path.join(scratch,'extracted package');await mkdir(unpack,{recursive:true});
execFileSync('cmake',['-E','tar','xf',release.archive],{cwd:unpack});
const home=path.join(scratch,'data'),source=path.join(scratch,'source');await mkdir(home);await mkdir(source);
const state=new DatabaseSync(path.join(source,'state_1.sqlite'));
state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,project_id TEXT); CREATE TABLE projects(id TEXT,name TEXT);');
state.prepare('INSERT INTO projects VALUES(?,?)').run('release','Release fixture');
for(const [id,title] of [['a','OAuth authentication'],['b','SQLite migrations'],['c','Local embeddings']])state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id,title,'C:/synthetic',1,2,0,'release');state.close();
const history=new DatabaseSync(path.join(source,'thread_history_1.sqlite'));
history.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_type TEXT,item_json TEXT,updated_at_ordinal INTEGER)');
for(const [id,text] of [['a','Use OAuth PKCE for secure authentication.'],['b','Back up SQLite before a migration.'],['c','Create local embeddings in the background.']])history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)').run(id,'turn','item-'+id,0,1,'userMessage',JSON.stringify({type:'userMessage',content:[{type:'text',text}]}),1);history.close();
await writeFile(path.join(home,'config.json'),JSON.stringify({model:'google/embeddinggemma-2',model_file:'missing-for-keyword-test.gguf',model_sha256:'68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216',dimensions:768,sources:[{id:'release',label:'Synthetic release fixture',kind:'local',codex_home:source}]}));
const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const env={...process.env,BETTER_SEARCH_HOME:home,BETTER_SEARCH_PORT:String(port),BETTER_SEARCH_NO_WATCH:'1',PATH:target.windows?process.env.SystemRoot+'\\System32':'/usr/bin:/bin'};
// Exercise Codex's own package/path resolver, rather than substituting paths in the test.
const ciHost=process.env.CI==='true'&&process.env.BETTER_SEARCH_CI_HOST==='1';
let desktopCodex;
if(!ciHost&&process.platform==='win32'){
 const hosts=execFileSync('powershell.exe',['-NoProfile','-Command',
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'codex.exe' -and $_.CommandLine -match '\\bapp-server\\b' } | Select-Object -ExpandProperty ExecutablePath -Unique"],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean);
 if(hosts.length===1)desktopCodex=hosts[0];
}
if(!ciHost&&!target.windows){
 for(const candidate of ['/usr/lib/chatgpt/resources/codex','/opt/ChatGPT/resources/codex']){
  try{await access(candidate,constants.X_OK);desktopCodex=candidate;break;}catch(error){if(error.code!=='ENOENT')throw error;}
 }
}
const codex=process.env.BETTER_SEARCH_CODEX_CLI||desktopCodex||process.env.CODEX_CLI_PATH;
if(!codex)throw Error('Set BETTER_SEARCH_CODEX_CLI to the desktop-bundled Codex executable for host-resolution verification.');
const normalizeExecutable=value=>target.windows?path.resolve(value).toLowerCase():path.resolve(value);
if(desktopCodex)assert.equal(normalizeExecutable(codex),normalizeExecutable(desktopCodex),
 'Release verification must use the CLI bundled with the running desktop app, not a separate CLI');
const codexVersion=execFileSync(codex,['--version'],{encoding:'utf8'}).trim();
console.log(`Verifying ${ciHost?'pinned CI protocol host':'desktop host'}: ${codexVersion}`);
const hostProfile=path.join(scratch,'host profile');
await mkdir(hostProfile);
const catalog=JSON.parse(await readFile(path.join(unpack,'.agents/plugins/marketplace.json'),'utf8'));
assert.equal(catalog.name,'better-search-local');
assert.equal(catalog.plugins[0].source.path,'./');
const hostEnv={...process.env,CODEX_HOME:hostProfile};
const cli=(...args)=>JSON.parse(execFileSync(codex,args,{env:hostEnv,encoding:'utf8'}));
cli('plugin','marketplace','add',unpack,'--json');
cli('plugin','add','better-search@better-search-local','--json');
const installed=cli('mcp','list','--json').find(server=>server.name==='better-search');
assert.ok(installed?.enabled,'Codex must load the installed MCP server');
const resolved=installed.transport;
assert.equal(resolved.type,'stdio');
assert.ok(!JSON.stringify(resolved).includes('${'),'Codex must resolve all transport paths');
assert.ok(resolved.cwd.startsWith(hostProfile),'Adapter must run inside the isolated installed package');
// Verify the same catalog API used by the desktop, including plugin ownership and UI metadata.
const host=spawn(codex,['-c','features.prefer_mxc=true','app-server'],{
 env:{...hostEnv,...env,CODEX_HOME:hostProfile},stdio:['pipe','pipe','ignore'],windowsHide:true,
});
const hostLines=createInterface({input:host.stdout}),pending=new Map();let rpcId=0;
hostLines.on('line',line=>{
 let message;try{message=JSON.parse(line);}catch{return;}
 const callback=pending.get(message.id);if(!callback)return;pending.delete(message.id);
 message.error?callback.reject(Error(JSON.stringify(message.error))):callback.resolve(message.result);
});
const request=(method,params)=>new Promise((resolve,reject)=>{
 const id=++rpcId;pending.set(id,{resolve,reject});host.stdin.write(JSON.stringify({id,method,params})+'\n');
});
const hostTimeout=setTimeout(()=>{for(const callback of pending.values())callback.reject(Error('Desktop catalog verification timed out'));host.kill();},30000);
try{
 await request('initialize',{clientInfo:{name:'better_search_release_check',version:'1.0.0'},capabilities:{experimentalApi:true}});
 host.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const catalog=await request('mcpServerStatus/list',{serverName:'better-search',detail:'full'});
 const entry=catalog.data.find(server=>server.name==='better-search');
 assert.ok(entry,'Desktop catalog must discover BetterSearch');assert.equal(entry.toolsError??null,null);
 assert.equal(entry.pluginId,'better-search@better-search-local');
 assert.deepEqual(entry.serverInfo.icons.map(icon=>icon.mimeType),['image/png','image/png']);
 assert.deepEqual(entry.tools.open_search._meta['openai/ui'].entrypoints,[{type:'thread'}]);
 assert.equal(entry.resources.length,1);
}finally{
 clearTimeout(hostTimeout);hostLines.close();
 const closed=new Promise(resolve=>host.once('close',resolve));host.stdin.end();
 const killTimeout=setTimeout(()=>host.kill(),3000);await closed;clearTimeout(killTimeout);
}
const runtime=path.join(unpack,'dist/runtime',target.nodeName);
assert.equal(await fileHash(runtime),runtimeSpecs[target.target].sha256);
if(!target.windows){
 for(const name of [target.nativeName,'better-search-dialog'])await access(path.join(unpack,'dist/native',name),constants.X_OK);
 for(const name of ['setup','start','stop','status'])await access(path.join(unpack,`${name}.sh`),constants.X_OK);
}
assert.equal(execFileSync(runtime,['--version'],{env,encoding:'utf8'}).trim(),nodeVersion);
execFileSync(runtime,['--test',path.resolve('tests/lifecycle.test.mjs')],{
 env:{...process.env,BETTER_SEARCH_TEST_ROOT:resolved.cwd},encoding:'utf8',timeout:35000,
});
console.log('Extracted adapter lifecycle verified: active-request disconnects, rapid restarts and startup-lock cleanup.');
execFileSync(runtime,['--test',path.resolve('tests/settings.test.mjs')],{
 env:{...process.env,BETTER_SEARCH_TEST_ROOT:resolved.cwd},encoding:'utf8',timeout:35000,
});
console.log('Extracted settings verified: persistence, source exclusion, agent isolation, model reuse and backed-up maintenance.');
execFileSync(runtime,['--test',path.resolve('tests/embedding-policy.test.mjs')],{
 env:{...process.env,BETTER_SEARCH_TEST_ROOT:resolved.cwd},encoding:'utf8',timeout:180000,
});
console.log('Extracted embedding policy checked (real-model coverage requires local verified weights).');
const client=new Client({name:'release-verification',version:'1.0.0'});
const tool=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return result.structuredContent;};
try{
 await client.connect(new StdioClientTransport({command:resolved.command,args:resolved.args,cwd:resolved.cwd,env:{...env,...resolved.env},stderr:'pipe'}));
 for(const theme of ['dark','light']){
  const icon=client.getServerVersion().icons.find(icon=>icon.theme===theme);
  assert.equal(icon.mimeType,'image/png');assert.deepEqual(icon.sizes,['256x256']);
  assert.deepEqual(Buffer.from(icon.src.split(',')[1],'base64'),await readFile(path.join(unpack,`assets/better-search-tab-mask-${theme}.png`)));
 }
 const panel=(await client.listTools()).tools.find(tool=>tool.name==='open_search');
 assert.deepEqual(panel._meta['openai/ui'].entrypoints,[{type:'thread'}]);
 assert.ok((await client.readResource({uri:panel._meta.ui.resourceUri})).contents[0].text.includes('Search your chats'));
 assert.equal((await client.listResources()).resources.length,1);
 assert.deepEqual((await tool('search_chats',{query:''})).results,[]);
 const settings=await tool('read_settings');assert.equal(settings.preferences.density,'comfortable');
 await tool('update_settings',{density:'compact',agent_access:false});
 const blocked=await client.callTool({name:'search_chats',arguments:{query:'OAuth'}});
 assert.equal(blocked.isError,true);assert.equal(blocked._meta.code,'AGENT_ACCESS_DISABLED');
 assert.deepEqual((await tool('search_panel',{query:''})).results,[]);
 await tool('update_settings',{agent_access:true});
 await tool('manage_index',{action:'refresh'});
 let status;for(let i=0;i<100;i++){status=await tool('search_status');if(!status.indexing)break;await new Promise(resolve=>setTimeout(resolve,50));}
 assert.equal(status.threads,3);assert.equal(status.model_ready,false);
 const result=await tool('search_chats',{query:'OAuth',mode:'keyword'});
 assert.equal(result.results[0].thread_id,'a');assert.equal(result.results[0].matches[0].item_id,'item-a');
 const filtered=await tool('search_panel',{query:'OAuth "secure authentication"',mode:'keyword',updated_after:'1970-01-01',updated_before:'1970-01-01'});
 assert.equal(filtered.results.length,1,'Extracted package must enforce phrase/date filters through MCP');
 assert.deepEqual((await tool('search_panel',{query:'"OAuth" "SQLite"',mode:'keyword'})).results,[]);
 assert.deepEqual((await tool('search_panel',{query:'OAuth',mode:'keyword',updated_after:'2026-01-01'})).results,[]);
 const before=JSON.parse(execFileSync(path.join(unpack,'dist/native',target.nativeName),['--index-check','--database',path.join(home,'search.sqlite')],{env,encoding:'utf8'}));
 execFileSync(runtime,[path.join(unpack,'scripts/stop.mjs')],{env,encoding:'utf8'});
 for(let i=0;i<100;i++){try{await fetch(`http://127.0.0.1:${port}/health`);await new Promise(resolve=>setTimeout(resolve,50));}catch{break;}}
 assert.equal((await tool('search_status')).threads,3);
 assert.equal((await tool('read_settings')).preferences.density,'compact');
 const after=JSON.parse(execFileSync(path.join(unpack,'dist/native',target.nativeName),['--index-check','--database',path.join(home,'search.sqlite')],{env,encoding:'utf8'}));assert.deepEqual(after,before);
 const db=new DatabaseSync(path.join(home,'search.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);db.close();
 await writeFile(path.join(scratch,'verification.json'),JSON.stringify({version:release.version,codex,codexVersion,syntheticChats:3,isolatedRuntime:true,hostResolvedTransport:true,desktopCatalogVerified:true,conversationPanelRegistered:true,restartPreservedIndex:true},null,2));
 console.log('Extracted release verified: bundled runtime, service startup, empty query, source import, headless evidence and restart without index changes.');
}finally{
 await client.close();
 try{execFileSync(runtime,[path.join(unpack,'scripts/stop.mjs')],{env,stdio:'ignore'});}catch{}
}
