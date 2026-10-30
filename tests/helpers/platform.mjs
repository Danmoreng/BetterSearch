import path from 'node:path';
import {platformConfig} from '../../scripts/platform.mjs';
export const nativeBinary = path.resolve(process.env.BETTER_SEARCH_TEST_ROOT || '.', 'dist/native', platformConfig().nativeName);
