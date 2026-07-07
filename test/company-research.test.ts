import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { scoreJob } from '../src/scorer/index.js';
import type { CompanyProfile, RawJob } from '../src/types.js';
import { buildBossCompanyProfile, type CompanyProfileService } from '../src/services/company-profile-service.js';
import { RunService } from '../src/services/run-service.js';
import { JobStore } from '../src/server/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createStore(): JobStore {
  const dir = mkdtempSync(join(tmpdir(), 'job-hunter-company-'));
  dirs.push(dir);
  return new JobStore(join(dir, 'test.sqlite'));
}

function raw(overrides: Partial<RawJob> = {}): RawJob {
  return {
    title: 'AI Agent工程师',
    company: '同一家公司',
    salary: '20-30K',
    location: '深圳',
    source: 'boss',
    url: 'https://example.com/job',
    jd_fulltext: '使用 Python、RAG 和 Agent 做大模型应用。',
    ...overrides,
  };
}

function profile(company: string, overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    company_key: company,
    display_name: company,
    quality_score: 92,
    company_type: 'foreign',
    work_life: 'weekends',
    reputation_summary: '公开信息显示双休外企',
    green_flags: ['双休', '外企'],
    red_flags: [],
    sources: [{ query: 'boss', title: '公司画像', url: 'https://example.com/profile', description: 'BOSS 公司信息' }],
    confidence: 0.9,
    researched_at: '2026-06-01T00:00:00.000Z',
    expires_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

async function waitForRun(store: JobStore, runId: string): Promise<void> {
  for (let index = 0; index < 100; index++) {
    const run = store.getRun(runId);
    if (run && !['queued', 'running'].includes(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待重新评分任务超时');
}

describe('BOSS 公司画像与复用', () => {
  it('同一家公司多个岗位在重新评分时只构建一次并复用画像', async () => {
    const store = createStore();
    store.upsertJobs([
      await scoreJob(raw({ title: '岗位一', url: 'https://example.com/a' }), { useLlm: false }),
      await scoreJob(raw({ title: '岗位二', url: 'https://example.com/b' }), { useLlm: false }),
    ]);
    let calls = 0;
    const companyProfile = {
      build(companyName: string) {
        calls += 1;
        return profile(companyName);
      },
    } as CompanyProfileService;
    const service = new RunService(store, { companyProfile, useLlm: false });
    const run = service.startRescore();
    await waitForRun(store, run.id);
    const finished = store.getRun(run.id);
    const jobs = store.listJobs({ lifecycle: 'all' });
    assert.equal(finished?.status, 'succeeded');
    assert.equal(calls, 1);
    assert.equal(store.getCompanyProfile('同一家公司')?.quality_score, 92);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].company_profile?.quality_score, 92);
    assert.equal(jobs[0].score.company_quality_score, 92);
    store.close();
  });

  it('BOSS 规模、阶段和福利字段会提高公司质量分', () => {
    const saved = buildBossCompanyProfile('样例科技', [
      raw({
        company: '样例科技',
        company_industry: '互联网',
        company_stage: '已上市',
        company_scale: '1000-9999人',
        tags: ['五险一金', '带薪年假', '定期体检'],
        jd_fulltext: '周末双休，做五休二，使用 Python、RAG 和 Agent 做大模型应用。',
      }),
    ], new Date('2026-06-23T00:00:00.000Z'));

    assert.equal(saved.company_type, 'listed');
    assert.equal(saved.work_life, 'weekends');
    assert.ok(saved.quality_score >= 90);
    assert.match(saved.reputation_summary, /1000-9999人/);
    assert.equal(saved.sources[0].query, 'boss');
  });

  it('BOSS 外包、小团队和大小周信号会降低公司质量分', () => {
    const saved = buildBossCompanyProfile('外包科技', [
      raw({
        company: '外包科技',
        company_stage: '未融资',
        company_scale: '0-20人',
        tags: ['加班补助'],
        jd_fulltext: '该岗位为客户现场外包驻场，大小周，销售KPI 明确。',
      }),
    ], new Date('2026-06-23T00:00:00.000Z'));

    assert.equal(saved.company_type, 'outsourcing');
    assert.equal(saved.work_life, 'big_small_week');
    assert.ok(saved.quality_score < 50);
    assert.match(saved.reputation_summary, /外包/);
  });

  it('公司画像构建异常时写入中性画像且不阻断重新评分', async () => {
    const store = createStore();
    store.upsertJobs([await scoreJob(raw(), { useLlm: false })]);
    const companyProfile = {
      build() {
        throw new Error('BOSS 字段异常');
      },
    } as CompanyProfileService;
    const service = new RunService(store, { companyProfile, useLlm: false });
    const run = service.startRescore();
    await waitForRun(store, run.id);
    const saved = store.listJobs()[0];
    assert.equal(store.getRun(run.id)?.status, 'succeeded');
    assert.equal(saved.company_profile?.quality_score, 70);
    assert.match(saved.company_profile?.last_error ?? '', /BOSS 字段异常/);
    assert.equal(saved.score.company_quality_score, 70);
    store.close();
  });
});
