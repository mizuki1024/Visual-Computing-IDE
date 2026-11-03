/* =============================================================================
 * 7C HMR 安全対策の実ブラウザ試験の共通部分（試験ではない。tests/hmr-*-e2e.spec.mjs が読む）。
 *
 * 実ブラウザ・実際の IDE（next start）・実際の開発サーバー（next dev・Turbopack・server fast refresh は既定のまま）・
 * 実際の HMR・実 DB。題材は**使い捨てのコピー**（poc/out/<name>/poc/fixture-app、Git 管理外）に、
 * 試験ごとの一時的なページを足したもの（IDE の中の poc/fixture-app は変えない）。
 * 転送役・画面の操作は docs/07c-hmr-lineage-safety-results/hmr-misattribution-e2e.mjs と同じ（そこから複写した）。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '..');
const SRC_FIXTURE = path.join(REPO, 'poc', 'fixture-app');
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const IDE_HOST = 'ide.cloud.test';
const PV_HOST = 'preview.cloud.test';
const POSTH = { 'content-type': 'application/json', 'x-vcide-request': '1' };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 試験の前提が揃っているか（揃っていなければ skip の理由） */
export function skipReason() {
  if (!fs.existsSync(path.join(REPO, '.next', 'BUILD_ID'))) return 'IDE がビルドされていない（.next/BUILD_ID が無い）。先に npm run build';
  if (!fs.existsSync(path.join(REPO, '.libjs', 'lib', 'adapter.js'))) return '.libjs が無い。先に npm run build:lib';
  if (!fs.existsSync(path.join(SRC_FIXTURE, 'node_modules', 'next', 'dist', 'bin', 'next'))) return `${SRC_FIXTURE} に next がインストールされていない`;
  return null;
}

export function results() {
  let pass = 0;
  const fails = [];
  const log = [];
  const ok = (name, cond, got) => {
    log.push({ name, pass: !!cond, ...(cond ? {} : { got }) });
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
  };
  const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);
  const note = (s) => { console.log(`    · ${s}`); log.push({ note: s }); };
  return { ok, eq, note, log, fails, get pass() { return pass; } };
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

/**
 * 使い捨ての題材を作り、IDE・転送役・ブラウザを起動する。
 * @param {{name: string, files: Record<string,string>, shots?: string|null, portBase?: number}} o
 */
