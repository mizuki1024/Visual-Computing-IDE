/* =============================================================================
 * Phase 7B-3B-2 — 画面の要素から、その値の由来の DB カラム（の候補）まで。**実物**で端から端まで確かめる。
 *   npm run build && npm run build:lib && node tests/lineage-e2e.spec.mjs
 *   SHOTS=docs/07b3b2-screenshots node tests/lineage-e2e.spec.mjs
 *
 * 実物: Chrome・IDE（next start）・next dev（Turbopack）・計装・PostgreSQL 16・PoC-04 の静的解析。
 * 模擬: クラウドのポート転送（queries-e2e / observe-e2e と同じ転送役）。
 * 前提: 題材 poc/fixture-app が使う使い捨ての PostgreSQL（poc/README.md）。**DB が無ければ失敗にする**。
 *
 * **正解はこの試験が題材のソースを読んで決める**（data-poc-field の要素の行・列、pool.query の行・列）。
 * IDE の照合・解析の結果は使わない。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const PROJECT = process.env.VCIDE_E2E_PROJECT ?? path.join(REPO, 'poc', 'fixture-app');
const SHOTS = process.env.SHOTS ?? null;
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const IDE_HOST = 'ide.cloud.test';
const PV_HOST = 'preview.cloud.test';
const MARK = 'DUMMY-SECRET-7B3B2-E2E';

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(REPO, '.next', 'BUILD_ID'))) {
  console.log('\n⊘ IDE がビルドされていない（.next/BUILD_ID が無い）ため、全件 skip。先に npm run build');
  process.exit(0);
}
if (!fs.existsSync(path.join(PROJECT, 'node_modules', 'next', 'dist', 'bin', 'next'))) {
  console.log(`\n⊘ ${PROJECT} に next がインストールされていないため、全件 skip`);
  process.exit(0);
}

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
const IDE_PORT = await freePort(4100);
const GW_PORT = await freePort(4160);
const DUMMY_SECRETS = {
  GITHUB_TOKEN: `ghp_${MARK}`, GH_TOKEN: MARK, AWS_SECRET_ACCESS_KEY: MARK, AWS_ACCESS_KEY_ID: MARK,
  ANTHROPIC_API_KEY: `sk-ant-${MARK}`, CLAUDE_CODE_OAUTH_TOKEN: MARK, OPENAI_API_KEY: MARK,
  DATABASE_URL: `postgres://u:${MARK}@db.invalid/x`, ALL_PROXY: `http://u:${MARK}@proxy.invalid:8080`,
};
const ide = spawn(process.execPath, [path.join(REPO, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(IDE_PORT), '-H', '127.0.0.1'], {
  cwd: REPO,
  env: {
    ...process.env,
    ...DUMMY_SECRETS,
    VCIDE_ALLOWED_HOSTS: IDE_HOST,
    VCIDE_PREVIEW_ORIGIN: `http://${PV_HOST}`,
    VCIDE_PREVIEW_PORT: String(GW_PORT),
  },
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

/* ------------------------------------------------- 転送役（クラウドのポート転送を模す） */
const MAP = {
  [IDE_HOST]: IDE_PORT,
  [PV_HOST]: GW_PORT,
  // 許可していない名前で同じポートに来る（DNS リバインディングを模す）
  'rebind.cloud.test': IDE_PORT,
  'rebind-preview.cloud.test': GW_PORT,
};
const forwardLog = [];
const fwd = { blockPreview: false };
const FWD_PORT = await freePort(4220);
const forwarder = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
  forwardLog.push({ host: u.host, path: u.pathname });
  const port = MAP[u.hostname];
  if (!port || u.port || (fwd.blockPreview && u.hostname === PV_HOST)) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`forwarder: ${u.host} is not forwarded`);
    return;
  }
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: u.pathname + u.search, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502); } res.end(); });
  req.pipe(up);
});
forwarder.on('connect', (req, sock) => {
  const [h, p] = req.url.split(':');
  forwardLog.push({ host: req.url, path: '(CONNECT)' });
  const port = MAP[h];
  if (!port || p !== '80' || (fwd.blockPreview && h === PV_HOST)) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const up = net.connect(port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});
await new Promise((r) => forwarder.listen(FWD_PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  ...(CHANNEL === 'none' ? {} : { channel: CHANNEL }),
  args: [`--proxy-server=http://127.0.0.1:${FWD_PORT}`, '--proxy-bypass-list=<-loopback>'],
});
console.log(`ブラウザ: ${CHANNEL === 'none' ? '同梱の chromium' : `channel ${CHANNEL}`} ${browser.version()} / 題材: ${PROJECT}`);
console.log(`IDE: 127.0.0.1:${IDE_PORT}（ブラウザからは http://${IDE_HOST}）/ 中継: 127.0.0.1:${GW_PORT}（http://${PV_HOST}）`);

const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const ideErrors = [];
/** 第6節で転送をわざと止めている間。そのときの「届かない」は期待どおりの出力である */
const phase = { expectUnreachable: false, negativeApi: false };
// プレビューの中のアプリのエラー（題材は DB が無いと /api/* が失敗する）は IDE の不具合ではないので分ける。
// pageerror は iframe の中の例外も区別せずに含み、スタックが空のこともある。
// そこで IDE の最上位の文書にだけ受け口を置き、IDE の画面で起きた例外だけを拾う
await page.exposeBinding('__vcideE2eError', (_src, msg) => { ideErrors.push(String(msg)); });
await page.addInitScript(() => {
  if (window !== window.top) return;
  addEventListener('error', (e) => window.__vcideE2eError(e.message));
  addEventListener('unhandledrejection', (e) => window.__vcideE2eError(e.reason?.message ?? String(e.reason)));
});
/** プレビューの中で出た、**IDE の中継が原因になりうる**エラー（CSP の書き方・差し込んだスクリプト）。アプリ自身のエラーとは分ける */
const gatewayErrors = [];
page.on('console', (m) => {
  // 第6節で転送をわざと止めている間の「ping に届かない」は期待どおりなので除く
  if (/Content-Security-Policy|frame-ancestors|__vcide_preview|agent\.js/.test(m.text())
    && !(phase.expectUnreachable && m.text().includes('/__vcide_preview/ping'))) gatewayErrors.push(m.text());
  if (m.type() !== 'error' || !(m.location().url ?? '').startsWith(`http://${IDE_HOST}`) || /favicon/.test(m.text())) return;
  if (phase.expectUnreachable && m.text().includes(`http://${PV_HOST}`)) return;
  // 第5・7節で、わざと拒否される要求（400 / 403 / 409）を送っている間の「読み込み失敗」は期待どおり
  if (phase.negativeApi && /Failed to load resource: the server responded with a status of (400|403|409)/.test(m.text())) { phase.negativeSeen += 1; return; }
  ideErrors.push(m.text());
});
const sockets = [];
page.on('websocket', (ws) => {
  const rec = { url: ws.url(), frames: 0, error: null };
  sockets.push(rec);
  ws.on('framereceived', () => { rec.frames += 1; });
  ws.on('socketerror', (e) => { rec.error = String(e); });
});
const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };

