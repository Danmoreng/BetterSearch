import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

const bundle=await build({entryPoints:['src/ui.ts'],bundle:true,platform:'browser',format:'iife',write:false,plugins:[{name:'synthetic-app',setup(build){
  build.onResolve({filter:/^@modelcontextprotocol\/ext-apps$/},()=>({path:'app',namespace:'synthetic'}));
  build.onLoad({filter:/.*/,namespace:'synthetic'},()=>({contents:`export class App {async connect(){} getHostContext(){return {locale:'en-US',theme:'light'}} async callServerTool(params){return globalThis.fixtureApi(params)} async openLink(params){globalThis.opened.push(params.url);return {}}}` }));
}}]});
const html=await readFile('src/index.html','utf8');
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(predicate){for(let i=0;i<150;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('UI condition timed out');}

async function fixture(){
  const {window,document}=parseHTML(html);
  // Linkedom models DOM text and events, while these browser-specific properties need small shims.
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||'';},set(value){for(const option of this.querySelectorAll('option')){if(option.value===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');}}});
  window.HTMLElement.prototype.scrollIntoView=function(){};
  const calls=[],opened=[];
  const settings={preferences:{include_archived:true,density:'comfortable',automatic_updates:true,profile:'balanced',paused:false,agent_access:true,language:'auto'},sources:[{id:'fixture',label:'Synthetic',enabled:true,codex_home:'C:/Synthetic',last_sync:'2026-10-29T12:00:00Z'}],status:{version:'0.6.0',threads:3,chunks:3,embedded:3,indexing:false,embedding:false,model_ready:true,database_bytes:1024,progress:{phase:'idle',done:0,total:0,error:null}},model:{phase:'ready',busy:false,installed_bytes:1024}};
  let failSearch=false, pendingSave=null, pendingProjects=null;
  const fixtureApi=async params=>{
    calls.push(structuredClone(params));
    const args=params.arguments||{};
    if(params.name==='read_settings')return {structuredContent:structuredClone(settings)};
    if(params.name==='update_settings'){const waiting=pendingSave;pendingSave=null;if(waiting)await waiting;Object.assign(settings.preferences,args);return {structuredContent:structuredClone(settings)};}
    if(params.name==='settings_action'&&args.action==='source_enabled'){const waiting=pendingSave;pendingSave=null;if(waiting)await waiting;settings.sources.find(source=>source.id===args.id).enabled=args.enabled;return {structuredContent:structuredClone(settings)};}
    if(params.name==='search_filters'){
      const projects=settings.sources.some(source=>source.enabled)?[{key:'qa',name:'Search demo'}]:[];
      const waiting=pendingProjects;pendingProjects=null;if(waiting)await waiting;
      return {structuredContent:{projects}};
    }
    if(params.name==='search_panel'){
      if(args.cancel)return {structuredContent:{discarded:true,results:[]}};
      if(failSearch)return {isError:true,_meta:{code:'SERVICE_UNAVAILABLE'}};
      if((args.query.match(/"/g)?.length||0)%2)return {isError:true,_meta:{code:'SEARCH_QUERY_INVALID'}};
      const results=args.query==='nothing'?[]:['first','second'].filter(key=>args.include_archived!==false||key==='first').map(key=>({key,title:`Chat ${key}`,project:{id:'qa',name:'Search demo'},updatedAt:'2026-10-29',snippet:{segments:[{text:'Original text about authentication and a refresh token.',matched:false}],provenance:'message'},navigation:{kind:'open-original',url:`codex://threads/${key}`}}));
      return {structuredContent:{results,has_more:false,snapshot_id:'synthetic'}};
    }
    throw Error(params.name);
  };
  const context=vm.createContext({window,document,navigator:{language:'en-US'},HTMLElement:window.HTMLElement,HTMLInputElement:window.HTMLInputElement,HTMLSelectElement:window.HTMLSelectElement,HTMLDialogElement:window.HTMLDialogElement,AbortController,DOMException,URL,structuredClone,crypto:webcrypto,console,Intl,Date,setTimeout,clearTimeout,setInterval:()=>0,matchMedia:()=>({matches:false,addEventListener(){}}),getComputedStyle:()=>({getPropertyValue:()=> '166'}),fixtureApi,opened});
  window.parent={};
  vm.runInContext(bundle.outputFiles[0].text,context);
  await until(()=>document.querySelector('#project-filter').children.length===2);
  const el=id=>document.getElementById(id);
  const searchCalls=()=>calls.filter(call=>call.name==='search_panel'&&!call.arguments.cancel);
  const query=async value=>{el('query').value=value;el('query').oninput();await until(()=>searchCalls().at(-1)?.arguments.query===value);await turn();};
  const change=(id,value)=>{const field=el(id);field.value=value;field.onchange({target:field});};
  const holdNextSave=()=>{let release;pendingSave=new Promise(resolve=>{release=resolve;});return release;};
  const holdNextProjects=()=>{let release;pendingProjects=new Promise(resolve=>{release=resolve;});return release;};
  return {document,el,calls,searchCalls,query,change,opened,holdNextSave,holdNextProjects,setFail:value=>{failSearch=value;}};
}

test('project and time dropdowns are direct; custom dates apply explicitly and cancel preserves results',async()=>{
  const f=await fixture();
  assert.equal(f.searchCalls().length,0);assert.equal(f.el('idle').textContent,'');assert.equal(f.el('project-page'),null);
  assert.equal(f.el('filter-toggle'),null);assert.equal(f.el('contains-words'),null);assert.equal(f.document.querySelector('footer'),null);
  assert.equal(f.document.querySelector('.filter-tools').querySelectorAll('select').length,2);
  assert.equal(f.el('settings').textContent,'');assert.equal(f.el('settings').getAttribute('aria-label'),'Settings');assert.equal(f.el('settings').title,'Settings');
  f.change('project-filter','qa');assert.equal(f.searchCalls().length,0);
  f.change('date-filter','30');assert.equal(f.searchCalls().length,0);assert.equal(f.el('date-range').hidden,true);
  await f.query('authentication "refresh token"');
  const previousCount=f.searchCalls().length;
  f.change('date-filter','custom');assert.equal(f.el('date-range').hidden,false);assert.equal(f.searchCalls().length,previousCount);
  f.el('date-from').value='2026-10-01';f.el('date-through').value='2026-10-29';
  f.el('date-range').onsubmit({preventDefault(){}});
  await until(()=>f.searchCalls().length===previousCount+1);
  const args=f.searchCalls().at(-1).arguments;
  assert.equal(args.project_key,'qa');assert.equal(args.updated_after,new Date(2026,9,1).toISOString());assert.equal(args.updated_before,new Date(2026,9,30).toISOString());
  assert.equal(args.query,'authentication "refresh token"');assert.equal(args.contains_words,undefined);
  assert.equal(f.el('active-filters').children.length,2);assert.equal(f.el('date-range').hidden,true);
  const count=f.searchCalls().length;f.change('date-filter','custom');f.el('date-from').value='2026-11-01';f.el('date-range').onsubmit({preventDefault(){}});
  assert.equal(f.el('date-error').hidden,false);assert.equal(f.searchCalls().length,count);assert.equal(f.el('date-range').hidden,false);
  f.el('cancel-dates').onclick();assert.equal(f.el('date-filter').value,'applied-custom');assert.equal(f.el('date-range').hidden,true);assert.equal(f.searchCalls().length,count);
  assert.equal(f.el('date-filter').querySelector('option[value="custom"]').hidden,false);
  f.change('date-filter','custom');assert.equal(f.el('date-range').hidden,false);f.el('cancel-dates').onclick();
  f.change('date-filter','any');await until(()=>f.searchCalls().length===count+1);assert.equal(f.searchCalls().at(-1).arguments.updated_after,undefined);
  f.change('date-filter','custom');f.el('cancel-dates').onclick();assert.equal(f.el('date-filter').value,'any');assert.equal(f.el('active-filters').children.length,1);
});

test('returning from settings preserves selection and scroll unless search scope changed',async()=>{
  const f=await fixture();await f.query('authentication');
  const row=f.el('results').children[1];row.onpointermove();f.el('results').scrollTop=150;
  const count=f.searchCalls().length;f.el('settings').onclick();await turn();f.document.querySelector('.back').onclick();
  assert.equal(f.el('settings').hidden,false);
  assert.equal(f.searchCalls().length,count);assert.equal(f.el('results').children[1],row);assert.equal(row.getAttribute('aria-selected'),'true');assert.equal(f.el('results').scrollTop,150);
  f.el('settings').onclick();await turn();
  assert.equal(f.el('settings').hidden,true);
  const archived=f.document.querySelector('[data-setting="include_archived"]');archived.checked=false;archived.onchange();await turn();
  f.document.querySelector('.back').onclick();await until(()=>f.searchCalls().length===count+1);
  assert.equal(f.searchCalls().at(-1).arguments.include_archived,false);
});

test('incomplete quoted phrases explain the correction without an ineffective retry',async()=>{
  const f=await fixture();await f.query('"refresh token');
  assert.equal(f.el('search-recovery').hidden,true);assert.match(f.el('live-status').textContent,/quotation marks/);
  await f.query('"refresh token"');assert.equal(f.el('results').children.length,2);assert.equal(f.el('live-status').textContent,'');
});

test('a settings save finishing after Back immediately refreshes the visible search scope',async()=>{
  const f=await fixture();await f.query('authentication');
  assert.equal(f.el('results').children.length,2);const count=f.searchCalls().length;
  f.el('settings').onclick();await turn();
  const release=f.holdNextSave();
  const archived=f.document.querySelector('[data-setting="include_archived"]');archived.checked=false;archived.onchange();await turn();
  f.document.querySelector('.back').onclick();
  assert.equal(f.el('palette').hidden,false);assert.equal(f.searchCalls().length,count);
  release();
  await until(()=>f.searchCalls().length===count+1&&f.el('results').children.length===1);
  assert.equal(f.searchCalls().at(-1).arguments.include_archived,false);
  assert.equal(f.el('results').children[0].dataset.key,'first');assert.equal(f.el('query').value,'authentication');
});

test('a delayed source save queues fresh project choices behind an older request',async()=>{
  const f=await fixture();await f.query('authentication');f.el('settings').onclick();await turn();
  const releaseSave=f.holdNextSave(), releaseProjects=f.holdNextProjects();
  const source=f.el('source-enabled-fixture');source.checked=false;source.onchange();await turn();
  f.document.querySelector('.back').onclick();
  const count=f.calls.filter(call=>call.name==='search_filters').length;
  releaseSave();await turn();
  assert.equal(f.calls.filter(call=>call.name==='search_filters').length,count,'source change queues behind the active request');
  releaseProjects();
  await until(()=>f.calls.filter(call=>call.name==='search_filters').length===count+1&&f.el('project-filter').children.length===1);
  assert.equal(f.el('project-filter').children[0].value,'');assert.equal(f.el('project-error').hidden,true);
});

test('empty results broaden only on request and failed searches can be retried in place',async()=>{
  const f=await fixture();f.change('project-filter','qa');await f.query('nothing');
  assert.equal(f.el('empty').hidden,false);assert.match(f.el('empty-message').textContent,/Search demo/);
  assert.equal(f.searchCalls().at(-1).arguments.project_key,'qa');const count=f.searchCalls().length;
  f.el('empty-action').onclick();await until(()=>f.searchCalls().length===count+1);
  assert.equal(f.searchCalls().at(-1).arguments.project_key,undefined);assert.equal(f.el('query').value,'nothing');
  f.setFail(true);await f.query('authentication');assert.equal(f.el('search-recovery').hidden,false);
  f.setFail(false);f.el('retry-search').onclick();await until(()=>f.el('results').children.length===2);
  assert.equal(f.el('search-recovery').hidden,true);
  f.el('results').children[0].onclick({button:0});await turn();assert.deepEqual(f.opened,['codex://threads/first']);
});
