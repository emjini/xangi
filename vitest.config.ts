import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 実行環境（xangi ランタイムが export した AGENT_MODEL / DATA_DIR 等）が
    // テストのフィクスチャを上書きするのを防ぐ。詳細は setup ファイル冒頭。
    setupFiles: ['tests/setup-env-isolation.ts'],
  },
});
