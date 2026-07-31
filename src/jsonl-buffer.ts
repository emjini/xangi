/**
 * バッファ上限（文字数）。これを超えて改行が来ない場合、
 * バッファは JSONL として壊れているとみなして捨てる。
 *
 * ⛔なぜ要るか（2026-07-31 追加）: 改行を含まない出力が流れ込むと buffer が
 * 無限に伸び、**1行も emit されない＝応答が組み立たないまま空になる**。
 * 上限を置いて捨てれば、少なくとも後続の正しい JSONL 行から復帰できる。
 *
 * 8MB 相当。Claude CLI の1メッセージは大きくても数百KB なので、
 * 正常な行をこの上限で切ることは実質ない。
 */
export const MAX_JSONL_BUFFER = 8 * 1024 * 1024;

export function appendJsonlChunk(
  buffer: string,
  chunk: string
): { lines: string[]; buffer: string; dropped?: number } {
  const parts = `${buffer}${chunk}`.split('\n');
  const lines = parts.slice(0, -1);
  let rest = parts[parts.length - 1] ?? '';

  // ⛔改行が来ないまま上限を超えたら、その残骸は捨てる（無限成長の防止）。
  // ⭐捨てた事実は呼び出し側へ返して必ずログさせる（黙って消さない）。
  let dropped: number | undefined;
  if (rest.length > MAX_JSONL_BUFFER) {
    dropped = rest.length;
    rest = '';
  }

  return dropped === undefined
    ? { lines, buffer: rest }
    : { lines, buffer: rest, dropped };
}

export function flushJsonlBuffer(buffer: string): string[] {
  return buffer.trim() ? [buffer] : [];
}
