import path from 'node:path';
import {hubCache} from '../../scripts/model-cache.mjs';
import {modelRepository, modelRevision, modelName} from '../../scripts/model.mjs';

export const testModelFile = process.env.BETTER_SEARCH_TEST_MODEL || path.join(hubCache(),
  `models--${modelRepository.replace('/', '--')}`, 'snapshots', modelRevision, modelName);
