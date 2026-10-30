import {nativeBinary} from './helpers/platform.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {spawn, execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import path from 'node:path';

test('quoted search phrases and calendar filters constrain chats before ranking', async t => {
  const fixture = await mkdtemp(path.resolve('.runtime/search-filters-'));
  const source = path.join(fixture, 'source'), home = path.join(fixture, 'data');
  await mkdir(source); await mkdir(home);
  const state = new DatabaseSync(path.join(source, 'state_5.sqlite'));
  const history = new DatabaseSync(path.join(source, 'thread_history_1.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at TEXT,updated_at TEXT,archived INTEGER,project_id TEXT); CREATE TABLE projects(id TEXT,name TEXT)');
  history.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_type TEXT,item_json TEXT)');
  state.prepare('INSERT INTO projects VALUES(?,?)').run('fixture', 'Filter fixtures');
  const records = [
    ['across', '2026-10-01T00:00:00Z', ['needle alpha', 'pink elephant beta'], ''],
    ['title-only', '2026-10-01T12:00:00Z', ['needle ordinary content'], ' alpha pink elephant'],
    ['metadata-only', 'unknown', [], ' alpha pink elephant'],
    ['separated', '2026-10-01T18:00:00Z', ['needle pink unusual elephant alpha beta'], ''],
    ['seconds', String(Date.parse('2026-10-02T00:00:00Z') / 1000), ['needle alpha beta'], ''],
    ['milliseconds', String(Date.parse('2026-10-02T23:59:59.999Z')), ['needle alpha beta'], ''],
    ['after', '2026-10-03T00:00:00Z', ['needle alpha beta'], ''],
    ['offset', '2026-10-03T01:00:00+02:00', ['needle alpha beta'], ''],
    ['invalid', 'unknown', ['needle alpha beta'], ''],
    ['null', null, ['needle alpha beta'], ''],
  ];
  for (const [id, updated, messages, titleSuffix] of records) {
    state.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id, `filterfixture ${id}${titleSuffix}`, 'C:/synthetic/filters', '2026-09-01', updated, 0, 'fixture');
    messages.forEach((text, ordinal) => history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(
      id, 'turn', `${id}-${ordinal}`, ordinal, 100, 'userMessage',
      JSON.stringify({type: 'userMessage', content: [{type: 'text', text}]})));
  }
  state.close(); history.close();
  await writeFile(path.join(home, 'config.json'), JSON.stringify({model: 'google/embeddinggemma-2', model_file: 'missing-test-model.gguf', dimensions: 768,
    model_sha256: '68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216',
    sources: [{id: 'fixture', kind: 'local', label: 'Fixture', codex_home: source}]}));
  const exe = nativeBinary;
  execFileSync(exe, ['--data', home, '--index-only'], {encoding: 'utf8'});
  const token = randomBytes(32).toString('hex'), tokenFile = path.join(home, 'access-token');
  await writeFile(tokenFile, token);
  const port = 39581;
  const child = spawn(exe, ['--data', home, '--token-file', tokenFile, '--port', String(port), '--no-watch'], {stdio: 'ignore', windowsHide: true});
  const call = async params => {
    const response = await fetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      body: JSON.stringify({method: 'search_chats', params: {query: 'filterfixture', mode: 'keyword', ...params}}),
    });
    return response.json();
  };
  const keys = async params => {
    const response = await call(params);
    assert.ok(response.result, JSON.stringify(response));
    return response.result.results.map(hit => hit.key).sort();
  };
  try {
    let ready = false;
    for (let i = 0; i < 60; ++i) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Synthetic service starts');
    await t.test('quoted phrases match original messages or titles and all phrases are required', async () => {
      assert.deepEqual(await keys({query: '"pink elephant"'}), ['fixture:across', 'fixture:metadata-only', 'fixture:title-only']);
      assert.deepEqual(await keys({query: 'needle "pink elephant"'}), ['fixture:across', 'fixture:metadata-only', 'fixture:title-only']);
      assert.deepEqual(await keys({query: '"needle alpha" "pink elephant"'}), ['fixture:across'], 'Separate phrases may occur in different messages');
      assert.deepEqual(await keys({query: 'filterfixture "pink elephant" "beta"'}), ['fixture:across']);
      assert.deepEqual(await keys({query: '"pink elephant" "missingword"'}), []);
      assert.deepEqual(await keys({query: '"alph"'}), [], 'Quoted terms do not use prefix matching');
      assert.deepEqual(await keys({query: '"alpha OR absent"'}), [], 'Quoted FTS operators remain literal words');
      assert.deepEqual(await keys({query: '"synthetic filters"'}), [], 'Synthetic path text cannot satisfy a quoted phrase');
      assert.deepEqual(await keys({query: '"Filter fixtures"'}), [], 'A project name cannot satisfy a quoted phrase');
      assert.ok((await keys({query: 'alpha missingword'})).includes('fixture:across'), 'Unquoted terms retain existing OR retrieval');
    });
    await t.test('includes both date endpoints across ISO, second and millisecond storage', async () => {
      assert.deepEqual(await keys({updated_after: '2026-10-02', updated_before: '2026-10-02'}),
        ['fixture:milliseconds', 'fixture:offset', 'fixture:seconds']);
      assert.deepEqual(await keys({query: '"pink elephant" "beta"', updated_after: '2026-10-01', updated_before: '2026-10-01'}), ['fixture:across']);
      assert.deepEqual(await keys({updated_after: '2026-10-03'}), ['fixture:after']);
    });
    await t.test('accepts precise exclusive timestamp bounds for local calendar days', async () => {
      // Europe/Berlin's October 2 is October 1 22:00Z through October 2 22:00Z.
      assert.deepEqual(await keys({updated_after: '2026-10-01T22:00:00.000Z', updated_before: '2026-10-02T22:00:00.000Z'}), ['fixture:seconds']);
      assert.deepEqual(await keys({updated_after: '2026-10-02T23:59:59.999Z', updated_before: '2026-10-03T00:00:00.000Z'}), ['fixture:milliseconds']);
      assert.deepEqual(await keys({updated_before: '2026-10-01T00:00:00.000Z'}), []);
    });
    await t.test('invalid constraints fail rather than broadening results', async () => {
      for (const params of [
        {updated_after: '2026-02-30'}, {updated_after: '2026-10-03', updated_before: '2026-10-01'},
        {updated_after: '2026-10-03', updated_before: '2026-10-02'},
        {updated_after: '2026-10-01T25:00:00Z'}, {updated_before: 12},
      ]) assert.equal((await call(params)).code, 'SEARCH_FILTER_INVALID', JSON.stringify(params));
      for (const query of ['"unfinished', 'filterfixture "unfinished', '""', '"***"'])
        assert.equal((await call({query})).code, 'SEARCH_QUERY_INVALID', query);
      assert.deepEqual(await keys({query: ' ', updated_after: '2026-10-01'}), [], 'Filters never make an empty query browse chats');
    });
    await t.test('pagination identity includes every filter and survives cancellation', async () => {
      const params = {query: '"alpha" "beta"', updated_after: '2026-10-01', presentation: 'palette-v1', session_id: 'filter-pagination', request_id: 1, limit: 2};
      const first = (await call(params)).result;
      assert.equal(first.results.length, 2); assert.ok(first.has_more);
      const next = {...params, snapshot_id: first.snapshot_id, offset: 2};
      for (const change of [{query: '"alpha"'}, {updated_after: '2026-10-02'}, {updated_before: '2026-10-02'}])
        assert.equal((await call({...next, ...change})).code, 'SEARCH_SNAPSHOT_EXPIRED');
      await call({session_id: params.session_id, request_id: 2, cancel: true});
      const second = (await call({...next, request_id: 3})).result;
      assert.equal(second.results.length, 2);
      assert.equal(new Set([...first.results, ...second.results].map(hit => hit.key)).size, 4);
    });
  } finally {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  }
});
