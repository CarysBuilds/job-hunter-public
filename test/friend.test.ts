import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { KeywordsSchema, splitKeywords } from '../src/keywords.js';
import { getCrawlConfig, getEffectiveLlmConfig, loadUserSettings, saveUserSettings } from '../src/config.js';
import { BaseCrawler } from '../src/crawlers/base.js';
import { JobStore } from '../src/server/store.js';
import { scoreJob } from '../src/scorer/index.js';
import { TemplateGreetingBatch, TemplateGreetingService, bossJobUrl } from '../src/services/template-greeting-service.js';
import type { GreetingSender } from '../src/services/boss-greeting-sender.js';
import type { Grade, RawJob, ScoredJob } from '../src/types.js';

describe('独立关键词搜索', () => {
  it('中英文逗号、顿号、分号和换行分别拆分，去重并保留标题中的空格', () => {
    assert.deepEqual(splitKeywords('产品经理，产品运营,用户运营\nJava 开发；产品经理、设计师'), ['产品经理', '产品运营', '用户运营', 'Java 开发', '设计师']);
    assert.deepEqual(KeywordsSchema.parse(['产品经理，产品运营', '产品经理']), ['产品经理', '产品运营']);
    assert.throws(() => KeywordsSchema.parse('，,\n'));
    assert.throws(() => KeywordsSchema.parse(Array.from({ length: 21 }, (_, i) => `岗位${i}`)));
  });

  it('保存、重新读取和爬虫都使用独立关键词', async () => {
    saveUserSettings({ keywords: ['产品经理，产品运营', 'Java 开发'] });
    assert.deepEqual(loadUserSettings().keywords, ['产品经理', '产品运营', 'Java 开发']);
    const searches: string[] = [];
    class FixtureCrawler extends BaseCrawler {
      readonly source = 'boss' as const;
      async ensureReady() {}
      async loginInteractive() { return true; }
      async searchPage(keyword: string): Promise<RawJob[]> { searches.push(keyword); return []; }
    }
    const crawler = new FixtureCrawler(getCrawlConfig({ cities: ['北京'], pages: 1, delayMinMs: 0, delayMaxMs: 0 }));
    await crawler.crawl(['产品经理，产品运营', 'Java 开发']);
    assert.deepEqual(searches, ['产品经理', '产品运营', 'Java 开发']);
  });
});

