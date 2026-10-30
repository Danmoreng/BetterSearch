// Development-only MCP Apps host with synthetic results. Never packaged as a product surface.
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const host=await build({stdin:{resolveDir:process.cwd(),contents:`
import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const frame=document.querySelector('iframe');
const bridge=new AppBridge(null,{name:'BetterSearch QA host',version:'1.0.0'},{openLinks:{},serverTools:{}},{hostContext:{theme:'light',locale:'en-US',displayMode:'inline'}});
window.qa={calls:[],opened:[]};
const settings={preferences:{include_archived:true,density:'comfortable',automatic_updates:true,profile:'balanced',paused:false,agent_access:true,language:'auto'},sources:[{id:'fixture',label:'Local Codex',kind:'local',codex_home:'C:\\\\Users\\\\Demo\\\\.codex',enabled:true,last_sync:'2026-10-29T12:15:00Z',warning:false}],status:{version:'0.6.1',threads:128,chunks:2480,embedded:2480,indexing:false,embedding:false,model_ready:true,database_bytes:17825792,progress:{phase:'idle',done:0,total:0,error:null}},model:{phase:'ready',busy:false,installed_bytes:558000000}};
bridge.oncalltool=async params=>{
 window.qa.calls.push(params);
 const args=params.arguments||{};let result={};
 if(document.getElementById('fail-save').checked&&['update_settings','settings_action'].includes(params.name))return {isError:true,content:[{type:'text',text:JSON.stringify({code:'SAVE_FAILED'})}],_meta:{code:'SAVE_FAILED'}};
 if(params.name==='search_panel'){
  if(args.cancel)return {content:[],structuredContent:{results:[],discarded:true}};
  if((args.query.match(/"/g)||[]).length%2)return {isError:true,content:[],_meta:{code:'SEARCH_QUERY_INVALID'}};
  if(args.query==='error')return {isError:true,content:[],_meta:{code:'REQUEST_FAILED'}};
  await new Promise(resolve=>setTimeout(resolve,180));
  const titles=['OAuth login with PKCE','Authentication callback handling','Session refresh tokens','Secure sign-in flow','Debugging login redirects','OAuth provider setup','Token expiry handling','Local credential storage'];
  const results=args.query==='nothing'||args.query.includes('"missing phrase"')?[]:titles.map((title,i)=>({key:'fixture:'+i,threadId:String(i),sourceId:'fixture',title,project:{id:'qa',name:'Search demo'},updatedAt:'2026-10-29',snippet:{segments:[{text:'An original discussion about ',matched:false},{text:'authentication',matched:true},{text:' and implementation details. We chose a short-lived session token and a separate refresh token, with a clear recovery path when the session expires.',matched:false}],provenance:'message'},navigation:{kind:'open-original',url:'codex://threads/fixture-'+i}}));
  result={results,has_more:false,snapshot_id:'fixture'};
 }
 if(params.name==='read_settings')result=structuredClone(settings);
 if(params.name==='update_settings'){Object.assign(settings.preferences,args);result=structuredClone(settings);}
 if(params.name==='settings_action'){
  if(args.action==='source_enabled')settings.sources.find(s=>s.id===args.id).enabled=args.enabled;
  if(args.action==='rename_source')settings.sources.find(s=>s.id===args.id).label=args.label;
  if(args.action==='add_source')settings.sources.push({id:'second',label:'Work profile',codex_home:'D:/Codex/profile',enabled:true,last_sync:null,warning:false});
  if(args.action==='clear'){settings.status.threads=0;settings.status.chunks=0;settings.status.embedded=0;settings.preferences.paused=true;}
  if(args.action==='rebuild'){settings.status.threads=128;settings.status.chunks=2480;settings.status.embedded=2480;settings.preferences.paused=false;}
  if(args.action==='install_model'){settings.model={phase:'downloading',busy:true,bytes:218000000,total:558000000};setTimeout(()=>{settings.model={phase:'ready',busy:false,installed_bytes:558000000};},4000);}
  result=structuredClone(settings);
 }
 if(params.name==='search_filters')result={projects:[{key:'qa',name:'Search demo',thread_count:8}]};
 if(params.name==='search_status')result={threads:8,chunks:32,embedded:32,progress:{phase:'idle',error:null},model_ready:true};
 return {content:[],structuredContent:result};
};
bridge.onopenlink=async params=>{window.qa.opened.push(params.url);document.getElementById('opened').textContent=params.url;return {};};
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));
frame.src='/panel';
document.getElementById('theme').onchange=e=>{bridge.setHostContext({theme:e.target.value,locale:'en-US',displayMode:'inline'});};
document.getElementById('width').onchange=e=>{frame.style.width=e.target.value+'px';};
`},bundle:true,platform:'browser',format:'esm',write:false});
const panel=await readFile('dist/ui/index.html','utf8');
const icon=await readFile('assets/better-search-tab-dark.svg','utf8');
const server=createServer((req,res)=>{
 if(req.url==='/icon.svg'){res.setHeader('Content-Type','image/svg+xml');res.end(icon);return;}
 if(req.url==='/icon-preview'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><title>BetterSearch icon</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#181818"><img alt="BetterSearch icon with white magnifying glass" src="/icon.svg" width="256" height="256"></body></html>');return;}
 if(req.url==='/host.js'){res.setHeader('Content-Type','application/javascript');res.end(host.outputFiles[0].text);return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');
 if(req.url==='/panel'){res.end(panel);return;}
 res.end('<!doctype html><html lang="en"><title>BetterSearch development preview</title><style>body{font:14px system-ui;background:#eee;margin:24px}iframe{width:375px;height:750px;border:1px solid #ccc;display:block;margin-top:16px}label{margin-right:20px}</style><label>Theme <select id="theme"><option>light</option><option>dark</option></select></label><label>Panel width <select id="width"><option>375</option><option>768</option><option>1024</option></select></label><label><input id="fail-save" type="checkbox">Simulate failed save</label><span id="opened"></span><iframe title="BetterSearch panel"></iframe><script type="module" src="/host.js"></script></html>');
});
server.listen(39579,'127.0.0.1',()=>console.log('Synthetic panel QA: http://127.0.0.1:39579'));
