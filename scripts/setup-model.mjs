import {ensureModel} from './model.mjs';
const index=process.argv.indexOf('--home');
await ensureModel(index<0?undefined:process.argv[index+1]);
