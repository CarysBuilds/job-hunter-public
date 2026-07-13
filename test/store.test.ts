import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { scoreJob } from '../src/scorer/index.js';
import { createJobId } from '../src/job-id.js';
import { JobStore } from '../src/server/store.js';
import type { CompanyProfile, Grade, RawJob, ScoredJob } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRaw(overrides: Partial<RawJob> = {}): RawJob {
  return {
    title: 'AI Agent工程师', company: '测试公司', salary: '20-30K', location: '深圳',
    source: 'boss', url: 'https://www.zhipin.com/job_detail/abc.html?ka=search',
    jd_fulltext: '使用 Python、Node.js、RAG 和 API 开发大模型 Agent 应用。',
    ...overrides,
  };
}

function createStore(): JobStore {
  const dir = mkdtempSync(join(tmpdir(), 'job-hunter-'));
  dirs.push(dir);
  return new JobStore(join(dir, 'test.sqlite'));
}

function makeCompanyProfile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    company_key: '测试公司',
    display_name: '测试公司',
    quality_score: 88,
    company_type: 'foreign',
    work_life: 'weekends',
    reputation_summary: '外企且双休',
    green_flags: ['外企', '双休'],
    red_flags: [],
    sources: [{ query: '测试公司 双休', title: '测试来源', url: 'https://example.com/company', description: '双休外企' }],
    confidence: 0.8,
    researched_at: '2026-06-01T00:00:00.000Z',
    expires_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function tuneScore(job: ScoredJob, grade: Grade, total: number, redFlags: string[] = []): ScoredJob {
  job.score = {
    ...job.score,
    grade,
    total,
    job_match_score: total,
    red_flags: redFlags,
    summary: `${grade} ${total}`,
  };
  return job;
}

