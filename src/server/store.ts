import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appConfig } from '../config.js';
import { canonicalizeJobUrl, createContentFingerprint, createJobId, normalizeFingerprintText } from '../job-id.js';
import { parseSalary, scoreWithRules } from '../scorer/rules.js';
import { normalizeCompanyKey } from '../services/company-profile-service.js';
import { readOptionalResume } from '../services/resume-service.js';
import { createVerifiedDatabaseBackup } from './database-safety.js';
import { ensurePrivateDirectory, ensurePrivateFile } from '../file-security.js';
import type {
  ApplicationEvent,
  ApplicationEventType,
  CompanyProfile,
  ContactStatus,
  ContactFunnelStats,
  ContactOutcome,
  CrawlJobObservation,
  CrawlRun,
  CrawlRunPage,
  Grade,
  JobContentVersion,
  JobContact,
  JobFilters,
  JobSource,
  JobSourceHealth,
  LifecycleStatus,
  RawJob,
  RunOperation,
  ScoredJob,
} from '../types.js';

export { createJobId } from '../job-id.js';

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const RUN_HEARTBEAT_STALE_MS = 2 * 60 * 1000;
export const CURRENT_SCHEMA_VERSION = 2;
const PROTECTED_CONTACT_STATUSES: ContactStatus[] = ['drafted', 'greeted', 'ready_to_apply', 'applied', 'interviewing', 'follow_up'];
type ArchiveDaysConfig = number | Partial<Record<Grade, number>>;

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface JobRow {
  id: string;
  source: JobSource;
  title: string;
  company: string;
  company_key: string;
  salary: string;
  salary_upper: number | null;
  location: string;
  url: string;
  jd_fulltext: string;
  experience: string | null;
  education: string | null;
  tags_json: string;
  recruiter_name: string | null;
  recruiter_title: string | null;
  is_headhunter: number;
  company_industry: string | null;
  company_stage: string | null;
  company_scale: string | null;
  content_fingerprint: string;
  score_total: number;
  score_grade: Grade;
  score_json: string;
  crawled_at: string;
  updated_at: string;
  first_seen_at: string;
  last_seen_at: string;
  lifecycle_status: LifecycleStatus;
  archived_at: string | null;
}

interface CompanyProfileRow {
  company_key: string;
  display_name: string;
  quality_score: number;
  company_type: CompanyProfile['company_type'];
  work_life: CompanyProfile['work_life'];
  reputation_summary: string;
  green_flags_json: string;
  red_flags_json: string;
  sources_json: string;
  confidence: number;
  researched_at: string;
  expires_at: string;
  last_error: string | null;
}

interface JobContactRow {
  job_id: string;
  status: ContactStatus;
  greeted_at: string | null;
  ready_to_apply_at: string | null;
  applied_at: string | null;
  interviewing_at: string | null;
  platform: JobSource | null;
  last_message: string | null;
  next_follow_up_at: string | null;
  notes: string | null;
  outcome: ContactOutcome | null;
  outcome_at: string | null;
  communication_source: JobContact['communication_source'] | null;
  communication_verified_at: string | null;
  updated_at: string;
}

function rowToCompanyProfile(row: CompanyProfileRow): CompanyProfile {
  return {
    company_key: row.company_key,
    display_name: row.display_name,
    quality_score: row.quality_score,
    company_type: row.company_type,
    work_life: row.work_life,
    reputation_summary: row.reputation_summary,
    green_flags: safeJson<string[]>(row.green_flags_json, []),
    red_flags: safeJson<string[]>(row.red_flags_json, []),
    sources: safeJson(row.sources_json, []),
    confidence: row.confidence,
    researched_at: row.researched_at,
    expires_at: row.expires_at,
    last_error: row.last_error ?? undefined,
  };
}

function rowToContact(row: JobContactRow): JobContact {
  return {
    job_id: row.job_id,
    status: row.status,
    greeted_at: row.greeted_at ?? undefined,
    ready_to_apply_at: row.ready_to_apply_at ?? undefined,
    applied_at: row.applied_at ?? undefined,
    interviewing_at: row.interviewing_at ?? undefined,
    platform: row.platform ?? undefined,
    last_message: row.last_message ?? undefined,
    next_follow_up_at: row.next_follow_up_at ?? undefined,
    notes: row.notes ?? undefined,
    outcome: row.outcome ?? undefined,
    outcome_at: row.outcome_at ?? undefined,
    communication_source: row.communication_source ?? undefined,
    communication_verified_at: row.communication_verified_at ?? undefined,
    updated_at: row.updated_at,
  };
}

function rowToJob(row: JobRow): ScoredJob {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    company: row.company,
    company_key: row.company_key || normalizeCompanyKey(row.company),
    salary: row.salary,
    location: row.location,
    url: row.url,
    jd_fulltext: row.jd_fulltext,
    experience: row.experience ?? undefined,
    education: row.education ?? undefined,
    tags: safeJson<string[]>(row.tags_json, []),
    recruiter_name: row.recruiter_name ?? undefined,
    recruiter_title: row.recruiter_title ?? undefined,
    is_headhunter: Boolean(row.is_headhunter),
    company_industry: row.company_industry ?? undefined,
    company_stage: row.company_stage ?? undefined,
    company_scale: row.company_scale ?? undefined,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    lifecycle_status: row.lifecycle_status,
    archived_at: row.archived_at ?? undefined,
    score: safeJson(row.score_json, null)!,
    crawled_at: row.crawled_at,
    updated_at: row.updated_at,
  };
}

export interface UpsertStats {
  saved: number;
  inserted: number;
  updated: number;
  reactivated: number;
  deduplicated: number;
}

function jobCompleteness(job: RawJob): number {
  return [job.url, job.jd_fulltext, job.salary, job.location, job.experience, job.education,
    job.recruiter_name, job.recruiter_title, job.company_industry, job.company_stage, job.company_scale, ...(job.tags ?? [])]
    .reduce((score, value) => score + (String(value ?? '').trim() ? 1 : 0), 0);
}

function preferIncoming(existing: ScoredJob, incoming: ScoredJob): boolean {
  if (existing.is_headhunter !== incoming.is_headhunter) return !incoming.is_headhunter;
  return jobCompleteness(incoming) >= jobCompleteness(existing);
}

function sameStableJob(existing: JobRow, incoming: RawJob, canonicalUrl: string): boolean {
  if (!canonicalUrl || canonicalizeJobUrl(existing.url) !== canonicalUrl) return false;
  const fields: Array<[string | null | undefined, string | null | undefined]> = [
    [existing.source, incoming.source],
    [existing.title, incoming.title],
    [existing.company, incoming.company],
    [existing.location, incoming.location],
    [existing.salary, incoming.salary],
    [existing.experience, incoming.experience],
    [existing.education, incoming.education],
  ];
  return fields.every(([left, right]) => normalizeFingerprintText(left ?? '') === normalizeFingerprintText(right ?? ''));
}

