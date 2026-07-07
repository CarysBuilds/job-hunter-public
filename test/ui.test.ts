import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { createApp } from '../src/index.js';
import { scoreJob } from '../src/scorer/index.js';
import type { GreetingGenerator } from '../src/services/greeting-service.js';
import { RunService } from '../src/services/run-service.js';
import { JobStore } from '../src/server/store.js';

const dir = mkdtempSync(join(tmpdir(), 'job-hunter-ui-'));
const store = new JobStore(join(dir, 'ui.sqlite'));
const greeting: GreetingGenerator = {
  status: () => ({ resumeConfigured: true, llmConfigured: true, model: 'deepseek-chat' }),
  generate: async () => ({ text: '测试文案', model: 'deepseek-chat' }),
};
const app = createApp({ store, runs: new RunService(store), greeting });
let server: Server;
let browser: Browser;
let origin: string;

before(async () => {
  const active = await scoreJob({
    title: '当前 Agent 岗位', company: '当前公司', salary: '20-30K', location: '深圳',
    source: 'boss', url: 'https://www.zhipin.com/job_detail/ui-active.html',
    jd_fulltext: '负责 AI 解决方案、需求调研、PoC 演示、客户沟通、交付培训和上线复盘。'.repeat(5),
  }, { useLlm: false });
  active.score.grade = 'A';
  const archived = await scoreJob({
    title: '历史解决方案岗位', company: '历史公司', salary: '18-25K', location: '深圳',
    source: 'boss', url: 'https://example.com/archived', jd_fulltext: 'AI PoC 交付',
  }, { useLlm: false });
  archived.first_seen_at = '2025-01-01T00:00:00.000Z';
  archived.last_seen_at = archived.first_seen_at;
  store.upsertJobs([active, archived]);
  store.archiveStaleJobs(new Date('2026-06-01T00:00:00.000Z'), 14);
  const staleRun = store.createRun({ operation: 'crawl', source: 'boss', keywords: ['旧任务'], pages: 1 });
  store.updateRun(staleRun.id, {
    status: 'interrupted',
    startedAt: '2026-05-01T00:00:00.000Z',
    finishedAt: '2026-05-01T00:01:00.000Z',
    message: '进程重启，任务已中断',
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('无法获取测试端口');
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('前端生命周期烟测', () => {
  it('设置弹窗把已保存配置作为表单值渲染而不是 HTML', async () => {
    const payload = '"><svg onload=x=1>';
    const configResponse = await fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cityCode: '101010100', keywords: [payload], setupCompleted: true }),
    });
    assert.equal(configResponse.status, 200);
    const profileResponse = await fetch(`${origin}/api/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        careerStage: 'experienced',
        targetTracks: ['ai_solutions'],
        experienceYears: 3,
        locationScore: { [payload]: 5 },
      }),
    });
    assert.equal(profileResponse.status, 200);

    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.evaluate(() => { (window as unknown as { x: number }).x = 0; });
    await page.locator('#btn-setup').click();
    await page.waitForSelector('#setup-overlay:not(.hidden)');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window as unknown as { x: number }).x), 0);
    assert.equal(await page.locator('input[name="keywords"]').inputValue(), payload);
    assert.equal(await page.locator('input[name="cities"]').inputValue(), payload);
    await page.close();
  });

  it('首页可渲染、可切换历史岗位，并在详情显示发现时间', async () => {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'networkidle' });
    assert.equal(await page.title(), 'Job Hunter — AI 岗位评估');
    assert.equal(await page.locator('[data-login-source="boss"]').innerText(), '打开 BOSS 登录');
    assert.equal(await page.locator('[data-crawl-source]').count(), 3);
    assert.equal(await page.locator('#btn-setup').innerText(), '设置');
    if (await page.locator('#setup-overlay').isVisible()) {
      await page.locator('#setup-overlay .modal-close').click();
    }
    assert.equal(await page.locator('#status-bar').evaluate((node) => node.classList.contains('hidden')), true);
    assert.equal(await page.locator('#job-tbody tr').count(), 1);
    assert.match(await page.locator('#job-tbody').innerText(), /当前 Agent 岗位/);

    let crawlBody: { keywords?: string[] } | undefined;
    await page.route('**/api/crawl', async (route) => {
      crawlBody = JSON.parse(route.request().postData() || '{}') as { keywords?: string[] };
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: {
            id: 'ui-crawl-stub',
            operation: 'crawl',
            status: 'queued',
            source: 'boss',
            keywords: crawlBody.keywords,
            pages: 1,
            currentPage: 0,
            totalPages: crawlBody.keywords?.length ?? 0,
            found: 0,
            saved: 0,
            inserted: 0,
            updated: 0,
            reactivated: 0,
            archived: 0,
            deduplicated: 0,
            message: '等待抓取 BOSS',
            createdAt: '2026-06-01T00:00:00.000Z',
          },
        }),
      });
    });
    await page.locator('#crawl-keyword-preset button[data-value="product"]').click();
    await page.locator('[data-crawl-source="boss"]').click();
    assert.deepEqual(crawlBody?.keywords, [
      '产品经理', '产品运营', '客户成功经理', '实施顾问', '业务流程顾问', 'SaaS解决方案顾问',
    ]);
    await page.unroute('**/api/crawl');
    await page.waitForFunction(() => !(document.querySelector('[data-crawl-source="boss"]') as HTMLButtonElement | null)?.disabled);

    await Promise.all([
      page.waitForResponse((response) => response.url().includes('lifecycle=archived')),
      page.locator('#filter-lifecycle button[data-value="archived"]').click(),
    ]);
    await page.waitForFunction(() => document.querySelector('#job-tbody')?.textContent?.includes('历史解决方案岗位'));
    assert.equal(await page.locator('#job-tbody tr').count(), 1);
    await page.locator('#job-tbody tr').click();
    assert.equal(await page.locator('#detail-overlay').isVisible(), true);
    const detail = await page.locator('#detail-panel').innerText();
    assert.match(detail, /首次发现/);
    assert.match(detail, /最近发现/);
    assert.match(detail, /BOSS/);
    assert.match(detail, /生成打招呼草稿/);
    await page.close();
  });
});
