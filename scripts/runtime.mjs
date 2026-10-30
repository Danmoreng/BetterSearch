import {mkdir, readFile, writeFile, rename, copyFile, unlink, chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileHash} from './model-cache.mjs';
import {platformConfig} from './platform.mjs';

export const nodeVersion = 'v26.13.0';
// Pinned independently for each package; never substitute the developer's Node.
export const runtimeSpecs = {
  'windows-x64': {file: 'win-x64/node.exe', sha256: '14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5'},
  'linux-x64': {
    file: `node-${nodeVersion}-linux-x64.tar.xz`,
    archiveSha256: 'd28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997',
    sha256: '0adde40d1b7dfa57c8bc83cbc319758c3ec6ebba21363bb2fa752ea6b267ad1b',
  },
};
async function matches(file, sha256) {
  try {return await fileHash(file) === sha256;}
  catch (error) {if (error.code === 'ENOENT') return false; throw error;}
}
async function download(url, file, sha256) {
  if (await matches(file, sha256)) return;
  const response = await fetch(url, {signal: AbortSignal.timeout(5 * 60 * 1000)});
  if (!response.ok) throw Error(`Node.js download failed: HTTP ${response.status}`);
  const pending = file + '.part';
  try {
    await writeFile(pending, Buffer.from(await response.arrayBuffer()));
    if (await fileHash(pending) !== sha256) throw Error('Node.js checksum mismatch');
    await rename(pending, file);
  } finally {await unlink(pending).catch(() => {});}
}
export async function bundleRuntime(destination, target = platformConfig()) {
  const spec = runtimeSpecs[target.target];
  if (!spec) throw Error(`Unsupported Node runtime: ${target.target}`);
  const cache = path.resolve('.runtime', `node-${nodeVersion}-${target.target}`);
  await mkdir(cache, {recursive: true});
  const executable = path.join(cache, target.nodeName);
  const license = path.join(cache, 'LICENSE');
  if (target.windows) {
    await download(`https://nodejs.org/dist/${nodeVersion}/${spec.file}`, executable, spec.sha256);
    try {await readFile(license);}
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`);
      if (!response.ok) throw Error('Unable to obtain the pinned Node.js license');
      await writeFile(license, await response.text());
    }
  } else {
    let hasLicense = false;
    try {await readFile(license); hasLicense = true;} catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (!await matches(executable, spec.sha256) || !hasLicense) {
      const archive = path.join(cache, spec.file);
      await download(`https://nodejs.org/dist/${nodeVersion}/${spec.file}`, archive, spec.archiveSha256);
      execFileSync('cmake', ['-E', 'tar', 'xf', archive], {cwd: cache});
      const extracted = path.join(cache, `node-${nodeVersion}-linux-x64`);
      if (!await matches(path.join(extracted, 'bin/node'), spec.sha256)) throw Error('Extracted Node.js checksum mismatch');
      await copyFile(path.join(extracted, 'bin/node'), executable);
      await copyFile(path.join(extracted, 'LICENSE'), license);
    }
    await chmod(executable, 0o755);
  }
  await mkdir(destination, {recursive: true});
  const bundled = path.join(destination, target.nodeName);
  if (!await matches(bundled, spec.sha256)) await copyFile(executable, bundled);
  if (!target.windows) await chmod(bundled, 0o755);
  await copyFile(license, path.join(destination, 'NODE_LICENSE.txt'));
}
