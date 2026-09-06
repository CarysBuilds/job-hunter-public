import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { scoreJob } from '../src/scorer/index.js';
import { createVerifiedDatabaseBackup, restoreVerifiedDatabase, verifyDatabase } from '../src/server/database-safety.js';
import { CURRENT_SCHEMA_VERSION, JobStore } from '../src/server/store.js';

async function seededStore(path: string): Promise<{ store: JobStore; id: string }> {
  const store = new JobStore(path);
  const job = await scoreJob({
    title: '迁移保留岗位', company: '匿名公司', salary: '20-30K', location: '北京', source: 'boss',
    url: 'https://example.com/migration', jd_fulltext: '负责产品规划、需求分析、客户沟通和项目交付。'.repeat(5),
  }, { useLlm: false });
  store.upsertJobs([job]);
  return { store, id: job.id };
}

describe('数据库迁移、备份与恢复', () => {
  it('user_version=0 先产生验证备份，再迁移 schema 2 且重复启动幂等', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-hunter-migration-'));
    const path = join(directory, 'v013.sqlite');
    const seeded = await seededStore(path);
    seeded.store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA user_version = 0');
    legacy.close();

    const migrated = new JobStore(path);
    assert.equal(migrated.schemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.equal(migrated.getJob(seeded.id)?.title, '迁移保留岗位');
    const backups = readdirSync(join(directory, 'backups')).filter((name) => name.includes('pre-migration-v0'));
    assert.equal(backups.length, 1);
    assert.equal(verifyDatabase(join(directory, 'backups', backups[0])).schemaVersion, 0);
    migrated.close();
    const reopened = new JobStore(path);
    reopened.close();
    assert.equal(readdirSync(join(directory, 'backups')).filter((name) => name.includes('pre-migration-v0')).length, 1);
    if (process.platform !== 'win32') {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('拒绝打开未来 schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-hunter-future-'));
    const path = join(directory, 'future.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    db.close();
    assert.throws(() => new JobStore(path), /高于当前程序支持/);
    rmSync(directory, { recursive: true, force: true });
  });

  it('恢复要求精确确认，恢复前备份并原子替换数据库', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-hunter-restore-'));
    const path = join(directory, 'restore.sqlite');
    const seeded = await seededStore(path);
    seeded.store.close();
    const backup = createVerifiedDatabaseBackup(path, { kind: 'test' });
    const modified = new JobStore(path);
    modified.deleteJobs();
    modified.close();
    assert.throws(() => restoreVerifiedDatabase(path, backup.path, 'RESTORE wrong.sqlite'), /确认短语/);
    const safety = restoreVerifiedDatabase(path, backup.path, `RESTORE ${basename(path)}`);
    assert.equal(existsSync(safety.path), true);
    const restored = new JobStore(path);
    assert.equal(restored.countJobs('all'), 1);
    restored.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('危险删除 challenge', () => {
  it('校验短语、条数、有效期、活动任务和重复使用，成功前创建备份', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-hunter-delete-'));
    const path = join(directory, 'delete.sqlite');
    const seeded = await seededStore(path);
    const wrongPhrase = seeded.store.createDeleteChallenge();
    assert.throws(() => seeded.store.deleteJobsWithChallenge({ ...wrongPhrase, confirmation: 'DELETE' }), /确认短语/);

    const expiredAt = new Date('2026-01-01T00:00:00.000Z');
    const expired = seeded.store.createDeleteChallenge(expiredAt);
    assert.throws(() => seeded.store.deleteJobsWithChallenge(expired, new Date('2026-01-01T00:06:00.000Z')), /已过期/);

    const changed = seeded.store.createDeleteChallenge();
    const extra = await scoreJob({
      title: '新增岗位', company: '匿名二号', salary: '15-20K', location: '北京', source: 'boss',
      url: 'https://example.com/extra', jd_fulltext: '负责客户运营和项目交付。'.repeat(6),
    }, { useLlm: false });
    seeded.store.upsertJobs([extra]);
    assert.throws(() => seeded.store.deleteJobsWithChallenge(changed), /数量已变化/);

    const active = seeded.store.createRun({ operation: 'crawl', source: 'boss', keywords: ['AI'], pages: 1 });
    seeded.store.updateRun(active.id, { status: 'running', workerPid: process.pid, heartbeatAt: new Date().toISOString() });
    const activeChallenge = seeded.store.createDeleteChallenge();
    assert.throws(() => seeded.store.deleteJobsWithChallenge(activeChallenge), /活动任务/);
    seeded.store.updateRun(active.id, { status: 'failed', finishedAt: new Date().toISOString() });

    const valid = seeded.store.createDeleteChallenge();
    const result = seeded.store.deleteJobsWithChallenge(valid);
    assert.equal(result.deleted, 2);
    assert.equal(existsSync(result.backupPath), true);
    assert.throws(() => seeded.store.deleteJobsWithChallenge(valid), /已使用/);
    seeded.store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('备份失败时不删除任何岗位', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-hunter-delete-backup-fail-'));
    const path = join(directory, 'delete.sqlite');
    const seeded = await seededStore(path);
    writeFileSync(join(directory, 'backups'), '阻止创建备份目录');
    const challenge = seeded.store.createDeleteChallenge();
    assert.throws(() => seeded.store.deleteJobsWithChallenge(challenge), /验证备份失败/);
    assert.equal(seeded.store.countJobs('all'), 1);
    seeded.store.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
