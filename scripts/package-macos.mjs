import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('macOS 安装包只能在 macOS 上构建');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error(`macOS 打包必须使用 Node 24.x，当前为 ${process.version}`);
const packageInfo = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const stage = resolve(root, 'staging', 'macos');
const appBundle = resolve(stage, 'Job Hunter.app');
const contents = resolve(appBundle, 'Contents');
const resources = resolve(contents, 'Resources');
const appStage = resolve(resources, 'app');
const runtimeBin = resolve(resources, 'runtime', 'bin');
const launcherStage = resolve(resources, 'launcher');
const artifacts = resolve(root, 'artifacts', 'macos');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('请通过 npm run package:macos 启动打包，以固定 npm 的 Node 24 运行时');
  run(process.execPath, [npmCli, ...args], options);
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `${command} ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function fetchWithRetry(url, timeoutMs = 180_000) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) console.warn(`[package] 下载失败，准备第 ${attempt + 1} 次尝试：${url}`);
    }
  }
  throw new Error(`下载 ${url} 失败：${lastError?.message || '未知错误'}`);
}

async function download(url, destination) {
  const response = await fetchWithRetry(url);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

runNpm(['run', 'build'], { cwd: root });
rmSync(stage, { recursive: true, force: true });
mkdirSync(appStage, { recursive: true });
mkdirSync(runtimeBin, { recursive: true });
mkdirSync(launcherStage, { recursive: true });
mkdirSync(resolve(contents, 'MacOS'), { recursive: true });
mkdirSync(artifacts, { recursive: true });

for (const name of ['dist', 'public', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'LICENSE']) {
  cpSync(resolve(root, name), resolve(appStage, name), { recursive: true });
}
cpSync(resolve(root, 'docs'), resolve(appStage, 'docs'), { recursive: true });
cpSync(resolve(root, 'packaging', 'macos', 'launcher'), launcherStage, { recursive: true });
runNpm(['ci', '--ignore-scripts', '--omit=dev'], { cwd: appStage });

const bundledNode = resolve(runtimeBin, 'node');
const expectedNodeVersion = process.version;
const nodeVersion = process.version.replace(/^v/, '');
const downloadDir = resolve(stage, 'node-downloads');
const baseUrl = `https://nodejs.org/dist/v${nodeVersion}`;
const requestedRuntime = process.env.JOB_HUNTER_RUNTIME_ARCHS || 'universal';
const nodeArchs = requestedRuntime === 'universal'
  ? ['arm64', 'x64']
  : [process.arch === 'arm64' ? 'arm64' : 'x64'];
mkdirSync(downloadDir, { recursive: true });
const sumsResponse = await fetchWithRetry(`${baseUrl}/SHASUMS256.txt`, 30_000);
const sums = await sumsResponse.text();
const nodeSlices = [];
for (const nodeArch of nodeArchs) {
  const archiveName = `node-v${nodeVersion}-darwin-${nodeArch}.tar.gz`;
  const archivePath = resolve(downloadDir, archiveName);
  console.log(`[package] downloading official Node runtime: ${archiveName}`);
  await download(`${baseUrl}/${archiveName}`, archivePath);
  const expected = sums
    .split('\n')
    .find((line) => line.trim().endsWith(`  ${archiveName}`))
    ?.trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  if (!expected || actual !== expected) throw new Error(`${archiveName} 的 SHA-256 校验失败`);
  run('/usr/bin/tar', ['-xzf', archivePath, '-C', downloadDir]);
  const nodeSlice = resolve(downloadDir, `node-v${nodeVersion}-darwin-${nodeArch}`, 'bin', 'node');
  if (output(nodeSlice, ['--version']) !== expectedNodeVersion) throw new Error(`${nodeArch} Node 运行时版本不一致`);
  nodeSlices.push(nodeSlice);
}
if (nodeSlices.length === 1) cpSync(nodeSlices[0], bundledNode);
else run('/usr/bin/lipo', ['-create', ...nodeSlices, '-output', bundledNode]);
chmodSync(bundledNode, 0o755);
if (output(bundledNode, ['--version']) !== expectedNodeVersion) throw new Error('Node 运行时版本校验失败');
const runtimeArchs = output('/usr/bin/lipo', ['-archs', bundledNode]).split(/\s+/).sort();
const compileArchs = runtimeArchs.flatMap((arch) => ['-arch', arch]);
const executable = resolve(contents, 'MacOS', 'Job Hunter');
run('/usr/bin/clang', [
  ...compileArchs,
  '-Wall',
  '-Wextra',
  '-O2',
  resolve(root, 'packaging', 'macos', 'job-hunter-launcher.c'),
  '-o', executable,
]);

const infoTemplate = readFileSync(resolve(root, 'packaging', 'macos', 'Info.plist'), 'utf8');
writeFileSync(resolve(contents, 'Info.plist'), infoTemplate.replaceAll('__VERSION__', packageInfo.version));
writeFileSync(resolve(contents, 'PkgInfo'), 'APPL????');

const signIdentity = process.env.MACOS_SIGN_IDENTITY || '-';
const signArgs = signIdentity === '-'
  ? ['--force', '--sign', '-']
  : ['--force', '--timestamp', '--options', 'runtime', '--sign', signIdentity];
run('/usr/bin/codesign', [...signArgs, bundledNode]);
run('/usr/bin/codesign', [...signArgs, executable]);
run('/usr/bin/codesign', [...signArgs, '--deep', appBundle]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);

const archLabel = runtimeArchs.includes('arm64') && runtimeArchs.includes('x86_64')
  ? 'Universal'
  : runtimeArchs.includes('arm64') ? 'Apple-Silicon' : 'Intel';
const dmgName = `JobHunter-macOS-${archLabel}-v${packageInfo.version}.dmg`;
const dmgPath = resolve(artifacts, dmgName);
const dmgRoot = resolve(stage, 'dmg-root');
rmSync(dmgRoot, { recursive: true, force: true });
mkdirSync(dmgRoot, { recursive: true });
const dmgAppBundle = resolve(dmgRoot, 'Job Hunter.app');
run('/usr/bin/ditto', [appBundle, dmgAppBundle]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', dmgAppBundle]);
symlinkSync('/Applications', resolve(dmgRoot, 'Applications'));
writeFileSync(
  resolve(dmgRoot, 'Mac安装说明.txt'),
  'Job Hunter for macOS\n\n1. 将“Job Hunter”拖入 Applications。\n2. 从“应用程序”打开 Job Hunter。\n3. 首次打开若提示无法验证开发者，请在 Finder 中右键应用并选择“打开”。\n\n用户数据保存在：~/Library/Application Support/JobHunter/data\n',
);

rmSync(dmgPath, { force: true });
run('/usr/bin/hdiutil', [
  'create',
  '-volname', `Job Hunter ${packageInfo.version}`,
  '-srcfolder', dmgRoot,
  '-ov',
  '-format', 'UDZO',
  dmgPath,
]);

const dmgSha256 = createHash('sha256').update(readFileSync(dmgPath)).digest('hex');
writeFileSync(`${dmgPath}.sha256`, `${dmgSha256}  ${dmgName}\n`);

console.log(`[package] macOS app: ${appBundle}`);
console.log(`[package] runtime architectures: ${runtimeArchs.join(', ')}`);
console.log(`[package] macOS installer: ${dmgPath}`);
console.log(`[package] SHA-256: ${dmgSha256}`);
