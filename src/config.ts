import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CandidateProfile, CrawlConfig, JobSource, UserSettings } from './types.js';

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = resolve(PROJECT_ROOT, '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const boolFromString = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
  }, z.boolean());

const intFromString = (defaultValue: number, min: number, max: number) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? defaultValue : Number(value)),
    z.number().int().min(min).max(max)
  );

function defaultDataDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || resolve(homedir(), 'AppData', 'Roaming');
    return resolve(appData, 'JobHunter', 'data');
  }
  return './data';
}

const EnvSchema = z.object({
  PORT: intFromString(3000, 1, 65535),
  APP_DATA_DIR: z.string().default(defaultDataDir()),
  LLM_API_BASE: z.string().url().default('https://api.deepseek.com/v1'),
  LLM_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().default('deepseek-chat'),
  LLM_ENABLED: boolFromString(false),
  LLM_TIMEOUT_MS: intFromString(20_000, 1_000, 120_000),
  CANDIDATE_RESUME_PATH: z.string().default('./data/profile/resume.md'),
  COMPANY_RESEARCH_TTL_DAYS: intFromString(30, 1, 365),
  CRAWL_HEADLESS: boolFromString(false),
  CRAWL_PAGES: intFromString(1, 1, 20),
  CRAWL_DELAY_MIN_MS: intFromString(3_000, 0, 60_000),
  CRAWL_DELAY_MAX_MS: intFromString(8_000, 0, 120_000),
  CRAWL_KEYWORDS: z.string().default(''),
  BOSS_CDP_PORT: intFromString(9222, 1024, 65535),
  LIEPIN_CDP_PORT: intFromString(9223, 1024, 65535),
  ZHAOPIN_CDP_PORT: intFromString(9224, 1024, 65535),
  CRAWL_CITY_CODE: z.string().regex(/^\d{9}$/).default('101010100'),
  ARCHIVE_A_DAYS: intFromString(30, 1, 365),
  ARCHIVE_B_DAYS: intFromString(21, 1, 365),
  ARCHIVE_C_DAYS: intFromString(14, 1, 365),
  ARCHIVE_D_DAYS: intFromString(7, 1, 365),
});

export function parseEnv(input: NodeJS.ProcessEnv) {
  const result = EnvSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`环境配置无效：${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；')}`);
  }
  return result.data;
}

const parsed = parseEnv(process.env);
export const DATA_DIR = isAbsolute(parsed.APP_DATA_DIR)
  ? parsed.APP_DATA_DIR
  : resolve(PROJECT_ROOT, parsed.APP_DATA_DIR);
export const SETTINGS_PATH = resolve(DATA_DIR, 'settings.json');
export const PROFILE_PATH = resolve(DATA_DIR, 'profile', 'profile.json');
export const RESUME_PATH = resolve(DATA_DIR, 'profile', 'resume.md');

export const DEFAULT_KEYWORDS = [
  'AI产品经理',
  'AI解决方案顾问',
  '大模型解决方案',
  'AI客户成功',
  'AI实施顾问',
  '数字化解决方案顾问',
];

export const DEFAULT_CANDIDATE_PROFILE: CandidateProfile = {
  careerStage: 'experienced',
  targetTracks: ['ai_solutions', 'ai_product', 'ai_customer_success'],
  technicalGroups: [
    { label: '大模型应用理解', keywords: ['Agent', '智能体', 'RAG', '知识库', 'LLM', '大模型应用', 'AIGC', 'Prompt'], points: 5 },
    { label: 'AI工具与工作流', keywords: ['Dify', 'Coze', '扣子', '工作流', '低代码', '无代码', '自动化'], points: 4 },
    { label: '业务流程与数据分析', keywords: ['流程数字化', 'CRM', '数据看板', '业务分析', '客户台账', '运营分析'], points: 4 },
    { label: '产品落地', keywords: ['AI产品', '产品需求', '产品规划', '产品设计', 'PRD', '原型', '用户体验', '产品落地'], points: 4 },
    { label: '轻量系统集成', keywords: ['API', '接口', '系统集成', 'SaaS', '企业微信', '飞书', '钉钉'], points: 2 },
  ],
  solutionGroups: [
    { label: '需求调研与分析', keywords: ['需求分析', '需求调研', '客户需求', '用户访谈', '痛点分析'], points: 3 },
    { label: '解决方案设计', keywords: ['解决方案', '方案设计', '技术方案', '咨询方案', '方案架构'], points: 4 },
    { label: 'PoC与演示', keywords: ['PoC', 'POC', '原型', 'Demo', '演示', '投标', '标书'], points: 4 },
    { label: '客户沟通与售前', keywords: ['客户沟通', '售前', '技术顾问', '客户汇报', '跨部门'], points: 4 },
    { label: '交付培训与客户成功', keywords: ['项目交付', '实施', '技术文档', '培训', '客户成功', '上线', '复盘'], points: 3 },
  ],
  mismatchSkills: [
    'PyTorch', 'TensorFlow', 'CUDA', 'C++', '模型训练', '分布式训练', '模型微调',
    'SFT', 'LoRA', '强化学习', '推理部署', '推理优化', '论文复现', '算法研究',
  ],
  education: '未配置',
  experienceYears: 3,
  salaryFloorK: 0,
  salaryExpectK: 0,
  locationScore: {},
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  setupCompleted: false,
  cityCode: parsed.CRAWL_CITY_CODE,
  keywords: [...DEFAULT_KEYWORDS],
  platforms: { boss: true, liepin: false, zhaopin: false },
  llm: {
    enabled: parsed.LLM_ENABLED,
    baseURL: parsed.LLM_API_BASE,
    apiKey: parsed.LLM_API_KEY,
    model: parsed.LLM_MODEL,
    timeoutMs: parsed.LLM_TIMEOUT_MS,
  },
  publicMode: {
    draftedOnlyGreeting: true,
    batchGreetingEnabled: false,
  },
};

