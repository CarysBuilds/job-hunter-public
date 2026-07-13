import type {
  CandidateProfile,
  CompanyProfile,
  Grade,
  JobScore,
  JobTrack,
  RawJob,
  SalaryRange,
  ScoreEvidence,
  SemanticAnalysis,
} from '../types.js';
import { getCandidateProfile } from './profile.js';
import { CAPABILITY_GROUPS } from './capability-dictionary.js';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ');
const hasAny = (text: string, values: string[]) => values.some((value) => text.includes(value.toLowerCase()));

const SOLUTION_KEYWORDS = ['解决方案', '售前', '技术顾问', '咨询顾问', '方案架构', '方案设计', '交付', '实施', 'poc', 'demo', '演示', '投标'];
const PRODUCT_KEYWORDS = ['产品经理', 'ai产品', '产品负责人', '产品专家', '产品顾问', '产品运营', '产品策划', '产品设计', '产品规划'];
const CUSTOMER_SUCCESS_KEYWORDS = ['客户成功', '客户体验', '客户运营', '客户培训', '客户服务', '上线运营', '续费', '留存'];
const SALES_KEYWORDS = ['销售', '客户经理', '商务拓展', '业务拓展', 'bd'];
const ENGINEERING_TITLE_KEYWORDS = ['开发', '工程师', '后端', '前端', '全栈', '架构师', '研发'];
const EXPLICIT_AI_KEYWORDS = ['ai', '人工智能', '大模型', 'llm', 'aigc', 'agent', '智能体', 'rag', 'prompt', 'dify', 'coze', '扣子'];
const NON_FULL_TIME_FIELD_PATTERN = /实习|兼职|在校|校招|应届|应届生|应届毕业|毕业生|暑期|寒假|可转正|留用|202[6-9]届|2[6-9]届/i;
const NON_FULL_TIME_JD_PATTERN = /实习生|实习岗位|实习职位|实习招聘|实习机会|实习期|实习转正|可转正|暑期实习|寒假实习|长期实习|短期实习|全职实习|每周.{0,8}(?:到岗|出勤).{0,8}\d+\s*天|\d+\s*天.{0,8}(?:到岗|出勤)|在校生|在校学生/i;
const NON_MONTHLY_SALARY_PATTERN = /(?:元\s*\/\s*(?:天|日|时|小时)|日薪|天薪|时薪|周薪)/i;

export function isHeadhunterJob(job: RawJob): boolean {
  if (job.is_headhunter) return true;
  const recruiter = `${job.recruiter_title ?? ''} ${(job.tags ?? []).join(' ')}`;
  return /猎头|寻访顾问|招聘顾问|人才顾问|headhunter/i.test(recruiter);
}

export function parseSalary(salary: string): SalaryRange | null {
  if (!salary.trim()) return null;
  const normalized = salary.replace(/,/g, '').replace(/—/g, '-');

  const annual = normalized.match(/(\d+(?:\.\d+)?)\s*[-~–]\s*(\d+(?:\.\d+)?)\s*万\s*\/\s*年/);
  if (annual) {
    return { minK: Number(annual[1]) * 10 / 12, maxK: Number(annual[2]) * 10 / 12, months: 12 };
  }

  const wan = normalized.match(/(\d+(?:\.\d+)?)\s*[-~–]\s*(\d+(?:\.\d+)?)\s*万(?:\s*\/\s*月)?/);
  if (wan) return { minK: Number(wan[1]) * 10, maxK: Number(wan[2]) * 10 };

  const range = normalized.match(/(\d+(?:\.\d+)?)\s*[kK千]?\s*[-~–]\s*(\d+(?:\.\d+)?)\s*[kK千]/);
  if (range) {
    const months = normalized.match(/[·x×*](\d{2})薪/i)?.[1];
    return { minK: Number(range[1]), maxK: Number(range[2]), months: months ? Number(months) : undefined };
  }

  const single = normalized.match(/(\d+(?:\.\d+)?)\s*[kK千]/);
  if (single) {
    const value = Number(single[1]);
    return { minK: value, maxK: value };
  }
  return null;
}

