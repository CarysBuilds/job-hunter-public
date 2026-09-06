import type { JobStore } from '../server/store.js';

function safeCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  const protectedValue = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

export function exportDataset(store: JobStore, dataset: 'jobs' | 'contacts', format: 'csv' | 'json'):
  { contentType: string; extension: string; body: string } {
  const generatedAt = new Date().toISOString();
  const jobs = store.listJobs({ lifecycle: 'all' });
  const rows = dataset === 'jobs'
    ? jobs.map((job) => ({ id: job.id, source: job.source, title: job.title, company: job.company, salary: job.salary,
      location: job.location, grade: job.score.grade, score: job.score.total, status: job.contact?.status ?? 'unprocessed',
      url: job.url, first_seen_at: job.first_seen_at, last_seen_at: job.last_seen_at }))
    : jobs.map((job) => ({ job_id: job.id, title: job.title, company: job.company, source: job.source,
      status: job.contact?.status ?? 'unprocessed', greeted_at: job.contact?.greeted_at ?? '',
      ready_to_apply_at: job.contact?.ready_to_apply_at ?? '', applied_at: job.contact?.applied_at ?? '',
      interviewing_at: job.contact?.interviewing_at ?? '', outcome: job.contact?.outcome ?? '',
      next_follow_up_at: job.contact?.next_follow_up_at ?? '', notes: job.contact?.notes ?? '' }));
  if (format === 'json') return {
    contentType: 'application/json; charset=utf-8', extension: 'json',
    body: `${JSON.stringify({ metadata: { dataset, generatedAt, schemaVersion: store.schemaVersion() }, data: rows }, null, 2)}\n`,
  };
  const headers = rows.length ? Object.keys(rows[0]) : dataset === 'jobs' ? ['id', 'title'] : ['job_id', 'status'];
  const body = [`# Job Hunter ${dataset}; generated_at=${generatedAt}; schema_version=${store.schemaVersion()}`,
    headers.map(safeCell).join(','), ...rows.map((row) => headers.map((key) => safeCell((row as Record<string, unknown>)[key])).join(','))].join('\r\n');
  return { contentType: 'text/csv; charset=utf-8', extension: 'csv', body: `\uFEFF${body}\r\n` };
}
