import { existsSync, readFileSync } from 'node:fs';
import { appConfig } from '../config.js';
import { getLlmClient, llmStatus } from '../llm/client.js';
import type { ScoredJob } from '../types.js';

export interface GreetingResult {
  text: string;
  model: string;
}

export interface GreetingGenerator {
  status(): { resumeConfigured: boolean; llmConfigured: boolean; model: string };
  generate(job: ScoredJob): Promise<GreetingResult>;
}

export class ResumeMissingError extends Error {
  constructor() {
    super('尚未上传有效简历，请先在“设置”中上传简历内容');
    this.name = 'ResumeMissingError';
  }
}

export class LlmUnavailableError extends Error {
  constructor() {
    super('模型 API Key 尚未配置，请先在“设置”中填写 API Key');
    this.name = 'LlmUnavailableError';
  }
}

function readResume(): string {
  if (!existsSync(appConfig.candidateResumePath)) throw new ResumeMissingError();
  const resume = readFileSync(appConfig.candidateResumePath, 'utf8').trim();
  if (resume.length < 80) throw new ResumeMissingError();
  return resume.slice(0, 20_000);
}

export function buildGreetingPrompt(resume: string, job: ScoredJob): string {
  return `请基于候选人简历和目标岗位生成一段招聘平台打招呼文案。

要求：
1. 只使用简历中真实存在的经历、成果和技能，禁止编造年限、公司、项目或数字；
2. 结合岗位职责，挑选最相关的 2–3 个匹配点，不要机械罗列关键词；
3. 使用自然、专业、有温度的第一人称中文，控制在 100–160 个汉字；
4. 开头直接说明匹配价值，结尾表达希望进一步沟通；
5. 只输出最终文案，不加标题、引号、分析或 Markdown。

候选人简历：
${resume}

目标岗位：${job.title}
公司：${job.company}
地点：${job.location}
薪资：${job.salary}
岗位职责：
${job.jd_fulltext.slice(0, 12_000)}

系统评分识别的匹配能力：${job.score.matched_skills.join('、') || '无'}
明确能力差距：${job.score.required_gaps.join('、') || '无'}`;
}

export class LlmGreetingService implements GreetingGenerator {
  status() {
    const llm = llmStatus();
    let resumeConfigured = false;
    try {
      resumeConfigured = readResume().length >= 80;
    } catch {
      resumeConfigured = false;
    }
    return { resumeConfigured, llmConfigured: llm.configured, model: llm.model };
  }

  async generate(job: ScoredJob): Promise<GreetingResult> {
    const resume = readResume();
    const client = getLlmClient();
    if (!client) throw new LlmUnavailableError();
    const response = await client.chat.completions.create({
      model: appConfig.llm.model,
      temperature: 0.55,
      max_tokens: 350,
      messages: [
        {
          role: 'system',
          content: '你是严谨的求职沟通顾问。你的首要原则是忠于简历事实，并把候选人的真实优势与岗位需求具体连接。',
        },
        { role: 'user', content: buildGreetingPrompt(resume, job) },
      ],
    });
    const text = response.choices[0]?.message?.content?.trim().replace(/^['“”"]+|['“”"]+$/g, '') ?? '';
    if (text.length < 20) throw new Error('LLM 未返回有效文案');
    return { text: text.slice(0, 500), model: appConfig.llm.model };
  }
}

let singleton: GreetingGenerator | undefined;
export function getGreetingService(): GreetingGenerator {
  singleton ??= new LlmGreetingService();
  return singleton;
}
