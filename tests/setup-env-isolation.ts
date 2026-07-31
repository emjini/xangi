/**
 * テストを実行環境から隔離する。
 *
 * xangi は自分自身の実行基盤なので、開発機ではランタイムが export した環境変数
 * (AGENT_MODEL / DATA_DIR / WORKSPACE_PATH / XANGI_*) がシェルに残っている。
 * これらはプロダクションコードが設定より優先して読むため、テストが用意した
 * フィクスチャを上書きし、CI では通るテストが開発機だけ落ちる。
 *
 * 実害 (2026-08-01): even-terminal-server が model=gemma-test を期待するのに
 * AGENT_MODEL=claude-opus-5 を拾って失敗、notion-sync-cmd が DATA_DIR の混入で
 * 状態ディレクトリを取り違えて失敗。3件が落ち続けた結果 pre-commit フックが
 * 全テストを走らせる構成のため **リポジトリへ一切コミットできない状態**になり、
 * 無関係な修正を --no-verify で通す運用になっていた。
 *
 * .husky/pre-commit 側でも一部を unset しているが、そちらは `npm test` を直接
 * 叩いた場合に効かない。実行経路によらず効かせるためここで消す。
 */
const LEAKING_ENV_VARS = [
  'AGENT_MODEL',
  'AGENT_BACKEND',
  'DATA_DIR',
  'WORKSPACE_PATH',
  'GIT_INDEX_FILE',
  'GIT_DIR',
  'GIT_WORK_TREE',
];

for (const key of Object.keys(process.env)) {
  if (LEAKING_ENV_VARS.includes(key) || key.startsWith('XANGI_')) {
    delete process.env[key];
  }
}
