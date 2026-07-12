import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { AuthRequiredError, createCrawler, PageStructureError, RateLimitError } from '../crawlers/index.js';
import { isExpiredJobError } from '../crawlers/availability.js';
import { appConfig, getCrawlConfig, PROJECT_ROOT } from '../config.js';
import { createContentFingerprint } from '../job-id.js';
import { scoreJob, scoreJobs } from '../scorer/index.js';
import { getStore, type JobStore } from '../server/store.js';
import { getCompanyProfileService, neutralCompanyProfile, normalizeCompanyKey, type CompanyProfileService } from './company-profile-service.js';
import { getDetailRefresher, type DetailRefresher } from './detail-refresh-service.js';
import type { CompanyProfile, CrawlRun, JobSource, RawJob, ScoredJob } from '../types.js';

const SOURCE_LABELS: Record<JobSource, string> = { boss: 'BOSS', liepin: '猎聘', zhaopin: '智联' };
const DEFAULT_AUTO_DETAIL_LIMIT = 30;
const AUTO_DETAIL_SOURCES = new Set<JobSource>(['liepin', 'zhaopin']);

export class RunConflictError extends Error {
  constructor(readonly run: CrawlRun) {
    super('已有任务正在运行');
    this.name = 'RunConflictError';
  }
}

interface RunServiceOptions {
  crawlExecution?: 'worker' | 'inline';
  companyProfile?: CompanyProfileService;
  detailRefresher?: DetailRefresher;
  useLlm?: boolean;
}

function autoDetailLimit(source: JobSource): number {
  if (!AUTO_DETAIL_SOURCES.has(source)) return 0;
  const envName = source === 'liepin' ? 'LIEPIN_AUTO_DETAIL_LIMIT' : 'ZHAOPIN_AUTO_DETAIL_LIMIT';
  const raw = Number(process.env[envName] ?? DEFAULT_AUTO_DETAIL_LIMIT);
  if (!Number.isFinite(raw)) return DEFAULT_AUTO_DETAIL_LIMIT;
  return Math.max(0, Math.min(Math.trunc(raw), 50));
}

function looksLikeSummaryOnly(job: ScoredJob): boolean {
  const text = job.jd_fulltext.trim();
  if (/^职位：/.test(text)) return true;
  if (/职位描述|岗位职责|任职要求|工作职责|岗位要求/.test(text)) return false;
  return text.length < 500;
}