export function parseExperience(job: RawJob): [number, number] | null {
  const text = `${job.experience ?? ''} ${job.jd_fulltext}`;
  if (/经验不限|不限经验|应届生|应届毕业/.test(text)) return [0, 99];
  const range = text.match(/(\d+)\s*[-~–]\s*(\d+)\s*年/);
  if (range) return [Number(range[1]), Number(range[2])];
  const minimum = text.match(/(\d+)\s*(?:年及以上|年以上|年\+)/);
  if (minimum) return [Number(minimum[1]), 99];
  return null;
}

function classifyTrack(job: RawJob, semantic?: SemanticAnalysis | null): JobTrack {
  if (semantic?.track && semantic.track !== 'other') return semantic.track;
  const title = normalize(job.title);
  const text = normalize(`${job.title} ${job.jd_fulltext}`);
  const hasAi = hasAny(text, ['ai', '大模型', 'llm', 'aigc', 'agent', '智能体', 'rag']);
  const algorithm = hasAny(title, ['算法', '机器学习', '深度学习', '模型训练', '训练工程师', 'ai训练', '模型工程师', '研究员']);
  const solution = hasAny(text, SOLUTION_KEYWORDS);
  const product = hasAny(text, PRODUCT_KEYWORDS);
  const customerSuccess = hasAny(text, CUSTOMER_SUCCESS_KEYWORDS);
  const sales = hasAny(title, SALES_KEYWORDS);
  const application = hasAny(text, ['agent', '智能体', 'rag', '大模型应用', 'ai应用', 'llm应用'])
    || (hasAi && hasAny(title, ENGINEERING_TITLE_KEYWORDS));
  if (algorithm && !application) return 'algorithm_research';
  if (sales && !solution && !customerSuccess) return 'pure_sales';
  if (product && hasAi) return 'ai_product';
  if (customerSuccess && hasAi) return 'ai_customer_success';
  if (solution && hasAi) return 'ai_solutions';
  if (application) return 'ai_application';
  if (product) return 'product';
  if (hasAny(title, ['运营', '内容', '增长', '用户运营', '活动策划'])) return 'operations';
  if (hasAny(title, ['设计师', '视觉设计', '交互设计', 'ui', 'ux'])) return 'design';
  if (hasAny(title, ['数据分析', '数据科学', '商业分析', 'bi'])) return 'data';
  if (hasAny(title, ENGINEERING_TITLE_KEYWORDS)) return 'engineering';
  if (solution) return 'consulting';
  if (customerSuccess || hasAny(title, ['客服', '客户服务', '售后'])) return 'customer_service';
  return 'other';
}

function targetMatchesTrack(targets: JobTrack[], track: JobTrack): boolean {
  const families: Partial<Record<JobTrack, JobTrack[]>> = {
    product: ['product', 'ai_product'],
    engineering: ['engineering', 'ai_application'],
    data: ['data', 'algorithm_research'],
    consulting: ['consulting', 'ai_solutions'],
    customer_service: ['customer_service', 'ai_customer_success'],
  };
  return targets.some((target) => target === track || families[target]?.includes(track));
}

function scoreRole(_job: RawJob, track: JobTrack, profile: CandidateProfile): { score: number; evidence: string[] } {
  if (targetMatchesTrack(profile.targetTracks, track)) {
    return { score: 30, evidence: ['岗位方向属于当前用户画像的目标方向'] };
  }
  return { score: 10, evidence: ['岗位方向未被选为当前目标方向'] };
}

function hasPriorityWork(text: string): boolean {
  return hasAny(text, [...SOLUTION_KEYWORDS, ...PRODUCT_KEYWORDS, ...CUSTOMER_SUCCESS_KEYWORDS, '需求分析', '业务分析', '客户沟通', '培训']);
}

function hasExplicitAiEvidence(text: string): boolean {
  const normalized = normalize(text);
  return /\bai\b/i.test(normalized) || hasAny(normalized, EXPLICIT_AI_KEYWORDS.filter((keyword) => keyword !== 'ai'));
}

