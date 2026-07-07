import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreJob } from '../src/scorer/index.js';
import { buildGreetingPrompt } from '../src/services/greeting-service.js';

describe('打招呼文案提示词', () => {
  it('包含简历、JD 与禁止编造约束', async () => {
    const job = await scoreJob({
      title: 'AI Agent工程师', company: '测试科技', salary: '20-30K', location: '深圳',
      source: 'boss', url: 'https://example.com/job',
      jd_fulltext: '负责 RAG、Agent、Python 和工作流的产品落地。',
    }, { useLlm: false });
    const prompt = buildGreetingPrompt('候选人拥有 Python 自动化与数据分析项目经验，完成过业务流程优化。', job);
    assert.match(prompt, /候选人拥有 Python 自动化/);
    assert.match(prompt, /负责 RAG、Agent/);
    assert.match(prompt, /禁止编造/);
    assert.match(prompt, /100–160/);
  });
});
