/* =============================================================================
 * 7C HMR × 由来の安全性調査 — 診断用スクリプト（試験ではない。製品のコードは変えない）。
 *
 *   npm run build:lib    # 製品の照合（.libjs）を使うため
 *   node docs/07c-hmr-lineage-safety-results/hmr-lineage-probe.mjs [--no-server-fast-refresh] [--out <json>]
 *
 * 使い捨てのコピー（poc/out/hmr-safety-probe[-nsfr]、Git 管理外）に一時的な題材を足し、IDE と同じ計装の環境変数で
 * `next dev`（Turbopack）を起動する。手順ごとにソースを書き換え → ページを要求し、その要求で実行された SQL について
 *   正解     … SQL 文から、いまのソースのどの pool.query が実行したか（この診断がソースを読んで決める。照合器とは別の情報源）
 *   計装     … 呼び出しの入口で取ったスタック（収集ファイルの callsite 記録）の、最初の生成物のフレーム
 *   生の URL … 診断用の前置（rawstack-preload.cjs）が取った同じ呼び出しの生のスタック（`?<moduleId>` の有無）
 *   Node     … そのフレームを Node 自身が持つソースマップ（module.findSourceMap）で戻した位置（案B の実現性）
 *   製品     … 製品の resolveDataAccess（.libjs/server/dataAccess.js。PoC-02 の照合器＋A〜D の照合）の結果
 *   由来     … 製品の evaluateLineage（.libjs/lib/liveLineage.js）を、その要求の観測から作った入力で評価した結果
 * を並べ、判定する（correct / WRONG / 未特定）。
 *
 * 由来の評価の入力: 文書の同定は「その要求の応答の X-Vcide-Trace が指す受付スパン」（中継の識別子の経路は使わない）。
 * 要素の位置は題材のソースから求める（F-01 の版の照合は通った前提＝選択は正しく特定されている、とする）。
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NSFR = process.argv.includes('--no-server-fast-refresh');
const OUT_JSON = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : null; })();
const SRC_FIXTURE = path.join(REPO, 'poc', 'fixture-app');
const WORK = path.join(REPO, 'poc', 'out', NSFR ? 'hmr-safety-probe-nsfr' : 'hmr-safety-probe');
const APP = path.join(WORK, 'poc', 'fixture-app');
const RT = path.join(WORK, 'runtime');
const SPAN = path.join(RT, 'spans.jsonl');
const RAW = path.join(RT, 'rawstack.jsonl');
const ANCH = path.join(RT, 'anchors');
const PORT = NSFR ? 3478 : 3477;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.chdir(REPO); // 製品の ideRoot() は cwd から package.json を探す
const req = createRequire(path.join(REPO, 'package.json'));
const DA = req('./.libjs/server/dataAccess.js');
const AN = req('./.libjs/server/anchors.js');
const LN = req('./.libjs/server/lineage.js');
const LL = req('./.libjs/lib/liveLineage.js');
const SQLP = await import(path.join(REPO, 'poc', 'runner', 'lib', 'sqlparse.mjs'));

/* ------------------------------------------------------------ 使い捨ての題材 */
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(RT, { recursive: true });
fs.cpSync(path.join(REPO, 'poc', 'anchor'), path.join(WORK, 'poc', 'anchor'), { recursive: true });
fs.cpSync(SRC_FIXTURE, APP, {
  recursive: true,
  filter: (src) => { const r = path.relative(SRC_FIXTURE, src).split(path.sep); return r[0] !== 'node_modules' && r[0] !== '.next'; },
});
execFileSync('cp', ['-al', path.join(SRC_FIXTURE, 'node_modules'), path.join(APP, 'node_modules')]);

