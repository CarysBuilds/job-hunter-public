import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const errors = [];
const requiredIgnores = ['data/**', '!data/.gitkeep', 'data/profile/', 'data/auth/', 'data/diagnostics/', '.env', '.env.local'];
const forbiddenLifecycleScripts = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'prepack']);

function walk(directory, output = []) {
  for (const name of readdirSync(directory)) {
    if (['node_modules', '.git', 'data', 'dist', 'staging', 'artifacts'].includes(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, output);
    else if (name === 'package.json') output.push(path);
  }
  return output;
}

const ignores = new Set(readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim()));
for (const rule of requiredIgnores) if (!ignores.has(rule)) errors.push(`.gitignore 缺少个人数据保护规则：${rule}`);
for (const manifestPath of walk(root)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const lifecycle = Object.keys(scripts).filter((name) => forbiddenLifecycleScripts.has(name));
  if (lifecycle.length) errors.push(`${relative(root, manifestPath)} 含依赖生命周期脚本：${lifecycle.join(', ')}`);
  if ('trustedDependencies' in manifest) errors.push(`${relative(root, manifestPath)} 禁止 trustedDependencies`);
}
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (metadata?.hasInstallScript && !metadata.dev) errors.push(`生产依赖含生命周期脚本：${packagePath}`);
}
for (const workflowName of readdirSync(join(root, '.github', 'workflows'))) {
  const workflow = readFileSync(join(root, '.github', 'workflows', workflowName), 'utf8');
  for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    if (!/@[a-f0-9]{40}$/.test(match[1])) errors.push(`${workflowName} 中 Action 未固定到 40 位提交：${match[1]}`);
  }
  if (/\brun:\s*npm ci\s*(?:\r?\n|$)/.test(workflow)) errors.push(`${workflowName} 的 npm ci 缺少 --ignore-scripts`);
}
if (errors.length) {
  console.error(`security-guards: ${errors.length} 项失败`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else console.log('security-guards: OK');
