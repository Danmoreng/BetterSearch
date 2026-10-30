import {mkdir, readFile, writeFile, rename, unlink, symlink, link} from 'node:fs/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable, Transform} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';

export function hubCache(env = process.env, userHome = homedir()) {
  return path.resolve(env.HF_HUB_CACHE || env.HUGGINGFACE_HUB_CACHE ||
    path.join(env.HF_HOME || path.join(env.XDG_CACHE_HOME || path.join(userHome, '.cache'), 'huggingface'), 'hub'));
}
export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function verified(file, sha256) {
  try { return await fileHash(file) === sha256; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Use the Hub's blobs/snapshots layout. Never change refs/main for a pinned revision.
export async function cachedModel({repository, revision, filename, sha256, cache = hubCache(), progress = async () => {}}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(revision) ||
      !/^[a-f0-9]{64}$/.test(sha256) || path.basename(filename) !== filename || !filename.endsWith('.gguf'))
    throw Error('Invalid model cache identity');
  const repo = `models--${repository.replace('/', '--')}`;
  const base = path.join(cache, repo), blob = path.join(base, 'blobs', sha256);
  const target = path.join(base, 'snapshots', revision, filename);
  if (await verified(target, sha256)) return target;
  const lock = path.join(cache, '.locks', repo, `better-search-${sha256}.lock`);
  await mkdir(path.dirname(lock), {recursive: true});
  const deadline = Date.now() + 31 * 60 * 1000;
  for (;;) {
    try { await writeFile(lock, String(process.pid), {flag: 'wx'}); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(await readFile(lock, 'utf8'));
        if (Number.isInteger(owner) && owner > 0) process.kill(owner, 0);
      }
      catch (failure) {
        if (failure.code === 'ESRCH') { await unlink(lock).catch(() => {}); continue; }
        if (failure.code === 'ENOENT') continue;
      }
      if (Date.now() > deadline) throw Error('Model cache installation is busy');
      await delay(200);
    }
  }
  const pending = blob + `.better-search-${randomUUID()}.incomplete`;
  let snapshotTemp;
  try {
    if (await verified(target, sha256)) return target;
    if (!await verified(blob, sha256)) {
      await mkdir(path.dirname(blob), {recursive: true});
      const response = await fetch(`https://huggingface.co/${repository}/resolve/${revision}/${filename}`,
        {signal: AbortSignal.timeout(30 * 60 * 1000)});
      if (!response.ok || !response.body) throw Error(`Model download failed: HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || null;
      let bytes = 0, last = 0;
      await progress({phase: 'downloading', bytes, total});
      const meter = new Transform({transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (Date.now() - last > 1000) {
          last = Date.now();
          progress({phase: 'downloading', bytes, total}).then(() => done(null, chunk), done);
        } else done(null, chunk);
      }});
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(pending, {flags: 'wx'}));
      await progress({phase: 'verifying', bytes, total});
      if (!await verified(pending, sha256)) throw Error('Model checksum mismatch; the downloaded file was not activated.');
      await rename(pending, blob);
    }
    await mkdir(path.dirname(target), {recursive: true});
    snapshotTemp = target + `.${randomUUID()}.tmp`;
    try { await symlink(path.relative(path.dirname(target), blob), snapshotTemp, 'file'); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      // Windows hard links share bytes without requiring Developer Mode or elevation.
      await link(blob, snapshotTemp);
    }
    await rename(snapshotTemp, target);
    return target;
  } finally {
    await unlink(pending).catch(() => {});
    if (snapshotTemp) await unlink(snapshotTemp).catch(() => {});
    await unlink(lock).catch(() => {});
  }
}
