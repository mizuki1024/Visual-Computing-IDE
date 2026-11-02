/* =============================================================================
 * Phase 7B-2 — 実ページの要素をクリックして、React のソース位置を根拠つきで特定する。
 * **クラウドの開発環境を模した**実ブラウザで端から端まで確かめる（模し方は preview-e2e と同じ）。
 *   npm run build && node tests/select-e2e.spec.mjs
 *   SHOTS=docs/07b2-screenshots node tests/select-e2e.spec.mjs
 *
 * 正解はこの試験が**ソースを自分で読んで**決める（対応表・IDE の照合とは別の情報源）。
 *
 * 模しているもの（Codespaces などのポート転送）
 *   - ブラウザは **転送用のホスト名でしかサーバーに届かない。**
 *       http://ide.cloud.test      → サーバーの 127.0.0.1:<IDE のポート>
 *       http://preview.cloud.test  → サーバーの 127.0.0.1:<中継のポート>
 *     転送は Host をそのまま渡す（Codespaces と同じ）
 *   - ブラウザの 127.0.0.1 は **サーバーの 127.0.0.1 ではない。** ブラウザの全通信を
 *     この試験の転送役（HTTP プロキシ）に通し、ループバックも例外にしない（--proxy-bypass-list=<-loopback>）。
 *     転送役は上の2つの名前以外を転送しない
 *
 * この試験は IDE を自分で起動する（転送ホストの許可とダミーの秘密情報を IDE の環境変数に入れるため）。
 * IDE のビルド（.next）が要る。題材は poc/fixture-app（Next 16.4.3）。
 *
 * 画面の操作で行う。API を直接叩くのは、否定の確認（届かないこと）だけである。
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
const MARK = 'DUMMY-SECRET-7B2-E2E';

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
const IDE_PORT = await freePort(3400);
const GW_PORT = await freePort(3460);
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
const FWD_PORT = await freePort(3520);
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

/* ------------------------------------------------ 正解（ソースを自分で読む） */
/** needle で始まる JSX の位置（1 始まりの行・列）。**対応表も IDE の照合も使わない** */
function locate(rel, needle) {
  const lines = fs.readFileSync(path.join(PROJECT, rel), 'utf8').split('\n');
  const hits = [];
  lines.forEach((l, i) => { const c = l.indexOf(needle); if (c >= 0) hits.push(`${rel}:${i + 1}:${c + 1}`); });
  if (hits.length !== 1) throw new Error(`正解の位置が1つに決まりません: ${rel} ${needle} → ${hits}`);
  return hits[0];
}
const TRUTH = {
  badge: locate('src/components/RegionBadge.tsx', '<span className="badge-text">'),
  rscCode: locate('src/app/cards-rsc/page.tsx', '<span className="code">'),
  rscH1: locate('src/app/cards-rsc/page.tsx', '<h1>物件カード（サーバー描画）'),
  cardsH1: locate('src/app/cards/page.tsx', '<h1>物件カード</h1>'),
  inSlot: locate('src/app/cards/page.tsx', '<span className="in-slot">'),
  listingsH1: locate('src/app/listings/page.tsx', '<h1>物件一覧'),
};

/* ------------------------------------------- IDE の画面が受け取った知らせを記録する
 * LivePreview が作る MessageChannel の受け口に、試験用の聞き手を足す（知らせの中身を検査するため） */
await page.addInitScript(() => {
  if (window !== window.top) return;
  window.__portLog = [];
  const C = window.MessageChannel;
  window.MessageChannel = function MessageChannelSpy() {
    const c = new C();
    c.port1.addEventListener('message', (e) => { try { window.__portLog.push(JSON.stringify(e.data)); } catch { window.__portLog.push('(unserializable)'); } });
    return c;
  };
});
const anchorBodies = [];
page.on('request', (r) => { if (r.url().includes('/api/runtime/anchor')) anchorBodies.push(r.postData() ?? ''); });

