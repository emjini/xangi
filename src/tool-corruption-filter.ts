import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Opus 4.8 の壊れたツール呼び出しXMLがテキストとして漏れる問題への防御
 *
 * 背景 (anthropics/claude-code#64658 ほか):
 *   stop_reason: tool_use のターンで、モデルが構造化 tool_use ブロックの代わりに
 *   レガシー <invoke> XML をテキストとして出力するバグがある（CJK環境で発生しやすい）。
 *   このテキストはツールとして実行されず、そのまま Discord に生タグとして漏れる。
 *
 * 防御方針:
 *   - 正常時、ツール呼び出しは tool_use ブロックになるため text に実タグが現れることはない
 *   - コードブロック(```)内はドキュメント例示の可能性があるため対象外
 *   - フィルタ処理で例外が起きた場合は原文をそのまま返す（フェイルセーフ）
 */

/** 破損の開始タグ（antml: プレフィックス有無の両方） */
const CORRUPTION_START = /<(?:antml:)?(?:invoke|function_calls|parameter)\b[^\n>]*>?/;

/** 破損領域の終了タグ（parameter の閉じはまだ invoke 内なので含めない） */
const CORRUPTION_END = /<\/(?:antml:)?(?:invoke|function_calls)>/g;

/** 高速事前チェック（通常の応答はここで即 return する） */
const QUICK_CHECK = /<\/?(?:antml:)?(?:invoke|function_calls|parameter)\b/;

/** 除去した箇所に挿入する注記 */
export const CORRUPTION_PLACEHOLDER =
  '⚠️ *(ツール呼び出しの破損出力を検出したため除去しました。応答が不完全な場合はもう一度指示してください)*';

/**
 * テキストに破損ツール呼び出しが含まれるかの軽量判定
 * （コードブロックは考慮しない。persistent-runner での検出フラグ用）
 */
export function detectToolCorruption(text: string): boolean {
  try {
    if (!QUICK_CHECK.test(text)) return false;
    // コードブロックを除いた部分にタグがあるかを確認
    return stripToolCorruption(text) !== text;
  } catch {
    return false;
  }
}

/**
 * 破損ツール呼び出しXMLの領域を除去し、注記に置き換える
 *
 * - コードブロック(```)内は変更しない
 * - 開始タグ〜対応する閉じタグ(</invoke> 等)までを1領域として除去
 * - 閉じタグが来ないまま末尾に達したら以降すべて除去（ストリーミング途中でも安全）
 * - 冪等: 累積テキストに繰り返し適用してもよい
 */
export function stripToolCorruption(text: string): string {
  try {
    if (!QUICK_CHECK.test(text)) return text;

    const lines = text.split('\n');
    const out: string[] = [];
    let inCodeBlock = false;
    let inCorruption = false;

    for (const line of lines) {
      let rest = line;

      // 破損領域内: 閉じタグを探す
      if (inCorruption) {
        const closeIdx = findLastCorruptionEnd(rest);
        if (closeIdx < 0) continue; // 閉じタグなし → 行ごと除去
        inCorruption = false;
        rest = rest.slice(closeIdx);
        if (!rest.trim()) continue; // 閉じタグの後に何もない
        // 閉じタグ後の残りテキストは通常処理へフォールスルー
      }

      if (rest.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        out.push(rest);
        continue;
      }
      if (inCodeBlock) {
        out.push(rest);
        continue;
      }

      // 破損タグを含まない通常行はそのまま保持（空行も含む）
      if (!CORRUPTION_START.test(rest)) {
        out.push(rest);
        continue;
      }

      // 破損タグを含む行: タグより前のテキストを保持し、破損領域を注記に置換
      // （同一行内の複数領域にも対応）
      let kept = '';
      let guard = 0;
      while (rest.length > 0 && guard++ < 20) {
        const m = CORRUPTION_START.exec(rest);
        if (!m) {
          kept += rest;
          break;
        }
        const before = rest.slice(0, m.index).trimEnd();
        if (before) kept += `${before} `;
        kept += CORRUPTION_PLACEHOLDER;

        const afterStart = rest.slice(m.index + m[0].length);
        const closeIdx = findLastCorruptionEnd(afterStart);
        if (closeIdx < 0) {
          // 同一行で閉じない → 破損モードに入り、行の残りは捨てる
          inCorruption = true;
          rest = '';
        } else {
          rest = afterStart.slice(closeIdx);
          if (rest.trim()) kept += ' ';
          else rest = '';
        }
      }
      if (kept.trim()) out.push(kept);
    }

    return out.join('\n');
  } catch {
    return text; // フェイルセーフ: フィルタ自身の不具合で応答を壊さない
  }
}

/** 行内の最後の破損閉じタグの終端位置を返す（なければ -1） */
function findLastCorruptionEnd(line: string): number {
  let lastEnd = -1;
  const re = new RegExp(CORRUPTION_END.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  return lastEnd;
}

/**
 * 破損検出のログを記録する（観測用: 発生頻度をデータで追う）
 * transcript-logger と同じく workdir 配下の logs/ に書く
 */
export function logToolCorruption(baseDir: string, channelId: string, detail: string): void {
  try {
    const logDir = join(baseDir, 'logs');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const logPath = join(logDir, 'tool-corruption.log');
    const timestamp = new Date().toISOString();
    appendFileSync(logPath, `${timestamp} | channel=${channelId} | ${detail}\n`);
  } catch {
    // ログ失敗は本処理に影響させない
  }
}

/**
 * 最終表示テキストを整える（上流 finalizeDisplayText 相当・コードブロック保護版）。
 *
 * 上流 `tool-call-sanitize.ts` の finalizeDisplayText は内部で stripToolCallArtifacts を
 * 呼ぶため、コードブロック内の例示タグまで消してしまう（2026-07-30 実測）。
 * ドキュメント例示が壊れるのを避けるため除去は本ファイルの stripToolCorruption を使い、
 * 「本文が空なら誤解を招く ✅ ではなく正直な fallback を返す」という上流の思想だけ取り込む。
 */
export const FRIENDLY_FALLBACK_MESSAGE =
  '（応答本文が空でした。処理は完了している可能性がありますが、内容を確認してください）';

export function finalizeDisplayTextSafe(text: string | undefined | null): string {
  const clean = stripToolCorruption(text ?? '').trim();
  return clean || FRIENDLY_FALLBACK_MESSAGE;
}
