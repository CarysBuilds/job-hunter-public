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

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ');
const hasAny = (text: string, values: string[]) => values.some((value) => text.includes(value.toLowerCase()));

const SOLUTION_KEYWORDS = ['解决方案', '售前', '技术顾问', '咨询顾问', '方案架构', '方案设计', '交付', '实施', 'poc', 'demo', '演示', '投标'];
const PRODUCT_KEYWORDS = ['产品经理', 'ai产品', '产品负责人', '产品专家', '产品顾问', '产品运营', '产品策划', '产品设计', '产品规划'];
const CUSTOMER_SUCCESS_KEYWORDS = ['客户成功', '客户体验', '客户运营', '客户培训', '客户服务', '上线运营', '续费', '留存'];
const SALES_KEYWORDS = ['销售', '客户经理', '商务拓展', '业务拓展', 'bd'];
const ENGINEERING_TITLE_KEYWORDS = ['开发', '工程师', '后端', '前端', '全栈', '架构师', '研发'];
const MODEL_ENGINEERING_KEYWORDS = [
  'pytorch', 'tensorflow', 'cuda', '模型训练', '模型微调', 'fine-tuning', 'sft', 'lora',
  '强化学习', 'drl', '深度学习', '机器学习', '模型压缩', '模型量化', '推理部署',
  '推理优化', '模型并行', '多模态模型', '向量数据库', 'milvus', 'faiss', 'pgvector',
  'vllm', 'sglang', 'tensorrt', 'triton', 'ray', '私有化部署',
];
const CODING_KEYWORDS = [
  'python', 'java', 'typescript', 'javascript', 'node.js', 'nodejs', 'go', 'golang',
  'c++', 'c#', 'php', 'rust', 'fastapi', 'flask', 'django', 'nestjs', 'spring',
  'vue', 'react', 'kubernetes', 'docker', '微服务', '高并发', '后端', '前端', '全栈',
];
const CODING_GAP_KEYWORDS: Array<{ label: string; keywords: string[] }> = [
  { label: 'Python 编码', keywords: ['python', 'fastapi', 'flask', 'django'] },
  { label: 'Java/Go/C# 后端编码', keywords: ['java', 'golang', 'go', 'c#', 'spring'] },
  { label: 'TypeScript/JavaScript 工程开发', keywords: ['typescript', 'javascript', 'node.js', 'nodejs', 'nestjs'] },
  { label: '前端工程开发', keywords: ['vue', 'react', '前端'] },
  { label: '后端/全栈/微服务工程', keywords: ['后端', '全栈', '微服务', '高并发', 'kubernetes', 'docker'] },
];
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
  return 'other';
}