describe('SQLite JobStore', () => {
  it('同一 URL 的核心字段变化时保留两条记录', async () => {
    const store = createStore();
    const first = await scoreJob(makeRaw(), { useLlm: false });
    const updated = await scoreJob(makeRaw({ salary: '25-40K', url: 'https://www.zhipin.com/job_detail/abc.html?lid=tracking' }), { useLlm: false });
    assert.equal(first.id, updated.id);
    store.upsertJobs([first]);
    store.upsertJobs([updated]);
    assert.equal(store.countJobs(), 2);
    assert.equal(store.listJobs({ minSalary: 35 }).length, 1);
    store.close();
  });

  it('同一 URL 核心字段一致但解析字段更完整时更新旧记录', async () => {
    const store = createStore();
    const base = {
      source: 'zhaopin' as const,
      url: 'https://www.zhaopin.com/jobdetail/CC139506240J40683450002.htm',
      title: '客户成功经理',
      company: '广州市新文溯科技有限公司',
      salary: '1-2万·15薪',
      location: '深圳·福田·莲花',
      experience: '1-3年',
      education: '本科',
    };
    const sparse = await scoreJob(makeRaw({
      ...base,
      jd_fulltext: '客户成功经理\n广州市新文溯科技有限公司\n1-2万·15薪\n深圳·福田·莲花\nKA大客户\n金融行业客户',
    }), { useLlm: false });
    const enriched = await scoreJob(makeRaw({
      ...base,
      recruiter_name: '王女士',
      recruiter_title: '客户成功招聘',
      company_stage: '民营',
      company_scale: '20-99人',
      company_industry: '软件/IT服务',
      tags: ['KA大客户', '金融行业客户', '高回复率'],
      jd_fulltext: '职位：客户成功经理\n公司：广州市新文溯科技有限公司\n薪资：1-2万·15薪\n地点：深圳·福田·莲花\n经验：1-3年\n学历：本科\n招聘人：王女士·客户成功招聘\n行业：软件/IT服务\n性质/阶段：民营\n规模：20-99人',
    }), { useLlm: false });
    store.upsertJobs([sparse]);
    const stats = store.upsertJobsDetailed([enriched]);
    const [saved] = store.listJobs({ lifecycle: 'all' });
    assert.equal(store.countJobs(), 1);
    assert.equal(stats.updated, 1);
    assert.equal(saved.recruiter_name, '王女士');
    assert.equal(saved.company_scale, '20-99人');
    store.close();
  });

  it('同公司完整内容相同但 URL 不同，只保留 canonical 并记录严格去重', async () => {
    const store = createStore();
    const first = await scoreJob(makeRaw({ url: 'https://www.zhipin.com/job_detail/exact-a.html' }), { useLlm: false });
    const second = await scoreJob(makeRaw({ url: 'https://www.zhipin.com/job_detail/exact-b.html' }), { useLlm: false });
    const stats = store.upsertJobsDetailed([first, second]);
    assert.equal(store.countJobs(), 1);
    assert.equal(stats.inserted, 1);
    assert.equal(stats.deduplicated, 1);
    store.upsertJobs([second]);
    assert.equal(store.countJobs(), 1);
    store.close();
  });

  it('投递优先排序先列 A 与无硬风险高分 B', async () => {
    const store = createStore();
    const jobs = await Promise.all([
      scoreJob(makeRaw({ title: 'B高分编码', url: 'https://example.com/noisy-b', jd_fulltext: '需要 Python 编码、模型微调和工程开发。' }), { useLlm: false }),
      scoreJob(makeRaw({ title: 'C高分', url: 'https://example.com/high-c', jd_fulltext: '包含销售指标和客户资源要求。' }), { useLlm: false }),
      scoreJob(makeRaw({ title: 'B高分干净', url: 'https://example.com/clean-b', jd_fulltext: '负责 AI 解决方案、PoC 演示、客户沟通和交付培训。' }), { useLlm: false }),
      scoreJob(makeRaw({ title: 'A低分优先', url: 'https://example.com/a', jd_fulltext: '负责 AI 客户成功、需求调研、方案设计和上线复盘。' }), { useLlm: false }),
    ]);
    store.upsertJobs([
      tuneScore(jobs[0], 'B', 95, ['包含一定编码或工程实现要求，需要谨慎核对']),
      tuneScore(jobs[1], 'C', 96, ['包含销售指标、获客或客户资源要求']),
      tuneScore(jobs[2], 'B', 82, []),
      tuneScore(jobs[3], 'A', 70, []),
    ]);

    assert.deepEqual(
      store.listJobs({ sort: 'priority-desc' }).map((job) => job.title),
      ['A低分优先', 'B高分干净', 'B高分编码', 'C高分']
    );
    store.close();
  });

  it('不同公司即使标题和 JD 相同也不合并', async () => {
    const store = createStore();
    const one = await scoreJob(makeRaw({ company: '公司甲', url: 'https://example.com/a' }), { useLlm: false });
    const two = await scoreJob(makeRaw({ company: '公司乙', url: 'https://example.com/b' }), { useLlm: false });
    store.upsertJobs([one, two]);
    assert.equal(store.countJobs(), 2);
    store.close();
  });

  it('同公司同标题但 JD、薪资或地点不同均保留', async () => {
    const store = createStore();
    const jobs = await Promise.all([
      scoreJob(makeRaw({ url: 'https://example.com/base' }), { useLlm: false }),
      scoreJob(makeRaw({ url: 'https://example.com/jd', jd_fulltext: '完全不同的岗位职责' }), { useLlm: false }),
      scoreJob(makeRaw({ url: 'https://example.com/salary', salary: '30-40K' }), { useLlm: false }),
      scoreJob(makeRaw({ url: 'https://example.com/location', location: '广州' }), { useLlm: false }),
    ]);
    store.upsertJobs(jobs);
    assert.equal(store.countJobs(), 4);
    store.close();
  });

  it('仅 Unicode、换行与连续空白不同的内容会合并', async () => {
    const store = createStore();
    const one = await scoreJob(makeRaw({
      url: 'https://example.com/space-a', company: '测试 公司', jd_fulltext: 'Python\nRAG  Agent',
    }), { useLlm: false });
    const two = await scoreJob(makeRaw({
      url: 'https://example.com/space-b', company: '测试　公司', jd_fulltext: 'Python   RAG\r\nAgent',
    }), { useLlm: false });
    store.upsertJobs([one, two]);
    assert.equal(store.countJobs(), 1);
    store.close();
  });

  it('JD 缺失且 URL 不同时不跨 URL 合并', async () => {
    const store = createStore();
    const one = await scoreJob(makeRaw({ url: 'https://example.com/empty-a', jd_fulltext: '' }), { useLlm: false });
    const two = await scoreJob(makeRaw({ url: 'https://example.com/empty-b', jd_fulltext: '' }), { useLlm: false });
    store.upsertJobs([one, two]);
    assert.equal(store.countJobs(), 2);
    store.close();
  });

  it('重复组优先保留企业直招而不是猎头发布', async () => {
    const store = createStore();
    const headhunter = await scoreJob(makeRaw({ url: 'https://example.com/hunter', is_headhunter: true }), { useLlm: false });
    const direct = await scoreJob(makeRaw({ url: 'https://example.com/direct', is_headhunter: false }), { useLlm: false });
    store.upsertJobs([headhunter, direct]);
    assert.equal(store.countJobs(), 1);
    assert.equal(store.listJobs()[0].is_headhunter, false);
    store.close();
  });

  it('14 天未发现后归档，重新出现时恢复且保留首次发现时间', async () => {
    const store = createStore();
    const old = await scoreJob(makeRaw({ url: 'https://example.com/lifecycle' }), { useLlm: false });
    old.first_seen_at = '2026-05-01T00:00:00.000Z';
    old.last_seen_at = '2026-05-01T00:00:00.000Z';
    store.upsertJobs([old]);
    assert.equal(store.archiveStaleJobs(new Date('2026-06-01T00:00:00.000Z'), 14), 1);
    assert.equal(store.listJobs().length, 0);
    assert.equal(store.listJobs({ lifecycle: 'archived' }).length, 1);

    const rediscovered = await scoreJob(makeRaw({ url: 'https://example.com/lifecycle' }), { useLlm: false });
    rediscovered.last_seen_at = '2026-06-02T00:00:00.000Z';
    const stats = store.upsertJobsDetailed([rediscovered]);
    assert.equal(stats.reactivated, 1);
    assert.equal(store.listJobs().length, 1);
    assert.equal(store.listJobs()[0].first_seen_at, old.first_seen_at);
    store.close();
  });

  it('按 A/B/C/D 新鲜度动态归档', async () => {
    const store = createStore();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const makeScored = async (grade: 'A' | 'B' | 'C' | 'D', title: string, lastSeen: string) => {
      const scored = await scoreJob(makeRaw({ title, url: `https://example.com/${title}`, jd_fulltext: `${title} 大模型解决方案` }), { useLlm: false });
      scored.score.grade = grade;
      scored.first_seen_at = '2026-04-01T00:00:00.000Z';
      scored.last_seen_at = lastSeen;
      return scored;
    };
    const jobs = await Promise.all([
      makeScored('A', 'A旧岗位', '2026-05-01T00:00:00.000Z'),
      makeScored('A', 'A新岗位', '2026-05-10T00:00:00.000Z'),
      makeScored('B', 'B旧岗位', '2026-05-10T00:00:00.000Z'),
      makeScored('C', 'C旧岗位', '2026-05-17T00:00:00.000Z'),
      makeScored('D', 'D旧岗位', '2026-05-24T00:00:00.000Z'),
    ]);
    store.upsertJobs(jobs);
    assert.equal(store.archiveStaleJobs(now, { A: 30, B: 21, C: 14, D: 7 }), 4);
    assert.deepEqual(store.listJobs().map((job) => job.title), ['A新岗位']);
    store.close();
  });

  it('启动时补归档历史 closed 但仍 active 的岗位', async () => {
    const store = createStore();
    const closedJob = await scoreJob(makeRaw({
      title: '历史已结束岗位',
      url: 'https://example.com/legacy-closed',
      jd_fulltext: '历史 closed active 数据',
    }), { useLlm: false });
    store.upsertJobs([closedJob]);
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare(`
      INSERT INTO job_contacts(job_id, status, updated_at)
      VALUES (?, 'closed', ?)
    `).run(closedJob.id, '2026-05-01T00:00:00.000Z');
    db.prepare("UPDATE jobs SET lifecycle_status = 'active', archived_at = NULL WHERE id = ?").run(closedJob.id);
    const databasePath = store.databasePath;
    store.close();

    const reopened = new JobStore(databasePath);
    assert.equal(reopened.getJob(closedJob.id)?.lifecycle_status, 'archived');
    assert.equal(reopened.listJobs().some((job) => job.id === closedJob.id), false);
    reopened.close();
  });

  it('当前列表防御性排除 closed 状态岗位', async () => {
    const store = createStore();
    const closedJob = await scoreJob(makeRaw({
      title: '异常当前已结束岗位',
      url: 'https://example.com/active-closed',
      jd_fulltext: '异常 closed active 数据',
    }), { useLlm: false });
    store.upsertJobs([closedJob]);
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare(`
      INSERT INTO job_contacts(job_id, status, updated_at)
      VALUES (?, 'closed', ?)
    `).run(closedJob.id, '2026-05-01T00:00:00.000Z');
    db.prepare("UPDATE jobs SET lifecycle_status = 'active', archived_at = NULL WHERE id = ?").run(closedJob.id);

    assert.equal(store.getJob(closedJob.id)?.lifecycle_status, 'active');
    assert.equal(store.listJobs().some((job) => job.id === closedJob.id), false);
    assert.equal(store.listJobs({ lifecycle: 'all' }).some((job) => job.id === closedJob.id), true);
    store.close();
  });

  it('已沟通岗位不自动归档，已结束立即归档，已拒绝按评级归档', async () => {
    const store = createStore();
    const now = new Date('2026-06-01T00:00:00.000Z');
    const makeScored = async (title: string) => {
      const scored = await scoreJob(makeRaw({ title, url: `https://example.com/${title}`, jd_fulltext: `${title} AI 客户成功` }), { useLlm: false });
      scored.score.grade = 'D';
      scored.first_seen_at = '2026-04-01T00:00:00.000Z';
      scored.last_seen_at = '2026-05-01T00:00:00.000Z';
      return scored;
    };
    const protectedJob = await makeScored('已打招呼岗位');
    const rejectedJob = await makeScored('已拒绝岗位');
    const closedJob = await makeScored('已结束岗位');
    store.upsertJobs([protectedJob, rejectedJob, closedJob]);
    store.updateJobContact(protectedJob.id, { status: 'greeted' });
    store.updateJobContact(rejectedJob.id, { status: 'rejected' });
    store.updateJobContact(closedJob.id, { status: 'closed' });
    assert.equal(store.getJob(closedJob.id)?.lifecycle_status, 'archived');

    assert.equal(store.archiveStaleJobs(now, { D: 7 }), 1);
    assert.deepEqual(store.listJobs().map((job) => job.title), ['已打招呼岗位']);
    assert.deepEqual(store.listJobs({ lifecycle: 'archived' }).map((job) => job.title).sort(), ['已拒绝岗位', '已结束岗位']);
    store.updateJobContact(closedJob.id, { status: 'follow_up' });
    assert.equal(store.getJob(closedJob.id)?.lifecycle_status, 'active');
    store.close();
  });

  it('已结束岗位再次抓到时不恢复为当前岗位', async () => {
    const store = createStore();
    const original = await scoreJob(makeRaw({
      title: '重新出现的已结束岗位',
      url: 'https://example.com/closed-rediscovered',
      jd_fulltext: '负责 AI 方案交付',
    }), { useLlm: false });
    store.upsertJobs([original]);
    store.updateJobContact(original.id, { status: 'closed' });

    const rediscovered = await scoreJob(makeRaw({
      title: original.title,
      url: original.url,
      jd_fulltext: original.jd_fulltext,
    }), { useLlm: false });
    const stats = store.upsertJobsDetailed([rediscovered]);

    assert.equal(stats.reactivated, 0);
    assert.equal(store.getJob(original.id)?.lifecycle_status, 'archived');
    assert.equal(store.listJobs().some((job) => job.id === original.id), false);
    store.close();
  });

  it('同一岗位跨平台出现时保留不同来源记录', async () => {
    const store = createStore();
    const boss = await scoreJob(makeRaw({
      source: 'boss',
      url: 'https://www.zhipin.com/job_detail/cross-platform.html',
      title: 'AI客户成功',
      company: '跨平台科技',
      jd_fulltext: '负责 AI 解决方案客户成功与交付复盘。',
    }), { useLlm: false });
    const liepin = await scoreJob(makeRaw({
      source: 'liepin',
      url: 'https://www.liepin.com/job/123456.shtml',
      title: 'AI客户成功',
      company: '跨平台科技',
      jd_fulltext: '负责 AI 解决方案客户成功与交付复盘。',
    }), { useLlm: false });
    const stats = store.upsertJobsDetailed([boss, liepin]);
    assert.equal(store.countJobs(), 2);
    assert.equal(stats.deduplicated, 0);
    assert.deepEqual(new Set(store.listJobs({ lifecycle: 'all' }).map((job) => job.source)), new Set(['boss', 'liepin']));
    store.close();
  });

  it('持久化发布者信息与猎头标记', async () => {
    const store = createStore();
    const scored = await scoreJob(makeRaw({
      recruiter_name: '张顾问', recruiter_title: '猎头顾问', is_headhunter: true,
    }), { useLlm: false });
    store.upsertJobs([scored]);
    const saved = store.getJob(scored.id);
    assert.equal(saved?.recruiter_name, '张顾问');
    assert.equal(saved?.recruiter_title, '猎头顾问');
    assert.equal(saved?.is_headhunter, true);
    assert.equal(saved?.score.grade, 'C');
    store.close();
  });

  it('持久化公司画像并在同公司岗位间复用', async () => {
    const store = createStore();
    const profile = makeCompanyProfile();
    store.upsertCompanyProfile(profile);
    const first = await scoreJob(makeRaw({ title: '岗位一', url: 'https://example.com/company-a' }), {
      useLlm: false,
      companyProfile: profile,
    });
    const second = await scoreJob(makeRaw({ title: '岗位二', url: 'https://example.com/company-b' }), {
      useLlm: false,
      companyProfile: profile,
    });
    store.upsertJobs([first, second]);
    const saved = store.listJobs({ lifecycle: 'all' });
    assert.equal(saved.length, 2);
    assert.equal(saved[0].company_key, saved[1].company_key);
    assert.equal(saved[0].company_profile?.quality_score, 88);
    assert.equal(store.getFreshCompanyProfile('测试公司', new Date('2026-06-15T00:00:00.000Z'))?.quality_score, 88);
    assert.equal(store.getFreshCompanyProfile('测试公司', new Date('2026-08-01T00:00:00.000Z')), null);
    store.close();
  });

  it('删除岗位时保留公司画像存档', async () => {
    const store = createStore();
    store.upsertCompanyProfile(makeCompanyProfile());
    const scored = await scoreJob(makeRaw(), { useLlm: false });
    store.upsertJobs([scored]);
    assert.equal(store.deleteJobs(), 1);
    assert.equal(store.countJobs(), 0);
    assert.equal(store.getCompanyProfile('测试公司')?.quality_score, 88);
    store.close();
  });

  it('空 URL 使用岗位指纹，不会把所有岗位折叠成一条', () => {
    const one = makeRaw({ url: '', title: '岗位一' });
    const two = makeRaw({ url: '', title: '岗位二' });
    assert.notEqual(createJobId(one), createJobId(two));
  });

  it('进程重启后把未完成任务标记为 interrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-hunter-'));
    dirs.push(dir);
    const path = join(dir, 'test.sqlite');
    const store = new JobStore(path);
    const run = store.createRun({ operation: 'crawl', source: 'boss', keywords: ['AI Agent'], pages: 1 });
    store.updateRun(run.id, { status: 'running', startedAt: new Date().toISOString() });
    store.close();
    const reopened = new JobStore(path);
    assert.equal(reopened.getRun(run.id)?.status, 'interrupted');
    reopened.close();
  });

  it('进程重启时保留心跳新鲜且 worker 仍存活的任务', () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-hunter-'));
    dirs.push(dir);
    const path = join(dir, 'test.sqlite');
    const store = new JobStore(path);
    const run = store.createRun({ operation: 'crawl', source: 'boss', keywords: ['AI Agent'], pages: 1 });
    store.updateRun(run.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      workerPid: process.pid,
      heartbeatAt: new Date().toISOString(),
    });
    store.close();
    const reopened = new JobStore(path);
    assert.equal(reopened.getRun(run.id)?.status, 'running');
    reopened.close();
  });

  it('迁移旧 JSON 时按 v6 规则重新评分', () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-hunter-'));
    dirs.push(dir);
    const legacyPath = join(dir, 'jobs.json');
    writeFileSync(legacyPath, JSON.stringify([{
      ...makeRaw(),
      score: { total: 1, grade: 'D', skill_match: 0 },
      crawled_at: '2025-01-01T00:00:00.000Z',
    }]));
    const store = new JobStore(join(dir, 'test.sqlite'));
    assert.equal(store.migrateLegacyJson(legacyPath), 1);
    const migrated = store.listJobs()[0];
    assert.equal(migrated.score.score_version, 6);
    assert.notEqual(migrated.score.total, 1);
    store.close();
  });

  it('启动时把旧 SQLite 评分回填为 v6', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-hunter-'));
    dirs.push(dir);
    const path = join(dir, 'test.sqlite');
    const store = new JobStore(path);
    const scored = await scoreJob(makeRaw(), { useLlm: false });
    store.upsertJobs([scored]);
    store.close();

    const db = new DatabaseSync(path);
    db.prepare("UPDATE jobs SET score_total = 1, score_grade = 'D', score_json = ? WHERE id = ?")
      .run(JSON.stringify({ total: 1, grade: 'D', score_version: 2 }), scored.id);
    db.close();

    const reopened = new JobStore(path);
    const migrated = reopened.getJob(scored.id);
    assert.equal(migrated?.score.score_version, 6);
    assert.notEqual(migrated?.score.total, 1);
    assert.equal(typeof migrated?.score.job_match_score, 'number');
    reopened.close();
  });
});
