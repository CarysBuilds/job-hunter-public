import { appConfig } from '../config.js';
import type {
  CompanyProfile,
  CompanyProfileSource,
  CompanyType,
  CompanyWorkLife,
  RawJob,
} from '../types.js';

const SOURCE_LABELS = { boss: 'BOSS', liepin: '猎聘', zhaopin: '智联' } as const;

export function normalizeCompanyKey(company: string): string {
  return company.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function companySource(company: string, jobs: RawJob[]): CompanyProfileSource[] {
  const sourceJobs = jobs.slice(0, 8);
  return sourceJobs.map((job) => ({
    query: job.source,
    title: `${job.title} · ${job.company}`,
    url: job.url,
    hostname: hostnameOf(job.url),
    description: [
      job.company_industry ? `行业：${job.company_industry}` : '',
      job.company_stage ? `阶段/性质：${job.company_stage}` : '',
      job.company_scale ? `规模：${job.company_scale}` : '',
      job.tags?.length ? `福利/标签：${job.tags.join('、')}` : '',
    ].filter(Boolean).join('；') || `${SOURCE_LABELS[job.source]} 岗位列表与详情信息`,
  }));
}

function inferCompanyType(text: string): CompanyType {
  if (includesAny(text, ['外包', '派遣', '驻场', '人力外包'])) return 'outsourcing';
  if (includesAny(text, ['外企', '外资', '跨国'])) return 'foreign';
  if (includesAny(text, ['上市', '已上市', 'a股', '港股', '美股'])) return 'listed';
  if (includesAny(text, ['10000人以上', '1000-9999人', '成熟', '不需要融资'])) return 'mature';
  if (includesAny(text, ['未融资', '天使轮', 'a轮', 'b轮', 'c轮', '初创'])) return 'startup';
  return 'unknown';
}

function inferWorkLife(text: string): CompanyWorkLife {
  if (includesAny(text, ['大小周'])) return 'big_small_week';
  if (includesAny(text, ['单休', '每周休一天'])) return 'single_day_off';
  if (includesAny(text, ['996', '长期加班', '经常加班', '强制加班'])) return 'overtime_risk';
  if (includesAny(text, ['双休', '周末双休', '做五休二'])) return 'weekends';
  if (includesAny(text, ['加班补助', '节假日加班费', '夜班补助'])) return 'overtime_risk';
  return 'unknown';
}

function scaleScore(text: string): { delta: number; flag?: string } {
  if (includesAny(text, ['10000人以上', '万人以上'])) return { delta: 8, flag: '平台显示万人以上规模' };
  if (includesAny(text, ['1000-9999人', '1000人以上'])) return { delta: 6, flag: '平台显示千人以上规模' };
  if (includesAny(text, ['500-999人', '500人以上'])) return { delta: 4, flag: '平台显示中大型团队规模' };
  if (includesAny(text, ['100-499人'])) return { delta: 2, flag: '平台显示百人以上规模' };
  if (includesAny(text, ['0-20人', '20人以下'])) return { delta: -4, flag: '平台显示团队规模较小' };
  return { delta: 0 };
}

export function buildBossCompanyProfile(company: string, jobs: RawJob[], now = new Date()): CompanyProfile {
  const displayName = company.trim() || '未知公司';
  const platformLabel = unique(jobs.map((job) => SOURCE_LABELS[job.source])).join('/') || '平台';
  const text = jobs.map((job) => [
    job.company,
    job.company_industry,
    job.company_stage,
    job.company_scale,
    job.recruiter_title,
    ...(job.tags ?? []),
    job.jd_fulltext,
  ].filter(Boolean).join(' ')).join(' ').normalize('NFKC').toLowerCase();
  const greenFlags = new Set<string>();
  const redFlags = new Set<string>();
  const score = 70;

  const companyType = inferCompanyType(text);
  const workLife = inferWorkLife(text);
  const scale = scaleScore(text);
  if (scale.flag && scale.delta > 0) greenFlags.add(scale.flag);
  if (scale.flag && scale.delta < 0) redFlags.add(scale.flag);

  if (companyType === 'foreign') {
    greenFlags.add(`${platformLabel}信息显示外企/外资信号`);
  } else if (companyType === 'listed') {
    greenFlags.add(`${platformLabel}信息显示上市或成熟公司信号`);
  } else if (companyType === 'mature') {
    greenFlags.add(`${platformLabel}信息显示成熟公司信号`);
  } else if (companyType === 'startup') {
    redFlags.add(`${platformLabel}信息显示融资阶段较早或不确定`);
  } else if (companyType === 'outsourcing') {
    redFlags.add(`${platformLabel}信息显示外包、派遣或驻场风险`);
  }

  if (workLife === 'weekends') {
    greenFlags.add(`${platformLabel}信息出现双休信号`);
  } else if (workLife === 'big_small_week') {
    redFlags.add(`${platformLabel}信息出现大小周信号`);
  } else if (workLife === 'single_day_off') {
    redFlags.add(`${platformLabel}信息出现单休信号`);
  } else if (workLife === 'overtime_risk') {
    redFlags.add(`${platformLabel}福利或 JD 出现加班补助/夜班/高强度信号`);
  }

  if (includesAny(text, ['五险一金'])) {
    greenFlags.add(`${platformLabel}福利包含五险一金`);
  }
  if (includesAny(text, ['带薪年假'])) {
    greenFlags.add(`${platformLabel}福利包含带薪年假`);
  }
  if (includesAny(text, ['补充医疗保险', '定期体检', '免费班车', '餐补', '住房补贴'])) {
    greenFlags.add(`${platformLabel}福利完整度较好`);
  }
  if (includesAny(text, ['销售kpi', '销售指标', '业绩指标', '底薪加提成'])) {
    redFlags.add(`${platformLabel}信息出现销售或提成压力信号`);
  }

  const sources = companySource(displayName, jobs);
  const sourceFacts = unique([
    ...jobs.flatMap((job) => [job.company_industry ?? '', job.company_stage ?? '', job.company_scale ?? '']),
  ]);
  const confidence = Math.min(1, 0.35 + sources.length * 0.1 + sourceFacts.length * 0.08);
  const researchedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + appConfig.companyResearch.ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const positives = greenFlags.size ? `正向信号：${[...greenFlags].slice(0, 3).join('、')}` : '正向信号不足';
  const risks = redFlags.size ? `风险信号：${[...redFlags].slice(0, 3).join('、')}` : '暂无明确高风险信号';
  const facts = sourceFacts.length ? `${platformLabel}字段：${sourceFacts.join('、')}` : `${platformLabel}未提供规模/阶段/行业字段`;

  return {
    company_key: normalizeCompanyKey(displayName),
    display_name: displayName,
    quality_score: Math.max(0, Math.min(100, Math.round(score))),
    company_type: companyType,
    work_life: workLife,
    reputation_summary: `${facts}；${positives}；${risks}`,
    green_flags: [...greenFlags],
    red_flags: [...redFlags],
    sources,
    confidence,
    researched_at: researchedAt,
    expires_at: expiresAt,
  };
}

export function neutralCompanyProfile(displayName: string, now = new Date(), lastError?: string): CompanyProfile {
  const researchedAt = now.toISOString();
  return {
    company_key: normalizeCompanyKey(displayName),
    display_name: displayName,
    quality_score: 70,
    company_type: 'unknown',
    work_life: 'unknown',
    reputation_summary: lastError ? `平台公司画像不足，按中性分计算：${lastError}` : '平台公司画像不足，按中性分计算',
    green_flags: [],
    red_flags: [],
    sources: [],
    confidence: 0,
    researched_at: researchedAt,
    expires_at: new Date(now.getTime() + appConfig.companyResearch.ttlDays * 24 * 60 * 60 * 1000).toISOString(),
    last_error: lastError,
  };
}

export class CompanyProfileService {
  build(company: string, jobs: RawJob[], now = new Date()): CompanyProfile {
    return jobs.length ? buildBossCompanyProfile(company, jobs, now) : neutralCompanyProfile(company, now, '同公司岗位为空');
  }
}

let singleton: CompanyProfileService | undefined;
export function getCompanyProfileService(): CompanyProfileService {
  singleton ??= new CompanyProfileService();
  return singleton;
}