function scoreRole(job: RawJob, track: JobTrack, profile: CandidateProfile): { score: number; evidence: string[] } {
  const text = normalize(`${job.title} ${job.jd_fulltext}`);
  if (profile.targetTracks.includes(track)) {
    return { score: 30, evidence: ['岗位方向属于当前用户画像的目标方向'] };
  }
  switch (track) {
    case 'ai_solutions':
      return { score: 30, evidence: ['岗位属于 AI 解决方案、售前或交付优先方向'] };
    case 'ai_product':
      return { score: 29, evidence: ['岗位属于 AI 产品经理或产品落地优先方向'] };
    case 'ai_customer_success':
      return { score: 27, evidence: ['岗位属于 AI 客户成功、培训或上线运营方向'] };
    case 'ai_application':
      return {
        score: hasAny(text, [...SOLUTION_KEYWORDS, ...PRODUCT_KEYWORDS, ...CUSTOMER_SUCCESS_KEYWORDS]) ? 22 : 18,
        evidence: ['岗位偏 AI 应用工程，非当前第一优先方向'],
      };
    case 'algorithm_research':
      return { score: 4, evidence: ['岗位偏算法研究或模型训练，并非目标主线'] };
    case 'pure_sales':
      return { score: 4, evidence: ['岗位以销售或商务拓展为主'] };
    default:
      return {
        score: hasAny(text, ['rag', 'llm', '大模型', 'agent', '智能体']) ? 14 : 8,
        evidence: ['岗位方向与 AI 方案/产品/客户成功主线仅部分重合'],
      };
  }
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

function hasCodingBurden(job: RawJob, text: string, track: JobTrack): { level: 'none' | 'moderate' | 'heavy'; hits: string[] } {
  const title = normalize(job.title);
  const hits = CODING_KEYWORDS.filter((keyword) => text.includes(keyword));
  const engineeringTitle = hasAny(title, ENGINEERING_TITLE_KEYWORDS) && !hasAny(title, [...SOLUTION_KEYWORDS, ...PRODUCT_KEYWORDS, ...CUSTOMER_SUCCESS_KEYWORDS]);
  const hardRequirement = /(熟练|精通|掌握|扎实|必须|要求|至少|独立|负责).{0,20}(开发|编码|工程化|后端|前端|全栈|微服务|系统架构|代码)/.test(text)
    || /(开发|编码|工程化|后端|前端|全栈|微服务|系统架构|代码).{0,20}(熟练|精通|掌握|扎实|必须|要求|至少|独立)/.test(text);
  const frameworkBurden = hits.some((keyword) => ['fastapi', 'flask', 'django', 'nestjs', 'spring', 'vue', 'react', 'kubernetes', 'docker', '微服务', '高并发'].includes(keyword));

  if (engineeringTitle && (hits.length >= 2 || hardRequirement || frameworkBurden)) return { level: 'heavy', hits };
  if (track === 'ai_application' && hits.length >= 3) return { level: 'heavy', hits };
  if (hits.length >= 3 && !hasPriorityWork(text)) return { level: 'heavy', hits };
  if (hits.length >= 2 || hardRequirement || frameworkBurden) return { level: 'moderate', hits };
  return { level: 'none', hits };
}

function hasModelEngineeringBurden(job: RawJob, text: string): { level: 'none' | 'moderate' | 'heavy'; hits: string[] } {
  const title = normalize(job.title);
  const hits = MODEL_ENGINEERING_KEYWORDS.filter((keyword) => text.includes(keyword));
  const titleIsHard = hasAny(title, ['算法', '训练工程师', 'ai训练', '模型训练', '深度学习', '机器学习']);
  const hardRequirement = /(负责|熟悉|掌握|精通|扎实|要求).{0,24}(模型训练|模型微调|深度学习|机器学习|强化学习|推理部署|推理优化|pytorch|tensorflow|cuda)/.test(text)
    || /(模型训练|模型微调|深度学习|机器学习|强化学习|推理部署|推理优化|pytorch|tensorflow|cuda).{0,24}(负责|熟悉|掌握|精通|扎实|要求)/.test(text);
  if (titleIsHard || hits.length >= 3 || hardRequirement) return { level: 'heavy', hits };
  if (hits.length >= 1) return { level: 'moderate', hits };
  return { level: 'none', hits };
}

function detectCodingGaps(job: RawJob, track: JobTrack, codingBurden: { level: 'none' | 'moderate' | 'heavy'; hits: string[] }): string[] {
  if (codingBurden.level === 'none') return [];
  const text = normalize(`${job.title} ${job.jd_fulltext} ${(job.tags ?? []).join(' ')}`);
  const gaps = CODING_GAP_KEYWORDS
    .filter((group) => group.keywords.some((keyword) => text.includes(keyword)))
    .map((group) => group.label);
  if (track === 'ai_application' && gaps.length === 0 && hasAny(text, ['开发', '工程化', '编码'])) gaps.push('工程开发');
  return [...new Set(gaps)];
}

function scoreCapabilities(job: RawJob, profile: CandidateProfile, track: JobTrack, codingBurden: { level: 'none' | 'moderate' | 'heavy'; hits: string[] }) {
  const text = normalize(`${job.title} ${job.jd_fulltext} ${(job.tags ?? []).join(' ')}`);
  const matched: string[] = [];
  let score = 0;
  for (const group of [...profile.technicalGroups, ...profile.solutionGroups]) {
    if (hasAny(text, group.keywords.map(normalize))) {
      score += group.points;
      matched.push(group.label);
    }
  }
  const targetBonus = profile.targetTracks.includes(track) ? 3 : 0;
  const trackCap: Record<JobTrack, number> = {
    ai_solutions: 25,
    ai_product: 25,
    ai_customer_success: 23 + targetBonus,
    ai_application: profile.targetTracks.includes('ai_application') ? 25 : hasPriorityWork(text) ? 18 : 12,
    algorithm_research: 10,
    pure_sales: 8,
    other: 14,
  };
  const codeCap = codingBurden.level === 'heavy' ? Math.min(trackCap[track], 12) : codingBurden.level === 'moderate' ? Math.min(trackCap[track], 18) : trackCap[track];
  const requiredGaps = [
    ...profile.mismatchSkills.filter((skill) => text.includes(skill.toLowerCase())),
    ...detectCodingGaps(job, track, codingBurden),
  ];
  return { score: clamp(score, 0, codeCap), matched, requiredGaps: [...new Set(requiredGaps)] };
}

function scoreThreshold(job: RawJob, profile: CandidateProfile): { score: number; evidence: string[]; insufficient: string[]; nonFullTime: boolean } {
  const evidence: string[] = [];
  const insufficient: string[] = [];
  const experience = parseExperience(job);
  let experienceScore = 8;
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
    evidence.push('工作年限未知，按中性分计算');
  } else if (experience[0] <= comfortableYears) {
    experienceScore = 10;
    evidence.push(`经验门槛在 ${profile.experienceYears} 年 B 端经验舒适范围内`);
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

  const text = `${job.education ?? ''} ${job.jd_fulltext}`;
  let educationScore = 4;
  if (/博士|phd/i.test(text)) educationScore = 0;
  else if (/(硕士|研究生).*(必须|以上)|硕士及以上/.test(text)) educationScore = 2;
  else if (/(计算机|人工智能|数学|统计).*(专业|相关背景).*(必须|要求)/.test(text)) educationScore = 2;
  else if (/本科|学士|大专/.test(text)) educationScore = 5;
  else insufficient.push('学历要求未明确');

  return { score: experienceScore + educationScore, evidence, insufficient, nonFullTime };
}

function scoreConditions(job: RawJob, profile: CandidateProfile) {
  const evidence: string[] = [];
  const insufficient: string[] = [];
  const salary = parseSalary(job.salary);
  let salaryScore = 5;
  if (!salary) {
    const nonMonthlySalary = /(?:元\s*\/\s*(?:天|日|时|小时)|日薪|天薪|时薪|周薪)/i.test(job.salary);
    if (nonMonthlySalary) {
      insufficient.push('非月薪制，未纳入正式岗月薪比较');
      evidence.push('薪资为非月薪制，条件分按中性值计算');
    } else {
      insufficient.push('薪资未明确');
      evidence.push('薪资未知，按中性分计算');
    }
  } else {
    const midpoint = (salary.minK + salary.maxK) / 2;
    if (profile.salaryExpectK <= 0 && profile.salaryFloorK <= 0) salaryScore = 8;
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
  const aiReality = concreteAi >= 3 ? 4 : concreteAi >= 1 ? 2 : 0;
  const length = job.jd_fulltext.trim().length;
  const clarity = length >= 500 ? 4 : length >= 250 ? 3 : length >= 100 ? 2 : 1;
  const deliverySignals = ['需求分析', '需求调研', '解决方案', 'poc', 'demo', '演示', '交付', '实施', '培训', '客户成功']
    .filter((keyword) => text.includes(keyword)).length;
  const delivery = clamp(deliverySignals, 0, 3);
  const productSignals = ['产品需求', '产品规划', 'prd', '原型', '用户体验', '产品落地', '业务流程']
    .filter((keyword) => text.includes(keyword)).length;
  const product = clamp(productSignals, 0, 3);
  const ownershipSignals = ['从0到1', '0-1', '产品落地', '独立负责', '项目负责人', '项目管理', '上线']
    .filter((keyword) => text.includes(keyword)).length;
  const ownership = clamp(ownershipSignals, 0, 3);
  const finance = hasAny(text, ['金融', '交易', '证券', '基金', '投研', 'fintech']) ? 2 : 0;
  const evidence = [
    aiReality >= 4 ? '包含具体 AI 技术与落地内容' : aiReality > 0 ? '包含部分真实 AI 内容' : 'AI 技术内容不足',
    clarity >= 3 ? 'JD 职责描述较清晰' : 'JD 信息较少',
  ];
  if (delivery) evidence.push('包含方案、演示、交付或客户成功工作');
  if (product) evidence.push('包含产品需求、原型或业务流程工作');
  if (finance) evidence.push('金融/交易场景带来背景协同');
  return { score: clamp(aiReality + clarity + delivery + product + ownership + finance, 0, 15), evidence, concreteAi };
}

function scoreRisks(
  job: RawJob,
  track: JobTrack,
  semantic: SemanticAnalysis | null | undefined,
  concreteAi: number,
  codingBurden: { level: 'none' | 'moderate' | 'heavy'; hits: string[] },
  modelBurden: { level: 'none' | 'moderate' | 'heavy'; hits: string[] }
) {
  const text = normalize(`${job.title} ${job.jd_fulltext}`);
  const redFlags = new Set<string>();
  const greenFlags = new Set<string>();
  let penalty = 0;

  if (/996|大小周|长期加班|经常加班|承受.*压力|强抗压/.test(text) || semantic?.overtime_hint) {
    penalty -= 8;
    redFlags.add('存在明确加班或强压暗示');
  }
  if (/外包|劳务派遣|驻场开发|长期驻场/.test(text)) {
    penalty -= 6;
    redFlags.add('外包、派遣或长期驻场');
  }
  const negatedQuota = /(?:不承担|无需|没有|无)(?:任何)?(?:销售)?(?:业绩)?(?:指标|kpi)/.test(text);
  const quotaText = text.replace(/(?:不承担|无需|没有|无)(?:任何)?(?:销售)?(?:业绩)?(?:指标|kpi)/g, '');
  const hasSalesQuota = /销售指标|业绩指标|销售kpi|获客|自带客户|客户资源|业绩目标|签单|回款|成交|销售额|提成|商务谈判|客户开拓|市场拓展|商机转化/.test(quotaText)
    || Boolean(semantic?.has_sales_quota && !negatedQuota);
  if (hasSalesQuota) {
    penalty -= 10;
    redFlags.add('包含销售指标、获客或客户资源要求');
  }
  const domains = ['前端', '后端', '运维', '测试', '产品', '运营', '设计', '销售'];
  const domainHits = domains.filter((domain) => text.includes(domain));
  if (domainHits.length >= 5 || semantic?.is_kitchen_sink) {
    penalty -= 6;
    redFlags.add('职责跨度过大，疑似全能杂役岗');
  }
  if (codingBurden.level === 'heavy') {
    penalty -= 10;
    redFlags.add('要求较强编码或工程开发，不符合当前优先画像');
  } else if (codingBurden.level === 'moderate') {
    penalty -= 4;
    redFlags.add('包含一定编码或工程实现要求，需要谨慎核对');
  }
  if (modelBurden.level === 'heavy') {
    penalty -= 12;
    redFlags.add('偏模型训练、微调、推理部署或算法工程，不符合当前优先画像');
  } else if (modelBurden.level === 'moderate') {
    penalty -= 5;
    redFlags.add('包含模型训练、微调或推理部署信号，需要谨慎核对');
  }
  const claimsAi = hasAny(text, ['ai', '人工智能', '大模型', 'aigc']);
  const hasSolutionWork = hasPriorityWork(text);
  if (track !== 'pure_sales' && ((claimsAi && concreteAi === 0 && !hasSolutionWork) || semantic?.is_fake_ai)) {
    penalty -= 5;
    redFlags.add('AI 内容空泛，可能仅使用概念包装');
  }
  semantic?.red_flags.forEach((flag) => redFlags.add(flag));
  semantic?.green_flags.forEach((flag) => greenFlags.add(flag));
  if (concreteAi >= 3) greenFlags.add('JD 包含具体 AI 技术或工具场景');
  if (hasSolutionWork) greenFlags.add('包含方案、PoC 或交付能力要求');
  if (hasAny(text, ['金融', '交易', '证券', '基金', '投研'])) greenFlags.add('金融/交易领域背景协同');

  return {
    penalty: clamp(penalty, -30, 0),
    redFlags: [...redFlags],
    greenFlags: [...greenFlags],
    codingBurden: codingBurden.level,
    modelBurden: modelBurden.level,
    hasSalesQuota,
  };
}

function gradeFor(
  total: number,
  lowSalary: boolean,
  nonFullTime: boolean,
  headhunter: boolean,
  codingBurden: 'none' | 'moderate' | 'heavy',
  modelBurden: 'none' | 'moderate' | 'heavy',
  hasSalesQuota: boolean,
  lacksJdAiEvidence: boolean
): Grade {
  if (headhunter) return 'C';
  let grade: Grade = total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 45 ? 'C' : 'D';
  if (lacksJdAiEvidence && (grade === 'A' || grade === 'B')) grade = 'C';
  if ((lowSalary || nonFullTime) && (grade === 'A' || grade === 'B')) grade = 'C';
  if (hasSalesQuota && (grade === 'A' || grade === 'B')) grade = 'C';
  if (modelBurden === 'heavy' && (grade === 'A' || grade === 'B')) grade = 'C';
  if (modelBurden === 'moderate' && grade === 'A') grade = 'B';
  if (codingBurden === 'heavy' && (grade === 'A' || grade === 'B')) grade = 'C';
  if (codingBurden === 'moderate' && grade === 'A') grade = 'B';
  return grade;
}

export function scoreWithRules(
  job: RawJob,
  semantic: SemanticAnalysis | null = null,
  profile: CandidateProfile = getCandidateProfile(),
  companyProfile: CompanyProfile | null = null
): JobScore {
  const track = classifyTrack(job, semantic);
  const role = scoreRole(job, track, profile);
  const fullText = normalize(`${job.title} ${job.jd_fulltext} ${(job.tags ?? []).join(' ')}`);
  const codingBurden = hasCodingBurden(job, fullText, track);
  const modelBurden = hasModelEngineeringBurden(job, fullText);
  const capability = scoreCapabilities(job, profile, track, codingBurden);
  const threshold = scoreThreshold(job, profile);
  const condition = scoreConditions(job, profile);
  const quality = scoreQuality(job);
  const risk = scoreRisks(job, track, semantic, quality.concreteAi, codingBurden, modelBurden);
  const positive = role.score + capability.score + threshold.score + condition.score + quality.score;
  const jobMatchScore = clamp(positive + risk.penalty, 0, 100);
  const companyQualityScore = companyProfile?.quality_score ?? 70;
  const total = clamp(Math.round(jobMatchScore * 0.7 + companyQualityScore * 0.3), 0, 100);
  const lowSalary = Boolean(condition.salary && condition.salary.maxK < profile.salaryFloorK);
  const headhunter = isHeadhunterJob(job);
  const lacksJdAiEvidence = !hasExplicitAiEvidence(normalize(job.jd_fulltext));
  const earlyCareer = profile.careerStage === 'internship' || profile.careerStage === 'new_grad';
  const grade = gradeFor(total, lowSalary, threshold.nonFullTime && !earlyCareer, headhunter, risk.codingBurden, risk.modelBurden, risk.hasSalesQuota, lacksJdAiEvidence);
  const insufficient = [...threshold.insufficient, ...condition.insufficient];
  if (!companyProfile || companyProfile.confidence === 0) insufficient.push('公司公开画像不足，按中性公司分计算');
  const companyGreenFlags = companyProfile?.green_flags ?? [];
  const companyRedFlags = companyProfile?.red_flags ?? [];
  const evidence: ScoreEvidence[] = [
    ...role.evidence.map((text) => ({ category: 'role' as const, text })),
    ...threshold.evidence.map((text) => ({ category: 'threshold' as const, text })),
    ...condition.evidence.map((text) => ({ category: 'condition' as const, text })),
    ...quality.evidence.map((text) => ({ category: 'quality' as const, text })),
    ...(lacksJdAiEvidence ? [{
      category: 'risk' as const,
      text: 'JD 未出现明确 AI、大模型、Agent、RAG 或智能体内容，最高按 C 级处理',
    }] : []),
    ...(companyProfile ? [{
      category: 'company' as const,
      text: `公司质量分 ${companyQualityScore}：${companyProfile.reputation_summary}`,
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
    other: '其他方向',
  };
  const aiEvidenceSuffix = lacksJdAiEvidence ? '；JD 缺少明确 AI 证据，最高 C' : '';
  const baseSummary = semantic?.summary || `${trackLabel[track]}方向；岗位分 ${jobMatchScore}；公司分 ${companyQualityScore}；匹配 ${capability.matched.length} 个能力组${risk.redFlags.length + companyRedFlags.length ? `；${risk.redFlags.length + companyRedFlags.length} 项风险` : ''}${aiEvidenceSuffix}`;
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
    score_version: 5,
    scoring_mode: semantic ? 'rules+llm' : 'rules',
  };
}
