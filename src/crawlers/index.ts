import { getCrawlConfig } from '../config.js';
import { createContentFingerprint } from '../job-id.js';
import type { CrawlConfig, JobSource, RawJob } from '../types.js';
import { BossCrawler } from './boss.js';
import { LiepinCrawler } from './liepin.js';
import { ZhaopinCrawler } from './zhaopin.js';

export { getCrawlConfig } from '../config.js';
export { AuthRequiredError, PageStructureError, RateLimitError } from './base.js';

export function createCrawler(source: JobSource, config: CrawlConfig = getCrawlConfig()) {
  if (source === 'boss') return new BossCrawler(config);
  if (source === 'liepin') return new LiepinCrawler(config);
  if (source === 'zhaopin') return new ZhaopinCrawler(config);
  throw new Error(`未知岗位来源：${source}`);
}

export function dedupeJobs(jobs: RawJob[]): RawJob[] {
  const unique = new Map<string, RawJob>();
  for (const job of jobs) unique.set(createContentFingerprint(job), job);
  return [...unique.values()];
}
