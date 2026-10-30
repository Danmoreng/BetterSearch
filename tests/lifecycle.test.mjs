import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {access,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {mcpTransport} from '../scripts/platform.mjs';
import pkg from '../package.json' with {type:'json'};
const pluginRoot=path.resolve(process.env.BETTER_SEARCH_TEST_ROOT||'.');

test('adapter exits cleanly when the host disconnects during an active HTTP request, then restarts',
 {timeout:25000},async()=>{
 const home=await mkdtemp(path.resolve('.runtime/lifecycle-test-'));
 await writeFile(path.join(home,'access-token'),'synthetic-lifecycle-token');
 const waiting=[];let seen;
 const fixture=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/health'){res.end(JSON.stringify({service:'better-search',version:pkg.version}));return;}
  for await(const _ of req){}
  waiting.push(res);seen?.();
 });
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const manifest=process.env.BETTER_SEARCH_TEST_ROOT
  ? JSON.parse(await readFile(path.join(pluginRoot,'.mcp.json'),'utf8')).mcpServers['better-search']
  : mcpTransport();
 try{
  // Exercise the platform transport, including the Windows command wrapper.
  for(const mode of ['stdin','both','stdout','both','stdin','stdout']){
   const child=spawn(manifest.command,manifest.args,{cwd:pluginRoot,windowsHide:true,
    env:{...process.env,BETTER_SEARCH_HOME:home,BETTER_SEARCH_PORT:String(fixture.address().port)},
    stdio:['pipe','pipe','pipe']});
   let stderr='';child.stderr.on('data',data=>stderr+=data);child.stdin.on('error',()=>{});
   const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
   const lines=createInterface({input:child.stdout});
   const initialized=new Promise((resolve,reject)=>{
    lines.on('line',line=>{try{const message=JSON.parse(line);if(message.id===1)resolve();}catch(error){reject(error);}});
    child.once('error',reject);
   });
   const timeout=setTimeout(()=>{child.stdin.destroy();child.stdout.destroy();child.kill();},3500);
   try{
    const send=message=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
    send({id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'lifecycle-test',version:'1'}}});
    await initialized;send({method:'notifications/initialized'});
    const active=new Promise(resolve=>{seen=resolve;});
    send({id:2,method:'tools/call',params:{name:'search_chats',arguments:{query:'synthetic'}}});
    await active;
    const started=Date.now();
    if(mode!=='stdout')child.stdin.end();
    if(mode!=='stdin'){lines.close();child.stdout.destroy();}
    // With only stdout closed, let the pending reply encounter the closed pipe.
    if(mode==='stdout')waiting.at(-1).end(JSON.stringify({result:{results:[],requestId:0}}));
    const result=await closed;
    assert.deepEqual(result,{code:0,signal:null},`${mode}: ${stderr}`);
    assert.ok(Date.now()-started<2500,`${mode}: adapter did not stop promptly`);
    assert.equal(stderr,'',`${mode}: unexpected shutdown diagnostics`);
    assert.equal(await fetch(`http://127.0.0.1:${fixture.address().port}/health`).then(r=>r.status),200,
     'Disconnecting an adapter must leave the independent HTTP service available');
   }finally{clearTimeout(timeout);lines.close();child.stdin.destroy();child.stdout.destroy();if(child.exitCode===null)child.kill();}
  }
 }finally{
  for(const response of waiting)response.destroy();fixture.closeAllConnections();
  await new Promise(resolve=>fixture.close(resolve));
 }
});

test('disconnect during service startup releases the owned lock without spawning a service',
 {timeout:8000},async()=>{
 const home=await mkdtemp(path.resolve('.runtime/lifecycle-startup-'));
 let healthCalls=0,blocked;
 const startupBlocked=new Promise(resolve=>{blocked=resolve;});
 const fixture=createServer((req,res)=>{
  if(req.url==='/health'&&++healthCalls===1){res.writeHead(404).end();return;}
  blocked(); // The second health check runs after this adapter acquired the lock.
 });
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const manifest=process.env.BETTER_SEARCH_TEST_ROOT
  ? JSON.parse(await readFile(path.join(pluginRoot,'.mcp.json'),'utf8')).mcpServers['better-search']
  : mcpTransport();
 const child=spawn(manifest.command,manifest.args,{cwd:pluginRoot,windowsHide:true,
  env:{...process.env,BETTER_SEARCH_HOME:home,BETTER_SEARCH_PORT:String(fixture.address().port)},
  stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);child.stdin.on('error',()=>{});
 const lines=createInterface({input:child.stdout});
 const initialized=new Promise((resolve,reject)=>{
  lines.on('line',line=>{try{if(JSON.parse(line).id===1)resolve();}catch(error){reject(error);}});
  child.once('error',reject);
 });
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 const timeout=setTimeout(()=>{child.stdin.destroy();child.stdout.destroy();child.kill();},5000);
 try{
  const send=message=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
  send({id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'startup-test',version:'1'}}});
  await initialized;send({method:'notifications/initialized'});
  send({id:2,method:'tools/call',params:{name:'search_chats',arguments:{query:'synthetic'}}});
  await startupBlocked;
  assert.ok(Number(await readFile(path.join(home,'service-start.lock'),'utf8'))>0);
  child.stdin.end();
  assert.deepEqual(await closed,{code:0,signal:null},stderr);assert.equal(stderr,'');
  await assert.rejects(access(path.join(home,'service-start.lock')),{code:'ENOENT'});
  await assert.rejects(access(path.join(home,'service.log')),{code:'ENOENT'});
 }finally{
  clearTimeout(timeout);lines.close();child.stdin.destroy();child.stdout.destroy();
  if(child.exitCode===null)child.kill();fixture.closeAllConnections();
  await new Promise(resolve=>fixture.close(resolve));
 }
});
