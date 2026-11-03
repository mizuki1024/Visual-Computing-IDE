/* =============================================================================
 * 7C HMR × 由来の安全性調査 — **画面での誤対応の再現**（診断用。試験ではない。製品のコードは変えない）。
 *
 *   npm run build && npm run build:lib
 *   PW_CHANNEL=none SHOTS=docs/07c-hmr-lineage-safety-results RESULTS=docs/07c-hmr-lineage-safety-results/hmr-misattribution-e2e.json \
 *     node docs/07c-hmr-lineage-safety-results/hmr-misattribution-e2e.mjs
 *
 * 実ブラウザ・実際の IDE（next start）・実際の HMR・実 DB。転送役・画面の操作は tests/lineage-revision-e2e.spec.mjs と同じ
 * （そこから複写した。差は題材と手順だけ）。題材は使い捨てのコピー（poc/out/hmr-misattr-e2e、Git 管理外）に一時的な
 * ページ /hmr-m（同じコンポーネントに SQL が2つ。hmr-lineage-probe.mjs と同じ）を足したもの。
 *
 * 手順
 *   1. 起動直後: /hmr-m の <p>{a.rows[0].region}</p>（SQL a = poc.listings）を選ぶ → poc.listings.region に結ぶ（正しい）
 *   2. 同じ起動のまま /hmr-m/page.tsx の末尾にコメントだけ足す（サーバー側の HMR）→ F-01 で選択は消える
 *   3. 読み込み直し（新しい文書の要求）→ 同じ要素を選び直す → 由来・右ドック・キャンバスに何が出るか
 *      （hmr-lineage-probe の結果どおりなら、SQL b = poc.regions の列 name を出す＝誤ったカラム）
 *   4. 開発サーバーを起動し直して選び直す → poc.listings.region に戻る
 * 「誤対応を出した」こと自体は試験の失敗にしない。何が表示されたかを記録する（ok の項目は前提の確認だけ）。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const SRC_FIXTURE = path.join(REPO, 'poc', 'fixture-app');
const WORK = path.join(REPO, 'poc', 'out', 'hmr-misattr-e2e');
const PROJECT = path.join(WORK, 'poc', 'fixture-app');
const SHOTS = process.env.SHOTS ?? null;
const RESULTS = process.env.RESULTS ?? null;
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const IDE_HOST = 'ide.cloud.test';
const PV_HOST = 'preview.cloud.test';

let pass = 0;
const fails = [];
const log = [];
const ok = (name, cond, got) => {
  log.push({ name, pass: !!cond, ...(cond ? {} : { got }) });
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (s) => { console.log(`    · ${s}`); log.push({ note: s }); };

if (!fs.existsSync(path.join(REPO, '.next', 'BUILD_ID'))) {
  console.log('\n⊘ IDE がビルドされていない（.next/BUILD_ID が無い）ため、全件 skip。先に npm run build');
  process.exit(0);
}
if (!fs.existsSync(path.join(SRC_FIXTURE, 'node_modules', 'next', 'dist', 'bin', 'next'))) {
  console.log(`\n⊘ ${SRC_FIXTURE} に next がインストールされていないため、全件 skip`);
  process.exit(0);
}

/* ------------------------------------------------------------ 使い捨ての題材 */
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'poc'), { recursive: true });
fs.cpSync(path.join(REPO, 'poc', 'anchor'), path.join(WORK, 'poc', 'anchor'), { recursive: true });
fs.cpSync(SRC_FIXTURE, PROJECT, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(SRC_FIXTURE, src).split(path.sep);
    return rel[0] !== 'node_modules' && rel[0] !== '.next';
  },
});
execFileSync('cp', ['-al', path.join(SRC_FIXTURE, 'node_modules'), path.join(PROJECT, 'node_modules')]);

/** 題材の .env の DB に届くか（値は表示しない）。**DB が無ければ失敗にする**（lineage-e2e と同じ） */
async function dbReachable() {
  try {
    const env = fs.readFileSync(path.join(PROJECT, '.env'), 'utf8');
    const m = /^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m.exec(env);
    if (!m) return 'no-database-url';
    const { Client } = createRequire(path.join(PROJECT, 'package.json'))('pg');
    const c = new Client({ connectionString: m[1].replace(/\?schema=[^&]+/, ''), connectionTimeoutMillis: 3000 });
    await c.connect();
    await c.query('SELECT 1 FROM poc.listings LIMIT 1');
    await c.end();
    return null;
  } catch (e) { return String(e?.code ?? e?.message ?? e).slice(0, 80); }
}

