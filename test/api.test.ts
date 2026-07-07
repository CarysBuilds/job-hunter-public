import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { request, type Server } from 'node:http';
import { createApp } from '../src/index.js';
import { RunService } from '../src/services/run-service.js';
import { scoreJob } from '../src/scorer/index.js';
import { JobStore } from '../src/server/store.js';
import type { GreetingGenerator } from '../src/services/greeting-service.js';

const dir = mkdtempSync(join(tmpdir(), 'job-hunter-api-'));
const store = new JobStore(join(dir, 'api.sqlite'));
const greeting: GreetingGenerator = {
  status: () => ({ resumeConfigured: true, llmConfigured: true, model: 'deepseek-chat' }),
  generate: async (job) => ({ text: `您好，我对${job.title}很感兴趣，希望进一步沟通。`, model: 'deepseek-chat' }),
};
const runs = {
  startCrawl: (input: { source: 'boss' | 'liepin' | 'zhaopin'; keywords: string[]; pages: number }) => ({
    id: `stub-${input.source}`,
    operation: 'crawl',
    status: 'queued',
    source: input.source,
    keywords: input.keywords,
    pages: input.pages,
    currentPage: 0,
    totalPages: input.keywords.length * input.pages,
    found: 0,
    saved: 0,
    inserted: 0,
    updated: 0,
    reactivated: 0,
    archived: 0,
    deduplicated: 0,
    message: `等待抓取 ${input.source}`,
    createdAt: '2026-06-01T00:00:00.000Z',
  }),
  startRescore: () => ({
    id: 'stub-rescore',
    operation: 'rescore',
    status: 'queued',
    source: null,
    keywords: [],
    pages: 0,
    currentPage: 0,
    totalPages: 0,
    found: 0,
    saved: 0,
    inserted: 0,
    updated: 0,
    reactivated: 0,
    archived: 0,
    deduplicated: 0,
    message: '等待重新评分',
    createdAt: '2026-06-01T00:00:00.000Z',
  }),
} as unknown as RunService;
const app = createApp({ store, runs, greeting });
let server: Server;
let origin: string;
let port: number;

