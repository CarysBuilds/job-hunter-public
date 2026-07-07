import { createJobId } from '../job-id.js';
import { normalizeCompanyKey } from '../services/company-profile-service.js';
import type { CompanyProfile, RawJob, ScoredJob } from '../types.js';
import { analyzeWithLlm } from './llm.js';
import { scoreWithRules } from './rules.js';

export async function scoreJob(
  job: RawJob,
  options: { useLlm?: boolean; companyProfile?: CompanyProfile | null } = {}
): Promise<ScoredJob> {
  const semantic = options.useLlm === false ? null : await analyzeWithLlm(job);
  const now = new Date().toISOString();
  const companyKey = normalizeCompanyKey(job.company);
  return {
    ...job,
    id: createJobId(job),
    company_key: companyKey,
    score: scoreWithRules(job, semantic, undefined, options.companyProfile ?? null),
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
  const results: ScoredJob[] = new Array(jobs.length);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 5));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor++;
      try {
        const companyProfile = options.companyProfiles?.get(normalizeCompanyKey(jobs[index].company)) ?? null;
        results[index] = await scoreJob(jobs[index], { ...options, companyProfile });
      } catch (error) {
        console.error(`[scorer] ${jobs[index].title} 评分失败：${(error as Error).message}`);
      }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}
