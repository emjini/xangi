import http from 'http';
import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * /status エンドポイント: 「今セッションが動いてるか・サブエージェント(claudeプロセス)が動いてるか」
 * を可視化する読み取り専用HTTPサーバ。processingChannels 等の“プロセス内メモリ状態”（従来ゼロ可視）を晒す。
 */

/** index.ts 側（main スコープ）から渡す、メモリ上の生状態（runners は RunnerManager.getStatus().channels） */
export interface CoreStatus {
  processingChannels: string[];
  runners: Array<{ channelId: string; idleSeconds: number; alive: boolean }>;
  activity: Array<{
    channelId: string;
    elapsedSec: number;
    request: string;
    latestText: string;
    latestAgoSec: number;
  }>;
  dataDir: string;
}

/** アイドルこの秒数を超えた runner を抱えたまま busy なら「取り残しロック」と見なす閾値 */
const STUCK_IDLE_SEC = 120;

/** DATA_DIR/parked/*.md を数えて、チャンネルごとの park 件数を返す */
function scanParked(dataDir: string): Array<{ channelId: string; count: number }> {
  const dir = join(dataDir, 'parked');
  if (!existsSync(dir)) return [];
  const out: Array<{ channelId: string; count: number }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    try {
      const count = readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => l.trim().startsWith('- ')).length;
      if (count > 0) out.push({ channelId: f.replace(/\.md$/, ''), count });
    } catch {
      /* 読めない file はスキップ */
    }
  }
  return out;
}

/** /proc を走査して稼働中の headless claude プロセス（セッション本体＋別プロセス化したサブエージェント）を拾う */
function scanClaudeProcesses(): Array<{ pid: number; session: string; etimeSec: number }> {
  const out: Array<{ pid: number; session: string; etimeSec: number }> = [];
  let pids: string[];
  try {
    pids = readdirSync('/proc').filter((f) => /^\d+$/.test(f));
  } catch {
    return out; // /proc が無い環境（非Linux）ではスキップ
  }
  let sysUptime = 0;
  try {
    sysUptime = Number(readFileSync('/proc/uptime', 'utf-8').split(' ')[0]);
  } catch {
    /* uptime 取れなければ etime は 0 のまま */
  }
  for (const pid of pids) {
    let args: string[];
    try {
      args = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0');
    } catch {
      continue; // 消えたプロセス
    }
    const exe = args[0] ?? '';
    const isClaude = exe === 'claude' || exe.endsWith('/claude');
    if (!isClaude || !args.includes('-p')) continue; // headless(-p) の claude のみ
    const rIdx = args.indexOf('--resume');
    const session = rIdx >= 0 && args[rIdx + 1] ? args[rIdx + 1].slice(0, 8) : '(new)';
    let etimeSec = 0;
    if (sysUptime > 0) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        // "pid (comm) state ..." の comm は空白/括弧を含みうるので最後の ')' 以降を使う
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const startTicks = Number(fields[19]); // starttime（clock ticks, sysconf(_SC_CLK_TCK)=100想定）
        if (Number.isFinite(startTicks))
          etimeSec = Math.max(0, Math.round(sysUptime - startTicks / 100));
      } catch {
        /* stat 読めなければ 0 */
      }
    }
    out.push({ pid: Number(pid), session, etimeSec });
  }
  return out.sort((a, b) => b.etimeSec - a.etimeSec);
}

/** ファイル末尾の bytes だけを読む（巨大 jsonl を全読みしない） */
function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** サブエージェントの jsonl 末尾から「今何をしているか」（最新の tool_use / text）を1つ拾う */
function readSubagentLatest(jsonlPath: string): { text: string; kind: string } {
  let tail: string;
  try {
    tail = readTail(jsonlPath, 32768);
  } catch {
    return { text: '(ログ読取失敗)', kind: 'unknown' };
  }
  const lines = tail.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let j: { type?: string; message?: { content?: Array<Record<string, unknown>> } };
    try {
      j = JSON.parse(lines[i]);
    } catch {
      continue; // tail 先頭の切れた行などはスキップ
    }
    if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
      const blocks = j.message.content;
      for (let k = blocks.length - 1; k >= 0; k--) {
        const b = blocks[k];
        if (b.type === 'tool_use') {
          return { text: `${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 80)})`, kind: 'tool' };
        }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          return { text: b.text.replace(/\s+/g, ' ').trim().slice(-140), kind: 'text' };
        }
      }
    }
  }
  return { text: '(最新活動を特定できず)', kind: 'unknown' };
}

interface SubagentInfo {
  agentType: string;
  task: string;
  session: string;
  ageSec: number;
  latest: string;
  latestKind: string;
}
interface SubagentScan {
  ok: boolean;
  error?: string;
  items: SubagentInfo[];
}

