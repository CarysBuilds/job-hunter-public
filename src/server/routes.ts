import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  DEFAULT_CANDIDATE_PROFILE,
  DEFAULT_USER_SETTINGS,
  getCrawlConfig,
  loadCandidateProfile,
  loadUserSettings,
  saveCandidateProfile,
  saveUserSettings,
  setupStatus,
  appConfig,
} from '../config.js';
import { CdpChromeSession, PLATFORM_CDP_OPTIONS } from '../crawlers/cdp-chrome.js';
import { RunConflictError, type RunService } from '../services/run-service.js';
import { scoreJob } from '../scorer/index.js';
import {
  LlmUnavailableError,
  ResumeMissingError,
  type GreetingGenerator,
} from '../services/greeting-service.js';
import {
  UnsupportedDetailRefreshError,
  type DetailRefresher,
} from '../services/detail-refresh-service.js';
import type { ContactStatus, Grade, JobFilters, JobSource, RawJob, ScoredJob, UserSettings } from '../types.js';
import type { JobStore } from './store.js';

const APP_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
const JobSourceSchema = z.enum(['boss', 'liepin', 'zhaopin']);
const SOURCE_LABELS: Record<JobSource, string> = { boss: 'BOSS', liepin: '猎聘', zhaopin: '智联' };

const JobQuerySchema = z.object({
  grade: z.string().optional(),
  source: z.string().optional(),
  minSalary: z.coerce.number().min(0).optional(),
  sort: z.enum(['priority-desc', 'score-desc', 'salary-desc', 'salary-asc', 'fresh-desc']).optional(),
  lifecycle: z.enum(['active', 'archived', 'all']).default('active'),
  q: z.string().trim().max(100).optional(),
});

const CrawlBodySchema = z.object({
  sources: z.array(JobSourceSchema).default(['boss']),
  keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(10),
  pages: z.number().int().min(1).max(20).default(1),
});

