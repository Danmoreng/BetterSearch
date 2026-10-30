import path from 'node:path';
import {homedir} from 'node:os';

export function platformConfig(platform = process.platform, arch = process.arch) {
  if (!['win32', 'linux'].includes(platform) || arch !== 'x64')
    throw Error(`Unsupported target: ${platform}-${arch}. BetterSearch packages support Windows x64 and Linux x64.`);
  const windows = platform === 'win32';
  return {
    platform, arch, windows, target: `${windows ? 'windows' : 'linux'}-${arch}`,
    preset: windows ? 'windows-cpu' : 'linux-cpu',
    nativeName: windows ? 'better-search.exe' : 'better-search',
    nodeName: windows ? 'node.exe' : 'node',
    nativeBuild: windows ? 'build/cpu/Release/better-search.exe' : 'build/linux-cpu/better-search',
  };
}

export function dataDirectory(env = process.env, platform = process.platform, userHome = homedir()) {
  return env.BETTER_SEARCH_HOME || path.join(platform === 'win32'
    ? env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local')
    : env.XDG_DATA_HOME || path.join(env.HOME || userHome, '.local', 'share'), 'BetterSearch');
}

export function mcpTransport(platform = process.platform, arch = process.arch) {
  const target = platformConfig(platform, arch);
  return target.windows
    ? {command: 'cmd.exe', args: ['/d', '/s', '/c', '.\\dist\\runtime\\node.exe', '.\\dist\\mcp.js'], cwd: './'}
    : {command: './dist/runtime/node', args: ['./dist/mcp.js'], cwd: './'};
}

export function buildProfile(preset, platform = process.platform, arch = process.arch) {
  const target = platformConfig(platform, arch);
  if (preset === target.preset) return {preset, binary: target.nativeBuild, accelerator: 'cpu'};
  if (preset === `${target.windows ? 'windows' : 'linux'}-cuda`)
    return {preset, binary: target.windows ? 'build/cuda/Release/better-search.exe' : 'build/linux-cuda/better-search', accelerator: 'cuda'};
  if (target.windows && preset === 'windows-rtx5080')
    return {preset, binary: 'build/rtx5080/Release/better-search.exe', accelerator: 'cuda'};
  throw Error(`Unsupported build preset for ${target.target}: ${preset}`);
}
