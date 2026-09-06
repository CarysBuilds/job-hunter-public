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
  UnsafeGreetingError,
  type GreetingGenerator,
} from '../services/greeting-service.js';
import {
  UnsupportedDetailRefreshError,
  type DetailRefresher,
} from '../services/detail-refresh-service.js';
import type { ContactStatus, Grade, JobFilters, JobSource, RawJob, ScoredJob, UserSettings } from '../types.js';
import type { JobStore } from './store.js';
import { exportDataset } from '../services/export-service.js';
import { ensurePrivateFile } from '../file-security.js';

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
  minSalary: z.number().min(0).max(500).optional(),
  maxJobs: z.number().int().min(1).max(5_000).optional(),
});

const CONTACT_STATUSES = ['unprocessed', 'drafted', 'greeted', 'ready_to_apply', 'applied', 'interviewing', 'rejected', 'closed', 'follow_up'] as const;
const ContactPatchSchema = z.object({
  status: z.enum(CONTACT_STATUSES).optional(),
  greeted_at: z.string().datetime().nullable().optional(),
  ready_to_apply_at: z.string().datetime().nullable().optional(),
  applied_at: z.string().datetime().nullable().optional(),
  interviewing_at: z.string().datetime().nullable().optional(),
  platform: JobSourceSchema.nullable().optional(),
  last_message: z.string().max(2000).nullable().optional(),
  next_follow_up_at: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  outcome: z.enum(['offer', 'accepted', 'rejected', 'withdrawn', 'no_response']).nullable().optional(),
  outcome_at: z.string().datetime().nullable().optional(),
  communication_source: z.enum(['manual', 'legacy_unverified']).nullable().optional(),
  communication_verified_at: z.string().datetime().nullable().optional(),
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
  expectedProfileVersion: z.number().int().min(1).optional(),
  strategyTemplate: z.enum(['general', 'custom']).optional(),
  careerStage: z.enum(['internship', 'new_grad', 'experienced', 'career_change']).optional(),
  targetTracks: z.array(z.enum(['ai_application', 'ai_solutions', 'ai_product', 'ai_customer_success', 'algorithm_research', 'pure_sales', 'product', 'engineering', 'operations', 'design', 'data', 'consulting', 'customer_service', 'other']))
    .min(1).max(5).optional(),
  education: z.string().max(120).optional(),
  experienceYears: z.number().int().min(0).max(50).optional(),
  salaryFloorK: z.number().min(0).max(300).optional(),
  salaryExpectK: z.number().min(0).max(500).optional(),
  locationScore: z.record(z.string().min(1).max(30), z.number().min(0).max(10)).optional(),
  salesRiskTolerance: z.enum(['avoid', 'balanced', 'accept']).optional(),
  blockedCompanies: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  blockedKeywords: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
});