const rtPanel = () => page.locator('.fpnl[aria-label="プロジェクトと実行"]');
const pvPanel = () => page.locator('section[aria-label="プレビュー"]');
const pv = () => pvPanel().locator('.pvlive');
const pvState = () => pv().getAttribute('data-preview-state', { timeout: 2000 }).catch(() => null);
const waitPv = (state, timeout = 200000) => page.waitForFunction(
  (s) => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') === s,
  state, { timeout },
);
const frame = () => page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe');
const rtState = () => rtPanel().locator('.rt-st b').innerText();
const loadsNow = async () => Number(await pv().getAttribute('data-loads'));
const waitLoads = (n, timeout = 60000) => page.waitForFunction(
  (k) => Number(document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-loads')) > k,
  n, { timeout },
);
const groupPids = (pgid) => execFileSync('ps', ['-ax', '-o', 'pid=,pgid='], { encoding: 'utf8' })
  .split('\n').map((l) => /^\s*(\d+)\s+(\d+)/.exec(l)).filter(Boolean)
  .filter((m) => +m[2] === pgid).map((m) => +m[1]);
const environOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return null; } };

/* ------------------------------------------------------- この試験の道具 */
import { createRequire } from 'node:module';
const requireLib = createRequire(path.join(REPO, '.libjs', 'lib', 'adapter.js'));
const LIB = fs.existsSync(path.join(REPO, '.libjs', 'lib', 'adapter.js'))
  ? { A: requireLib('./adapter.js'), M: requireLib('./model.js'), L: requireLib('./layout.js') } : null;
const NO_DB = process.env.VCIDE_E2E_NO_DB === '1';
let skipped = 0;
const skip = (name) => { skipped++; console.log(`  ⊘ ${name}（VCIDE_E2E_NO_DB=1）`); };

/** 題材の .env の DB に届くか（値は表示しない）。題材の依存の pg で1回だけ問い合わせる */
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

const sel = (a) => pv().getAttribute(a);
const obsRow = () => pv().locator('.pvobsrow');
const obsAttr = (a) => obsRow().getAttribute(a, { timeout: 2000 }).catch(() => null);
const gotoPath = async (p) => {
  const n = await loadsNow();
  await pv().locator('input[aria-label="プレビューのパス"]').fill(p);
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  await waitLoads(n);
};
const status = () => page.evaluate(async () => (await fetch('/api/runtime/status')).json());
const POSTH = { 'content-type': 'application/json', 'x-vcide-request': '1' };
/** 観測の API を、画面と同じ入口（同一オリジン・独自ヘッダ）で呼ぶ */
const fetchObs = (run) => page.evaluate(async ({ run, h }) => {
  /* 7C-1: 画面は要約＋選んだ通信の証拠だけを受け取る。試験は証拠を直接確かめるので全件（detail: 'all'）を求める */
  const r = await fetch('/api/runtime/observations', { method: 'POST', headers: h, body: JSON.stringify({ run, detail: 'all' }) });
  return { status: r.status, text: await r.text() };
}, { run, h: POSTH });
const obsOf = async (run) => { const r = await fetchObs(run); return r.status === 200 ? JSON.parse(r.text).observation ?? null : null; };
/** 観測を返さなかった理由（200 で observation: null と stale） */
const staleOf = async (run) => { const r = await fetchObs(run); const j = JSON.parse(r.text); return `${r.status}/${j.observation === null ? 'null' : 'obs'}/${j.stale?.code ?? '-'}`; };
const runOf = (st) => ({ instance: st.runtime.instance, pid: st.runtime.pid, startedAt: st.runtime.startedAt });
/** 観測にこの通信が現れ、（DB があれば）SQL まで結べるまで待つ */
async function waitExchange(run, p, { sql = true, timeout = 60000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const o = await obsOf(run);
    const e = o?.exchanges.filter((x) => x.path === p).at(-1);
    if (e && (!sql || (LIB && LIB.A.liveExchangeLinks(o, e).sql.length > 0))) return { o, e };
    if (Date.now() - t0 > timeout) return { o, e: e ?? null };
    await sleep(400);
  }
}
/** 一覧から通信を選んで［表示］ */
async function showExchange(seq) {
  await obsRow().locator('select').selectOption(String(seq));
  await obsRow().locator('.rt-b', { hasText: '表示' }).click();
  await page.waitForFunction((s) => document.querySelector('.pvobsrow')?.getAttribute('data-obs-shown') === String(s), seq, { timeout: 10000 });
}
const nodeLabels = () => page.locator('g.nd').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
const dockText = () => page.locator('aside.dock').innerText();
/** キャンバスだけを撮る（浮かぶパネルが手前を覆う — 7B-2 第7.3節の既知の制約）。撮る間だけパネルを見えなくする。操作はしない */
const shotCanvas = async (name) => {
  if (!SHOTS) return;
  const h = await page.addStyleTag({ content: '.fpnl{visibility:hidden !important}' });
  await shot(name);
  await h.evaluate((el) => el.remove());
};
/** ブラウザに届いた中継の応答ヘッダ（中継の識別子・トレース識別子が漏れていないかを見る） */
const pvResponses = [];
page.on('response', (r) => {
  if (!r.url().startsWith(`http://${PV_HOST}`)) return;
  const h = r.headers();
  pvResponses.push({ url: r.url(), trace: h['x-vcide-trace'] ?? null, relay: h['x-vcide-relay'] ?? null });
});
/** 要素の選択（7B-2）の要求と解決。選択した要素を観測と並べた画面を、Node で同じ変換にかけて確かめるために持つ */
const anchorCalls = [];
page.on('request', (r) => {
  if (r.url().endsWith('/api/runtime/anchor') && r.method() === 'POST') anchorCalls.push({ body: JSON.parse(r.postData() ?? '{}'), res: null });
});
page.on('response', async (r) => {
  if (!r.url().endsWith('/api/runtime/anchor')) return;
  const c = anchorCalls.at(-1);
  if (c) { try { c.res = await r.json(); } catch { /* 読めなければ null のまま */ } }
});

