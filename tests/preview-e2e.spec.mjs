/* =============================================================================
 * Phase 7B-1 — 実プレビューを、**クラウドの開発環境を模した**実ブラウザで端から端まで確かめる。
 *   npm run build && node tests/preview-e2e.spec.mjs
 *   SHOTS=docs/07b-screenshots node tests/preview-e2e.spec.mjs
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
const MARK = 'DUMMY-SECRET-7B1-E2E';

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
const phase = { expectUnreachable: false };
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

const TSCONFIG = path.join(PROJECT, 'tsconfig.json');
const TSCONFIG_BEFORE = fs.existsSync(TSCONFIG) ? fs.readFileSync(TSCONFIG, 'utf8') : null;

try {
  /* ============================================ 1. 転送 URL で IDE を開く */
  console.log('\n1. クラウドの転送 URL で IDE を開く');
  const r0 = await page.goto(`http://${IDE_HOST}/`, { waitUntil: 'networkidle' });
  eq('転送 URL で IDE の画面が開く', r0?.status(), 200);
  await page.evaluate(() => { setTimeout(() => { throw new Error('vcide-e2e-selftest'); }, 0); });
  await page.waitForTimeout(300);
  ok('（試験の自己確認）IDE の画面で起きた例外を拾える', ideErrors.some((m) => m.includes('vcide-e2e-selftest')), ideErrors);
  ideErrors.length = 0;
  eq('Phase 5 の確定 UI が出ている（N0 / キャンバス / 右ドック）',
    await page.locator('.n0').count() + await page.locator('.canvas').count() + await page.locator('.dock').count(), 3);
  const st = await page.evaluate(async () => (await fetch('/api/runtime/status')).json());
  ok('転送ホストからも IDE の API が使える（明示したホストだけ）', !!st.runtime && !st.error, st.error);
  eq('API は、このブラウザから見た中継の URL を返す', st.preview?.origin, `http://${PV_HOST}`);
  await page.waitForTimeout(800);
  ok('「IDE の API に届きませんでした」を出していない', (await rtPanel().locator('.rt-card.blocker b', { hasText: 'IDE の API' }).count()) === 0);
  eq('起動を観測するまでは、従来の見本のプレビューのまま（合成・記録データの画面を壊さない）', await pv().count(), 0);
  eq('見本のプレビューのパネルは出ている', await pvPanel().count(), 1);
  await shot('01-cloud-open');

  /* ============================================ 2. 届かない経路（否定） */
  console.log('\n2. 届かない経路（ブラウザの localhost / 許可していない名前）');
  {
    const tab = await browser.newPage();
    const a = await tab.goto(`http://127.0.0.1:${IDE_PORT}/api/runtime/status`).catch((e) => e);
    ok('ブラウザの 127.0.0.1 はサーバーに届かない（直接の iframe が成り立たない理由）',
      !(a?.status?.() === 200), a?.status?.() ?? String(a));
    const b = await tab.goto('http://rebind.cloud.test/api/runtime/status');
    eq('許可していないホスト名で同じポートに来ても、API は拒否する', b?.status(), 403);
    ok('拒否の理由は non-local-host', (await b.text()).includes('non-local-host'));
    const c = await tab.goto('http://rebind-preview.cloud.test/');
    eq('許可していないホスト名で中継に来ても拒否する（421）', c?.status(), 421);
    const d = await tab.goto(`http://${PV_HOST}/`);
    eq('開発サーバーを起動する前は、中継は転送しない（503）', d?.status(), 503);
    ok('503 は IDE の中継が作った説明', (await tab.locator('body').getAttribute('data-vcide-gateway')) === '503');
    // プレビューの origin から IDE の API を呼べないこと（プレビューの中のスクリプトに起動・停止させない）
    const e = await tab.evaluate(async (ideHost) => {
      try {
        const r = await fetch(`http://${ideHost}/api/runtime/stop`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: '{}',
        });
        return `status ${r.status}`;
      } catch (err) { return `blocked: ${err.message}`; }
    }, IDE_HOST);
    ok('プレビューの origin から IDE の停止 API は呼べない', !/status 200/.test(e), e);
    await tab.close();
  }

  /* ========================================= 3. 指定して起動 → 実プレビュー */
  console.log('\n3. fixture-app を指定して起動し、実ページを既存のプレビューパネルに出す');
  await rtPanel().locator('#rt-path').fill(PROJECT);
  await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((p) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === p, PROJECT, { timeout: 20000 });
  ok('検出の判定が出る（対応 / 部分対応）', ['対応', '部分対応'].includes(await rtPanel().locator('.rt-vd').innerText()));
  // プレビューの状態の移り変わりを記録する（取りこぼさないよう DOM の変化で拾う）
  await page.evaluate(() => {
    window.__pvStates = [];
    const rec = () => {
      const s = document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') ?? 'synthetic';
      const r = document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-st b')?.textContent ?? '';
      const last = window.__pvStates[window.__pvStates.length - 1];
      if (!last || last.s !== s || last.r !== r) window.__pvStates.push({ s, r, iframe: !!document.querySelector('iframe.pvframe') });
    };
    new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    rec();
  });
  forwardLog.length = 0;
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  const states = await page.evaluate(() => window.__pvStates);
  ok('起動中は「起動中」の表示を通る（応答を確認する前に iframe を置かない）',
    states.some((x) => x.s === 'starting' && !x.iframe), states);
  ok('iframe を置いたとき、実行状態は「実行中」', states.filter((x) => x.iframe).every((x) => x.r === '実行中'), states);
  eq('実行状態は「実行中」', await rtState(), '実行中');
  const src = await pv().locator('iframe.pvframe').getAttribute('src');
  ok('iframe は中継の転送 URL を開く（開発サーバーの 127.0.0.1 を使わない）', src?.startsWith(`http://${PV_HOST}/`), src);
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-http-status') === '200', null, { timeout: 60000 });
  ok('実ページが表示される（fixture-app の見出し）', (await frame().locator('h1').innerText({ timeout: 30000 })).includes('PoC-01 Fixture'));
  eq('HTTP の状態を表示する（200）', await pv().getAttribute('data-http-status'), '200');
  eq('開発サーバーのページだと示す', await pv().getAttribute('data-from'), 'app');
  ok('フッターに HTTP 200 とパスを出す', /HTTP 200/.test(await pvPanel().locator('.pvfoot').innerText()));
  eq('パネルの位置と幅は既存のまま（新しい画面を作らない）', JSON.stringify(await pvPanel().evaluate((el) => [el.style.left, el.style.top, el.style.width])), JSON.stringify(['232px', '16px', '392px']));
  const devPort = Number((await page.evaluate(async () => (await fetch('/api/runtime/status')).json())).runtime.port);
  ok('ブラウザは開発サーバーのポートに直接行っていない', !forwardLog.some((x) => x.host.includes(`:${devPort}`)), forwardLog.filter((x) => x.host.includes(String(devPort))));
  ok('プレビューの通信はすべて中継の転送 URL を通っている', forwardLog.some((x) => x.host === PV_HOST && x.path.startsWith('/_next/')), forwardLog.slice(0, 5));
  await shot('02-live-preview');

  /* HMR の WebSocket が中継を通ってつながる */
  await page.waitForTimeout(3000);
  const hmr = sockets.find((s) => s.url.startsWith(`ws://${PV_HOST}/_next/`));
  ok('HMR の WebSocket は中継の転送 URL でつながる', !!hmr, sockets.map((s) => s.url));
  ok('HMR の WebSocket がメッセージを受け取る', (hmr?.frames ?? 0) > 0, hmr);
  eq('HMR の WebSocket に接続エラーが無い', hmr?.error ?? null, null);

  /* ================================================ 4. ページ移動・再読み込み */
  console.log('\n4. ページ移動・再読み込み');
  let n = await loadsNow();
  await frame().locator('a[href="/listings"]').click();
  await waitLoads(n);
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-path') === '/listings', null, { timeout: 60000 });
  eq('プレビューの中のリンクで移動できる', await frame().locator('h1').innerText({ timeout: 30000 }), '物件一覧');
  eq('移動先のパスが入力欄に出る', await pv().locator('input[aria-label="プレビューのパス"]').inputValue(), '/listings');
  eq('移動先の HTTP 状態（200）', await pv().getAttribute('data-http-status'), '200');

  n = await loadsNow();
  await pv().locator('input[aria-label="プレビューのパス"]').fill('/no-such-page-7b1');
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  await waitLoads(n);
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-path') === '/no-such-page-7b1', null, { timeout: 60000 });
  eq('存在しないページ: HTTP 404 を表示する', await pv().getAttribute('data-http-status'), '404');
  ok('存在しないページ: 「ページが見つかりません」と書く', /404.*ページが見つかりません/.test(await pvPanel().locator('.pvfoot').innerText()), await pvPanel().locator('.pvfoot').innerText());
  eq('存在しないページ: 404 は開発サーバーの応答（中継の説明ではない）', await pv().getAttribute('data-from'), 'app');
  ok('存在しないページ: 開発サーバーの 404 ページが中に出ている', /404/.test(await frame().locator('body').innerText({ timeout: 30000 })));
  await shot('03-not-found');

  const srcBefore = await pv().locator('iframe.pvframe').getAttribute('src');
  await pv().locator('input[aria-label="プレビューのパス"]').fill('http://evil.example/');
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  ok('別の origin の URL は開かない（理由を出す）', (await pv().locator('.pvwarn').innerText()).includes('/ で始まる'));
  eq('iframe の URL は変わらない', await pv().locator('iframe.pvframe').getAttribute('src'), srcBefore);

  await pv().locator('input[aria-label="プレビューのパス"]').fill('/');
  n = await loadsNow();
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  await waitLoads(n);
  eq('入力欄からトップへ戻れる', await frame().locator('h1').innerText({ timeout: 30000 }).then((t) => t.includes('PoC-01 Fixture')), true);
  n = await loadsNow();
  await pv().locator('button[aria-label="再読み込み"]').click();
  await waitLoads(n);
  eq('再読み込みできる（同じパスをもう一度読み込む）', await pv().getAttribute('data-path'), '/');
  ok('再読み込みの後も表示される', (await frame().locator('h1').innerText({ timeout: 30000 })).includes('PoC-01 Fixture'));

  /* ============================================= 5. 起動先の環境変数 */
  console.log('\n5. 秘密情報が起動先へ渡らない（IDE にダミーを入れて起動した）');
  {
    const s = await page.evaluate(async () => (await fetch('/api/runtime/status')).json());
    const ideEnv = environOf(ide.pid) ?? '';
    ok('前提: IDE のプロセスにはダミーの秘密情報が入っている', ideEnv.includes(MARK));
    const pids = groupPids(s.runtime.pid);
    ok('開発サーバーのプロセス（グループ）を見つける', pids.length >= 1, pids);
    for (const pid of pids) {
      const e = environOf(pid);
      if (e === null) continue;
      ok(`PID ${pid}: どの値にもダミーの秘密情報が無い`, !e.includes(MARK));
      const names = e.split('\0').map((kv) => kv.split('=')[0]);
      ok(`PID ${pid}: 秘密情報の名前（${Object.keys(DUMMY_SECRETS).length} 個）を1つも受け取っていない`,
        !Object.keys(DUMMY_SECRETS).some((k) => names.includes(k)), names.filter((k) => k in DUMMY_SECRETS));
      ok(`PID ${pid}: IDE の設定（VCIDE_*）を受け取っていない`, !names.some((k) => k.startsWith('VCIDE_')));
    }
    ok('画面に「渡した数・渡していない数」を出す', /個を渡しました/.test(await rtPanel().locator('.rt-env').innerText()));
    const html = await (await browser.newPage()).goto(`http://${PV_HOST}/`).then((r) => r.text());
    ok('プレビューのページにダミーの秘密情報が出ない', !html.includes(MARK));
  }

  /* ============================================= 6. 通信失敗の表示 */
  console.log('\n6. 通信の失敗（転送が途切れた / 開発サーバーが落ちた）');
  fwd.blockPreview = true;
  phase.expectUnreachable = true;
  await pv().locator('button[aria-label="再読み込み"]').click();
  await waitPv('unreachable', 30000);
  ok('転送が途切れたら「ブラウザから中継に届きません」と出す',
    (await pv().locator('.rt-card b').innerText()).includes(`このブラウザからプレビューの中継（http://${PV_HOST}）に届きませんでした`));
  eq('届かない間は iframe を置かない', await pv().locator('iframe').count(), 0);
  eq('開発サーバー自体は実行中のまま（プレビューの失敗とプロセスの状態を混ぜない）', await rtState(), '実行中');
  await shot('04-unreachable');
  fwd.blockPreview = false;
  await pv().locator('.rt-b', { hasText: 'もう一度確かめる' }).click();
  await waitPv('live', 30000);
  phase.expectUnreachable = false;
  ok('転送が戻れば、もう一度確かめて表示に戻る', (await frame().locator('h1').innerText({ timeout: 30000 })).includes('PoC-01 Fixture'));

  {
    const s = await page.evaluate(async () => (await fetch('/api/runtime/status')).json());
    const pgid = s.runtime.pid;
    process.kill(-pgid, 'SIGKILL');
    // 状態の取得（3 秒間隔）より先に、プレビューの中で再読み込みする
    await pv().locator('button[aria-label="再読み込み"]').click().catch(() => { /* 既に切り替わっていてもよい */ });
    const gotFailurePage = await page.waitForFunction(() => {
      const el = document.querySelector('section[aria-label="プレビュー"] .pvlive');
      return el?.getAttribute('data-from') === 'gateway' || el?.getAttribute('data-preview-state') === 'error';
    }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    ok('開発サーバーが落ちたら、中継の説明か「起動できていません」を出す', gotFailurePage);
    await waitPv('error', 30000);
    eq('実行状態は「起動できていません」', await rtState(), '起動できていません');
    ok('プレビューは落ちたことを書く', /終了しました/.test(await pv().locator('.rt-card b').innerText()), await pv().locator('.rt-card b').innerText());
    eq('落ちた後は iframe を置かない', await pv().locator('iframe').count(), 0);
    const tab = await browser.newPage();
    const r = await tab.goto(`http://${PV_HOST}/`);
    eq('落ちた後は、中継も転送しない（503）', r?.status(), 503);
    await tab.close();
    await shot('05-crashed');
  }

  /* ============================================= 7. 起動し直す・停止する */
  console.log('\n7. 起動し直す・停止する');
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await waitPv('live');
  ok('起動し直すと実プレビューに戻る（最初のページから）', (await frame().locator('h1').innerText({ timeout: 60000 })).includes('PoC-01 Fixture'));
  await page.evaluate(() => { window.__pvStates = []; });
  await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
  await waitPv('stopped', 60000);
  eq('停止すると実行状態は「停止しています」', await rtState(), '停止しています');
  eq('停止するとプレビューも停止状態になる（iframe を置かない）', await pv().locator('iframe').count(), 0);
  ok('プレビューは停止していることを書く', (await pv().innerText()).includes('開発サーバーは停止しています'));
  const stopStates = await page.evaluate(() => window.__pvStates);
  ok('停止の途中で iframe を残さない', stopStates.every((x) => !x.iframe || x.r === '実行中'), stopStates);
  {
    const tab = await browser.newPage();
    const r = await tab.goto(`http://${PV_HOST}/listings`);
    eq('停止後は中継も転送しない（503）', r?.status(), 503);
    await tab.close();
  }
  await shot('06-stopped');

  /* ============================================= 8. ループバックで開いたとき */
  console.log('\n8. 同じ機械のブラウザ（ループバック）で開いたとき');
  {
    const local = await chromium.launch(CHANNEL === 'none' ? {} : { channel: CHANNEL });
    const lp = await local.newPage();
    await lp.goto(`http://127.0.0.1:${IDE_PORT}/`, { waitUntil: 'networkidle' });
    const s = await lp.evaluate(async () => (await fetch('/api/runtime/status')).json());
    eq('ループバックの IDE には、ループバックの中継の URL を返す', s.preview?.origin, `http://127.0.0.1:${GW_PORT}`);
    await local.close();
  }

  eq('IDE の画面にエラーが出ていない', JSON.stringify(ideErrors), '[]');
  eq('中継が原因のエラー（CSP・差し込んだスクリプト）がプレビューの中に出ていない', JSON.stringify(gatewayErrors), '[]');
  if (TSCONFIG_BEFORE !== null) eq('対象の tsconfig.json は変わっていない', fs.readFileSync(TSCONFIG, 'utf8'), TSCONFIG_BEFORE);
} finally {
  // 後片付け: 起動したままなら止める
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
