import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {dataDirectory} from './platform.mjs';
import {cachedModel} from './model-cache.mjs';
export const modelName='embeddinggemma-2-BF16.gguf';
export const modelHash='68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216';
export const modelRevision='58faf90940886df2d62be555c8765d00dac362c5';
export const modelRepository='ggml-org/embeddinggemma-2-GGUF';
export const dataHome=dataDirectory();
export async function ensureModel(home=dataHome){
  await mkdir(home,{recursive:true});
  const lock=path.join(home,'model-setup.lock');
  try{await writeFile(lock,String(process.pid),{flag:'wx'});}catch(error){
    if(error.code!=='EEXIST')throw error;
    let running=true;try{const owner=Number(await readFile(lock,'utf8'));if(Number.isInteger(owner)&&owner>0)process.kill(owner,0);}catch(e){if(e.code==='ESRCH')running=false;}
    if(running)throw Error('Model installation is already running.');
    await unlink(lock);return ensureModel(home);
  }
  const progress=path.join(home,'model-setup.json');
  async function update(value){await writeFile(progress+'.tmp',JSON.stringify(value));await rename(progress+'.tmp',progress);}
  try{
    await update({phase:'checking'});
    const target=await cachedModel({repository:modelRepository,revision:modelRevision,filename:modelName,sha256:modelHash,progress:update});
    await update({phase:'ready',model_file:target});
    console.log('Verified EmbeddingGemma 2 in the Hugging Face cache.');
    return target;
  }catch(error){await update({phase:'error',code:'MODEL_SETUP_FAILED'});throw error;}
  finally{await unlink(lock).catch(()=>{});}
}