const ORIGINAL = new Map();
const srcOf = (rel) => fs.readFileSync(path.join(PROJECT, rel), 'utf8');
const put = (rel, text) => {
  if (!ORIGINAL.has(rel)) ORIGINAL.set(rel, srcOf(rel));
  fs.writeFileSync(path.join(PROJECT, rel), text);
};
const restore = (rel) => { if (ORIGINAL.has(rel)) fs.writeFileSync(path.join(PROJECT, rel), ORIGINAL.get(rel)); };

/* 一時的な題材（hmr-lineage-probe.mjs と同じ /hmr-m） */
const HMR_M = 'src/app/hmr-m/page.tsx';
fs.mkdirSync(path.join(PROJECT, 'src', 'app', 'hmr-m'), { recursive: true });
fs.writeFileSync(path.join(PROJECT, HMR_M), `/* HMR 調査の一時的な題材: 同じコンポーネントに SQL が2つ */
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
`);
/** 題材のソースから: needle を含む行の pool.query の位置（列は query の q） */
function truthCallOf(rel, needle) {
  const lines = srcOf(rel).split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  return `${rel}:${i + 1}:${lines[i].indexOf('pool.query(') + 'pool.'.length + 1}`;
}
const T0 = {
  el: (() => { const l = srcOf(HMR_M).split('\n'); const i = l.findIndex((x) => x.includes('data-poc-field="m-a"')); return `${HMR_M}:${i + 1}:${l[i].indexOf('<p') + 1}`; })(),
  callA: truthCallOf(HMR_M, "'SELECT id, region FROM poc.listings"),
  callB: truthCallOf(HMR_M, "'SELECT id, name AS region FROM poc.regions"),
};

async function freePort(from) {
  for (let p = from; p < from + 200; p++) {
    const got = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (got) return p;
  }
  throw new Error('空きポートが見つかりません');
}