/* 一時的な題材（このコピーにだけ置く）。SQL 文は題材の中で一意（正解を SQL 文で決めるため） */
const FILES = {
  /* 同じコンポーネントに SQL が2つ。a と b の生成物の行の差が、生成物の中のモジュールの開始行のずれ（7）と同じになるように置く */
  'src/app/hmr-m/page.tsx': `/* HMR 調査の一時的な題材: 同じコンポーネントに SQL が2つ */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function HmrM() {
  const a = await pool.query('SELECT id, region FROM poc.listings ORDER BY id DESC LIMIT 1');
  const n1 = a.rows.length;
  const n2 = n1 + 1;
  const n3 = n2 + 1;
  const n4 = n3 + 1;
  const n5 = n4 + 1;
  const n6 = n5 + 1;
  const b = await pool.query('SELECT id, name AS region FROM poc.regions ORDER BY id LIMIT 1');
  return (
    <main className="hmr-m">
      <p data-poc-field="m-a">{a.rows[0].region}</p>
      <p data-poc-field="m-b">{b.rows[0].region}</p>
      <p data-poc-field="m-n">{String(n6)}</p>
    </main>
  );
}
`,
  /* 別ファイルの子の Server Component が自分の SQL を持つ */
  'src/app/hmr-c/page.tsx': `/* HMR 調査の一時的な題材: 子の Server Component が別ファイル */
import HmrChild from '../../components/HmrChild';
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function HmrC() {
  const p = await pool.query('SELECT id, plan FROM poc.listings ORDER BY id LIMIT 1');
  return (
    <main className="hmr-c">
      <p data-poc-field="c-plan">{p.rows[0].plan}</p>
      <HmrChild />
    </main>
  );
}
`,
  'src/components/HmrChild.tsx': `/* HMR 調査の一時的な題材: 子の Server Component */
import { pool } from '../lib/db';

export default async function HmrChild() {
  const k = await pool.query('SELECT id, code FROM poc.regions ORDER BY id LIMIT 1');
  return <p data-poc-field="c-child">{k.rows[0].code}</p>;
}
`,
  /* 別ファイルの取得関数（コンポーネントの外。帰属しないのが正解） */
  'src/app/hmr-h/page.tsx': `/* HMR 調査の一時的な題材: 取得関数が別ファイル */
import { fetchHmrRegions } from '../../lib/hmrFetch';
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function HmrH() {
  const q = await pool.query('SELECT id, scale FROM poc.listings ORDER BY id LIMIT 1');
  const h = await fetchHmrRegions();
  return (
    <main className="hmr-h">
      <p data-poc-field="h-scale">{String(q.rows[0].scale)}</p>
      <p data-poc-field="h-helper">{h.rows[0].name}</p>
    </main>
  );
}
`,
  'src/lib/hmrFetch.ts': `/* HMR 調査の一時的な題材: 取得関数 */
import { pool } from './db';

export async function fetchHmrRegions() {
  return pool.query('SELECT id, name FROM poc.regions ORDER BY id DESC LIMIT 1');
}
`,
};
for (const [rel, text] of Object.entries(FILES)) {
  fs.mkdirSync(path.dirname(path.join(APP, rel)), { recursive: true });
  fs.writeFileSync(path.join(APP, rel), text);
}
const ORIG = new Map();
const srcOf = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const put = (rel, text) => { if (!ORIG.has(rel)) ORIG.set(rel, srcOf(rel)); fs.writeFileSync(path.join(APP, rel), text); };
const restore = (rel) => { if (ORIG.has(rel)) fs.writeFileSync(path.join(APP, rel), ORIG.get(rel)); };

/* 要素（正解のための位置。ソースから） */
const ELEMENTS = [
  { path: '/hmr-m', field: 'm-a', file: 'src/app/hmr-m/page.tsx', component: 'HmrM', truthColumn: 'poc.listings.region' },
  { path: '/hmr-m', field: 'm-b', file: 'src/app/hmr-m/page.tsx', component: 'HmrM', truthColumn: 'poc.regions.name' },
  { path: '/hmr-c', field: 'c-plan', file: 'src/app/hmr-c/page.tsx', component: 'HmrC', truthColumn: 'poc.listings.plan' },
  { path: '/hmr-c', field: 'c-child', file: 'src/components/HmrChild.tsx', component: 'HmrChild', truthColumn: 'poc.regions.code' },
  { path: '/hmr-h', field: 'h-scale', file: 'src/app/hmr-h/page.tsx', component: 'HmrH', truthColumn: 'poc.listings.scale' },
  { path: '/lin-a', field: 'a-region', file: 'src/app/lin-a/page.tsx', component: 'LinA', truthColumn: 'poc.listings.region' },
];
function elementPos(el) {
  const lines = srcOf(el.file).split('\n');
  const i = lines.findIndex((l) => l.includes(`data-poc-field="${el.field}"`));
  if (i < 0) return null;
  const col = lines[i].search(/<[a-z]/) + 1;
  const tag = /<([a-z]+)/.exec(lines[i].slice(col - 1))[1];
  return { file: el.file, line: i + 1, col, tag, component: el.component };
}

