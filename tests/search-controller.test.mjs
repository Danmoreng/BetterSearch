import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['src/search-controller.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {SearchController}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
const hit=key=>({key});
function fixture(t,initialLimit){
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=[],statuses=[],renders=[];
 const api=(_method,params,signal)=>params.cancel?Promise.resolve({}):new Promise((resolve,reject)=>pending.push({params,signal,resolve,reject}));
 const controller=new SearchController(api,()=>renders.push(controller.results.map(r=>r.key)),text=>statuses.push(text),initialLimit);
 return {controller,pending,statuses,renders};
}
test('opening, clearing and whitespace never issue searches or show recent chats',async t=>{
 const {controller:c,pending}=fixture(t);
 for(const query of ['', '   ', '\n\t']){c.begin(query);t.mock.timers.tick(1000);assert.equal(c.state,'idle');assert.deepEqual(c.results,[]);}
 assert.equal(pending.length,0);
 c.begin('something');t.mock.timers.tick(180);c.begin('');
 pending[0].resolve({results:[hit('stale')]});await flush();
 assert.deepEqual(c.results,[]);assert.equal(c.state,'idle');c.close();
});
test('one debounced hybrid request publishes only a completed result list',async t=>{
 const {controller:c,pending,renders}=fixture(t,()=>12);
 c.begin('l');t.mock.timers.tick(100);c.begin('login');t.mock.timers.tick(179);
 assert.equal(pending.length,0);assert.deepEqual(c.results,[]);
 t.mock.timers.tick(1);assert.equal(pending.length,1);assert.equal(pending[0].params.mode,'hybrid');assert.equal(pending[0].params.limit,12);
 pending[0].resolve({results:[hit('b'),hit('a')],snapshot_id:'s',has_more:false});await flush();
 t.mock.timers.tick(1000);assert.equal(pending.length,1);assert.deepEqual(c.results.map(r=>r.key),['b','a']);
 assert.equal(renders.filter(rows=>rows.length).length,1);assert.equal(c.state,'ready');c.close();
});
test('new input invalidates responses and errors before its debounce fires',async t=>{
 const {controller:c,pending,statuses}=fixture(t);
 c.begin('old');t.mock.timers.tick(180);c.begin('new');assert.ok(pending[0].signal.aborted);
 pending[0].resolve({results:[hit('old')]});await flush();assert.deepEqual(c.results,[]);
 t.mock.timers.tick(180);pending[1].resolve({results:[hit('new')]});await flush();assert.equal(c.results[0].key,'new');
 c.begin('third');t.mock.timers.tick(180);c.begin('fourth');pending[2].reject(Error('obsolete'));await flush();
 assert.ok(!statuses.includes('obsolete'));c.close();
});
test('later pages use the original snapshot and preserve rows and selection',async t=>{
 const {controller:c,pending}=fixture(t,()=>12);
 c.begin('query');t.mock.timers.tick(180);
 pending[0].resolve({results:[hit('a'),hit('b')],snapshot_id:'ranked-snapshot',has_more:true});await flush();
 c.move(1);const more=c.loadMore();
 assert.equal(pending[1].params.offset,2);assert.equal(pending[1].params.snapshot_id,'ranked-snapshot');
 pending[1].resolve({results:[hit('c')],has_more:false,corpusRevision:999});await more;
 assert.deepEqual(c.results.map(r=>r.key),['a','b','c']);assert.equal(c.selected,'b');c.close();
});

test('the saved archived preference is applied to the first page and its immutable continuation',async t=>{
 const {controller:c,pending}=fixture(t);
 c.begin('query',{include_archived:false});t.mock.timers.tick(180);
 assert.equal(pending[0].params.include_archived,false);
 pending[0].resolve({results:[hit('a')],snapshot_id:'s',has_more:true});await flush();
 const more=c.loadMore();assert.equal(pending[1].params.include_archived,false);
 pending[1].resolve({results:[],has_more:false});await more;c.close();
});
test('IME composition and closing suppress requests and late updates',async t=>{
 const {controller:c,pending}=fixture(t);
 c.begin('に',{},true);t.mock.timers.tick(1000);assert.equal(pending.length,0);
 c.begin('日本');t.mock.timers.tick(180);c.close();pending[0].resolve({results:[hit('closed')]});await flush();
 assert.equal(c.state,'idle');assert.deepEqual(c.results,[]);
});
test('a keyword fallback is final and a failed request never leaves old results',async t=>{
 const {controller:c,pending,statuses}=fixture(t);
 c.begin('first');t.mock.timers.tick(180);
 pending[0].resolve({results:[hit('text')],warningCode:'SEMANTIC_UNAVAILABLE'});await flush();
 assert.match(statuses.at(-1),/Text (?:results|search) only/);t.mock.timers.tick(1000);assert.equal(pending.length,1);
 c.begin('second');assert.deepEqual(c.results,[]);t.mock.timers.tick(180);
 pending[1].reject(Error('model failed'));await flush();assert.equal(c.state,'error');assert.deepEqual(c.results,[]);c.close();
});
test('a late pagination finalizer cannot unlock pagination for a different query',async t=>{
 const {controller:c,pending}=fixture(t);
 c.begin('a');t.mock.timers.tick(180);pending[0].resolve({results:[hit('a')],snapshot_id:'a',has_more:true});await flush();
 const old=c.loadMore();c.begin('b');t.mock.timers.tick(180);pending[2].resolve({results:[hit('b')],snapshot_id:'b',has_more:true});await flush();
 const current=c.loadMore();pending[1].resolve({results:[hit('old')]});await old;
 await c.loadMore();assert.equal(pending.length,4);
 pending[3].resolve({results:[hit('new')],has_more:false});await current;
 assert.deepEqual(c.results.map(r=>r.key),['b','new']);c.close();
});

test('settings round trip preserves completed pages, selection and snapshot without another search',async t=>{
 const {controller:c,pending}=fixture(t);
 c.begin('query',{project_key:'project',include_archived:true});t.mock.timers.tick(180);
 pending[0].resolve({results:[hit('a'),hit('b')],snapshot_id:'original',has_more:true});await flush();
 const page=c.loadMore();pending[1].resolve({results:[hit('c')],has_more:true});await page;
 c.select('c');const original=c.results;
 c.suspend();await c.loadMore();t.mock.timers.tick(5000);assert.equal(pending.length,2);
 assert.equal(c.resume(' query ',{include_archived:true,project_key:'project'}),false);
 t.mock.timers.tick(1000);assert.equal(pending.length,2);assert.equal(c.results,original);
 assert.deepEqual(c.results.map(r=>r.key),['a','b','c']);assert.equal(c.selected,'c');assert.equal(c.frozen,true);
 const next=c.loadMore();assert.equal(pending[2].params.snapshot_id,'original');assert.equal(pending[2].params.offset,3);
 pending[2].resolve({results:[hit('d')],has_more:false});await next;c.close();
});

test('leaving during debounce or inference cancels work and resumes only the unfinished search',async t=>{
 const {controller:c,pending}=fixture(t);
 c.begin('before debounce');c.suspend();t.mock.timers.tick(1000);assert.equal(pending.length,0);
 assert.equal(c.resume('before debounce'),true);t.mock.timers.tick(180);assert.equal(pending.length,1);
 c.suspend();assert.ok(pending[0].signal.aborted);
 pending[0].resolve({results:[hit('stale')]});await flush();assert.deepEqual(c.results,[]);
 assert.equal(c.resume('before debounce'),true);t.mock.timers.tick(180);
 pending[1].resolve({results:[hit('current')],snapshot_id:'current'});await flush();
 assert.deepEqual(c.results.map(r=>r.key),['current']);c.close();
});

test('changed search preferences rerun on return and filters are captured immutably',async t=>{
 const {controller:c,pending}=fixture(t),filters={include_archived:true,project_keys:['first']};
 c.begin('query',filters);filters.project_keys.push('later');t.mock.timers.tick(180);
 assert.deepEqual(pending[0].params.project_keys,['first']);
 pending[0].resolve({results:[hit('old')],snapshot_id:'old'});await flush();c.suspend();
 assert.equal(c.resume('query',{include_archived:false,project_keys:['first']}),true);
 assert.deepEqual(c.results,[]);t.mock.timers.tick(180);assert.equal(pending[1].params.include_archived,false);
 pending[1].resolve({results:[hit('new')],snapshot_id:'new'});await flush();assert.equal(c.results[0].key,'new');c.close();
});

test('returning after an unfinished composition searches only after composition has ended',async t=>{
 const {controller:c,pending}=fixture(t);
 c.begin('日本',{},true);c.suspend();assert.equal(c.resume('日本',{},true),true);
 t.mock.timers.tick(1000);assert.equal(pending.length,0);
 c.suspend();assert.equal(c.resume('日本'),true);t.mock.timers.tick(180);
 pending[0].resolve({results:[hit('composed')]});await flush();assert.equal(c.results[0].key,'composed');c.close();
});

test('suspended pagination ignores late pages and can continue the preserved snapshot',async t=>{
 const {controller:c,pending}=fixture(t);
 c.begin('query');t.mock.timers.tick(180);pending[0].resolve({results:[hit('a')],snapshot_id:'s',has_more:true});await flush();
 const old=c.loadMore();c.suspend();assert.ok(pending[1].signal.aborted);
 pending[1].resolve({results:[hit('stale')],has_more:false});await old;
 assert.equal(c.resume('query'),false);assert.deepEqual(c.results.map(r=>r.key),['a']);
 const next=c.loadMore();assert.equal(pending[2].params.snapshot_id,'s');assert.equal(pending[2].params.offset,1);
 pending[2].resolve({results:[hit('b')],has_more:false});await next;assert.deepEqual(c.results.map(r=>r.key),['a','b']);c.close();
});

test('failed searches offer explicit retry and settings navigation does not retry silently',async t=>{
 const {controller:c,pending}=fixture(t);
 c.begin('query');t.mock.timers.tick(180);pending[0].reject(Error('network'));await flush();
 assert.equal(c.recovery,'retry');c.suspend();assert.equal(c.resume('query'),false);
 t.mock.timers.tick(1000);assert.equal(pending.length,1);assert.equal(c.state,'error');
 c.retry();assert.equal(c.recovery,'none');t.mock.timers.tick(180);
 pending[1].resolve({results:[hit('retry')]});await flush();assert.equal(c.state,'ready');c.close();
});

test('malformed exact phrases explain how to fix the query without offering a useless retry',async t=>{
 const {controller:c,pending,statuses}=fixture(t);
 c.begin('login "exact phrase');t.mock.timers.tick(180);
 pending[0].reject(Error('SEARCH_QUERY_INVALID'));await flush();
 assert.equal(c.state,'error');assert.equal(c.recovery,'none');assert.deepEqual(c.results,[]);
 assert.match(statuses.at(-1),/matching quotation marks/);
 c.retry();t.mock.timers.tick(1000);assert.equal(pending.length,1);
 c.suspend();assert.equal(c.resume('login "exact phrase'),false);assert.match(statuses.at(-1),/quotation marks/);
 c.begin('login "exact phrase"');assert.equal(statuses.at(-1),'');t.mock.timers.tick(180);
 assert.equal(pending[1].params.query,'login "exact phrase"');
 pending[1].resolve({results:[hit('fixed')]});await flush();assert.equal(c.state,'ready');assert.equal(c.results[0].key,'fixed');c.close();
});

test('a late invalid-phrase response cannot replace a corrected query state',async t=>{
 const {controller:c,pending,statuses}=fixture(t);
 c.begin('"unfinished');t.mock.timers.tick(180);c.begin('"finished"');
 pending[0].reject(Error('SEARCH_QUERY_INVALID'));await flush();
 assert.equal(c.state,'waiting');assert.equal(c.recovery,'none');assert.equal(statuses.at(-1),'');
 t.mock.timers.tick(180);pending[1].resolve({results:[hit('corrected')]});await flush();
 assert.equal(c.results[0].key,'corrected');assert.equal(c.state,'ready');c.close();
});

test('a transient page failure retries the same snapshot only after an explicit action',async t=>{
 const {controller:c,pending,statuses}=fixture(t);
 c.begin('query');t.mock.timers.tick(180);pending[0].resolve({results:[hit('a')],snapshot_id:'s',has_more:true});await flush();
 const page=c.loadMore();pending[1].reject(Error('network'));await page;
 assert.equal(c.recovery,'retry');assert.match(statuses.at(-1),/load more/i);
 await c.loadMore();assert.equal(pending.length,2);assert.deepEqual(c.results.map(r=>r.key),['a']);
 const retry=c.retry();assert.equal(pending[2].params.snapshot_id,'s');assert.equal(pending[2].params.offset,1);
 pending[2].resolve({results:[hit('b')],has_more:false});await retry;
 assert.deepEqual(c.results.map(r=>r.key),['a','b']);assert.equal(c.recovery,'none');c.close();
});

test('expired snapshots retain visible results until the user explicitly refreshes the search',async t=>{
 const {controller:c,pending}=fixture(t);
 c.begin('query "required phrase"',{project_key:'project'});t.mock.timers.tick(180);
 pending[0].resolve({results:[hit('old')],snapshot_id:'expired',has_more:true});await flush();
 const page=c.loadMore();pending[1].reject(Error('SEARCH_SNAPSHOT_EXPIRED'));await page;
 assert.equal(c.recovery,'refresh');assert.equal(c.state,'ready');assert.equal(c.results[0].key,'old');
 c.suspend();assert.equal(c.resume('query "required phrase"',{project_key:'project'}),false);
 await c.loadMore();t.mock.timers.tick(1000);assert.equal(pending.length,2);
 c.retry();assert.deepEqual(c.results,[]);t.mock.timers.tick(180);
 assert.equal(pending[2].params.snapshot_id,undefined);assert.equal(pending[2].params.project_key,'project');
 assert.equal(pending[2].params.query,'query "required phrase"');
 pending[2].resolve({results:[hit('fresh')],snapshot_id:'fresh'});await flush();assert.equal(c.results[0].key,'fresh');c.close();
});
