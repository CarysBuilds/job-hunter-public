import { z } from 'zod';
import { appConfig } from '../config.js';
import { getLlmClient } from '../llm/client.js';
import type { RawJob, SemanticAnalysis } from '../types.js';

const TRACKS = ['ai_application', 'ai_solutions', 'ai_product', 'ai_customer_success', 'algorithm_research', 'pure_sales', 'other'] as const;

const tolerantBoolean = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes', 'y', '是', '有', '存在'].includes(value.trim().toLowerCase());
}, z.boolean());

const tolerantStringArray = (max = 20) => z.preprocess((value) => {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : typeof value === 'string' && value.trim()
        ? value.split(/\n|[；;]/)
        : [];
  return values
    .flatMap((item) => typeof item === 'string' ? [item] : item == null ? [] : [String(item)])
    .map((item) => item.replace(/^[-*•\d.、)）\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, max);
}, z.array(z.string()).max(max));

const SemanticSchema = z.object({
  track: z.preprocess((value) => {
    const normalized = String(value ?? '').trim().toLowerCase();
    return TRACKS.includes(normalized as typeof TRACKS[number]) ? normalized : 'other';
  }, z.enum(TRACKS)),
  red_flags: tolerantStringArray().default([]),
  green_flags: tolerantStringArray().default([]),
  is_kitchen_sink: tolerantBoolean.default(false),
  overtime_hint: tolerantBoolean.default(false),
  has_sales_quota: tolerantBoolean.default(false),
  is_fake_ai: tolerantBoolean.default(false),
  evidence: tolerantStringArray(6).default([]),
  summary: z.preprocess((value) => value == null ? '' : String(value), z.string()).default(''),
});

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export function parseSemanticResponse(text: string): SemanticAnalysis | null {
  const json = extractJson(text);
  return json ? SemanticSchema.parse(JSON.parse(json)) : null;
}

export async function analyzeWithLlm(job: RawJob): Promise<SemanticAnalysis | null> {
  const llm = getLlmClient();
  if (!llm) return null;
  try {
    const response = await llm.chat.completions.create({
      model: appConfig.llm.model,
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content: '你是严谨的招聘岗位分类器。只提取语义标签和JD证据，不直接打分，只返回JSON。',
        },
        {
          role: 'user',
          content: `将岗位归类为 ai_solutions、ai_product、ai_customer_success、ai_application、algorithm_research、pure_sales、other 之一。技术售前、PoC、方案演示和交付属于 ai_solutions；AI 产品经理、产品规划、原型和产品落地属于 ai_product；客户成功、培训、上线运营和续费留存属于 ai_customer_success；重编码的应用开发才属于 ai_application；仅在有业绩、获客或客户资源要求时标记销售指标。\n\n标题：${job.title}\n公司：${job.company}\n薪资：${job.salary}\n地点：${job.location}\nJD：\n${job.jd_fulltext}\n\n返回字段：track, red_flags, green_flags, is_kitchen_sink, overtime_hint, has_sales_quota, is_fake_ai, evidence, summary。evidence 只摘录或概括JD中的短证据。`,
        },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? '';
    return parseSemanticResponse(raw);
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')
      : (error as Error).message;
    console.warn(`[LLM] ${job.title} 语义分析降级为规则模式：${detail.slice(0, 240)}`);
    return null;
  }
}