/**
 * Claude harness の subagents/*.meta.json + jsonl を走査して稼働中サブエージェントを拾う（Tier-2・best-effort）。
 * ⚠️ 内部フォーマット依存。読めない/スキーマが変わった場合は ok:false で「要修正」を明示（空白にしない）。
 */
function scanSubagents(activeSec = 90): SubagentScan {
  const base = join(homedir(), '.claude', 'projects');
  if (!existsSync(base)) {
    return {
      ok: false,
      error: `projects dir が見つからない: ${base}（Claude Codeの構成変更の可能性）`,
      items: [],
    };
  }
  const items: SubagentInfo[] = [];
  const now = Date.now();
  try {
    for (const proj of readdirSync(base)) {
      let sessions: string[];
      try {
        sessions = readdirSync(join(base, proj));
      } catch {
        continue;
      }
      for (const sess of sessions) {
        const subDir = join(base, proj, sess, 'subagents');
        if (!existsSync(subDir)) continue;
        let files: string[];
        try {
          files = readdirSync(subDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith('.meta.json')) continue;
          const metaPath = join(subDir, f);
          const jsonlPath = metaPath.replace(/\.meta\.json$/, '.jsonl');
          let freshest: number;
          try {
            const mm = statSync(metaPath).mtimeMs;
            let jm = mm;
            try {
              jm = statSync(jsonlPath).mtimeMs;
            } catch {
              /* jsonl 無ければ meta の mtime を使う */
            }
            freshest = Math.max(mm, jm);
          } catch {
            continue;
          }
          if (now - freshest > activeSec * 1000) continue; // 古い＝非アクティブはスキップ
          let meta: { agentType?: unknown; description?: unknown };
          try {
            meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          } catch {
            return {
              ok: false,
              error: `meta.json のparse失敗 (${f})＝フォーマット変更の可能性。要修正`,
              items,
            };
          }
          if (typeof meta.agentType !== 'string') {
            return {
              ok: false,
              error: `meta.json に agentType が無い (${f})＝スキーマ変更の可能性。要修正`,
              items,
            };
          }
          const latest = readSubagentLatest(jsonlPath);
          items.push({
            agentType: meta.agentType,
            task: typeof meta.description === 'string' ? meta.description : '',
            session: sess.slice(0, 8),
            ageSec: Math.round((now - freshest) / 1000),
            latest: latest.text,
            latestKind: latest.kind,
          });
        }
      }
    }
  } catch (e) {
    return { ok: false, error: `サブエージェント走査中に例外: ${String(e)}。要修正`, items };
  }
  return { ok: true, items: items.sort((a, b) => a.ageSec - b.ageSec) };
}

/** スナップショットを組み立てる */
function buildSnapshot(getCore: () => CoreStatus) {
  const core = getCore();
  const runnerByChannel = new Map(core.runners.map((r) => [r.channelId, r]));
  // busy（ターン実行中）なのに runner が居ない/死んでる/長時間アイドル ＝ 取り残しロックの疑い
  const stuckChannels = core.processingChannels.filter((ch) => {
    const r = runnerByChannel.get(ch);
    return !r || !r.alive || r.idleSeconds > STUCK_IDLE_SEC;
  });
  return {
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    processingChannels: core.processingChannels,
    stuckChannels,
    activity: core.activity,
    subagents: scanSubagents(),
    runners: core.runners,
    parked: scanParked(core.dataDir),
    claudeProcesses: scanClaudeProcesses(),
  };
}

