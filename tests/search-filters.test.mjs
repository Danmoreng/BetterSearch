import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({entryPoints:['src/search-filters.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {dateFilters}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('calendar ranges include the full local final day and freeze relative presets',()=>{
  const now=new Date(2026,9,29,18,15);
  const result=dateFilters({preset:'7',from:'',through:''},now);
  assert.deepEqual(result.selection,{preset:'7',from:'2026-10-23',through:'2026-10-29'});
  assert.deepEqual(result.filters,{updated_after:new Date(2026,9,23).toISOString(),updated_before:new Date(2026,9,30).toISOString()});
  const sameDay=dateFilters({preset:'custom',from:'2026-03-29',through:'2026-03-29'});
  assert.equal(sameDay.filters.updated_after,new Date(2026,2,29).toISOString());
  assert.equal(sameDay.filters.updated_before,new Date(2026,2,30).toISOString());
  assert.deepEqual(dateFilters({preset:'custom',from:'',through:'2026-10-29'}).filters,{updated_before:new Date(2026,9,30).toISOString()});
});

test('invalid ranges cannot silently become a broader search',()=>{
  for(const selection of [
    {preset:'custom',from:'2026-02-29',through:''},
    {preset:'custom',from:'2026-10-30',through:'2026-10-29'},
    {preset:'custom',from:'',through:''},
    {preset:'custom',from:'2026-13-01',through:''},
  ])assert.throws(()=>dateFilters(selection),/INVALID_DATES/);
  assert.deepEqual(dateFilters({preset:'any',from:'2026-01-01',through:'2026-10-29'}).filters,{});
});
