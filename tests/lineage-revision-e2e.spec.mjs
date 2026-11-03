/* =============================================================================
 * 7C（lineage-e2e の復旧）— **由来を結んだ（linked）状態**で F-01 の版の照合が働くことを、実ブラウザ・実際の HMR・
 * 実際の PostgreSQL で確かめる。F-01 の時点では lineage-e2e が通らなかったため、この組み合わせは未確認だった
 * （docs/07c-f01-selection-revision-report.md 第6.2節「由来が依存するファイル」・第8節 1）。
 *   npm run build && npm run build:lib && PW_CHANNEL=none node tests/lineage-revision-e2e.spec.mjs
 *   RESULTS=docs/07c-lineage-recovery-results/lineage-revision-e2e.json SHOTS=docs/07c-lineage-recovery-results ... で記録を残す
 *
 * **題材は使い捨てのコピーだけを書き換える**（poc/out/lin-rev-e2e、Git 管理外）。
 *   poc/out/lin-rev-e2e/poc/fixture-app （src などを複写。node_modules はハードリンクの複写。.env も複写 — 使い捨ての DB）
 *   poc/out/lin-rev-e2e/poc/anchor      （next.config が ../anchor を読むため）
 * コピーは自分の node_modules を持つので、IDE 側の pg とは別の実体になる（＝実在のプロジェクトと同じ条件。
 * 修正前の計装では、この条件で呼び出し位置が取れず、由来がつねに切れていた。tests/callsite-entry-unit.spec.mjs）。
 *
 * 確かめること
 *   1. /lin-a の <li>{row.region}</li> を選ぶと由来を結ぶ（poc.listings.region・取得位置はソースの pool.query）
 *   2. 無関係なファイルの変更では、結んだ由来の表示を消さない
 *   3. 由来を表示している状態で、選んだ要素のファイルを変える → 選択・由来・右ドック・キャンバスの由来を消す
 *   4. HMR を止めた古い DOM から選ぶ（値の式を {row.id} に変えたソース） → 特定しない・由来を結ばない
 *      （位置だけで照合すると、新しいソースの poc.listings.id を古い DOM の値の由来として出してしまう）。
 *      HMR を戻して最新の DOM を選ぶと、最新のソースどおり poc.listings.id に結ぶ
 *   5. 由来の評価の応答（結べた）が届く前にソースが変わる → 遅れて届いた古い由来を表示しない
 *      （応答の保留・要求の保留の両方）
 *   6. 由来が切れる（未観測）ケース: 定数を描く要素は「結ばない」のまま（推測で補わない）
 * 正解はこの試験がソースを読んで決める（対応表・IDE の照合とは別の情報源）。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const SRC_FIXTURE = path.join(REPO, 'poc', 'fixture-app');
const WORK = path.join(REPO, 'poc', 'out', 'lin-rev-e2e');
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

const LIN_A = 'src/app/lin-a/page.tsx';
const LIN_G = 'src/app/lin-g/page.tsx';
const UNRELATED = 'src/app/listings/page.tsx';
const LI_REGION = '<li key={row.id} data-poc-field="a-region">{row.region}</li>';
const LI_ID = '<li key={row.id} data-poc-field="a-region">{row.id}</li>';
if (!srcOf(LIN_A).includes(LI_REGION)) throw new Error('題材の書き換えが当たりません（題材が変わった）');
/** 題材のソースから: 要素の位置（1 始まり） */
function truthEl(rel, needle) {
  const lines = srcOf(rel).split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  return `${rel}:${i + 1}:${lines[i].indexOf(needle) + 1}`;
}
/** 題材のソースから: 最初の pool.query の位置（列は query の q。V8 のスタックが指す列） */
function truthCall(rel) {
  const lines = srcOf(rel).split('\n');
  const i = lines.findIndex((l) => l.includes('pool.query('));
  return `${rel}:${i + 1}:${lines[i].indexOf('pool.query(') + 'pool.'.length + 1}`;
}
const T0 = { li: truthEl(LIN_A, '<li key={row.id}'), call: truthCall(LIN_A) };

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
/* 7C 最終（4 番の切り分けの診断。期待値には使わない）: プレビューの iframe が送った要求（RSC の再取得か）と、受け取った HMR の通知 */
const pvRequests = [];
const hmrMessages = [];
page.on('request', (r) => {
  try {
    const u = new URL(r.url());
    if (u.hostname !== PV_HOST || u.pathname.startsWith('/_next/static') || u.pathname.startsWith('/__nextjs')) return;
    const h = r.headers();
    pvRequests.push({ t: Date.now(), method: r.method(), path: u.pathname, rsc: h.rsc ?? null, rscQuery: u.searchParams.has('_rsc'), dest: h['sec-fetch-dest'] ?? null });
  } catch { /* 記録だけ */ }
});
page.on('websocket', (ws) => {
  ws.on('framereceived', (f) => {
    const t = typeof f.payload === 'string' ? f.payload : '';
    const m = /"(?:action|type)"\s*:\s*"([^"]+)"/.exec(t);
    if (m && !/^(?:ping|pong)$/i.test(m[1])) hmrMessages.push({ t: Date.now(), kind: m[1], head: t.slice(0, 100) });
  });
});
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
async function expectLineageGone(label, col) {
  const d = await dockText();
  const c = await canvasText();
  const labels = await nodeLabels();
  ok(`${label}: パネルの由来の状態を消す（data-lineage が linked でない）`, (await sel('data-lineage')) !== 'linked', await snapshot());
  ok(`${label}: 右ドックに「この値の出所」を出さない`, !d.includes('この値の出所'), d.slice(0, 400));
  ok(`${label}: キャンバスに「由来は静的解析による推定」を出さない`, !c.includes('由来は静的解析による推定'), c.slice(0, 300));
  ok(`${label}: キャンバスに前の由来のカラム（${col}）のノードを残さない`, !labels.some((l) => (l ?? '').includes(col)), labels);
}
async function expectInvalidated(label, old, col) {
  const cleared = await until(async () => (await sel('data-selection')) === 'cleared', 15000);
  ok(`${label}: 選択を無効にする（data-selection=cleared）`, cleared, await snapshot());
  eq(`${label}: 解除の理由は source-changed`, await sel('data-sel-cleared'), 'source-changed');
  const t = await pv().innerText().catch(() => '');
  ok(`${label}: 「コードが変更されたため…もう一度選択」の理由を出す`, /コードが変更された/.test(t) && /もう一度選択/.test(t), t.slice(0, 300));
  ok(`${label}: 右ドックに前の要素の位置（${old}）を残さない`, !(await dockText()).includes(old), (await dockText()).slice(0, 400));
  await expectLineageGone(label, col);
}

