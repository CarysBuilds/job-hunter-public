import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scoreJob } from '../src/scorer/index.js';
import { exportDataset } from '../src/services/export-service.js';
import { JobStore } from '../src/server/store.js';

async function withStore<T>(callback: (store: JobStore) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'job-hunter-workflow-'));
  const store = new JobStore(join(directory, 'workflow.sqlite'));
  try { return await callback(store); }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}

async function addJob(store: JobStore, title = 'AI解决方案顾问') {
  const job = await scoreJob({
    title, company: '=匿名科技', salary: '20-30K', location: '北京', source: 'boss',
    url: `https://example.com/${encodeURIComponent(title)}`,
    jd_fulltext: '负责企业客户需求调研、AI 解决方案、PoC 演示、项目交付、客户培训和上线复盘。'.repeat(4),
  }, { useLlm: false });
  store.upsertJobs([job]);
  return store.getJob(job.id)!;
}

describe('求职工作流与导出', () => {
  it('事件幂等并投影状态、时间戳和漏斗', async () => withStore(async (store) => {
    const job = await addJob(store);
    const applied = store.recordApplicationEvent({ jobId: job.id, type: 'applied', idempotencyKey: 'apply-once' });
    const duplicate = store.recordApplicationEvent({ jobId: job.id, type: 'applied', idempotencyKey: 'apply-once' });
    assert.equal(applied.id, duplicate.id);
    assert.equal(store.listApplicationEvents(job.id).length, 1);
    assert.equal(store.getJob(job.id)?.contact?.status, 'applied');
    assert.ok(store.getJob(job.id)?.contact?.applied_at);
    store.recordApplicationEvent({ jobId: job.id, type: 'interview_scheduled', idempotencyKey: 'interview-once' });
    const funnel = store.contactFunnel();
    assert.equal(funnel.stages.applied, 1);
    assert.equal(funnel.stages.interviewing, 1);
    assert.equal(funnel.conversion.application_to_interview, 1);
  }));

  it('完整 JD 内容幂等，评分成功后原子激活新版本并保留旧版本', async () => withStore(async (store) => {
    const job = await addJob(store);
    const firstContent = '岗位职责：负责 AI 产品需求分析、客户访谈、产品规划、项目交付和复盘。任职要求：本科，三年以上经验。'.repeat(3);
    const firstScore = await scoreJob({ ...job, jd_fulltext: firstContent }, { useLlm: false });
    const first = store.commitJobContentVersion(job.id, firstScore, firstContent, 'manual_paste');
    const same = store.commitJobContentVersion(job.id, firstScore, firstContent, 'manual_paste');
    assert.equal(first.id, same.id);
    const secondContent = '岗位职责：负责企业 AI 解决方案、PoC、客户培训、实施交付与上线运营。任职要求：本科，三年以上经验。'.repeat(3);
    const secondScore = await scoreJob({ ...job, jd_fulltext: secondContent }, { useLlm: false });
    const second = store.commitJobContentVersion(job.id, secondScore, secondContent, 'manual_paste');
    const versions = store.listJobContentVersions(job.id);
    assert.equal(versions.length, 2);
    assert.equal(versions.find((item) => item.id === second.id)?.active, true);
    assert.equal(versions.find((item) => item.id === first.id)?.active, false);
    assert.equal(store.getJob(job.id)?.jd_fulltext, secondContent);
  }));

  it('CSV 中和公式前缀并携带导出时间和 schema 版本', async () => withStore(async (store) => {
    await addJob(store, '=HYPERLINK("https://bad.invalid")');
    const csv = exportDataset(store, 'jobs', 'csv').body;
    assert.match(csv, /generated_at=/);
    assert.match(csv, /schema_version=2/);
    assert.match(csv, /"'=HYPERLINK/);
    const json = JSON.parse(exportDataset(store, 'contacts', 'json').body);
    assert.equal(json.metadata.schemaVersion, 2);
  }));
});
