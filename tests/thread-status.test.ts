import { describe, expect, it } from 'vitest';
import {
  buildThreadStateName,
  detectManualThreadState,
  detectThreadState,
} from '../src/thread-status.js';

describe('detectManualThreadState', () => {
  it('detects a valid command outside a code block', () => {
    expect(detectManualThreadState('本文\n!discord   thread-status  🟡\n🟢完了')).toBe('🟡');
  });

  it('ignores commands inside code blocks and invalid emoji', () => {
    expect(detectManualThreadState('```\n!discord thread-status 🟢\n```')).toBeNull();
    expect(detectManualThreadState('!discord thread-status ✅')).toBeNull();
  });

  it('uses the latest valid manual command', () => {
    expect(
      detectManualThreadState(
        '!discord thread-status 🔵\n!discord thread-status 🟡\n!discord thread-status 🟢'
      )
    ).toBe('🟢');
  });
});

describe('detectThreadState', () => {
  it('detects a status at the start of the last non-empty line', () => {
    expect(detectThreadState('回答です\n\n  🟢完了  ')).toBe('🟢');
  });

  it('looks back through up to three ignored command lines', () => {
    expect(
      detectThreadState('回答です\n🟡要確認: 判断してください\nFILE: /tmp/a\n!discord channels')
    ).toBe('🟡');
  });

  it('does not look back farther than three non-empty lines', () => {
    expect(
      detectThreadState('🟢完了\nFILE: /tmp/a\nMEDIA: /tmp/b\nSYSTEM_COMMAND:set autoRestart=false')
    ).toBeNull();
  });

  it('does not match an emoji in the middle of prose', () => {
    expect(detectThreadState('末尾に🟢を付けます')).toBeNull();
  });

  it('stops lookback at an ordinary non-status line', () => {
    expect(detectThreadState('🟢完了\nただし問題があります')).toBeNull();
  });

  it('does not match a status inside a trailing code block', () => {
    expect(detectThreadState('例:\n```text\n🟢完了\n```')).toBeNull();
  });
});

describe('buildThreadStateName', () => {
  it('replaces an existing fixed status prefix', () => {
    expect(buildThreadStateName('🔵 進行中のスレッド', '🟡')).toBe('🟡 進行中のスレッド');
  });

  it('preserves names without a status prefix', () => {
    expect(buildThreadStateName('通常のスレッド', '🟢')).toBe('🟢 通常のスレッド');
  });

  it('clamps the result to 100 UTF-16 code units', () => {
    expect(buildThreadStateName('a'.repeat(120), '🟢')).toHaveLength(100);
  });
});
