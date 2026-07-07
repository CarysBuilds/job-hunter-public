import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.APP_DATA_DIR) {
  process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'job-hunter-test-data-'));
}

process.env.LLM_ENABLED ??= 'false';
process.env.LLM_API_KEY ??= 'env-key-should-not-leak';