/* ------------------------------------------------------------ IDE を起動する */
const IDE_PORT = await freePort(3800);
const GW_PORT = await freePort(3860);
const ide = spawn(process.execPath, [path.join(REPO, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(IDE_PORT), '-H', '127.0.0.1'], {
  cwd: REPO,
  env: { ...process.env, VCIDE_ALLOWED_HOSTS: IDE_HOST, VCIDE_PREVIEW_ORIGIN: `http://${PV_HOST}`, VCIDE_PREVIEW_PORT: String(GW_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let ideOut = '';
ide.stdout.on('data', (d) => { ideOut += d; });
ide.stderr.on('data', (d) => { ideOut += d; });
const killIde = () => { try { process.kill(-ide.pid, 'SIGTERM'); } catch { /* 既に終わっている */ } };
process.on('exit', killIde);
for (let i = 0; ; i++) {
  const up = await new Promise((r) => {
    http.get({ host: '127.0.0.1', port: IDE_PORT, path: '/api/runtime/status' }, (res) => { res.resume(); r(res.statusCode === 200); })
      .on('error', () => r(false));
  });
  if (up) break;
  if (i > 120) { console.log(ideOut); throw new Error('IDE が起動しませんでした'); }
  await sleep(250);
}

/* ------------------------------------------------- 転送役（クラウドのポート転送を模す。select-revision-e2e と同じ） */
const MAP = { [IDE_HOST]: IDE_PORT, [PV_HOST]: GW_PORT };
const FWD_PORT = await freePort(3920);
const KIND_OF = { '/api/runtime/anchor': 'anchor', '/api/runtime/lineage': 'lineage', '/api/runtime/source-revisions': 'revisions' };
const holds = {};
function hold(kind, mode) {
  let arrived; let release;
  const h = { mode, arrivedP: new Promise((r) => { arrived = r; }), gate: new Promise((r) => { release = r; }) };
  h.arrived = arrived; h.release = () => release();
  holds[kind] = h;
  return h;
}
const upstreamErrors = [];
const forwarder = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
  const port = MAP[u.hostname];
  if (!port || u.port) { res.writeHead(502); res.end(); return; }
  const kind = u.hostname === IDE_HOST ? KIND_OF[u.pathname] : undefined;
  const h = kind ? holds[kind] : undefined;
  if (h) delete holds[kind];
  if (h?.mode === 'request') { h.arrived(); await h.gate; }
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: u.pathname + u.search, headers: req.headers }, async (r) => {
    if (h?.mode === 'response') {
      const chunks = [];
      for await (const c of r) chunks.push(c);
      h.status = r.statusCode;
      h.body = Buffer.concat(chunks);
      h.arrived(); await h.gate;
      res.writeHead(r.statusCode, r.headers);
      res.end(h.body);
      return;
    }
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { upstreamErrors.push(`${u.pathname} ${e.code ?? e.message}`); if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});
const hmr = { frozen: false, held: [], sockets: 0 };
const freeze = () => { hmr.frozen = true; };
const thaw = () => {
  hmr.frozen = false;
  for (const [sock, d] of hmr.held.splice(0)) { if (!sock.destroyed) sock.write(d); }
};
forwarder.on('connect', (req, sock) => {
  const [h, p] = req.url.split(':');
  const port = MAP[h];
  if (!port || p !== '80') { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const isPv = h === PV_HOST;
  if (isPv) hmr.sockets += 1;
  const up = net.connect(port, '127.0.0.1', () => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (isPv) up.on('data', (d) => { if (hmr.frozen) hmr.held.push([sock, d]); else sock.write(d); });
    else up.pipe(sock);
    sock.pipe(up);
  });
  up.on('end', () => sock.end());
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});
await new Promise((r) => forwarder.listen(FWD_PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  ...(CHANNEL === 'none' ? {} : { channel: CHANNEL }),
  args: [`--proxy-server=http://127.0.0.1:${FWD_PORT}`, '--proxy-bypass-list=<-loopback>'],
});
console.log(`ブラウザ: ${CHANNEL === 'none' ? '同梱の chromium' : `channel ${CHANNEL}`} ${browser.version()} / 題材（使い捨て）: ${PROJECT}`);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const ideErrors = [];
await page.exposeFunction('__ideError', (m) => { ideErrors.push(m); });
await page.addInitScript(() => {
  if (window !== window.top) return;
  window.addEventListener('error', (e) => { window.__ideError?.(String(e.message)); });
});

const A = createRequire(path.join(REPO, '.libjs', 'lib', 'adapter.js'))('./adapter.js');
/** その通信のトレースで実行された SQL のスパン（画面と同じ関数 liveExchangeLinks で求める） */
function exchangeSqlIds(obs, seq) {
  const ex = obs?.exchanges?.find((e) => e.seq === seq);
  return new Set(ex ? A.liveExchangeLinks(obs, ex).sql.map((sp) => sp.spanId) : []);
}
/** 由来の評価の応答（画面が受け取ったもの）。**観測した証拠**として記録に残す（行データ・絶対パスは含まない形だけ） */
const linResponses = [];
const anchorCalls = [];
page.on('request', (r) => { if (r.url().includes('/api/runtime/anchor')) anchorCalls.push(Date.now()); });
page.on('response', async (r) => {
  if (!r.url().includes('/api/runtime/lineage')) return;
  const rec = { t: Date.now(), status: r.status() };
  linResponses.push(rec);
  try {
    const j = await r.json();
    const l = j.lineage;
    Object.assign(rec, {
      lineage: l?.status ?? null, cut: l?.cut?.reason ?? null, outcome: l?.outcome ?? null,
      candidates: (l?.candidates ?? []).map((c) => `${c.schema}.${c.table}.${c.column}`),
      site: l?.site ? `${l.site.file}:${l.site.line}:${l.site.col}` : null,
      element: l?.site?.element ? `${l.site.element.file}:${l.site.element.line}:${l.site.element.col}` : null,
      fetch: l?.fetch ? `${l.fetch.file}:${l.fetch.line}:${l.fetch.col}` : null,
      sqlSpanIds: l?.sqlSpanIds ?? [],
      exchangeSeq: l?.exchangeSeq ?? null,
      /** **その文書の通信のトレースの** SQL の呼び出し位置の特定（server-call-stack）。特定できなかったものは理由 */
      dataAccess: (j.observation?.dataAccess ?? []).filter((d) => exchangeSqlIds(j.observation, l?.exchangeSeq ?? l?.binding?.seq).has(d.spanId)).map((d) => ({
        spanId: d.spanId, site: d.site ? `${d.site.file}:${d.site.line}:${d.site.col}` : null,
        located: d.located ? `${d.located.file}:${d.located.line}:${d.located.col}` : null,
        failure: d.failure ? `${d.failure.reason}: ${String(d.failure.detail ?? '').slice(0, 160)}` : null,
      })),
      resolution: j.resolution ? { status: j.resolution.status, at: j.resolution.anchor ? `${j.resolution.anchor.file}:${j.resolution.anchor.line}:${j.resolution.anchor.col}` : null, rev: j.resolution.anchor?.rev ?? null, reason: j.resolution.reason ?? null } : null,
    });
  } catch (e) { rec.parseError = String(e).slice(0, 120); }
});

/* ------------------------------------------------------------ 画面の操作 */
const rtPanel = () => page.locator('.fpnl[aria-label="プロジェクトと実行"]');
const pv = () => page.locator('section[aria-label="プレビュー"] .pvlive');
const frame = () => page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe');
const sel = (attr) => pv().getAttribute(attr, { timeout: 3000 }).catch(() => null);
const dockText = () => page.locator('aside.dock').innerText().catch(() => '');
const canvasText = () => page.locator('.canvas').innerText().catch(() => '');
const nodeLabels = () => page.locator('g.nd').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))).catch(() => []);
const status = () => page.evaluate(async () => (await fetch('/api/runtime/status')).json());
const waitPv = (state, timeout = 200000) => page.waitForFunction(
  (s) => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') === s, state, { timeout });
const loadsNow = async () => Number(await sel('data-loads'));
async function until(fn, timeout = 15000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* 途中の状態 */ }
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
}
const selectMode = async (on) => {
  if (((await sel('data-select-mode')) === 'on') !== on) await pv().locator('.rt-b', { hasText: '選択' }).click();
  await until(async () => ((await sel('data-agent-mode')) === 'on') === on, 10000);
};
const gotoPath = async (p) => {
  const n = await loadsNow();
  await pv().locator('input[aria-label="プレビューのパス"]').fill(p);
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  await until(async () => (await loadsNow()) > n, 60000);
  await until(async () => (await sel('data-path')) === p, 60000);
  await until(async () => (await sel('data-select-mode')) === (await sel('data-agent-mode')), 30000);
};
const snapshot = async () => ({
  selection: await sel('data-selection'), at: await sel('data-sel-at'), reason: await sel('data-sel-reason'),
  cleared: await sel('data-sel-cleared'), lineage: await sel('data-lineage'), lineageReason: await sel('data-lineage-reason'),
  cands: await sel('data-lineage-cands'),
});
/** 選択モードで要素を選び、由来の評価が終わる（linked / cut）か、選択が解決しない、まで待つ */
async function pick(locator, { want = null, timeout = 45000 } = {}) {
  await selectMode(true);
  const n = anchorCalls.length;
  const m = linResponses.length;
  await locator.click({ timeout: 30000 });
  await until(() => anchorCalls.length > n, 20000, 50);
  await until(async () => ['resolved', 'unresolved', 'error'].includes(await sel('data-selection')), 30000, 50);
  if ((await sel('data-selection')) === 'resolved') {
    await until(async () => {
      const st = await sel('data-lineage');
      return linResponses.length > m && st && (!want || st === want);
    }, timeout, 250);
  }
  return snapshot();
}
let devPort = null;
/** 開発サーバーに直接ページを要求し、変換（ローダ）と対応表の書き直しを起こす。ブラウザの DOM は変えない */
const compileNow = (p) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port: devPort, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); })
    .on('error', (e) => resolve(String(e)));
});
const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
const frameText = (css) => frame().locator(css).allInnerTexts().catch(() => []);

