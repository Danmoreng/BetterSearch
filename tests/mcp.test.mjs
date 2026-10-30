import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createServer} from 'node:http';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import pkg from '../package.json' with {type:'json'};

test('MCP exposes one conversation panel, headless search and minimal operational tools',async()=>{
 const client=new Client({name:'better-search-test',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/mcp.js')],stderr:'pipe'});
 try{
  await client.connect(transport);
  for(const theme of ['dark','light']){
   const icon=client.getServerVersion().icons.find(i=>i.theme===theme);
   assert.equal(icon.mimeType,'image/png');assert.deepEqual(icon.sizes,['256x256']);
   const png=Buffer.from(icon.src.split(',')[1],'base64');
   assert.deepEqual(png,await readFile(`assets/better-search-tab-mask-${theme}.png`));
   assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
   assert.equal(png.readUInt32BE(16),256);assert.equal(png.readUInt32BE(20),256);
  }
  const {tools}=await client.listTools();
  assert.deepEqual(tools.map(t=>t.name).sort(),['manage_index','open_search','read_settings','search_chats','search_filters','search_panel','search_status','settings_action','update_settings']);
  for(const name of ['search_panel','read_settings','update_settings','settings_action'])
   assert.deepEqual(tools.find(t=>t.name===name)._meta.ui.visibility,['app']);
  const panel=tools.find(t=>t.name==='open_search'),search=tools.find(t=>t.name==='search_chats');
  assert.deepEqual(panel._meta['openai/ui'].entrypoints,[{type:'thread'}]);
  assert.equal(search._meta,undefined,'agent search must not open or bind a UI');
  assert.equal(search.annotations.readOnlyHint,true);assert.ok(search.outputSchema);
  for(const name of ['search_chats','search_panel']) {
   const inputs=tools.find(t=>t.name===name).inputSchema.properties;
   assert.equal(inputs.updated_after.type,'string');assert.ok(inputs.updated_after.pattern);
   assert.equal(inputs.updated_before.type,'string');assert.ok(inputs.updated_before.pattern);
   assert.equal(inputs.contains_words,undefined);assert.match(inputs.query.description,/double quotes/);
  }
  assert.deepEqual(tools.find(t=>t.name==='manage_index')._meta.ui.visibility,['app']);
  const {resources}=await client.listResources();assert.equal(resources.length,1);
  const resource=await client.readResource({uri:panel._meta.ui.resourceUri});
  const html=resource.contents[0].text;
  assert.deepEqual(resource.contents[0]._meta['openai/ui'].availableDisplayModes,['inline']);
  assert.ok(html.includes('data-surface="panel"'));assert.ok(html.includes('role="combobox"'));
  assert.ok(html.includes('data-i18n-aria-label="search.clear"'));assert.ok(html.includes('id="idle"'));
 }finally{await client.close();}
});

test('headless search returns structured results without loading panel resources',async()=>{
 const home=await mkdtemp(path.resolve('.runtime/mcp-headless-'));await writeFile(path.join(home,'access-token'),'test-token');
 const calls=[];
 const fixture=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/health'){res.end(JSON.stringify({service:'better-search',version:pkg.version}));return;}
  let raw='';for await(const part of req)raw+=part;
  calls.push(JSON.parse(raw));res.end(JSON.stringify({result:{results:[{key:'fixture:a',source_id:'fixture',origin_id:'fixture-origin',source_label:'Fixture',thread_id:'a',title:'Evidence',project_key:'p',project_name:'Fixture',repo:'',branch:'',archived:0,updated_at:'2026-10-29',url:'codex://threads/a',navigation:{kind:'open-original',url:'codex://threads/a'},snippet:'Original evidence',score:1,matches:[],evidence:{title:true,project:false,keyword:true,semantic:false}}],requestId:0,has_more:false}}));
 });
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const client=new Client({name:'headless-test',version:'1.0.0'});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/mcp.js')],env:{...process.env,BETTER_SEARCH_HOME:home,BETTER_SEARCH_PORT:String(fixture.address().port)},stderr:'pipe'}));
  const filters={updated_after:'2026-10-01T22:00:00.000Z',updated_before:'2026-10-29'};
  const query='evidence "exact phrase"';
  const result=await client.callTool({name:'search_chats',arguments:{query,...filters}});
  assert.equal(result.isError,undefined);assert.equal(result.structuredContent.results[0].key,'fixture:a');
  assert.deepEqual(calls.map(c=>c.method),['search_chats']);
  assert.equal(calls[0].params.query,query);
  for(const [name,value] of Object.entries(filters))assert.equal(calls[0].params[name],value);
  await client.callTool({name:'search_panel',arguments:{query,...filters}});
  assert.equal(calls[1].method,'search_panel');
  assert.equal(calls[1].params.query,query);
  for(const [name,value] of Object.entries(filters))assert.equal(calls[1].params[name],value);
 }finally{await client.close();await new Promise(resolve=>fixture.close(resolve));}
});

test('MCP rejects a mismatched service version with an actionable English error',async()=>{
 const fixture=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'better-search',version:'0.0.1'}));});
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const client=new Client({name:'version-test',version:'1.0.0'});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/mcp.js')],env:{...process.env,BETTER_SEARCH_PORT:String(fixture.address().port)},stderr:'pipe'}));
  await client.listTools(); // Cache output schemas, as the desktop host does.
  const result=await client.callTool({name:'search_status',arguments:{}});
  assert.equal(result._meta.code,'VERSION_MISMATCH');
  assert.equal(result.isError,true);assert.match(result.content[0].text,/0\.0\.1/);assert.ok(result.content[0].text.includes(`requires ${pkg.version}`));
 }finally{await client.close();await new Promise(resolve=>fixture.close(resolve));}
});
