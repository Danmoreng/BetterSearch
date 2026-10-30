import {nativeBinary} from './helpers/platform.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {hubCache} from '../scripts/model-cache.mjs';
import {modelName, modelRevision, modelRepository} from '../scripts/model.mjs';

test('a fresh profile creates the current index and uses the central model cache', async () => {
  const home = await mkdtemp(path.resolve('.runtime/fresh install '));
  const cache = path.join(home, 'shared hub');
  const env = {...process.env, HF_HUB_CACHE: cache};
  const exe = nativeBinary;
  execFileSync(exe, ['--data', home, '--status'], {env});
  const config = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config.model_file, path.join(hubCache(env), `models--${modelRepository.replace('/', '--')}`,
    'snapshots', modelRevision, modelName));
  const db = new DatabaseSync(path.join(home, 'search.sqlite'), {readOnly: true});
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM chunks').get().n, 0);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='initial_embedding_complete'").get().value,'0');
  db.close();
  const before = JSON.parse(execFileSync(exe, ['--index-check', '--database', path.join(home, 'search.sqlite')], {env}));
  execFileSync(exe, ['--data', home, '--status'], {env});
  assert.deepEqual(JSON.parse(execFileSync(exe, ['--index-check', '--database', path.join(home, 'search.sqlite')], {env})), before);
});

test('an unsupported index is rejected without converting it', async () => {
  const home = await mkdtemp(path.resolve('.runtime/unsupported index '));
  await mkdir(path.join(home, 'source'));
  await writeFile(path.join(home, 'config.json'), JSON.stringify({model:'google/embeddinggemma-2',
    model_file:'missing.gguf', model_sha256:'synthetic', dimensions:768, sources:[]}));
  const db = new DatabaseSync(path.join(home, 'search.sqlite'));
  db.exec('PRAGMA user_version=99; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES(\'unchanged\')');
  db.close();
  assert.throws(() => execFileSync(nativeBinary, ['--data', home, '--status'], {stdio:'pipe'}),
    error => error.stderr.toString().includes('Unsupported index schema'));
  const check = new DatabaseSync(path.join(home, 'search.sqlite'), {readOnly:true});
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99);
  assert.equal(check.prepare('SELECT value FROM sentinel').get().value, 'unchanged');
  check.close();
});
