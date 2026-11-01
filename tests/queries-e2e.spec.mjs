/* =============================================================================
 * Phase 7B-3B-1 — Server Component の実行時に起きた SQL を、それを実行したデータ取得の呼び出し位置
 * （DataAccessSite）へ `queries` で結ぶ。**クラウドの開発環境を模した**実ブラウザで端から端まで確かめる
 * （模し方は observe-e2e / select-e2e と同じ。転送役・ホスト名・IDE の起動方法をそのまま使う）。
 *   npm run build && npm run build:lib && node tests/queries-e2e.spec.mjs
 *   SHOTS=docs/07b3b1-screenshots node tests/queries-e2e.spec.mjs
 *
 * 前提: 題材 poc/fixture-app が使う使い捨ての PostgreSQL（poc/README.md）。**DB が無ければ失敗にする**
 *   （SQL を実行していないのに「位置を特定できた」とは言えないため。skip にもしない）。
 *
 * **正解はこの試験が題材のソースを読んで決める**（IDE の照合とは別の情報源）:
 *   SQL 文（取得時点でリテラルを $0 に置き換えたもの）と同じ文を `pool.query('…')` に書いた行・列、
 *   その行の上で最も近い `function 名前` の宣言（大文字で始まればコンポーネント）。
 *   同じ文が2か所にあれば正解の候補は2つで、**文の一致だけでは決まらない**ことも確かめる。
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
const MARK = 'DUMMY-SECRET-7B3B1-E2E';

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);
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
const IDE_PORT = await freePort(3800);
const GW_PORT = await freePort(3860);
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
const FWD_PORT = await freePort(3920);
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
  const r = await fetch('/api/runtime/observations', { method: 'POST', headers: h, body: JSON.stringify({ run }) });
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
  console.log('\n✗ この試験は DB 無しでは意味が無い（SQL を実行していないのに位置を特定できたとは言えない）。VCIDE_E2E_NO_DB を外してください');
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

try {
  /* ============================================ 1. 起動する。呼び出し位置の記録と中継の識別子が有効になる */
  console.log('\n1. fixture-app を起動する（計装つき）。呼び出し位置の記録（POC02_CALLSITE）と中継の識別子が有効');
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
  eq('要素識別子の注入も有効（囲むコンポーネントの第2の情報源）', st1.runtime.anchors?.state, 'enabled');
  {
    const envs = groupPids(st1.runtime.pid).map(environOf).filter(Boolean);
    const has = (kv) => envs.some((e) => e.split('\0').includes(kv));
    ok('起動先に POC02_CALLSITE=1 を渡した（PoC-02 の計装をそのまま使う）', has('POC02_CALLSITE=1'), envs.length);
    ok('起動先に POC07_RELAY_ID=1 を渡した（受付スパンに中継の識別子を写す）', has('POC07_RELAY_ID=1'));
    ok('サーバー内部の fetch の計装（POC02_UNDICI）は渡していない（今回の範囲外）', !envs.some((e) => e.includes('POC02_UNDICI=')));
  }
  await page.waitForFunction(() => ['none', 'some'].includes(document.querySelector('.pvobsrow')?.getAttribute('data-obs-state') ?? ''), null, { timeout: 30000 });
  {
    const o = await obsOf(run1);
    eq('観測に呼び出し位置の記録の状態がある（有効）', o?.callsite?.enabled, true);
    eq('照合器（PoC-02 の rscattr.mjs）を読み込める', o?.callsite?.resolver?.available, true);
    eq('中継が開発サーバーへ書き足すヘッダは x-vcide-relay だけ', JSON.stringify(o?.session.writtenRequestHeaders), '["x-vcide-relay"]');
    eq('中継が読むヘッダは 7B-3A のまま', JSON.stringify([o?.session.readRequestHeaders, o?.session.readResponseHeaders]), JSON.stringify([['sec-fetch-dest', 'rsc'], ['x-vcide-trace']]));
  }

  /* ============================================ 2. 実際の RSC ページ: /rsc-db */
  console.log('\n2. /rsc-db（Server Component が pool.query で直接読む）: SQL を実行した呼び出し位置を特定する');
  await gotoPath('/rsc-db');
  const { o: o2, e: ex2, l: l2 } = await waitAttributed(run1, '/rsc-db');
  ok('文書の取得を中継が記録した', !!ex2, o2?.exchanges.map((e) => e.path));
  ok('中継の識別子（16進32桁）を持つ', /^[0-9a-f]{32}$/.test(ex2?.relayId ?? ''), ex2?.relayId);
  eq('通信 → 受付スパンは中継の識別子で結んだ（relay-id）', l2?.basis, 'relay-id');
  eq('受付スパンが中継の識別子を受け取っていた', l2?.root?.attrs['vcide.relay.id'], ex2?.relayId);
  eq('応答の専用ヘッダのトレース識別子も同じ受付スパンを指す（食い違いなし）', `${ex2?.trace?.traceId}/${ex2?.trace?.spanId}`, `${l2?.root?.traceId}/${l2?.root?.spanId}`);
  eq('サーバー処理はページの描画スパン（ルート単位）', l2?.server?.attrs['next.span_type'], 'AppRender.getBodyResult');
  eq('描画スパンの子孫に SQL を1本', l2?.sql.length, 1);
  const sql2 = l2?.sql[0];
  const d2 = sql2 ? daOf(o2, sql2) : null;
  const truth2 = sql2 ? truthSites(SQL_TEXT(sql2), ['src/app/rsc-db/page.tsx']) : [];
  eq('正解（ソースから）: 候補は1つ', truth2.length, 1);
  ok('呼び出し位置を特定した（理由なし）', !!d2?.site && !d2.failure, d2?.failure);
  eq('呼び出し位置 = 試験がソースから決めた行・列', d2?.site && `${d2.site.file}:${d2.site.line}:${d2.site.col}`, truth2[0] && `${truth2[0].file}:${truth2[0].line}:${truth2[0].col}`);
  eq('囲むコンポーネント = ソースの関数宣言', d2?.site?.component.name, truth2[0]?.component);
  ok('読み直した行に pool.query がある', /pool\.query\(/.test(d2?.site?.sourceLine ?? ''), d2?.site?.sourceLine);
  eq('照合の記録は SQL のスパンと同じトレース', d2?.traceId, sql2?.traceId);
  eq('呼び出しの入口は pg-pool の Pool.query', d2?.at, 'pg-pool.Pool.query');
  ok('通った照合を7つ持つ（記録1件・PoC-02 の4段・注入範囲・実行後の書き換えなし）', d2?.checks.length === 7, d2?.checks);
  {
    const { dataset } = LIB.A.fromLiveRun(o2, ex2.seq);
    eq('validateDataset() を通過する（いまの起動の実データ）', JSON.stringify(LIB.M.validateDataset(dataset)), '[]');
    eq('ノード: 通信・サーバー処理・呼び出し位置・SQL・テーブル・カラム×3（id / code / plan）',
      kindsOf(dataset).join(','), 'http,server,component,sql,table,column,column,column');
    const q = relOf(dataset, 'queries');
    const x = relOf(dataset, 'executes');
    eq('queries を1本', q.length, 1);
    eq('queries の取得手段は server-call-stack（L1相当・実測）', `${q[0]?.source}/${q[0]?.observability}`, 'server-call-stack/measured');
    eq('queries の始点は DataAccessSite（列まで）', JSON.stringify(q[0]?.endpoints?.from), JSON.stringify({ type: 'DataAccessSite', file: truth2[0].file, line: truth2[0].line, col: truth2[0].col, inComponent: truth2[0].component }));
    eq('queries はコンポーネントのノードから SQL のノードへ', `${dataset.nodes.find((n) => n.id === q[0]?.from)?.kind}->${dataset.nodes.find((n) => n.id === q[0]?.to)?.kind}`, 'component->sql');
    eq('executes は別にある（サーバー処理 → SQL、trace-span）', `${dataset.nodes.find((n) => n.id === x[0]?.from)?.kind}/${x[0]?.source}`, 'server/trace-span');
    eq('executes と queries は同じ SQL への別々の観測（shared-object）', [q[0]?.to === x[0]?.to, q[0]?.convergence, x[0]?.convergence].join(','), 'true,shared-object,shared-object');
    ok('supplies / derives / maps / binds / requests を作らない', !dataset.hops.some((h) => ['supplies', 'derives', 'maps', 'binds', 'requests'].includes(h.relation)));
    ok('表示された値のノードは作らない', !dataset.nodes.some((n) => n.kind === 'value'));
    ok('呼び出し位置のノードに「結果の行き先は未確認」の切断', dataset.cuts.some((c) => c.from === q[0]?.from && c.head.includes('未確認')));
    ok('帰属の範囲（どの描画インスタンスかは同定しない）を出す', dataset.nodes.find((n) => n.id === q[0]?.from)?.overview.some((r) => r.v === LIB.M.ATTRIBUTION_SCOPE_NOTE.definitionOnly));
  }
  await showExchange(ex2.seq);
  {
    const labels = await nodeLabels();
    const n = (t) => labels.filter((l) => l.startsWith(t)).length;
    eq('キャンバス: コンポーネント（呼び出し位置）1・実行SQL 1', `${n('コンポーネント')}/${n('実行SQL')}`, '1/1');
    eq('一覧の行: 呼び出し位置を特定した SQL の本数を出す', Number(await obsAttr('data-obs-sites')) >= 1, true);
    ok('観測の行に「実行した呼び出し位置を特定」', (await obsRow().innerText()).includes('実行した呼び出し位置を特定'));
    const compId = LIB.A.fromLiveRun(o2, ex2.seq).dataset.nodes.find((x) => x.kind === 'component').id;
    await page.keyboard.press(String(compId));
    const d = await dockText();
    ok('右ドック: 取得手段（サーバー側でデータ取得の呼び出し時に記録したスタック）', d.includes('サーバー側でデータ取得の呼び出し時に記録したスタック'), d.slice(0, 400));
    ok('右ドック: 呼び出し位置（行・列・ファイル）', d.includes(`${truth2[0].file}:${truth2[0].line}:${truth2[0].col}`));
    ok('右ドック: 主張の範囲（結果がどの値になったかは確認していない）', d.includes('この SQL の結果が画面のどの値になったかは確認していません'));
  }
  await shot('01-rsc-db-queries');
  await shotCanvas('01b-rsc-db-queries-canvas');

  /* ============================================ 3. 同じ SQL 文を2か所から: /rsc-dup */
  console.log('\n3. /rsc-dup（同じ SQL 文をページ本体と子のコンポーネントが実行）: 文の一致ではなくスタックで分ける');
  await gotoPath('/rsc-dup');
  const { o: o3, e: ex3, l: l3 } = await waitAttributed(run1, '/rsc-dup', { nSql: 2 });
  eq('SQL を2本（同じ文）', [l3?.sql.length, new Set(l3?.sql.map(SQL_TEXT)).size].join('/'), '2/1');
  const truth3 = l3?.sql[0] ? truthSites(SQL_TEXT(l3.sql[0]), ['src/app/rsc-dup/page.tsx', 'src/components/ListingCount.tsx']) : [];
  eq('正解（ソースから）: 同じ文が2か所にある＝文の一致だけでは決まらない', truth3.length, 2);
  {
    const got = l3.sql.map((sp) => daOf(o3, sp)?.site).map((s) => s && `${s.file}:${s.line}:${s.col}:${s.component.name}`);
    eq('2本とも位置を特定し、別々の位置になった', [got.every(Boolean), new Set(got).size].join('/'), 'true/2');
    eq('2つの位置 = ソースの2か所（ページ本体と ListingCount）', [...got].sort().join(' | '), truth3.map((t) => `${t.file}:${t.line}:${t.col}:${t.component}`).sort().join(' | '));
    const { dataset } = LIB.A.fromLiveRun(o3, ex3.seq);
    eq('validateDataset() を通過する', JSON.stringify(LIB.M.validateDataset(dataset)), '[]');
    eq('queries 2本・呼び出し位置のノード2つ', `${relOf(dataset, 'queries').length}/${dataset.nodes.filter((n) => n.kind === 'component').length}`, '2/2');
    ok('各 queries は別の SQL のノードへ', new Set(relOf(dataset, 'queries').map((h) => h.to)).size === 2);
  }
  await showExchange(ex3.seq);
  await shotCanvas('02-rsc-dup-two-sites-canvas');

  /* ============================================ 4. 並列の3本: /rsc-parallel */
  console.log('\n4. /rsc-parallel（Promise.all で3本）: それぞれの行へ');
  await gotoPath('/rsc-parallel');
  const { o: o4, l: l4 } = await waitAttributed(run1, '/rsc-parallel', { nSql: 3 });
  eq('SQL を3本', l4?.sql.length, 3);
  for (const sp of l4?.sql ?? []) {
    const t = truthSites(SQL_TEXT(sp), ['src/app/rsc-parallel/page.tsx']);
    const s = daOf(o4, sp)?.site;
    eq(`${SQL_TEXT(sp).slice(-26)} → ソースのその文の行・列`, s && `${s.line}:${s.col}`, t.length === 1 ? `${t[0].line}:${t[0].col}` : `候補 ${t.length}`);
  }

  /* ============================================ 5. 断定しない: コンポーネントでない関数・Prisma */
  console.log('\n5. 断定しない: コンポーネントでない関数の中（/rsc-helper）・入口を包んでいないドライバ（Prisma）');
  await gotoPath('/rsc-helper');
  const { o: o5, e: ex5, l: l5 } = await waitAttributed(run1, '/rsc-helper');
  {
    const d = l5?.sql[0] ? daOf(o5, l5.sql[0]) : null;
    const t = l5?.sql[0] ? truthSites(SQL_TEXT(l5.sql[0]), ['src/app/rsc-helper/page.tsx']) : [];
    eq('正解（ソースから）: 囲む関数はコンポーネントではない（loadScaleCounts）', `${t[0]?.fn}/${t[0]?.component}`, 'loadScaleCounts/null');
    eq('位置を断定しない（component-not-agreed）', d?.failure?.reason, 'component-not-agreed');
    eq('site は無い', d?.site ?? null, null);
    eq('戻した位置は参考として持つ（行は正解と同じ）', d?.located && `${d.located.file}:${d.located.line}`, t[0] && `${t[0].file}:${t[0].line}`);
    const { dataset } = LIB.A.fromLiveRun(o5, ex5.seq);
    eq('queries を作らない・コンポーネントのノードも作らない', `${relOf(dataset, 'queries').length}/${dataset.nodes.filter((n) => n.kind === 'component').length}`, '0/0');
    ok('SQL の詳細に「特定していません」と理由・参考の位置', dataset.nodes.find((n) => n.kind === 'sql').overview.some((r) => r.k === '実行した呼び出し位置' && r.v.startsWith('特定していません') && r.v.includes('関係は作っていません')));
    eq('validateDataset() を通過する', JSON.stringify(LIB.M.validateDataset(dataset)), '[]');
  }
  await gotoPath('/listings');
  const { o: o6, e: ex6, l: l6 } = await waitAttributed(run1, '/api/listings');
  {
    const d = l6?.sql[0] ? daOf(o6, l6.sql[0]) : null;
    eq('Prisma の SQL: 呼び出しの入口のスタックが無い（no-entry-callsite）', d?.failure?.reason, 'no-entry-callsite');
    const { dataset } = LIB.A.fromLiveRun(o6, ex6.seq);
    eq('Prisma の SQL には queries を作らない', relOf(dataset, 'queries').length, 0);
    eq('コンポーネントのノードを作らない（7B-3A の表示のまま）', dataset.nodes.filter((n) => n.kind === 'component').length, 0);
  }

  /* ============================================ 6. 同じパスへの並行要求を取り違えない */
  console.log('\n6. 同じパス（/rsc-dup）へ6本を同時に送る: 通信・トレース・SQL・呼び出し位置を取り違えない');
  const before6 = new Set((await obsOf(run1)).exchanges.map((e) => e.seq));
  const statuses = await frame().locator('body').evaluate(async () => Promise.all(Array.from({ length: 6 }, () => fetch('/rsc-dup', { cache: 'no-store' }).then((r) => r.status))));
  eq('6本とも 200', statuses.join(','), '200,200,200,200,200,200');
  let o7 = null;
  let par = [];
  for (let i = 0; i < 150; i++) {
    o7 = await obsOf(run1);
    par = o7.exchanges.filter((e) => e.path === '/rsc-dup' && !before6.has(e.seq));
    const ls = par.map((e) => LIB.A.liveExchangeLinks(o7, e));
    if (par.length >= 6 && ls.every((l) => l.sql.length === 2 && l.sql.every((sp) => daOf(o7, sp)))) break;
    await sleep(400);
  }
  eq('中継は6本を別々に記録した', par.length, 6);
  {
    const overlap = par.filter((a) => par.some((b) => b !== a && a.startMs < b.startMs + (b.durationMs ?? 0) && b.startMs < a.startMs + (a.durationMs ?? 0))).length;
    console.log(`    （中継の記録で、区間が他の要求と重なった要求: ${overlap} / 6）`);
    ok('前提: 実際に並行していた（区間が重なる要求がある）', overlap >= 2, overlap);
    const ls = par.map((e) => LIB.A.liveExchangeLinks(o7, e));
    eq('中継の識別子は6本とも別', new Set(par.map((e) => e.relayId)).size, 6);
    eq('6本とも中継の識別子で受付スパンに結んだ', ls.filter((l) => l.basis === 'relay-id').length, 6);
    eq('受付スパンは6本とも別（トレースも別）', `${new Set(ls.map((l) => l.root?.spanId)).size}/${new Set(ls.map((l) => l.root?.traceId)).size}`, '6/6');
    ok('各通信の受付スパンは、その通信の中継の識別子を受け取っていた', par.every((e, i) => ls[i].root?.attrs['vcide.relay.id'] === e.relayId));
    const allSql = ls.flatMap((l) => l.sql.map((s) => s.spanId));
    eq('SQL は12本で、どの SQL も1つの通信にしか属さない', `${allSql.length}/${new Set(allSql).size}`, '12/12');
    ok('各通信の SQL は、その通信のトレースの中だけ', ls.every((l) => l.sql.every((s) => s.traceId === l.root.traceId)));
    const want = truth3.map((t) => `${t.file}:${t.line}:${t.col}`).sort().join('|');
    ok('各通信で、2本の SQL がページ本体と ListingCount の2つの位置へ（6本とも）', ls.every((l) => l.sql.map((sp) => daOf(o7, sp)?.site).map((s) => s && `${s.file}:${s.line}:${s.col}`).sort().join('|') === want));
    ok('照合の記録のトレースは、それぞれの SQL のトレース', ls.every((l) => l.sql.every((sp) => daOf(o7, sp)?.traceId === sp.traceId)));
    for (const e of par) eq(`#${e.seq}: validateDataset() を通過`, JSON.stringify(LIB.M.validateDataset(LIB.A.fromLiveRun(o7, e.seq).dataset)), '[]');

    /* 付け替えの評価（実データを複製して、応答ヘッダだけを同じパスの別の要求のものにする） */
    const [A, B] = par;
    const swapped = { ...o7, exchanges: o7.exchanges.map((e) => (e.seq === A.seq ? { ...e, trace: B.trace } : e)) };
    const lsw = LIB.A.liveExchangeLinks(swapped, swapped.exchanges.find((e) => e.seq === A.seq));
    eq('応答ヘッダを同じパスの別の要求のものに付け替えると、7B-3B-1 の規則は結ばない', lsw.server, null);
    ok('理由: 中継の識別子の受付スパンと食い違う', /食い違います/.test(lsw.reason ?? ''), lsw.reason);
    const legacy = { ...swapped, exchanges: swapped.exchanges.map((e) => (e.seq === A.seq ? { ...e, relayId: undefined } : e)) };
    const lleg = LIB.A.liveExchangeLinks(legacy, legacy.exchanges.find((e) => e.seq === A.seq));
    ok('比較: 7B-3A の規則（応答ヘッダ＋パスの照合）だけなら、別の要求（B）に付け替えたまま結んでしまう', lleg.basis === 'trace-header' && lleg.root?.spanId === ls[1].root.spanId, lleg);
    console.log('    → 7B-3A の規則は同じパスの付け替えを検出できない。中継の識別子を足した規則は検出して結ばない');
  }

  /* ---- ページのスクリプトが中継の識別子を偽っても通らない */
  {
    const fake = 'f'.repeat(32);
    const before = new Set((await obsOf(run1)).exchanges.map((e) => e.seq));
    await frame().locator('body').evaluate(async (v) => { await fetch('/rsc-db', { cache: 'no-store', headers: { 'x-vcide-relay': v } }); }, fake);
    let e = null; let o = null;
    for (let i = 0; i < 80; i++) {
      o = await obsOf(run1);
      e = o.exchanges.find((x) => x.path === '/rsc-db' && !before.has(x.seq)) ?? null;
      if (e && LIB.A.liveExchangeLinks(o, e).root) break;
      await sleep(300);
    }
    ok('ページのスクリプトが送った x-vcide-relay は転送されず、中継の値に置き換わる', e && e.relayId !== fake && LIB.A.liveExchangeLinks(o, e).root?.attrs['vcide.relay.id'] === e.relayId, e?.relayId);
    ok('偽の値を受け取った受付スパンは無い', !o.spans.some((s) => s.attrs['vcide.relay.id'] === fake));
  }
  eq('ブラウザに届いた応答に x-vcide-relay / X-Vcide-Trace が無い', pvResponses.filter((r) => r.relay || r.trace).length, 0);

  /* ============================================ 7. 選択した要素と、SQL を実行した位置を並べる（結ばない） */
  console.log('\n7. /rsc-db の要素を選び、同じパスの通信を表示する: React のソースと SQL の呼び出し位置を並べ、値と SQL は結ばない');
  await gotoPath('/rsc-db');
  await pv().locator('.rt-b', { hasText: '選択' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-agent-mode') === 'on', null, { timeout: 15000 });
  const nCalls = anchorCalls.length;
  await frame().locator('li').first().click({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-selection') === 'resolved', null, { timeout: 30000 });
  for (let i = 0; i < 50 && !(anchorCalls.length > nCalls && anchorCalls.at(-1).res); i++) await sleep(100);
  const selAt = await pv().getAttribute('data-sel-at');
  {
    const lines = SRC('src/app/rsc-db/page.tsx');
    const li = lines.findIndex((l) => /<li\b/.test(l));
    eq('選択した要素の React ソース = ソースの <li> の行・列', selAt, `src/app/rsc-db/page.tsx:${li + 1}:${lines[li].indexOf('<li') + 1}`);
  }
  await pv().locator('.rt-b', { hasText: '選択' }).click();     // 選択モードを抜ける（選択は残る）
  const { o: o8, e: ex8 } = await waitAttributed(run1, '/rsc-db');
  await showExchange(ex8.seq);
  eq('観測の表示に、選択した要素を並べた', await obsAttr('data-obs-with-sel'), 'on');
  eq('選択の行は残る（解除していない）', await pv().getAttribute('data-selection'), 'resolved');
  ok('「両者は結んでいません」の注記', (await pv().innerText()).includes('両者は結んでいません'));
  {
    const call = anchorCalls.at(-1);
    const input = {
      project: st1.runtime.project?.name ?? '—', port: st1.runtime.port ?? 0,
      page: { path: call.body.selection.path, title: '' },
      selection: call.body.selection, resolution: call.res.resolution, selectedAt: new Date().toISOString(),
    };
    const { dataset } = LIB.A.fromLiveRun(o8, ex8.seq, { selection: input });
    eq('validateDataset() を通過する（選択＋観測）', JSON.stringify(LIB.M.validateDataset(dataset)), '[]');
    const labels = await nodeLabels();
    eq('キャンバスのノード数 = 変換のノード数（画面と同じ変換）', labels.length, dataset.nodes.length);
    const value = dataset.nodes.find((n) => n.kind === 'value');
    const comps = dataset.nodes.filter((n) => n.kind === 'component');
    eq('コンポーネントのノードは2つ（描いた位置と、SQL を実行した位置）', comps.length, 2);
    const drew = comps.find((n) => n.source === 'element-anchor');
    const ran = comps.find((n) => n.source === 'server-call-stack');
    eq('描いた位置（element-anchor）と実行した位置（server-call-stack）は別のノード', `${drew?.identifier} / ${ran?.identifier}`, `${selAt.split(':').slice(0, 2).join(':')} / ${truth2[0].file}:${truth2[0].line}`);
    eq('同じコンポーネント定義（RscDb）の中にある', `${drew?.chipSub}/${ran?.chipSub}`, 'RscDb/RscDb');
    const touching = (id) => dataset.hops.filter((h) => h.from === id || h.to === id).map((h) => h.relation).sort().join(',');
    eq('選択した値に触れる関係は renders だけ', touching(value.id), 'renders');
    eq('描いた位置のコンポーネントに触れる関係は renders だけ（SQL へ線を引かない）', touching(drew.id), 'renders');
    eq('実行した位置のコンポーネントに触れる関係は queries だけ', touching(ran.id), 'queries');
    ok('supplies / derives / maps / binds を作らない', !dataset.hops.some((h) => ['supplies', 'derives', 'maps', 'binds'].includes(h.relation)));
    ok('描いた位置から「この値の由来は未確認です」の切断', dataset.cuts.some((c) => c.from === drew.id && c.head === 'この値の由来は未確認です'));
    ok('描いた位置の詳細: 同じ定義の中にあることは根拠にしていない', drew.overview.some((r) => r.k === 'SQL との関係' && r.v.includes('同じ定義の中にあることは根拠にしていません')));
    ok('選択した値の詳細: この要素を描いた文書取得がこの通信かは特定していない', value.overview.some((r) => r.k === '通信との関係' && r.v.includes('特定していません')));
    await page.keyboard.press(String(drew.id));
    ok('右ドック（描いた位置）: 同じ定義の中にあることは根拠にしていない', (await dockText()).includes('同じ定義の中にあることは根拠にしていません'));
    await shot('03-selection-and-site');
    await shotCanvas('03b-selection-and-site-canvas');
    await page.keyboard.press(String(ran.id));
    ok('右ドック（実行した位置）: 呼び出し位置と主張の範囲', (await dockText()).includes(`${truth2[0].file}:${truth2[0].line}:${truth2[0].col}`));
    await shotCanvas('04-site-selected-canvas');
  }

  /* ============================================ 8. 機密情報を取得しない */
  console.log('\n8. SQL のパラメータ・行データ・トークン・Cookie・絶対パスを返さない');
  {
    await frame().locator('body').evaluate((_, m) => { document.cookie = `vcide_e2e=${m}-COOKIE; path=/`; }, MARK);
    const raw = (await fetchObs(run1)).text;
    ok('観測の API に Cookie の印・接続文字列・DB のパスワードが無い', !raw.includes(MARK) && !/postgres(ql)?:\/\//i.test(raw) && !raw.includes('poc01_local_only'));
    ok('観測の API に対象プロジェクト・IDE の絶対パスが無い', !raw.includes(PROJECT) && !raw.includes(REPO) && !raw.includes('.ide-runtime'));
    ok('観測の API に行データ（物件コード）が無い', !/No\.9000\d\d/.test(raw));
    ok('観測の API に呼び出しスタックのフレームそのもの（生成物のパス）を出さない', !raw.includes('.next/dev/server/chunks'));
    const o = JSON.parse(raw).observation;
    ok('SQL にパラメータの値が無い（LIMIT の数値も除去）', o.spans.every((s) => !/LIMIT \d/.test(SQL_TEXT(s))));
    ok('照合の結果に持つのは位置・1行・関数名・コンポーネント名だけ', o.dataAccess.every((d) => Object.keys(d).sort().join(',') === 'at,checks,failure,located,site,spanId,traceId'
      && (!d.site || Object.keys(d.site).sort().join(',') === 'col,component,file,functionName,line,sourceLine')));
  }

  /* ============================================ 9. 停止・再起動で古い観測を混ぜない */
  console.log('\n9. 停止・再起動: 前の起動の SQL・呼び出し位置の照合を混ぜない');
  const old = await obsOf(run1);
  const oldSql = new Set(old.dataAccess.map((d) => d.spanId));
  await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
  await waitPv('stopped', 60000);
  eq('停止したらキャンバスは元のデータセット（ノード数）', await page.locator('g.nd').count(), nodesBase);
  eq('停止中は観測を返さない', await staleOf(run1), '200/null/stale-run');
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  const run2 = runOf(await status());
  ok('前提: 別の起動', run2.pid !== run1.pid || run2.startedAt !== run1.startedAt);
  eq('前の起動を指す要求には観測を返さない', await staleOf(run1), '200/null/stale-run');
  await page.waitForFunction(() => ['none', 'some'].includes(document.querySelector('.pvobsrow')?.getAttribute('data-obs-state') ?? ''), null, { timeout: 30000 });
  {
    const fresh = await obsOf(run2);
    ok('新しい起動の観測に、前の起動の照合結果が無い', fresh.dataAccess.every((d) => !oldSql.has(d.spanId)));
    ok('呼び出し位置の記録の数は新しい収集ファイルのものだけ（前の起動の分を数えない）', fresh.callsite.records < old.callsite.records, [fresh.callsite.records, old.callsite.records]);
    await gotoPath('/rsc-db');
    const { o, l } = await waitAttributed(run2, '/rsc-db');
    const d = l?.sql[0] ? daOf(o, l.sql[0]) : null;
    eq('新しい起動でも同じ位置を特定する（新しい記録から）', d?.site && `${d.site.file}:${d.site.line}:${d.site.col}`, `${truth2[0].file}:${truth2[0].line}:${truth2[0].col}`);
    ok('その SQL は前の起動のものではない', !oldSql.has(l.sql[0].spanId));
  }

  ok('IDE の画面にエラーが出ていない', ideErrors.length === 0, ideErrors.slice(0, 3));
  ok('中継が原因のエラー（CSP・差し込んだスクリプト）がプレビューの中に出ていない', gatewayErrors.length === 0, gatewayErrors.slice(0, 3));
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
