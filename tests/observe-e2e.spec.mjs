/* =============================================================================
 * Phase 7B-3A — いまの起動で観測した HTTP・サーバー処理・SQL を、既存のキャンバスと右ドックに出す。
 * **クラウドの開発環境を模した**実ブラウザで端から端まで確かめる（模し方は preview-e2e / select-e2e と同じ）。
 *   npm run build && npm run build:lib && node tests/observe-e2e.spec.mjs
 *   SHOTS=docs/07b3a-screenshots node tests/observe-e2e.spec.mjs
 *
 * 前提: 題材 poc/fixture-app が使う使い捨ての PostgreSQL（poc/README.md）。DB が無いと SQL は実行されない。
 *   DB に届かなければ **失敗にする**（SQL の観測を確かめていないのに通過させない）。
 *   DB 無しで回すと明示する場合だけ VCIDE_E2E_NO_DB=1（SQL の節を skip として数える）。
 *
 * 正解はこの試験が**題材のソースを読んで**決める（IDE の解析とは別の情報源）。
 *   /api/listings  … Prisma の select { id, code, region }
 *   /lin-g         … SELECT code, region … ORDER BY id（id は結果列ではない — Phase 6F）
 * 画面の操作で行う。API を直接叩くのは、観測の中身の検査と否定の確認だけである。
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
const MARK = 'DUMMY-SECRET-7B3A-E2E';

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
const IDE_PORT = await freePort(3600);
const GW_PORT = await freePort(3660);
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
const FWD_PORT = await freePort(3720);
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
/** ブラウザに届いた中継の応答ヘッダ（トレース識別子が漏れていないかを見る） */
const pvResponses = [];
page.on('response', (r) => {
  if (!r.url().startsWith(`http://${PV_HOST}`)) return;
  const h = r.headers();
  pvResponses.push({ url: r.url(), trace: h['x-vcide-trace'] ?? null, timing: h['server-timing'] ?? null });
});

if (!LIB) {
  console.log('\n⊘ .libjs が無い（npm run build:lib を先に）。全件 skip');
  process.exit(0);
}
const dbProblem = await dbReachable();
if (dbProblem && !NO_DB) {
  console.log(`\n✗ 題材の DB に届きません（${dbProblem}）。poc/README.md の手順で使い捨ての PostgreSQL を用意してください。`);
  console.log('  SQL の観測を確かめずに通過させないため、失敗にします。DB 無しで回すなら VCIDE_E2E_NO_DB=1。');
  killIde(); browser.close(); forwarder.close();
  process.exit(1);
}

