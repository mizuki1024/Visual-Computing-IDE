/* =============================================================================
 * F-01（06h 独立レビュー）— 探索モードの選択で、コード変更前の選択・DOM・応答を、変更後の別の要素へ
 * 黙って対応付けないことを、実ブラウザ・実際の HMR で確かめる。
 *   npm run build && npm run build:lib && PW_CHANNEL=none node tests/select-revision-e2e.spec.mjs
 *   RESULTS=docs/07c-f01-results/e2e-fixed.json SHOTS=docs/07c-f01-results ... で記録を残す
 *
 * **題材は使い捨てのコピーだけを書き換える。** poc/fixture-app をそのまま使わず、
 *   poc/out/f01-e2e/poc/fixture-app （src などを複写。node_modules はハードリンクの複写）
 *   poc/out/f01-e2e/poc/anchor      （いまの poc/anchor の複写。next.config が ../anchor を読むため）
 * に作り、そこを IDE で起動して、ソースを書き換える（poc/out は Git 管理外）。
 *
 * 模している環境・IDE の起動・転送役は tests/select-e2e.spec.mjs と同じ。
 * HMR の WebSocket は転送役の CONNECT で中継する。`hmr.frozen` の間は開発サーバーからの知らせを
 * ページへ渡さず貯める（＝ソースは変わったが、プレビューの DOM はまだ前の版のまま、を作る）。
 *
 * 正解はこの試験が**ソースを自分で読んで**決める（対応表・IDE の照合とは別の情報源）。
 * 修正前のコードでは、F-01 の項目が FAIL になる（再現の証拠）。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const SRC_FIXTURE = path.join(REPO, 'poc', 'fixture-app');
const WORK = path.join(REPO, 'poc', 'out', 'f01-e2e');
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
const eq = (name, a, b) => ok(name, a === b, a);
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
    return rel[0] !== 'node_modules' && rel[0] !== '.next' && rel[0] !== '.env';
  },
});
execFileSync('cp', ['-al', path.join(SRC_FIXTURE, 'node_modules'), path.join(PROJECT, 'node_modules')]);
const ORIGINAL = new Map();
const srcOf = (rel) => fs.readFileSync(path.join(PROJECT, rel), 'utf8');
const put = (rel, text) => {
  if (!ORIGINAL.has(rel)) ORIGINAL.set(rel, srcOf(rel));
  fs.writeFileSync(path.join(PROJECT, rel), text);
};
const restore = (rel) => { if (ORIGINAL.has(rel)) fs.writeFileSync(path.join(PROJECT, rel), ORIGINAL.get(rel)); };

/** needle で始まる JSX の位置（1 始まりの行・列）。**対応表も IDE の照合も使わない** */
function locate(rel, needle) {
  const lines = srcOf(rel).split('\n');
  const hits = [];
  lines.forEach((l, i) => { const c = l.indexOf(needle); if (c >= 0) hits.push(`${rel}:${i + 1}:${c + 1}`); });
  if (hits.length !== 1) throw new Error(`正解の位置が1つに決まりません: ${rel} ${needle} → ${hits}`);
  return hits[0];
}
const RSC = 'src/app/cards-rsc/page.tsx';
const BADGE = 'src/components/RegionBadge.tsx';
const CARDS = 'src/app/cards/page.tsx';
const UNRELATED = 'src/app/listings/page.tsx';
/** 同じ行・列に、同じタグ・同じコンポーネントの別の要素を置く（前に1行足す） */
const insertKind = (s) => s.replace('            <span className="code">{s.code}</span>',
  '            <span className="kind">新着</span>\n            <span className="code">{s.code}</span>');
