import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { chromium } from 'playwright';
import { createApp } from '../src/index.js';
import { JobStore } from '../src/server/store.js';
import { RunService } from '../src/services/run-service.js';
import { TemplateGreetingBatch } from '../src/services/template-greeting-service.js';
import { scoreJob } from '../src/scorer/index.js';
import { saveUserSettings } from '../src/config.js';

it('朋友版界面：逐词预览、自填模板、A/B选择、确认和结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friend-ui-'));
  const store = new JobStore(join(dir, 'jobs.sqlite'));
  saveUserSettings({ setupCompleted: true });
  for (const grade of ['A', 'B', 'C'] as const) {
    const job = await scoreJob({ title: `产品运营示例 ${grade}`, company: `示例企业 ${grade}`, salary: '15-25K', location: '北京',
      source: 'boss', url: `https://www.zhipin.com/job_detail/fixture${grade}.html`, jd_fulltext: '负责产品运营与数据分析。'.repeat(20) }, { useLlm: false });
    job.score.grade = grade;
    store.upsertJobs([job]);
  }
  const messages: string[] = [];
  const batch = new TemplateGreetingBatch(store, { delayMs: 0, sender: {
    send: async (_job, text) => {
      messages.push(text);
      return { platform: 'boss', receiptConfirmed: true, sentAt: new Date().toISOString(), confirmationMethod: 'test' };
    },
  } });
  const app = createApp({ store, runs: new RunService(store), batch });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#setup-overlay').waitFor({ state: 'visible' });
    await page.locator('[name="keywords"]').fill('产品经理，产品运营\nJava 开发');
    await page.getByText('将分别搜索 3 个关键词：产品经理 / 产品运营 / Java 开发').waitFor();
    assert.equal(await page.locator('[name="llmApiKey"]').count(), 0);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.locator('#setup-overlay').waitFor({ state: 'hidden' });
    const settings = await fetch(`${origin}/api/config`).then((res) => res.json());
    assert.deepEqual(settings.data.settings.keywords, ['产品经理', '产品运营', 'Java 开发']);
    await page.getByRole('button', { name: '批量打招呼', exact: true }).click();
    await page.locator('#friend-template').fill('您好，我对贵公司的岗位很感兴趣，希望进一步沟通具体职责。');
    await page.getByRole('button', { name: '保存模板', exact: true }).click();
    await page.getByText('模板已保存到本机。').waitFor();
    await page.getByRole('button', { name: '选择 A+B 档', exact: true }).click();
    assert.equal(await page.locator('#friend-candidates input:checked').count(), 2);
    await page.getByRole('button', { name: '预览选中的岗位与文案', exact: true }).click();
    await page.locator('#friend-confirmation').waitFor({ state: 'visible' });
    assert.equal(messages.length, 0);
    assert.equal(await page.locator('#friend-preview-jobs li').count(), 2);
    mkdirSync('artifacts/friend', { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'artifacts/friend/template-preview.png', fullPage: true });
    const rejected = await fetch(`${origin}/api/greeting/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-job-hunter-request': '1' }, body: JSON.stringify({ token: crypto.randomUUID(), confirm: false }),
    });
    assert.equal(rejected.status, 400);
    await page.getByRole('button', { name: '确认并发送', exact: true }).click();
    await page.getByText('发送完成，已确认 2/2 条', { exact: true }).waitFor();
    assert.equal(messages.length, 2);
    assert.equal(messages[0], messages[1]);
    await page.reload();
    await page.getByRole('button', { name: '批量打招呼', exact: true }).click();
    await page.getByText('可选 0 个（A 0 / B 0），已选 0/20 个').waitFor();
    await page.locator('#friend-results').getByText(/产品运营示例 A · 示例企业 A：已发送/).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await batch.waitForIdle();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
