import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BaseCrawler, PageStructureError } from '../src/crawlers/base.js';
import { RunService } from '../src/services/run-service.js';
import { JobStore } from '../src/server/store.js';
import type { CrawlConfig, RawJob } from '../src/types.js';

class FixtureCrawler extends BaseCrawler {
  readonly source = 'boss' as const;
  readonly fetched: number[] = [];

  constructor(config: CrawlConfig, private readonly failAtPage?: number) { super(config); }
  protected async ensureReady(): Promise<void> {}
  async loginInteractive(): Promise<boolean> { return true; }
  protected async searchPage(_keyword: string, page: number, city: string): Promise<RawJob[]> {
    this.fetched.push(page);
    if (page === this.failAtPage) throw new PageStructureError('boss', 'fixture 页面漂移');
    return [{
      title: `AI 产品经理 P${page}`, company: '匿名科技', salary: '20-30K', location: city,
      source: 'boss', url: `https://www.zhipin.com/job_detail/fixture-${page}.html`,
      jd_fulltext: '负责 AI 产品规划、需求分析、客户访谈、项目交付、上线运营和复盘。'.repeat(5),
      experience: '3-5年', education: '本科',
      crawl_observation: { platformJobId: `fixture-${page}`, detailStatus: 'full' },
    }];
  }
  protected override async randomDelay(): Promise<void> {}
}

describe('抓取 worker 页级 E2E', () => {
  it('失败后只重试未提交页，并保留页统计、岗位处置与来源健康', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-hunter-worker-'));
    const store = new JobStore(join(directory, 'worker.sqlite'));
    let firstCrawler: FixtureCrawler | undefined;
    const firstService = new RunService(store, {
      crawlExecution: 'inline', useLlm: false,
      crawlerFactory: (_source, config) => (firstCrawler = new FixtureCrawler(config, 2)),
    });
    const failed = await firstService.runCrawlNow({ source: 'boss', keywords: ['AI'], pages: 2 });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCategory, 'page_structure');
    assert.deepEqual(firstCrawler?.fetched, [1, 2]);
    assert.equal(store.listRunPages(failed.id).filter((page) => page.status === 'committed').length, 1);
    assert.equal(store.countJobs('all'), 1);

    store.updateRun(failed.id, { status: 'queued', error: undefined, finishedAt: undefined });
    let retryCrawler: FixtureCrawler | undefined;
    const retryService = new RunService(store, {
      crawlExecution: 'inline', useLlm: false,
      crawlerFactory: (_source, config) => (retryCrawler = new FixtureCrawler(config)),
    });
    const completed = await retryService.runExistingCrawl(failed.id);
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(retryCrawler?.fetched, [2]);
    assert.equal(store.listRunPages(failed.id).filter((page) => page.status === 'committed').length, 2);
    assert.equal(store.listRunObservations(failed.id).filter((item) => item.disposition === 'saved').length, 2);
    assert.equal(store.countJobs('all'), 2);
    assert.equal(store.listSourceHealth().find((item) => item.source === 'boss')?.status, 'healthy');
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
