import {access, mkdir, open, readFile, writeFile, unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pkg from '../package.json' with {type: 'json'};
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localData = process.env.LOCALAPPDATA || path.join(process.env.HOME || '', '.local/share');
export const dataHome = process.env.BETTER_SEARCH_HOME || path.join(localData, 'BetterSearch');
export const port = Number(process.env.BETTER_SEARCH_PORT || 39471);
export const baseUrl = `http://127.0.0.1:${port}`;
const tokenFile = path.join(dataHome, 'access-token');
export class ServiceError extends Error {constructor(public code: string, message: string) {super(message);}}
async function exists(p: string) {try {await access(p); return true;} catch {return false;}}
function requestSignal(timeout: number, signal?: AbortSignal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}
async function healthy(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const response = await fetch(`${baseUrl}/health`, {signal: requestSignal(1000, signal)}).catch(() => null);
  signal?.throwIfAborted();
  if (!response?.ok) return false;
  const body = await response.json().catch(() => null) as {service?: string; version?: string} | null;
  if (body?.service !== 'better-search') throw new ServiceError('PORT_IN_USE', `Port ${port} is used by another service. Set BETTER_SEARCH_PORT to an available port.`);
  if (body.version !== pkg.version) throw new ServiceError('VERSION_MISMATCH', `BetterSearch ${body.version || 'unknown'} is running; this plugin requires ${pkg.version}. Stop the old service and reopen the plugin.`);
  return true;
}
let pending: Promise<void> | undefined;
export async function ensureService(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!pending) pending = startService(signal).finally(() => {pending = undefined;});
  return pending;
}
async function startService(signal?: AbortSignal) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ServiceError('INVALID_PORT', 'BETTER_SEARCH_PORT must be between 1024 and 65535.');
  if (await healthy(signal)) return;
  await mkdir(dataHome, {recursive: true});
  try {await writeFile(tokenFile, randomBytes(32).toString('base64url'), {flag: 'wx', mode: 0o600});}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
  const lockPath = path.join(dataHome, 'service-start.lock');
  let ownsLock = false;
  for (let i = 0; i < 120; ++i) {
    signal?.throwIfAborted();
    try {await writeFile(lockPath, String(process.pid), {flag: 'wx'}); ownsLock = true; break;}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {const pid = Number(await readFile(lockPath, 'utf8')); process.kill(pid, 0);}
      catch (failure) {if ((failure as NodeJS.ErrnoException).code === 'ESRCH') await unlink(lockPath).catch(() => {});}
      if (await healthy(signal)) return;
      await delay(500, undefined, {signal});
    }
  }
  if (!ownsLock) throw new ServiceError('START_BUSY', 'Another BetterSearch client is still starting the local service.');
  try {
    if (await healthy(signal)) return;
    const candidates = [path.join(root, 'dist/native/better-search.exe'), path.join(root, 'build/cpu/Release/better-search.exe')];
    const exe = (await Promise.all(candidates.map(async p => await exists(p) ? p : null))).find(Boolean);
    if (!exe) throw new ServiceError('BINARY_MISSING', 'Native binary missing. Install a complete BetterSearch release, or run npm run setup && npm run build:native && npm run build.');
    const log = await open(path.join(dataHome, 'service.log'), 'a');
    const args = ['--data', dataHome, '--token-file', tokenFile, '--port', String(port)];
    if (process.env.BETTER_SEARCH_NO_WATCH === '1') args.push('--no-watch');
    if (signal?.aborted) {await log.close(); signal.throwIfAborted();}
    const child = spawn(exe, args, {detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd]});
    let spawnError: Error | undefined; child.on('error', error => {spawnError = error;}); child.unref(); await log.close();
    for (let i = 0; i < 120; ++i) {
      if (spawnError) throw spawnError;
      if (await healthy(signal)) return;
      if (child.exitCode !== null) break;
      await delay(500, undefined, {signal});
    }
    throw new ServiceError('START_FAILED', `Local service failed to start; see ${path.join(dataHome, 'service.log')}.`);
  } finally {await unlink(lockPath).catch(() => {});}
}
export async function call(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
  await ensureService(signal);
  signal?.throwIfAborted();
  const token = await readFile(tokenFile, 'utf8');
  const response = await fetch(`${baseUrl}/api`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
    body: JSON.stringify({method, params}), signal: requestSignal(180_000, signal)});
  const body = await response.json() as {result?: Record<string, unknown>; error?: string; code?: string};
  if (!response.ok || body.error) throw new ServiceError(body.code || 'REQUEST_FAILED', body.error || `HTTP ${response.status}`);
  return body.result || {};
}
