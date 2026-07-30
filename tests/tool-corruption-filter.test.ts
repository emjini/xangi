import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  stripToolCorruption,
  detectToolCorruption,
  logToolCorruption,
  CORRUPTION_PLACEHOLDER,
} from '../src/tool-corruption-filter.js';

// 注意: 破損タグをこのファイルにリテラルで書くと、AIエージェントがこのファイルを
// 読み書きする際にツール呼び出しのパースを壊す危険があるため、文字列連結で組み立てる
const LT = '<';
const openTag = (name: string, attrs = '') => `${LT}${name}${attrs}>`;
const closeTag = (name: string) => `${LT}/${name}>`;

const INVOKE_ANTML = openTag('antml:invoke', ' name="Bash"');
const INVOKE_ANTML_CLOSE = closeTag('antml:invoke');
const PARAM_ANTML = openTag('antml:parameter', ' name="command"');
const PARAM_ANTML_CLOSE = closeTag('antml:parameter');
const INVOKE_PLAIN = openTag('invoke', ' name="Bash"'); // antml: 抜け落ち版
const INVOKE_PLAIN_CLOSE = closeTag('invoke');
const PARAM_PLAIN = openTag('parameter', ' name="command"');
const PARAM_PLAIN_CLOSE = closeTag('parameter');
const FUNC_CALLS = openTag('antml:function_calls');
const FUNC_CALLS_CLOSE = closeTag('antml:function_calls');

// antml: プレフィックス付きの複数行破損（Issue #64658 の典型形）
const CORRUPT_ANTML = [
  'ここまでは正常な文章。',
  FUNC_CALLS,
  INVOKE_ANTML,
  `${PARAM_ANTML}rm -rf /tmp/secret${PARAM_ANTML_CLOSE}`,
  INVOKE_ANTML_CLOSE,
  FUNC_CALLS_CLOSE,
  'そのあとの文章。',
].join('\n');

// antml: 抜け落ち版の破損
const CORRUPT_NO_PREFIX = [
  '説明テキスト。',
  INVOKE_PLAIN,
  `${PARAM_PLAIN}cat ~/.ssh/id_rsa${PARAM_PLAIN_CLOSE}`,
  INVOKE_PLAIN_CLOSE,
].join('\n');