const CONTACT_STATUSES = ['unprocessed', 'drafted', 'greeted', 'applied', 'interviewing', 'rejected', 'closed', 'follow_up'] as const;
const ContactPatchSchema = z.object({
  status: z.enum(CONTACT_STATUSES).optional(),
  greeted_at: z.string().datetime().nullable().optional(),
  platform: JobSourceSchema.nullable().optional(),
  last_message: z.string().max(2000).nullable().optional(),
  next_follow_up_at: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const LoginSourceSchema = z.object({ source: JobSourceSchema.default('boss') });
const ResumeSchema = z.object({ content: z.string().trim().min(80, '简历内容至少需要 80 个字符').max(100_000) });

const UserSettingsPatchSchema = z.object({
  setupCompleted: z.boolean().optional(),
  cityCode: z.string().regex(/^\d{9}$/).optional(),
  cities: z.array(z.string().trim().min(1).max(20)).min(1).max(5).optional(),
  keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(20).optional(),
  platforms: z.object({
    boss: z.boolean().optional(),
    liepin: z.boolean().optional(),
    zhaopin: z.boolean().optional(),
  }).partial().optional(),
  llm: z.object({
    enabled: z.boolean().optional(),
    baseURL: z.string().url().optional(),
    apiKey: z.string().optional(),
    model: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  }).partial().optional(),
});

const ProfilePatchSchema = z.object({
  careerStage: z.enum(['internship', 'new_grad', 'experienced', 'career_change']).optional(),
  targetTracks: z.array(z.enum(['ai_application', 'ai_solutions', 'ai_product', 'ai_customer_success', 'algorithm_research', 'pure_sales', 'product', 'engineering', 'operations', 'design', 'data', 'consulting', 'customer_service', 'other']))
    .min(1).max(5).optional(),
  technicalGroups: z.array(z.object({
    label: z.string().min(1).max(40),
    keywords: z.array(z.string().min(1).max(40)).max(40),
    points: z.number().min(0).max(10),
  })).max(20).optional(),
  solutionGroups: z.array(z.object({
    label: z.string().min(1).max(40),
    keywords: z.array(z.string().min(1).max(40)).max(40),
    points: z.number().min(0).max(10),
  })).max(20).optional(),
  mismatchSkills: z.array(z.string().min(1).max(40)).max(80).optional(),
  education: z.string().max(120).optional(),
  experienceYears: z.number().int().min(0).max(50).optional(),
  salaryFloorK: z.number().min(0).max(300).optional(),
  salaryExpectK: z.number().min(0).max(500).optional(),
  locationScore: z.record(z.string().min(1).max(30), z.number().min(0).max(10)).optional(),
});

function sendValidationError(res: Response, error: z.ZodError): void {
  res.status(400).json({ ok: false, error: error.issues.map((issue) => issue.message).join('；') });
}

function redactUserSettings(settings: UserSettings): UserSettings {
  return {
    ...settings,
    llm: {
      ...settings.llm,
      apiKey: settings.llm.apiKey ? 'configured' : '',
    },
  };
}

function rawFromScored(job: ScoredJob): RawJob {
  return {
    title: job.title,
    company: job.company,
    salary: job.salary,
    location: job.location,
    source: job.source,
    url: job.url,
    jd_fulltext: job.jd_fulltext,
    experience: job.experience,
    education: job.education,
    tags: job.tags,
    recruiter_name: job.recruiter_name,
    recruiter_title: job.recruiter_title,
    is_headhunter: job.is_headhunter,
    company_industry: job.company_industry,
    company_stage: job.company_stage,
    company_scale: job.company_scale,
  };
}

export function createRouter(
  store: JobStore,
  runs: RunService,
  greeting: GreetingGenerator,
  detailRefresher: DetailRefresher
): Router {
  const router = Router();

  router.get('/health', (_req: Request, res: Response) => {
    const latestRun = store.latestRun();
    res.json({
      ok: true,
      data: {
        version: APP_VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
        jobs: store.lifecycleCounts(),
        task: latestRun ? {
          id: latestRun.id,
          operation: latestRun.operation,
          status: latestRun.status,
          message: latestRun.message,
        } : null,
      },
    });
  });

  router.get('/setup/status', (_req: Request, res: Response) => {
    res.json({ ok: true, data: setupStatus() });
  });

  router.get('/config', (_req: Request, res: Response) => {
    const settings = loadUserSettings();
    res.json({
      ok: true,
      data: {
        defaults: redactUserSettings(DEFAULT_USER_SETTINGS),
        settings: redactUserSettings(settings),
      },
    });
  });

  router.put('/config', (req: Request, res: Response) => {
    const parsed = UserSettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const current = loadUserSettings();
    const next = saveUserSettings({
      ...current,
      ...parsed.data,
      platforms: { ...current.platforms, ...parsed.data.platforms },
      llm: { ...current.llm, ...parsed.data.llm },
      setupCompleted: parsed.data.setupCompleted ?? true,
    });
    res.json({ ok: true, data: redactUserSettings(next) });
  });

  router.get('/profile', (_req: Request, res: Response) => {
    res.json({ ok: true, data: { defaults: DEFAULT_CANDIDATE_PROFILE, profile: loadCandidateProfile() } });
  });

  router.put('/profile', (req: Request, res: Response) => {
    const parsed = ProfilePatchSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    res.json({ ok: true, data: saveCandidateProfile(parsed.data) });
  });

  router.get('/jobs', (req: Request, res: Response) => {
    const parsed = JobQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const grades = parsed.data.grade?.split(',').filter(Boolean) ?? [];
    const sources = parsed.data.source?.split(',').filter(Boolean) ?? [];
    if (grades.some((grade) => !['A', 'B', 'C', 'D'].includes(grade))) {
      return void res.status(400).json({ ok: false, error: '评级筛选仅支持 A、B、C、D' });
    }
    if (sources.some((source) => !['boss', 'liepin', 'zhaopin'].includes(source))) {
      return void res.status(400).json({ ok: false, error: '岗位来源参数无效' });
    }
    const filters: JobFilters = {
      grade: grades.length ? grades as Grade[] : undefined,
      source: sources.length ? sources as JobSource[] : undefined,
      minSalary: parsed.data.minSalary,
      sort: parsed.data.sort,
      lifecycle: parsed.data.lifecycle,
      q: parsed.data.q,
    };
    res.json({ ok: true, data: store.listJobs(filters) });
  });

  router.get('/jobs/:id', (req: Request, res: Response) => {
    const job = store.getJob(req.params.id);
    if (!job) return void res.status(404).json({ ok: false, error: '岗位不存在' });
    res.json({ ok: true, data: job });
  });

  router.get('/status', (_req: Request, res: Response) => {
    res.json({ ok: true, data: store.latestRun() });
  });

  router.get('/profile/status', (_req: Request, res: Response) => {
    res.json({ ok: true, data: greeting.status() });
  });

  router.get('/resume', (_req: Request, res: Response) => {
    const content = existsSync(appConfig.candidateResumePath)
      ? readFileSync(appConfig.candidateResumePath, 'utf8')
      : '';
    res.json({ ok: true, data: { content } });
  });

  router.put('/resume', (req: Request, res: Response) => {
    const parsed = ResumeSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    mkdirSync(dirname(appConfig.candidateResumePath), { recursive: true });
    writeFileSync(appConfig.candidateResumePath, `${parsed.data.content}\n`, 'utf8');
    res.json({ ok: true, data: { saved: true, path: 'data/profile/resume.md' } });
  });

  router.get('/login/status', async (req: Request, res: Response) => {
    const parsed = LoginSourceSchema.safeParse({ source: req.query.source });
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const source = parsed.data.source;
    try {
      const session = new CdpChromeSession(getCrawlConfig({ pages: 1 }), PLATFORM_CDP_OPTIONS[source]);
      const loggedIn = source === 'boss'
        ? await session.isLoggedIn().catch(() => false)
        : await session.currentUrl().then((url) => Boolean(url
          && PLATFORM_CDP_OPTIONS[source].targetUrlPattern.test(url)
          && !PLATFORM_CDP_OPTIONS[source].authUrlPattern.test(url))).catch(() => false);
      res.json({ ok: true, data: { source, loggedIn } });
    } catch {
      res.json({ ok: true, data: { source, loggedIn: false } });
    }
  });

  router.post('/login', async (req: Request, res: Response) => {
    const sourceValue = typeof req.query.source === 'string'
      ? req.query.source
      : typeof req.body?.source === 'string'
        ? req.body.source
        : undefined;
    const parsed = LoginSourceSchema.safeParse({ source: sourceValue });
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const source = parsed.data.source;
    const label = SOURCE_LABELS[source];
    try {
      const session = new CdpChromeSession(getCrawlConfig({ pages: 1 }), PLATFORM_CDP_OPTIONS[source]);
      await session.openLogin();
      res.json({
        ok: true,
        data: {
          message: `已打开 ${label} 登录页；请在 Chrome 完成登录后再点击「抓取 ${label}」`,
        },
      });
    } catch (error) {
      console.error('[login]', error);
      res.status(502).json({ ok: false, error: `无法打开 ${label} 登录页：${(error as Error).message}` });
    }
  });

  router.post('/jobs/:id/greeting', async (req: Request, res: Response) => {
    const job = store.getJob(req.params.id);
    if (!job) return void res.status(404).json({ ok: false, error: '岗位不存在' });
    try {
      const result = await greeting.generate(job);
      const contact = store.updateJobContact(job.id, {
        status: 'drafted',
        platform: job.source,
        last_message: result.text,
      });
      res.json({ ok: true, data: { ...result, contact } });
    } catch (error) {
      if (error instanceof ResumeMissingError) {
        return void res.status(422).json({ ok: false, error: error.message });
      }
      if (error instanceof LlmUnavailableError) {
        return void res.status(503).json({ ok: false, error: error.message });
      }
      console.error(`[greeting] ${job.title}：`, error);
      return void res.status(502).json({ ok: false, error: '生成失败，请稍后重试' });
    }
  });

  router.post('/jobs/:id/detail-refresh', async (req: Request, res: Response) => {
    const job = store.getJob(req.params.id);
    if (!job) return void res.status(404).json({ ok: false, error: '岗位不存在' });
    try {
      const jd = await detailRefresher.refresh(job);
      const rescored = await scoreJob({ ...rawFromScored(job), jd_fulltext: jd }, {
        companyProfile: job.company_profile ?? store.getFreshCompanyProfile(job.company_key),
      });
      rescored.first_seen_at = job.first_seen_at;
      rescored.last_seen_at = job.last_seen_at;
      rescored.crawled_at = job.crawled_at;
      rescored.updated_at = new Date().toISOString();
      const stats = store.upsertJobsDetailed([rescored]);
      const refreshed = store.getJob(job.id) ?? store.getJob(rescored.id) ?? rescored;
      res.json({ ok: true, data: { job: refreshed, stats, jdLength: jd.length } });
    } catch (error) {
      if (error instanceof UnsupportedDetailRefreshError) {
        return void res.status(400).json({ ok: false, error: error.message });
      }
      const message = (error as Error).message;
      if (/登录|安全验证|passport|login/i.test(message)) {
        return void res.status(401).json({ ok: false, error: `详情补全需要重新登录或通过安全验证：${message}` });
      }
      console.error(`[detail-refresh] ${job.title}：`, error);
      return void res.status(502).json({ ok: false, error: `详情补全失败：${message}` });
    }
  });

  router.patch('/jobs/:id/contact', (req: Request, res: Response) => {
    const job = store.getJob(req.params.id);
    if (!job) return void res.status(404).json({ ok: false, error: '岗位不存在' });
    const parsed = ContactPatchSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const changes = Object.fromEntries(
      Object.entries(parsed.data).map(([key, value]) => [key, value === null ? undefined : value])
    ) as Partial<{
      status: ContactStatus;
      greeted_at: string;
      platform: JobSource;
      last_message: string;
      next_follow_up_at: string;
      notes: string;
    }>;
    const contact = store.updateJobContact(job.id, changes);
    res.json({ ok: true, data: contact });
  });

  router.post('/crawl', (req: Request, res: Response) => {
    const parsed = CrawlBodySchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    if (parsed.data.sources.length !== 1) {
      return void res.status(400).json({ ok: false, error: '第一版一次只支持单个平台抓取，请分别点击 BOSS、猎聘或智联' });
    }
    try {
      const run = runs.startCrawl({ source: parsed.data.sources[0], keywords: parsed.data.keywords, pages: parsed.data.pages });
      res.status(202).json({ ok: true, data: run });
    } catch (error) {
      if (error instanceof RunConflictError) {
        return void res.status(409).json({ ok: false, error: error.message, data: error.run });
      }
      throw error;
    }
  });

  router.post('/rescore', (_req: Request, res: Response) => {
    if (store.countJobs('active') === 0) return void res.status(400).json({ ok: false, error: '暂无当前岗位可重新评分' });
    try {
      const run = runs.startRescore();
      res.status(202).json({ ok: true, data: run });
    } catch (error) {
      if (error instanceof RunConflictError) {
        return void res.status(409).json({ ok: false, error: error.message, data: error.run });
      }
      throw error;
    }
  });

  router.delete('/jobs', (_req: Request, res: Response) => {
    const deleted = store.deleteJobs();
    res.json({ ok: true, data: { deleted } });
  });

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'API 路径不存在' });
  });

  router.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    console.error('[api]', error);
    res.status(500).json({ ok: false, error: '服务器内部错误' });
  });
  return router;
}