/* ------------------------------------------------------------ 正解: SQL 文 → いまのソースの呼び出し位置 */
function walkSrc(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, out); else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
  }
  return out;
}
function truthOf(sqlText) {
  const head = sqlText.split('$')[0].trim();
  const hits = [];
  for (const abs of walkSrc(path.join(APP, 'src'))) {
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (l.includes(`'${head}`) || l.includes(`\`${head}`)) {
        const c = l.indexOf('query(');
        if (c >= 0) hits.push(`${path.relative(APP, abs).split(path.sep).join('/')}:${i + 1}:${c + 1}`);
      }
    });
  }
  return hits.length === 1 ? hits[0] : hits.length ? `ambiguous(${hits.join(',')})` : 'not-found';
}

/* ------------------------------------------------------------ 開発サーバー */
let child = null;
let devLog = '';
async function startDev() {
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require "${path.join(REPO, 'poc/fixture-app/ide-instrumentation/boot.cjs')}" --require "${path.join(import.meta.dirname, 'rawstack-preload.cjs')}"`,
    POC01_MODE: 'method2', POC01_RUN: 'hmr-probe', POC01_SPAN_FILE: SPAN, NEXT_OTEL_VERBOSE: '1',
    POC05_TRACE_HEADER: '1', POC05_SERVER_TIMING: '0', POC02_CALLSITE: '1', POC07_RELAY_ID: '1',
    POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCH, RAWSTACK_OUT: RAW,
  };
  const args = [path.join(APP, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(PORT), '-H', '127.0.0.1', ...(NSFR ? ['--no-server-fast-refresh'] : [])];
  child = spawn(process.execPath, args, { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', (d) => { devLog += d; });
  child.stderr.on('data', (d) => { devLog += d; });
  for (let i = 0; i < 240; i++) { const r = await get('/'); if (r.status === 200 || r.status === 404) return; await sleep(500); }
  throw new Error(`開発サーバーが起動しません\n${devLog.slice(-2000)}`);
}
async function stopDev() {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 終わっている */ }
  for (let i = 0; i < 40; i++) { try { process.kill(child.pid, 0); await sleep(250); } catch { break; } }
  child = null;
}
process.on('exit', () => { if (child) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* */ } });
function get(p) {
  return new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let len = 0; r.on('data', (d) => { len += d.length; });
      r.on('end', () => res({ status: r.statusCode, len, trace: r.headers['x-vcide-trace'] ?? null }));
    }).on('error', (e) => res({ status: String(e.code), len: 0, trace: null }));
  });
}

/* ------------------------------------------------------------ 収集ファイル */
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const SQL_TEXT = (a) => a['db.statement'] ?? a['db.query.text'] ?? null;
const pos = (p) => (p ? `${p.file}:${p.line}:${p.col}` : null);

/** 1回の要求の観測から、製品の照合と由来の評価を行う */
async function evaluateRequest(p, r, t0) {
  const recs = readJsonl(SPAN);
  const raw = readJsonl(RAW).filter((o) => o.type === 'rawstack' && o.t >= t0);
  const tp = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(r.trace ?? '');
  if (!tp) return { path: p, error: `応答に X-Vcide-Trace がありません（${r.status}）` };
  const [, traceId, rootId] = tp;
  const spans = []; const pidOf = new Map(); const callsites = new Map();
  for (const o of recs) {
    if (o.type === 'callsite') {
      const c = DA.parseCallsiteRecord(o);
      if (c && c.target === 'sql' && c.traceId === traceId) { const l = callsites.get(c.spanId) ?? []; l.push(c); callsites.set(c.spanId, l); }
      continue;
    }
    if (o.type !== 'span' || o.traceId !== traceId) continue;
    spans.push({
      traceId: o.traceId, spanId: o.spanId, parentSpanId: o.parentSpanId ?? null, name: String(o.name ?? ''), kind: Number(o.kind ?? 0),
      startMs: Number(o.startMs), endMs: Number(o.endMs), durationMs: Number(o.durationMs), statusCode: Number(o.statusCode ?? 0),
      scope: String(o.scope ?? ''), attrs: o.attrs ?? {}, droppedAttributeKeys: o.droppedAttributeKeys ?? [],
    });
    if (typeof o.proc?.pid === 'number') pidOf.set(o.spanId, o.proc.pid);
  }
  const sqlSpans = spans.filter((s) => typeof SQL_TEXT(s.attrs) === 'string').sort((a, b) => a.startMs - b.startMs);
  const manifest = AN.readManifestComponents(ANCH);
  const dataAccess = await DA.resolveDataAccess({
    projectRoot: APP, sql: sqlSpans.map((s) => ({ span: s, pid: pidOf.get(s.spanId) ?? null })),
    callsites, manifest, enabled: true,
  });
  const sqlAnalyses = sqlSpans.map((s) => SQLP.sqlAnalysisRecord({ spanId: s.spanId, sql: SQL_TEXT(s.attrs), redacted: null }));
  const usedRaw = new Set();
  const rows = sqlSpans.map((s) => {
    const sql = SQL_TEXT(s.attrs);
    const truth = truthOf(sql);
    const d = dataAccess.find((x) => x.spanId === s.spanId);
    const cs = (callsites.get(s.spanId) ?? [])[0];
    const gen = cs?.entry?.frames.find((f) => f.scope === 'build-output' || f.scope === 'bundler-virtual') ?? null;
    /* 生のスタック: 同じ SQL 文の頭・実行時刻の近いもの（診断の突き合わせだけに使う。製品の照合には使っていない） */
    const head = sql.split('$')[0].trim();
    const rr = raw.map((o, i) => ({ o, i })).filter(({ o, i }) => !usedRaw.has(i) && o.sql.startsWith(head) && Math.abs(o.t - s.startMs) < 2000)
      .sort((a, b) => Math.abs(a.o.t - s.startMs) - Math.abs(b.o.t - s.startMs))[0];
    if (rr) usedRaw.add(rr.i);
    const rf = rr?.o.frames.find((f) => f.line === gen?.line && f.col === gen?.col) ?? rr?.o.frames[0] ?? null;
    const site = d?.site ? pos(d.site) : null;
    const nodePos = rf?.node?.source ? `${rf.node.source.replace(/^<APP>\//, '')}:${rf.node.line}:${rf.node.col}` : null;
    return {
      sql: sql.slice(0, 70), truth,
      frame: gen ? `${gen.file.replace('.next/dev/server/chunks/ssr/', '…/')}:${gen.line}:${gen.col}` : null,
      fn: gen?.functionName ?? null,
      rawHasQuery: rf ? rf.hasQuery : null, moduleId: rf?.moduleId ?? null,
      node: nodePos, nodeFound: rf?.node?.found ?? null,
      product: site, failure: d?.failure?.reason ?? null, located: d?.located ? pos(d.located) : null,
      verdict: site ? (site === truth ? 'correct' : 'WRONG') : `unresolved(${d?.failure?.reason ?? '?'})`,
      nodeVerdict: nodePos ? (nodePos === truth ? 'correct' : 'WRONG') : 'none',
    };
  });

  /* 由来（製品の evaluateLineage） */
  const root = spans.find((s) => s.spanId === rootId) ?? null;
  const ex = { seq: 1, kind: 'document', method: 'GET', path: p, startMs: t0, status: r.status, relayId: null, trace: { traceId, spanId: rootId }, failure: null };
  const obs = {
    instrumentation: { state: 'enabled', reason: null }, exchanges: [ex], spans, sqlAnalyses,
    parser: { available: true, reason: null }, dataAccess,
  };
  const pl = await LN.analyzeProject(APP);
  const lineage = [];
  for (const el of ELEMENTS.filter((e) => e.path === p)) {
    const anchor = elementPos(el);
    const l = LL.evaluateLineage({
      obs, binding: { status: 'identified', seq: 1, reason: null, detail: null }, anchor,
      analysis: pl.analysis, analyzerError: pl.error, resolveLineage: pl.resolveLineage, changedAfter: pl.changedAfter, reasonText: pl.reasonText,
    });
    const cands = (l.candidates ?? []).map((c) => `${c.schema}.${c.table}.${c.column}`);
    lineage.push({
      field: el.field, status: l.status, cut: l.cut?.reason ?? null, cutDetail: l.cut?.detail?.slice(0, 160) ?? null,
      candidates: cands, fetch: l.fetch ? `${l.fetch.file}:${l.fetch.line}:${l.fetch.col}` : null,
      verdict: l.status === 'linked' ? (cands.length === 1 && cands[0] === el.truthColumn ? 'correct' : `WRONG(正解 ${el.truthColumn})`) : 'cut',
    });
  }
  return { path: p, status: r.status, rootFound: !!root, rows, lineage };
}

