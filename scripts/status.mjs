import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {dataHome} from './model.mjs';
const token=await readFile(path.join(dataHome,'access-token'),'utf8');
const response=await fetch(`http://127.0.0.1:${Number(process.env.BETTER_SEARCH_PORT||39471)}/api`,{
  method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({method:'search_status',params:{}}),signal:AbortSignal.timeout(5000)});
const body=await response.json();if(!response.ok)throw Error(body.error);console.log(JSON.stringify(body.result,null,2));
