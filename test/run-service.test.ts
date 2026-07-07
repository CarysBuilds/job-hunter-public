import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreJob } from '../src/scorer/index.js';
import { selectAutoDetailCandidates } from '../src/services/run-service.js';
import type { Grade, JobSource, RawJob } from '../src/types.js';

function raw(overrides: Partial<RawJob> = {}): RawJob {
  return {
    title: 'AI解决方案顾问',
    company: '测试公司',
    salary: '20-30K',
    location: '深圳',
    source: 'zhaopin',
    url: 'https://www.zhaopin.com/jobdetail/abc.htm',
    jd_fulltext: '职位：AI解决方案顾问\n公司：测试公司\n标签：售前、PoC',
    ...overrides,
  };
}

async function scored(grade: Grade, overrides: Partial<RawJob> = {}) {
  const job = await scoreJob(raw(overrides), { useLlm: false });
  job.score.grade = grade;
  return job;
}

describe('RunService 详情自动补全候选', () => {
  it('只选择指定平台 A/B 且仍是摘要的岗位，并遵守上限', async () => {
    const duplicated = await scored('A', { title: 'A 级智联摘要' });
    const candidates = selectAutoDetailCandidates([
      duplicated,
      duplicated,
      await scored('B', { title: 'B 级智联摘要', url: 'https://www.zhaopin.com/jobdetail/b.htm' }),
      await scored('C', { title: 'C 级不补', url: 'https://www.zhaopin.com/jobdetail/c.htm' }),
      await scored('A', { title: 'BOSS 不补', source: 'boss' as JobSource, url: 'https://www.zhipin.com/job_detail/a.html' }),
      await scored('A', { title: '长 JD 不补', url: 'https://www.zhaopin.com/jobdetail/long.htm', jd_fulltext: '完整职责'.repeat(120) }),
      await scored('A', { title: '短完整 JD 不补', url: 'https://www.zhaopin.com/jobdetail/detail.htm', jd_fulltext: '职位描述\n岗位职责\n负责 AI 售前方案与客户沟通。\n任职要求\n本科以上。' }),
    ], 2);
    assert.deepEqual(candidates.map((job) => job.title), ['A 级智联摘要', 'B 级智联摘要']);
  });

  it('猎聘抓取时只选择猎聘 A/B 候选', async () => {
    const candidates = selectAutoDetailCandidates([
      await scored('A', { title: '智联不补', source: 'zhaopin', url: 'https://www.zhaopin.com/jobdetail/a.htm' }),
      await scored('A', { title: '猎聘 A 补', source: 'liepin', url: 'https://www.liepin.com/job/1982646795.shtml' }),
      await scored('B', { title: '猎聘 B 补', source: 'liepin', url: 'https://www.liepin.com/job/1982646796.shtml' }),
      await scored('C', { title: '猎聘 C 不补', source: 'liepin', url: 'https://www.liepin.com/job/1982646797.shtml' }),
    ], 10, 'liepin');
    assert.deepEqual(candidates.map((job) => job.title), ['猎聘 A 补', '猎聘 B 补']);
  });
});