export async function startHarness({ name, files, shots = null, portBase = 3800 }) {
  const WORK = path.join(REPO, 'poc', 'out', name);
  const PROJECT = path.join(WORK, 'poc', 'fixture-app');
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK, 'poc'), { recursive: true });
  fs.cpSync(path.join(REPO, 'poc', 'anchor'), path.join(WORK, 'poc', 'anchor'), { recursive: true });
  fs.cpSync(SRC_FIXTURE, PROJECT, {
    recursive: true,
    filter: (src) => { const rel = path.relative(SRC_FIXTURE, src).split(path.sep); return rel[0] !== 'node_modules' && rel[0] !== '.next'; },
  });
  execFileSync('cp', ['-al', path.join(SRC_FIXTURE, 'node_modules'), path.join(PROJECT, 'node_modules')]);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(PROJECT, rel)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT, rel), text);
  }
  const ORIGINAL = new Map();
  const srcOf = (rel) => fs.readFileSync(path.join(PROJECT, rel), 'utf8');
  const put = (rel, text) => { if (!ORIGINAL.has(rel)) ORIGINAL.set(rel, srcOf(rel)); fs.writeFileSync(path.join(PROJECT, rel), text); };
  const restore = (rel) => { if (ORIGINAL.has(rel)) fs.writeFileSync(path.join(PROJECT, rel), ORIGINAL.get(rel)); };
  /** needle を含む行の `pool.query(` の位置（列は query の q）— 題材のソースから決める正解 */
  const callOf = (rel, needle) => {
    const lines = srcOf(rel).split('\n');
    const i = lines.findIndex((l) => l.includes(needle));
    return i < 0 ? null : `${rel}:${i + 1}:${lines[i].indexOf('pool.query(') + 'pool.'.length + 1}`;
  };
  const elOf = (rel, field) => {
    const l = srcOf(rel).split('\n');
    const i = l.findIndex((x) => x.includes(`data-poc-field="${field}"`));
    return `${rel}:${i + 1}:${l[i].indexOf('<p') + 1}`;
  };

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

  /* ---------------------------------------------------------------- IDE */
  const IDE_PORT = await freePort(portBase);
  const GW_PORT = await freePort(portBase + 60);
  const ide = spawn(process.execPath, [path.join(REPO, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(IDE_PORT), '-H', '127.0.0.1'], {
    cwd: REPO,
    env: { ...process.env, VCIDE_ALLOWED_HOSTS: IDE_HOST, VCIDE_PREVIEW_ORIGIN: `http://${PV_HOST}`, VCIDE_PREVIEW_PORT: String(GW_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let ideOut = '';
  ide.stdout.on('data', (d) => { ideOut += d; });
  ide.stderr.on('data', (d) => { ideOut += d; });
  const killIde = () => { try { process.kill(-ide.pid, 'SIGTERM'); } catch { /* 終わっている */ } };
  process.on('exit', killIde);
  for (let i = 0; ; i++) {
    const up = await new Promise((r) => {
      http.get({ host: '127.0.0.1', port: IDE_PORT, path: '/api/runtime/status' }, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false));
    });
    if (up) break;
    if (i > 120) { console.log(ideOut); throw new Error('IDE が起動しませんでした'); }
    await sleep(250);
  }

  /* ------------------------------------------------ 転送役（クラウドのポート転送を模す） */
  const MAP = { [IDE_HOST]: IDE_PORT, [PV_HOST]: GW_PORT };
  const FWD_PORT = await freePort(portBase + 120);
  const forwarder = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const port = MAP[u.hostname];
    if (!port || u.port) { res.writeHead(502); res.end(); return; }
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: u.pathname + u.search, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  forwarder.on('connect', (req, sock) => {
    const [h, p] = req.url.split(':');
    const port = MAP[h];
    if (!port || p !== '80') { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = net.connect(port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
    up.on('end', () => sock.end());
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  await new Promise((r) => forwarder.listen(FWD_PORT, '127.0.0.1', r));

  const browser = await chromium.launch({
    ...(CHANNEL === 'none' ? {} : { channel: CHANNEL }),
    args: [`--proxy-server=http://127.0.0.1:${FWD_PORT}`, '--proxy-bypass-list=<-loopback>'],
  });
  console.log(`ブラウザ: ${CHANNEL === 'none' ? '同梱の chromium' : `channel ${CHANNEL}`} ${browser.version()} / 題材（使い捨てのコピー）: ${path.relative(REPO, PROJECT)}`);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const ideErrors = [];
  await page.exposeFunction('__ideError', (m) => { ideErrors.push(m); });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.addEventListener('error', (e) => { window.__ideError?.(String(e.message)); });
  });

  const LIB = createRequire(path.join(REPO, '.libjs', 'lib', 'adapter.js'))('./adapter.js');
  const exchangeSqlIds = (obs, seq) => {
    const ex = obs?.exchanges?.find((e) => e.seq === seq);
    return new Set(ex ? LIB.liveExchangeLinks(obs, ex).sql.map((sp) => sp.spanId) : []);
  };
  /** 由来の評価の応答（画面が受け取ったもの）。行データ・絶対パスは含まない形だけを記録に残す */
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
      const sqlText = (id) => String(j.observation?.spans?.find((s) => s.spanId === id)?.attrs?.['db.statement'] ?? '').slice(0, 60);
      Object.assign(rec, {
        lineage: l?.status ?? null, cut: l?.cut?.reason ?? null, cutDetail: l?.cut?.detail?.slice(0, 200) ?? null,
        candidates: (l?.candidates ?? []).map((c) => `${c.schema}.${c.table}.${c.column}`),
        fetch: l?.fetch ? `${l.fetch.file}:${l.fetch.line}:${l.fetch.col}` : null,
        exchangeSeq: l?.exchangeSeq ?? null, binding: l?.binding?.status ?? null,
        dataAccess: (j.observation?.dataAccess ?? []).filter((d) => exchangeSqlIds(j.observation, l?.exchangeSeq ?? l?.binding?.seq).has(d.spanId)).map((d) => ({
          spanId: d.spanId, sql: sqlText(d.spanId),
          site: d.site ? `${d.site.file}:${d.site.line}:${d.site.col}` : null,
          located: d.located ? `${d.located.file}:${d.located.line}:${d.located.col}` : null,
          failure: d.failure ? d.failure.reason : null,
        })),
      });
    } catch (e) { rec.parseError = String(e).slice(0, 120); }
  });

  /* ------------------------------------------------------------ 画面の操作 */
  const rtPanel = () => page.locator('.fpnl[aria-label="プロジェクトと実行"]');
  const pv = () => page.locator('section[aria-label="プレビュー"] .pvlive');
  const frame = () => page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe');
  const sel = (attr) => pv().getAttribute(attr, { timeout: 3000 }).catch(() => null);
  const dockText = () => page.locator('aside.dock').innerText().catch(() => '');
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
  /** パスへ移動する。wait=false なら移動を押すだけ（要求の処理中の変更を試すため） */
  const gotoPath = async (p, { wait = true } = {}) => {
    const n = await loadsNow();
    await pv().locator('input[aria-label="プレビューのパス"]').fill(p);
    await pv().locator('.rt-b', { hasText: '移動' }).click();
    if (!wait) return n;
    await until(async () => (await loadsNow()) > n, 60000);
    await until(async () => (await sel('data-path')) === p, 60000);
    await until(async () => (await sel('data-select-mode')) === (await sel('data-agent-mode')), 30000);
    return n;
  };
  const waitLoaded = async (n, p) => {
    await until(async () => (await loadsNow()) > n, 90000);
    await until(async () => (await sel('data-path')) === p, 60000);
    await until(async () => (await sel('data-select-mode')) === (await sel('data-agent-mode')), 30000);
  };
  /** 選択モードで要素を選び、由来の評価が終わる（linked / cut）か、選択が解決しない、まで待つ */
  async function pick(css, { want = null, timeout = 45000 } = {}) {
    await selectMode(true);
    const n = anchorCalls.length;
    const m = linResponses.length;
    await frame().locator(css).first().click({ timeout: 30000 });
    await until(() => anchorCalls.length > n, 20000, 50);
    await until(async () => ['resolved', 'unresolved', 'error'].includes(await sel('data-selection')), 30000, 50);
    if ((await sel('data-selection')) === 'resolved') {
      await until(async () => {
        const st = await sel('data-lineage');
        return linResponses.length > m && st && (!want || st === want);
      }, timeout, 250);
    }
    await until(async () => ['linked', 'cut'].includes(await sel('data-lineage')), 10000, 250);
    await selectMode(false);
    await page.waitForTimeout(800);
    const d = await dockText();
    const k = d.indexOf('この値の出所');
    /* この選択で届いた由来の評価の応答だけ（選択が解決しなければ前の応答を使わない） */
    const last = linResponses.length > m ? linResponses.at(-1) : null;
    return {
      selection: await sel('data-selection'), at: await sel('data-sel-at'),
      lineage: await sel('data-lineage'), lineageReason: await sel('data-lineage-reason'), cands: await sel('data-lineage-cands'),
      docBinding: await sel('data-doc-binding'),
      dock: d,
      dockOrigin: k >= 0 ? d.slice(k, k + 80).replace(/\s+/g, ' ') : null,
      labels: await nodeLabels(),
      response: last,
    };
  }
  const startProject = async () => {
    await page.goto(`http://${IDE_HOST}/`, { waitUntil: 'networkidle' });
    await rtPanel().locator('#rt-path').fill(PROJECT);
    await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
    await page.waitForFunction((p) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === p, PROJECT, { timeout: 20000 });
    await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
    await waitPv('live');
    await until(async () => Number(await sel('data-conn')) >= 1, 60000);
    return status();
  };
  const restartDev = async () => {
    await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
    await waitPv('stopped', 60000);
    await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
    await waitPv('live');
    await until(async () => Number(await sel('data-conn')) >= 1, 60000);
    return status();
  };
  const runOf = (st) => ({ instance: st.runtime.instance, pid: st.runtime.pid, startedAt: st.runtime.startedAt });
  /** 観測の全件（試験は証拠を直接確かめる。画面は要約＋選んだ通信の証拠だけを受け取る） */
  const obsOf = async () => {
    const st = await status();
    const r = await page.evaluate(async ({ run, h }) => {
      const x = await fetch('/api/runtime/observations', { method: 'POST', headers: h, body: JSON.stringify({ run, detail: 'all' }) });
      return { status: x.status, text: await x.text() };
    }, { run: runOf(st), h: POSTH });
    return r.status === 200 ? JSON.parse(r.text).observation ?? null : null;
  };
  /** 一覧から通信を選んで［表示］（観測画面のキャンバスに描く） */
  const obsRow = () => pv().locator('.pvobsrow');
  async function showExchange(seq) {
    /* HMR による iframe の再描画で表示が解除されることがある（選択の無い観測の表示は読み込みで解く）。3 回までやり直す */
    for (let i = 0; ; i++) {
      await obsRow().locator('select').selectOption(String(seq));
      await obsRow().locator('.rt-b', { hasText: '表示' }).click();
      const shown = await page.waitForFunction((s) => document.querySelector('.pvobsrow')?.getAttribute('data-obs-shown') === String(s), seq, { timeout: 10000 }).then(() => true, () => false);
      await page.waitForTimeout(800);
      if (shown && (await obsRow().getAttribute('data-obs-shown')) === String(seq)) return;
      if (i >= 2) throw new Error(`通信 #${seq} をキャンバスに表示できませんでした`);
      await sleep(1500);
    }
  }
  /** その通信の SQL ごとの照合の結果（SQL 文の頭・特定した位置・理由） */
  const sqlOf = (obs, seq) => {
    const ids = exchangeSqlIds(obs, seq);
    return (obs?.dataAccess ?? []).filter((d) => ids.has(d.spanId)).map((d) => ({
      sql: String(obs.spans.find((s) => s.spanId === d.spanId)?.attrs?.['db.statement'] ?? '').slice(0, 60),
      site: d.site ? `${d.site.file}:${d.site.line}:${d.site.col}` : null,
      located: d.located ? `${d.located.file}:${d.located.line}:${d.located.col}` : null,
      failure: d.failure?.reason ?? null,
    }));
  };
  /** 画面と同じ変換（fromLiveRun）で、その通信の SQL のノードの「実行した呼び出し位置」の行 */
  const sqlRows = (obs, seq) => LIB.fromLiveRun(obs, seq, {}).dataset.nodes.filter((n) => n.kind === 'sql')
    .map((n) => ({ sql: n.identifier, row: n.overview.find((r) => r.k === '実行した呼び出し位置')?.v ?? null }));
  const shot = async (n) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${n}.png`) }); } };

  async function cleanup(r) {
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
    r.ok('後片付け: 使い捨ての題材で動くプロセスが残っていない', leftover === '', leftover);
    fs.rmSync(WORK, { recursive: true, force: true });
  }

  return {
    PROJECT, page, ideErrors, linResponses, put, restore, srcOf, callOf, elOf, dbReachable, startProject, restartDev,
    gotoPath, waitLoaded, pick, obsOf, showExchange, sqlOf, sqlRows, nodeLabels, dockText, shot, cleanup, sel, until,
  };
}