const DeleteChallengeSchema = z.object({ token: z.string().uuid(), expectedCount: z.number().int().min(0), confirmation: z.string().max(100) }).strict();
const EventSchema = z.object({
  type: z.enum(['applied', 'recruiter_reply', 'resume_requested', 'screening', 'assessment', 'interview_scheduled', 'interview_completed', 'feedback', 'offer', 'accepted', 'rejected', 'withdrawn', 'no_response']),
  stage: z.string().trim().max(120).optional(), note: z.string().trim().max(2000).optional(), reasonCode: z.string().trim().max(120).optional(),
  occurredAt: z.string().datetime().optional(), idempotencyKey: z.string().trim().min(1).max(240).optional(),
}).strict();
const ContentVersionSchema = z.object({ content: z.string().trim().min(80).max(100_000), origin: z.enum(['manual_paste']).default('manual_paste') }).strict();

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
        nodeVersion: process.version,
        platform: process.platform,
        schemaVersion: store.schemaVersion(),
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
    const status = setupStatus();
    res.json({ ok: true, data: {
      configured: status.configured,
      settingsConfigured: status.settingsConfigured,
      profileConfigured: status.profileConfigured,
      resumeConfigured: status.resumeConfigured,
    } });
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
    const current = loadCandidateProfile();
    if (parsed.data.expectedProfileVersion && parsed.data.expectedProfileVersion !== current.profileVersion) {
      return void res.status(409).json({ ok: false, error: `画像已更新到 v${current.profileVersion}，请刷新后重试` });
    }
    const changes = { ...parsed.data };
    delete changes.expectedProfileVersion;
    res.json({ ok: true, data: saveCandidateProfile({ ...changes, strategyTemplate: 'custom' }) });
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

  router.get('/runs', (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 50) || 50, 200));
    res.json({ ok: true, data: store.listRuns(limit) });
  });

  router.get('/runs/:runId', (req: Request, res: Response) => {
    const run = store.getRun(req.params.runId);
    if (!run) return void res.status(404).json({ ok: false, error: '任务不存在' });
    res.json({ ok: true, data: { run, pages: store.listRunPages(run.id), observations: store.listRunObservations(run.id) } });
  });

  router.post('/runs/:runId/retry', (req: Request, res: Response) => {
    try { res.status(201).json({ ok: true, data: runs.retryRun(req.params.runId) }); }
    catch (error) { res.status(409).json({ ok: false, error: (error as Error).message }); }
  });

  router.post('/runs/:runId/cancel', (req: Request, res: Response) => {
    try { res.json({ ok: true, data: store.cancelRun(req.params.runId) }); }
    catch (error) { res.status(409).json({ ok: false, error: (error as Error).message }); }
  });

  router.get('/sources', (_req: Request, res: Response) => {
    res.json({ ok: true, data: store.listSourceHealth() });
  });

  router.get('/contact/funnel', (_req: Request, res: Response) => {
    res.json({ ok: true, data: store.contactFunnel() });
  });

  router.get('/profile/status', (_req: Request, res: Response) => {
    res.json({ ok: true, data: greeting.status() });
  });

  router.get('/jobs/:id/events', (req: Request, res: Response) => {
    if (!store.getJob(req.params.id)) return void res.status(404).json({ ok: false, error: '岗位不存在' });
    res.json({ ok: true, data: store.listApplicationEvents(req.params.id) });
  });

  router.post('/jobs/:id/events', (req: Request, res: Response) => {
    const parsed = EventSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try { res.status(201).json({ ok: true, data: store.recordApplicationEvent({ jobId: req.params.id, ...parsed.data }) }); }
    catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });

  router.get('/jobs/:id/content-versions', (req: Request, res: Response) => {
    if (!store.getJob(req.params.id)) return void res.status(404).json({ ok: false, error: '岗位不存在' });
    res.json({ ok: true, data: store.listJobContentVersions(req.params.id) });
  });

  router.post('/jobs/:id/content-versions', async (req: Request, res: Response) => {
    const parsed = ContentVersionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const job = store.getJob(req.params.id);
    if (!job) return void res.status(404).json({ ok: false, error: '岗位不存在' });
    try {
      const rescored = await scoreJob({ ...rawFromScored(job), jd_fulltext: parsed.data.content }, {
        companyProfile: job.company_profile ?? store.getFreshCompanyProfile(job.company_key),
      });
      rescored.first_seen_at = job.first_seen_at;
      rescored.last_seen_at = job.last_seen_at;
      rescored.crawled_at = job.crawled_at;
      const version = store.commitJobContentVersion(job.id, rescored, parsed.data.content, parsed.data.origin);
      res.status(201).json({ ok: true, data: { version, job: store.getJob(job.id) ?? rescored } });
    } catch (error) { res.status(400).json({ ok: false, error: (error as Error).message }); }
  });

  router.post('/exports/:dataset', (req: Request, res: Response) => {
    if (!['jobs', 'contacts'].includes(req.params.dataset)) return void res.status(404).json({ ok: false, error: '导出数据集不存在' });
    const parsed = z.object({ format: z.enum(['csv', 'json']).default('csv') }).strict().safeParse(req.body ?? {});
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const output = exportDataset(store, req.params.dataset as 'jobs' | 'contacts', parsed.data.format);
    res.setHeader('Content-Type', output.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="job-hunter-${req.params.dataset}.${output.extension}"`);
    res.send(output.body);
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
    ensurePrivateFile(appConfig.candidateResumePath);
    res.json({ ok: true, data: { saved: true } });
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
      if (error instanceof UnsafeGreetingError) {
        return void res.status(422).json({ ok: false, error: error.message, rules: error.rules });
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
      if (jd.trim().length >= 80) store.commitJobContentVersion(job.id, rescored, jd, 'detail_refresh');
      else store.upsertJobsDetailed([rescored]);
      const refreshed = store.getJob(job.id) ?? store.getJob(rescored.id) ?? rescored;
      res.json({ ok: true, data: { job: refreshed, jdLength: jd.length } });
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
      ready_to_apply_at: string;
      applied_at: string;
      interviewing_at: string;
      platform: JobSource;
      last_message: string;
      next_follow_up_at: string;
      notes: string;
      outcome: 'offer' | 'accepted' | 'rejected' | 'withdrawn' | 'no_response';
      outcome_at: string;
      communication_source: 'manual' | 'legacy_unverified';
      communication_verified_at: string;
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
      const run = runs.startCrawl({
        source: parsed.data.sources[0], keywords: parsed.data.keywords, pages: parsed.data.pages,
        minSalary: parsed.data.minSalary, maxJobs: parsed.data.maxJobs,
      });
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

  router.post('/jobs/delete-challenge', (_req: Request, res: Response) => {
    res.status(201).json({ ok: true, data: store.createDeleteChallenge() });
  });

  router.delete('/jobs', (req: Request, res: Response) => {
    const parsed = DeleteChallengeSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      const result = store.deleteJobsWithChallenge(parsed.data);
      res.json({ ok: true, data: { deleted: result.deleted, backupCreated: true } });
    }
    catch (error) { res.status(409).json({ ok: false, error: (error as Error).message }); }
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
