import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') throw new Error('Windows 安装包烟测只能在 Windows 上运行');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageInfo = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const installer = resolve(root, 'artifacts', 'windows', 'JobHunter-Setup-x64.exe');
if (!existsSync(installer)) throw new Error(`未找到 Windows 安装包：${installer}`);

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('无法分配烟测端口'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(port) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`服务未能在 30 秒内启动：${lastError?.message || '健康检查失败'}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(10_000).then(() => { throw new Error('Windows 服务未能在 10 秒内退出'); }),
  ]);
}

const smokeRoot = mkdtempSync(resolve(tmpdir(), 'job-hunter-windows-smoke-'));
const installDir = resolve(smokeRoot, 'install');
const dataDir = resolve(smokeRoot, 'data');
let child;

try {
  const installation = spawnSync(installer, [
    '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOICONS', `/DIR=${installDir}`,
  ], { stdio: 'inherit' });
  if (installation.status !== 0) throw new Error(`Windows 安装失败，退出码 ${installation.status}`);

  const nodeExe = resolve(installDir, 'runtime', 'node', 'node.exe');
  const serverEntry = resolve(installDir, 'app', 'dist', 'index.js');
  const uninstaller = resolve(installDir, 'unins000.exe');
  for (const path of [nodeExe, serverEntry, uninstaller]) {
    if (!existsSync(path)) throw new Error(`安装结果缺少文件：${path}`);
  }

  const runtimeVersion = spawnSync(nodeExe, ['--version'], { encoding: 'utf8' });
  if (runtimeVersion.status !== 0 || runtimeVersion.stdout.trim() !== process.version) {
    throw new Error(`安装包 Node 版本不一致：${runtimeVersion.stdout.trim() || runtimeVersion.stderr.trim()}`);
  }

  const port = await freePort();
  child = spawn(nodeExe, [serverEntry], {
    cwd: resolve(installDir, 'app'),
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production', APP_DATA_DIR: dataDir, PORT: String(port) },
  });
  const health = await waitForHealth(port);
  if (health.version !== packageInfo.version) throw new Error(`版本健康检查失败：${health.version}`);
  if (health.nodeVersion !== process.version) throw new Error(`Node 健康检查失败：${health.nodeVersion}`);
  if (health.platform !== 'win32') throw new Error(`平台健康检查失败：${health.platform}`);
  if (health.schemaVersion !== 2) throw new Error(`schema 健康检查失败：${health.schemaVersion}`);

  const home = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
  if (!home.ok || !(await home.text()).includes('Job Hunter')) throw new Error('Windows 首页烟测失败');
  await stopChild(child);
  child = undefined;

  const afterExit = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(500),
  }).then(() => false, () => true);
  if (!afterExit) throw new Error('Windows 服务退出后端口仍被占用');

  const uninstall = spawnSync(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'inherit' });
  if (uninstall.status !== 0) throw new Error(`Windows 卸载清理失败，退出码 ${uninstall.status}`);
  console.log(`[smoke] Windows installer: version ${health.version}, Node ${health.nodeVersion}, schema ${health.schemaVersion}`);
  console.log('[smoke] silent install, isolated data, home page, shutdown and uninstall: OK');
} finally {
  if (child) await stopChild(child).catch(() => undefined);
  rmSync(smokeRoot, { recursive: true, force: true });
}
