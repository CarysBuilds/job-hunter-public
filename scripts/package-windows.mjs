import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error(`Windows 打包必须使用 Node 24.x，当前为 ${process.version}`);
const stage = resolve(root, 'staging', 'windows');
const appStage = resolve(stage, 'app');
const runtimeStage = resolve(stage, 'runtime', 'node');
const launcherStage = resolve(stage, 'launcher');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('请通过 npm run package:windows 启动打包，以固定 npm 的 Node 24 运行时');
  run(process.execPath, [npmCli, ...args], options);
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(result.stderr || `${command} ${args.join(' ')} failed`);
  return result.stdout.trim();
}

runNpm(['run', 'build'], { cwd: root });
rmSync(stage, { recursive: true, force: true });
mkdirSync(appStage, { recursive: true });
mkdirSync(runtimeStage, { recursive: true });
mkdirSync(launcherStage, { recursive: true });

for (const name of ['dist', 'public', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'LICENSE']) {
  cpSync(resolve(root, name), resolve(appStage, name), { recursive: true });
}
cpSync(resolve(root, 'docs'), resolve(appStage, 'docs'), { recursive: true });
cpSync(resolve(root, 'packaging', 'windows', 'launcher'), launcherStage, { recursive: true });

runNpm(['ci', '--ignore-scripts', '--omit=dev'], { cwd: appStage });

if (!existsSync(resolve(runtimeStage, 'node.exe'))) {
  if (process.platform !== 'win32') {
    writeFileSync(resolve(runtimeStage, 'README.txt'), 'node.exe is added by the Windows release workflow.\n');
  } else {
    const version = process.version.replace(/^v/, '');
    const zip = resolve(stage, `node-v${version}-win-x64.zip`);
    run('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Invoke-WebRequest -Uri https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip -OutFile ${JSON.stringify(zip)}; Expand-Archive -Force ${JSON.stringify(zip)} ${JSON.stringify(resolve(stage, 'node-runtime'))}`,
    ]);
    const extracted = resolve(stage, 'node-runtime', `node-v${version}-win-x64`);
    cpSync(extracted, runtimeStage, { recursive: true });
    const bundledVersion = output(resolve(runtimeStage, 'node.exe'), ['--version']);
    if (bundledVersion !== process.version) throw new Error(`Windows Node 运行时版本不一致：${bundledVersion}`);
  }
}

writeFileSync(resolve(stage, 'README.txt'), 'Job Hunter Windows installer staging directory.\n');
console.log(`[package] Windows staging ready: ${stage}`);