function isNonFullTimeJob(job: RawJob): boolean {
  const primaryFields = normalize(`${job.title} ${job.experience ?? ''} ${(job.tags ?? []).join(' ')}`);
  if (NON_FULL_TIME_FIELD_PATTERN.test(primaryFields)) return true;
  if (NON_MONTHLY_SALARY_PATTERN.test(job.salary)) return true;
  return NON_FULL_TIME_JD_PATTERN.test(normalize(job.jd_fulltext));
}

const TERM_STOP_WORDS = new Set([
  '负责', '工作', '岗位', '职位', '公司', '相关', '能力', '经验', '要求', '熟悉', '掌握', '具备', '优先',
  '以及', '进行', '完成', '参与', '能够', '良好', '较强', '以上', '以下', '至少', '包括', '不限', '需要',
  '通过', '根据', '提供', '支持', '推动', '协助', '团队', '业务', '项目', '产品', '客户', '任职', '职责',
]);

function extractResumeTerms(text: string): string[] {
  const segments = [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text.toLowerCase())]
    .filter((item) => item.isWordLike)
    .map((item) => item.segment.trim())
    .filter((item) => item.length >= 2 && !TERM_STOP_WORDS.has(item) && /[a-z\u4e00-\u9fff]/i.test(item));
  const terms = new Set(segments);
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (/^[\u4e00-\u9fff]+$/.test(previous + current) && previous.length + current.length <= 10) {
      terms.add(previous + current);
    }
  }
  return [...terms];
}

function normalizeCapabilityText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsCapabilityKeyword(text: string, keyword: string): boolean {
  const normalizedText = normalizeCapabilityText(text);
  const normalizedKeyword = normalizeCapabilityText(keyword);
  if (/^[a-z0-9+#./ -]+$/i.test(normalizedKeyword)) {
    const pattern = normalizedKeyword
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s*');
    return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, 'i').test(normalizedText);
  }
  return normalizedText.replace(/\s+/g, '').includes(normalizedKeyword.replace(/\s+/g, ''));
}

function keywordHits(text: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => containsCapabilityKeyword(text, keyword));
}

function localResumeCapability(job: RawJob, resume: string) {
  const jobText = `${job.title}\n${job.jd_fulltext}\n${(job.tags ?? []).join('\n')}`;
  const groupMatches = CAPABILITY_GROUPS.flatMap((group) => {
    const resumeHits = keywordHits(resume, group.keywords);
    const jobHits = keywordHits(jobText, group.keywords);
    // 同一能力组两侧各有明确关键词即可归为类别匹配，例如
    // “需求管理”（简历）与“需求分析/PRD”（JD）都属于产品能力。
    if (!resumeHits.length || !jobHits.length) return [];
    return [{
      label: group.label,
      points: group.points,
      evidence: `${group.label}：简历命中“${resumeHits.slice(0, 3).join('、')}”；JD 命中“${jobHits.slice(0, 3).join('、')}”`,
    }];
  });
  const resumeTerms = new Set(extractResumeTerms(resume));
  const candidates = new Set(extractResumeTerms(jobText.toLowerCase()));
  for (const tag of job.tags ?? []) {
    const normalizedTag = tag.trim().toLowerCase();
    if (normalizedTag.length >= 2) candidates.add(normalizedTag);
  }
  const directMatches = [...candidates]
    .filter((term) => resumeTerms.has(term) || resume.toLowerCase().includes(term))
    .sort((a, b) => b.length - a.length)
    .filter((term, index, values) => !values.slice(0, index).some((selected) => selected.includes(term)))
    .filter((term) => !groupMatches.some((group) => group.evidence.toLowerCase().includes(term)))
    .slice(0, Math.max(0, 8 - groupMatches.length));
  const matched = [...groupMatches.map((group) => group.label), ...directMatches].slice(0, 8);
  const score = clamp(
    groupMatches.reduce((total, group) => total + group.points, 0)
      + directMatches.reduce((total, term) => total + (term.length >= 4 ? 3 : 2), 0),
    0,
    25
  );
  return {
    score,
    matched,
    requiredGaps: [] as string[],
    evidence: matched.length
      ? [...groupMatches.map((group) => group.evidence), `本地模式共确认 ${matched.length} 项能力；未调用模型时不推断隐含能力差距`]
      : ['已读取简历，但未找到可直接确认的简历与 JD 能力重合词'],
    insufficient: [] as string[],
    mode: 'local' as const,
  };
}