/** 同じタグ・同じコンポーネントの中で、兄弟の2要素を入れ替える */
const swapBadge = (s) => s.replace(
  '      <span className="badge-dot" aria-hidden="true" />\n      <span className="badge-text">{region}</span>',
  '      <span className="badge-text">{region}</span>\n      <span className="badge-dot" aria-hidden="true" />');
{
  const a = insertKind(srcOf(RSC)); const b = swapBadge(srcOf(BADGE));
  if (a === srcOf(RSC) || b === srcOf(BADGE)) throw new Error('題材の書き換えが当たりません（題材が変わった）');
}
const T0 = {
  code: locate(RSC, '<span className="code">'),
  rscH1: locate(RSC, '<h1>物件カード（サーバー描画）'),
  badgeText: locate(BADGE, '<span className="badge-text">'),
  badgeDot: locate(BADGE, '<span className="badge-dot"'),
  cardsH1: locate(CARDS, '<h1>物件カード</h1>'),
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
const IDE_PORT = await freePort(3600);
const GW_PORT = await freePort(3660);
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

/* ------------------------------------------------- 転送役（クラウドのポート転送を模す） */
const MAP = { [IDE_HOST]: IDE_PORT, [PV_HOST]: GW_PORT };
const FWD_PORT = await freePort(3720);
/* --------------------------------------------- 要求・応答を止める（遅れて届く応答を作る）
 * 転送役の中で止める（ブラウザから見れば、ネットワークが遅いのと同じ）。
 * kind: anchor | lineage | revisions。mode: request（サーバーへ出す前に止める）| response（応答を受けてから渡すのを止める） */
const KIND_OF = { '/api/runtime/anchor': 'anchor', '/api/runtime/lineage': 'lineage', '/api/runtime/source-revisions': 'revisions' };
const holds = {};
function hold(kind, mode) {
  let arrived; let release;
  const h = { mode, arrivedP: new Promise((r) => { arrived = r; }), gate: new Promise((r) => { release = r; }) };
  h.arrived = arrived; h.release = () => release();
  holds[kind] = h;
  return h;
}
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
      h.arrived(); await h.gate;
      res.writeHead(r.statusCode, r.headers);
      res.end(Buffer.concat(chunks));
      return;
    }
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { upstreamErrors.push(`${u.pathname} ${e.code ?? e.message}`); if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});
/** 転送役で上流（IDE・中継）に届かなかった要求（試験の環境の記録。IDE の不具合の判定には使わない） */
const upstreamErrors = [];
/* ------------------------------------------------------- HMR の中継（止められる）
 * ブラウザは ws:// をプロキシの CONNECT で通す。プレビューの origin への CONNECT は HMR の WebSocket だけなので、
 * `hmr.frozen` の間は開発サーバー → ブラウザの向きのバイト列を貯めて渡さない（ブラウザ → サーバーはそのまま） */
