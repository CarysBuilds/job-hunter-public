import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const denyName = [
  /^\.env$/,
  /\.sqlite(?:-.+)?$/,
  /\.db$/,
  /cookie/i,
  /chrome-profile/i,
  /resume\.md$/i,
  /\.log$/i,
];
const denyContent = [
  /lanqishi/i,
  /\/Users\/lanqishi/i,
  /com\.lanqishi/i,
  /湖北科技学院/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /BOSS_GREETING_SEND_ENABLED/,
  /AUTO_GREETING_/,
  /真实发送/,
  /批量打招呼/,
];
const includeBuild = process.argv.includes('--include-build') || process.env.SCAN_SENSITIVE_INCLUDE_BUILD === '1';
const alwaysSkipDirs = new Set(['.git', 'node_modules', 'data']);
const buildSkipDirs = new Set(['dist', 'staging', 'artifacts', 'release']);
const textExt = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.txt', '.example', '.iss']);

function extOf(path) {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index) : '';
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = relative(root, path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!alwaysSkipDirs.has(entry) && (includeBuild || !buildSkipDirs.has(entry))) walk(path, files);
      continue;
    }
    files.push(rel);
  }
  return files;
}

const findings = [];
for (const rel of walk(root)) {
  if (denyName.some((pattern) => pattern.test(rel))) findings.push(`${rel}: denied file name`);
  if (rel === 'scripts/scan-sensitive.mjs') continue;
  const path = resolve(root, rel);
  if (!existsSync(path) || !textExt.has(extOf(path)) && !rel.endsWith('.gitignore')) continue;
  const text = readFileSync(path, 'utf8');
  for (const pattern of denyContent) {
    if (pattern.test(text)) findings.push(`${rel}: matched ${pattern}`);
  }
}

if (findings.length) {
  console.error(findings.join('\n'));
  process.exit(1);
}

console.log('Sensitive scan passed.');
