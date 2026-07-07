import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunService } from '../services/run-service.js';
import { getStore } from '../server/store.js';

function readRunId(argv: string[]): string {
  const index = argv.indexOf('--run-id');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error('缺少 --run-id');
  return value;
}

async function main(): Promise<void> {
  const runId = readRunId(process.argv);
  const store = getStore();
  try {
    console.log(`[worker] 开始执行抓取任务：${runId}`);
    const run = await new RunService(store, { crawlExecution: 'inline' }).runExistingCrawl(runId);
    console.log(`[worker] 任务结束：${run.status}；${run.message}`);
  } finally {
    store.close();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[worker:fatal] ${(error as Error).stack || (error as Error).message}`);
    process.exitCode = 1;
  });
}
