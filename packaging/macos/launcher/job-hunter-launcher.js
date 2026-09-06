import { spawn, execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
const resourcesDir = dirname(dirname(dirname(process.execPath)));
const appDir = resolve(resourcesDir, 'app');
const packageInfo = JSON.parse(readFileSync(resolve(appDir, 'package.json'), 'utf8'));
const dataDir = process.env.APP_DATA_DIR
  ? resolve(process.env.APP_DATA_DIR)
  : resolve(homedir(), 'Library', 'Application Support', 'JobHunter', 'data');
const pidPath = resolve(dataDir, 'job-hunter.pid');
const logPath = resolve(dataDir, 'logs', 'job-hunter.log');
const port = Number(process.env.PORT || 17321);
const origin = `http://127.0.0.1:${port}`;

function isAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function health() {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.data?.version === packageInfo.version;
  } catch {
    return false;
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await health()) return true;
    await delay(250);
  }
  return false;
}

async function openApp() {
  if (process.env.JOB_HUNTER_NO_OPEN === '1') return;
  await execFileAsync('/usr/bin/open', [origin]);
}

async function main() {
  mkdirSync(resolve(dataDir, 'logs'), { recursive: true });
  if (existsSync(pidPath)) {
    const previous = Number(readFileSync(pidPath, 'utf8').trim());
    if (isAlive(previous) && await health()) {
      await openApp();
      return;
    }
  }

  if (await health()) {
    await openApp();
    return;
  }

  const logFd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [resolve(appDir, 'dist', 'index.js')], {
    cwd: appDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_DATA_DIR: dataDir,
      PORT: String(port),
    },
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(pidPath, String(child.pid), 'utf8');

  if (!(await waitForServer())) {
    if (isAlive(child.pid)) process.kill(child.pid, 'SIGTERM');
    throw new Error(`服务未能在 ${origin} 启动，请查看 ${logPath}`);
  }
  await openApp();
}

main().catch((error) => {
  mkdirSync(resolve(dataDir, 'logs'), { recursive: true });
  writeFileSync(
    resolve(dataDir, 'logs', 'launcher-error.log'),
    `${new Date().toISOString()} ${error.stack || error.message}\n`,
    { flag: 'a' },
  );
  process.exitCode = 1;
});