/** 由来が画面に出ているか（パネルの属性・右ドック・キャンバス） */
async function lineageShown(col) {
  const d = await dockText();
  const c = await canvasText();
  const labels = await nodeLabels();
  return {
    attr: (await sel('data-lineage')) === 'linked' && (await sel('data-lineage-cands')) === col,
    dock: d.includes('この値の出所') && d.includes(col.split('.').slice(0, 2).join('.')) && d.includes(col.split('.')[2]),
    canvasWord: c.includes('由来は静的解析による推定'),
    canvasColumn: labels.some((l) => (l ?? '').includes(col)),
  };
}
/** 由来の表示（右ドックの「この値の出所」・キャンバスの推定の語・カラムのノード）が残っていないか */

const results = { startedAt: new Date().toISOString(), project: path.relative(REPO, PROJECT), truth: T0, phases: {} };
const EL = () => frame().locator('p[data-poc-field="m-a"]').first();
const TRUE_COL = 'poc.listings.region';
const WRONG_COL = 'poc.regions.name';
/** 画面に出た由来（パネルの属性・応答・右ドックの「この値の出所」の近く・キャンバスのカラムのノード） */
async function shown(label) {
  await selectMode(false);
  await page.waitForTimeout(800);
  const d = await dockText();
  const k = d.indexOf('この値の出所');
  const last = linResponses.at(-1) ?? null;
  const out = {
    selection: await sel('data-selection'), at: await sel('data-sel-at'),
    lineage: await sel('data-lineage'), lineageReason: await sel('data-lineage-reason'), cands: await sel('data-lineage-cands'),
    docBinding: await sel('data-doc-binding'),
    dockOrigin: k >= 0 ? d.slice(k, k + 140).replace(/\s+/g, ' ') : null,
    canvasColumns: (await nodeLabels()).filter((l) => /poc\./.test(l ?? '')),
    response: last ? { lineage: last.lineage, cut: last.cut, candidates: last.candidates, fetch: last.fetch, dataAccess: last.dataAccess } : null,
  };
  note(`${label}: 由来 ${out.lineage}（${out.lineageReason ?? '-'}）候補 ${out.cands ?? '-'} / 応答の取得位置 ${out.response?.fetch ?? '-'} / 右ドック「${out.dockOrigin ?? '（この値の出所なし）'}」`);
  for (const x of out.response?.dataAccess ?? []) note(`  この文書の SQL ${x.spanId}: 呼び出し位置 ${x.site ?? '-'}${x.failure ? ` / ${x.failure}` : ''}`);
  return out;
}