function scoreCapabilities(job: RawJob, semantic: SemanticAnalysis | null, resume: string | null) {
  if (!resume) {
    return {
      score: 0,
      matched: [] as string[],
      requiredGaps: [] as string[],
      evidence: ['未上传简历，能力匹配不加分；请上传简历后重新评分'],
      insufficient: ['需上传简历后进行能力匹配'],
      mode: 'none' as const,
    };
  }
  if (semantic && (semantic.capability_score > 0 || semantic.matched_skills.length || semantic.capability_evidence.length)) {
    return {
      score: clamp(semantic.capability_score, 0, 25),
      matched: semantic.matched_skills.slice(0, 8),
      requiredGaps: semantic.required_gaps.slice(0, 8),
      evidence: semantic.capability_evidence,
      insufficient: [] as string[],
      mode: 'llm' as const,
    };
  }
  return localResumeCapability(job, resume);
}

function educationRank(text: string): number | null {
  if (/博士|phd/i.test(text)) return 4;
  if (/硕士|研究生|master/i.test(text)) return 3;
  if (/本科|学士|bachelor/i.test(text)) return 2;
  if (/大专|专科|college/i.test(text)) return 1;
  if (/高中|中专/.test(text)) return 0;
  return null;
}

function scoreThreshold(job: RawJob, profile: CandidateProfile, resume: string | null): { score: number; evidence: string[]; insufficient: string[]; nonFullTime: boolean } {
  const evidence: string[] = [];
  const insufficient: string[] = [];
  const experience = parseExperience(job);
  let experienceScore = 0;
  const comfortableYears = Math.max(3, profile.experienceYears - 3);
  const nonFullTime = isNonFullTimeJob(job);
  const acceptsEarlyCareer = profile.careerStage === 'internship' || profile.careerStage === 'new_grad';
  if (nonFullTime && !acceptsEarlyCareer) {
    experienceScore = 0;
    evidence.push('实习、校招或兼职岗位，不符合当前求职阶段');
  } else if (nonFullTime && acceptsEarlyCareer) {
    experienceScore = 9;
    evidence.push('岗位符合当前实习/应届求职阶段');
  } else if (!experience) {
    insufficient.push('工作年限未明确');
    evidence.push('岗位工作年限未知，经验匹配不加分');
  } else if (experience[0] <= comfortableYears) {
    experienceScore = 10;
    evidence.push(`经验门槛在用户填写的 ${profile.experienceYears} 年经验范围内`);
  } else if (experience[0] <= profile.experienceYears) {
    experienceScore = 8;
    evidence.push(`经验要求不超过 ${profile.experienceYears} 年，可正常申请`);
  } else if (experience[0] <= profile.experienceYears + 2) {
    experienceScore = 4;
    evidence.push('经验要求略高于当前画像，需要核对是否要求同岗位年限');
  } else {
    experienceScore = 0;
    evidence.push('经验或管理年限要求明显过高');
  }

  const requirementText = `${job.education ?? ''} ${job.jd_fulltext}`;
  const candidateText = `${profile.education === '未配置' ? '' : profile.education} ${resume ?? ''}`;
  const requiredEducation = educationRank(requirementText);
  const candidateEducation = educationRank(candidateText);
  let educationScore = 0;
  if (candidateEducation === null) {
    insufficient.push('简历中未识别到学历，学历匹配不加分');
    evidence.push('缺少候选人学历证据，未推断学历匹配');
  } else if (requiredEducation === null) {
    insufficient.push('岗位学历要求未明确');
    evidence.push('岗位学历要求未知，学历匹配不加分');
  } else if (candidateEducation >= requiredEducation) {
    educationScore = 5;
    evidence.push('简历学历满足岗位明确要求');
  } else {
    evidence.push('简历学历低于岗位明确要求');
  }

  return { score: experienceScore + educationScore, evidence, insufficient, nonFullTime };
}

