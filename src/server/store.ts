import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appConfig } from '../config.js';
import { canonicalizeJobUrl, createContentFingerprint, createJobId, normalizeFingerprintText } from '../job-id.js';
import { parseSalary, scoreWithRules } from '../scorer/rules.js';
import { normalizeCompanyKey } from '../services/company-profile-service.js';
import { readOptionalResume } from '../services/resume-service.js';
import type {
  CompanyProfile,
  ContactStatus,
  CrawlRun,
  Grade,
  JobContact,
  JobFilters,
  JobSource,
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
const PROTECTED_CONTACT_STATUSES: ContactStatus[] = ['drafted', 'greeted', 'applied', 'interviewing', 'follow_up'];
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
  platform: JobSource | null;
  last_message: string | null;
  next_follow_up_at: string | null;
  notes: string | null;
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
    platform: row.platform ?? undefined,
    last_message: row.last_message ?? undefined,
    next_follow_up_at: row.next_follow_up_at ?? undefined,
    notes: row.notes ?? undefined,
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
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
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
        platform TEXT,
        last_message TEXT,
        next_follow_up_at TEXT,
        notes TEXT,
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
        worker_pid INTEGER,
        heartbeat_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_created ON crawl_runs(created_at DESC);
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
    if (!runColumns.has('worker_pid')) this.db.exec('ALTER TABLE crawl_runs ADD COLUMN worker_pid INTEGER');
    if (!runColumns.has('heartbeat_at')) this.db.exec('ALTER TABLE crawl_runs ADD COLUMN heartbeat_at TEXT');
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

  upsertJobsDetailed(jobs: ScoredJob[]): UpsertStats {
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
    this.db.exec('BEGIN IMMEDIATE');
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
      this.db.exec('COMMIT');
      return stats;
    } catch (error) {
      this.db.exec('ROLLBACK');
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
    END, score_total DESC, updated_at DESC`;
    const order = filters.sort === 'score-desc'
      ? 'score_total DESC, updated_at DESC'
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
    this.db.prepare(`
      INSERT INTO job_contacts (
        job_id, status, greeted_at, platform, last_message, next_follow_up_at, notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        status = excluded.status,
        greeted_at = excluded.greeted_at,
        platform = excluded.platform,
        last_message = excluded.last_message,
        next_follow_up_at = excluded.next_follow_up_at,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).run(
      next.job_id, next.status, next.greeted_at ?? null, next.platform ?? null,
      next.last_message ?? null, next.next_follow_up_at ?? null, next.notes ?? null, next.updated_at
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

  createRun(input: { operation: RunOperation; source?: JobSource; keywords?: string[]; pages?: number }): CrawlRun {
    const createdAt = new Date().toISOString();
    const run: CrawlRun = {
      id: randomUUID(),
      operation: input.operation,
      status: 'queued',
      source: input.source ?? null,
      keywords: input.keywords ?? [],
      pages: input.pages ?? 0,
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
        id, operation, status, source, keywords_json, pages, current_page, total_pages,
        found, saved, inserted, updated, reactivated, archived, deduplicated,
        message, error, worker_pid, heartbeat_at, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.operation, run.status, run.source, JSON.stringify(run.keywords), run.pages,
      run.currentPage, run.totalPages, run.found, run.saved, run.inserted, run.updated,
      run.reactivated, run.archived, run.deduplicated, run.message, null, null, null, null, null, run.createdAt
    );
    return run;
  }

  updateRun(id: string, changes: Partial<Omit<CrawlRun, 'id' | 'createdAt'>>): CrawlRun {
    const current = this.getRun(id);
    if (!current) throw new Error(`任务不存在：${id}`);
    const next = { ...current, ...changes };
    this.db.prepare(`
      UPDATE crawl_runs SET
        operation = ?, status = ?, source = ?, keywords_json = ?, pages = ?, current_page = ?,
        total_pages = ?, found = ?, saved = ?, inserted = ?, updated = ?, reactivated = ?,
        archived = ?, deduplicated = ?, message = ?, error = ?, worker_pid = ?, heartbeat_at = ?,
        started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      next.operation, next.status, next.source, JSON.stringify(next.keywords), next.pages,
      next.currentPage, next.totalPages, next.found, next.saved, next.inserted, next.updated,
      next.reactivated, next.archived, next.deduplicated, next.message, next.error ?? null,
      next.workerPid ?? null, next.heartbeatAt ?? null, next.startedAt ?? null, next.finishedAt ?? null, id
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

  private rowToRun(row: Record<string, unknown>): CrawlRun {
    return {
      id: String(row.id),
      operation: row.operation as RunOperation,
      status: row.status as CrawlRun['status'],
      source: (row.source as JobSource | null) ?? null,
      keywords: safeJson(String(row.keywords_json), []),
      pages: Number(row.pages),
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
        if (existing?.score_version === 6 && typeof existing.job_match_score === 'number') continue;
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