describe('自填模板批量发送', () => {
  let directory: string;
  let store: JobStore;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'friend-test-')); store = new JobStore(join(directory, 'jobs.sqlite')); });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  async function add(id: string, grade: Grade = 'A', source: 'boss' | 'liepin' = 'boss'): Promise<ScoredJob> {
    const job = await scoreJob({ title: `产品经理${id}`, company: `示例公司${id}`, salary: '15-25K', location: '北京',
      source, url: `https://www.zhipin.com/job_detail/${id}.html`, jd_fulltext: `岗位要求${id}`.repeat(30) }, { useLlm: false });
    job.score.grade = grade;
    store.upsertJobs([job]);
    return store.getJob(job.id)!;
  }
  function runner(send?: GreetingSender['send']) {
    return new TemplateGreetingBatch(store, { delayMs: 0, readTemplate: () => '您好，我对这个岗位感兴趣，希望进一步沟通。', sender: {
      send: send ?? (async () => ({ platform: 'boss', sentAt: new Date().toISOString(), receiptConfirmed: true, confirmationMethod: 'test' })),
    } });
  }

  it('模板不需要简历或 API，关闭环境变量和已保存的模型配置', async () => {
    saveUserSettings({ greetingTemplate: '您好，希望进一步沟通。', llm: { enabled: true, apiKey: 'example', baseURL: 'https://example.com/v1', model: 'test', timeoutMs: 1000 } });
    assert.equal(getEffectiveLlmConfig().enabled, false);
    assert.equal(getEffectiveLlmConfig().apiKey, '');
    assert.equal((await new TemplateGreetingService().generate(await add('local'))).text, '您好，希望进一步沟通。');
  });

  it('仅选择当前 BOSS A/B，排除已沟通、猎聘、C/D 和不可信链接', async () => {
    const a = await add('a');
    const b = await add('b', 'B');
    const processed = await add('processed');
    store.updateJobContact(processed.id, { status: 'greeted' });
    await add('c', 'C'); await add('d', 'D'); await add('liepin', 'A', 'liepin');
    assert.deepEqual(new Set(runner().candidates().map((job) => job.id)), new Set([a.id, b.id]));
    assert.equal(bossJobUrl('https://www.zhipin.com.evil.example/job_detail/a.html'), undefined);
    assert.equal(bossJobUrl('https://user@www.zhipin.com/job_detail/a.html'), undefined);
    assert.equal(bossJobUrl('http://www.zhipin.com/job_detail/a.html'), undefined);
    assert.equal(bossJobUrl(a.url + '?securityId=x'), a.url);
  });

  it('预览前不发送，确认后逐条发送预览原文，令牌不可复用', async () => {
    const a = await add('a'); const b = await add('b', 'B');
    const sent: string[] = [];
    let active = 0;
    const batch = runner(async (_job, message) => {
      assert.equal(++active, 1);
      sent.push(message);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { platform: 'boss', sentAt: new Date().toISOString(), receiptConfirmed: true, confirmationMethod: 'test' };
    });
    const preview = batch.preview([a.id, b.id]);
    assert.equal(sent.length, 0);
    const run = batch.start(preview.token);
    assert.throws(() => batch.start(preview.token), /已有任务/);
    await batch.waitForIdle();
    assert.deepEqual(sent, [preview.text, preview.text]);
    assert.equal(store.getRun(run.id)?.status, 'succeeded');
    assert.equal(store.getJobContact(a.id).communication_source, 'template');
    assert.throws(() => batch.start(preview.token), /预览已失效/);
    assert.equal(batch.candidates().length, 0);
  });

  it('发送结果未知立即停止，重启和重置沟通状态均不会重发', async () => {
    const a = await add('a'); const b = await add('b');
    let calls = 0;
    const batch = runner(async () => { calls++; throw new Error('回执丢失'); });
    const run = batch.start(batch.preview([a.id, b.id]).token);
    await batch.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(store.getRun(run.id)?.status, 'failed');
    assert.equal(store.getJobContact(a.id).status, 'send_unknown');
    assert.equal(store.getJobContact(b.id).status, 'unprocessed');
    store.updateJobContact(a.id, { status: 'unprocessed' });
    store.close(); store = new JobStore(join(directory, 'jobs.sqlite'));
    assert.deepEqual(runner().candidates().map((job) => job.id), [b.id]);
  });

  it('取消等待当前岗位回执，保留确认成功的记录，未发送岗位仍可选择', async () => {
    const a = await add('a'); const b = await add('b');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const batch = runner(async () => {
      await pending;
      return { platform: 'boss', sentAt: new Date().toISOString(), receiptConfirmed: true, confirmationMethod: 'test' };
    });
    const run = batch.start(batch.preview([a.id, b.id]).token);
    batch.cancel(run.id);
    assert.equal(batch.busy, true);
    release();
    await batch.waitForIdle();
    assert.equal(store.getRun(run.id)?.status, 'cancelled');
    assert.equal(store.getJobContact(a.id).status, 'greeted');
    assert.deepEqual(batch.candidates().map((job) => job.id), [b.id]);
  });

  it('再次检查预览后的岗位状态与发送数量', async () => {
    const job = await add('a');
    const batch = runner();
    assert.throws(() => batch.preview([]), /1–20/);
    assert.throws(() => batch.preview(Array.from({ length: 21 }, (_, i) => `${i}`)), /1–20/);
    const preview = batch.preview([job.id]);
    store.updateJobContact(job.id, { status: 'greeted' });
    assert.throws(() => batch.start(preview.token), /岗位状态/);
  });
});
