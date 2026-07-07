import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = resolve(root, 'staging', 'windows');
const appStage = resolve(stage, 'app');
const runtimeStage = resolve(stage, 'runtime', 'node');
const launcherStage = resolve(stage, 'launcher');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(appStage, { recursive: true });
mkdirSync(runtimeStage, { recursive: true });
mkdirSync(launcherStage, { recursive: true });

for (const name of ['dist', 'public', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'LICENSE']) {
  cpSync(resolve(root, name), resolve(appStage, name), { recursive: true });
}
cpSync(resolve(root, 'docs'), resolve(appStage, 'docs'), { recursive: true });
cpSync(resolve(root, 'packaging', 'windows', 'launcher'), launcherStage, { recursive: true });

run('npm', ['ci', '--omit=dev'], { cwd: appStage });

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
  }
}

writeFileSync(resolve(stage, 'README.txt'), 'Job Hunter Windows installer staging directory.\n');
console.log(`[package] Windows staging ready: ${stage}`);
