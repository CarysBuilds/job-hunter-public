import { createHash } from 'node:crypto';
import type { RawJob } from './types.js';

export function canonicalizeJobUrl(raw: string): string {
  if (!raw.trim()) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    const keep = new URLSearchParams();
    for (const key of ['query', 'page']) {
      const value = url.searchParams.get(key);
      if (value) keep.set(key, value);
    }
    url.search = keep.toString();
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function createJobId(job: RawJob): string {
  const canonicalUrl = canonicalizeJobUrl(job.url);
  const identity = canonicalUrl
    ? `${job.source}|${canonicalUrl}`
    : `${job.source}|${job.title.trim().toLowerCase()}|${job.company.trim().toLowerCase()}|${job.location.trim().toLowerCase()}`;
  return createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

export function normalizeFingerprintText(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

export function createContentFingerprint(job: RawJob): string {
  const url = canonicalizeJobUrl(job.url);
  const jd = normalizeFingerprintText(job.jd_fulltext);
  const fields = jd
    ? [job.source, job.company, job.title, job.location, job.salary, job.experience, job.education, jd]
    : [job.source, 'missing-jd', url || createJobId(job)];
  return createHash('sha256')
    .update(fields.map((value) => normalizeFingerprintText(value)).join('\u001f'))
    .digest('hex')
    .slice(0, 32);
}
