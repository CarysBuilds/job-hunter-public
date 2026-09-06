import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ensurePrivateDirectory, ensurePrivateFile } from '../file-security.js';

export interface DatabaseBackup {
  path: string;
  sha256: string;
  schemaVersion: number;
  createdAt: string;
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Number(Object.values(row)[0] ?? 0);
}

export function verifyDatabase(path: string): { schemaVersion: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    if (integrity.length !== 1 || String(Object.values(integrity[0])[0]) !== 'ok') throw new Error('SQLite integrity_check 未通过');
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw new Error(`SQLite 存在 ${foreignKeys.length} 个外键异常`);
    return { schemaVersion: pragmaNumber(db, 'user_version') };
  } finally { db.close(); }
}

export function createVerifiedDatabaseBackup(databasePath: string, options: { kind?: string; outputPath?: string } = {}): DatabaseBackup {
  if (!existsSync(databasePath)) throw new Error(`数据库不存在：${databasePath}`);
  const backupDir = resolve(dirname(databasePath), 'backups');
  ensurePrivateDirectory(backupDir);
  const outputPath = options.outputPath ?? resolve(backupDir, `${basename(databasePath)}.${options.kind ?? 'manual'}.${stamp()}.sqlite`);
  if (existsSync(outputPath)) throw new Error(`备份目标已存在：${outputPath}`);
  const db = new DatabaseSync(databasePath);
  try { db.exec(`VACUUM INTO '${outputPath.replaceAll("'", "''")}'`); } finally { db.close(); }
  ensurePrivateFile(outputPath);
  const verified = verifyDatabase(outputPath);
  return { path: outputPath, sha256: sha256(outputPath), schemaVersion: verified.schemaVersion, createdAt: new Date().toISOString() };
}

export function databaseHolders(databasePath: string): string {
  if (process.platform === 'win32') return '';
  const targets = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter(existsSync);
  if (!targets.length) return '';
  try { return execFileSync('/usr/sbin/lsof', ['-nP', ...targets], { encoding: 'utf8' }).trim(); } catch (error) {
    const stdout = (error as { stdout?: string }).stdout?.trim();
    return stdout ?? '';
  }
}

export function restoreVerifiedDatabase(databasePath: string, backupPath: string, confirmation: string): DatabaseBackup {
  const expected = `RESTORE ${basename(databasePath)}`;
  if (confirmation !== expected) throw new Error(`恢复确认短语必须为：${expected}`);
  verifyDatabase(backupPath);
  const holders = databaseHolders(databasePath);
  if (holders) throw new Error(`数据库仍被进程占用，拒绝恢复：\n${holders}`);
  const safety = createVerifiedDatabaseBackup(databasePath, { kind: 'pre-restore' });
  const temporary = `${databasePath}.restore-${process.pid}`;
  copyFileSync(backupPath, temporary);
  ensurePrivateFile(temporary);
  verifyDatabase(temporary);
  for (const suffix of ['-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
  renameSync(temporary, databasePath);
  ensurePrivateFile(databasePath);
  return safety;
}

export function ensureWritableFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o600);
  closeSync(fd);
  ensurePrivateFile(path);
}
