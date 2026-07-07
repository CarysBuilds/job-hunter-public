import { createCrawler, getCrawlConfig } from '../crawlers/index.js';
import type { JobSource } from '../types.js';

const SOURCES = ['boss', 'liepin', 'zhaopin'] as const;

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readSource(): JobSource {
  const source = readArg('--source') ?? 'boss';
  if (!SOURCES.includes(source as JobSource)) throw new Error('source 仅支持 boss、liepin、zhaopin');
  return source as JobSource;
}

async function main(): Promise<void> {
  const source = readSource();
  const crawler = createCrawler(source, { ...getCrawlConfig(), headless: false });
  try {
    const success = await crawler.loginInteractive();
    if (!success) throw new Error('登录等待超时，请重新运行 npm run login');
  } finally {
    await crawler.close();
  }
}

main().catch((error) => {
  console.error(`[login] ${(error as Error).message}`);
  process.exitCode = 1;
});
