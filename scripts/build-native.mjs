import {execFileSync} from 'node:child_process';
import {platformConfig,buildProfile} from './platform.mjs';

const target = platformConfig();
const preset = process.argv.includes('--cuda') ? `${target.windows ? 'windows' : 'linux'}-cuda`
  : process.argv.includes('--gpu') ? 'windows-rtx5080' : target.preset;
buildProfile(preset);
const architecture = process.env.BETTER_SEARCH_CUDA_ARCHITECTURES;
execFileSync('cmake', ['--preset', preset, ...(architecture && preset.endsWith('-cuda') ? [`-DCMAKE_CUDA_ARCHITECTURES=${architecture}`] : [])], {stdio: 'inherit'});
execFileSync('cmake', ['--build', '--preset', preset, ...(target.windows ? ['--', '/verbosity:minimal'] : [])], {stdio: 'inherit'});
