import { createJobId } from '../job-id.js';
import { normalizeCompanyKey } from '../services/company-profile-service.js';
import type { CompanyProfile, RawJob, ScoredJob } from '../types.js';
import { analyzeWithLlm } from './llm.js';
import { scoreWithRules } from './rules.js';
import { readOptionalResume } from '../services/resume-service.js';

interface ScoreOptions {
  useLlm?: boolean;
  companyProfile?: CompanyProfile | null;
  resume?: string | null;
}

export async function scoreJob(
  job: RawJob,
  options: ScoreOptions = {}
): Promise<ScoredJob> {
  const resume = options.resume === undefined ? readOptionalResume() : options.resume;
  const semantic = options.useLlm === false ? null : await analyzeWithLlm(job, resume);
  const now = new Date().toISOString();
  const companyKey = normalizeCompanyKey(job.company);
  return {
    ...job,
    id: createJobId(job),
    company_key: companyKey,
    score: scoreWithRules(job, semantic, undefined, options.companyProfile ?? null, resume),
    crawled_at: now,
    updated_at: now,
    first_seen_at: now,
    last_seen_at: now,
    lifecycle_status: 'active',
  };
}

export async function scoreJobs(
  jobs: RawJob[],
  options: { useLlm?: boolean; concurrency?: number; companyProfiles?: Map<string, CompanyProfile> } = {}
): Promise<ScoredJob[]> {
  const resume = readOptionalResume();
  const results: ScoredJob[] = new Array(jobs.length);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 5));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor++;
      try {
        const companyProfile = options.companyProfiles?.get(normalizeCompanyKey(jobs[index].company)) ?? null;
        results[index] = await scoreJob(jobs[index], { ...options, companyProfile, resume });
      } catch (error) {
        console.error(`[scorer] ${jobs[index].title} 评分失败：${(error as Error).message}`);
      }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}
