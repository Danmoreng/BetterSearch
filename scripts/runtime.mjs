import {mkdir, readFile, writeFile, rename, copyFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileHash} from './model-cache.mjs';

export const nodeVersion = 'v26.13.0';
const nodeHash = '14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5';

// Release inputs are pinned independently of the developer's installed Node.js.
export async function bundleRuntime(destination) {
  const cache = path.resolve('.runtime', `node-${nodeVersion}-win-x64`);
  await mkdir(cache, {recursive: true});
  const executable = path.join(cache, 'node.exe');
  let valid = false;
  try { valid = await fileHash(executable) === nodeHash; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!valid) {
    const response = await fetch(`https://nodejs.org/dist/${nodeVersion}/win-x64/node.exe`, {signal: AbortSignal.timeout(5 * 60 * 1000)});
    if (!response.ok) throw Error(`Node.js download failed: HTTP ${response.status}`);
    const pending = executable + '.part';
    try {
      await writeFile(pending, Buffer.from(await response.arrayBuffer()));
      if (await fileHash(pending) !== nodeHash) throw Error('Node.js checksum mismatch');
      await rename(pending, executable);
    } finally { await unlink(pending).catch(() => {}); }
  }
  const license = path.join(cache, 'LICENSE');
  try { await readFile(license); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`);
    if (!response.ok) throw Error('Unable to obtain the pinned Node.js license');
    await writeFile(license, await response.text());
  }
  await mkdir(destination, {recursive: true});
  const bundled = path.join(destination, 'node.exe');
  let matches = false;
  try { matches = await fileHash(bundled) === nodeHash; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!matches) await copyFile(executable, bundled);
  await copyFile(license, path.join(destination, 'NODE_LICENSE.txt'));
}