function scoreConditions(job: RawJob, profile: CandidateProfile) {
  const evidence: string[] = [];
  const insufficient: string[] = [];
  const salary = parseSalary(job.salary);
  let salaryScore = 0;
  if (!salary) {
    const nonMonthlySalary = /(?:元\s*\/\s*(?:天|日|时|小时)|日薪|天薪|时薪|周薪)/i.test(job.salary);
    if (nonMonthlySalary) {
      insufficient.push('非月薪制，未纳入正式岗月薪比较');
      evidence.push('薪资为非月薪制，未推断月薪匹配');
    } else {
      insufficient.push('薪资未明确');
      evidence.push('薪资未知，薪资匹配不加分');
    }
  } else {
    const midpoint = (salary.minK + salary.maxK) / 2;
    if (profile.salaryExpectK <= 0 && profile.salaryFloorK <= 0) {
      salaryScore = 0;
      insufficient.push('未填写期望薪资，薪资匹配不加分');
      evidence.push('缺少薪资偏好，未推断薪资匹配');
    }
    else if (midpoint >= profile.salaryExpectK) salaryScore = 10;
    else if (midpoint >= profile.salaryFloorK) salaryScore = 7;
    else if (salary.maxK >= profile.salaryFloorK) salaryScore = 5;
    else salaryScore = 0;
    evidence.push(`月薪区间约 ${salary.minK.toFixed(1)}–${salary.maxK.toFixed(1)}K`);
  }

  let locationScore = 0;
  for (const [city, points] of Object.entries(profile.locationScore)) {
    if (job.location.includes(city)) locationScore = Math.max(locationScore, points);
  }
  if (/远程|remote|居家办公/i.test(`${job.location} ${job.jd_fulltext}`)) {
    locationScore = Math.max(locationScore, 4);
    evidence.push('支持远程办公');
  } else if (!job.location.trim()) {
    locationScore = 2;
    insufficient.push('工作地点未明确');
  } else if (locationScore > 0) {
    evidence.push(`地点 ${job.location} 符合偏好`);
  } else {
    evidence.push(`地点 ${job.location} 不在优先城市`);
  }
  return { score: salaryScore + locationScore, salary, evidence, insufficient };
}

function scoreQuality(job: RawJob) {
  const text = normalize(`${job.title} ${job.jd_fulltext}`);
  const concreteAi = ['agent', '智能体', 'rag', '知识库', 'llm', '大模型', 'prompt', 'dify', 'coze', '扣子', '工作流']
    .filter((keyword) => text.includes(keyword)).length;
  const length = job.jd_fulltext.trim().length;
  const clarity = length >= 500 ? 5 : length >= 250 ? 4 : length >= 100 ? 2 : 1;
  const responsibilitySignals = ['负责', '职责', '目标', '交付', '产出', '协作', '推进', '完成', '优化', '设计', '分析']
    .filter((keyword) => text.includes(keyword)).length;
  const specificity = clamp(responsibilitySignals, 0, 4);
  const completeness = [job.salary, job.location, job.experience, job.education]
    .filter((value) => Boolean(value?.trim())).length;
  const structured = (job.tags?.length ?? 0) >= 3 || /\d+\s*[-–]\s*\d+\s*年|本科|硕士|博士|大专/.test(text) ? 2 : 0;
  const evidence = [
    clarity >= 3 ? 'JD 职责描述较清晰' : 'JD 信息较少',
    completeness >= 3 ? '薪资、地点、经验或学历信息较完整' : '岗位基础信息不够完整',
  ];
  if (specificity >= 3) evidence.push('职责和预期产出较具体');
  return { score: clamp(clarity + specificity + completeness + structured, 0, 15), evidence, concreteAi };
}

