import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';
const bundle=await build({entryPoints:['src/i18n.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {setLocale,currentLocale,t,localize}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('all panel localization keys exist and unsupported locales fall back to English',async()=>{
 const {document}=parseHTML(await readFile('src/index.html','utf8'));
 const catalog=JSON.parse(await readFile('locales/en.json','utf8'));
 for(const element of document.querySelectorAll('*'))for(const attribute of element.attributes)
  if(attribute.name.startsWith('data-i18n'))assert.ok(catalog[attribute.value],attribute.value);
 setLocale('fr-FR');localize(document);
 assert.equal(currentLocale(),'fr-FR');assert.equal(document.querySelector('#query').getAttribute('placeholder'),'Search your chats…');
 assert.equal(t('projects.count',{count:12}),'12 chats');
 setLocale('not a locale');assert.equal(currentLocale(),'en');
});