before(async () => {
  store.upsertJobs([await scoreJob({
    title: 'AI Agent工程师', company: 'API测试公司', salary: '20-30K', location: '深圳',
    source: 'boss', url: 'mock://api/job', jd_fulltext: 'Python RAG Agent API',
  }, { useLlm: false })]);
  const archived = await scoreJob({
    title: '历史 AI 岗位', company: '旧公司', salary: '15-20K', location: '深圳',
    source: 'boss', url: 'mock://api/archived', jd_fulltext: '历史岗位内容',
  }, { useLlm: false });
  archived.last_seen_at = '2025-01-01T00:00:00.000Z';
  archived.first_seen_at = archived.last_seen_at;
  store.upsertJobs([archived]);
  store.archiveStaleJobs(new Date('2026-06-01T00:00:00.000Z'), 14);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('无法获取测试端口');
      port = address.port;
      origin = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('HTTP API', () => {
  function requestWithHost(host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/api/health',
        method: 'GET',
        headers: { host },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('查询岗位并使用稳定 ID 获取详情', async () => {
    const list = await fetch(`${origin}/api/jobs?q=Agent`).then((response) => response.json());
    assert.equal(list.ok, true);
    assert.equal(list.data.length, 1);
    const detail = await fetch(`${origin}/api/jobs/${list.data[0].id}`).then((response) => response.json());
    assert.equal(detail.data.company, 'API测试公司');
  });

  it('默认仅返回当前岗位，并支持历史、全部与新鲜度排序', async () => {
    const active = await fetch(`${origin}/api/jobs`).then((response) => response.json());
    const archived = await fetch(`${origin}/api/jobs?lifecycle=archived&sort=fresh-desc`).then((response) => response.json());
    const all = await fetch(`${origin}/api/jobs?lifecycle=all`).then((response) => response.json());
    assert.equal(active.data.length, 1);
    assert.equal(archived.data.length, 1);
    assert.equal(archived.data[0].lifecycle_status, 'archived');
    assert.equal(all.data.length, 2);
  });

  it('健康检查返回版本、运行时长、岗位数量与任务状态', async () => {
    const response = await fetch(`${origin}/api/health`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.data.version, '0.1.0');
    assert.equal(typeof result.data.uptimeSeconds, 'number');
    assert.deepEqual(result.data.jobs, { active: 1, archived: 1, total: 2 });
    assert.equal(result.data.task, null);
  });

  it('支持单平台抓取任务并拒绝多平台并发', async () => {
    for (const source of ['boss', 'liepin', 'zhaopin']) {
      const response = await fetch(`${origin}/api/crawl`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: [source], keywords: ['AI'], pages: 1 }),
      });
      const result = await response.json();
      assert.equal(response.status, 202);
      assert.equal(result.data.source, source);
    }

    const response = await fetch(`${origin}/api/crawl`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: ['boss', 'liepin'], keywords: ['AI'], pages: 1 }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /单个平台/);
  });

  it('拒绝非法筛选值并为未知 API 返回 JSON 404', async () => {
    assert.equal((await fetch(`${origin}/api/jobs?grade=Z`)).status, 400);
    const missing = await fetch(`${origin}/api/not-found`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).ok, false);
  });

  it('静态首页、脚本与状态接口可访问', async () => {
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/app.js`)).status, 200);
    assert.equal((await fetch(`${origin}/api/status`)).status, 200);
  });

  it('拒绝非本机 Host 和跨站写操作', async () => {
    const hostResponse = await requestWithHost('example.com');
    assert.equal(hostResponse.status, 403);
    assert.match(JSON.parse(hostResponse.body).error, /本机/);

    const crossOrigin = await fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ cityCode: '101010100', keywords: ['AI'] }),
    });
    assert.equal(crossOrigin.status, 403);

    const localOrigin = await fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ cityCode: '101010100', keywords: ['AI'] }),
    });
    assert.equal(localOrigin.status, 200);
  });

  it('返回简历/API 状态并生成岗位打招呼文案', async () => {
    const profile = await fetch(`${origin}/api/profile/status`).then((response) => response.json());
    assert.equal(profile.data.resumeConfigured, true);
    assert.equal(profile.data.model, 'deepseek-chat');
    const target = store.listJobs()[0];
    const response = await fetch(`${origin}/api/jobs/${target.id}/greeting`, { method: 'POST' });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.match(result.data.text, /AI Agent工程师/);
    assert.equal(result.data.contact.status, 'drafted');
    assert.equal(store.getJob(target.id)?.contact?.status, 'drafted');
  });

  it('支持读取并保存公开版配置和用户画像', async () => {
    const setup = await fetch(`${origin}/api/setup/status`).then((response) => response.json());
    assert.equal(setup.ok, true);
    const initialConfig = await fetch(`${origin}/api/config`).then((response) => response.json());
    assert.notEqual(initialConfig.data.defaults.llm.apiKey, 'env-key-should-not-leak');
    assert.equal(initialConfig.data.defaults.llm.apiKey, '');

    const configResponse = await fetch(`${origin}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cityCode: '101010100',
        keywords: ['产品经理'],
        setupCompleted: true,
        llm: { apiKey: 'saved-key-should-not-leak', baseURL: 'https://api.example.com/v1', model: 'test-model' },
      }),
    });
    assert.equal(configResponse.status, 200);
    const savedConfig = await configResponse.json();
    assert.equal(savedConfig.data.llm.apiKey, 'configured');
    assert.ok(!JSON.stringify(savedConfig).includes('saved-key-should-not-leak'));

    const reloadedConfig = await fetch(`${origin}/api/config`).then((response) => response.json());
    assert.equal(reloadedConfig.data.settings.llm.apiKey, 'configured');
    assert.ok(!JSON.stringify(reloadedConfig).includes('saved-key-should-not-leak'));

    const profileResponse = await fetch(`${origin}/api/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ careerStage: 'career_change', targetTracks: ['ai_product'], experienceYears: 5, salaryFloorK: 20 }),
    });
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.json();
    assert.equal(profile.data.careerStage, 'career_change');
    assert.deepEqual(profile.data.targetTracks, ['ai_product']);
  });

  it('支持更新岗位沟通状态', async () => {
    const target = store.listJobs()[0];
    const response = await fetch(`${origin}/api/jobs/${target.id}/contact`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'applied', notes: '已在 BOSS 投递' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.data.status, 'applied');
    assert.equal(result.data.notes, '已在 BOSS 投递');

    const closedResponse = await fetch(`${origin}/api/jobs/${target.id}/contact`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    });
    const closed = await closedResponse.json();
    assert.equal(closedResponse.status, 200);
    assert.equal(closed.data.status, 'closed');
    assert.equal(store.getJob(target.id)?.lifecycle_status, 'archived');
  });
});