/* ------------------------------------------------------------ 手順 */
const steps = [];
const PAGES = ['/hmr-m', '/hmr-c', '/hmr-h', '/lin-a'];
async function step(label, pages, change = null) {
  if (change) { change(); await sleep(4000); }
  const results = [];
  for (const p of pages) {
    const t0 = Date.now();
    const r = await get(p);
    await sleep(1500);
    results.push(await evaluateRequest(p, r, t0));
  }
  steps.push({ label, results });
  console.log(`\n## ${label}`);
  for (const res of results) {
    if (res.error) { console.log(`  ${res.path}: ${res.error}`); continue; }
    console.log(`  ${res.path} (${res.status})`);
    for (const x of res.rows) {
      console.log(`    SQL ${x.sql}`);
      console.log(`      正解 ${x.truth} | 実行時のフレーム ${x.frame} [${x.fn}] 生のURLに?moduleId: ${x.rawHasQuery}${x.moduleId ? ` (${x.moduleId.slice(0, 60)})` : ''}`);
      console.log(`      製品 ${x.product ?? '-'}${x.failure ? ` / ${x.failure}` : ''}${x.located && !x.product ? ` (located ${x.located})` : ''} → ${x.verdict} | Node の findSourceMap → ${x.node ?? '-'} (${x.nodeVerdict})`);
    }
    for (const l of res.lineage) {
      console.log(`    由来 ${l.field}: ${l.status}${l.cut ? ` / ${l.cut}` : ''} ${l.candidates.length ? `候補 ${l.candidates.join(',')}` : ''}${l.fetch ? ` 取得 ${l.fetch}` : ''} → ${l.verdict}`);
    }
  }
}

