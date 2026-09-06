import express from 'express';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appConfig, getCrawlConfig } from './config.js';
import { getRunService } from './services/run-service.js';
import { getGreetingService, type GreetingGenerator } from './services/greeting-service.js';
import { getDetailRefresher, type DetailRefresher } from './services/detail-refresh-service.js';
import { createRouter } from './server/routes.js';
import { getStore } from './server/store.js';
import type { JobSource } from './types.js';
import { requireLocalAccess, requireMutationMarker, setSecurityHeaders } from './server/security.js';

const SOURCES = ['boss', 'liepin', 'zhaopin'] as const;
const SOURCE_LABELS: Record<JobSource, string> = { boss: 'BOSS', liepin: '猎聘', zhaopin: '智联' };

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readSource(): JobSource {
  const source = readArg('--source') ?? 'boss';
  if (!SOURCES.includes(source as JobSource)) throw new Error('source 仅支持 boss、liepin、zhaopin');
  return source as JobSource;
}

function displayHost(host: string): string {
  return host === '::1' ? '[::1]' : host;
}

function describePortOwner(port: number): string {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `$c=Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -First 1; $p=Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; "PID=$($c.OwningProcess) Process=$($p.ProcessName) Address=$($c.LocalAddress):$($c.LocalPort)"`],
      { encoding: 'utf8' }).trim();
    }
    return execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
  } catch {
    return 'PID、进程名和监听地址暂不可用';
  }
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
  app.use(setSecurityHeaders);
  app.use(requireLocalAccess);
  app.use(requireMutationMarker);
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
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') throw error;
    const owner = describePortOwner(appConfig.port);
    console.error(`[server] 端口 ${appConfig.host}:${appConfig.port} 已被占用；不会结束其他进程。\n${owner}`);
    process.exitCode = 1;
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
