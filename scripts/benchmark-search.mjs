// Uses a running LOCAL preview. Does not import chats, modify the index or install a plugin.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home=process.env.BETTER_SEARCH_HOME || path.resolve('.runtime/preview');
const port=Number(process.env.BETTER_SEARCH_PORT || 39472);
const token=(await readFile(path.join(home,'access-token'),'utf8')).trim();
const queries=['Login','codex','SQLite','session','Projekt','CUDA','OAuth','Sicherheit','Architektur','SSH','Repository','Windows'];
const http=async(method,params={})=>{
  const r=await fetch(`http://127.0.0.1:${port}/api`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  const body=await r.json();if(!r.ok||body.error)throw Error(body.error||`HTTP ${r.status}`);return body.result;
};
const client=new Client({name:'better-search-benchmark',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/mcp.js')],env:{...process.env,BETTER_SEARCH_HOME:home,BETTER_SEARCH_PORT:String(port)},stderr:'pipe'});
const measurements=[];
try{
  await client.connect(transport);
  // Warm the model separately; cold startup is recorded separately from the warm distribution.
  let start=performance.now();const cold=await http('search_chats',{query:'initial warmup',mode:'hybrid',limit:6,presentation:'palette-v1'});
  const coldMs=performance.now()-start;
  for(const channel of ['http','mcp'])for(const mode of ['keyword','hybrid'])for(let repeat=0;repeat<3;repeat++)for(const query of queries){
    // Vary limit within the supported contract to avoid response-cache hits.
    // Embedding cache is retained, just as during incremental typing/revisiting queries.
    const params={query,mode,limit:6+repeat+ (channel==='mcp'?3:0),presentation:'palette-v1'};
    start=performance.now();
    const result=channel==='http'?await http('search_chats',params):(await client.callTool({name:'search_chats',arguments:params})).structuredContent;
    if(!result || result.discarded)throw Error('Missing benchmark result');
    measurements.push({channel,mode,repeat,query,ms:performance.now()-start,count:result.results.length,...result.timings});
  }
  const summary=[];
  for(const channel of ['http','mcp'])for(const mode of ['keyword','hybrid']){
    const values=measurements.filter(m=>m.channel===channel&&m.mode===mode).map(m=>m.ms).sort((a,b)=>a-b);
    const percentile=p=>values[Math.ceil(values.length*p)-1];
    summary.push({channel,mode,samples:values.length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)});
  }
  const status=await http('search_status');
  const report={date:new Date().toISOString(),cold:{http_ms:coldMs,...cold.timings},summary,counts:{threads:status.threads,chunks:status.chunks,vectors:status.vector_rows},version:status.version,measurements};
  await mkdir('artifacts/benchmarks',{recursive:true});
  await writeFile('artifacts/benchmarks/search.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({cold:report.cold,summary,counts:report.counts},null,2));
}finally{await client.close();}
