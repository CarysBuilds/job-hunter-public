import type { CrawlConfig, JobSource, RawJob } from '../types.js';

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
}

export abstract class BaseCrawler {
  abstract readonly source: JobSource;
  constructor(protected readonly config: CrawlConfig) {}

  protected abstract ensureReady(): Promise<void>;
  protected abstract searchPage(keyword: string, page: number, city: string): Promise<RawJob[]>;
  abstract loginInteractive(timeoutMs?: number): Promise<boolean>;

  async crawl(
    keywords: string[],
    onProgress?: (progress: CrawlProgress) => void | Promise<void>
  ): Promise<RawJob[]> {
    await this.ensureReady();
    const results: RawJob[] = [];
    const totalPages = keywords.length * this.config.cities.length * this.config.pages;
    let completedPages = 0;
    for (const keyword of keywords) {
      for (const city of this.config.cities) {
        for (let page = 1; page <= this.config.pages; page++) {
          const jobs = await this.searchPageWithRetry(keyword, page, city);
          results.push(...jobs);
          completedPages++;
          await onProgress?.({ keyword, city, page, completedPages, totalPages, found: results.length });
          if (completedPages < totalPages) await this.randomDelay();
        }
      }
    }
    return results;
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
