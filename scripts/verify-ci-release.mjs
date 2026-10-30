// CI has no desktop app. Verify the exact pinned host protocol on both runners.
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import {platformConfig} from './platform.mjs';
if(process.env.CI!=='true')throw Error('Use npm run verify:release with the installed desktop app outside CI.');
const target=platformConfig();
const require=createRequire(path.resolve('.runtime/ci-codex/package.json'));
const pkg=JSON.parse(await readFile(require.resolve('@openai/codex/package.json'),'utf8'));
assert.equal(pkg.version,'0.166.0-alpha.5.1');
const platformPackage=require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
const triple=target.windows?'x86_64-pc-windows-msvc':'x86_64-unknown-linux-musl';
const executable=path.join(path.dirname(platformPackage),'vendor',triple,'bin',target.windows?'codex.exe':'codex');
execFileSync(process.execPath,['scripts/verify-release.mjs'],{stdio:'inherit',env:{...process.env,BETTER_SEARCH_CI_HOST:'1',BETTER_SEARCH_CODEX_CLI:executable}});