const JobSourceSchema = z.enum(['boss', 'liepin', 'zhaopin']);
const SettingsSchema = z.object({
  setupCompleted: z.boolean().default(false),
  cityCode: z.string().regex(/^\d{9}$/).default(DEFAULT_USER_SETTINGS.cityCode),
  keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(20).default(DEFAULT_USER_SETTINGS.keywords),
  platforms: z.object({
    boss: z.boolean().default(DEFAULT_USER_SETTINGS.platforms.boss),
    liepin: z.boolean().default(DEFAULT_USER_SETTINGS.platforms.liepin),
    zhaopin: z.boolean().default(DEFAULT_USER_SETTINGS.platforms.zhaopin),
  }).default(DEFAULT_USER_SETTINGS.platforms),
  llm: z.object({
    enabled: z.boolean().default(false),
    baseURL: z.string().url().default(DEFAULT_USER_SETTINGS.llm.baseURL),
    apiKey: z.string().default(''),
    model: z.string().min(1).default(DEFAULT_USER_SETTINGS.llm.model),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_USER_SETTINGS.llm.timeoutMs),
  }).default(DEFAULT_USER_SETTINGS.llm),
  publicMode: z.object({
    draftedOnlyGreeting: z.boolean().default(true),
    batchGreetingEnabled: z.boolean().default(false),
  }).default(DEFAULT_USER_SETTINGS.publicMode),
});

const ProfileSchema = z.object({
  careerStage: z.enum(['internship', 'new_grad', 'experienced', 'career_change']).default(DEFAULT_CANDIDATE_PROFILE.careerStage),
  targetTracks: z.array(z.enum(['ai_application', 'ai_solutions', 'ai_product', 'ai_customer_success', 'algorithm_research', 'pure_sales', 'other']))
    .min(1).max(5).default(DEFAULT_CANDIDATE_PROFILE.targetTracks),
  technicalGroups: z.array(z.object({
    label: z.string().min(1).max(40),
    keywords: z.array(z.string().min(1).max(40)).max(40),
    points: z.number().min(0).max(10),
  })).max(20).default(DEFAULT_CANDIDATE_PROFILE.technicalGroups),
  solutionGroups: z.array(z.object({
    label: z.string().min(1).max(40),
    keywords: z.array(z.string().min(1).max(40)).max(40),
    points: z.number().min(0).max(10),
  })).max(20).default(DEFAULT_CANDIDATE_PROFILE.solutionGroups),
  mismatchSkills: z.array(z.string().min(1).max(40)).max(80).default(DEFAULT_CANDIDATE_PROFILE.mismatchSkills),
  education: z.string().max(120).default(DEFAULT_CANDIDATE_PROFILE.education),
  experienceYears: z.number().int().min(0).max(50).default(DEFAULT_CANDIDATE_PROFILE.experienceYears),
  salaryFloorK: z.number().min(0).max(300).default(DEFAULT_CANDIDATE_PROFILE.salaryFloorK),
  salaryExpectK: z.number().min(0).max(500).default(DEFAULT_CANDIDATE_PROFILE.salaryExpectK),
  locationScore: z.record(z.string().min(1).max(30), z.number().min(0).max(10)).default(DEFAULT_CANDIDATE_PROFILE.locationScore),
});

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function loadUserSettings(): UserSettings {
  const parsedSettings = SettingsSchema.safeParse(readJson(SETTINGS_PATH) ?? {});
  return parsedSettings.success ? parsedSettings.data : DEFAULT_USER_SETTINGS;
}