export class JobStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;

  constructor(databasePath = appConfig.databasePath) {
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    ensurePrivateDirectory(dirname(databasePath));
    this.db = new DatabaseSync(databasePath);
    ensurePrivateFile(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const schemaVersion = Number(Object.values(this.db.prepare('PRAGMA user_version').get() as Record<string, unknown>)[0] ?? 0);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`数据库 schema 版本 ${schemaVersion} 高于当前程序支持的 ${CURRENT_SCHEMA_VERSION}，拒绝降级打开`);
    }
    const tables = Number((this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { count: number }).count);
    if (schemaVersion < CURRENT_SCHEMA_VERSION && tables > 0) {
      createVerifiedDatabaseBackup(databasePath, { kind: `pre-migration-v${schemaVersion}` });
    }
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        company_key TEXT NOT NULL DEFAULT '',
        salary TEXT NOT NULL,
        salary_upper REAL,
        location TEXT NOT NULL,
        url TEXT NOT NULL,
        jd_fulltext TEXT NOT NULL,
        experience TEXT,
        education TEXT,
        tags_json TEXT NOT NULL,
        recruiter_name TEXT,
        recruiter_title TEXT,
        is_headhunter INTEGER NOT NULL DEFAULT 0,
        company_industry TEXT,
        company_stage TEXT,
        company_scale TEXT,
        content_fingerprint TEXT NOT NULL DEFAULT '',
        score_total INTEGER NOT NULL,
        score_grade TEXT NOT NULL,
        score_json TEXT NOT NULL,
        crawled_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT NOT NULL DEFAULT '',
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score_total DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
      CREATE INDEX IF NOT EXISTS idx_jobs_grade ON jobs(score_grade);

      CREATE TABLE IF NOT EXISTS job_aliases (
        alias_url TEXT PRIMARY KEY,
        canonical_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_aliases_job ON job_aliases(canonical_job_id);

      CREATE TABLE IF NOT EXISTS company_profiles (
        company_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        quality_score INTEGER NOT NULL,
        company_type TEXT NOT NULL,
        work_life TEXT NOT NULL,
        reputation_summary TEXT NOT NULL,
        green_flags_json TEXT NOT NULL,
        red_flags_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        researched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_company_profiles_expires ON company_profiles(expires_at);

      CREATE TABLE IF NOT EXISTS job_contacts (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        greeted_at TEXT,
        ready_to_apply_at TEXT,
        applied_at TEXT,
        interviewing_at TEXT,
        platform TEXT,
        last_message TEXT,
        next_follow_up_at TEXT,
        notes TEXT,
        outcome TEXT,
        outcome_at TEXT,
        communication_source TEXT,
        communication_verified_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_contacts_status ON job_contacts(status);

      CREATE TABLE IF NOT EXISTS crawl_runs (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT,
        keywords_json TEXT NOT NULL,
        pages INTEGER NOT NULL,
        min_salary REAL,
        max_jobs INTEGER,
        current_page INTEGER NOT NULL DEFAULT 0,
        total_pages INTEGER NOT NULL DEFAULT 0,
        found INTEGER NOT NULL DEFAULT 0,
        saved INTEGER NOT NULL DEFAULT 0,
        inserted INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        reactivated INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        deduplicated INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL,
        error TEXT,
        failure_category TEXT,
        worker_pid INTEGER,
        heartbeat_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_created ON crawl_runs(created_at DESC);

      CREATE TABLE IF NOT EXISTS crawl_run_pages (
        run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        keyword TEXT NOT NULL,
        city TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        raw_count INTEGER NOT NULL DEFAULT 0,
        unique_count INTEGER NOT NULL DEFAULT 0,
        saved INTEGER NOT NULL DEFAULT 0,
        inserted INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        deduplicated INTEGER NOT NULL DEFAULT 0,
        detail_failed INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        committed_at TEXT,
        PRIMARY KEY(run_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS crawl_run_fingerprints (
        run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        PRIMARY KEY(run_id, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS crawl_job_observations (
        run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        job_id TEXT,
        source TEXT NOT NULL,
        platform_job_id TEXT,
        keyword TEXT NOT NULL,
        city TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        url TEXT NOT NULL,
        disposition TEXT NOT NULL,
        detail_status TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_crawl_observations_run ON crawl_job_observations(run_id, ordinal);
      CREATE TABLE IF NOT EXISTS source_health_checks (
        source TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT,
        detail_missing_count INTEGER NOT NULL DEFAULT 0,
        checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS application_events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        stage TEXT,
        note TEXT,
        reason_code TEXT,
        occurred_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_application_events_job ON application_events(job_id, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS job_content_versions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        origin TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(job_id, content_hash)
      );
      CREATE TABLE IF NOT EXISTS delete_challenges (
        token TEXT PRIMARY KEY,
        expected_count INTEGER NOT NULL,
        confirmation TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
    `);
    const jobColumns = new Set(
      (this.db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((column) => column.name)
    );
    if (!jobColumns.has('recruiter_name')) this.db.exec('ALTER TABLE jobs ADD COLUMN recruiter_name TEXT');
    if (!jobColumns.has('company_key')) this.db.exec("ALTER TABLE jobs ADD COLUMN company_key TEXT NOT NULL DEFAULT ''");
    if (!jobColumns.has('recruiter_title')) this.db.exec('ALTER TABLE jobs ADD COLUMN recruiter_title TEXT');
    if (!jobColumns.has('is_headhunter')) this.db.exec('ALTER TABLE jobs ADD COLUMN is_headhunter INTEGER NOT NULL DEFAULT 0');
    if (!jobColumns.has('company_industry')) this.db.exec('ALTER TABLE jobs ADD COLUMN company_industry TEXT');
    if (!jobColumns.has('company_stage')) this.db.exec('ALTER TABLE jobs ADD COLUMN company_stage TEXT');
    if (!jobColumns.has('company_scale')) this.db.exec('ALTER TABLE jobs ADD COLUMN company_scale TEXT');
    if (!jobColumns.has('content_fingerprint')) this.db.exec("ALTER TABLE jobs ADD COLUMN content_fingerprint TEXT NOT NULL DEFAULT ''");
    if (!jobColumns.has('first_seen_at')) this.db.exec("ALTER TABLE jobs ADD COLUMN first_seen_at TEXT NOT NULL DEFAULT ''");
    if (!jobColumns.has('last_seen_at')) this.db.exec("ALTER TABLE jobs ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''");
    if (!jobColumns.has('lifecycle_status')) this.db.exec("ALTER TABLE jobs ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'");
    if (!jobColumns.has('archived_at')) this.db.exec('ALTER TABLE jobs ADD COLUMN archived_at TEXT');
    const runColumns = new Set(
      (this.db.prepare('PRAGMA table_info(crawl_runs)').all() as Array<{ name: string }>).map((column) => column.name)
    );
    for (const column of ['inserted', 'updated', 'reactivated', 'archived', 'deduplicated']) {
      if (!runColumns.has(column)) this.db.exec(`ALTER TABLE crawl_runs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
    if (!runColumns.has('min_salary')) this.db.exec('ALTER TABLE crawl_runs ADD COLUMN min_salary REAL');
    if (!runColumns.has('max_jobs')) this.db.exec('ALTER TABLE crawl_runs ADD COLUMN max_jobs INTEGER');
    if (!runColumns.has('worker_pid')) this.db.exec('ALTER TABLE crawl_runs ADD COLUMN worker_pid INTEGER');
    if (!runColumns.has('heartbeat_at')) this.db.exec('ALTER TABLE crawl_runs ADD COLUMN heartbeat_at TEXT');
    if (!runColumns.has('failure_category')) this.db.exec('ALTER TABLE crawl_runs ADD COLUMN failure_category TEXT');
    const contactColumns = new Set(
      (this.db.prepare('PRAGMA table_info(job_contacts)').all() as Array<{ name: string }>).map((column) => column.name)
    );
    for (const column of ['ready_to_apply_at', 'applied_at', 'interviewing_at', 'outcome', 'outcome_at', 'communication_source', 'communication_verified_at']) {
      if (!contactColumns.has(column)) this.db.exec(`ALTER TABLE job_contacts ADD COLUMN ${column} TEXT`);
    }
    this.db.exec("UPDATE crawl_runs SET worker_pid = NULL, heartbeat_at = NULL WHERE status NOT IN ('queued', 'running')");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_aliases (
        alias_url TEXT PRIMARY KEY,
        canonical_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_aliases_job ON job_aliases(canonical_job_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint ON jobs(content_fingerprint);
      CREATE INDEX IF NOT EXISTS idx_jobs_lifecycle ON jobs(lifecycle_status, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_key);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS company_profiles (
        company_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        quality_score INTEGER NOT NULL,
        company_type TEXT NOT NULL,
        work_life TEXT NOT NULL,
        reputation_summary TEXT NOT NULL,
        green_flags_json TEXT NOT NULL,
        red_flags_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        researched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_company_profiles_expires ON company_profiles(expires_at);

      CREATE TABLE IF NOT EXISTS job_contacts (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        greeted_at TEXT,
        platform TEXT,
        last_message TEXT,
        next_follow_up_at TEXT,
        notes TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_job_contacts_status ON job_contacts(status);
    `);
    this.db.exec(`
      UPDATE jobs
      SET first_seen_at = CASE WHEN first_seen_at = '' THEN crawled_at ELSE first_seen_at END,
          last_seen_at = CASE WHEN last_seen_at = '' THEN crawled_at ELSE last_seen_at END,
          company_key = CASE WHEN company_key = '' THEN lower(replace(company, ' ', '')) ELSE company_key END,
          lifecycle_status = CASE WHEN lifecycle_status NOT IN ('active', 'archived') THEN 'active' ELSE lifecycle_status END
    `);
    this.backfillCompanyKeys();
    this.backfillScores();
    this.backfillFingerprints();
    this.markInterruptedRuns();
    this.archiveClosedJobs();
    this.archiveStaleJobs();
    this.db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  }

  schemaVersion(): number {
    return Number(Object.values(this.db.prepare('PRAGMA user_version').get() as Record<string, unknown>)[0] ?? 0);
  }

  migrateLegacyJson(path = appConfig.legacyJobsPath): number {
    if (this.countJobs() > 0 || !existsSync(path)) return 0;
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return 0;
      const parsed = JSON.parse(raw) as Array<Partial<ScoredJob>>;
      if (!Array.isArray(parsed)) return 0;
      const now = new Date().toISOString();
      const resume = readOptionalResume();
      const valid = parsed.filter((job) => Boolean(job.title && job.company && job.source)).map((legacy) => {
        const rawJob: RawJob = {
          title: legacy.title!,
          company: legacy.company!,
          source: legacy.source!,
          url: legacy.url || '',
          salary: legacy.salary || '',
          location: legacy.location || '',
          jd_fulltext: legacy.jd_fulltext || '',
          experience: legacy.experience,
          education: legacy.education,
          tags: legacy.tags,
          recruiter_name: legacy.recruiter_name,
          recruiter_title: legacy.recruiter_title,
          is_headhunter: legacy.is_headhunter,
          company_industry: legacy.company_industry,
          company_stage: legacy.company_stage,
          company_scale: legacy.company_scale,
        };
        return {
          ...rawJob,
          id: createJobId(rawJob),
          company_key: normalizeCompanyKey(rawJob.company),
          score: scoreWithRules(rawJob, null, undefined, null, resume),
          crawled_at: legacy.crawled_at || now,
          updated_at: now,
          first_seen_at: legacy.first_seen_at || legacy.crawled_at || now,
          last_seen_at: now,
          lifecycle_status: 'active' as const,
        } satisfies ScoredJob;
      });
      return this.upsertJobs(valid);
    } catch (error) {
      console.warn(`[storage] 旧 jobs.json 无法迁移：${(error as Error).message}`);
      return 0;
    }
  }

  countJobs(lifecycle: LifecycleStatus | 'all' = 'all'): number {
    const row = lifecycle === 'all'
      ? this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()
      : this.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE lifecycle_status = ?').get(lifecycle);
    return Number((row as { count: number }).count);
  }

  upsertJobs(jobs: ScoredJob[]): number {
    return this.upsertJobsDetailed(jobs).saved;
  }

  upsertJobsDetailed(jobs: ScoredJob[], withinTransaction = false): UpsertStats {
    const stats: UpsertStats = { saved: 0, inserted: 0, updated: 0, reactivated: 0, deduplicated: 0 };
    if (!jobs.length) return stats;
    const seenFingerprints = new Set<string>();
    const insert = this.db.prepare(`
      INSERT INTO jobs (
        id, source, title, company, company_key, salary, salary_upper, location, url, jd_fulltext,
        experience, education, tags_json, recruiter_name, recruiter_title, is_headhunter,
        company_industry, company_stage, company_scale,
        content_fingerprint, score_total, score_grade, score_json, crawled_at, updated_at,
        first_seen_at, last_seen_at, lifecycle_status, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL)
    `);
    const update = this.db.prepare(`
      UPDATE jobs SET
        source = ?, title = ?, company = ?, company_key = ?, salary = ?, salary_upper = ?, location = ?,
        url = ?, jd_fulltext = ?, experience = ?, education = ?, tags_json = ?,
        recruiter_name = ?, recruiter_title = ?, is_headhunter = ?,
        company_industry = ?, company_stage = ?, company_scale = ?, content_fingerprint = ?,
        score_total = ?, score_grade = ?, score_json = ?, updated_at = ?, last_seen_at = ?,
        lifecycle_status = CASE
          WHEN EXISTS (
            SELECT 1 FROM job_contacts
            WHERE job_contacts.job_id = jobs.id AND job_contacts.status = 'closed'
          ) THEN 'archived'
          ELSE 'active'
        END,
        archived_at = CASE
          WHEN EXISTS (
            SELECT 1 FROM job_contacts
            WHERE job_contacts.job_id = jobs.id AND job_contacts.status = 'closed'
          ) THEN COALESCE(archived_at, ?)
          ELSE NULL
        END
      WHERE id = ?
    `);
    const findByAlias = this.db.prepare(`
      SELECT jobs.* FROM job_aliases
      JOIN jobs ON jobs.id = job_aliases.canonical_job_id
      WHERE job_aliases.alias_url = ?
    `);
    const findById = this.db.prepare('SELECT * FROM jobs WHERE id = ?');
    const findByFingerprint = this.db.prepare(`
      SELECT * FROM jobs WHERE content_fingerprint = ?
      ORDER BY is_headhunter ASC, LENGTH(jd_fulltext) DESC, last_seen_at DESC LIMIT 1
    `);
    const addAlias = this.db.prepare(`
      INSERT INTO job_aliases(alias_url, canonical_job_id, created_at)
      VALUES (?, ?, ?) ON CONFLICT(alias_url) DO UPDATE SET
        canonical_job_id = excluded.canonical_job_id,
        created_at = excluded.created_at
    `);
    if (!withinTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const job of jobs) {
        const now = new Date().toISOString();
        const baseIncomingId = job.id || createJobId(job);
        const canonicalUrl = canonicalizeJobUrl(job.url);
        const fingerprint = createContentFingerprint(job);
        const batchDuplicate = seenFingerprints.has(fingerprint);
        seenFingerprints.add(fingerprint);
        if (batchDuplicate) stats.deduplicated++;
        const salaryUpper = parseSalary(job.salary)?.maxK ?? null;
        const aliasRow = (canonicalUrl ? findByAlias.get(canonicalUrl) : undefined) as unknown as JobRow | undefined;
        const idRow = findById.get(baseIncomingId) as unknown as JobRow | undefined;
        const stableIdRow = idRow && sameStableJob(idRow, job, canonicalUrl) ? idRow : undefined;
        const existingRow = (
          (aliasRow?.content_fingerprint === fingerprint ? aliasRow : undefined)
          ?? (idRow?.content_fingerprint === fingerprint ? idRow : undefined)
          ?? stableIdRow
          ?? findByFingerprint.get(fingerprint)
        ) as unknown as JobRow | undefined;

        if (!existingRow) {
          const incomingId = idRow ? `${baseIncomingId}-${fingerprint.slice(0, 8)}` : baseIncomingId;
          const firstSeenAt = job.first_seen_at || job.crawled_at || now;
          const lastSeenAt = job.last_seen_at || now;
          const companyKey = job.company_key || normalizeCompanyKey(job.company);
          insert.run(
            incomingId, job.source, job.title, job.company, companyKey, job.salary, salaryUpper,
            job.location, canonicalUrl, job.jd_fulltext, job.experience ?? null,
            job.education ?? null, JSON.stringify(job.tags ?? []), job.recruiter_name ?? null,
            job.recruiter_title ?? null, job.is_headhunter ? 1 : 0,
            job.company_industry ?? null, job.company_stage ?? null, job.company_scale ?? null, fingerprint,
            job.score.total, job.score.grade, JSON.stringify(job.score), job.crawled_at,
            job.updated_at, firstSeenAt, lastSeenAt
          );
          if (canonicalUrl) addAlias.run(canonicalUrl, incomingId, now);
          stats.inserted++;
          stats.saved++;
          continue;
        }

        const existing = rowToJob(existingRow);
        const duplicate = existing.id !== baseIncomingId;
        if (duplicate && !batchDuplicate) stats.deduplicated++;
        const existingContact = this.getJobContact(existing.id);
        if (existing.lifecycle_status === 'archived' && existingContact.status !== 'closed') stats.reactivated++;
        const selected = preferIncoming(existing, job) ? job : existing;
        const selectedUrl = selected === job ? canonicalUrl : canonicalizeJobUrl(existing.url);
        const selectedFingerprint = createContentFingerprint(selected);
        const selectedCompanyKey = selected.company_key || normalizeCompanyKey(selected.company);
        update.run(
          selected.source, selected.title, selected.company, selectedCompanyKey, selected.salary,
          parseSalary(selected.salary)?.maxK ?? null, selected.location, selectedUrl,
          selected.jd_fulltext, selected.experience ?? null, selected.education ?? null,
          JSON.stringify(selected.tags ?? []), selected.recruiter_name ?? null,
          selected.recruiter_title ?? null, selected.is_headhunter ? 1 : 0,
          selected.company_industry ?? null, selected.company_stage ?? null, selected.company_scale ?? null, selectedFingerprint,
          selected.score.total, selected.score.grade, JSON.stringify(selected.score),
          selected === job ? job.updated_at : existing.updated_at,
          job.last_seen_at || now, now, existing.id
        );
        const existingUrl = canonicalizeJobUrl(existing.url);
        if (existingUrl) addAlias.run(existingUrl, existing.id, now);
        if (canonicalUrl) addAlias.run(canonicalUrl, existing.id, now);
        if (!batchDuplicate) {
          stats.updated++;
          stats.saved++;
        }
      }
      if (!withinTransaction) this.db.exec('COMMIT');
      return stats;
    } catch (error) {
      if (!withinTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listJobs(filters: JobFilters = {}): ScoredJob[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    const lifecycle = filters.lifecycle ?? 'active';
    if (lifecycle !== 'all') {
      where.push('lifecycle_status = ?');
      params.push(lifecycle);
    }
    if (lifecycle === 'active') {
      where.push(`NOT EXISTS (
        SELECT 1 FROM job_contacts
        WHERE job_contacts.job_id = jobs.id
          AND job_contacts.status = 'closed'
      )`);
    }
    if (filters.grade?.length) {
      where.push(`score_grade IN (${filters.grade.map(() => '?').join(',')})`);
      params.push(...filters.grade);
    }
    if (filters.source?.length) {
      where.push(`source IN (${filters.source.map(() => '?').join(',')})`);
      params.push(...filters.source);
    }
    if (filters.minSalary !== undefined) {
      where.push('COALESCE(salary_upper, 0) >= ?');
      params.push(filters.minSalary);
    }
    if (filters.q) {
      where.push('(title LIKE ? OR company LIKE ? OR jd_fulltext LIKE ?)');
      const query = `%${filters.q}%`;
      params.push(query, query, query);
    }
    const priorityBlockingRisk = `EXISTS (
      SELECT 1 FROM json_each(jobs.score_json, '$.red_flags') AS risk
      WHERE risk.value LIKE '%编码%'
        OR risk.value LIKE '%工程开发%'
        OR risk.value LIKE '%模型训练%'
        OR risk.value LIKE '%微调%'
        OR risk.value LIKE '%推理部署%'
        OR risk.value LIKE '%销售指标%'
        OR risk.value LIKE '%获客%'
        OR risk.value LIKE '%客户资源%'
        OR risk.value LIKE '%强压%'
        OR risk.value LIKE '%加班%'
    )`;
    const priorityOrder = `CASE
      WHEN score_grade = 'A' THEN 0
      WHEN score_grade = 'B' AND score_total >= 80 AND NOT (${priorityBlockingRisk}) THEN 1
      WHEN score_grade = 'B' THEN 2
      WHEN score_grade = 'C' THEN 3
      ELSE 4
    END, score_total DESC, COALESCE(json_extract(score_json, '$.company_quality_score'), 70) DESC, updated_at DESC`;
    const order = filters.sort === 'score-desc'
      ? "score_total DESC, COALESCE(json_extract(score_json, '$.company_quality_score'), 70) DESC, updated_at DESC"
      : filters.sort === 'fresh-desc'
        ? 'last_seen_at DESC, score_total DESC'
        : filters.sort === 'salary-desc'
          ? 'COALESCE(salary_upper, 0) DESC'
          : filters.sort === 'salary-asc'
            ? 'COALESCE(salary_upper, 0) ASC'
            : priorityOrder;
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`;
    return (this.db.prepare(sql).all(...params) as unknown as JobRow[]).map((row) => this.enrichJob(rowToJob(row)));
  }

  getJob(id: string): ScoredJob | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
    return row ? this.enrichJob(rowToJob(row)) : null;
  }

  getJobDetailByUrl(url: string): string | undefined {
    const canonical = canonicalizeJobUrl(url);
    if (!canonical) return undefined;
    const row = this.db.prepare(`
      SELECT jd_fulltext FROM jobs
      WHERE url = ? OR id IN (SELECT canonical_job_id FROM job_aliases WHERE alias_url = ?)
      ORDER BY LENGTH(TRIM(jd_fulltext)) DESC, last_seen_at DESC LIMIT 1
    `).get(canonical, canonical) as { jd_fulltext?: string } | undefined;
    return row?.jd_fulltext;
  }

  getCompanyProfile(companyKeyOrName: string): CompanyProfile | null {
    const key = normalizeCompanyKey(companyKeyOrName);
    const row = this.db.prepare('SELECT * FROM company_profiles WHERE company_key = ?').get(key) as unknown as CompanyProfileRow | undefined;
    return row ? rowToCompanyProfile(row) : null;
  }

  getFreshCompanyProfile(companyKeyOrName: string, now = new Date()): CompanyProfile | null {
    const profile = this.getCompanyProfile(companyKeyOrName);
    if (!profile) return null;
    return new Date(profile.expires_at).getTime() > now.getTime() ? profile : null;
  }

  upsertCompanyProfile(profile: CompanyProfile): void {
    this.db.prepare(`
      INSERT INTO company_profiles (
        company_key, display_name, quality_score, company_type, work_life, reputation_summary,
        green_flags_json, red_flags_json, sources_json, confidence, researched_at, expires_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_key) DO UPDATE SET
        display_name = excluded.display_name,
        quality_score = excluded.quality_score,
        company_type = excluded.company_type,
        work_life = excluded.work_life,
        reputation_summary = excluded.reputation_summary,
        green_flags_json = excluded.green_flags_json,
        red_flags_json = excluded.red_flags_json,
        sources_json = excluded.sources_json,
        confidence = excluded.confidence,
        researched_at = excluded.researched_at,
        expires_at = excluded.expires_at,
        last_error = excluded.last_error
    `).run(
      profile.company_key, profile.display_name, profile.quality_score, profile.company_type,
      profile.work_life, profile.reputation_summary, JSON.stringify(profile.green_flags),
      JSON.stringify(profile.red_flags), JSON.stringify(profile.sources), profile.confidence,
      profile.researched_at, profile.expires_at, profile.last_error ?? null
    );
  }

  getJobContact(jobId: string): JobContact {
    const row = this.db.prepare('SELECT * FROM job_contacts WHERE job_id = ?').get(jobId) as unknown as JobContactRow | undefined;
    if (row) return rowToContact(row);
    return { job_id: jobId, status: 'unprocessed', updated_at: '' };
  }

  updateJobContact(jobId: string, changes: Partial<Omit<JobContact, 'job_id' | 'updated_at'>>): JobContact {
    const current = this.getJobContact(jobId);
    const updatedAt = new Date().toISOString();
    const next: JobContact = {
      ...current,
      ...changes,
      job_id: jobId,
      updated_at: updatedAt,
    };
    if (next.status === 'greeted' && !next.greeted_at) next.greeted_at = updatedAt;
    if (next.status === 'ready_to_apply' && !next.ready_to_apply_at) next.ready_to_apply_at = updatedAt;
    if (next.status === 'applied' && !next.applied_at) next.applied_at = updatedAt;
    if (next.status === 'interviewing' && !next.interviewing_at) next.interviewing_at = updatedAt;
    if (next.outcome && !next.outcome_at) next.outcome_at = updatedAt;
    this.db.prepare(`
      INSERT INTO job_contacts (
        job_id, status, greeted_at, ready_to_apply_at, applied_at, interviewing_at,
        platform, last_message, next_follow_up_at, notes, outcome, outcome_at,
        communication_source, communication_verified_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        greeted_at = excluded.greeted_at,
        ready_to_apply_at = excluded.ready_to_apply_at,
        applied_at = excluded.applied_at,
        interviewing_at = excluded.interviewing_at,
        platform = excluded.platform,
        last_message = excluded.last_message,
        next_follow_up_at = excluded.next_follow_up_at,
        notes = excluded.notes,
        outcome = excluded.outcome,
        outcome_at = excluded.outcome_at,
        communication_source = excluded.communication_source,
        communication_verified_at = excluded.communication_verified_at,
        updated_at = excluded.updated_at
    `).run(
      next.job_id, next.status, next.greeted_at ?? null, next.ready_to_apply_at ?? null,
      next.applied_at ?? null, next.interviewing_at ?? null, next.platform ?? null,
      next.last_message ?? null, next.next_follow_up_at ?? null, next.notes ?? null,
      next.outcome ?? null, next.outcome_at ?? null, next.communication_source ?? null,
      next.communication_verified_at ?? null, next.updated_at
    );
    if (next.status === 'closed') {
      this.archiveClosedJobs(new Date(updatedAt));
    } else if (PROTECTED_CONTACT_STATUSES.includes(next.status)) {
      this.db.prepare(`
        UPDATE jobs
        SET lifecycle_status = 'active', archived_at = NULL
        WHERE id = ? AND lifecycle_status = 'archived'
      `).run(jobId);
    }
    return next;
  }

  deleteJobs(): number {
    return Number(this.db.prepare('DELETE FROM jobs').run().changes);
  }

  createDeleteChallenge(now = new Date()): { token: string; expectedCount: number; confirmation: string; expiresAt: string } {
    const token = randomUUID();
    const expectedCount = this.countJobs('all');
    const confirmation = `DELETE ${expectedCount} JOBS`;
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    this.db.prepare('INSERT INTO delete_challenges(token, expected_count, confirmation, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, expectedCount, confirmation, expiresAt);
    return { token, expectedCount, confirmation, expiresAt };
  }

  deleteJobsWithChallenge(input: { token: string; expectedCount: number; confirmation: string }, now = new Date()): { deleted: number; backupPath: string } {
    const challenge = this.db.prepare('SELECT * FROM delete_challenges WHERE token = ?').get(input.token) as {
      expected_count: number; confirmation: string; expires_at: string; used_at: string | null;
    } | undefined;
    if (!challenge || challenge.used_at) throw new Error('删除挑战不存在或已使用');
    if (new Date(challenge.expires_at).getTime() < now.getTime()) throw new Error('删除挑战已过期');
    const actualCount = this.countJobs('all');
    if (input.expectedCount !== challenge.expected_count || actualCount !== challenge.expected_count) throw new Error('岗位数量已变化，请重新申请删除挑战');
    if (input.confirmation !== challenge.confirmation) throw new Error(`确认短语必须为：${challenge.confirmation}`);
    if (this.findActiveRun()) throw new Error('存在活动任务，拒绝删除岗位');
    let backup: ReturnType<typeof createVerifiedDatabaseBackup>;
    try {
      backup = createVerifiedDatabaseBackup(this.databasePath, { kind: 'pre-delete' });
    } catch {
      throw new Error('删除前验证备份失败，未删除任何岗位');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const deleted = Number(this.db.prepare('DELETE FROM jobs').run().changes);
      this.db.prepare('UPDATE delete_challenges SET used_at = ? WHERE token = ?').run(now.toISOString(), input.token);
      this.db.exec('COMMIT');
      return { deleted, backupPath: backup.path };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteDemoJobs(): number {
    return Number(this.db.prepare("DELETE FROM jobs WHERE url LIKE 'mock://%'").run().changes);
  }

  archiveClosedJobs(now = new Date()): number {
    return Number(this.db.prepare(`
      UPDATE jobs
      SET lifecycle_status = 'archived', archived_at = ?
      WHERE lifecycle_status = 'active'
        AND EXISTS (
          SELECT 1 FROM job_contacts
          WHERE job_contacts.job_id = jobs.id
            AND job_contacts.status = 'closed'
        )
    `).run(now.toISOString()).changes);
  }

  archiveStaleJobs(now = new Date(), archiveDays: ArchiveDaysConfig = appConfig.archiveDays): number {
    const days = typeof archiveDays === 'number'
      ? { A: archiveDays, B: archiveDays, C: archiveDays, D: archiveDays }
      : { ...appConfig.archiveDays, ...archiveDays };
    const cutoff = (grade: Grade) => new Date(now.getTime() - days[grade] * 24 * 60 * 60 * 1000).toISOString();
    return Number(this.db.prepare(`
      UPDATE jobs
      SET lifecycle_status = 'archived', archived_at = ?
      WHERE lifecycle_status = 'active'
        AND (
          (score_grade = 'A' AND last_seen_at < ?)
          OR (score_grade = 'B' AND last_seen_at < ?)
          OR (score_grade = 'C' AND last_seen_at < ?)
          OR (score_grade = 'D' AND last_seen_at < ?)
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_contacts
          WHERE job_contacts.job_id = jobs.id
            AND job_contacts.status IN (${PROTECTED_CONTACT_STATUSES.map(() => '?').join(',')})
        )
    `).run(
      now.toISOString(),
      cutoff('A'), cutoff('B'), cutoff('C'), cutoff('D'),
      ...PROTECTED_CONTACT_STATUSES
    ).changes);
  }

  lifecycleCounts(): { active: number; archived: number; total: number } {
    const rows = this.db.prepare(`
      SELECT lifecycle_status AS status, COUNT(*) AS count
      FROM jobs GROUP BY lifecycle_status
    `).all() as Array<{ status: LifecycleStatus; count: number }>;
    const counts = { active: 0, archived: 0, total: 0 };
    for (const row of rows) {
      counts[row.status] = Number(row.count);
      counts.total += Number(row.count);
    }
    return counts;
  }

  createRun(input: { operation: RunOperation; source?: JobSource; keywords?: string[]; pages?: number; minSalary?: number; maxJobs?: number }): CrawlRun {
    const createdAt = new Date().toISOString();
    const run: CrawlRun = {
      id: randomUUID(),
      operation: input.operation,
      status: 'queued',
      source: input.source ?? null,
      keywords: input.keywords ?? [],
      pages: input.pages ?? 0,
      minSalary: input.minSalary,
      maxJobs: input.maxJobs,
      currentPage: 0,
      totalPages: (input.pages ?? 0) * (input.keywords?.length ?? 0),
      found: 0,
      saved: 0,
      inserted: 0,
      updated: 0,
      reactivated: 0,
      archived: 0,
      deduplicated: 0,
      message: '等待执行',
      createdAt,
    };
    this.db.prepare(`
      INSERT INTO crawl_runs (
        id, operation, status, source, keywords_json, pages, min_salary, max_jobs, current_page, total_pages,
        found, saved, inserted, updated, reactivated, archived, deduplicated,
        message, error, failure_category, worker_pid, heartbeat_at, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.operation, run.status, run.source, JSON.stringify(run.keywords), run.pages, run.minSalary ?? null, run.maxJobs ?? null,
      run.currentPage, run.totalPages, run.found, run.saved, run.inserted, run.updated,
      run.reactivated, run.archived, run.deduplicated, run.message, null, null, null, null, null, null, run.createdAt
    );
    return run;
  }

  updateRun(id: string, changes: Partial<Omit<CrawlRun, 'id' | 'createdAt'>>): CrawlRun {
    const current = this.getRun(id);
    if (!current) throw new Error(`任务不存在：${id}`);
    const next = { ...current, ...changes };
    this.db.prepare(`
      UPDATE crawl_runs SET
        operation = ?, status = ?, source = ?, keywords_json = ?, pages = ?, min_salary = ?, max_jobs = ?, current_page = ?,
        total_pages = ?, found = ?, saved = ?, inserted = ?, updated = ?, reactivated = ?,
        archived = ?, deduplicated = ?, message = ?, error = ?, failure_category = ?, worker_pid = ?, heartbeat_at = ?,
        started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      next.operation, next.status, next.source, JSON.stringify(next.keywords), next.pages, next.minSalary ?? null, next.maxJobs ?? null,
      next.currentPage, next.totalPages, next.found, next.saved, next.inserted, next.updated,
      next.reactivated, next.archived, next.deduplicated, next.message, next.error ?? null,
      next.failureCategory ?? null, next.workerPid ?? null, next.heartbeatAt ?? null, next.startedAt ?? null, next.finishedAt ?? null, id
    );
    return next;
  }

  assignRunWorker(id: string, workerPid: number, heartbeatAt = new Date().toISOString()): CrawlRun {
    return this.updateRun(id, { workerPid, heartbeatAt });
  }

  touchRunHeartbeat(id: string, workerPid = process.pid, heartbeatAt = new Date().toISOString()): void {
    this.db.prepare('UPDATE crawl_runs SET worker_pid = ?, heartbeat_at = ? WHERE id = ?').run(workerPid, heartbeatAt, id);
  }

  getRun(id: string): CrawlRun | null {
    const row = this.db.prepare('SELECT * FROM crawl_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : null;
  }

  latestRun(): CrawlRun | null {
    this.markInterruptedRuns();
    const row = this.db.prepare('SELECT * FROM crawl_runs ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : null;
  }

  findActiveRun(): CrawlRun | null {
    this.markInterruptedRuns();
    const row = this.db.prepare("SELECT * FROM crawl_runs WHERE status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : null;
  }

  markInterruptedRuns(now = new Date()): number {
    const activeRuns = this.db.prepare(`
      SELECT id, worker_pid, heartbeat_at
      FROM crawl_runs
      WHERE status IN ('queued', 'running')
    `).all() as Array<{ id: string; worker_pid: number | null; heartbeat_at: string | null }>;
    const cutoff = now.getTime() - RUN_HEARTBEAT_STALE_MS;
    const interrupt = this.db.prepare(`
      UPDATE crawl_runs
      SET status = 'interrupted', message = '进程重启，任务已中断', finished_at = ?
      WHERE id = ?
    `);
    let changed = 0;
    for (const run of activeRuns) {
      const heartbeatFresh = run.heartbeat_at ? new Date(run.heartbeat_at).getTime() >= cutoff : false;
      if (isProcessAlive(run.worker_pid) && heartbeatFresh) continue;
      changed += Number(interrupt.run(now.toISOString(), run.id).changes);
    }
    return changed;
  }

  listRuns(limit = 50): CrawlRun[] {
    this.markInterruptedRuns();
    return (this.db.prepare('SELECT * FROM crawl_runs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>)
      .map((row) => this.rowToRun(row));
  }

  cancelRun(id: string): CrawlRun {
    const run = this.getRun(id);
    if (!run) throw new Error('任务不存在');
    if (!['queued', 'running'].includes(run.status)) throw new Error('只有等待或运行中的任务可以取消');
    if (run.workerPid && isProcessAlive(run.workerPid) && run.workerPid !== process.pid) {
      try { process.kill(run.workerPid, 'SIGTERM'); } catch {}
    }
    return this.updateRun(id, { status: 'cancelled', message: '已由用户取消', finishedAt: new Date().toISOString(), workerPid: undefined, heartbeatAt: undefined });
  }

  listRunFingerprints(runId: string): string[] {
    return (this.db.prepare('SELECT fingerprint FROM crawl_run_fingerprints WHERE run_id = ?').all(runId) as Array<{ fingerprint: string }>).map((row) => row.fingerprint);
  }

  recordCrawlPage(input: {
    page: CrawlRunPage;
    fingerprints: string[];
    observations: CrawlJobObservation[];
  }, withinTransaction = false): void {
    const { page } = input;
    if (!withinTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO crawl_run_pages(run_id, ordinal, keyword, city, page_number, status, raw_count, unique_count,
          saved, inserted, updated, deduplicated, detail_failed, error_message, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, ordinal) DO UPDATE SET status=excluded.status, raw_count=excluded.raw_count,
          unique_count=excluded.unique_count, saved=excluded.saved, inserted=excluded.inserted, updated=excluded.updated,
          deduplicated=excluded.deduplicated, detail_failed=excluded.detail_failed, error_message=excluded.error_message,
          committed_at=excluded.committed_at
      `).run(page.runId, page.ordinal, page.keyword, page.city, page.pageNumber, page.status, page.rawCount,
        page.uniqueCount, page.saved, page.inserted, page.updated, page.deduplicated, page.detailFailed,
        page.errorMessage ?? null, page.committedAt ?? null);
      const addFingerprint = this.db.prepare('INSERT OR IGNORE INTO crawl_run_fingerprints(run_id, fingerprint) VALUES (?, ?)');
      for (const fingerprint of input.fingerprints) addFingerprint.run(page.runId, fingerprint);
      this.db.prepare('DELETE FROM crawl_job_observations WHERE run_id = ? AND ordinal = ?').run(page.runId, page.ordinal);
      const addObservation = this.db.prepare(`
        INSERT INTO crawl_job_observations(run_id, ordinal, job_id, source, platform_job_id, keyword, city,
          page_number, rank, title, company, url, disposition, detail_status, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of input.observations) addObservation.run(item.runId, item.ordinal, item.jobId ?? null, item.source,
        item.platformJobId ?? null, item.keyword, item.city, item.pageNumber, item.rank, item.title, item.company,
        item.url, item.disposition, item.detailStatus, item.observedAt);
      if (!withinTransaction) this.db.exec('COMMIT');
    } catch (error) {
      if (!withinTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  commitCrawlPage(input: {
    jobs: ScoredJob[];
    page: Omit<CrawlRunPage, 'saved' | 'inserted' | 'updated' | 'deduplicated'>;
    fingerprints: string[];
    observations: CrawlJobObservation[];
  }): UpsertStats {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stats = this.upsertJobsDetailed(input.jobs, true);
      this.recordCrawlPage({
        page: {
          ...input.page,
          saved: stats.saved,
          inserted: stats.inserted,
          updated: stats.updated,
          deduplicated: stats.deduplicated,
        },
        fingerprints: input.fingerprints,
        observations: input.observations,
      }, true);
      this.db.exec('COMMIT');
      return stats;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listRunPages(runId: string): CrawlRunPage[] {
    const rows = this.db.prepare('SELECT * FROM crawl_run_pages WHERE run_id = ? ORDER BY ordinal').all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: String(row.run_id), ordinal: Number(row.ordinal), keyword: String(row.keyword), city: String(row.city),
      pageNumber: Number(row.page_number), status: row.status as CrawlRunPage['status'], rawCount: Number(row.raw_count),
      uniqueCount: Number(row.unique_count), saved: Number(row.saved), inserted: Number(row.inserted), updated: Number(row.updated),
      deduplicated: Number(row.deduplicated), detailFailed: Number(row.detail_failed),
      errorMessage: row.error_message ? String(row.error_message) : undefined,
      committedAt: row.committed_at ? String(row.committed_at) : undefined,
    }));
  }

  listRunObservations(runId: string): CrawlJobObservation[] {
    return (this.db.prepare('SELECT * FROM crawl_job_observations WHERE run_id = ? ORDER BY ordinal, rank').all(runId) as Array<Record<string, unknown>>).map((row) => ({
      runId: String(row.run_id), ordinal: Number(row.ordinal), jobId: row.job_id ? String(row.job_id) : undefined,
      source: row.source as JobSource, platformJobId: row.platform_job_id ? String(row.platform_job_id) : undefined,
      keyword: String(row.keyword), city: String(row.city), pageNumber: Number(row.page_number), rank: Number(row.rank),
      title: String(row.title), company: String(row.company), url: String(row.url),
      disposition: row.disposition as CrawlJobObservation['disposition'], detailStatus: row.detail_status as CrawlJobObservation['detailStatus'],
      observedAt: String(row.observed_at),
    }));
  }

  recordSourceHealth(health: JobSourceHealth): JobSourceHealth {
    this.db.prepare(`
      INSERT INTO source_health_checks(source, status, last_success_at, last_failure_at, last_error, detail_missing_count, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET status=excluded.status,
        last_success_at=COALESCE(excluded.last_success_at, source_health_checks.last_success_at),
        last_failure_at=COALESCE(excluded.last_failure_at, source_health_checks.last_failure_at),
        last_error=excluded.last_error, detail_missing_count=excluded.detail_missing_count, checked_at=excluded.checked_at
    `).run(health.source, health.status, health.last_success_at ?? null, health.last_failure_at ?? null,
      health.last_error ?? null, health.detail_missing_count, health.checked_at);
    return health;
  }

  listSourceHealth(): JobSourceHealth[] {
    const existing = new Map((this.db.prepare('SELECT * FROM source_health_checks').all() as Array<Record<string, unknown>>).map((row) => [String(row.source), row]));
    return (['boss', 'liepin', 'zhaopin'] as JobSource[]).map((source) => {
      const row = existing.get(source);
      return row ? {
        source, status: row.status as JobSourceHealth['status'], last_success_at: row.last_success_at ? String(row.last_success_at) : undefined,
        last_failure_at: row.last_failure_at ? String(row.last_failure_at) : undefined,
        last_error: row.last_error ? String(row.last_error) : undefined, detail_missing_count: Number(row.detail_missing_count), checked_at: String(row.checked_at),
      } : { source, status: 'unknown', detail_missing_count: 0, checked_at: '' };
    });
  }

  listApplicationEvents(jobId: string): ApplicationEvent[] {
    return (this.db.prepare('SELECT * FROM application_events WHERE job_id = ? ORDER BY occurred_at DESC, created_at DESC').all(jobId) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), job_id: String(row.job_id), type: row.type as ApplicationEventType,
      stage: row.stage ? String(row.stage) : undefined, note: row.note ? String(row.note) : undefined,
      reason_code: row.reason_code ? String(row.reason_code) : undefined, occurred_at: String(row.occurred_at),
      idempotency_key: String(row.idempotency_key), created_at: String(row.created_at),
    }));
  }

  recordApplicationEvent(input: {
    jobId: string; type: ApplicationEventType; stage?: string; note?: string; reasonCode?: string;
    occurredAt?: string; idempotencyKey?: string;
  }): ApplicationEvent {
    if (!this.getJob(input.jobId)) throw new Error('岗位不存在');
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const idempotencyKey = input.idempotencyKey ?? `${input.jobId}:${input.type}:${occurredAt}`;
    const existing = this.db.prepare('SELECT * FROM application_events WHERE idempotency_key = ?').get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return this.listApplicationEvents(input.jobId).find((item) => item.id === String(existing.id))!;
    const event: ApplicationEvent = {
      id: randomUUID(), job_id: input.jobId, type: input.type, stage: input.stage, note: input.note,
      reason_code: input.reasonCode, occurred_at: occurredAt, idempotency_key: idempotencyKey, created_at: new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO application_events(id, job_id, type, stage, note, reason_code, occurred_at, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.job_id, event.type, event.stage ?? null, event.note ?? null, event.reason_code ?? null,
        event.occurred_at, event.idempotency_key, event.created_at);
    if (input.type === 'applied') this.updateJobContact(input.jobId, { status: 'applied' });
    if (['interview_scheduled', 'interview_completed'].includes(input.type)) this.updateJobContact(input.jobId, { status: 'interviewing' });
    if (input.type === 'offer') this.updateJobContact(input.jobId, { outcome: 'offer' });
    if (input.type === 'accepted') this.updateJobContact(input.jobId, { status: 'closed', outcome: 'accepted' });
    if (input.type === 'rejected') this.updateJobContact(input.jobId, { status: 'rejected', outcome: 'rejected' });
    if (input.type === 'withdrawn') this.updateJobContact(input.jobId, { status: 'closed', outcome: 'withdrawn' });
    if (input.type === 'no_response') this.updateJobContact(input.jobId, { status: 'closed', outcome: 'no_response' });
    return event;
  }

  contactFunnel(now = new Date()): ContactFunnelStats {
    const rows = this.db.prepare('SELECT * FROM job_contacts').all() as unknown as JobContactRow[];
    const contacts = rows.map(rowToContact);
    const outcomeCounts: Record<ContactOutcome, number> = { offer: 0, accepted: 0, rejected: 0, withdrawn: 0, no_response: 0 };
    for (const contact of contacts) if (contact.outcome) outcomeCounts[contact.outcome]++;
    const stages = {
      ready_to_apply: contacts.filter((item) => item.status === 'ready_to_apply').length,
      applied: contacts.filter((item) => Boolean(item.applied_at) || ['applied', 'interviewing'].includes(item.status)).length,
      interviewing: contacts.filter((item) => Boolean(item.interviewing_at) || item.status === 'interviewing').length,
      outcome: contacts.filter((item) => Boolean(item.outcome)).length,
      positive_outcome: outcomeCounts.offer + outcomeCounts.accepted,
    };
    return {
      generated_at: now.toISOString(), stages,
      due_follow_ups: contacts.filter((item) => item.next_follow_up_at && new Date(item.next_follow_up_at) <= now && !['closed', 'rejected'].includes(item.status)).length,
      outcomes: outcomeCounts,
      conversion: {
        application_to_interview: stages.applied ? stages.interviewing / stages.applied : 0,
        interview_to_positive_outcome: stages.interviewing ? stages.positive_outcome / stages.interviewing : 0,
      },
    };
  }

  listJobContentVersions(jobId: string): JobContentVersion[] {
    return (this.db.prepare('SELECT * FROM job_content_versions WHERE job_id = ? ORDER BY created_at DESC').all(jobId) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), job_id: String(row.job_id), origin: row.origin as JobContentVersion['origin'], content: String(row.content),
      content_hash: String(row.content_hash), active: Boolean(row.active), created_at: String(row.created_at),
    }));
  }

  addJobContentVersion(jobId: string, content: string, origin: JobContentVersion['origin'], activate = true): JobContentVersion {
    if (!this.getJob(jobId)) throw new Error('岗位不存在');
    const normalized = content.trim();
    if (normalized.length < 80) throw new Error('完整 JD 至少需要 80 个字符');
    const hash = createHash('sha256').update(normalized).digest('hex');
    const existing = this.db.prepare('SELECT id FROM job_content_versions WHERE job_id = ? AND content_hash = ?').get(jobId, hash) as { id: string } | undefined;
    if (existing) return this.listJobContentVersions(jobId).find((item) => item.id === existing.id)!;
    const version: JobContentVersion = { id: randomUUID(), job_id: jobId, origin, content: normalized, content_hash: hash, active: activate, created_at: new Date().toISOString() };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (activate) this.db.prepare('UPDATE job_content_versions SET active = 0 WHERE job_id = ?').run(jobId);
      this.db.prepare('INSERT INTO job_content_versions(id, job_id, origin, content, content_hash, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(version.id, jobId, origin, normalized, hash, activate ? 1 : 0, version.created_at);
      this.db.exec('COMMIT');
      return version;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  commitJobContentVersion(jobId: string, scored: ScoredJob, content: string, origin: JobContentVersion['origin']): JobContentVersion {
    if (!this.getJob(jobId)) throw new Error('岗位不存在');
    const normalized = content.trim();
    if (normalized.length < 80) throw new Error('完整 JD 至少需要 80 个字符');
    const hash = createHash('sha256').update(normalized).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.upsertJobsDetailed([scored], true);
      this.db.prepare('UPDATE job_content_versions SET active = 0 WHERE job_id = ?').run(jobId);
      const existing = this.db.prepare('SELECT id FROM job_content_versions WHERE job_id = ? AND content_hash = ?')
        .get(jobId, hash) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      if (existing) {
        this.db.prepare('UPDATE job_content_versions SET active = 1 WHERE id = ?').run(id);
      } else {
        this.db.prepare('INSERT INTO job_content_versions(id, job_id, origin, content, content_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
          .run(id, jobId, origin, normalized, hash, new Date().toISOString());
      }
      this.db.exec('COMMIT');
      return this.listJobContentVersions(jobId).find((item) => item.id === id)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private rowToRun(row: Record<string, unknown>): CrawlRun {
    return {
      id: String(row.id),
      operation: row.operation as RunOperation,
      status: row.status as CrawlRun['status'],
      source: (row.source as JobSource | null) ?? null,
      keywords: safeJson(String(row.keywords_json), []),
      pages: Number(row.pages),
      minSalary: row.min_salary == null ? undefined : Number(row.min_salary),
      maxJobs: row.max_jobs == null ? undefined : Number(row.max_jobs),
      currentPage: Number(row.current_page),
      totalPages: Number(row.total_pages),
      found: Number(row.found),
      saved: Number(row.saved),
      inserted: Number(row.inserted ?? 0),
      updated: Number(row.updated ?? 0),
      reactivated: Number(row.reactivated ?? 0),
      archived: Number(row.archived ?? 0),
      deduplicated: Number(row.deduplicated ?? 0),
      message: String(row.message),
      error: row.error ? String(row.error) : undefined,
      failureCategory: row.failure_category ? String(row.failure_category) as CrawlRun['failureCategory'] : undefined,
      workerPid: row.worker_pid ? Number(row.worker_pid) : undefined,
      heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : undefined,
      startedAt: row.started_at ? String(row.started_at) : undefined,
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
      createdAt: String(row.created_at),
    };
  }

  private enrichJob(job: ScoredJob): ScoredJob {
    const companyProfile = this.getCompanyProfile(job.company_key);
    const contact = this.getJobContact(job.id);
    return {
      ...job,
      company_profile: companyProfile ?? undefined,
      contact,
    };
  }

  private backfillCompanyKeys(): void {
    const rows = this.db.prepare('SELECT id, company, company_key FROM jobs').all() as Array<{ id: string; company: string; company_key: string | null }>;
    if (!rows.length) return;
    const update = this.db.prepare('UPDATE jobs SET company_key = ? WHERE id = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const key = normalizeCompanyKey(row.company);
        if (row.company_key !== key) update.run(key, row.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private backfillScores(): void {
    const rows = this.db.prepare('SELECT * FROM jobs').all() as unknown as JobRow[];
    if (!rows.length) return;
    const update = this.db.prepare('UPDATE jobs SET score_total = ?, score_grade = ?, score_json = ? WHERE id = ?');
    const resume = readOptionalResume();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const existing = safeJson<{ score_version?: number; job_match_score?: number } | null>(row.score_json, null);
        if (existing?.score_version === 7 && typeof existing.job_match_score === 'number') continue;
        const job = rowToJob(row);
        const score = scoreWithRules(job, null, undefined, this.getCompanyProfile(job.company_key), resume);
        update.run(score.total, score.grade, JSON.stringify(score), row.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private backfillFingerprints(): void {
    const rows = this.db.prepare('SELECT * FROM jobs').all() as unknown as JobRow[];
    if (!rows.length) return;
    const update = this.db.prepare('UPDATE jobs SET content_fingerprint = ? WHERE id = ?');
    const addAlias = this.db.prepare(`
      INSERT INTO job_aliases(alias_url, canonical_job_id, created_at)
      VALUES (?, ?, ?) ON CONFLICT(alias_url) DO NOTHING
    `);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const job = rowToJob(row);
        update.run(createContentFingerprint(job), row.id);
        const url = canonicalizeJobUrl(row.url);
        if (url) addAlias.run(url, row.id, now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

let singleton: JobStore | undefined;
export function getStore(): JobStore {
  singleton ??= new JobStore();
  return singleton;
}