if (!LIB) {
  console.log('\n⊘ .libjs が無い（npm run build:lib を先に）。全件 skip');
  process.exit(0);
}
if (NO_DB) {
  console.log('\n✗ この試験は DB 無しでは意味が無い（SQL を実行していないのに由来を結べたとは言えない）。VCIDE_E2E_NO_DB を外してください');
  killIde(); browser.close(); forwarder.close();
  process.exit(1);
}
const dbProblem = await dbReachable();
if (dbProblem) {
  console.log(`\n✗ 題材の DB に届きません（${dbProblem}）。poc/README.md の手順で使い捨ての PostgreSQL を用意してください。`);
  killIde(); browser.close(); forwarder.close();
  process.exit(1);
}

/* ------------------------------------------------- 正解（試験が題材のソースを読んで決める） */
const SRC = (rel) => fs.readFileSync(path.join(PROJECT, rel), 'utf8').split('\n');
/** 取得時点の除去（mask.cjs）と同じ置き換えをソースの文字列に当てる（数値・文字列リテラル → $0） */
const maskLike = (sql) => sql.replace(/'(?:[^']|'')*'/g, '$0').replace(/(?<![\w$."])\d+(?:\.\d+)?(?![\w.])/g, '$0').replace(/\s+/g, ' ').trim();
/**
 * この SQL 文を `pool.query('…')` に書いた位置の候補（ファイル・行・列）と、その行の上で最も近い関数宣言。
 * 列は `query` の q の位置（1 始まり）。**IDE の照合器は使わない**
 */
function truthSites(sqlText, files) {
  const out = [];
  for (const f of files) {
    const lines = SRC(f);
    lines.forEach((l, i) => {
      const m = /pool\.query\('((?:[^']|'')*)'/.exec(l);
      if (!m || maskLike(m[1]) !== sqlText) return;
      let fn = null;
      for (let j = i; j >= 0 && !fn; j--) fn = /function\s+([A-Za-z_$][\w$]*)/.exec(lines[j])?.[1] ?? null;
      out.push({ file: f, line: i + 1, col: l.indexOf('pool.query(') + 'pool.'.length + 1, fn, component: fn && /^[A-Z]/.test(fn) ? fn : null });
    });
  }
  return out;
}
const SQL_TEXT = (s) => String(s.attrs['db.statement'] ?? s.attrs['db.query.text'] ?? '');
const daOf = (o, sp) => o.dataAccess?.find((d) => d.spanId === sp.spanId) ?? null;
/** 観測にこの通信が現れ、SQL がすべて照合済みになるまで待つ（照合は取得のたびに進む） */
async function waitAttributed(run, p, { nSql = 1, timeout = 90000, pick = (xs) => xs.at(-1) } = {}) {
  const t0 = Date.now();
  for (;;) {
    const o = await obsOf(run);
    const e = o ? pick(o.exchanges.filter((x) => x.path === p)) : null;
    const l = e ? LIB.A.liveExchangeLinks(o, e) : null;
    if (l && l.sql.length >= nSql && l.sql.every((sp) => daOf(o, sp))) return { o, e, l };
    if (Date.now() - t0 > timeout) return { o, e: e ?? null, l };
    await sleep(400);
  }
}
const kindsOf = (ds) => ds.nodes.map((n) => n.kind);
const relOf = (ds, r) => ds.hops.filter((h) => h.relation === r);


/* ------------------------------------------------------- この試験の道具（7B-3B-2） */
/** 由来の API の要求と応答（画面が呼んだもの）。Node で同じ変換にかけて確かめる */
const linCalls = [];
page.on('request', (r) => {
  if (r.url().endsWith('/api/runtime/lineage') && r.method() === 'POST') linCalls.push({ req: r, body: JSON.parse(r.postData() ?? '{}'), res: null });
});
/* 7C-1: 応答は**その要求**に結ぶ（到着の順では結ばない）。全 29 本の直列実行で1回、別の選択の応答を
 * この選択の結果として読んだ（応答が前後して届くと、順で結ぶ方式は取り違える） */
