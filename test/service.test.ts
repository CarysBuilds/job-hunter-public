import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { rotateLogFile } from '../src/scripts/rotate-logs.js';
import { findActiveRunForRestartGuard, renderLaunchAgentPlist, SERVICE_LABEL } from '../src/scripts/service.js';
import { JobStore } from '../src/server/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('macOS LaunchAgent service', () => {
  it('生成含绝对路径、自动启动、直接 node、持续保活与 30 秒重启间隔的 plist', () => {
    const plist = renderLaunchAgentPlist({
      projectRoot: '/Users/test/job-hunter',
      nodePath: '/opt/homebrew/bin/node',
      plistPath: `/Users/test/Library/LaunchAgents/${SERVICE_LABEL}.plist`,
      logsDir: '/Users/test/job-hunter/data/logs',
      port: 3000,
    });
    assert.match(plist, new RegExp(`<string>${SERVICE_LABEL}</string>`));
    assert.doesNotMatch(plist, /\/bin\/zsh/);
    assert.doesNotMatch(plist, /-lc/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    assert.doesNotMatch(plist, /<key>ProcessType<\/key>/);
    assert.match(plist, /<key>PATH<\/key>/);
    assert.match(plist, /\/opt\/homebrew\/bin\/node/);
    assert.match(plist, /\/Users\/test\/job-hunter\/dist\/index\.js/);
    assert.match(plist, /server\.out\.log/);
    assert.match(plist, /server\.err\.log/);
  });

  it('日志达到阈值后轮转并最多保留三份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-hunter-logs-'));
    dirs.push(dir);
    const path = join(dir, 'server.out.log');
    writeFileSync(path, 'new-log');
    writeFileSync(`${path}.1`, 'old-1');
    writeFileSync(`${path}.2`, 'old-2');
    writeFileSync(`${path}.3`, 'old-3');
    assert.equal(rotateLogFile(path, 3, 3), true);
    assert.equal(readFileSync(`${path}.1`, 'utf8'), 'new-log');
    assert.equal(readFileSync(`${path}.2`, 'utf8'), 'old-1');
    assert.equal(readFileSync(`${path}.3`, 'utf8'), 'old-2');
  });

  it('重启前能识别正在运行的任务，避免误中断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-hunter-service-'));
    dirs.push(dir);
    const store = new JobStore(join(dir, 'service.sqlite'));
    const run = store.createRun({ operation: 'crawl', source: 'boss', keywords: ['AI'], pages: 1 });
    store.updateRun(run.id, {
      status: 'running',
      message: '正在抓取岗位',
      workerPid: process.pid,
      heartbeatAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });
    store.close();

    const active = findActiveRunForRestartGuard(join(dir, 'service.sqlite'));
    assert.equal(active?.id, run.id);
    assert.equal(active?.status, 'running');
  });
});