const results = { startedAt: new Date().toISOString(), project: path.relative(REPO, PROJECT) };
try {
  const db = await dbReachable();
  ok('前提: 題材の DB（使い捨ての PostgreSQL）に届く', db === null, db);
  ok('前提: コピーの pg は IDE 側の pg と別の実体（実在のプロジェクトと同じ条件）',
    fs.realpathSync(path.join(PROJECT, 'node_modules', 'pg')) !== fs.realpathSync(path.join(SRC_FIXTURE, 'node_modules', 'pg')));

  /* ============================================ 0. 起動 */
  console.log('\n0. 使い捨ての題材を起動する（計装・呼び出し位置の記録・要素識別子の注入）');
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
  await gotoPath('/lin-a');
  ok('前提: HMR の WebSocket を転送役で中継できている', hmr.sockets >= 1, { sockets: hmr.sockets });
  ok('前提: /lin-a は DB の値（region）を描いている', (await frameText('li[data-poc-field="a-region"]')).length === 3, await frameText('li[data-poc-field="a-region"]'));
  const COL = 'poc.listings.region';

  /* ============================================ 1. 由来を結ぶ */
  console.log('\n1. /lin-a の <li>{row.region}</li> を選ぶ → 由来を結ぶ');
  {
    const r = await pick(frame().locator('li[data-poc-field="a-region"]').first(), { want: 'linked' });
    eq('1 選択の位置 = ソースの <li>', r.at, T0.li);
    eq('1 由来を結んだ（linked）・候補 = poc.listings.region', [r.lineage, r.cands], ['linked', COL]);
    const last = linResponses.at(-1);
    eq('1 由来の評価の応答: 取得位置（DataAccessSite）= ソースの pool.query（server-call-stack）', last?.fetch, T0.call);
    ok('1 由来の評価の応答: 結びついた SQL のスパンがある（この文書の通信で観測）', (last?.sqlSpanIds ?? []).length >= 1, last);
    eq('1 由来の評価の応答: 照合した要素はいまの選択と同じ', last?.resolution?.at, T0.li);
    await selectMode(false);                       // 「経路を見る」状態（lineage-e2e と同じ流れ）
    await page.waitForTimeout(700);
    const s = await lineageShown(COL);
    ok('1 右ドック: 「この値の出所」と poc.listings . region', s.dock, (await dockText()).slice(0, 400));
    ok('1 キャンバス: 「由来は静的解析による推定」', s.canvasWord);
    ok('1 キャンバス: カラム poc.listings.region のノード', s.canvasColumn, await nodeLabels());
    results.linked = last;
    await shot('lin-rev-1-linked');
  }

  const COL_ID = 'poc.listings.id';
  const LI = () => frame().locator('li[data-poc-field="a-region"]').first();
  /** 開発サーバーを停止・起動し直す。同じ起動の中でサーバー側のコードが HMR で差し替わった後は、
   * 実行中のコードの位置がディスクの生成物と一致せず呼び出し位置を戻せない（第4節で実測）ため、
   * 「新しいソースで正しく結ぶ」ことは起動し直して確かめる */
  async function restartDev(label) {
    await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
    await waitPv('stopped', 60000);
    await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
    await waitPv('live');
    await until(async () => Number(await sel('data-conn')) >= 1, 60000);
    const s = await status();
    devPort = s.runtime.port;
    note(`${label}: 開発サーバーを再起動した`);
    await gotoPath('/lin-a');
  }

  /* ============================================ 2. 遅れて届く「結べた」応答 */
  console.log('\n2. 由来の評価（結べた）の応答が画面に届く前に、選んだ要素のファイルが変わる');
  {
    const h = hold('lineage', 'response');
    await selectMode(true);
    await LI().click();
    await h.arrivedP;
    let held = null;
    try { held = JSON.parse(h.body.toString('utf8')).lineage?.status ?? null; } catch { held = null; }
    eq('前提: 止めた応答は「結べた」（linked。サーバーは変更の前に評価した）', held, 'linked');
    eq('前提: 選択は解決済み（版の確かめが動く）', await sel('data-selection'), 'resolved');
    put(LIN_A, `${srcOf(LIN_A)}\n// comment only ${Date.now()}\n`);
    note(`由来の評価の応答を止めている間に ${LIN_A} にコメントを足した`);
    const cleared = await until(async () => (await sel('data-selection')) === 'cleared', 15000);
    ok('2 版の確かめで選択を無効にする', cleared, await snapshot());
    h.release();
    await sleep(2000);
    ok('2 遅れて届いた古い「結べた」応答で、選択も由来も復活させない', (await sel('data-selection')) === 'cleared' && (await sel('data-lineage')) !== 'linked', await snapshot());
    await expectLineageGone('2 遅れて届いた応答の後', COL);
    restore(LIN_A);
    await sleep(1500);
    await restartDev('2 の後');
  }

  /* ============================================ 3. 無関係なファイルの変更 */
  console.log('\n3. 由来を表示している状態で、無関係なファイルを変える');
  {
    const r = await pick(LI(), { want: 'linked' });
    eq('前提: 由来を結んだ', [r.lineage, r.cands], ['linked', COL]);
    await selectMode(false);
    await page.waitForTimeout(700);
    put(UNRELATED, `${srcOf(UNRELATED)}\n// unrelated edit ${Date.now()}\n`);
    note(`${UNRELATED}（選択とは無関係のファイル）を書き換えた`);
    await sleep(5000);
    eq('3 選択を解除しない', await sel('data-selection'), 'resolved');
    const s = await lineageShown(COL);
    ok('3 由来の表示（パネル・右ドック・キャンバス）を保つ', s.attr && s.dock && s.canvasWord && s.canvasColumn, s);
    restore(UNRELATED);
    await sleep(1500);
  }

  /* ============================================ 4. 選んだ要素のファイルを変える */
  console.log('\n4. 由来を表示している状態で、選んだ要素のファイル（取得の呼び出しも同じファイル）を変える');
  {
    eq('前提: 由来を表示している', (await lineageShown(COL)).attr, true);
    const tEdit4 = Date.now();
    /* 7C 最終: 変更をコメントだけ（＋すぐ元に戻す）にすると、生成されるコードが変わらず、サーバー側の HMR（eval）も RSC の再取得も
     * 起きないことがある（docs/07c-hmr-final-safety-report.md 第5節。基準のコミットでも 4 番の前半が失敗した原因）。
     * 生成されるコードが変わる文を末尾に足し（要素・取得の位置も値の式も変えない）、4 番が終わるまで元に戻さない。
     * そのうえで「HMR が実際に起きた」ことを、ブラウザの RSC の再取得とサーバーの eval の印で前提として確かめる */
    put(LIN_A, `${srcOf(LIN_A)}\nconst __hmrProbe = ${Date.now()};\nvoid __hmrProbe;\n`);
    note(`${LIN_A} の末尾に、生成されるコードが変わる文を足した（要素の位置も値の式も取得の位置も変えない）`);
    await expectInvalidated('4 結んだ由来', T0.li, COL);
    await shot('lin-rev-4-invalidated');
    const refetched = await until(() => pvRequests.some((q) => q.t >= tEdit4 && q.path === '/lin-a' && (q.rsc || q.rscQuery)), 30000);
    ok('4 前提: HMR が実際に起きた（変更の後に、プレビューが /lin-a の RSC の再取得を送った）', refetched,
      { hmr: hmrMessages.filter((m) => m.t >= tEdit4).map((m) => m.kind), requests: pvRequests.filter((q) => q.t >= tEdit4) });
    await sleep(2500);
    /* HMR で描き直された DOM は、記録した文書の取得が描いたものとは限らない（同じパスの RSC の再取得がある）。
     * そのため前の文書の通信の SQL を結ばない（7B-3B-2 の規則 refetched-after-document） */
    const r = await pick(LI(), { want: 'cut' });
    {
      /* 診断（期待値には使わない）: 変更の後に、ブラウザが HMR の通知を受けたか・RSC の再取得を送ったか・IDE がそれを観測したか */
      const st = await status();
      const ob = await page.evaluate(async ({ run }) => {
        const x = await fetch('/api/runtime/observations', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: JSON.stringify({ run, detail: 'all' }) });
        return x.status === 200 ? (await x.json()).observation : null;
      }, { run: { instance: st.runtime.instance, pid: st.runtime.pid, startedAt: st.runtime.startedAt } }).catch(() => null);
      const after = (xs) => xs.filter((x) => x.t >= tEdit4).map((x) => ({ ...x, t: `+${x.t - tEdit4}ms` }));
      note(`4 診断: 変更の後に受けた HMR の通知 ${JSON.stringify(after(hmrMessages).map((m) => `${m.t} ${m.kind}`))}`);
      note(`4 診断: 変更の後にプレビューが送った要求 ${JSON.stringify(after(pvRequests).map((q) => `${q.t} ${q.method} ${q.path}${q.rsc ? ' RSC' : ''}${q.rscQuery ? ' ?_rsc' : ''}`))}`);
      note(`4 診断: IDE が観測した通信（変更の後） ${JSON.stringify((ob?.exchanges ?? []).filter((e) => e.startMs >= tEdit4 - 200).map((e) => `#${e.seq} ${e.kind} ${e.path} +${Math.round(e.startMs - tEdit4)}ms`))}・文書の同定 ${await sel('data-doc-binding')}`);
      results.step4Diagnosis = { hmr: after(hmrMessages), requests: after(pvRequests), exchanges: (ob?.exchanges ?? []).filter((e) => e.startMs >= tEdit4 - 200).map((e) => ({ seq: e.seq, kind: e.kind, path: e.path, dt: Math.round(e.startMs - tEdit4) })) };
    }
    eq('4 HMR の後の DOM を選ぶ: 前の文書の通信には同定しない（refetched-after-document）・由来を結ばない', [r.selection, await sel('data-doc-binding'), r.lineage], ['resolved', 'refetched-after-document', 'cut']);
    /* 同じ起動のまま読み込み直す: 文書は同定できるが、HMR の後の SQL の呼び出し位置は戻せない（既知の制約・未観測として扱う） */
    await gotoPath('/lin-a');
    const r2 = await pick(LI(), { want: 'cut' });
    const lr = linResponses.at(-1);
    const own = lr?.dataAccess ?? [];
    note(`同じ起動のまま読み込み直した: 文書 ${await sel('data-doc-binding')}・由来 ${r2.lineage}（${r2.lineageReason}）・呼び出し位置の特定 ${[...new Set(own.map((d) => d.failure ?? d.site))].join(' / ')}`);
    eq('4 同じ起動でコードを変えた後: 文書は同定する', await sel('data-doc-binding'), 'identified');
    /* 7C（HMR 安全対策・案A）で期待値を変えた（承認済み。docs/07c-hmr-lineage-guard-report.md 第5節）。
     * 変更前: 由来の理由 fetch-not-measured・呼び出し位置の理由 no-app-frame（ずれた先がたまたまデータ取得の行ではなかった＝偶然の未観測）。
     * 変更後: 呼び出し位置の理由は hmr-evaluated-code（HMR で eval されたコードのフレームを計装が印付けし、照合が拒む）、
     *         由来の理由は fetch-callsite-unverifiable（SQL は観測したが呼び出し位置を確かめられない）。結ばない・候補なしは同じ */
    eq('4 同じ起動でコードを変えた後: 実測との照合で切れる（fetch-callsite-unverifiable）。推測で結ばない', [r2.lineage, r2.lineageReason, r2.cands ?? ''], ['cut', 'fetch-callsite-unverifiable', '']);
    ok('4 その理由は「HMR で eval されたコードが SQL を実行した」（hmr-evaluated-code。ディスクの生成物・ソースマップとの対応を確かめられない）', own.length > 0 && own.every((d) => (d.failure ?? '').startsWith('hmr-evaluated-code')), own);
    ok('4 右ドックに「この値の出所」を出さない（前の由来も出さない）', !(await dockText()).includes('この値の出所'));
    results.sameRunAfterChange = lr;
    restore(LIN_A);
    await sleep(1500);
    await restartDev('4 の後');
  }

  /* ============================================ 5. HMR を止めた古い DOM から選ぶ（値の式が変わった） */
  console.log('\n5. ソースの値の式を {row.id} に変え、HMR の前の古い DOM（region を描いている）から選ぶ');
  {
    const r0 = await pick(LI(), { want: 'linked' });
    eq('前提: 由来を結んだ（region）', [r0.lineage, r0.cands], ['linked', COL]);
    freeze();
    const loads = await loadsNow();
    put(LIN_A, srcOf(LIN_A).replace(LI_REGION, LI_ID));
    note(`${LIN_A}: ${LI_REGION} → ${LI_ID}（同じ行・列・同じタグ・同じコンポーネント）`);
    const code = await compileNow('/lin-a');
    note(`開発サーバーに直接 /lin-a を要求して変換を起こした（HTTP ${code}）。プレビューへの HMR は止めている`);
    await expectInvalidated('5 既存の選択（結んだ由来）', T0.li, COL);
    const before = await frameText('li[data-poc-field="a-region"]');
    ok('前提: プレビューの DOM はまだ前の版（region の文字列）', before.length === 3 && before.every((t) => !/^\d+$/.test(t)), before);
    const r = await pick(LI());
    eq('前提: その間にプレビューは読み込み直していない', await loadsNow(), loads);
    ok('前提: クリックの時点でも DOM は前の版', (await frameText('li[data-poc-field="a-region"]')).every((t) => !/^\d+$/.test(t)));
    ok('5 古い DOM の要素を、同じ行・列の新しい要素として特定しない', r.selection !== 'resolved', r);
    eq('5 理由は source-changed', r.reason, 'source-changed');
    ok('5 由来を結ばない（新しいソースの poc.listings.id を古い DOM の値の由来にしない）', r.lineage !== 'linked' && !(r.cands ?? '').includes(COL_ID), r);
    const d = await dockText();
    ok('5 右ドックに poc.listings.id も「この値の出所」も出さない', !d.includes('この値の出所') && !d.includes('listings . id'), d.slice(0, 400));
    await expectLineageGone('5 古い DOM の選択', COL_ID);
    await shot('lin-rev-5-stale-dom');
    thaw();
    ok('前提: HMR を戻すと新しい DOM（id の数字）', await until(async () => (await frameText('li[data-poc-field="a-region"]')).every((t) => /^\d+$/.test(t)), 30000));
    const h = await pick(LI(), { want: 'cut' });
    eq('5 HMR の後の最新の DOM: 要素は最新のソースの位置に特定し、前の文書の SQL は結ばない', [h.selection, h.at, await sel('data-doc-binding'), h.lineage], ['resolved', T0.li, 'refetched-after-document', 'cut']);
    await restartDev('5（{row.id} のまま）');
    ok('前提: 起動し直した DOM も id の数字', (await frameText('li[data-poc-field="a-region"]')).every((t) => /^\d+$/.test(t)));
    const n = await pick(LI(), { want: 'linked' });
    eq('5 新しいソースの要素を選ぶと、新しいソースどおり poc.listings.id に結ぶ', [n.lineage, n.cands], ['linked', COL_ID]);
    eq('5 取得位置は同じ pool.query（ソースの位置）', linResponses.at(-1)?.fetch, T0.call);
    results.linkedAfterChange = linResponses.at(-1);
    await selectMode(false);
    await page.waitForTimeout(700);
    const s = await lineageShown(COL_ID);
    ok('5 右ドック・キャンバスも poc.listings.id（新しいソースの由来）', s.dock && s.canvasColumn, s);
    /* キャンバスのカラムのノードは「実行された SQL の SELECT 句の列」（id・region の両方。実測）なので、region のノードは残ってよい。
     * 前の由来が残っていないことは、右ドックの「この値の出所」が region を言わないことで確かめる */
    {
      const d = await dockText();
      const head = d.slice(d.indexOf('この値の出所'), d.indexOf('この値の出所') + 120);
      ok('5 右ドックの「この値の出所」は poc.listings . id で、前の由来（region）を言わない', head.includes('listings . id') && !head.includes('region'), head);
    }
    await shot('lin-rev-5-relinked-id');
    restore(LIN_A);
    await sleep(1500);
    await restartDev('5 の後（元に戻した）');
  }

  /* ============================================ 6. 由来の評価の要求の途中でソースが変わる */
  console.log('\n6. 由来の評価の要求がサーバーに届く前に、選んだ要素のファイルが変わる');
  {
    const h2 = hold('lineage', 'request');
    await selectMode(true);
    await LI().click();
    await h2.arrivedP;
    put(LIN_A, `${srcOf(LIN_A)}\n// comment only ${Date.now()}\n`);
    note(`由来の評価の要求を止めている間に ${LIN_A} にコメントを足した`);
    await sleep(300);
    const m = linResponses.length;
    h2.release();
    await until(() => linResponses.length > m, 15000);
    await sleep(1500);
    const lr = linResponses.at(-1);
    note(`止めた要求の応答: 由来 ${lr?.lineage ?? '-'}・照合 ${lr?.resolution?.status ?? '-'}（${lr?.resolution?.reason ?? '-'}）`);
    eq('6 サーバーは要素を照合し直し、版が変わったので特定しない（unresolved・source-changed）', [lr?.resolution?.status, lr?.resolution?.reason], ['unresolved', 'source-changed']);
    ok('6 変更の後に評価した由来を、前の選択に付けない', (await sel('data-lineage')) !== 'linked' && (await sel('data-selection')) !== 'resolved', await snapshot());
    await expectLineageGone('6', COL);
    restore(LIN_A);
    await sleep(2500);
  }

  /* ============================================ 7. 由来が未観測で切れるケース */
  console.log('\n7. 由来を結べない要素（同名の局所変数）は「結ばない」のまま');
  {
    await gotoPath('/lin-g');
    const r = await pick(frame().locator('[data-poc-field="g-shadow"]').first(), { want: 'cut' });
    eq('7 由来は切れたまま（cut）', r.lineage, 'cut');
    ok('7 候補を出さない', !r.cands, r);
    const d = await dockText();
    ok('7 右ドック: 値の由来は「未確認」・「この値の出所」を出さない', d.includes('未確認') && !d.includes('この値の出所'), d.slice(0, 400));
    void LIN_G;
  }

  eq('IDE の画面にエラーが出ていない', JSON.stringify(ideErrors), '[]');
  note(`転送役で上流に届かなかった要求: ${upstreamErrors.length} 件 ${JSON.stringify(upstreamErrors.slice(0, 5))}`);
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
console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
