import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'darwin') throw new Error('macOS 烟雾测试只能在 macOS 上运行');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageInfo = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const requestedDmg = process.argv[2] ? resolve(process.argv[2]) : null;
const dmgDir = resolve(root, 'artifacts', 'macos');
const dmgPath = requestedDmg || resolve(
  dmgDir,
  readdirSync(dmgDir).filter((name) => /^JobHunter-macOS-.+-v.+\.dmg$/.test(name)).sort().at(-1) || '',
);
if (!existsSync(dmgPath)) throw new Error(`未找到 macOS DMG：${dmgPath}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout.trim();
}

async function freePort() {
  return new Promise((accept, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => accept(address.port));
    });
  });
}

async function waitFor(check, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await delay(250);
  }
  return null;
}

const temp = mkdtempSync(resolve(tmpdir(), 'job-hunter-macos-smoke-'));
const mountPoint = resolve(temp, 'mount');
const dataDir = resolve(temp, 'data');
const port = await freePort();
let pid = null;
let mounted = false;

try {
  run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath]);
  mounted = true;
  const mountedAppBundle = resolve(mountPoint, 'Job Hunter.app');
  const appBundle = resolve(temp, 'Applications', 'Job Hunter.app');
  mkdirSync(dirname(appBundle), { recursive: true });
  run('/usr/bin/ditto', [mountedAppBundle, appBundle]);
  run('/usr/bin/hdiutil', ['detach', mountPoint]);
  mounted = false;
  const executable = resolve(appBundle, 'Contents', 'MacOS', 'Job Hunter');
  if (!existsSync(executable)) throw new Error('DMG 中缺少 Job Hunter.app 启动程序');

  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
  const runtimeArchs = run('/usr/bin/lipo', ['-archs', resolve(appBundle, 'Contents', 'Resources', 'runtime', 'bin', 'node')]);
  run(executable, [], {
    env: {
      ...process.env,
      APP_DATA_DIR: dataDir,
      PORT: String(port),
      JOB_HUNTER_NO_OPEN: '1',
    },
    timeout: 20_000,
  });

  const pidPath = resolve(dataDir, 'job-hunter.pid');
  const ready = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json();
    return response.ok && body?.ok && body?.data?.version === packageInfo.version
      && /^v?24\./.test(body?.data?.nodeVersion || '')
      && body?.data?.platform === 'darwin'
      && body?.data?.schemaVersion === 2 ? body : null;
  });
  if (!ready) throw new Error('安装包内应用未通过健康检查');

  pid = Number(readFileSync(pidPath, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('应用未写入有效 PID');

  const databasePath = resolve(dataDir, 'job-hunter.sqlite');
  if (!existsSync(databasePath)) throw new Error('应用未使用指定的独立用户数据目录');
  if ((statSync(dataDir).mode & 0o777) !== 0o700 || (statSync(databasePath).mode & 0o777) !== 0o600) {
    throw new Error('用户数据目录或数据库权限不安全');
  }

  const homeResponse = await fetch(`http://127.0.0.1:${port}/`);
  const html = await homeResponse.text();
  if (!homeResponse.ok || !html.includes('Job Hunter')) throw new Error('应用首页未正常返回');

  console.log(`[smoke] DMG mounted: ${basename(dmgPath)}`);
  console.log('[smoke] app copied to Applications test directory: OK');
  console.log(`[smoke] code signature: valid`);
  console.log(`[smoke] bundled runtime: ${runtimeArchs}`);
  console.log(`[smoke] health: version ${ready.data.version}, ${ready.data.jobs.total} jobs`);
  console.log(`[smoke] runtime: Node ${ready.data.nodeVersion}, schema ${ready.data.schemaVersion}`);
  console.log('[smoke] isolated user data and permissions: OK');
  console.log('[smoke] home page: OK');
  console.log('[smoke] macOS installer smoke test passed.');
} finally {
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 24);
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  if (mounted) {
    try { run('/usr/bin/hdiutil', ['detach', mountPoint]); } catch (error) {
      console.error(`[smoke] warning: ${(error).message}`);
    }
  }
  rmSync(temp, { recursive: true, force: true });
}
