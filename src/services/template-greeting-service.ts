import { randomUUID } from 'node:crypto';
import { loadCandidateProfile, loadUserSettings } from '../config.js';
import type { JobStore } from '../server/store.js';
import type { ScoredJob } from '../types.js';
import { BossGreetingSender, type GreetingSender } from './boss-greeting-sender.js';
import type { GreetingGenerator } from './greeting-service.js';

export function templateText(input: string): string {
  const text = input.trim();
  if (!text || text.length > 500) throw new Error('请填写 1–500 个字符的打招呼模板');
  return text;
}

export function bossJobUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'www.zhipin.com' && !url.port && !url.username && !url.password
      && /^\/job_detail\/[^/]+\.html$/.test(url.pathname)) return url.origin + url.pathname;
  } catch { /* Invalid source links are excluded from sending. */ }
  return undefined;
}

export class TemplateGreetingService implements GreetingGenerator {
  status() { return { resumeConfigured: false, llmConfigured: false, model: '自填模板' }; }
  async generate(_job: ScoredJob) {
    return { text: templateText(loadUserSettings().greetingTemplate ?? ''), model: '自填模板' };
  }
}

interface Preview {
  token: string;
  expiresAt: number;
  text: string;
  jobs: ScoredJob[];
}

export class TemplateGreetingBatch {
  private previews = new Map<string, Preview>();
  private active?: { id: string; cancelled: boolean };
  private completion: Promise<void> = Promise.resolve();

  constructor(private readonly store: JobStore, private readonly options: {
    sender?: GreetingSender;
    delayMs?: number;
    readTemplate?: () => string;
  } = {}) {}

  get busy() { return Boolean(this.active); }

  private eligible(job: ScoredJob): boolean {
    const url = bossJobUrl(job.url);
    const profile = loadCandidateProfile();
    const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    return job.source === 'boss' && job.lifecycle_status === 'active'
      && ['A', 'B'].includes(job.score.grade) && !job.is_headhunter
      && ['unprocessed', 'drafted'].includes(job.contact?.status ?? 'unprocessed')
      && !profile.blockedCompanies.some((name) => normalize(job.company).includes(normalize(name)))
      && !profile.blockedKeywords.some((word) => normalize(`${job.title} ${job.jd_fulltext}`).includes(normalize(word)))
      && Boolean(url && !this.store.greetingAttempted(url));
  }

  candidates(): ScoredJob[] {
    const seen = new Set<string>();
    return this.store.listJobs({ lifecycle: 'active', source: ['boss'], sort: 'priority-desc' })
      .filter((job) => this.eligible(job)).filter((job) => {
        const url = bossJobUrl(job.url)!;
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });
  }

  preview(jobIds: string[]): Preview {
    const ids = [...new Set(jobIds)];
    if (!ids.length || ids.length > 20) throw new Error('每批请选择 1–20 个岗位');
    const eligible = new Map(this.candidates().map((job) => [job.id, job]));
    const jobs = ids.map((id) => {
      const job = eligible.get(id);
      if (!job) throw new Error('选中的岗位已不满足发送条件，请刷新列表');
      return job;
    });
    const text = templateText(this.options.readTemplate?.() ?? loadUserSettings().greetingTemplate ?? '');
    for (const [token, item] of this.previews) if (item.expiresAt <= Date.now()) this.previews.delete(token);
    if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!);
    const preview = { token: randomUUID(), expiresAt: Date.now() + 10 * 60_000, text, jobs };
    this.previews.set(preview.token, preview);
    return preview;
  }

  start(token: string) {
    if (this.busy || this.store.findActiveRun()) throw new Error('已有任务正在运行，请稍后再试');
    const preview = this.previews.get(token);
    if (!preview || preview.expiresAt <= Date.now()) throw new Error('预览已失效，请重新选择并预览');
    if (preview.jobs.some((job) => {
      const current = this.store.getJob(job.id);
      return !current || !this.eligible(current) || current.url !== job.url;
    })) throw new Error('岗位状态已变更，请重新预览');
    this.previews.delete(token);
    const run = this.store.createRun({ operation: 'greeting', source: 'boss' });
    const active = { id: run.id, cancelled: false };
    this.active = active;
    this.store.updateRun(run.id, { status: 'running', workerPid: process.pid, heartbeatAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), totalPages: preview.jobs.length, message: '准备发送模板' });
    this.completion = this.execute(preview, active).finally(() => { this.active = undefined; });
    return this.store.getRun(run.id)!;
  }

  cancel(runId: string) {
    if (this.active?.id !== runId) throw new Error('该发送任务未在运行');
    this.active.cancelled = true;
    return this.store.updateRun(runId, { message: '正在停止；当前岗位核对完成后不再发送下一条' });
  }

  async waitForIdle() { await this.completion; }

  private async execute(preview: Preview, active: { id: string; cancelled: boolean }) {
    const heartbeat = setInterval(() => this.store.touchRunHeartbeat(active.id), 2_000);
    let sent = 0;
    try {
      const sender = this.options.sender ?? new BossGreetingSender();
      for (let index = 0; index < preview.jobs.length; index++) {
        if (active.cancelled) break;
        const expected = preview.jobs[index];
        const job = this.store.getJob(expected.id);
        if (!job || !this.eligible(job) || job.url !== expected.url) throw new Error('岗位状态变化，已停止本批发送');
        const url = bossJobUrl(job.url)!;
        // Commit the attempt before any browser interaction. Restarts never resend this job.
        this.store.reserveGreeting(url, job.id, active.id, preview.text);
        this.store.updateJobContact(job.id, { status: 'send_unknown', last_message: preview.text, platform: 'boss' });
        this.store.updateRun(active.id, { currentPage: index, message: `正在发送 ${index + 1}/${preview.jobs.length}：${job.title}` });
        try {
          const receipt = await sender.send(job, preview.text);
          if (!receipt.receiptConfirmed) throw new Error('未确认平台发送回执');
          this.store.finishGreeting(url, 'sent', '已确认本人消息气泡');
          this.store.updateJobContact(job.id, { status: 'greeted', greeted_at: receipt.sentAt,
            communication_source: 'template', communication_verified_at: receipt.sentAt });
          sent++;
          this.store.updateRun(active.id, { currentPage: index + 1, saved: sent, message: `已确认发送 ${sent}/${preview.jobs.length}` });
        } catch (error) {
          this.store.finishGreeting(url, 'unknown', (error as Error).message);
          throw new Error(`“${job.title}”发送未确认，已停止。请到 BOSS 查看，不会自动重发：${(error as Error).message}`, { cause: error });
        }
        if (index < preview.jobs.length - 1) {
          const deadline = Date.now() + (this.options.delayMs ?? 10_000 + Math.random() * 10_000);
          while (!active.cancelled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(200, deadline - Date.now())));
        }
      }
      this.store.updateRun(active.id, { status: active.cancelled ? 'cancelled' : 'succeeded', saved: sent,
        message: `${active.cancelled ? '已停止' : '发送完成'}，已确认 ${sent}/${preview.jobs.length} 条`, finishedAt: new Date().toISOString() });
    } catch (error) {
      this.store.updateRun(active.id, { status: sent ? 'partial' : 'failed', saved: sent,
        message: '批量发送已停止', error: (error as Error).message, finishedAt: new Date().toISOString() });
    } finally { clearInterval(heartbeat); }
  }
}
