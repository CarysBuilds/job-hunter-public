import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = resolve(root, 'dist');
const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [tsc], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