const sel = (attr) => pv().getAttribute(attr);
const waitSel = (status, timeout = 30000) => page.waitForFunction(
  (s) => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-selection') === s,
  status, { timeout },
);
/** 選択の結果が変わるまで待つ（同じ結果が続く選択でも取り違えないよう、要求の数で待つ） */
async function pick(locator, expect = null) {
  const n = anchorBodies.length;
  await locator.click({ timeout: 30000 });
  const t0 = Date.now();
  while (anchorBodies.length <= n && Date.now() - t0 < 20000) await sleep(50);
  await page.waitForFunction(() => {
    const s = document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-selection');
    return s === 'resolved' || s === 'unresolved' || s === 'error';
  }, null, { timeout: 30000 });
  if (expect) await waitSel(expect);
  return { status: await sel('data-selection'), at: await sel('data-sel-at'), component: await sel('data-sel-component'), reason: await sel('data-sel-reason') };
}
const dockText = () => page.locator('aside.dock').innerText();
const gotoPath = async (p) => {
  const n = await loadsNow();
  await pv().locator('input[aria-label="プレビューのパス"]').fill(p);
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  await waitLoads(n);
  await page.waitForFunction((x) => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-path') === x, p, { timeout: 60000 });
  // 新しい文書のスクリプトと接続し直すまで待つ
  await page.waitForFunction(() => {
    const el = document.querySelector('section[aria-label="プレビュー"] .pvlive');
    return el?.getAttribute('data-select-mode') === el?.getAttribute('data-agent-mode');
  }, null, { timeout: 30000 });
};
const status = () => page.evaluate(async () => (await fetch('/api/runtime/status')).json());

try {
  /* ============================================ 1. 起動して、選択モードに入る */
  console.log('\n1. fixture-app を起動し、プレビューの中のスクリプトと接続する');
  await page.goto(`http://${IDE_HOST}/`, { waitUntil: 'networkidle' });
  const nodesBase = await page.locator('g.nd').count();
  const noticeBase = await page.locator('.note.synth').innerText();
  await rtPanel().locator('#rt-path').fill(PROJECT);
  await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((p) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === p, PROJECT, { timeout: 20000 });
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  await page.waitForFunction(() => Number(document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-conn')) >= 1, null, { timeout: 60000 });
  ok('中継のスクリプトと MessagePort で接続する', Number(await sel('data-conn')) >= 1);
  const st1 = await status();
  eq('要素識別子の注入が有効（対象の next.config がローダを読む設定）', st1.runtime.anchors?.state, 'enabled');
  ok('状態 API に対応表の置き場所（絶対パス）を出さない', !JSON.stringify(st1).includes('.ide-runtime/anchors'));
  const run1 = { instance: st1.runtime.instance, pid: st1.runtime.pid, startedAt: st1.runtime.startedAt };
  eq('選択モードは既定で切（プレビューの中のクリックはページの操作のまま）', await sel('data-select-mode'), 'off');
  await pv().locator('.rt-b', { hasText: '選択' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-agent-mode') === 'on', null, { timeout: 10000 });
  ok('選択モードがプレビューの中のスクリプトに伝わる', (await sel('data-agent-mode')) === 'on');

  /* ============================================ 2. Server Component のページで選ぶ */
  console.log('\n2. Server Component のページ（/cards-rsc）の要素を選ぶ');
  await gotoPath('/cards-rsc');
  const badges = frame().locator('span.badge-text');
  eq('前提: 同じコンポーネント（RegionBadge）が2回描かれている', await badges.count(), 2);
  const a = await pick(badges.nth(0), 'resolved');
  eq('実ページの要素をクリックすると、ソース位置が特定される', a.status, 'resolved');
  eq('正しいソース位置（試験がソースを読んで決めた正解と一致）', a.at, TRUTH.badge);
  eq('正しいコンポーネント', a.component, 'RegionBadge');
  eq('選択してもページは操作されない（移動していない）', await sel('data-path'), '/cards-rsc');
  {
    const d = await dockText();
    ok('右ドックに React コンポーネント', d.includes('RegionBadge'), d.slice(0, 400));
    ok('右ドックにソースファイルと行・列', d.includes(TRUTH.badge), d.slice(0, 600));
    ok('右ドックに特定方法', d.includes('要素自身の識別子') || d.includes('ビルド時に注入した要素識別子'));
    /* 7C-3（P1-10）: 「ここから先はたどれていません」に代えて、描画位置（特定済み）と値の由来（未確認）を分けて言う */
    ok('右ドックは値の由来を断定しない（描画位置は特定済み・値の由来は未確認・「この値の出所」と言わない）',
      d.includes('特定済み') && d.includes('値の由来') && d.includes('未確認') && !d.includes('この値の出所'), d.slice(0, 600));
    ok('キャンバスは実ページの選択に差し替わる（① 表示された値 ② コンポーネント）',
      (await page.locator('g.nd[aria-label^="表示された値"]').count()) === 1 && (await page.locator('g.nd[aria-label^="コンポーネント"]').count()) === 1,
      await page.locator('g.nd').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))));
    ok('キャンバスの注記は実ページの選択だと言う', (await page.locator('.note.synth').innerText()).includes('開発サーバーの実ページで選択した要素'));
    ok('キャンバスに「ここから先は観測していません」の切断がある', (await page.locator('.canvas').innerText()).includes('ここから先は観測していません'));
    ok("Server Component のファイル: 'use client' が無いことと、その限界を書く", d.includes("'use client' はありません") || (await page.getByRole('tab', { name: '概要' }).count()) > 0);
  }
  await shot('01-select-rsc');
  await page.getByRole('tab', { name: '根拠' }).click();
  {
    const d = await dockText();
    ok('根拠タブに照合の根拠（対応表・ソースの読み直し）', /対応表/.test(d) && /読み直し/.test(d), d.slice(0, 600));
  }
  await shot('02-evidence');
  await page.getByRole('tab', { name: '概要' }).click();

  const b = await pick(badges.nth(1), 'resolved');
  eq('2つ目のインスタンスも同じソース位置（同じ JSX）', b.at, TRUTH.badge);
  ok('複数インスタンス: 何番目かは DOM 上の順番として出す', /2 個のうち 2 番目/.test(await pv().locator('.pvsel').innerText()), await pv().locator('.pvsel').innerText());
  ok('複数インスタンス: どの使用箇所かは区別しないと書く', /区別していません/.test(await pv().locator('.pvsel').innerText()));
  {
    // 概要の全行を見る（ドックのノード選択はコンポーネント）
    const d = await dockText();
    ok('複数インスタンス: 右ドックも「どの使用箇所が何番目を描いたかは観測していません」', d.includes('どの使用箇所が何番目を描いたかは観測していません'), d.slice(0, 900));
    ok('複数インスタンス: 使用箇所（呼び出し側のファイル）を根拠なく出さない', !d.includes('cards-rsc/page.tsx'), d.slice(0, 900));
  }
  const c = await pick(frame().locator('span.code').first(), 'resolved');
  eq('Server Component 本体の JSX', c.at, TRUTH.rscCode);
  eq('Server Component のコンポーネント名', c.component, 'CardsRsc');
  ok("Server Component のファイルには 'use client' が無いと書く", (await dockText()).includes("'use client' はありません"));
  const h = await pick(frame().locator('h1'), 'resolved');
  eq('Server Component の見出し', h.at, TRUTH.rscH1);

  /* ============================================ 3. Client Component・ページ遷移 */
  console.log('\n3. Client Component のページ（/cards）と、ページ遷移の後の選択');
  await gotoPath('/cards');
  const ch = await pick(frame().locator('h1'), 'resolved');
  eq('Client Component の要素', ch.at, TRUTH.cardsH1);
  eq('Client Component のコンポーネント名', ch.component, 'Cards');
  ok("Client Component のファイルには 'use client' があると書く", (await dockText()).includes("'use client' があります"));
  const slot = await pick(frame().locator('span.in-slot'), 'resolved');
  eq('ライブラリの枠の中に置いた自作 JSX は自作ファイルを指す', slot.at, TRUTH.inSlot);
  await shot('03-select-client');

  /* ============================================ 4. 識別子の無い要素を誤特定しない */
  console.log('\n4. 識別子の無い要素（ライブラリ由来・JSX を経ない DOM・フレームワークの要素）');
  const v = await pick(frame().locator('h3.vendor-title'), 'unresolved');
  eq('ライブラリ由来の要素は「特定できません」', v.status, 'unresolved');
  eq('理由: この要素自身に識別子が無い', v.reason, 'anchor-missing');
  eq('ソース位置を出さない', v.at, '');
  {
    const d = await dockText();
    ok('右ドックに未特定の理由', d.includes('この要素自身に要素識別子がありません'), d.slice(0, 600));
    ok('祖先（Cards の <main>）は文脈として書き、出所にしない', d.includes('祖先は文脈') && d.includes('Cards'), d.slice(0, 900));
    eq('コンポーネントのノードを作らない', await page.locator('g.nd[aria-label^="コンポーネント"]').count(), 0);
    ok('キャンバスに「この要素のソースは特定できません」', (await page.locator('.canvas').innerText()).includes('この要素のソースは特定できません'));
  }
  await shot('04-unresolved');
  const inj = await pick(frame().locator('span.injected'), 'unresolved');
  eq('JSX を経ずに作った要素も「特定できません」', inj.reason, 'anchor-missing');
  // body の余白（フレームワークが所有する要素。識別子を付けない）
  {
    const n = anchorBodies.length;
    await frame().locator('body').click({ position: { x: 4, y: 4 } });
    const t0 = Date.now(); while (anchorBodies.length <= n && Date.now() - t0 < 20000) await sleep(50);
    await page.waitForFunction(() => ['resolved', 'unresolved'].includes(document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-selection')), null, { timeout: 30000 });
    eq('フレームワークの要素（body / html）も「特定できません」', await sel('data-selection'), 'unresolved');
  }

  /* ============================================ 5. 不正な postMessage を拒否する */
  console.log('\n5. 不正な知らせを受けない（iframe の中のアプリが偽る場合を含む）');
  {
    await pick(frame().locator('h1'), 'resolved');
    const before = { at: await sel('data-sel-at'), rej: Number(await sel('data-rejected')), conn: Number(await sel('data-conn')), reqs: anchorBodies.length };
    const fr = page.frames().find((f) => f.url().startsWith(`http://${PV_HOST}/`));
    // (a) アプリのスクリプトが window.postMessage で選択を偽る
    await fr.evaluate((ids) => {
      parent.postMessage({ source: 'vcide-preview', v: 3, kind: 'select', nonce: 'x'.repeat(24), seq: 99, selection: { tag: 'span', anchorOnSelf: ids, anchorRev: '0123456789abcdef', anchorOrdinal: 0, anchorInstanceCount: 1, ancestorAnchors: [], ancestorRevs: [], textNodeIndex: null, valueShape: null, formControl: false, path: '/' } }, '*');
      parent.postMessage({ source: 'vcide-preview', v: 1, kind: 'ready', path: '/evil', title: 'x', status: 200, soft: false, from: 'app' }, '*');
      parent.postMessage('<html>not a message</html>', '*');
    }, '0123456789');
    await sleep(800);
    eq('(a) window.postMessage で偽った選択は受けない（選択は変わらない）', await sel('data-sel-at'), before.at);
    ok('(a) 偽った知らせは数えて捨てる', Number(await sel('data-rejected')) >= before.rej + 3, await sel('data-rejected'));
    eq('(a) 偽った知らせで解決の API を呼ばない', anchorBodies.length, before.reqs);
    ok('(a) 偽った場所の知らせでパスが変わらない', (await sel('data-path')) === '/cards', await sel('data-path'));
    // (b) アプリが自分のリスナーを置き、hello を偽って port を横取りしようとする
    const stolen = await fr.evaluate(async () => {
      window.__stolen = [];
      addEventListener('message', (e) => { window.__stolen.push({ kind: e.data?.kind ?? null, ports: e.ports?.length ?? 0 }); });
      parent.postMessage({ source: 'vcide-preview', v: 3, kind: 'hello' }, '*');
      await new Promise((r) => setTimeout(r, 800));
      return window.__stolen;
    });
    eq('(b) IDE が返した connect と port を、アプリのリスナーは受け取れない', JSON.stringify(stolen), '[]');
    eq('(b) 偽った hello で接続は入れ替わらない', Number(await sel('data-conn')), before.conn);
    // (c) アプリが作ったクリック（isTrusted でない）では選ばない
    const reqs = anchorBodies.length;
    await fr.evaluate(() => { document.querySelector('span.in-slot').click(); document.querySelector('span.in-slot').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await sleep(800);
    eq('(c) スクリプトが起こしたクリックでは選択しない', anchorBodies.length, reqs);
    // (b') 偽った hello の後も、本物のクリックは今の接続で解決できる
    const again = await pick(frame().locator('span.in-slot'), 'resolved');
    eq("(b') 本物のクリックは引き続き解決できる", again.at, TRUTH.inSlot);
    // (d) アプリが DOM の識別子を書き換える → IDE の照合（タグの一致）で止まる
    await fr.evaluate(() => { const id = document.querySelector('h1').getAttribute('data-vcide'); document.querySelector('span.in-slot').setAttribute('data-vcide', id); });
    const forged = await pick(frame().locator('span.in-slot'), 'unresolved');
    eq('(d) 別の要素の識別子を付け替えた要素は、タグの照合で止まる', forged.reason, 'tag-mismatch');
    await fr.evaluate(() => { document.querySelector('span.in-slot').setAttribute('data-vcide', 'ffffffffff'); });
    const bogus = await pick(frame().locator('span.in-slot'), 'unresolved');
    eq('(d) 対応表に無い識別子は「対応表にありません」', bogus.reason, 'anchor-not-in-manifest');
    // (e) 解決の API を直接呼ぶ
    phase.negativeApi = true; phase.negativeSeen = 0;
    const api = await page.evaluate(async ({ run }) => {
      const call = async (body) => {
        const r = await fetch('/api/runtime/anchor', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
      };
      const base = { tag: 'h1', anchorOnSelf: null, anchorRev: null, anchorOrdinal: null, anchorInstanceCount: 0, ancestorAnchors: [], ancestorRevs: [], textNodeIndex: null, valueShape: null, formControl: false, path: '/' };
      return {
        extraKey: await call({ run, selection: { ...base, html: '<p>secret</p>' } }),
        location: await call({ run, selection: { ...base, file: 'src/app/page.tsx', line: 1 } }),
        badId: await call({ run, selection: { ...base, anchorOnSelf: '../../etc', anchorOrdinal: 0, anchorInstanceCount: 1 } }),
        /* F-01: ソースの版のキーを持たない選択（版を知らない送り手）は受けない */
        noRev: await call({ run, selection: (({ anchorRev, ancestorRevs, ...o }) => o)(base) }),
        noHeader: (await fetch('/api/runtime/anchor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run, selection: base }) })).status,
      };
    }, { run: run1 });
    eq('(e) 知らないキー（本文など）を含む選択は 400', api.extraKey.status, 400);
    eq('(e) 選択にソース位置を書いて送っても受けない（400）', api.location.status, 400);
    eq('(e) 識別子の形でないもの（パスなど）は 400', api.badId.status, 400);
    eq('(e) F-01: ソースの版のキーを持たない選択は 400', api.noRev.status, 400);
    eq('(e) 変更操作の独自ヘッダが無ければ拒否', api.noHeader, 403);
    const fromPreview = await (await browser.newPage()).goto(`http://${PV_HOST}/__vcide_preview/agent.js`).then(async (r) => {
      const tab = r.frame().page();
      return tab.evaluate(async (ideHost) => {
        try {
          const x = await fetch(`http://${ideHost}/api/runtime/anchor`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: '{}' });
          return `status ${x.status}`;
        } catch (e) { return `blocked: ${e.message}`; }
      }, IDE_HOST);
    });
    ok('(e) プレビューの origin から解決の API は呼べない', !/status 200/.test(fromPreview), fromPreview);
    await sleep(300);
    phase.negativeApi = false;
  }

  /* ============================================ 6. 本文・秘密情報を送らない */
  console.log('\n6. HTML 本文・フォームの値・Cookie・トークンを送らない');
  {
    const fr = page.frames().find((f) => f.url().startsWith(`http://${PV_HOST}/`));
    await fr.evaluate((m) => {
      document.cookie = `vcide_e2e=${m}; path=/`;
      try { localStorage.setItem('vcide_e2e', m); } catch { /* 無くてよい */ }
      const i = document.createElement('input'); i.className = 'e2e-input'; i.value = m;
      const t = document.createElement('p'); t.className = 'e2e-text'; t.textContent = `本文 ${m}`;
      document.querySelector('main').append(i, t);
    }, MARK);
    await pick(frame().locator('input.e2e-input'), 'unresolved');
    await pick(frame().locator('p.e2e-text'), 'unresolved');
    await pick(frame().locator('h1'), 'resolved');
    const log = await page.evaluate(() => window.__portLog);
    ok('知らせを記録できている（試験の前提）', log.length > 5, log.length);
    ok('プレビューから IDE への知らせに、Cookie・入力値・本文の印が無い', !log.some((x) => x.includes(MARK)));
    ok('解決の API への要求にも印が無い', !anchorBodies.some((x) => x.includes(MARK)));
    ok('知らせに表示された文字（見出しの文字列）が無い', !log.some((x) => x.includes('物件カード')) && !anchorBodies.some((x) => x.includes('物件カード')));
    ok('知らせに HTML（タグの文字列）が無い', !log.some((x) => /<[a-z][^>]*>/i.test(x)));
    const keys = new Set();
    for (const x of log) { try { const o = JSON.parse(x); Object.keys(o).forEach((k) => keys.add(k)); if (o.selection) Object.keys(o.selection).forEach((k) => keys.add(`selection.${k}`)); } catch { /* 文字列 */ } }
    /* 7B-3B-2: select に doc（中継がこの文書の応答に付けた識別子。16 進 32 桁の乱数で、ページの内容を含まない）を足した */
    /* F-01: select に要素・祖先のソースの版（anchorRev・ancestorRevs。内容の sha1 の先頭16桁で、ソースもページの内容も含まない）を足した */
    const allowedKeys = ['source', 'v', 'kind', 'nonce', 'path', 'title', 'status', 'soft', 'from', 'select', 'seq', 'selection', 'doc',
      'selection.tag', 'selection.anchorOnSelf', 'selection.anchorRev', 'selection.anchorOrdinal', 'selection.anchorInstanceCount', 'selection.ancestorAnchors', 'selection.ancestorRevs',
      'selection.textNodeIndex', 'selection.valueShape', 'selection.formControl', 'selection.path'];
    ok('知らせのキーは決めたものだけ', [...keys].every((k) => allowedKeys.includes(k)), [...keys]);
    const inputSel = log.map((x) => { try { return JSON.parse(x); } catch { return null; } }).find((o) => o?.selection?.tag === 'input');
    ok('フォームの部品は値の形も送らない', inputSel && inputSel.selection.formControl === true && inputSel.selection.valueShape === null, inputSel);
  }

  /* ============================================ 7. 停止・再起動で古い選択が混ざらない */
  console.log('\n7. 停止・再起動の後に古い選択が混ざらない');
  {
    eq('前提: 選択がある', await sel('data-selection'), 'resolved');
    await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
    await waitPv('stopped', 60000);
    await waitSel('cleared', 10000);
    ok('停止したら選択を解除し、そう書く', /選択を解除しました/.test(await pv().innerText()));
    /* 7C-3（P1-9）: 停止後は前の選択も、合成デモ（別のアプリ）も描かない。プロジェクトの状態を出す */
    eq('停止したらキャンバスに経路を描かない（前の選択も合成デモも出さない）', await page.locator('g.nd').count(), 0);
    eq('停止したらキャンバスの注記はプロジェクトの空の状態（合成デモの注記に戻さない）', await page.locator('.note.synth').getAttribute('data-notice'), 'project-empty');
    ok('停止したら注記は合成デモのものではない', (await page.locator('.note.synth').innerText()) !== noticeBase);
    eq('停止したらキャンバスと右ドックは「停止しています」の状態', await page.locator('.cv-empty').getAttribute('data-project-phase'), 'stopped');
    phase.negativeApi = true;
    const staleWhileStopped = await page.evaluate(async (run) => (await fetch('/api/runtime/anchor', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: JSON.stringify({ run, selection: { tag: 'h1', anchorOnSelf: null, anchorRev: null, anchorOrdinal: null, anchorInstanceCount: 0, ancestorAnchors: [], ancestorRevs: [], textNodeIndex: null, valueShape: null, formControl: false, path: '/' } }) })).status, run1);
    eq('停止中は選択を解決しない（409）', staleWhileStopped, 409);
    await sleep(300);
    phase.negativeApi = false;
    await shot('05-stopped-cleared');

    await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
    await waitPv('live');
    await page.waitForFunction(() => Number(document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-conn')) >= 1, null, { timeout: 60000 });
    eq('起動し直した後、選択モードは切に戻る', await sel('data-select-mode'), 'off');
    const st2 = await status();
    const run2 = { instance: st2.runtime.instance, pid: st2.runtime.pid, startedAt: st2.runtime.startedAt };
    ok('前提: 別の起動（PID か開始時刻が違う）', run2.pid !== run1.pid || run2.startedAt !== run1.startedAt, { run1, run2 });
    phase.negativeApi = true;
    const stale = await page.evaluate(async (run) => {
      const r = await fetch('/api/runtime/anchor', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: JSON.stringify({ run, selection: { tag: 'h1', anchorOnSelf: null, anchorRev: null, anchorOrdinal: null, anchorInstanceCount: 0, ancestorAnchors: [], ancestorRevs: [], textNodeIndex: null, valueShape: null, formControl: false, path: '/' } }) });
      return { status: r.status, body: await r.json() };
    }, run1);
    eq('前の起動のページから来た選択は解決しない（409）', stale.status, 409);
    eq('理由は stale-run', stale.body.error?.code, 'stale-run');
    await sleep(300);
    phase.negativeApi = false;
    eq('起動し直した後、キャンバスに古い選択が残っていない（合成デモも描かない）', await page.locator('g.nd').count(), 0);
    // 選択モードを入れずにクリックしても選ばない（ページの操作として通る）
    const reqs = anchorBodies.length;
    await frame().locator('a[href="/listings"]').click();
    await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-path') === '/listings', null, { timeout: 60000 });
    eq('選択モードが切ならクリックはページの操作（リンクで移動する）', anchorBodies.length, reqs);
    await page.waitForFunction(() => {
      const el = document.querySelector('section[aria-label="プレビュー"] .pvlive');
      return el?.getAttribute('data-agent-mode') === 'off' && Number(el?.getAttribute('data-conn')) >= 2;
    }, null, { timeout: 30000 });
    await pv().locator('.rt-b', { hasText: '選択' }).click();
    await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-agent-mode') === 'on', null, { timeout: 10000 });
    const l = await pick(frame().locator('h1'), 'resolved');
    eq('リンクで移動した先のページでも正しい要素を選べる', l.at, TRUTH.listingsH1);
    eq('移動した先のコンポーネント', l.component, 'Listings');
    await shot('06-after-restart');
  }

  /* ============================================ 8. 既存の探索に戻れる */
  console.log('\n8. 解除すると経路の無い状態に戻る。合成デモは明示的に選べば探索できる（7C-3）');
  await pv().locator('.pvselrow .rt-b', { hasText: '解除' }).click();
  eq('解除すると、実行中の「まだ経路がありません」に戻る（合成デモは描かない）', JSON.stringify([await page.locator('g.nd').count(), await page.locator('.cv-empty').getAttribute('data-project-phase')]), JSON.stringify([0, 'running']));
  await page.locator('.cv-empty .pe-demo').click();
  eq('［合成デモを見る］で元のデータセットを描ける（ノード数）', await page.locator('g.nd').count(), nodesBase);
  ok('合成デモの間は、別のアプリの見本だと注記する', (await page.locator('.demo-banner').innerText()).includes('データではありません'));
  // キーボードの番号で選ぶ（03b 7章）。右上のパネルの大きさに左右されない操作で確かめる
  await page.keyboard.press('1');
  ok('元のデータセットのノードを選べる', (await page.locator('.nd.sel').count()) >= 1);
  ok('元のデータセットの経路サマリが出る', (await dockText()).includes('この値の出所'));

  eq('IDE の画面にエラーが出ていない', JSON.stringify(ideErrors), '[]');
  eq('中継が原因のエラー（CSP・差し込んだスクリプト）がプレビューの中に出ていない', JSON.stringify(gatewayErrors), '[]');
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
