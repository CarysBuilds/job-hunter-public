import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appConfig, getCrawlConfig } from './config.js';
import { getRunService } from './services/run-service.js';
import { getGreetingService, type GreetingGenerator } from './services/greeting-service.js';
import { getDetailRefresher, type DetailRefresher } from './services/detail-refresh-service.js';
import { createRouter } from './server/routes.js';
import { getStore } from './server/store.js';
import type { JobSource } from './types.js';

const SOURCES = ['boss', 'liepin', 'zhaopin'] as const;
const SOURCE_LABELS: Record<JobSource, string> = { boss: 'BOSS', liepin: '猎聘', zhaopin: '智联' };
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readSource(): JobSource {
  const source = readArg('--source') ?? 'boss';
  if (!SOURCES.includes(source as JobSource)) throw new Error('source 仅支持 boss、liepin、zhaopin');
  return source as JobSource;
}

function hostNameFromHeader(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

function isLocalOrigin(value: string | undefined): boolean {
  if (!value) return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function localAccessGuard(req: Request, res: Response, next: NextFunction): void {
  const hostName = hostNameFromHeader(req.headers.host);
  if (!LOCAL_HOSTNAMES.has(hostName)) {
    res.status(403).json({ ok: false, error: '仅允许本机访问' });
    return;
  }
  if (WRITE_METHODS.has(req.method) && !isLocalOrigin(req.headers.origin)) {
    res.status(403).json({ ok: false, error: '仅允许本机页面发起写操作' });
    return;
  }
  next();
}

function displayHost(host: string): string {
  return host === '::1' ? '[::1]' : host;
}

export function createApp(dependencies: {
  store?: ReturnType<typeof getStore>;
  runs?: ReturnType<typeof getRunService>;
  greeting?: GreetingGenerator;
  detailRefresher?: DetailRefresher;
} = {}) {
  const store = dependencies.store ?? getStore();
  const runs = dependencies.runs ?? getRunService();
  const greeting = dependencies.greeting ?? getGreetingService();
  const detailRefresher = dependencies.detailRefresher ?? getDetailRefresher();
  const app = express();
  app.disable('x-powered-by');
  app.use(localAccessGuard);
  app.use(express.json({ limit: '200kb' }));
  app.use('/api', createRouter(store, runs, greeting, detailRefresher));
  app.use(express.static(appConfig.publicDir, {
    setHeaders: (res, path) => {
      if (/\.(?:html|js|css)$/.test(path)) res.setHeader('Cache-Control', 'no-store');
    },
  }));
  app.get('*', (_req, res) => res.sendFile(`${appConfig.publicDir}/index.html`));
  return app;
}

async function crawlOnly(): Promise<void> {
  const config = getCrawlConfig();
  const source = readSource();
  console.log(`[crawl] ${SOURCE_LABELS[source]}；${config.keywords.length} 个关键词；每个 ${config.pages} 页`);
  const run = await getRunService().runCrawlNow({ source, keywords: config.keywords, pages: config.pages });
  if (run.status === 'failed') throw new Error(run.error || run.message);
  console.log(`[crawl] ${run.message}`);
}

import { rotateServiceLogs } from './scripts/rotate-logs.js';

async function main(): Promise<void> {
  const rotated = rotateServiceLogs();
  if (rotated) console.log(`[server] 日志轮转：${rotated} 个文件已归档`);
  const store = getStore();
  console.log(`[server] ${new Date().toISOString()} 启动 PID=${process.pid} PPID=${process.ppid}`);
  const migrated = store.migrateLegacyJson();
  if (migrated) console.log(`[storage] 已从 jobs.json 迁移 ${migrated} 条岗位`);
  if (process.argv.includes('--crawl-only')) return crawlOnly();
  const app = createApp();
  const server = app.listen(appConfig.port, appConfig.host, () => {
    const counts = store.lifecycleCounts();
    console.log(`[server] ${new Date().toISOString()} Job Hunter：http://${displayHost(appConfig.host)}:${appConfig.port}；当前 ${counts.active} 条，历史 ${counts.archived} 条`);
  });
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const active = store.findActiveRun();
    const activeText = active
      ? `；活动任务 ${active.operation} ${active.id} ${active.status} PID=${active.workerPid ?? 'none'}：${active.message}`
      : '；无活动任务';
    console.log(`[server] ${new Date().toISOString()} 收到 ${signal}，正在优雅关闭 PID=${process.pid}${activeText}`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[fatal] ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
