import type { CrawlConfig, JobSource, RawJob } from '../types.js';
import { canonicalizeJobUrl } from '../job-id.js';

export function crawlJobKey(job: RawJob): string {
  const platformId = job.crawl_observation?.platformJobId?.trim();
  if (platformId) return `${job.source}|id:${platformId}`;
  const url = canonicalizeJobUrl(job.url);
  return `${job.source}|url:${url || `${job.company.trim().toLowerCase()}|${job.title.trim().toLowerCase()}|${job.location.trim().toLowerCase()}`}`;
}

export class AuthRequiredError extends Error {
  constructor(readonly platform: JobSource, message = `未找到或已失效的 ${platform} 登录状态，请先运行 npm run login`) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class RateLimitError extends Error {
  constructor(readonly platform: JobSource, message = `${platform} 请求过于频繁`) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class PageStructureError extends Error {
  constructor(readonly platform: JobSource, message: string) {
    super(message);
    this.name = 'PageStructureError';
  }
}

export interface CrawlProgress {
  keyword: string;
  city: string;
  page: number;
  completedPages: number;
  totalPages: number;
  found: number;
  ordinal: number;
  rawCount: number;
  jobs: RawJob[];
  duplicateJobs: RawJob[];
  uniqueCount: number;
  detailFailed: number;
}

export interface CrawlOptions {
  committedOrdinals?: Set<number>;
  seenJobKeys?: Set<string>;
  getStoredDetail?: (job: RawJob) => string | undefined;
  shouldStop?: () => boolean | Promise<boolean>;
}

export abstract class BaseCrawler {
  abstract readonly source: JobSource;
  constructor(protected readonly config: CrawlConfig) {}
  private storedDetailProvider?: (job: RawJob) => string | undefined;
  private crawlSeenJobKeys = new Set<string>();

  protected abstract ensureReady(): Promise<void>;
  protected abstract searchPage(keyword: string, page: number, city: string): Promise<RawJob[]>;
  abstract loginInteractive(timeoutMs?: number): Promise<boolean>;

  async crawl(
    keywords: string[],
    onProgress?: (progress: CrawlProgress) => void | Promise<void>,
    options: CrawlOptions = {},
  ): Promise<RawJob[]> {
    await this.ensureReady();
    this.storedDetailProvider = options.getStoredDetail;
    this.crawlSeenJobKeys = new Set(options.seenJobKeys ?? []);
    const results: RawJob[] = [];
    const totalPages = keywords.length * this.config.cities.length * this.config.pages;
    let completedPages = 0;
    let ordinal = 0;
    crawlLoop: for (const keyword of keywords) {
      for (const city of this.config.cities) {
        for (let page = 1; page <= this.config.pages; page++) {
          if (await options.shouldStop?.()) break crawlLoop;
          ordinal++;
          if (options.committedOrdinals?.has(ordinal)) {
            completedPages++;
            continue;
          }
          const raw = await this.searchPageWithRetry(keyword, page, city);
          const duplicateJobs: RawJob[] = [];
          const jobs = raw.filter((job, rank) => {
            job.crawl_observation = {
              ...job.crawl_observation, keyword, city, page, rank: rank + 1,
              detailStatus: job.crawl_observation?.detailStatus ?? (job.jd_fulltext.trim().length >= 80 ? 'full' : 'missing'),
            };
            const key = crawlJobKey(job);
            if (job.crawl_observation.duplicateHint || this.crawlSeenJobKeys.has(key)) {
              duplicateJobs.push(job);
              return false;
            }
            this.crawlSeenJobKeys.add(key);
            return true;
          });
          results.push(...jobs);
          completedPages++;
          await onProgress?.({ keyword, city, page, completedPages, totalPages, found: results.length, ordinal,
            rawCount: raw.length, jobs, duplicateJobs,
            uniqueCount: jobs.length, detailFailed: jobs.filter((job) => ['missing', 'list_fallback'].includes(job.crawl_observation?.detailStatus ?? '')).length });
          if (await options.shouldStop?.()) break crawlLoop;
          if (this.source === 'boss' && page >= 2 && jobs.length < this.config.adaptiveMinUnique) break;
          if (completedPages < totalPages) await this.randomDelay();
        }
      }
    }
    return results;
  }

  protected reusableStoredDetail(job: RawJob): string | undefined {
    const value = this.storedDetailProvider?.(job)?.trim();
    return value && value.replace(/\s+/g, '').length >= 80 ? value : undefined;
  }

  protected isKnownJob(job: RawJob): boolean {
    return this.crawlSeenJobKeys.has(crawlJobKey(job));
  }

  private async searchPageWithRetry(keyword: string, page: number, city: string): Promise<RawJob[]> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.searchPage(keyword, page, city);
      } catch (error) {
        if (!(error instanceof RateLimitError) || attempt === 3) throw error;
        const backoff = 5_000 * 2 ** (attempt - 1);
        console.warn(`[${this.source}] 限流，${backoff / 1000}s 后重试 (${attempt}/3)`);
        await this.sleep(backoff);
      }
    }
    return [];
  }

  protected async randomDelay(): Promise<void> {
    const delay = this.config.delayMinMs + Math.random() * (this.config.delayMaxMs - this.config.delayMinMs);
    await this.sleep(delay);
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  async close(): Promise<void> {
    // Chrome 由用户控制并复用，不在任务结束时关闭。
  }
}
