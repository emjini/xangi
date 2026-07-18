import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
} from 'fs';
import { join } from 'path';

/**
 * park（一時保存）: ユーザーが作業中に思いついた追加メモを、エージェントを起動せずに
 * チャンネル単位のファイルへ溜める仕組み。現在のターンが終わったあと、別ターンで拾い上げる。
 * 「作業中に投げたメッセージが busy チャンネルで無言破棄される」問題への対処。
 */

function parkDir(dataDir: string): string {
  return join(dataDir, 'parked');
}

function parkFilePath(dataDir: string, channelId: string): string {
  return join(parkDir(dataDir), `${channelId}.md`);
}

/** parkメモを1件追記する（ディレクトリ／ファイルが無ければ作る） */
export function addParkedItem(
  dataDir: string,
  channelId: string,
  text: string,
  timestamp: string
): void {
  const dir = parkDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const line = `- [${timestamp}] ${text.replace(/\s*\n\s*/g, ' ').trim()}\n`;
  appendFileSync(parkFilePath(dataDir, channelId), line, 'utf-8');
}

export interface ParkTake {
  content: string;
  tmpPath: string;
  channelId: string;
}

/**
 * 溜まったparkメモを取り出す。処理中に新しく積まれた park を失わないよう、rename で
 * 現行ファイルを切り離してから読む（rename後の追記は新しいファイルになるので拾い残さない）。
 * 取り出しに成功したら、必ず commitTake（成功時）か restoreTake（失敗時）を呼ぶこと。
 */
export function takeParkedItems(dataDir: string, channelId: string): ParkTake | null {
  const fp = parkFilePath(dataDir, channelId);
  if (!existsSync(fp)) return null;
  const tmpPath = `${fp}.taking`;
  try {
    renameSync(fp, tmpPath);
  } catch {
    return null; // 別の拾い上げが先に取った
  }
  const content = readFileSync(tmpPath, 'utf-8').trim();
  if (!content) {
    rmSync(tmpPath, { force: true });
    return null;
  }
  return { content, tmpPath, channelId };
}

/** park拾いが成功した：取り出し済みファイルを破棄 */
export function commitTake(take: ParkTake): void {
  rmSync(take.tmpPath, { force: true });
}

/** park拾いが失敗した：取り出した内容を（新しく積まれたものより前に）戻し、次ターンで再試行させる */
export function restoreTake(dataDir: string, take: ParkTake): void {
  const fp = parkFilePath(dataDir, take.channelId);
  const newer = existsSync(fp) ? readFileSync(fp, 'utf-8') : '';
  const restored = readFileSync(take.tmpPath, 'utf-8').trimEnd();
  writeFileSync(fp, `${restored}\n${newer}`, 'utf-8');
  rmSync(take.tmpPath, { force: true });
}

/**
 * 起動時のリカバリ: 拾い上げ途中でプロセスが落ちて残った *.taking を元ファイルへ戻す。
 * これで再起動を跨いでも park メモを失わない。
 */
export function recoverOrphanedTakes(dataDir: string): void {
  const dir = parkDir(dataDir);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.taking')) continue;
    const tmp = join(dir, f);
    const orig = join(dir, f.replace(/\.taking$/, ''));
    try {
      const taken = readFileSync(tmp, 'utf-8').trimEnd();
      const newer = existsSync(orig) ? readFileSync(orig, 'utf-8') : '';
      writeFileSync(orig, `${taken}\n${newer}`, 'utf-8');
      rmSync(tmp, { force: true });
      console.log(`[park] Recovered orphaned park items: ${f}`);
    } catch (e) {
      console.error(`[park] Failed to recover ${f}:`, e);
    }
  }
}
