import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

const compiled=await build({entryPoints:['src/settings.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {Settings}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const html=await readFile('src/index.html','utf8');
const english=JSON.parse(await readFile('locales/en.json','utf8'));
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

function fixture(t){
 const {document,window}=parseHTML(html);
 for(const key of ['document','HTMLElement','HTMLInputElement']){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);
  Object.defineProperty(globalThis,key,{value:key==='document'?document:window[key],configurable:true,writable:true});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
 }
 // Linkedom omits browser select setters and modal dialog methods.
 const selectValue=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{...selectValue,set(value){
  for(const option of this.options)option.removeAttribute('selected');
  Array.from(this.options).find(option=>option.value===String(value))?.setAttribute('selected','');
 }});
 t.after(()=>Object.defineProperty(window.HTMLSelectElement.prototype,'value',selectValue));
 const dialog=document.getElementById('settings-confirm');
 dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');
 const state={
  preferences:{include_archived:true,density:'comfortable',automatic_updates:true,profile:'balanced',paused:false,agent_access:true,language:'auto'},
  sources:[{id:'work',label:'Work',codex_home:'C:/Synthetic/Work',enabled:true,last_sync:null,warning:false},
   {id:'personal',label:'Personal',codex_home:'C:/Synthetic/Personal',enabled:true,last_sync:null,warning:false}],
  status:{threads:12,chunks:40,embedded:40,indexing:false,embedding:false,model_ready:true,version:'test',database_bytes:1024,
   progress:{done:0,total:0,error:null}},
  model:{phase:'ready',busy:false,installed_bytes:1000},
 };
 const changes=[],calls=[];
 let nextFailure=null,cancelAction=false;
 const api=async(method,params={})=>{
  calls.push({method,params:structuredClone(params)});
  if(method==='read_settings')return structuredClone(state);
  if(nextFailure){const error=nextFailure;nextFailure=null;throw error;}
  if(method==='update_settings')Object.assign(state.preferences,params);
  if(method==='settings_action'){
   if(cancelAction){cancelAction=false;return {cancelled:true};}
   if(params.action==='source_enabled')state.sources.find(source=>source.id===params.id).enabled=params.enabled;
   if(params.action==='rename_source')state.sources.find(source=>source.id===params.id).label=params.label;
   if(params.action==='clear'){state.status.threads=0;state.preferences.paused=true;}
   if(params.action==='rebuild'){state.status.threads=12;state.preferences.paused=false;}
  }
  return structuredClone(state);
 };
 const settings=new Settings(api,(preferences,scope)=>changes.push({preferences:structuredClone(preferences),scope}));
 const field=key=>document.querySelector(`[data-setting="${key}"]`);
 const change=async(key,value)=>{
  const input=field(key);assert.ok(input,`missing settings field ${key}`);
  if(input.type==='checkbox')input.checked=value;else input.value=value;
  input.dispatchEvent(new window.Event('change',{bubbles:true}));await flush();
 };
 const toggleSource=async(id,enabled)=>{
  const input=document.getElementById(`source-enabled-${id}`);input.checked=enabled;
  input.dispatchEvent(new window.Event('change',{bubbles:true}));await flush();
 };
 const action=async name=>{
  document.querySelector(`[data-action="${name}"]`).click();
  if(name==='clear'||name==='rebuild'){
   assert.ok(dialog.hasAttribute('open'));document.getElementById('confirm-accept').click();
  }
  await flush();
 };
 return {document,settings,state,changes,calls,change,toggleSource,action,field,
  scope:()=>changes.at(-1)?.scope,fail:()=>{nextFailure=Error('SAVE_FAILED');},cancel:()=>{cancelAction=true;}};
}

test('presentation, resource preferences and status polling preserve the search scope',async t=>{
 const f=fixture(t);await f.settings.load();const scope=f.scope();
 await f.change('density','compact');await f.change('profile','efficient');await f.change('agent_access',false);
 f.state.status.threads=20;f.state.status.embedded=48;
 f.state.sources.reverse();f.state.sources[0].label='A renamed source';
 f.state.sources[0].last_sync='2026-10-29T10:00:00Z';await f.settings.load();
 assert.ok(f.changes.length>=5);assert.ok(f.changes.every(change=>change.scope===scope));
 assert.equal(f.state.preferences.density,'compact');assert.equal(f.state.preferences.profile,'efficient');
});

test('archive and enabled-source changes invalidate only the relevant search scope',async t=>{
 const f=fixture(t);await f.settings.load();const initial=f.scope();
 await f.change('include_archived',false);const withoutArchived=f.scope();assert.notEqual(withoutArchived,initial);
 await f.toggleSource('work',false);assert.notEqual(f.scope(),withoutArchived);
 assert.deepEqual(JSON.parse(f.scope()).sources,['personal']);
 await f.toggleSource('work',true);assert.equal(f.scope(),withoutArchived);
 await f.change('include_archived',true);assert.equal(f.scope(),initial);
});

test('only successful destructive maintenance revisions require a fresh search',async t=>{
 const f=fixture(t);await f.settings.load();const initial=f.scope();
 await f.action('refresh');assert.equal(f.scope(),initial);
 f.cancel();await f.action('clear');assert.equal(f.scope(),initial);
 f.fail();await f.action('rebuild');assert.equal(f.scope(),initial);
 await f.action('clear');const cleared=f.scope();assert.notEqual(cleared,initial);
 await f.settings.load();assert.equal(f.scope(),cleared);
 await f.action('rebuild');assert.notEqual(f.scope(),cleared);
 assert.equal(JSON.parse(f.scope()).revision,2);
 assert.ok(f.calls.filter(call=>['clear','rebuild'].includes(call.params.action)).every(call=>call.params.confirmed===true));
});

test('failed archive and source saves restore the controls without changing search scope',async t=>{
 const f=fixture(t);await f.settings.load();const initial=f.scope(),accepted=f.changes.length;
 f.fail();await f.change('include_archived',false);
 assert.equal(f.field('include_archived').checked,true);assert.equal(f.scope(),initial);assert.equal(f.changes.length,accepted);
 assert.equal(f.document.getElementById('settings-error').hidden,false);
 f.fail();await f.toggleSource('work',false);
 assert.equal(f.document.getElementById('source-enabled-work').checked,true);assert.equal(f.scope(),initial);
 assert.equal(f.changes.length,accepted);assert.equal(f.document.getElementById('save-status').textContent,english['settings.notSaved']);
});

test('settings distinguish an empty index from a searchable index',async t=>{
 const f=fixture(t);f.state.status.threads=0;await f.settings.load();
 assert.equal(f.document.getElementById('index-phase').textContent,english['settings.emptyIndex']);
 f.state.status.threads=12;await f.settings.load();
 assert.equal(f.document.getElementById('index-phase').textContent,english['settings.ready']);
});
