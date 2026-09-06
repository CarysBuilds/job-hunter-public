import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appConfig } from '../config.js';
import { createVerifiedDatabaseBackup, databaseHolders, restoreVerifiedDatabase, verifyDatabase } from '../server/database-safety.js';

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function runDatabaseCommand(command = process.argv[2]): void {
  if (command === 'status') {
    const verified = verifyDatabase(appConfig.databasePath);
    console.log(JSON.stringify({ database: appConfig.databasePath, ...verified, holders: databaseHolders(appConfig.databasePath) || null }, null, 2));
    return;
  }
  if (command === 'backup') {
    const output = value('--output');
    console.log(JSON.stringify(createVerifiedDatabaseBackup(appConfig.databasePath, { outputPath: output ? resolve(output) : undefined }), null, 2));
    return;
  }
  if (command === 'restore') {
    const source = value('--from');
    if (!source) throw new Error('用法：npm run db:restore -- --from <备份文件> --confirm "RESTORE job-hunter.sqlite"');
    const confirmation = value('--confirm') ?? '';
    const safety = restoreVerifiedDatabase(appConfig.databasePath, resolve(source), confirmation);
    console.log(`[db] 已恢复 ${basename(source)}；恢复前安全备份：${safety.path}`);
    return;
  }
  throw new Error('用法：database.ts status|backup|restore');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { runDatabaseCommand(); } catch (error) {
    console.error(`[db] ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