page.on('response', async (r) => {
  if (!r.url().endsWith('/api/runtime/lineage')) return;
  const c = linCalls.find((x) => x.req === r.request());
  if (c) { try { c.res = await r.json(); } catch { /* 読めなければ null */ } }
});
/** 由来の API を、画面と同じ入口で呼ぶ（否定の確認用） */
const callLineage = (body) => page.evaluate(async ({ body, h }) => {
  const r = await fetch('/api/runtime/lineage', { method: 'POST', headers: h, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}, { body, h: POSTH });
/** 題材のソースから: data-poc-field の要素の位置（要素の開始）と、値の式 {…} の位置 */
function truthEl(file, field) {
  const lines = SRC(file);
  const i = lines.findIndex((l) => l.includes(`data-poc-field="${field}"`));
  const l = lines[i];
  const elCol = l.lastIndexOf('<', l.indexOf(`data-poc-field="${field}"`)) + 1;
  const exprCol = l.indexOf('{', l.indexOf('>', l.indexOf(`data-poc-field="${field}"`))) + 1;
  return { file, line: i + 1, col: elCol, exprCol };
}
/** 題材のソースから: n 番目の pool.query の位置（列は query の q。V8 のスタックが指す列） */
function truthCall(file, nth = 0) {
  const lines = SRC(file);
  const hits = lines.map((l, i) => [l, i]).filter(([l]) => l.includes('pool.query('));
  const [l, i] = hits[nth];
  return { file, line: i + 1, col: l.indexOf('pool.query(') + 'pool.'.length + 1 };
}
const pvAttr = (a) => pv().getAttribute(a);
/** 選択モードにして要素をクリックし、由来の評価が `want`（linked / cut）になるまで待つ */
async function pick(locator, { want = null, reason = null, timeout = 45000 } = {}) {
  if ((await pvAttr('data-select-mode')) !== 'on') await pv().locator('.rt-b', { hasText: '選択' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-agent-mode') === 'on', null, { timeout: 15000 });
  const n = linCalls.length;
  await frame().locator(locator).first().click({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-selection') === 'resolved', null, { timeout: 30000 });
  const t0 = Date.now();
  for (;;) {
    const st = await pvAttr('data-lineage');
    const rs = await pvAttr('data-lineage-reason');
    const done = linCalls.length > n && linCalls.at(-1).res;
    if (done && st && (!want || (st === want && (!reason || rs === reason)))) break;
    if (Date.now() - t0 > timeout) break;
    await sleep(250);
  }
  await pv().locator('.rt-b', { hasText: '選択' }).click();      // 選択モードを抜ける（選択は残る）
  return linCalls.at(-1)?.res ?? null;
}
/** 画面が描いたのと同じ変換を Node で（由来の API の応答から） */
function datasetOf(res) {
  const call = linCalls.findLast((c) => c.res === res);
  const input = {
    project: 'fixture', port: 0, page: { path: call.body.selection.path, title: '' },
    selection: call.body.selection, resolution: res.resolution, selectedAt: 'T',
    ...(call.body.document ? { document: call.body.document } : {}),
  };
  if (res.binding.status === 'identified') {
    return LIB.A.fromLiveRun(res.observation, res.binding.seq, { selection: input, binding: res.binding, lineage: res.lineage }).dataset;
  }
  return LIB.A.fromLiveSelection({ ...input, lineage: res.lineage }).dataset;
}
const docTokenNow = () => frame().locator('script[data-vcide-doc]').first().getAttribute('data-vcide-doc', { timeout: 5000 }).catch(() => null);
const canvasText = () => page.locator('.canvas').innerText();
const rowText = () => pv().locator('.pvlin').innerText({ timeout: 3000 }).catch(() => '');

try {
  /* ============================================ 1. 起動 */
  console.log('\n1. fixture-app を起動する（計装・呼び出し位置の記録・要素識別子の注入）');
  await page.goto(`http://${IDE_HOST}/`, { waitUntil: 'networkidle' });
  const nodesBase = await page.locator('g.nd').count();
  await rtPanel().locator('#rt-path').fill(PROJECT);
  await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((p) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === p, PROJECT, { timeout: 20000 });
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  const st1 = await status();
  const run1 = runOf(st1);
  eq('計装は有効', st1.runtime.instrumentation.state, 'enabled');
  eq('要素識別子の注入は有効', st1.runtime.anchors?.state, 'enabled');

  /* ============================================ 2. /lin-a: 画面の値 → DB カラム（最初の対象） */
  console.log('\n2. /lin-a（PoC-04 ケースA）: <li> を選ぶ → 文書を同定 → 静的解析と実測が一致 → poc.listings.region');
  await gotoPath('/lin-a');
  const { o: oA, e: exA } = await waitAttributed(run1, '/lin-a');
  const tokA = await docTokenNow();
  ok('iframe の文書に、中継が付けた文書の識別子がある（16進32桁）', /^[0-9a-f]{32}$/.test(tokA ?? ''), tokA);
  eq('その識別子は、いまの起動の /lin-a の通信の記録と一致する', oA.exchanges.find((e) => e.docToken === tokA)?.seq, exA.seq);
  ok('文書の識別子は中継の識別子（relayId）と別', exA.docToken !== exA.relayId);
  const elA = truthEl('src/app/lin-a/page.tsx', 'a-region');
  const callA = truthCall('src/app/lin-a/page.tsx');
  const rA = await pick('li[data-poc-field="a-region"]', { want: 'linked' });
  eq('選択した要素の位置 = ソースの <li>（7B-2）', await pvAttr('data-sel-at'), `${elA.file}:${elA.line}:${elA.col}`);
  eq('文書を同定: いま表示している /lin-a の文書の通信', [await pvAttr('data-doc-binding'), Number(await pvAttr('data-doc-seq'))], ['identified', exA.seq]);
  eq('由来を結んだ（linked）・1列に確定', [await pvAttr('data-lineage'), await pvAttr('data-lineage-outcome')], ['linked', 'confirmed']);
  eq('由来の候補 = poc.listings.region', await pvAttr('data-lineage-cands'), 'poc.listings.region');
  const lA = rA?.lineage;
  eq('値を描く式の位置（PropBindingSite）= ソースの {row.region}', lA?.site && `${lA.site.file}:${lA.site.line}:${lA.site.col}`, `${elA.file}:${elA.line}:${elA.exprCol}`);
  eq('取得位置（DataAccessSite）= ソースの pool.query（実測と静的解析が列まで一致）', lA?.fetch && `${lA.fetch.file}:${lA.fetch.line}:${lA.fetch.col}`, `${callA.file}:${callA.line}:${callA.col}`);
  {
    const sp = oA.spans.find((s) => lA?.sqlSpanIds.includes(s.spanId));
    const an = rA.observation.sqlAnalyses.find((a) => a.spanId === sp?.spanId);
    ok('結びついた SQL は、その文書の通信のトレースの中で実行されたもの', !!sp && sp.traceId === LIB.A.liveExchangeLinks(oA, exA).root?.traceId);
    ok('実測した SQL の SELECT 結果列に region がある（照合した相手）', an?.selectItems?.some((i) => i.key === 'region' && i.resolved?.column === 'region'), an?.selectItems);
  }
  ok('パネルの行: 「由来（静的解析による推定）: poc.listings.region」', (await rowText()).includes('由来（静的解析による推定）: poc.listings.region'), await rowText());
  {
    const ds = datasetOf(rA);
    eq('validateDataset() を通過する（実データ）', JSON.stringify(LIB.M.validateDataset(ds)), '[]');
    eq('キャンバスのノード数 = 変換のノード数（画面と同じ変換）', (await nodeLabels()).length, ds.nodes.length);
    const sup = relOf(ds, 'supplies');
    eq('supplies を1本', sup.length, 1);
    eq('supplies: L2・static-analysis（推定）・向き against-data', `${sup[0]?.source}/${sup[0]?.observability}/${sup[0]?.orientation}`, 'static-analysis/estimated/against-data');
    eq('supplies の端点 from = PropBindingSite（式の位置）', JSON.stringify(sup[0]?.endpoints?.from), JSON.stringify({ type: 'PropBindingSite', file: elA.file, line: elA.line, col: elA.exprCol, inComponent: 'LinA' }));
    eq('supplies の端点 to = DataAccessSite（実測の呼び出し位置）', JSON.stringify(sup[0]?.endpoints?.to), JSON.stringify({ type: 'DataAccessSite', file: callA.file, line: callA.line, col: callA.col, inComponent: 'LinA' }));
    const to = ds.nodes.find((n) => n.id === sup[0]?.to);
    ok('supplies の終点のノードから queries（server-call-stack）が SQL へ', relOf(ds, 'queries').some((h) => h.from === to?.id && h.source === 'server-call-stack'));
    ok('経路: 値 → コンポーネント（描いた）→ コンポーネント（取得）→ SQL → テーブル → カラム region', ['value', 'component', 'sql', 'table', 'column'].every((k) => kindsOf(ds).includes(k)) && ds.nodes.some((n) => n.kind === 'column' && n.identifier === 'poc.listings.region'));
    const canvas = await canvasText();
    ok('キャンバスに「由来は静的解析による推定」の語', canvas.includes('由来は静的解析による推定'), canvas.slice(0, 300));
    const drew = ds.nodes.find((n) => n.id === sup[0]?.from);
    const summary = await dockText();
    ok('右ドック: この値の出所は poc.listings . region・語は「推定」（最弱環が supplies）',
      summary.includes('この値の出所') && summary.includes('poc.listings . region') && summary.includes('推定'), summary.slice(0, 300));
    ok('右ドック: いちばん弱いところ = 由来のホップ（静的解析による推定。実行時に観測したものではない）',
      summary.includes('いちばん弱いところ') && summary.includes('ソースの静的解析による推定') && summary.includes('実行時に観測したものではありません'));
    /* 数字はステップバッジ（表示順）で選ぶ（03b 7章） */
    const D = requireLib('./derive.js');
    const laid = LIB.L.layout(ds);
    const badge = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((b) => D.nodeIdForBadge(laid, b) === drew.id);
    /* キーボードの操作は IDE の文書に向ける（直前の操作でフォーカスがプレビューの iframe に残っていることがある） */
    await page.evaluate(() => { (document.activeElement)?.blur?.(); document.body.focus(); });
    await page.keyboard.press(String(badge));
    await page.waitForFunction(() => !document.querySelector('aside.dock')?.innerText.includes('この値の出所'), null, { timeout: 5000 }).catch(() => {});
    const d = await dockText();
    ok('右ドック（描いた位置）: 「…から来ていると推定」「supplies・L2」と、取得位置', /から来ていると\**推定/.test(d) && d.includes('supplies・L2') && d.includes(`${callA.file}:${callA.line}:${callA.col}`), { badge, drew: drew.id, i: d.indexOf('SQL との関係'), tail: d.slice(d.indexOf('概要'), d.indexOf('概要') + 500) });
  }
  await shot('01-lin-a-supplies');
  await shotCanvas('01b-lin-a-supplies-canvas');
  {
    /* 7C-2（P0-2）: 選択モードを抜けた「経路を見る」状態では、浮かぶパネルを**隠さずに**測って、
     * 経路のノードと接続線がパネルに覆われていない（scripts/lib/overlap.mjs と同じ定義）。視点の移動を待つ */
    await page.waitForTimeout(700);
    eq('7C-2: 選択モードを抜けると、プレビューのページ表示を畳む', await pv().getAttribute('data-folded'), 'on');
    const cov = await page.evaluate(() => {
      const ps = [...document.querySelectorAll('.canvas > .fpnl, .canvas > .ctl')].map((p) => p.getBoundingClientRect());
      const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const nodes = [...document.querySelectorAll('g.nd')].filter((g) => {
        const r = g.getBoundingClientRect();
        return ps.some((p) => inter(r, p) / (r.width * r.height || 1) > 0.05);
      }).map((g) => g.getAttribute('aria-label'));
      const hops = [...document.querySelectorAll('g.hp')].filter((g) => {
        const path = [...g.querySelectorAll('path')].at(-1);
        const L = path.getTotalLength(); const m = path.getScreenCTM();
        for (let i = 0; i <= 12; i++) {
          const q = path.getPointAtLength((L * i) / 12);
          const x = m.a * q.x + m.c * q.y + m.e; const y = m.b * q.x + m.d * q.y + m.f;
          if (ps.some((p) => x >= p.left && x <= p.right && y >= p.top && y <= p.bottom)) return true;
        }
        return false;
      }).map((g) => g.getAttribute('aria-label'));
      return { nodes, hops };
    });
    eq('7C-2: 経路のノードが浮かぶパネルに覆われていない（パネルを隠さずに DOM の矩形で測る）', JSON.stringify(cov.nodes), '[]');
    eq('7C-2: 接続線（推定の線を含む）が浮かぶパネルに覆われていない', JSON.stringify(cov.hops), '[]');
  }

  /* ============================================ 3. 同じパスの別の文書を取り違えない */
  console.log('\n3. 同じパスの別の文書: 再読み込み・並行する同じパスの取得・前の文書の通信');
  const n0 = await loadsNow();
  await pv().locator('button[aria-label="再読み込み"]').click();
  await waitLoads(n0);
  const { e: exA2 } = await waitAttributed(run1, '/lin-a', { pick: (xs) => xs.at(-1) });
  const tokA2 = await docTokenNow();
  ok('再読み込みした文書の識別子は前の文書と別', tokA2 && tokA2 !== tokA, [tokA, tokA2]);
  const rA2 = await pick('li[data-poc-field="a-region"]', { want: 'linked' });
  eq('再読み込みの後の選択は、新しい文書の通信に同定する', Number(await pvAttr('data-doc-seq')), exA2.seq);
  ok('前の文書の通信（#' + exA.seq + '）には同定しない', exA2.seq !== exA.seq);
  /* 同じパスを、同じ文書の中から3本並行に取得（HTML。スクリプトは実行されない）。最新の同じパスの通信は別物になる */
  const par = await frame().locator('body').evaluate(async () => (await Promise.all([1, 2, 3].map(() => fetch('/lin-a', { cache: 'no-store' }).then((r) => r.status)))).join(','));
  eq('並行する同じパスの取得が3本とも 200', par, '200,200,200');
  const { o: oPar } = await waitAttributed(run1, '/lin-a', { pick: (xs) => xs.at(-1) });
  const latest = oPar.exchanges.filter((e) => e.path === '/lin-a').at(-1);
  ok('前提: 同じパスの最新の通信は、いま表示している文書ではない', latest.seq !== exA2.seq, [latest.seq, exA2.seq]);
  const rPar = await pick('li[data-poc-field="a-region"]', { want: 'linked' });
  eq('並行の後の選択も、表示中の文書の通信に同定する（パスや新しさで選ばない）', Number(await pvAttr('data-doc-seq')), exA2.seq);
  eq('並行の後も由来は同じ列', await pvAttr('data-lineage-cands'), 'poc.listings.region');
  ok('並行の後も、結びついた SQL は表示中の文書のトレースのもの', rPar.lineage.sqlSpanIds.every((id) => rPar.observation.spans.find((s) => s.spanId === id)?.traceId === LIB.A.liveExchangeLinks(rPar.observation, exA2).root?.traceId));
  /* 前の文書の通信を［表示］: 選択は並べるが、由来は結ばない（別の文書） */
  await showExchange(exA.seq);
  {
    /* 7C-1: 由来の API が返す観測は、同定した文書の通信（exA2）の証拠だけ。exA の証拠は全件の観測から取る */
    const ds = LIB.A.fromLiveRun(await obsOf(run1), exA.seq, { selection: { ...linCalls.at(-1).body, project: 'fixture', port: 0, page: { path: '/lin-a', title: '' }, resolution: rPar.resolution, selectedAt: 'T' }, binding: rPar.binding, lineage: rPar.lineage }).dataset;
    eq('前の文書の通信を並べても supplies を作らない', relOf(ds, 'supplies').length, 0);
    ok('注記: 「この要素を描いた文書は通信 #n です」', (await pv().innerText()).includes(`この要素を描いた文書は通信 #${exA2.seq} です`), (await pv().innerText()).slice(-300));
    eq('キャンバスに由来の線を引いていない（変換と同じノード数）', (await nodeLabels()).length, ds.nodes.length);
  }

  /* ============================================ 4. クライアント側の遷移は文書の取得と同一視しない */
  console.log('\n4. クライアント側の遷移（pushState）の後の選択: 文書と同定しない');
  await frame().locator('body').evaluate(() => { history.pushState({}, '', location.pathname); });
  const rSoft = await pick('li[data-poc-field="a-region"]', { want: 'cut' });
  eq('文書を同定しない（client-navigation）', await pvAttr('data-doc-binding'), 'client-navigation');
  eq('由来は結ばない・欠けた段は「文書の同定」', [await pvAttr('data-lineage'), await pvAttr('data-lineage-reason'), await pvAttr('data-lineage-stage')], ['cut', 'document-unidentified', 'document']);
  ok('パネルの行に理由（クライアント側の遷移）', (await rowText()).includes('クライアント側の遷移'), await rowText());
  eq('右ドック（7C-3）: 切れた段階は「文書の同定」・値の由来は「未確認」', [await page.locator('aside.dock [data-vo="stage"]').innerText().catch(() => ''), (await page.locator('aside.dock [data-vo="lineage"]').innerText().catch(() => '')).includes('未確認')], ['文書の同定', true]);
  {
    const ds = datasetOf(rSoft);
    eq('supplies を作らない', relOf(ds, 'supplies').length, 0);
    ok('キャンバスの切断に、欠けた段と理由', (await canvasText()).includes('文書の同定'), (await canvasText()).slice(0, 300));
    eq('validateDataset() を通過する', JSON.stringify(LIB.M.validateDataset(ds)), '[]');
  }
  await shot('02-client-navigation-cut');

  /* ============================================ 5. 否定例（PoC-04 のケース） */
  console.log('\n5. 否定例: 定数・条件分岐・候補が複数・同名の変数・同じ SQL の2か所');
  await gotoPath('/lin-g');
  await waitAttributed(run1, '/lin-g');
  await pick('p[data-poc-field="g-shadow"]', { want: 'cut' });
  eq('g-shadow（列名と同じ名前の局所変数・定数）: 結ばない（no-reference / 静的解析）', [await pvAttr('data-lineage-reason'), await pvAttr('data-lineage-stage')], ['no-reference', 'static']);
  eq('g-shadow: 文書は同定できている（切れたのは静的解析の段）', await pvAttr('data-doc-binding'), 'identified');
  ok('g-shadow: パネルとキャンバスに理由（静的解析）', (await rowText()).includes('静的解析') && (await canvasText()).includes('静的解析'));
  {
    /* 7C-3（P1-10）: 右ドックで、描画位置（実測で特定済み）と値の由来（未確認）を分け、切れた段と理由を出す */
    const vo = (k) => page.locator(`aside.dock [data-vo="${k}"]`).innerText({ timeout: 3000 }).catch(() => '');
    const render = await vo('render');
    ok('右ドック: 描画位置は「特定済み」「実測」とソース位置', render.includes('特定済み') && render.includes('実測') && render.includes('src/app/lin-g/page.tsx'), render);
    ok('右ドック: 値の由来は「未確認」', (await vo('lineage')).includes('未確認'));
    eq('右ドック: 切れた段階は「静的解析」', await vo('stage'), '静的解析');
    ok('右ドック: 理由（参照の連鎖を解けない）', (await vo('reason')).includes('参照の連鎖'), await vo('reason'));
    ok('右ドック: 見出し「この値の出所」を出さない（取得元が分かったように見せない）', !(await dockText()).includes('この値の出所'));
  }
  {
    const o = await obsOf(run1);
    const gDoc = o.exchanges.filter((e) => e.path === '/lin-g' && e.docToken).at(-1);
    eq('一覧の既定は、この選択の文書の通信（結べなかったときも、同定できた通信を選んでおく）', await obsRow().locator('select').inputValue(), String(gDoc?.seq));
  }
  await shot('03-lin-g-shadow-cut');
  await pick('p[data-poc-field="g-env"]', { want: 'cut' });
  eq('g-env（環境変数）: 結ばない', await pvAttr('data-lineage-reason'), 'no-reference');

  await gotoPath('/lin-e');
  await waitAttributed(run1, '/lin-e');
  await pick('p[data-poc-field="e-inline"]', { want: 'cut' });
  eq('e-inline（条件の判定に使った列は由来ではない）: 結ばない', await pvAttr('data-lineage-reason'), 'no-reference');
  const rE = await pick('p[data-poc-field="e-either"]', { want: 'linked' });
  eq('e-either（条件分岐）: 候補2件のまま', [await pvAttr('data-lineage-outcome'), (await pvAttr('data-lineage-cands')).split(',').sort().join(',')], ['candidates', 'poc.listings.code,poc.listings.region']);
  ok('e-either: パネルに「2 候補のいずれか」「1つに決めていません」', (await rowText()).includes('2 候補のいずれか') && (await rowText()).includes('1つに決めていません'));
  {
    const ds = datasetOf(rE);
    const h = relOf(ds, 'supplies')[0];
    eq('e-either: supplies は multiple-candidates・候補2件', `${h?.linkStatus}/${h?.candidates?.length}`, 'multiple-candidates/2');
    eq('e-either: validateDataset() を通過する', JSON.stringify(LIB.M.validateDataset(ds)), '[]');
  }
  await shot('04-lin-e-candidates');

  await gotoPath('/lin-d');
  await waitAttributed(run1, '/lin-d', { nSql: 3 });
  await pick('li[data-poc-field="d-dynamic"]', { want: 'linked' });
  eq('d-dynamic（動的なキー）: 候補4件（SQL の全列）', (await pvAttr('data-lineage-cands')).split(',').length, 4);
  const rDa = await pick('li[data-poc-field="d-same-name-a"]', { want: 'linked' });
  const rDb = await pick('li[data-poc-field="d-same-name-b"]', { want: 'linked' });
  eq('同名の変数 row を取り違えない（a → listings.code / b → regions.name）', [rDa.lineage.candidates.map((c) => `${c.table}.${c.column}`).join(), rDb.lineage.candidates.map((c) => `${c.table}.${c.column}`).join()], ['listings.code', 'regions.name']);
  eq('同名の変数: それぞれ別の pool.query（ソースの2本目・3本目）', [rDa.lineage.fetch.line, rDb.lineage.fetch.line], [truthCall('src/app/lin-d/page.tsx', 1).line, truthCall('src/app/lin-d/page.tsx', 2).line]);

  await gotoPath('/rsc-dup');
  await waitAttributed(run1, '/rsc-dup', { nSql: 2 });
  const rDup = await pick('span[data-poc-field="child"]', { want: 'linked' });
  const tC = truthCall('src/components/ListingCount.tsx');
  eq('同じ SQL 文の2か所: 子の値は子の pool.query に結ぶ（文の一致では選ばない）', rDup.lineage.fetch && `${rDup.lineage.fetch.file}:${rDup.lineage.fetch.line}:${rDup.lineage.fetch.col}`, `${tC.file}:${tC.line}:${tC.col}`);
  eq('count(*) AS n: 列は主張せずテーブルまで', [rDup.lineage.outcome, rDup.lineage.tableCandidates.map((t) => `${t.schema}.${t.name}`).join()], ['table-only', 'poc.listings']);
  const rDupP = await pick('p[data-poc-field="page"]', { want: 'linked' });
  eq('同じ SQL 文の2か所: ページの値はページの pool.query に結ぶ', rDupP.lineage.fetch?.file, 'src/app/rsc-dup/page.tsx');

  /* ============================================ 6. API の否定（画面と同じ入口） */
  console.log('\n6. 文書の知らせを偽る・別の文書・別のパス・知らせなし（API で直接）');
  phase.negativeApi = true;
  {
    const last = linCalls.at(-1).body;
    const mk = (document, selection = last.selection) => ({ run: run1, selection, document });
    const rnd = 'f'.repeat(32);
    eq('いまの起動に無い識別子 → token-not-in-session', (await callLineage(mk({ token: rnd, soft: false }))).json.binding?.reason, 'token-not-in-session');
    eq('別のパスの文書の識別子（/lin-a の文書で /rsc-dup の選択）→ path-mismatch', (await callLineage(mk({ token: tokA2, soft: false }))).json.binding?.reason, 'path-mismatch');
    eq('遷移ありと知らせた → client-navigation', (await callLineage(mk({ token: tokA2, soft: true }))).json.binding?.reason, 'client-navigation');
    eq('知らせなし → no-document-token', (await callLineage(mk(null))).json.binding?.reason, 'no-document-token');
    eq('形の違う識別子は受け付けない（400）', (await callLineage(mk({ token: 'xyz', soft: false }))).status, 400);
    const r = await callLineage(mk({ token: rnd, soft: false }));
    eq('文書を同定できなければ由来は結ばない（document の段）', [r.json.lineage?.status, r.json.lineage?.cut?.stage], ['cut', 'document']);
  }
  phase.negativeApi = false;

  /* ============================================ 7. 機密情報 */
  console.log('\n7. 中継の内部の識別子・トレース識別子・行データ・絶対パスを出さない');
  {
    const html = await frame().locator('html').evaluate((el) => el.outerHTML);
    const o = await obsOf(run1);
    ok('iframe の文書に、どの通信の中継の識別子（relayId）も無い', !o.exchanges.some((e) => e.relayId && html.includes(e.relayId)));
    ok('iframe の文書に、トレース識別子が無い', !o.exchanges.some((e) => e.trace && html.includes(e.trace.traceId)));
    eq('ブラウザに届いた応答に x-vcide-relay / x-vcide-trace が無い', pvResponses.filter((r) => r.relay || r.trace).length, 0);
    const raw = JSON.stringify(linCalls.map((c) => c.res));
    ok('由来の API に対象プロジェクト・IDE の絶対パスが無い', !raw.includes(PROJECT) && !raw.includes(REPO));
    ok('由来の API に接続文字列・DB のパスワードが無い', !/postgres(ql)?:\/\//i.test(raw) && !raw.includes('poc01_local_only'));
    ok('由来の API に行データ（物件コード・地名）が無い', !/No\.9000\d\d/.test(raw));
    ok('由来の評価にソース全文を持たない（描いている式は 90 文字まで）', linCalls.every((c) => !c.res?.lineage?.site || c.res.lineage.site.expr.length <= 90));
  }

  /* ============================================ 8. PID（実物の計装が記録しているか） */
  console.log('\n8. 実物の計装が、呼び出し位置の記録と SQL のスパンの両方に PID を記録している');
  {
    const dir = path.join(REPO, '.ide-runtime', 'spans');
    const f = fs.readdirSync(dir).map((n) => path.join(dir, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const recs = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const cs = recs.filter((r) => r.type === 'callsite' && r.target === 'sql');
    const sqlSpans = recs.filter((r) => r.type === 'span' && typeof (r.attrs?.['db.statement'] ?? r.attrs?.['db.query.text']) === 'string');
    ok(`呼び出し位置の記録 ${cs.length} 件すべてに PID がある`, cs.length > 0 && cs.every((r) => Number.isInteger(r.proc?.pid)));
    ok(`SQL のスパン ${sqlSpans.length} 本すべてに PID がある`, sqlSpans.length > 0 && sqlSpans.every((r) => Number.isInteger(r.proc?.pid)));
    const bySpan = new Map(sqlSpans.map((s) => [s.spanId, s.proc.pid]));
    ok('呼び出し位置の記録の PID は、同じスパン ID の SQL のスパンの PID と一致する', cs.every((r) => !bySpan.has(r.spanId) || bySpan.get(r.spanId) === r.proc.pid));
  }

  /* ============================================ 9. 停止・再起動 */
  console.log('\n9. 停止・再起動: 前の起動の文書を新しい起動の通信に当てない');
  const oldSel = linCalls.find((c) => c.body.selection.path === '/lin-a').body.selection;
  await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
  await waitPv('stopped', 60000);
  /* 7C-3（P1-9）: 停止後は前の選択・観測も合成デモも描かない */
  eq('停止したらキャンバスに経路を描かない（前の選択も合成デモも出さない）', await page.locator('g.nd').count(), 0);
  ok('前提: プロジェクトを開く前は合成デモを描いていた', nodesBase > 0, nodesBase);
  phase.negativeApi = true;
  eq('停止中は由来の API が観測を返さない（409）', (await callLineage({ run: run1, selection: oldSel, document: { token: tokA2, soft: false } })).status, 409);
  phase.negativeApi = false;
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  const run2 = runOf(await status());
  ok('前提: 別の起動', run2.pid !== run1.pid || run2.startedAt !== run1.startedAt);
  eq('選択は解除されている', await pvAttr('data-selection'), 'cleared');
  eq('前の起動の文書の識別子を、新しい起動では同定しない', (await callLineage({ run: run2, selection: oldSel, document: { token: tokA2, soft: false } })).json.binding?.reason, 'token-not-in-session');
  await gotoPath('/lin-a');
  const { e: exB } = await waitAttributed(run2, '/lin-a');
  await pick('li[data-poc-field="a-region"]', { want: 'linked' });
  eq('新しい起動の文書に同定し、由来を結ぶ', [Number(await pvAttr('data-doc-seq')), await pvAttr('data-lineage-cands')], [exB.seq, 'poc.listings.region']);

  ok('IDE の画面にエラーが出ていない', ideErrors.length === 0, ideErrors.slice(0, 3));
  ok('中継が原因のエラーがプレビューの中に出ていない', gatewayErrors.length === 0, gatewayErrors.slice(0, 3));
} catch (e) {
  fails.push(`例外: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  try {
    await page.evaluate(async () => {
      const s = await (await fetch('/api/runtime/status')).json();
      if (s.runtime?.state === 'running') {
        await fetch('/api/runtime/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: '{}' });
      }
    });
  } catch { /* IDE が落ちていてもよい */ }
  await browser.close();
  forwarder.close();
  killIde();
}

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