describe('tool-corruption-filter', () => {
  describe('stripToolCorruption', () => {
    it('通常のテキストは変更しない', () => {
      const text = 'これは普通の応答です。\n改行もあります。';
      expect(stripToolCorruption(text)).toBe(text);
    });

    it('空行・段落を含む通常テキストを保持する（空行が消えない）', () => {
      const text = '段落1。\n\n段落2。\n\n- リスト1\n- リスト2';
      expect(stripToolCorruption(text)).toBe(text);
    });

    it('コードブロック内のタグは変更しない（ドキュメント例示）', () => {
      const text = ['説明:', '```', INVOKE_ANTML, INVOKE_ANTML_CLOSE, '```', 'おわり'].join('\n');
      expect(stripToolCorruption(text)).toBe(text);
    });

    it('antml:付き破損XMLを除去して注記に置換する', () => {
      const result = stripToolCorruption(CORRUPT_ANTML);
      expect(result).toContain('ここまでは正常な文章。');
      expect(result).toContain('そのあとの文章。');
      expect(result).toContain(CORRUPTION_PLACEHOLDER);
      expect(result).not.toContain('rm -rf /tmp/secret');
      expect(result).not.toContain('invoke');
    });

    it('antml:抜け落ち版の破損XMLも除去する', () => {
      const result = stripToolCorruption(CORRUPT_NO_PREFIX);
      expect(result).toContain('説明テキスト。');
      expect(result).toContain(CORRUPTION_PLACEHOLDER);
      expect(result).not.toContain('cat ~/.ssh/id_rsa');
    });

    it('strayトークン(court)の直後のタグを除去し、直前テキストは保持する', () => {
      const text = `作業を続けます。court${INVOKE_ANTML}\n${PARAM_ANTML}whoami${PARAM_ANTML_CLOSE}\n${INVOKE_ANTML_CLOSE}`;
      const result = stripToolCorruption(text);
      expect(result).toContain('作業を続けます。court');
      expect(result).toContain(CORRUPTION_PLACEHOLDER);
      expect(result).not.toContain('whoami');
    });

    it('閉じタグが来ないまま終端したら以降すべて除去する（ストリーミング途中）', () => {
      const text = `ここまでは正常。\n${INVOKE_ANTML}\n${PARAM_ANTML}秘密のデータ`;
      const result = stripToolCorruption(text);
      expect(result).toContain('ここまでは正常。');
      expect(result).toContain(CORRUPTION_PLACEHOLDER);
      expect(result).not.toContain('秘密のデータ');
    });

    it('閉じタグの後のテキストは保持する', () => {
      const text = `${INVOKE_PLAIN}\n${PARAM_PLAIN}echo hi${PARAM_PLAIN_CLOSE}\n${INVOKE_PLAIN_CLOSE}そして続きの説明です。`;
      const result = stripToolCorruption(text);
      expect(result).toContain('そして続きの説明です。');
      expect(result).not.toContain('echo hi');
    });

    it('同一行内で完結する破損も処理する', () => {
      const text = `前置き ${INVOKE_PLAIN}${PARAM_PLAIN}whoami${PARAM_PLAIN_CLOSE}${INVOKE_PLAIN_CLOSE} 後置き`;
      const result = stripToolCorruption(text);
      expect(result).toContain('前置き');
      expect(result).toContain('後置き');
      expect(result).toContain(CORRUPTION_PLACEHOLDER);
      expect(result).not.toContain('whoami');
    });

    it('複数の破損領域をそれぞれ除去する', () => {
      const text = [
        '1つ目。',
        openTag('invoke', ' name="A"'),
        INVOKE_PLAIN_CLOSE,
        '間のテキスト。',
        openTag('invoke', ' name="B"'),
        INVOKE_PLAIN_CLOSE,
        '最後。',
      ].join('\n');
      const result = stripToolCorruption(text);
      expect(result).toContain('1つ目。');
      expect(result).toContain('間のテキスト。');
      expect(result).toContain('最後。');
      expect(result).not.toContain('name="A"');
      expect(result).not.toContain('name="B"');
    });

    it('冪等である（2回適用しても結果が変わらない）', () => {
      const once = stripToolCorruption(CORRUPT_ANTML);
      expect(stripToolCorruption(once)).toBe(once);
    });

    it('破損領域より後のコードブロックは正常に保持される', () => {
      const text = [openTag('invoke', ' name="X"'), INVOKE_PLAIN_CLOSE, '```js', 'const a = 1;', '```'].join(
        '\n'
      );
      const result = stripToolCorruption(text);
      expect(result).toContain('const a = 1;');
    });

    it('タグ形式でない言及（インラインコード等）は変更しない', () => {
      const text = 'ツール呼び出しには `antml:` プレフィックスを付けること。invoke という語も無害。';
      expect(stripToolCorruption(text)).toBe(text);
    });
  });

  describe('detectToolCorruption', () => {
    it('通常のテキストでは false', () => {
      expect(detectToolCorruption('普通の応答です。')).toBe(false);
    });

    it('コードブロック内の例示のみなら false', () => {
      const text = ['```', INVOKE_PLAIN, '```'].join('\n');
      expect(detectToolCorruption(text)).toBe(false);
    });

    it('破損XMLを含むなら true', () => {
      expect(detectToolCorruption(CORRUPT_ANTML)).toBe(true);
      expect(detectToolCorruption(CORRUPT_NO_PREFIX)).toBe(true);
    });
  });

  describe('logToolCorruption', () => {
    it('logs/tool-corruption.log に追記する', () => {
      const dir = mkdtempSync(join(tmpdir(), 'corruption-test-'));
      logToolCorruption(dir, 'channel-123', 'model=claude-opus-4-8');
      const logPath = join(dir, 'logs', 'tool-corruption.log');
      expect(existsSync(logPath)).toBe(true);
      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('channel-123');
      expect(content).toContain('model=claude-opus-4-8');
    });

    it('書き込み失敗でも例外を投げない', () => {
      expect(() => logToolCorruption('/nonexistent-root-path', 'ch', 'detail')).not.toThrow();
    });
  });
});
