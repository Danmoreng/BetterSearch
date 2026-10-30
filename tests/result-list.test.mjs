import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

async function compile(file){
  const result=await build({entryPoints:[file],bundle:true,format:'esm',platform:'node',write:false});
  return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const {renderResults}=await compile('src/result-list.ts');
const {SearchController}=await compile('src/search-controller.ts');
const hit=key=>({key,title:`Chat ${key}`,project:{id:'p',name:'Project'},updatedAt:'2026-10-28',
  snippet:{segments:[{text:'Match',matched:true}],provenance:'original'},
  navigation:{kind:'open-original',url:`codex://threads/${key}`}});

function fixture(){
  const {document,Event,MutationObserver}=parseHTML('<html><body><input><ul></ul><div></div></body></html>');
  const list=document.querySelector('ul'),input=document.querySelector('input'),empty=document.querySelector('div');
  const opened=[],mutations=[];
  const search=new SearchController(async()=>({}),()=>redraw(),()=>{});
  const redraw=()=>renderResults(list,input,empty,search,key=>opened.push(search.results.find(r=>r.key===key).navigation.url));
  search.results=[hit('a'),hit('b')];search.selected='a';redraw();
  const observer=new MutationObserver(records=>mutations.push(...records));
  observer.observe(list,{childList:true});
  const pointer=(target,type,button=0)=>{
    const event=new Event(type,{bubbles:true,cancelable:true});event.button=button;target.dispatchEvent(event);return event;
  };
  return {list,input,search,opened,mutations,redraw,pointer,observer};
}

test('mouse down and hover keep rows attached until the click opens the original chat',async()=>{
  const f=fixture();
  try{
    const row=f.list.children[1],title=row.querySelector('.hit-title');
    f.pointer(title,'pointermove');
    assert.equal(f.search.selected,'b');
    assert.equal(f.pointer(title,'pointerdown').defaultPrevented,true);
    f.pointer(title,'pointermove');f.pointer(title,'pointerup');f.pointer(title,'click');
    await Promise.resolve();
    assert.equal(f.list.children[1],row);assert.equal(row.querySelector('.hit-title'),title);
    assert.equal(f.input.getAttribute('aria-activedescendant'),row.id);
    assert.deepEqual(f.opened,['codex://threads/b']);
    assert.equal(f.mutations.filter(record=>record.type==='childList').length,0,'selection must not detach or reinsert any click target');
  }finally{f.observer.disconnect();f.search.close();}
});

test('clicking a snippet survives appending another page',async()=>{
  const f=fixture();
  try{
    const row=f.list.children[0],target=row.querySelector('mark');
    f.pointer(target,'pointerdown');
    f.search.results.push(hit('c'));f.redraw();
    f.pointer(target,'pointerdown');f.pointer(target,'pointerup');f.pointer(target,'click');
    await Promise.resolve();
    assert.equal(f.list.children[0],row);assert.equal(row.querySelector('mark'),target);
    assert.equal(target.isConnected,true);
    assert.deepEqual(f.opened,['codex://threads/a']);
    assert.ok(f.mutations.every(record=>record.removedNodes.length===0),'adding results or changing revision must not detach existing rows');
    assert.equal(new Set(Array.from(f.list.children,r=>r.id)).size,3);
    f.pointer(target,'pointerdown',2);f.pointer(target,'click',2);
    assert.equal(f.opened.length,1,'right click must not open a chat');
  }finally{f.observer.disconnect();f.search.close();}
});

test('updated results reuse the row, refresh text safely, and activate current navigation',()=>{
  const f=fixture();
  try{
    const row=f.list.children[0];
    const updated={...hit('a'),title:'<script>example</script>',navigation:{kind:'open-original',url:'codex://threads/current'}};
    f.search.results=[updated,hit('c')];f.redraw();
    assert.equal(f.list.children[0],row);
    assert.equal(row.querySelector('.hit-title').textContent,updated.title);
    assert.equal(row.querySelector('script'),null);
    f.pointer(row.querySelector('.project'),'click');
    assert.deepEqual(f.opened,['codex://threads/current']);
    assert.deepEqual(Array.from(f.list.children,r=>r.dataset.key),['a','c']);
  }finally{f.observer.disconnect();f.search.close();}
});
