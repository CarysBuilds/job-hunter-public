import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const installDir = dirname(dirname(dirname(process.execPath)));
const appDir = resolve(installDir, 'app');
const dataDir = process.env.APPDATA
  ? resolve(process.env.APPDATA, 'JobHunter', 'data')
  : resolve(installDir, 'data');
const pidPath = resolve(dataDir, 'job-hunter.pid');
const port = Number(process.env.PORT || 3000);

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
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await health()) return true;
    await delay(250);
  }
  return false;
}

async function main() {
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(pidPath)) {
    const previous = Number(readFileSync(pidPath, 'utf8').trim());
    if (isAlive(previous) && await health()) {
      await import('node:child_process').then(({ execFile }) => execFile('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}`]));
      return;
    }
  }

  const child = spawn(process.execPath, [join(appDir, 'dist', 'index.js')], {
    cwd: appDir,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_DATA_DIR: dataDir,
      PORT: String(port),
    },
  });
  child.unref();
  writeFileSync(pidPath, String(child.pid), 'utf8');
  await waitForServer();
  await import('node:child_process').then(({ execFile }) => execFile('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}`]));
}

main().catch((error) => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(resolve(dataDir, 'launcher-error.log'), `${new Date().toISOString()} ${error.stack || error.message}\n`, { flag: 'a' });
  process.exitCode = 1;
});
