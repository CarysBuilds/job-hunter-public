import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSemanticResponse } from '../src/scorer/llm.js';

describe('LLM 语义输出归一化', () => {
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
    }));

    assert.ok(parsed);
    assert.equal(parsed.track, 'ai_application');
    assert.equal(parsed.overtime_hint, false);
    assert.equal(parsed.has_sales_quota, false);
    assert.deepEqual(parsed.green_flags, ['技术栈明确', '业务场景真实']);
    assert.deepEqual(parsed.evidence, ['包含 RAG 与 Agent', '强调真实落地']);
  });

  it('从 Markdown JSON 代码块提取结果并补齐缺省字段', () => {
    const parsed = parseSemanticResponse('```json\n{"track":"unknown","summary":null}\n```');
    assert.ok(parsed);
    assert.equal(parsed.track, 'other');
    assert.equal(parsed.summary, '');
    assert.deepEqual(parsed.evidence, []);
  });
});
