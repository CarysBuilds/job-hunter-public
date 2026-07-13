import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSemanticPrompt, parseSemanticResponse } from '../src/scorer/llm.js';
import type { RawJob } from '../src/types.js';

describe('LLM 语义输出归一化', () => {
  it('岗位匹配提示词要求只依据简历证据且覆盖通用方向', () => {
    const job = {
      title: 'Java工程师', company: '示例公司', salary: '20-30K', location: '北京',
      source: 'boss', url: '', jd_fulltext: '需要 Java 和 Spring Boot。',
    } satisfies RawJob;
    const prompt = buildSemanticPrompt(job, '候选人简历包含 Java 项目经验。');
    assert.match(prompt, /只有简历明确出现/);
    assert.match(prompt, /engineering/);
    assert.match(prompt, /候选人简历包含 Java 项目经验/);
  });
  it('兼容字符串布尔值、字符串证据和对象证据', () => {
    const parsed = parseSemanticResponse(JSON.stringify({
      track: 'ai_application',
      red_flags: '',
      green_flags: '技术栈明确；业务场景真实',
      is_kitchen_sink: 'false',
      overtime_hint: null,
      has_sales_quota: '否',
      is_fake_ai: 0,
      evidence: { stack: '包含 RAG 与 Agent', delivery: '强调真实落地' },
      summary: 'AI Agent 应用岗位',
      capability_score: '18',
      matched_skills: ['RAG', '客户沟通'],
      required_gaps: ['Kubernetes'],
      capability_evidence: ['简历包含 RAG 项目，JD 要求 RAG'],
    }));

    assert.ok(parsed);
    assert.equal(parsed.track, 'ai_application');
    assert.equal(parsed.overtime_hint, false);
    assert.equal(parsed.has_sales_quota, false);
    assert.deepEqual(parsed.green_flags, ['技术栈明确', '业务场景真实']);
    assert.deepEqual(parsed.evidence, ['包含 RAG 与 Agent', '强调真实落地']);
    assert.equal(parsed.capability_score, 18);
    assert.deepEqual(parsed.matched_skills, ['RAG', '客户沟通']);
  });

  it('从 Markdown JSON 代码块提取结果并补齐缺省字段', () => {
    const parsed = parseSemanticResponse('```json\n{"track":"unknown","summary":null}\n```');
    assert.ok(parsed);
    assert.equal(parsed.track, 'other');
    assert.equal(parsed.summary, '');
    assert.deepEqual(parsed.evidence, []);
    assert.equal(parsed.capability_score, 0);
    assert.deepEqual(parsed.matched_skills, []);
  });
});