function scoreRisks(
  job: RawJob,
  track: JobTrack,
  semantic: SemanticAnalysis | null | undefined,
  concreteAi: number,
  salesIsTarget: boolean
) {
  const text = normalize(`${job.title} ${job.jd_fulltext}`);
  const redFlags = new Set<string>();
  const greenFlags = new Set<string>();
  let penalty = 0;

  if (/996|大小周|长期加班|经常加班|承受.*压力|强抗压/.test(text) || semantic?.overtime_hint) {
    redFlags.add('存在明确加班或强压信号（仅提示，未配置作息偏好时不扣分）');
  }
  if (/外包|劳务派遣|驻场开发|长期驻场/.test(text)) {
    redFlags.add('外包、派遣或长期驻场信号（仅提示，未配置公司偏好时不扣分）');
  }
  const negatedQuota = /(?:不承担|无需|没有|无)(?:任何)?(?:销售)?(?:业绩)?(?:指标|kpi)/.test(text);
  const quotaText = text.replace(/(?:不承担|无需|没有|无)(?:任何)?(?:销售)?(?:业绩)?(?:指标|kpi)/g, '');
  const hasSalesQuota = /销售指标|业绩指标|销售kpi|获客|自带客户|客户资源|业绩目标|签单|回款|成交|销售额|提成|商务谈判|客户开拓|市场拓展|商机转化/.test(quotaText)
    || Boolean(semantic?.has_sales_quota && !negatedQuota);
  const hasSalesQuotaMismatch = hasSalesQuota && track !== 'pure_sales' && !salesIsTarget;
  if (hasSalesQuotaMismatch) {
    penalty -= 10;
    redFlags.add('岗位包含销售指标，但未归类为销售目标方向');
  }
  const domains = ['前端', '后端', '运维', '测试', '产品', '运营', '设计', '销售'];
  const domainHits = domains.filter((domain) => text.includes(domain));
  if (domainHits.length >= 5 || semantic?.is_kitchen_sink) {
    penalty -= 6;
    redFlags.add('职责跨度过大，疑似全能杂役岗');
  }
  const claimsAi = hasAny(text, ['ai', '人工智能', '大模型', 'aigc']);
  const hasSolutionWork = hasPriorityWork(text);
  if (track !== 'pure_sales' && ((claimsAi && concreteAi === 0 && !hasSolutionWork) || semantic?.is_fake_ai)) {
    penalty -= 5;
    redFlags.add('AI 内容空泛，可能仅使用概念包装');
  }
  semantic?.red_flags.forEach((flag) => redFlags.add(flag));
  semantic?.green_flags.forEach((flag) => greenFlags.add(flag));

  return {
    penalty: clamp(penalty, -30, 0),
    redFlags: [...redFlags],
    greenFlags: [...greenFlags],
    hasSalesQuota: hasSalesQuotaMismatch,
  };
}

function gradeFor(
  total: number,
  lowSalary: boolean,
  nonFullTime: boolean,
  headhunter: boolean,
  hasSalesQuota: boolean,
  lacksJdAiEvidence: boolean
): Grade {
  if (headhunter) return 'C';
  let grade: Grade = total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 45 ? 'C' : 'D';
  if (lacksJdAiEvidence && (grade === 'A' || grade === 'B')) grade = 'C';
  if ((lowSalary || nonFullTime) && (grade === 'A' || grade === 'B')) grade = 'C';
  if (hasSalesQuota && (grade === 'A' || grade === 'B')) grade = 'C';
  return grade;
}

