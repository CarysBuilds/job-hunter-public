import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_CANDIDATE_PROFILE } from '../src/config.js';
import { scoreWithRules } from '../src/scorer/rules.js';
import type { Grade, JobTrack } from '../src/types.js';

interface GoldCase {
  name: string;
  title: string;
  company: string;
  jd: string;
  track: JobTrack;
  grades: Grade[];
  risk: 'none' | 'soft' | 'hard';
  blockedKeyword?: string;
}

const cases = JSON.parse(readFileSync(new URL('./fixtures/scoring-v7-gold.json', import.meta.url), 'utf8')) as GoldCase[];
const resume = '本科，8年企业软件产品经验，负责产品规划、需求分析、客户访谈、PRD、AI 解决方案、RAG、Agent、PoC、客户培训、项目交付和上线复盘。'.repeat(3);

describe('评分 v7 九项脱敏金标回归', () => {
  for (const item of cases) {
    it(item.name, () => {
      const profile = {
        ...structuredClone(DEFAULT_CANDIDATE_PROFILE),
        education: '本科', experienceYears: 8, salaryFloorK: 15, salaryExpectK: 20,
        locationScore: { 北京: 5 }, targetTracks: ['product', 'ai_product', 'ai_solutions'] as JobTrack[],
        blockedKeywords: item.blockedKeyword ? [item.blockedKeyword] : [],
      };
      const score = scoreWithRules({
        title: item.title, company: item.company, salary: '20-30K', location: '北京', source: 'boss',
        url: `https://example.com/${encodeURIComponent(item.name)}`, jd_fulltext: item.jd,
        experience: '3年以上', education: '本科',
      }, null, profile, null, resume);
      assert.equal(score.score_version, 7);
      assert.equal(score.track, item.track);
      assert.ok(item.grades.includes(score.grade), `实际评级 ${score.grade} 不在金标范围 ${item.grades.join('/')}`);
      assert.equal(score.sales_risk_level, item.risk);
      assert.equal(score.total, score.interview_fit_score);
      assert.ok(score.dimensions.risk_penalty >= -30 && score.dimensions.risk_penalty <= 0);
      if (item.grades.length === 1 && item.grades[0] === 'D') assert.ok(score.grade_cap_reasons.length > 0);
    });
  }
});
