import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { appConfig, PROJECT_ROOT } from '../config.js';
import { JobStore } from '../server/store.js';
import type { CrawlRun } from '../types.js';

const execFileAsync = promisify(execFile);
export const SERVICE_LABEL = 'dev.jobhunter.local';

export interface ServicePaths {
  projectRoot: string;
  nodePath: string;
  plistPath: string;
  logsDir: string;
  port: number;
}

export function getServicePaths(): ServicePaths {
  return {
    projectRoot: PROJECT_ROOT,
    nodePath: process.execPath,
    plistPath: resolve(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    logsDir: appConfig.logsDir,
    port: appConfig.port,
  };
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderLaunchAgentPlist(paths: ServicePaths): string {
  const serverScript = resolve(paths.projectRoot, 'dist', 'index.js');
  const outLog = resolve(paths.logsDir, 'server.out.log');
  const errLog = resolve(paths.logsDir, 'server.err.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(paths.nodePath)}</string>
    <string>${xml(serverScript)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.projectRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(errLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>HOME</key>
    <string>${xml(homedir())}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key>
    <string>zh_CN.UTF-8</string>
    <key>LC_ALL</key>
    <string>zh_CN.UTF-8</string>
  </dict>
</dict>
</plist>
`;
}

function launchDomain(): string {
  if (!process.getuid) throw new Error('常驻服务仅支持 macOS 用户会话');
  return `gui/${process.getuid()}`;
}

async function launchctl(args: string[], ignoreFailure = false): Promise<string> {
  try {
    const result = await execFileAsync('/bin/launchctl', args, { encoding: 'utf8' });
    return result.stdout.trim();
  } catch (error) {
    if (ignoreFailure) return '';
    const detail = (error as { stderr?: string; message: string }).stderr?.trim() || (error as Error).message;
    throw new Error(`launchctl ${args[0]} 失败：${detail}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function bootstrapWithRetry(plistPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await launchctl(['bootstrap', launchDomain(), plistPath]);
      return;
    } catch (error) {
      lastError = error;
      if (!String((error as Error).message).includes('Input/output error') || attempt === 3) break;
      await sleep(1_500 * attempt);
    }
  }
  throw lastError;
}

async function install(): Promise<void> {
  const paths = getServicePaths();
  mkdirSync(dirname(paths.plistPath), { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  await launchctl(['bootout', `${launchDomain()}/${SERVICE_LABEL}`], true);
  writeFileSync(paths.plistPath, renderLaunchAgentPlist(paths), 'utf8');
  await bootstrapWithRetry(paths.plistPath);
  await launchctl(['enable', `${launchDomain()}/${SERVICE_LABEL}`]);
  await launchctl(['kickstart', '-k', `${launchDomain()}/${SERVICE_LABEL}`]);
  console.log(`[service] 已安装并启动：http://localhost:${paths.port}`);
  console.log(`[service] plist：${paths.plistPath}`);
}

async function restart(): Promise<void> {
  const paths = getServicePaths();
  if (!existsSync(paths.plistPath)) throw new Error('服务尚未安装，请先运行 npm run service:install');
  const active = findActiveRunForRestartGuard();
  if (active && !forceRestartRequested()) {
    throw new Error(
      `当前有任务正在运行，已取消重启以避免中断：${active.operation} ${active.id}（${active.message}）。`
      + ' 如确认要强制重启，请运行 npm run service:restart -- --force'
    );
  }
  await launchctl(['kickstart', '-k', `${launchDomain()}/${SERVICE_LABEL}`]);
  console.log('[service] 已重新构建并重启');
}

function forceRestartRequested(): boolean {
  return process.argv.includes('--force') || process.env.JOB_HUNTER_FORCE_RESTART === '1';
}

export function findActiveRunForRestartGuard(databasePath = appConfig.databasePath): CrawlRun | null {
  if (!existsSync(databasePath)) return null;
  const store = new JobStore(databasePath);
  try {
    return store.findActiveRun();
  } finally {
    store.close();
  }
}

async function status(): Promise<void> {
  const paths = getServicePaths();
  const output = await launchctl(['print', `${launchDomain()}/${SERVICE_LABEL}`], true);
  console.log(output || '[service] 未加载');
  try {
    const response = await fetch(`http://127.0.0.1:${paths.port}/api/health`, { signal: AbortSignal.timeout(2_000) });
    const health = await response.json();
    console.log(`[health] ${JSON.stringify(health)}`);
  } catch {
    console.log('[health] API 暂不可访问');
  }
}

function printLog(path: string): void {
  if (!existsSync(path)) return console.log(`[logs] 尚无 ${path}`);
  const lines = readFileSync(path, 'utf8').split('\n');
  console.log(`\n[logs] ${path}\n${lines.slice(-80).join('\n')}`);
}

function logs(): void {
  const paths = getServicePaths();
  printLog(resolve(paths.logsDir, 'server.out.log'));
  printLog(resolve(paths.logsDir, 'server.err.log'));
  printLog(resolve(paths.logsDir, 'crawl-worker.out.log'));
  printLog(resolve(paths.logsDir, 'crawl-worker.err.log'));
  printLog(resolve(paths.logsDir, 'greeting-worker.out.log'));
  printLog(resolve(paths.logsDir, 'greeting-worker.err.log'));
}

async function uninstall(): Promise<void> {
  const paths = getServicePaths();
  await launchctl(['bootout', `${launchDomain()}/${SERVICE_LABEL}`], true);
  rmSync(paths.plistPath, { force: true });
  console.log('[service] 已停止并卸载；数据库和日志均已保留');
}

export async function runServiceCommand(command = process.argv[2]): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('service:* 命令当前仅支持 macOS');
  if (command === 'install') return install();
  if (command === 'restart') return restart();
  if (command === 'status') return status();
  if (command === 'logs') return logs();
  if (command === 'uninstall') return uninstall();
  throw new Error('用法：service.ts install|status|restart|logs|uninstall');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runServiceCommand().catch((error) => {
    console.error(`[service] ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