export function saveUserSettings(input: unknown): UserSettings {
  const settings = SettingsSchema.parse({
    ...loadUserSettings(),
    ...(typeof input === 'object' && input ? input : {}),
    publicMode: DEFAULT_USER_SETTINGS.publicMode,
  });
  writeJson(SETTINGS_PATH, settings);
  return settings;
}

export function loadCandidateProfile(): CandidateProfile {
  const parsedProfile = ProfileSchema.safeParse(readJson(PROFILE_PATH) ?? {});
  return parsedProfile.success ? parsedProfile.data as CandidateProfile : DEFAULT_CANDIDATE_PROFILE;
}

export function saveCandidateProfile(input: unknown): CandidateProfile {
  const profile = ProfileSchema.parse({
    ...loadCandidateProfile(),
    ...(typeof input === 'object' && input ? input : {}),
  });
  writeJson(PROFILE_PATH, profile);
  return profile as CandidateProfile;
}

export function setupStatus() {
  const settings = loadUserSettings();
  const profileConfigured = existsSync(PROFILE_PATH);
  return {
    configured: settings.setupCompleted && profileConfigured,
    settingsConfigured: settings.setupCompleted,
    profileConfigured,
    resumeConfigured: existsSync(getCandidateResumePath()),
    dataDir: DATA_DIR,
  };
}

export function getEffectiveLlmConfig() {
  const settings = loadUserSettings();
  const apiKey = parsed.LLM_API_KEY || settings.llm.apiKey;
  const enabled = (parsed.LLM_ENABLED || settings.llm.enabled) && apiKey.length > 0;
  return {
    enabled,
    baseURL: parsed.LLM_API_KEY ? parsed.LLM_API_BASE : settings.llm.baseURL,
    apiKey,
    model: parsed.LLM_API_KEY ? parsed.LLM_MODEL : settings.llm.model,
    timeoutMs: parsed.LLM_API_KEY ? parsed.LLM_TIMEOUT_MS : settings.llm.timeoutMs,
  };
}

export function getCandidateResumePath(): string {
  if (process.env.CANDIDATE_RESUME_PATH) {
    return isAbsolute(parsed.CANDIDATE_RESUME_PATH)
      ? parsed.CANDIDATE_RESUME_PATH
      : resolve(PROJECT_ROOT, parsed.CANDIDATE_RESUME_PATH);
  }
  return RESUME_PATH;
}

export const appConfig = {
  port: parsed.PORT,
  dataDir: DATA_DIR,
  databasePath: resolve(DATA_DIR, 'job-hunter.sqlite'),
  legacyJobsPath: resolve(DATA_DIR, 'jobs.json'),
  publicDir: resolve(PROJECT_ROOT, 'public'),
  get llm() {
    return getEffectiveLlmConfig();
  },
  get candidateResumePath() {
    return getCandidateResumePath();
  },
  companyResearch: {
    ttlDays: parsed.COMPANY_RESEARCH_TTL_DAYS,
  },
  archiveDays: {
    A: parsed.ARCHIVE_A_DAYS,
    B: parsed.ARCHIVE_B_DAYS,
    C: parsed.ARCHIVE_C_DAYS,
    D: parsed.ARCHIVE_D_DAYS,
  },
  logsDir: resolve(DATA_DIR, 'logs'),
} as const;

export function getCrawlConfig(overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  const settings = loadUserSettings();
  const envKeywords = parsed.CRAWL_KEYWORDS.split(',').map((item) => item.trim()).filter(Boolean);
  const delayMinMs = parsed.CRAWL_DELAY_MIN_MS;
  const delayMaxMs = Math.max(delayMinMs, parsed.CRAWL_DELAY_MAX_MS);
  const ports: Record<JobSource, number> = {
    boss: parsed.BOSS_CDP_PORT,
    liepin: parsed.LIEPIN_CDP_PORT,
    zhaopin: parsed.ZHAOPIN_CDP_PORT,
  };
  return {
    headless: parsed.CRAWL_HEADLESS,
    pages: parsed.CRAWL_PAGES,
    delayMinMs,
    delayMaxMs,
    keywords: envKeywords.length ? envKeywords : settings.keywords,
    authDir: resolve(DATA_DIR, 'auth'),
    diagnosticsDir: resolve(DATA_DIR, 'diagnostics'),
    cdpPort: ports.boss,
    cdpPorts: ports,
    cityCode: settings.cityCode,
    ...overrides,
  };
}