console.log(`# hmr-lineage-probe ${new Date().toISOString()} mode=${NSFR ? '--no-server-fast-refresh' : '既定（server fast refresh 有効）'}`);
console.log(`# 題材（使い捨て）: ${path.relative(REPO, APP)}  next ${req(path.join(APP, 'node_modules/next/package.json')).version}`);
await startDev();
for (const p of PAGES) await get(p); // 初回のコンパイル（観測には使わない）
await sleep(1500);
{
  const raws = readJsonl(RAW);
  const sqlPids = new Set(raws.filter((o) => o.type === 'rawstack').map((o) => o.pid));
  for (const o of raws.filter((x) => x.type === 'proc')) {
    console.log(`# プロセス pid=${o.pid} SQL を実行=${sqlPids.has(o.pid)} sourceMapsEnabled=${o.sourceMapsEnabled} NODE_OPTIONS に --enable-source-maps=${o.nodeOptionsSourceMaps}`);
  }
}

await step('S0 起動直後（変更なし）', PAGES);
await step('S1 無関係なページを変更（listings/page.tsx の末尾にコメント）', PAGES,
  () => put('src/app/listings/page.tsx', `${srcOf('src/app/listings/page.tsx')}\n// probe ${Date.now()}\n`));
await step('S2 共有の lib/db.ts を変更（末尾にコメント）', ['/hmr-m', '/lin-a'],
  () => put('src/lib/db.ts', `${srcOf('src/lib/db.ts')}\n// probe ${Date.now()}\n`));