try {
  /* ============================================ 1. 起動する。観測セッションが新しく作られる */
  console.log('\n1. fixture-app を起動する（計装つき）。観測セッションが起動ごとに作られる');
  await page.goto(`http://${IDE_HOST}/`, { waitUntil: 'networkidle' });
  const nodesBase = await page.locator('g.nd').count();
  const noticeBase = await page.locator('.note.synth').innerText();
  await rtPanel().locator('#rt-path').fill(PROJECT);
  await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((p) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === p, PROJECT, { timeout: 20000 });
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  const st1 = await status();
  const run1 = runOf(st1);
  eq('計装は有効', st1.runtime.instrumentation.state, 'enabled');
  await page.waitForFunction(() => ['none', 'some'].includes(document.querySelector('.pvobsrow')?.getAttribute('data-obs-state') ?? ''), null, { timeout: 30000 });
  ok('既存のプレビューパネルに観測の行が出る', await obsRow().count() === 1);
  eq('観測の行は 7B-2 の選択の行のクラス（.pvsel / .pvselrow）を使わない（7B-2 の操作と取り違えない）', await pv().locator('.pvsel, .pvselrow').count(), 0);
  const o1 = await obsOf(run1);
  ok('観測セッションはこの起動の後に作られた', o1 && Date.parse(o1.session.startedAt) >= Date.parse(run1.startedAt), o1?.session);
  ok('最初のページの読み込み（/）が、いまの起動の通信として現れる', o1?.exchanges.some((e) => e.path === '/'), o1?.exchanges);
  /* http の転送ホストは「信頼できる origin」ではないので、Chrome は Sec-Fetch-* を送らない。
   * そのとき種類は推測せず unknown になる（https の Codespaces なら document になるはず — 未検証） */
  ok('種類は Sec-Fetch-Dest があれば document、無ければ unknown（推測しない）', o1?.exchanges.filter((e) => e.path === '/').every((e) => e.kind === 'document' || e.kind === 'unknown'), o1?.exchanges.map((e) => e.kind));
  /* 7C-3（P1-9）: 実行中・選択前は合成デモも描かない（「まだ経路がありません」） */
  eq('観測は自動では描かない（経路はまだ無い。合成デモも描かない）', JSON.stringify([await page.locator('g.nd').count(), await page.locator('.cv-empty').getAttribute('data-project-phase')]), JSON.stringify([0, 'running']));
  ok('前提: プロジェクトを開く前は合成デモを描いていた', nodesBase > 0, nodesBase);
  eq('中継は IDE の生存確認を描かない（中継を通らない処理は数だけ）', o1.exchanges.every((e) => e.startMs >= Date.parse(o1.session.startedAt)), true);

  /* ============================================ 2. 実行中のアプリから新しい HTTP・SQL を観測する */
  console.log('\n2. プレビューで /listings を開く → 新しい HTTP・サーバー処理・SQL を観測する');
  await gotoPath('/listings');
  const { o: o2, e: apiEx } = await waitExchange(run1, '/api/listings', { sql: !NO_DB });
  ok('ページのスクリプトが送った /api/listings を、中継が記録した', !!apiEx, o2?.exchanges);
  ok('種類はスクリプトからの通信（fetch）か、ヘッダが無ければ unknown', ['fetch', 'unknown'].includes(apiEx?.kind), apiEx?.kind);
  eq('HTTP の状態（開発サーバーの応答）', apiEx?.status, 200);
  ok('応答の専用ヘッダからトレース識別子を読んだ', /^[0-9a-f]{32}$/.test(apiEx?.trace?.traceId ?? ''), apiEx?.trace);
  ok('中継の記録の時刻は、この起動の後', apiEx && apiEx.startMs >= Date.parse(run1.startedAt));
  {
    const fixed = fs.readdirSync(path.join(REPO, 'src', 'data')).map((f) => fs.readFileSync(path.join(REPO, 'src', 'data', f), 'utf8')).join('\n');
    ok('トレース識別子は PoC の記録済みデータ（src/data）に無い（固定データを実測のふりで出していない）', apiEx?.trace && !fixed.includes(apiEx.trace.traceId));
  }
  const links = apiEx ? LIB.A.liveExchangeLinks(o2, apiEx) : null;
  ok('トレース識別子が指すスパンが、いまの起動の収集ファイルにある（通信 → サーバー処理）', !!links?.root, links?.reason);
  eq('サーバー処理はルート単位の処理のスパン（Route Handler）', links?.server?.attrs['next.span_type'], 'AppRouteRouteHandlers.runHandler');
  ok('サーバー処理は同じトレースの中（トレース識別子の一致）', links?.server?.traceId === apiEx?.trace?.traceId);
  if (NO_DB) { skip('SQL を観測する'); skip('SQL のテーブル・結果列'); } else {
    eq('この処理の子孫の SQL を1本観測した', links?.sql.length, 1);
    const a = o2.sqlAnalyses.find((x) => x.spanId === links?.sql[0]?.spanId);
    ok('SQL は Prisma が実行した文（パラメータは取得時点で除去）', a && /FROM "poc"\."listings"/.test(a.sql) && !/\b900\d{3}\b/.test(a.sql), a?.sql);
    eq('テーブル（構文解析）', a?.tables.map((t) => `${t.schema}.${t.name}`).join(','), 'poc.listings');
    eq('結果列 = 題材のソースの select { id, code, region }', a?.projections.map((p) => p.column).sort().join(','), 'code,id,region');
  }

  /* ---------------------------------------------- 3. 既存のキャンバスと右ドックに出す */
  console.log('\n3. 既存のキャンバス・右ドックに、取得手段・観測性・証拠つきで出す');
  await showExchange(apiEx.seq);
  {
    const labels = await nodeLabels();
    const n = (t) => labels.filter((l) => l.startsWith(t)).length;
    eq('通信のノード', n('通信'), 1);
    eq('サーバー処理のノード', n('サーバー処理'), 1);
    if (NO_DB) { skip('SQL・テーブル・カラムのノード'); } else {
      eq('実行SQLのノード', n('実行SQL'), 1);
      eq('テーブルのノード', n('テーブル'), 1);
      eq('カラムのノード（結果列の3つ）', n('カラム'), 3);
    }
    eq('表示された値・コンポーネントのノードは作らない（7B-3B の範囲）', n('表示された値') + n('コンポーネント'), 0);
    ok('キャンバスの注記は「いまの起動の実測」', (await page.locator('.note.synth').innerText()).includes('いまの起動の実測'));
    ok('キャンバスに上流の切断（結んでいない）を出す', (await page.locator('.canvas').innerText()).includes('ここより上流は結んでいません'));
    const d = await dockText();
    ok('右ドック: サーバー処理の取得手段（計装が生成したスパン）', d.includes('計装が生成したスパン'), d.slice(0, 500));
    ok('右ドック: 主張の範囲（どのコンポーネントが実行したかは観測していない）', d.includes('どのコンポーネント・どの行が SQL を実行したかは観測していません'));
    ok('右ドック: 観測性は「実測」', d.includes('実測'));
  }
  await shot('01-observed-api');
  await page.keyboard.press('1');
  {
    const d = await dockText();
    ok('通信の取得手段は中継の記録（ブラウザ自身の記録ではないと書く）', d.includes('IDE のプレビュー中継が転送した通信の記録（ブラウザ自身の記録ではありません）'), d.slice(0, 600));
    ok('通信の開始元は結んでいないと書く（7B-3B）', d.includes('結んでいません'));
  }
  await page.getByRole('tab', { name: '根拠' }).click();
  {
    const d = await dockText();
    ok('根拠タブ: 取得手段の名前（中継の記録）', d.includes('IDE のプレビュー中継が転送した通信の記録'), d.slice(0, 600));
  }
  await page.getByRole('tab', { name: '概要' }).click();
  {
    // ノード・ホップの検査は、画面と同じ変換を Node で回して行う（同じ関数・同じ入力）
    const { dataset } = LIB.A.fromLiveRun(o2, apiEx.seq);
    eq('validateDataset() を通過する（いまの起動の実データ）', JSON.stringify(LIB.M.validateDataset(dataset)), '[]');
    const h = dataset.hops.find((x) => x.relation === 'handles');
    eq('通信 → サーバー処理は trace-context（トレース識別子の一致）', h?.source, 'trace-context');
    ok('時間の重なりで結んでいない', !dataset.hops.some((x) => x.source === 'time-window'));
    ok('requests / derives / maps / supplies を作らない', !dataset.hops.some((x) => ['requests', 'derives', 'maps', 'supplies', 'binds'].includes(x.relation)));
    eq('通信ノードの取得手段は preview-relay（L0・実測）', `${dataset.nodes[0].source}/${dataset.nodes[0].observability}`, 'preview-relay/measured');
    if (!NO_DB) {
      ok('テーブル・カラムは構文解析（sql-ast-parse）だけで作る', dataset.nodes.filter((x) => x.kind === 'table' || x.kind === 'column').every((x) => x.source === 'sql-ast-parse'));
      ok('カラムの型は「未取得」と書く（情報スキーマに照会していない）', dataset.nodes.filter((x) => x.kind === 'column').every((x) => x.overview.some((r) => r.v.includes('未取得'))));
    }
  }

  /* ---------------------------------------------- 4. Phase 6F の射影解析を維持する（実データ） */
  console.log('\n4. ORDER BY だけで使う列を結果列にしない（Phase 6F）・SQL が多い処理');
  await gotoPath('/lin-g');
  const { o: o4, e: linG } = await waitExchange(run1, '/lin-g', { sql: !NO_DB });
  ok('/lin-g の種類はページの取得か unknown（推測しない）', ['document', 'unknown'].includes(linG?.kind), linG?.kind);
  if (NO_DB) { skip('ORDER BY id を射影にしない'); skip('SQL が多い処理'); } else {
    const l = LIB.A.liveExchangeLinks(o4, linG);
    eq('サーバー処理はページの描画スパン', l.server?.attrs['next.span_type'], 'AppRender.getBodyResult');
    const a = o4.sqlAnalyses.find((x) => x.spanId === l.sql[0]?.spanId);
    eq('結果列 = SELECT code, region（ORDER BY id の id は入らない）', a?.projections.map((p) => p.column).join(','), 'code,region');
    ok('id は「SELECT句の外で参照」として残す（隠さない）', a?.unresolved.some((u) => u.column === 'id' && u.why === 'referenced-outside-select-list'), a?.unresolved);
    await showExchange(linG.seq);
    const labels = await nodeLabels();
    ok('キャンバスに id のカラムを描かない', !labels.some((x) => x.startsWith('カラム') && /\.id$/.test(x)) && labels.filter((x) => x.startsWith('カラム')).length === 2, labels);
    await shot('02-phase6f-order-by');

    await gotoPath('/lin-d');
    const { o: o5, e: linD } = await waitExchange(run1, '/lin-d');
    const l5 = LIB.A.liveExchangeLinks(o5, linD);
    eq('/lin-d の描画の下で SQL を3本観測した', l5.sql.length, 3);
    const { dataset } = LIB.A.fromLiveRun(o5, linD.seq);
    eq('validateDataset() を通過する（SQL 3本・同じテーブルへ複数の reads）', JSON.stringify(LIB.M.validateDataset(dataset)), '[]');
    ok('同じテーブルへの複数の reads は shared-object（合流ではない）', dataset.hops.filter((h) => h.relation === 'reads' && h.to === dataset.nodes.find((n) => n.identifier === 'poc.listings')?.id).every((h) => h.convergence === 'shared-object'));
    ok('描かない SQL は数と理由を書く（観測はしている）', dataset.nodes.find((n) => n.kind === 'server').overview.some((r) => r.k === '描いていない SQL' && r.v.startsWith('1 本')));
  }

  /* ---------------------------------------------- 5. 機密情報を保存しない・ブラウザに識別子を渡さない */
  console.log('\n5. クエリの値・Cookie・本文・接続文字列を保存しない。トレース識別子をブラウザに渡さない');
  await frame().locator('body').evaluate((_, m) => { document.cookie = `vcide_e2e=${m}-COOKIE; path=/`; localStorage.setItem('k', `${m}-LS`); }, MARK);
  await gotoPath(`/listings?token=${MARK}-QUERY`);
  const { o: o6, e: q } = await waitExchange(run1, '/listings', { sql: false });
  ok('クエリ文字列は「付いていた」だけを残す', q?.hasQuery === true && q.path === '/listings', q);
  {
    const raw = (await fetchObs(run1)).text;
    ok('観測の API にクエリの値・Cookie・localStorage の印が無い', !raw.includes(MARK), raw.match(new RegExp(`.{40}${MARK}.{20}`))?.[0]);
    ok('観測の API に接続文字列・DB のパスワードが無い', !/postgres(ql)?:\/\//i.test(raw) && !raw.includes('poc01_local_only'));
    ok('観測の API に Cookie / Authorization のヘッダ名が無い', !/"cookie"|"authorization"/i.test(raw));
    ok('観測の API に収集ファイルの絶対パスが無い', !raw.includes('.ide-runtime'));
    ok('観測の API に応答本文（物件コード）が無い', !/No\.9000\d\d/.test(raw));
    ok('SQL にパラメータの値が無い（LIMIT の数値も除去）', o6.spans.every((s) => !/LIMIT \d/.test(String(s.attrs['db.statement'] ?? s.attrs['db.query.text'] ?? ''))));
    eq('中継が読むヘッダは決めたものだけ', JSON.stringify([o6.session.readRequestHeaders, o6.session.readResponseHeaders]), JSON.stringify([['sec-fetch-dest', 'rsc'], ['x-vcide-trace']]));
  }
  ok('前提: ブラウザは中継の応答を受けている', pvResponses.length > 5, pvResponses.length);
  eq('ブラウザに届いた応答に X-Vcide-Trace が無い（中継が読んで落とす）', pvResponses.filter((r) => r.trace).length, 0);
  eq('ブラウザに届いた応答に Server-Timing の traceparent が無い', pvResponses.filter((r) => /traceparent/.test(r.timing ?? '')).length, 0);
  {
    const seen = await frame().locator('body').evaluate(() => performance.getEntriesByType('resource').concat(performance.getEntriesByType('navigation'))
      .flatMap((e) => (e.serverTiming ?? []).map((t) => t.description)).filter((d) => /00-[0-9a-f]{32}/.test(d)).length);
    eq('ページの中のスクリプトはトレース識別子を読めない（Resource Timing）', seen, 0);
  }

  /* ---------------------------------------------- 6. 停止・再起動で混ざらない */
  console.log('\n6. 停止すると観測の表示を消す。再起動すると新しいセッションになり、前の起動の観測は返らない');
  if (!NO_DB) await showExchange(apiEx.seq);
  else await showExchange(o1.exchanges[0].seq);
  const traces1 = new Set((await obsOf(run1)).exchanges.map((e) => e.trace?.traceId).filter(Boolean));
  await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
  await waitPv('stopped', 60000);
  eq('停止したら観測の行は出さない', await obsRow().count(), 0);
  ok('停止したら「実測中ではありません」と書く', (await pv().innerText()).includes('実測中ではありません'), await pv().innerText());
  eq('停止したらキャンバスに経路を描かない（前の観測も合成デモも出さない）', await page.locator('g.nd').count(), 0);
  eq('停止したらキャンバスの注記はプロジェクトの空の状態（合成デモの注記に戻さない）', await page.locator('.note.synth').getAttribute('data-notice'), 'project-empty');
  ok('停止したら注記は合成デモのものではない', (await page.locator('.note.synth').innerText()) !== noticeBase);
  eq('停止中は観測を返さない（observation: null・理由 stale-run）', await staleOf(run1), '200/null/stale-run');
  await shot('03-stopped');

  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  const run2 = runOf(await status());
  ok('前提: 別の起動', run2.pid !== run1.pid || run2.startedAt !== run1.startedAt);
  await page.waitForFunction(() => ['none', 'some'].includes(document.querySelector('.pvobsrow')?.getAttribute('data-obs-state') ?? ''), null, { timeout: 30000 });
  eq('前の起動を指す要求には観測を返さない（stale-run）', await staleOf(run1), '200/null/stale-run');
  const o7 = await obsOf(run2);
  ok('新しいセッション（開始時刻が違う）', o7 && o7.session.startedAt !== o1.session.startedAt);
  ok('新しいセッションに前の起動の通信が無い', o7.exchanges.every((e) => !traces1.has(e.trace?.traceId)) && o7.exchanges.every((e) => e.startMs >= Date.parse(run2.startedAt)), o7.exchanges);
  eq('再起動直後はキャンバスに前の観測が残っていない（合成デモも描かない）', await page.locator('g.nd').count(), 0);
  ok('新しい観測の一覧に前の起動の通信が無い（/lin-d など）', !(await obsRow().innerText()).includes('/lin-d'));

  /* ---------------------------------------------- 7. 計装なしの起動: 情報が無ければ未観測と書く */
  console.log('\n7. 計装なしで起動すると、サーバー処理・SQL は未観測と書き、捏造しない');
  await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
  await waitPv('stopped', 60000);
  await rtPanel().locator('label.rt-ck input').uncheck();
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  const st3 = await status();
  eq('前提: 計装なし', st3.runtime.instrumentation.state, 'disabled');
  const run3 = runOf(st3);
  await gotoPath('/listings');
  const { o: o8, e: noIns } = await waitExchange(run3, '/api/listings', { sql: false });
  ok('通信は観測する（中継の記録）', !!noIns);
  eq('トレース識別子は無い（計装が付けない）', noIns?.trace ?? null, null);
  await page.waitForFunction(() => /観測していません/.test(document.querySelector('.pvobsrow')?.textContent ?? ''), null, { timeout: 10000 });
  ok('観測の行に「サーバー処理・SQL は観測していません」', (await obsRow().innerText()).includes('サーバー処理・SQL は観測していません'));
  await showExchange(noIns.seq);
  {
    const labels = await nodeLabels();
    eq('サーバー処理・SQL のノードを作らない', labels.filter((x) => !x.startsWith('通信')).length, 0);
    await page.keyboard.press('1');
    ok('通信の詳細に「サーバー処理: 結んでいません — 理由」', (await dockText()).includes('結んでいません — 計装が有効ではありません'));
    const { dataset } = LIB.A.fromLiveRun(o8, noIns.seq);
    eq('validateDataset() を通過する（計装なし）', JSON.stringify(LIB.M.validateDataset(dataset)), '[]');
    eq('ホップは0本（時間の重なりで結ばない）', dataset.hops.length, 0);
  }
  await shot('04-uninstrumented');
  await rtPanel().locator('label.rt-ck input').check().catch(() => {});

  eq('IDE の画面にエラーが出ていない', JSON.stringify(ideErrors), '[]');
  eq('中継が原因のエラー（CSP・差し込んだスクリプト）がプレビューの中に出ていない', JSON.stringify(gatewayErrors), '[]');
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

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗${skipped ? ` / ${skipped} 件 skip` : ''}`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
