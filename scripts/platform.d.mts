export function platformConfig(platform?: NodeJS.Platform, arch?: string): {
  platform: NodeJS.Platform; arch: string; windows: boolean; target: string;
  preset: string; nativeName: string; nodeName: string; nativeBuild: string;
};
export function dataDirectory(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, userHome?: string): string;
export function mcpTransport(platform?: NodeJS.Platform, arch?: string): {command: string; args: string[]; cwd: string};
export function buildProfile(preset: string, platform?: NodeJS.Platform, arch?: string): {preset: string; binary: string; accelerator: string};