await step('S3 別ファイルの子コンポーネントを変更（HmrChild.tsx の末尾にコメント）', ['/hmr-c'],
  () => put('src/components/HmrChild.tsx', `${srcOf('src/components/HmrChild.tsx')}\n// probe ${Date.now()}\n`));
await step('S4 別ファイルの取得関数を変更（hmrFetch.ts の末尾にコメント）', ['/hmr-h'],
  () => put('src/lib/hmrFetch.ts', `${srcOf('src/lib/hmrFetch.ts')}\n// probe ${Date.now()}\n`));
await step('S5 コメントだけの変更（hmr-m/page.tsx の末尾）', ['/hmr-m'],
  () => put('src/app/hmr-m/page.tsx', `${srcOf('src/app/hmr-m/page.tsx')}\n// probe ${Date.now()}\n`));
await step('S6 変更後の再要求（ソースは S5 のまま）', ['/hmr-m']);
await step('S7 元に戻す（hmr-m/page.tsx を最初の内容へ）', ['/hmr-m'], () => restore('src/app/hmr-m/page.tsx'));
await step('S8 SQL 呼び出しより前へコードを追加（HmrM の先頭に1文）', ['/hmr-m'],
  () => put('src/app/hmr-m/page.tsx', srcOf('src/app/hmr-m/page.tsx').replace('export default async function HmrM() {\n', 'export default async function HmrM() {\n  const pre = 0;\n')));
await step('S9 SQL 呼び出し自体を変更（a の SELECT 句に plan を足す）', ['/hmr-m'],
  () => put('src/app/hmr-m/page.tsx', srcOf('src/app/hmr-m/page.tsx').replace("'SELECT id, region FROM poc.listings ORDER BY id DESC LIMIT 1'", "'SELECT id, region, plan FROM poc.listings ORDER BY id DESC LIMIT 1'")));
await step('S10 lin-a（SQL 1つ）の末尾にコメント', ['/lin-a'],
  () => put('src/app/lin-a/page.tsx', `${srcOf('src/app/lin-a/page.tsx')}\n// probe ${Date.now()}\n`));
console.log('\n# 開発サーバーを停止して起動し直す（.next は消さない。ソースは S9・S10 のまま）');
await stopDev();
await startDev();
for (const p of PAGES) await get(p);
await sleep(1500);
await step('S11 開発サーバーの再起動後', PAGES);

await stopDev();
/* 集計 */
const all = steps.flatMap((s) => s.results.flatMap((r) => (r.rows ?? []).map((x) => ({ step: s.label, path: r.path, ...x }))));
const lin = steps.flatMap((s) => s.results.flatMap((r) => (r.lineage ?? []).map((x) => ({ step: s.label, path: r.path, ...x }))));
const count = (arr, k) => arr.reduce((m, x) => { const v = x[k].replace(/\(.*$/, ''); m[v] = (m[v] ?? 0) + 1; return m; }, {});
console.log('\n# 集計');
console.log('  SQL の呼び出し位置（製品）:', JSON.stringify(count(all, 'verdict')));
console.log('  SQL の呼び出し位置（Node の findSourceMap）:', JSON.stringify(count(all, 'nodeVerdict')));
console.log('  由来（製品の evaluateLineage）:', JSON.stringify(count(lin, 'verdict')));
for (const x of all.filter((y) => y.verdict === 'WRONG')) console.log(`  WRONG 呼び出し位置: ${x.step} ${x.path} SQL「${x.sql}」 正解 ${x.truth} → 製品 ${x.product}`);
for (const x of lin.filter((y) => y.verdict.startsWith('WRONG'))) console.log(`  WRONG 由来: ${x.step} ${x.path} ${x.field} → ${x.candidates.join(',')} ${x.verdict}`);
if (OUT_JSON) fs.writeFileSync(OUT_JSON, `${JSON.stringify({ mode: NSFR ? 'no-server-fast-refresh' : 'default', steps }, null, 2)}\n`);
process.exit(0);