/** ブラウザで即見れる自動更新ページ（Reactを組む前の暫定ビュー） */
const STATUS_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>xangi status</title>
<style>
body{background:#0f1115;color:#e6e6e6;font:14px/1.5 system-ui,sans-serif;margin:0;padding:16px}
h1{font-size:16px;margin:0 0 4px} .sub{color:#8a93a2;font-size:12px;margin-bottom:14px}
.card{background:#171a21;border:1px solid #232833;border-radius:10px;padding:12px 14px;margin-bottom:12px}
.card h2{font-size:13px;margin:0 0 8px;color:#a9b2c0;text-transform:uppercase;letter-spacing:.04em}
.row{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px solid #1e232d}
.row:last-child{border-bottom:0} .mono{font-family:ui-monospace,monospace}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px}
.on{background:#123524;color:#4ade80} .idle{background:#1e2530;color:#8a93a2} .stuck{background:#3a1620;color:#f87171}
.empty{color:#6b7280;font-style:italic}
</style></head><body>
<h1>🛰 xangi status</h1><div class="sub" id="meta">読み込み中…</div>
<div class="card"><h2>取り残しロック（要注意）</h2><div id="stuck"></div></div>
<div class="card"><h2>各チャンネルの今の作業</h2><div id="activity"></div></div>
<div class="card"><h2>処理中チャンネル（ターン実行中）</h2><div id="proc"></div></div>
<div class="card"><h2>サブエージェント（harness内部・best-effort）</h2><div id="subagents"></div></div>
<div class="card"><h2>稼働 claude プロセス（セッション/サブエージェント）</h2><div id="procs"></div></div>
<div class="card"><h2>ランナー・プール</h2><div id="runners"></div></div>
<div class="card"><h2>park 未処理</h2><div id="parked"></div></div>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function tick(){
 try{
  const s=await(await fetch('/status.json',{cache:'no-store'})).json();
  $('meta').textContent='pid '+s.pid+' · uptime '+s.uptimeSec+'s · mem '+s.memoryMB+'MB · '+new Date(s.now).toLocaleTimeString('ja-JP');
  $('stuck').innerHTML=s.stuckChannels.length?s.stuckChannels.map(c=>'<div class="row"><span class="mono">'+esc(c)+'</span><span class="pill stuck">STUCK?</span></div>').join(''):'<div class="empty">なし</div>';
  $('activity').innerHTML=(s.activity&&s.activity.length)?s.activity.map(a=>'<div class="row"><span><span class="mono">'+esc(a.channelId)+'</span><br><span style="color:#c9d1d9">'+esc(a.request||'(実行中)')+'</span>'+(a.latestText?'<br><span style="color:#8a93a2;font-size:12px">💬 '+esc(a.latestText)+(a.latestAgoSec>=0?' ('+a.latestAgoSec+'s前)':'')+'</span>':'')+'</span><span class="pill on">'+a.elapsedSec+'s</span></div>').join(''):'<div class="empty">アイドル</div>';
  $('proc').innerHTML=s.processingChannels.length?s.processingChannels.map(c=>'<div class="row"><span class="mono">'+esc(c)+'</span><span class="pill on">実行中</span></div>').join(''):'<div class="empty">アイドル</div>';
  if(s.subagents && s.subagents.ok===false){ $('subagents').innerHTML='<div class="row"><span style="color:#f87171">⚠️ 取得失敗（要修正）: '+esc(s.subagents.error||'')+'</span><span class="pill stuck">BROKEN</span></div>'; }
  else if(s.subagents && s.subagents.items.length){ $('subagents').innerHTML=s.subagents.items.map(a=>'<div class="row"><span><span class="pill on">'+esc(a.agentType)+'</span> <span style="color:#c9d1d9">'+esc(a.task||'')+'</span><br><span style="color:#8a93a2;font-size:12px">'+(a.latestKind==='tool'?'🔧 ':'💬 ')+esc(a.latest)+' · '+esc(a.session)+'</span></span><span class="pill on">'+a.ageSec+'s前</span></div>').join(''); }
  else { $('subagents').innerHTML='<div class="empty">なし（稼働中サブエージェント無し）</div>'; }
  $('procs').innerHTML=s.claudeProcesses.length?s.claudeProcesses.map(p=>'<div class="row"><span class="mono">pid '+p.pid+' · '+esc(p.session)+'</span><span class="pill on">'+p.etimeSec+'s</span></div>').join(''):'<div class="empty">なし</div>';
  $('runners').innerHTML=s.runners.length?s.runners.map(r=>'<div class="row"><span class="mono">'+esc(r.channelId)+(r.alive?'':' ☠dead')+'</span><span class="pill '+(!r.alive?'stuck':(r.idleSeconds>120?'idle':'on'))+'">idle '+r.idleSeconds+'s</span></div>').join(''):'<div class="empty">なし</div>';
  $('parked').innerHTML=s.parked.length?s.parked.map(p=>'<div class="row"><span class="mono">'+esc(p.channelId)+'</span><span class="pill idle">'+p.count+'件</span></div>').join(''):'<div class="empty">なし</div>';
 }catch(e){ $('meta').textContent='取得失敗: '+e; }
}
tick(); setInterval(tick,3000);
</script></body></html>`;

/** 読み取り専用の /status サーバを起動する */
export function startStatusServer(port: number, getCore: () => CoreStatus): http.Server {
  const server = http.createServer((req, res) => {
    try {
      const url = (req.url || '/').split('?')[0];
      if (url === '/status.json' || url === '/status') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(buildSnapshot(getCore), null, 2));
      } else if (url === '/' || url === '/status.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(STATUS_HTML);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  server.on('error', (e) => console.error('[status] server error:', (e as Error).message));
  server.listen(port, '0.0.0.0', () => console.log(`[status] status server listening on :${port}`));
  return server;
}