const hmr = { frozen: false, held: [], sockets: 0, delivered: 0 };
const freeze = () => { hmr.frozen = true; };
const thaw = () => {
  hmr.frozen = false;
  for (const [sock, d] of hmr.held.splice(0)) { if (!sock.destroyed) { sock.write(d); hmr.delivered += 1; } }
};
forwarder.on('connect', (req, sock) => {
  const [h, p] = req.url.split(':');
  const port = MAP[h];
  if (!port || p !== '80') { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const isPv = h === PV_HOST;
  if (isPv) hmr.sockets += 1;
  const up = net.connect(port, '127.0.0.1', () => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (isPv) up.on('data', (d) => { if (hmr.frozen) hmr.held.push([sock, d]); else { hmr.delivered += 1; sock.write(d); } });
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

const anchorBodies = [];
const revisionChecks = [];
page.on('request', (r) => {
  if (r.url().includes('/api/runtime/anchor')) anchorBodies.push(r.postData() ?? '');
  if (r.url().includes('/api/runtime/source-revisions')) revisionChecks.push(Date.now());
});

/* ------------------------------------------------------------ 画面の操作 */
const rtPanel = () => page.locator('.fpnl[aria-label="プロジェクトと実行"]');
const pv = () => page.locator('section[aria-label="プレビュー"] .pvlive');
const frame = () => page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe');
const sel = (attr) => pv().getAttribute(attr);
const dockText = () => page.locator('aside.dock').innerText();
const canvasText = () => page.locator('.canvas').innerText().catch(() => '');
const status = () => page.evaluate(async () => (await fetch('/api/runtime/status')).json());
const waitPv = (state, timeout = 200000) => page.waitForFunction(
  (s) => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') === s, state, { timeout });
const loadsNow = async () => Number(await sel('data-loads'));
/** 条件が真になるまで待つ。時間切れは失敗として返す（修正前のコードでも最後まで回すため） */
async function until(fn, timeout = 15000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* 途中の状態 */ }
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
}
async function pick(locator) {
  const n = anchorBodies.length;
  await locator.click({ timeout: 30000 });
  await until(() => anchorBodies.length > n, 20000, 50);
  await until(async () => ['resolved', 'unresolved', 'error'].includes(await sel('data-selection')), 30000, 50);
  return snapshot();
}
const snapshot = async () => ({
  status: await sel('data-selection'), at: await sel('data-sel-at'), component: await sel('data-sel-component'),
  reason: await sel('data-sel-reason'), cleared: await sel('data-sel-cleared'),
});
const gotoPath = async (p) => {
  const n = await loadsNow();
  await pv().locator('input[aria-label="プレビューのパス"]').fill(p);
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  await until(async () => (await loadsNow()) > n, 60000);
  await until(async () => (await sel('data-path')) === p, 60000);
  await until(async () => (await sel('data-select-mode')) === (await sel('data-agent-mode')), 30000);
};
const selectModeOn = async () => {
  if ((await sel('data-select-mode')) !== 'on') await pv().locator('.rt-b', { hasText: '選択' }).click();
  await until(async () => (await sel('data-agent-mode')) === 'on', 10000);
};
let devPort = null;
/** 開発サーバーに直接ページを要求し、変換（ローダ）と対応表の書き直しを起こす。ブラウザの DOM は変えない */
const compileNow = (p) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port: devPort, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); })
    .on('error', (e) => resolve(String(e)));
});
const frameCount = (css) => frame().locator(css).count();
const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
/** 選択が「コードが変更されたため」に解除されたか（表示・右ドック・キャンバスに前の要素が残っていないか） */
async function expectInvalidated(label, old) {
  const cleared = await until(async () => (await sel('data-selection')) === 'cleared', 15000);
  ok(`${label}: 選択を無効にする（data-selection=cleared）`, cleared, await snapshot());
  const t = await pv().innerText();
  ok(`${label}: 「コードが変更されたため…もう一度選択」の理由を出す`, /コードが変更された/.test(t) && /もう一度選択/.test(t), t.slice(0, 300));
  eq(`${label}: 解除の理由は source-changed`, await sel('data-sel-cleared'), 'source-changed');
  const d = await dockText();
  ok(`${label}: 右ドックに前の要素の位置（${old.at}）を現在の情報として残さない`, !d.includes(old.at), d.slice(0, 500));
  if (old.line) ok(`${label}: 右ドックに前の要素のソース行を残さない`, !d.includes(old.line), d.slice(0, 500));
  eq(`${label}: キャンバスに前の選択のコンポーネントを残さない`, await page.locator('g.nd[aria-label^="コンポーネント"]').count(), 0);
  /* プレビューの中の「選んだ要素」の枠（緑 #1f7a52）。HMR の後は同じ DOM ノードが別の要素になりうる */
  const boxed = await until(async () => (await frame().locator('[data-vcide-overlay]').evaluateAll(
    (els) => els.filter((e) => e.style.borderColor === 'rgb(31, 122, 82)' && e.style.display !== 'none').length)) === 0, 5000);
  ok(`${label}: プレビューの中に前の要素の選択枠を残さない`, boxed);
  eq(`${label}: 選択モードは続く（そのまま選び直せる）`, await sel('data-agent-mode'), 'on');
}

