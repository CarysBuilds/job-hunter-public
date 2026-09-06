import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function enablePrivateFileCreation(): void {
  if (process.platform !== 'win32') process.umask(0o077);
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform === 'win32') return;
  try { chmodSync(path, PRIVATE_DIRECTORY_MODE); } catch {}
}

export function ensurePrivateFile(path: string): void {
  if (!existsSync(path) || !statSync(path).isFile() || process.platform === 'win32') return;
  try { chmodSync(path, PRIVATE_FILE_MODE); } catch {}
}

export function writePrivateTextFile(path: string, data: string): void {
  writeFileSync(path, data, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  ensurePrivateFile(path);
}