export function scoreWithRules(
  job: RawJob,
  semantic: SemanticAnalysis | null = null,
  profile: CandidateProfile = getCandidateProfile(),
  companyProfile: CompanyProfile | null = null,
  resume: string | null = null
): JobScore {
  const track = classifyTrack(job, semantic);
  const role = scoreRole(job, track, profile);
  const capability = scoreCapabilities(job, semantic, resume);
  const threshold = scoreThreshold(job, profile, resume);
  const condition = scoreConditions(job, profile);
  const quality = scoreQuality(job);
  const risk = scoreRisks(job, track, semantic, quality.concreteAi, targetMatchesTrack(profile.targetTracks, 'pure_sales'));
  const positive = role.score + capability.score + threshold.score + condition.score + quality.score;
  const jobMatchScore = clamp(positive + risk.penalty, 0, 100);
  const companyQualityScore = 70;
  const total = clamp(Math.round(jobMatchScore * 0.7 + companyQualityScore * 0.3), 0, 100);
  const lowSalary = Boolean(condition.salary && condition.salary.maxK < profile.salaryFloorK);
  const headhunter = isHeadhunterJob(job);
  const aiTracks: JobTrack[] = ['ai_application', 'ai_solutions', 'ai_product', 'ai_customer_success', 'algorithm_research'];
  const lacksJdAiEvidence = aiTracks.includes(track) && !hasExplicitAiEvidence(normalize(job.jd_fulltext));
  const earlyCareer = profile.careerStage === 'internship' || profile.careerStage === 'new_grad';
  const grade = gradeFor(total, lowSalary, threshold.nonFullTime && !earlyCareer, headhunter, risk.hasSalesQuota, lacksJdAiEvidence);
  const insufficient = [...capability.insufficient, ...threshold.insufficient, ...condition.insufficient];
  if (!companyProfile || companyProfile.confidence === 0) insufficient.push('公司公开画像不足，按中性公司分计算');
  const companyGreenFlags = companyProfile?.green_flags ?? [];
  const companyRedFlags = companyProfile?.red_flags ?? [];
  const evidence: ScoreEvidence[] = [
    ...role.evidence.map((text) => ({ category: 'role' as const, text })),
    ...capability.evidence.map((text) => ({ category: 'capability' as const, text })),
    ...threshold.evidence.map((text) => ({ category: 'threshold' as const, text })),
    ...condition.evidence.map((text) => ({ category: 'condition' as const, text })),
    ...quality.evidence.map((text) => ({ category: 'quality' as const, text })),
    ...(lacksJdAiEvidence ? [{
      category: 'risk' as const,
      text: 'JD 未出现明确 AI、大模型、Agent、RAG 或智能体内容，最高按 C 级处理',
    }] : []),
    ...(companyProfile ? [{
      category: 'company' as const,
      text: `公司信号暂按中性分 ${companyQualityScore} 计算：${companyProfile.reputation_summary}`,
    }] : []),
    ...companyRedFlags.map((text) => ({ category: 'company' as const, text })),
    ...risk.redFlags.map((text) => ({ category: 'risk' as const, text })),
    ...(headhunter ? [{ category: 'threshold' as const, text: '猎头发布岗位，按个人偏好统一归为 C 级' }] : []),
    ...(semantic?.evidence ?? []).map((text) => ({ category: 'role' as const, text })),
  ];
  const trackLabel: Record<JobTrack, string> = {
    ai_application: 'AI 应用/Agent',
    ai_solutions: 'AI 技术解决方案',
    ai_product: 'AI 产品',
    ai_customer_success: 'AI 客户成功',
    algorithm_research: '算法研究',
    pure_sales: '销售/商务',
    product: '产品',
    engineering: '技术/研发',
    operations: '运营/增长',
    design: '设计/创意',
    data: '数据/分析',
    consulting: '咨询/解决方案/实施',
    customer_service: '客户成功/服务',
    other: '其他方向',
  };
  const aiEvidenceSuffix = lacksJdAiEvidence ? '；JD 缺少明确 AI 证据，最高 C' : '';
  const capabilitySummary = resume
    ? `匹配 ${capability.matched.length} 项简历能力`
    : '未上传简历，能力未评分';
  const baseSummary = `${semantic?.summary || `${trackLabel[track]}方向`}；岗位分 ${jobMatchScore}；公司分 ${companyQualityScore}；${capabilitySummary}${risk.redFlags.length + companyRedFlags.length ? `；${risk.redFlags.length + companyRedFlags.length} 项风险` : ''}${aiEvidenceSuffix}`;
  const summary = headhunter ? `${baseSummary}；猎头发布，归入 C 级` : baseSummary;
  return {
    total,
    job_match_score: jobMatchScore,
    company_quality_score: companyQualityScore,
    grade,
    track,
    dimensions: {
      role_fit: role.score,
      capability_fit: capability.score,
      threshold_fit: threshold.score,
      condition_fit: condition.score,
      opportunity_quality: quality.score,
      company_quality: companyQualityScore,
      risk_penalty: risk.penalty,
    },
    matched_skills: capability.matched,
    required_gaps: capability.requiredGaps,
    insufficient_evidence: insufficient,
    red_flags: [...risk.redFlags, ...companyRedFlags],
    green_flags: [...risk.greenFlags, ...companyGreenFlags],
    evidence,
    summary,
    score_version: 6,
    scoring_mode: semantic ? 'rules+llm' : 'rules',
  };
}
