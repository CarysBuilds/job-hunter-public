import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appConfig } from '../config.js';

export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const LOG_BACKUPS = 3;

export function rotateLogFile(path: string, maxBytes = MAX_LOG_BYTES, backups = LOG_BACKUPS): boolean {
  if (!existsSync(path) || statSync(path).size < maxBytes) return false;
  mkdirSync(dirname(path), { recursive: true });
  rmSync(`${path}.${backups}`, { force: true });
  for (let index = backups - 1; index >= 1; index--) {
    const from = `${path}.${index}`;
    if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
  }
  renameSync(path, `${path}.1`);
  return true;
}

export function rotateServiceLogs(): number {
  mkdirSync(appConfig.logsDir, { recursive: true });
  return [
    'server.out.log',
    'server.err.log',
    'crawl-worker.out.log',
    'crawl-worker.err.log',
    'greeting-worker.out.log',
    'greeting-worker.err.log',
  ]
    .filter((name) => rotateLogFile(resolve(appConfig.logsDir, name)))
    .length;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) rotateServiceLogs();