const results = { startedAt: new Date().toISOString(), project: PROJECT };
try {
  /* ============================================ 0. 起動 */
  console.log('\n0. 使い捨ての題材を起動し、選択モードに入る');
  await page.goto(`http://${IDE_HOST}/`, { waitUntil: 'networkidle' });
  await rtPanel().locator('#rt-path').fill(PROJECT);
  await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((p) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === p, PROJECT, { timeout: 20000 });
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  await until(async () => Number(await sel('data-conn')) >= 1, 60000);
  const st = await status();
  eq('前提: 要素識別子の注入が有効', st.runtime.anchors?.state, 'enabled');
  devPort = st.runtime.port;
  const run1 = { instance: st.runtime.instance, pid: st.runtime.pid, startedAt: st.runtime.startedAt };
  await selectModeOn();
  await gotoPath('/cards-rsc');
  ok('前提: HMR の WebSocket を転送役で中継できている', hmr.sockets >= 1, { sockets: hmr.sockets });

  /* ============================================ 1. 選択の後、同じ行・列に別の同種要素が来る */
  console.log('\n1. 選択の後、同じ行・列に同じタグ・同じコンポーネントの別の要素が来る（HMR は通常どおり）');
  {
    const a = await pick(frame().locator('span.code').first());
    eq('前提: span.code を選ぶと正しい位置', a.at, T0.code);
    const oldLine = '<span className="code">{s.code}</span>';
    ok('前提: 右ドックに選んだ要素の行', (await dockText()).includes(T0.code));
    put(RSC, insertKind(srcOf(RSC)));
    note(`${RSC} を書き換えた: ${T0.code} には <span className="kind"> が来た（span.code は次の行へ）`);
    await expectInvalidated('1 既存の選択', { at: T0.code, line: oldLine });
    await shot('f01-1-invalidated');
    const hmrDone = await until(async () => (await frameCount('span.kind')) === 2, 30000);
    ok('前提: HMR で新しい DOM に入れ替わった', hmrDone);
    const k = await pick(frame().locator('span.kind').first());
    eq('1 最新の DOM を選び直すと、最新のソースの位置（同じ行・列の新しい要素）', k.at, locate(RSC, '<span className="kind">'));
    ok('1 右ドックは新しい要素の行を出す', (await dockText()).includes('className="kind"'), (await dockText()).slice(0, 400));
    const c = await pick(frame().locator('span.code').first());
    eq('1 最新の DOM の span.code は、移った後の位置', c.at, locate(RSC, '<span className="code">'));
    restore(RSC);
    await until(async () => (await frameCount('span.kind')) === 0, 30000);
  }

  /* ============================================ 2. HMR の前の古い DOM から選ぶ（対応表は新しい） */
  console.log('\n2. ソース変更の後、HMR の前の古い DOM から選ぶ（対応表は書き直し済み）');
  {
    await pick(frame().locator('h1'));
    freeze();
    const loads = await loadsNow();
    put(RSC, insertKind(srcOf(RSC)));
    const code = await compileNow('/cards-rsc');
    note(`開発サーバーに直接 /cards-rsc を要求して変換を起こした（HTTP ${code}）。プレビューへの HMR は止めている`);
    await sleep(800);
    eq('前提: プレビューの DOM はまだ前の版（span.kind が無い）', await frameCount('span.kind'), 0);
    const r = await pick(frame().locator('span.code').first());
    eq('前提: その間にプレビューは読み込み直していない', await loadsNow(), loads);
    eq('前提: クリックの時点でも DOM は前の版', await frameCount('span.kind'), 0);
    ok('2 古い DOM の要素を、同じ行・列の新しい要素として特定しない', r.status !== 'resolved', r);
    eq('2 理由は「コードが変更された」（source-changed）', r.reason, 'source-changed');
    {
      const d = await dockText();
      ok('2 右ドックに新しい要素（span.kind）の行を出さない', !d.includes('className="kind"'), d.slice(0, 500));
      ok('2 右ドックに理由（再選択を求める）を出す', /コードが変更/.test(d) && /もう一度選択/.test(d), d.slice(0, 600));
      eq('2 コンポーネントのノードを作らない', await page.locator('g.nd[aria-label^="コンポーネント"]').count(), 0);
    }
    await shot('f01-2-stale-dom');
    const b = await pick(frame().locator('span.badge-text').first());
    eq('2 変更していないファイル（RegionBadge）の要素は、古い DOM のままでも特定できる', b.at, T0.badgeText);
    thaw();
    ok('前提: HMR を戻すと新しい DOM になる', await until(async () => (await frameCount('span.kind')) === 2, 30000));
    const k = await pick(frame().locator('span.kind').first());
    eq('2 最新の DOM を選び直すと最新のソースの位置', k.at, locate(RSC, '<span className="kind">'));
    restore(RSC);
    await until(async () => (await frameCount('span.kind')) === 0, 30000);
  }

  /* ============================================ 3. 同じタグ・同じコンポーネントの中で入れ替える */
  console.log('\n3. 同じタグ・同じコンポーネント（RegionBadge）の中で兄弟の要素を入れ替える');
  const firstBadgeChild = () => frame().locator('span.badge > span').first().getAttribute('class');
  {
    /* 3a 既存の選択（HMR は通常どおり） */
    const b = await pick(frame().locator('span.badge-text').nth(1));
    eq('前提: 2つ目の描画の badge-text', b.at, T0.badgeText);
    ok('前提: 複数描画の何番目かを出す', /2 個のうち 2 番目/.test(await pv().innerText()));
    put(BADGE, swapBadge(srcOf(BADGE)));
    note(`${BADGE} の badge-dot と badge-text を入れ替えた: ${T0.badgeText} には badge-dot が来た`);
    await expectInvalidated('3a 既存の選択', { at: T0.badgeText, line: '<span className="badge-text">{region}</span>' });
    ok('前提: HMR で入れ替わった DOM になる', await until(async () => (await firstBadgeChild()) === 'badge-text', 30000));
    const n = await pick(frame().locator('span.badge-text').nth(1));
    eq('3a 最新の DOM の badge-text は新しい位置', n.at, locate(BADGE, '<span className="badge-text">'));
    ok('3a 複数描画の何番目かは維持される', /2 個のうち 2 番目/.test(await pv().innerText()));
    restore(BADGE);
    ok('前提: 元に戻した DOM', await until(async () => (await firstBadgeChild()) === 'badge-dot', 30000));
  }
  {
    /* 3b HMR の前の古い DOM から選ぶ */
    await pick(frame().locator('h1'));
    freeze();
    const loads = await loadsNow();
    const sockets = hmr.sockets;
    put(BADGE, swapBadge(srcOf(BADGE)));
    await compileNow('/cards-rsc');
    await sleep(800);
    eq('前提: DOM はまだ前の版（badge-dot が先）', await firstBadgeChild(), 'badge-dot');
    const r = await pick(frame().locator('span.badge-text').first());
    eq('前提: クリックの時点でも DOM は前の版', await firstBadgeChild(), 'badge-dot');
    note(`HMR を止めている間: 読み込み ${loads} → ${await loadsNow()}、HMR の接続 ${sockets} → ${hmr.sockets}、貯めた知らせ ${hmr.held.length}`);
    ok('3b 古い DOM の badge-text を、入れ替わった位置の badge-dot として特定しない', r.status !== 'resolved', r);
    eq('3b 理由は source-changed', r.reason, 'source-changed');
    thaw();
    ok('前提: HMR を戻すと入れ替わった DOM になる', await until(async () => (await firstBadgeChild()) === 'badge-text', 30000));
    restore(BADGE);
    ok('前提: 元に戻した DOM', await until(async () => (await firstBadgeChild()) === 'badge-dot', 30000));
  }

  /* ============================================ 4. 解決の要求の途中でソースが変わる */
  console.log('\n4. 解決の要求がサーバーに届く前にソースが変わる');
  {
    await pick(frame().locator('h1'));
    const h = hold('anchor', 'request');
    const n = anchorBodies.length;
    await frame().locator('span.code').first().click();
    await h.arrivedP;
    put(RSC, insertKind(srcOf(RSC)));
    note('クリックの要求を止めている間に、同じ行・列へ span.kind を足した');
    await sleep(300);
    h.release();
    await until(() => anchorBodies.length > n, 5000);
    await until(async () => ['resolved', 'unresolved', 'error'].includes(await sel('data-selection')), 30000);
    const r = await snapshot();
    ok('4 クリックした時点の DOM の要素を、変更後の別の要素として特定しない', r.status !== 'resolved', r);
    eq('4 理由は source-changed', r.reason, 'source-changed');
    restore(RSC);
    await until(async () => (await frameCount('span.kind')) === 0, 30000);
    await sleep(500);
  }

  /* ============================================ 5. 古い選択の結果が新しい選択より遅れて届く */
  console.log('\n5. 古い選択の結果が、新しい選択の結果より遅れて届く');
  {
    const h = hold('anchor', 'response');
    await frame().locator('h1').click();
    await h.arrivedP;
    const b = await pick(frame().locator('span.code').first());
    eq('前提: 新しい選択（span.code）が出ている', b.at, T0.code);
    h.release();
    await sleep(1500);
    eq('5 遅れて届いた古い解決（h1）で、新しい選択を上書きしない', await sel('data-sel-at'), T0.code);
    ok('5 右ドックも新しい選択のまま', (await dockText()).includes(T0.code) && !(await dockText()).includes(T0.rscH1));

    const hl = hold('lineage', 'response');
    await pick(frame().locator('h1'));
    await hl.arrivedP;
    const c = await pick(frame().locator('span.badge-text').first());
    eq('前提: 新しい選択（badge-text）', c.at, T0.badgeText);
    hl.release();
    await sleep(1500);
    eq('5 遅れて届いた古い由来の評価で、新しい選択を上書きしない', await sel('data-sel-at'), T0.badgeText);
    ok('5 右ドックに古い選択（h1）の位置が出ない', !(await dockText()).includes(T0.rscH1));
  }

  /* ============================================ 6. 版の確かめの応答が、別の選択の後に遅れて届く */
  console.log('\n6. 前の選択の「ソースが変わった」応答が、新しい選択の後に届く');
  {
    const a = await pick(frame().locator('span.code').first());
    eq('前提: span.code を選んだ', a.at, T0.code);
    const h = hold('revisions', 'request');
    const got = await Promise.race([h.arrivedP.then(() => true), sleep(10000).then(() => false)]);
    note(got ? '前の選択の版の確かめを止めた' : '版の確かめの要求が無い（修正前のコード）');
    put(RSC, insertKind(srcOf(RSC)));
    const k = await until(async () => (await frameCount('span.kind')) === 2, 30000);
    ok('前提: HMR で新しい DOM', k);
    const b = await pick(frame().locator('span.badge-text').first());
    eq('前提: 変更していないファイルの要素を新しく選んだ', b.at, T0.badgeText);
    if (got) h.release();
    await sleep(3000);
    eq('6 前の選択への「変わった」応答で、新しい選択を解除しない', await sel('data-selection'), 'resolved');
    eq('6 新しい選択の位置のまま', await sel('data-sel-at'), T0.badgeText);
    restore(RSC);
    await until(async () => (await frameCount('span.kind')) === 0, 30000);
    await sleep(500);
  }

  /* ============================================ 7. 無効化の単位 */
  console.log('\n7. 無効化の単位（選んだ要素のファイルと、照合に使った祖先のファイル）');
  {
    const a = await pick(frame().locator('span.code').first());
    eq('前提: span.code', a.at, T0.code);
    put(UNRELATED, `${srcOf(UNRELATED)}\n// unrelated edit ${Date.now()}\n`);
    note(`${UNRELATED}（選択とは無関係のファイル）を書き換えた`);
    await sleep(5000);
    eq('7 無関係なファイルの変更では選択を解除しない', await sel('data-selection'), 'resolved');
    eq('7 位置もそのまま', await sel('data-sel-at'), T0.code);
    restore(UNRELATED);

    const b = await pick(frame().locator('span.badge-text').first());
    eq('前提: badge-text（祖先は cards-rsc/page.tsx の <li>・<ul>・<main>）', b.at, T0.badgeText);
    put(RSC, `${srcOf(RSC)}\n// comment only ${Date.now()}\n`);
    note(`${RSC}（祖先のファイル）の末尾にコメントだけを足した`);
    await expectInvalidated('7 祖先のファイルの変更（コメントだけでも）', { at: T0.badgeText });
    restore(RSC);
    await sleep(1500);

    const c = await pick(frame().locator('span.badge-text').first());
    eq('前提: badge-text をもう一度選んだ', c.at, T0.badgeText);
    put(BADGE, `${srcOf(BADGE)}\n// comment only ${Date.now()}\n`);
    await expectInvalidated('7 選んだ要素のファイルの変更（コメントだけでも）', { at: T0.badgeText });
    restore(BADGE);
    await sleep(1500);
  }

  /* ============================================ 8. Client Component・ページ遷移・HMR */
  console.log('\n8. Client Component のページ（/cards）でも、変更後に別の要素へ移らない');
  {
    await gotoPath('/cards');
    const h = await pick(frame().locator('h1'));
    eq('前提: Client Component の h1', h.at, T0.cardsH1);
    eq('前提: コンポーネント名', h.component, 'Cards');
    const v = await pick(frame().locator('h3.vendor-title'));
    eq('8 ライブラリ由来の要素は従来どおり「特定できません」（anchor-missing）', v.reason, 'anchor-missing');
    const h2 = await pick(frame().locator('h1'));
    eq('前提: h1 を選び直した', h2.at, T0.cardsH1);
    put(CARDS, srcOf(CARDS).replace('      <h1>物件カード</h1>', '      <h1 className="lead">お知らせ</h1>\n      <h1>物件カード</h1>'));
    note(`${CARDS} の h1 の前に、同じ行・列へ別の <h1> を足した`);
    await expectInvalidated('8 Client Component の既存の選択', { at: T0.cardsH1 });
    ok('前提: Fast Refresh で新しい DOM', await until(async () => (await frameCount('h1.lead')) === 1, 30000));
    const n = await pick(frame().locator('h1.lead'));
    eq('8 最新の DOM を選び直すと最新のソースの位置', n.at, locate(CARDS, '<h1 className="lead">'));
    const o = await pick(frame().locator('h1:not(.lead)'));
    eq('8 元の h1 は移った後の位置', o.at, locate(CARDS, '<h1>物件カード</h1>'));
    restore(CARDS);
    await until(async () => (await frameCount('h1.lead')) === 0, 30000);
    await gotoPath('/cards-rsc');
    const r = await pick(frame().locator('h1'));
    eq('8 ページ遷移の後も正しい要素を選べる', r.at, T0.rscH1);
  }

  /* ============================================ 9. 解除・停止・再起動の後に古い応答が届く */
  console.log('\n9. 選択解除・停止・再起動の後に、古い応答が届く');
  {
    const h = hold('anchor', 'response');
    await frame().locator('span.code').first().click();
    await h.arrivedP;
    await pv().locator('.pvselrow .rt-b', { hasText: '解除' }).click();
    h.release();
    await sleep(1500);
    eq('9 解除の後に届いた解決で、選択を復活させない', await sel('data-selection'), '');
    eq('9 解除の後、キャンバスにコンポーネントを描かない', await page.locator('g.nd[aria-label^="コンポーネント"]').count(), 0);

    const h2 = hold('anchor', 'response');
    await frame().locator('span.code').first().click();
    await h2.arrivedP;
    note(`停止の前に解決の応答を受け取った（HTTP ${h2.status}）。画面へ渡すのを止めている`);
    await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
    await waitPv('stopped', 60000);
    h2.release();
    await sleep(1500);
    ok('9 停止の後に届いた解決で、選択を出さない', (await page.locator('section[aria-label="プレビュー"] .pvlive').count()) === 0
      || (await sel('data-selection')) !== 'resolved', await snapshot().catch(() => null));
    eq('9 停止の後、キャンバスに経路を描かない', await page.locator('g.nd').count(), 0);

    await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
    await waitPv('live');
    await until(async () => Number(await sel('data-conn')) >= 1, 60000);
    const st2 = await status();
    devPort = st2.runtime.port;
    ok('前提: 別の起動', st2.runtime.pid !== run1.pid || st2.runtime.startedAt !== run1.startedAt);
    await selectModeOn();
    await gotoPath('/cards-rsc');
    const h3 = hold('anchor', 'response');
    await frame().locator('span.code').first().click();
    await h3.arrivedP;
    await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
    await waitPv('stopped', 60000);
    await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
    await waitPv('live');
    await until(async () => Number(await sel('data-conn')) >= 1, 60000);
    h3.release();
    await sleep(1500);
    ok('9 再起動の後に届いた前の起動の解決で、選択を出さない', (await sel('data-selection')) !== 'resolved', await snapshot());
    eq('9 再起動の後、キャンバスにコンポーネントを描かない', await page.locator('g.nd[aria-label^="コンポーネント"]').count(), 0);
    await selectModeOn();
    await gotoPath('/cards-rsc');
    const r = await pick(frame().locator('span.code').first());
    eq('9 再起動の後、最新の DOM を選べば正しく特定できる', r.at, T0.code);
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
  /* 所有した開発サーバーが残っていないか（使い捨ての題材のパスで探す） */
  let leftover = '';
  try { leftover = execFileSync('pgrep', ['-af', WORK], { encoding: 'utf8' }).trim(); } catch { leftover = ''; }
  ok('後片付け: 使い捨ての題材で動くプロセスが残っていない', leftover === '', leftover);
  fs.rmSync(WORK, { recursive: true, force: true });
}

results.finishedAt = new Date().toISOString();
results.pass = pass; results.fail = fails.length; results.items = log;
if (RESULTS) { fs.mkdirSync(path.dirname(RESULTS), { recursive: true }); fs.writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`); }
console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