try {
  const db = await dbReachable();
  ok('前提: 題材の DB（使い捨ての PostgreSQL）に届く', db === null, db);

  console.log('\n0. 使い捨ての題材を起動する');
  await page.goto(`http://${IDE_HOST}/`, { waitUntil: 'networkidle' });
  await rtPanel().locator('#rt-path').fill(PROJECT);
  await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((p) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === p, PROJECT, { timeout: 20000 });
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  await until(async () => Number(await sel('data-conn')) >= 1, 60000);
  const st = await status();
  eq('前提: 計装は有効', st.runtime.instrumentation?.state, 'enabled');
  eq('前提: 要素識別子の注入は有効', st.runtime.anchors?.state, 'enabled');
  devPort = st.runtime.port;
  await gotoPath('/hmr-m');
  ok('前提: /hmr-m は DB の値を描いている', (await frameText('p[data-poc-field="m-a"]')).length === 1, await frameText('p[data-poc-field="m-a"]'));

  console.log('\n1. 起動直後: <p>{a.rows[0].region}</p> を選ぶ');
  {
    await pick(EL(), { want: 'linked' });
    const s = await shown('1 起動直後');
    eq('1 前提: 選択の位置 = ソースの <p>', s.at, T0.el);
    results.phases.fresh = s;
    results.phases.freshVerdict = s.lineage === 'linked' && s.cands === TRUE_COL && s.response?.fetch === T0.callA ? 'correct' : 'other';
    note(`1 判定: ${results.phases.freshVerdict}（正解 ${TRUE_COL}・取得位置 ${T0.callA}）`);
    await shot('hmr-misattr-1-fresh');
  }

  console.log('\n2. 同じ起動のまま /hmr-m/page.tsx の末尾にコメントだけ足す（サーバー側の HMR）');
  {
    put(HMR_M, `${srcOf(HMR_M)}\n// comment only ${Date.now()}\n`);
    const cleared = await until(async () => (await sel('data-selection')) === 'cleared', 15000);
    ok('2 前提: F-01 の版の確かめで、前の選択を無効にする', cleared, await snapshot());
    await sleep(2500);
  }

  console.log('\n3. 読み込み直して（新しい文書の要求）、同じ要素を選び直す');
  {
    await gotoPath('/hmr-m');
    await sleep(1000);
    await pick(EL(), { timeout: 30000 });
    await until(async () => ['linked', 'cut'].includes(await sel('data-lineage')), 20000, 250);
    const s = await shown('3 HMR の後に読み込み直して選び直した');
    eq('3 前提: 選択はいまのソースの <p> に特定（F-01 の照合は通る＝DOM とソースは一致）', [s.selection, s.at], ['resolved', T0.el]);
    eq('3 前提: 文書は新しい要求に同定', s.docBinding, 'identified');
    results.phases.afterHmr = s;
    const wrong = s.lineage === 'linked' && (s.cands ?? '').includes(WRONG_COL);
    results.phases.afterHmrVerdict = wrong ? `WRONG（${WRONG_COL} を出した。正解 ${TRUE_COL}）`
      : s.lineage === 'linked' && s.cands === TRUE_COL ? 'correct' : `cut（${s.lineageReason}）`;
    note(`3 判定: ${results.phases.afterHmrVerdict}`);
    await shot('hmr-misattr-3-after-hmr');
  }

  console.log('\n4. 開発サーバーを起動し直して選び直す');
  {
    await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
    await waitPv('stopped', 60000);
    await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
    await waitPv('live');
    await until(async () => Number(await sel('data-conn')) >= 1, 60000);
    devPort = (await status()).runtime.port;
    await gotoPath('/hmr-m');
    await pick(EL(), { want: 'linked' });
    const s = await shown('4 再起動の後');
    results.phases.afterRestart = s;
    results.phases.afterRestartVerdict = s.lineage === 'linked' && s.cands === TRUE_COL && s.response?.fetch === T0.callA ? 'correct' : 'other';
    note(`4 判定: ${results.phases.afterRestartVerdict}`);
    await shot('hmr-misattr-4-after-restart');
  }
  ok('画面にエラーが出ていない', ideErrors.length === 0, ideErrors);
} catch (e) {
  fails.push(`例外: ${e?.stack ?? e}`);
  console.log(`  ✗ 例外: ${e?.stack ?? e}`);
} finally {
  for (const rel of ORIGINAL.keys()) restore(rel);
  try {
    await page.evaluate(async () => {
      const s = await (await fetch('/api/runtime/status')).json();
      if (s.runtime?.state === 'running' || s.runtime?.state === 'starting') {
        await fetch('/api/runtime/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: '{}' });
      }
    });
  } catch { /* IDE が落ちていてもよい */ }
  await sleep(1500);
  await browser.close();
  forwarder.close();
  killIde();
  await sleep(500);
  let leftover = '';
  try { leftover = execFileSync('pgrep', ['-af', WORK], { encoding: 'utf8' }).trim(); } catch { leftover = ''; }
  ok('後片付け: 使い捨ての題材で動くプロセスが残っていない', leftover === '', leftover);
  fs.rmSync(WORK, { recursive: true, force: true });
}
results.finishedAt = new Date().toISOString();
results.lineageResponses = linResponses;
results.pass = pass; results.fail = fails.length; results.items = log;
if (RESULTS) { fs.mkdirSync(path.dirname(RESULTS), { recursive: true }); fs.writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`); }
console.log(`\n判定: 起動直後 ${results.phases.freshVerdict} / HMR の後 ${results.phases.afterHmrVerdict} / 再起動の後 ${results.phases.afterRestartVerdict}`);
console.log(`${fails.length ? '✗ 前提の確認に失敗あり' : '✓ 前提の確認はすべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