export function selectAutoDetailCandidates(
  jobs: ScoredJob[],
  limit = autoDetailLimit('zhaopin'),
  source: JobSource = 'zhaopin'
): ScoredJob[] {
  if (limit <= 0) return [];
  const seen = new Set<string>();
  return jobs
    .filter((job) => job.source === source)
    .filter((job) => job.score.grade === 'A' || job.score.grade === 'B')
    .filter((job) => /^https?:\/\//i.test(job.url))
    .filter(looksLikeSummaryOnly)
    .filter((job) => {
      if (seen.has(job.id)) return false;
      seen.add(job.id);
      return true;
    })
    .slice(0, limit);
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

export class RunService {
  private active?: Promise<void>;

  constructor(
    private readonly store: JobStore = getStore(),
    private readonly options: RunServiceOptions = {}
  ) {}

  startCrawl(input: { source: JobSource; keywords: string[]; pages: number }): CrawlRun {
    this.assertIdle();
    const run = this.store.createRun({ operation: 'crawl', ...input });
    if (this.options.crawlExecution !== 'inline') {
      return this.spawnCrawlWorker(run);
    }
    this.active = this.executeCrawl(run).finally(() => { this.active = undefined; });
    return run;
  }

  async runCrawlNow(input: { source: JobSource; keywords: string[]; pages: number }): Promise<CrawlRun> {
    this.assertIdle();
    const run = this.store.createRun({ operation: 'crawl', ...input });
    await this.executeCrawl(run);
    return this.store.getRun(run.id)!;
  }

  async runExistingCrawl(runId: string): Promise<CrawlRun> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`任务不存在：${runId}`);
    if (run.operation !== 'crawl' || !run.source) throw new Error(`任务不是抓取任务：${runId}`);
    if (!['queued', 'running', 'interrupted'].includes(run.status)) throw new Error(`任务已结束：${runId}`);
    await this.executeCrawl(run);
    return this.store.getRun(run.id)!;
  }

  startRescore(): CrawlRun {
    this.assertIdle();
    const jobs = this.store.listJobs();
    const run = this.store.createRun({ operation: 'rescore', keywords: [], pages: 0 });
    this.active = this.executeRescore(run, jobs).finally(() => { this.active = undefined; });
    return run;
  }

  private assertIdle(): void {
    const running = this.store.findActiveRun();
    if (running || this.active) throw new RunConflictError(running ?? this.store.latestRun()!);
  }

  private spawnCrawlWorker(run: CrawlRun): CrawlRun {
    mkdirSync(appConfig.logsDir, { recursive: true });
    const out = openSync(resolve(appConfig.logsDir, 'crawl-worker.out.log'), 'a');
    const err = openSync(resolve(appConfig.logsDir, 'crawl-worker.err.log'), 'a');
    try {
      const distScript = resolve(PROJECT_ROOT, 'dist/scripts/crawl-worker.js');
      const srcScript = resolve(PROJECT_ROOT, 'src/scripts/crawl-worker.ts');
      const args = existsSync(distScript)
        ? [distScript, '--run-id', run.id]
        : ['--import', 'tsx', srcScript, '--run-id', run.id];
      const child = spawn(process.execPath, args, {
        cwd: PROJECT_ROOT,
        detached: true,
        env: { ...process.env, JOB_HUNTER_WORKER: '1' },
        stdio: ['ignore', out, err],
      });
      if (!child.pid) throw new Error('后台抓取进程未返回 pid');
      this.store.assignRunWorker(run.id, child.pid);
      child.unref();
      return this.store.updateRun(run.id, { message: `后台抓取进程已启动（PID ${child.pid}）` });
    } catch (error) {
      return this.store.updateRun(run.id, {
        status: 'failed',
        message: '后台抓取进程启动失败',
        error: (error as Error).message,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      closeSync(out);
      closeSync(err);
    }
  }

  private startHeartbeat(runId: string): NodeJS.Timeout {
    this.store.touchRunHeartbeat(runId);
    const timer = setInterval(() => {
      try {
        this.store.touchRunHeartbeat(runId);
      } catch (error) {
        console.warn(`[run] 心跳更新失败：${(error as Error).message}`);
      }
    }, 5_000);
    timer.unref();
    return timer;
  }

  private async executeCrawl(run: CrawlRun): Promise<void> {
    const heartbeat = this.startHeartbeat(run.id);
    const startedAt = new Date().toISOString();
    const sourceLabel = SOURCE_LABELS[run.source!];
    this.store.updateRun(run.id, {
      status: 'running',
      message: `正在启动 ${sourceLabel} 爬虫`,
      workerPid: process.pid,
      heartbeatAt: new Date().toISOString(),
      startedAt,
    });
    const config = getCrawlConfig({ pages: run.pages, keywords: run.keywords });
    const crawler = createCrawler(run.source!, config);
    let found = 0;
    try {
      const raw = await crawler.crawl(run.keywords, (progress) => {
        found = progress.found;
        this.store.updateRun(run.id, {
          currentPage: progress.completedPages,
          totalPages: progress.totalPages,
          found,
          message: `正在抓取 ${sourceLabel} · ${progress.city}「${progress.keyword}」第 ${progress.page} 页`,
        });
      });
      this.store.updateRun(run.id, { found: raw.length, message: `正在整理 ${new Set(raw.map((job) => normalizeCompanyKey(job.company))).size} 家公司画像` });
      const companyProfiles = await this.prepareCompanyProfiles(raw);
      this.store.updateRun(run.id, { found: raw.length, message: `正在评分 ${raw.length} 条岗位` });
      let scored = await scoreJobs(raw, { companyProfiles, useLlm: this.options.useLlm });
      scored = await this.enrichAutoDetail(run, scored, companyProfiles);
      const stats = this.store.upsertJobsDetailed(scored);
      const archived = this.store.archiveStaleJobs();
      const partial = scored.length !== raw.length;
      this.store.updateRun(run.id, {
        status: partial ? 'partial' : 'succeeded',
        found: raw.length,
        saved: stats.saved,
        inserted: stats.inserted,
        updated: stats.updated,
        reactivated: stats.reactivated,
        archived,
        deduplicated: stats.deduplicated,
        message: `${partial ? '部分完成' : '完成'}：新增 ${stats.inserted}，更新 ${stats.updated}，恢复 ${stats.reactivated}，归档 ${archived}，严格去重 ${stats.deduplicated}`,
        workerPid: undefined,
        heartbeatAt: undefined,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const failure = this.describeCrawlFailure(error);
      this.store.updateRun(run.id, {
        status: 'failed',
        found,
        message: failure.message,
        error: (error as Error).message,
        workerPid: undefined,
        heartbeatAt: undefined,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      clearInterval(heartbeat);
      await crawler.close().catch((error) => console.warn(`[crawl] 关闭浏览器失败：${(error as Error).message}`));
    }
  }

  private async enrichAutoDetail(
    run: CrawlRun,
    scored: ScoredJob[],
    companyProfiles: Map<string, CompanyProfile>
  ): Promise<ScoredJob[]> {
    const source = run.source!;
    const candidates = selectAutoDetailCandidates(scored, autoDetailLimit(source), source);
    if (!candidates.length) return scored;

    const byId = new Map(scored.map((job) => [job.id, job]));
    const refresher = this.options.detailRefresher ?? getDetailRefresher();
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      this.store.updateRun(run.id, {
        message: `正在补全${SOURCE_LABELS[candidate.source]} A/B 岗位 JD（${index + 1}/${candidates.length}）：${candidate.title}`,
      });
      try {
        const existing = this.store.getJob(candidate.id);
        const jd = existing && !looksLikeSummaryOnly(existing)
          ? existing.jd_fulltext
          : await refresher.refresh(candidate);
        if (jd.trim().length <= candidate.jd_fulltext.trim().length) continue;
        const companyProfile = companyProfiles.get(candidate.company_key) ?? null;
        const refreshed = await scoreJob({ ...rawFromScored(candidate), jd_fulltext: jd }, {
          companyProfile,
          useLlm: this.options.useLlm,
        });
        refreshed.first_seen_at = candidate.first_seen_at;
        refreshed.last_seen_at = candidate.last_seen_at;
        refreshed.crawled_at = candidate.crawled_at;
        byId.set(candidate.id, refreshed);
      } catch (error) {
        if (isExpiredJobError(error)) {
          byId.delete(candidate.id);
          if (this.store.getJob(candidate.id)) {
            this.store.updateJobContact(candidate.id, {
              status: 'closed',
              notes: `自动详情补全归档：${(error as Error).message}`,
            });
          }
          this.store.updateRun(run.id, {
            message: `跳过失效${SOURCE_LABELS[candidate.source]}岗位：${candidate.title}`,
          });
          continue;
        }
        console.warn(`[detail-refresh] ${candidate.title}：${(error as Error).message}`);
      }
    }
    return scored.flatMap((job) => byId.has(job.id) ? [byId.get(job.id)!] : []);
  }

  private describeCrawlFailure(error: unknown): { message: string } {
    if (error instanceof AuthRequiredError) {
      const label = SOURCE_LABELS[error.platform];
      return { message: `${label} 登录失效，请先打开 ${label} 登录后再抓取` };
    }
    if (error instanceof RateLimitError) {
      const label = SOURCE_LABELS[error.platform];
      return { message: `${label} 访问过频，请暂停后再试` };
    }
    if (error instanceof PageStructureError) {
      const label = SOURCE_LABELS[error.platform];
      return { message: `${label} 页面或风控异常，请回到官网检查账号状态` };
    }
    return { message: '抓取失败' };
  }

  private async executeRescore(run: CrawlRun, jobs: ScoredJob[]): Promise<void> {
    const heartbeat = this.startHeartbeat(run.id);
    this.store.updateRun(run.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      workerPid: process.pid,
      heartbeatAt: new Date().toISOString(),
      totalPages: jobs.length,
      message: `正在重新评分 ${jobs.length} 条岗位`,
    });
    try {
      const raw: RawJob[] = jobs.map(({
        id: _id,
        score: _score,
        crawled_at: _crawled,
        updated_at: _updated,
        first_seen_at: _firstSeen,
        last_seen_at: _lastSeen,
        lifecycle_status: _lifecycle,
        archived_at: _archivedAt,
        ...job
      }) => job);
      const companyProfiles = await this.prepareCompanyProfiles(raw);
      const rescored = await scoreJobs(raw, { companyProfiles, useLlm: this.options.useLlm });
      const originalByFingerprint = new Map(jobs.map((job) => [createContentFingerprint(job), job]));
      const preserved = rescored.map((job) => ({
        ...job,
        crawled_at: originalByFingerprint.get(createContentFingerprint(job))?.crawled_at ?? job.crawled_at,
        first_seen_at: originalByFingerprint.get(createContentFingerprint(job))?.first_seen_at ?? job.first_seen_at,
        last_seen_at: originalByFingerprint.get(createContentFingerprint(job))?.last_seen_at ?? job.last_seen_at,
      }));
      const stats = this.store.upsertJobsDetailed(preserved);
      this.store.updateRun(run.id, {
        status: rescored.length === raw.length ? 'succeeded' : 'partial',
        currentPage: rescored.length,
        found: raw.length,
        saved: stats.saved,
        inserted: stats.inserted,
        updated: stats.updated,
        reactivated: stats.reactivated,
        deduplicated: stats.deduplicated,
        message: `重新评分完成：${stats.updated} 条`,
        workerPid: undefined,
        heartbeatAt: undefined,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.store.updateRun(run.id, {
        status: 'failed',
        message: '重新评分失败',
        error: (error as Error).message,
        workerPid: undefined,
        heartbeatAt: undefined,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async prepareCompanyProfiles(jobs: RawJob[]): Promise<Map<string, CompanyProfile>> {
    const profiles = new Map<string, CompanyProfile>();
    const companies = new Map<string, { name: string; jobs: RawJob[] }>();
    for (const job of jobs) {
      const key = normalizeCompanyKey(job.company);
      if (!key) continue;
      const group = companies.get(key) ?? { name: job.company, jobs: [] };
      group.jobs.push(job);
      companies.set(key, group);
    }
    const now = new Date();
    const builder = this.options.companyProfile ?? getCompanyProfileService();
    for (const [key, group] of companies) {
      try {
        const profile = builder.build(group.name, group.jobs, now);
        this.store.upsertCompanyProfile(profile);
        profiles.set(key, profile);
      } catch (error) {
        const neutral = neutralCompanyProfile(group.name, now, (error as Error).message);
        this.store.upsertCompanyProfile(neutral);
        profiles.set(key, neutral);
      }
    }
    return profiles;
  }
}

let singleton: RunService | undefined;
export function getRunService(): RunService {
  singleton ??= new RunService();
  return singleton;
}
