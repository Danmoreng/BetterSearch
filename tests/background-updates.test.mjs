import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {once} from 'node:events';
import path from 'node:path';

const root = process.env.BETTER_SEARCH_TEST_ROOT || process.cwd();
const exe = path.join(root, 'dist/native/better-search.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('native background schedule respects fifteen minutes, busy jobs and queued manual work', () => {
  assert.match(execFileSync(exe, ['--self-test'], {encoding: 'utf8'}), /native self-test passed/);
});

test('background work ignores disabled backlog and manual refresh works without automatic updates', async t => {
  const fixture = await mkdtemp(path.resolve('.runtime/background fixture '));
  const home = path.join(fixture, 'data');
  await mkdir(path.join(home, 'models'), {recursive: true});
  const sources = [];
  for (const id of ['primary', 'excluded']) {
    const folder = path.join(fixture, id);
    await mkdir(folder);
    const db = new DatabaseSync(path.join(folder, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER)');
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run('initial', `Synthetic ${id} passage`, 'C:/Synthetic', 100, 200, 0);
    db.close();
    sources.push({id, label: id, kind: 'local', codex_home: folder});
  }
  // A tiny invalid local model makes a real embedding attempt fail deterministically,
  // without downloading weights or consuming inference resources.
  await writeFile(path.join(home, 'models/broken.gguf'), 'synthetic-invalid-model');
  await writeFile(path.join(home, 'config.json'), JSON.stringify({version: 1,
    model: 'google/embeddinggemma-2', model_file: path.join(home, 'models/broken.gguf'), dimensions: 768,
    model_sha256: '68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216', sources}));
  execFileSync(exe, ['--data', home, '--index-only'], {stdio: 'pipe'});
  await writeFile(path.join(home, 'preferences.json'), JSON.stringify({automatic_updates: false, disabled_sources: ['primary', 'excluded']}));
  const token = 'synthetic-background-token-with-32-characters';
  const tokenFile = path.join(home, 'access-token');
  await writeFile(tokenFile, token);
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(exe, ['--data', home, '--token-file', tokenFile, '--port', String(port)],
    {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  async function api(method, params = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify({method, params})});
    const body = await response.json();
    if (!response.ok) throw Error(body.code);
    return body.result;
  }
  async function until(predicate, description) {
    for (let attempt = 0; attempt < 150; ++attempt) {
      if (child.exitCode !== null) throw Error(`Fixture exited: ${stderr}`);
      if (await predicate()) return;
      await delay(40);
    }
    assert.fail(description);
  }
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    await api('shutdown');
    await exited;
  });
  await until(() => fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false), 'Fixture did not start');
  assert.equal((await api('search_status')).chunks, 2);
  assert.deepEqual(await api('manage_index', {action: 'resume'}), {started: false, reason: 'no_work'});
  assert.equal((await api('search_status')).progress.phase, 'idle');

  function addPrimary(id) {
    const db = new DatabaseSync(path.join(fixture, 'primary/state_5.sqlite'));
    db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run(id, `Synthetic ${id} passage`, 'C:/Synthetic', 100, 200, 0);
    db.close();
  }
  async function waitForAttempt(total) {
    await until(async () => {
      const status = await api('search_status');
      return !status.indexing && !status.embedding && status.progress.phase === 'embedding_error' && status.progress.total === total;
    }, `Expected one embedding attempt for ${total} enabled passages`);
  }
  addPrimary('second');
  await api('settings_action', {action: 'source_enabled', id: 'primary', enabled: true});
  await waitForAttempt(2);
  assert.equal((await api('search_status')).chunks, 3);
  await delay(100);
  const failedLog = stderr;
  await delay(2200);
  assert.equal(stderr, failedLog, 'An idle watcher must not retry a failed model');

  addPrimary('third');
  await api('settings_action', {action: 'refresh'});
  await waitForAttempt(3);
  assert.equal((await api('read_settings')).preferences.automatic_updates, false);

  await api('update_settings', {paused: true});
  addPrimary('fourth');
  await assert.rejects(api('settings_action', {action: 'refresh'}), /INDEX_PAUSED/);
  assert.equal((await api('search_status')).threads, 4);
  await api('update_settings', {paused: false});
  await waitForAttempt(4);
  assert.equal((await api('search_status')).threads, 5);

  await api('update_settings', {automatic_updates: true});
  const lastSync = (await api('read_settings')).sources.find(source => source.id === 'primary').last_sync;
  await delay(2200);
  const stable = await api('read_settings');
  assert.equal(stable.sources.find(source => source.id === 'primary').last_sync, lastSync);
  assert.equal(stable.status.progress.phase, 'embedding_error');
});
