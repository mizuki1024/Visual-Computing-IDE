/* =============================================================================
 * Phase 7C-1 — 重い試験・計測を、時間・メモリ・プロセス数の上限つきで走らせる（Linux 専用）。
 *   node scripts/run-guarded.mjs --time 1800 --pss-mb 6144 --procs 120 --min-avail-mb 2048 \
 *     --out guard.json -- <コマンド> [引数…]
 *
 * 以前 Mac がメモリ不足で停止した件（07c0 第5.3節）を受けて、計測はクラウドのコンテナで、
 * この見張りの下でだけ行う。見張るのは「コマンドの子孫すべて」（/proc の ppid で辿る。
 * IDE が別のプロセスグループで起動した開発サーバー・ブラウザも含む）。
 *   - 経過時間が --time 秒を超えた
 *   - 子孫の PSS（共有ページを按分した実使用量）の合計が --pss-mb を超えた
 *   - 子孫のプロセス数が --procs を超えた
 *   - マシンの MemAvailable が --min-avail-mb を下回った
 * のどれかで、子孫すべてに SIGTERM → 5 秒後に SIGKILL を送り、終了コード 124 で終わる。
 * 2 秒ごとの標本（PSS の内訳: ide / dev-server / browser / other）を --out に書く。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) { console.error('使い方: run-guarded.mjs [--time s] [--pss-mb n] [--procs n] [--min-avail-mb n] [--out f] -- cmd …'); process.exit(2); }
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i < sep ? argv[i + 1] : d; };
const LIMIT_S = Number(opt('--time', 1800));
const LIMIT_PSS = Number(opt('--pss-mb', 6144)) * 1024;      // kB
const LIMIT_PROCS = Number(opt('--procs', 120));
const MIN_AVAIL = Number(opt('--min-avail-mb', 2048)) * 1024; // kB
const OUT = opt('--out', null);
const cmd = argv.slice(sep + 1);

const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', detached: true });
const t0 = Date.now();
const samples = [];
let reason = null;

function procTable() {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const l = kids.get(ppid);
      if (l) l.push(Number(d)); else kids.set(ppid, [Number(d)]);
    } catch { /* 消えた */ }
  }
  return kids;
}
function tree(root) {
  const kids = procTable();
  const out = [];
  const stack = [root];
  while (stack.length) { const p = stack.pop(); out.push(p); stack.push(...(kids.get(p) ?? [])); }
  return out;
}
const pssOf = (pid) => { try { return Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0); } catch { return 0; } };
const cmdOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; } };
const classOf = (c) => (/chrom/i.test(c) ? 'browser' : /fixture-app|vcide-ext/.test(c) ? 'dev-server' : /next (start|dev)|next-server|next-router-worker/.test(c) ? 'ide' : 'other');
const avail = () => Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0);

function killAll(sig) {
  for (const p of tree(child.pid).reverse()) { try { process.kill(p, sig); } catch { /* 消えた */ } }
}

const timer = setInterval(() => {
  const pids = tree(child.pid).filter((p) => p !== child.pid || child.exitCode === null);
  const by = { ide: 0, 'dev-server': 0, browser: 0, other: 0 };
  let pss = 0;
  for (const p of pids) { const k = pssOf(p); pss += k; by[classOf(cmdOf(p))] += k; }
  const s = { t: Math.round((Date.now() - t0) / 1000), procs: pids.length, pssMB: Math.round(pss / 1024), availMB: Math.round(avail() / 1024),
    byMB: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(v / 1024)])) };
  samples.push(s);
  if (!reason) {
    if (s.t > LIMIT_S) reason = `時間の上限 ${LIMIT_S} 秒`;
    else if (pss > LIMIT_PSS) reason = `PSS の上限 ${LIMIT_PSS / 1024} MB（${s.pssMB} MB）`;
    else if (pids.length > LIMIT_PROCS) reason = `プロセス数の上限 ${LIMIT_PROCS}（${pids.length}）`;
    else if (avail() < MIN_AVAIL) reason = `空きメモリの下限 ${MIN_AVAIL / 1024} MB（${s.availMB} MB）`;
    if (reason) {
      console.error(`[guard] 上限に達したため止めます: ${reason}`);
      killAll('SIGTERM');
      setTimeout(() => killAll('SIGKILL'), 5000);
    }
  }
}, 2000);

child.on('exit', (code, signal) => {
  clearInterval(timer);
  /* 残った子孫（IDE が起動した開発サーバーなど）も止める */
  const left = tree(child.pid).filter((p) => p !== child.pid);
  for (const p of left) { try { process.kill(p, 'SIGKILL'); } catch { /* 消えた */ } }
  const max = samples.reduce((m, s) => (s.pssMB > m.pssMB ? s : m), { pssMB: 0 });
  const summary = { cmd: cmd.join(' '), seconds: Math.round((Date.now() - t0) / 1000), exit: code, signal, stoppedBy: reason,
    maxPssMB: max.pssMB, maxAt: max.t ?? null, maxProcs: Math.max(0, ...samples.map((s) => s.procs)), minAvailMB: Math.min(...samples.map((s) => s.availMB)), leftover: left.length };
  console.error(`[guard] ${JSON.stringify(summary)}`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, limits: { seconds: LIMIT_S, pssMB: LIMIT_PSS / 1024, procs: LIMIT_PROCS, minAvailMB: MIN_AVAIL / 1024 }, samples }, null, 1));
  process.exit(reason ? 124 : (code ?? 1));
});
