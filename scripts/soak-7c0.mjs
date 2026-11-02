/* =============================================================================
 * Phase 7C-0 — 長時間起動の計測（上限つき）。記録用のスクリプトで、試験ではない。
 *   BASE=http://127.0.0.1:3100 node scripts/soak-7c0.mjs
 *
 * IDE の画面から題材を起動し、プレビューの中継へ一定の速さで要求を送り続ける。
 * 区切りごとに、収集ファイルの量・観測 API の応答時間と大きさ・セッションの件数を記録する。
 * 途中（通信の上限 200 件を超えた後）で、画面から要素を選んで文書の同定が成り立つかを見る。
 *   VCIDE_SOAK_TOTAL  送る要求の数（既定 1500）
 *   VCIDE_SOAK_RPS    1 秒あたりの要求（既定 5。並列にしない）
 *   VCIDE_SOAK_OUT    記録の JSON
 *
 * Phase 7C-1 で足したこと（P0-1・P1-8 の確認。7C-0 の手順はそのまま）
 *   - 観測 API の大きさを3通りで測る: 全件（detail: 'all'。7C-0 までと同じ形）／画面と同じ取得
 *     （要約＋最新の通信の詳細）／変化なし（指紋が同じ）。**画面が実際に受け取ったバイト数**も数える
 *   - 選択のたびに、同定した通信が「いま iframe に表示している文書の識別子を持つ通信」であり、
 *     由来に使った SQL がすべてその通信のトレースのものであること（誤接続が無いこと）を確かめる
 *   - 保持範囲から外れた文書を選ぶと「保持対象外」（exchange-evicted）と理由が出ること
 *   - 停止・開発サーバーの異常終了・再起動の後に、前の起動の観測・収集ファイルが混ざらないこと
 *   - IDE のプロセス木の PSS（VCIDE_SOAK_IDE_PID）と、収集ファイルのディレクトリの量
 *   VCIDE_SOAK_PICKS   選ぶ区切り（既定 "250"。最後にも必ず選ぶ）
 *   VCIDE_SOAK_PHASES  "main,evicted,lifecycle"（既定すべて）
 *   VCIDE_SOAK_IDE_PID IDE（next start）の PID。あれば PSS を記録する
 * ========================================================================== */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const PROJECT = process.env.VCIDE_ACC_PROJECT ?? path.join(REPO, 'poc', 'fixture-app');
const TOTAL = Number(process.env.VCIDE_SOAK_TOTAL ?? 1500);
const RPS = Number(process.env.VCIDE_SOAK_RPS ?? 5);
const OUT = process.env.VCIDE_SOAK_OUT ?? null;
const PICKS = new Set((process.env.VCIDE_SOAK_PICKS ?? '250').split(',').map(Number).filter(Boolean));
const PHASES = new Set((process.env.VCIDE_SOAK_PHASES ?? 'main,evicted,lifecycle').split(','));
const IDE_PID = Number(process.env.VCIDE_SOAK_IDE_PID ?? 0) || null;
const PATHS = ['/lin-a', '/rsc-db', '/api/listings', '/lin-c', '/rsc-parallel'];
const SPAN_DIR = path.join(REPO, '.ide-runtime', 'spans');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = { startedAt: new Date().toISOString(), total: TOTAL, rps: RPS, points: [], picks: [], checks: [], lifecycle: [] };
const check = (name, cond, got) => { rec.checks.push({ name, ok: !!cond, got: got ?? null }); console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ` — got: ${JSON.stringify(got)}`}`); };

/* ---------------------------------------------------------------- 資源 */
/** プロセス木の PSS（MB）。`exclude` の部分木（IDE が起動した開発サーバー）は数えない */
function treePss(root, exclude = null) {
  if (!root) return null;
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const pp = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]); (kids.get(pp) ?? kids.set(pp, []).get(pp)).push(Number(d)); } catch { /* 消えた */ }
  }
  let kb = 0;
  const st = [root];
  while (st.length) {
    const p = st.pop();
    if (p === exclude) continue;
    try { kb += Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'))?.[1] ?? 0); } catch { /* 消えた */ }
    st.push(...(kids.get(p) ?? []));
  }
  return Math.round(kb / 1024);
}
const spanDir = () => {
  try { const fsx = fs.readdirSync(SPAN_DIR).filter((n) => n.endsWith('.jsonl')); return { files: fsx.length, mb: +(fsx.reduce((n, f) => n + fs.statSync(path.join(SPAN_DIR, f)).size, 0) / 1048576).toFixed(1), names: fsx }; }
  catch { return { files: 0, mb: 0, names: [] }; }
};

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL === 'none' ? undefined : 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
/* 7C-1: 画面（IDE のスクリプト）が観測 API から実際に受け取ったバイト数。スクリプト自身の取得（x-soak）は除く */
const uiTraffic = { bytes: 0, responses: 0, unchanged: 0 };
let lastLineage = null;
page.on('response', async (r) => {
  const u = r.url();
  if (u.endsWith('/api/runtime/lineage') && r.request().method() === 'POST') { try { lastLineage = await r.json(); } catch { /* 読めない */ } }
  if (!u.endsWith('/api/runtime/observations') || r.request().headers()['x-soak']) return;
  try { const b = await r.body(); uiTraffic.bytes += b.length; uiTraffic.responses += 1; if (b.length < 200 && b.includes('"unchanged":true')) uiTraffic.unchanged += 1; } catch { /* 読めない */ }
});
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const rt = page.locator('.fpnl[aria-label="プロジェクトと実行"]');
const pv = () => page.locator('section[aria-label="プレビュー"] .pvlive');
const status = () => page.evaluate(async () => (await fetch('/api/runtime/status')).json());
const runOf = (s) => ({ instance: s.runtime.instance, pid: s.runtime.pid, startedAt: s.runtime.startedAt });
async function startRun() {
  await rt.locator('#rt-path').fill(PROJECT);
  await rt.locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((x) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === x, PROJECT, { timeout: 30000 });
  await rt.locator('.rt-b.go', { hasText: '起動する' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') === 'live', null, { timeout: 240000 });
  return status();
}
async function stopRun() {
  await rt.locator('.rt-b', { hasText: '停止する' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') === 'stopped', null, { timeout: 60000 });
}
let st = await startRun();
let run = runOf(st);
let origin = st.preview.origin;
let spanFile = st.runtime.instrumentation.spanFile;
console.log(`起動: PID ${run.pid} / 中継 ${origin} / 収集 ${spanFile}`);

const obsCall = (body) => page.evaluate(async (body) => {
  const res = await fetch('/api/runtime/observations', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1', 'x-soak': '1' }, body: JSON.stringify(body) });
  const text = await res.text();
  return { bytes: text.length, j: JSON.parse(text) };
}, body);

async function obsPoint(sent) {
  /* 画面と同じ取得を先に測る（収集ファイルの差分の読み取りは、先に呼んだ側にかかる） */
  const t2 = performance.now();
  const ui0 = await obsCall({ run, detail: [], pin: [] });
  const firstMs = Math.round(performance.now() - t2);
  const newest = ui0.j.observation?.exchanges.at(-1)?.seq ?? null;
  const t1 = performance.now();
  const ui = await obsCall({ run, detail: newest ? [newest] : [], pin: [] });
  const uiMs = Math.round(performance.now() - t1);
  const t0 = performance.now();
  const all = await obsCall({ run, detail: 'all' });
  const apiMs = Math.round(performance.now() - t0);
  const o = all.j.observation;
  const same = await obsCall({ run, detail: newest ? [newest] : [], pin: [], etag: ui.j.observation?.etag ?? null });
  const r = o?.session.retention;
  const p = {
    sent, t: Date.now(), apiMs, uiMs, firstMs,
    bytesAll: all.bytes, bytesUi: ui.bytes, bytesUnchanged: same.bytes, unchanged: !!same.j.unchanged,
    recorded: o?.session.recorded ?? null, exchanges: o?.exchanges.length ?? null, evicted: r?.evicted ?? null,
    retainedSpans: r?.retainedSpans ?? null, spanRecords: o?.instrumentation.spanRecords ?? null, spansAll: o?.spans.length ?? null,
    truncated: o?.instrumentation.truncated ?? null, budgetEvicted: r?.spanBudgetEvicted ?? null,
    spanFileBytes: (() => { try { return fs.statSync(spanFile).size; } catch { return null; } })(),
    spanDirMB: spanDir().mb, idePssMB: treePss(IDE_PID, run.pid), devPssMB: treePss(run.pid),
    uiBytesTotal: uiTraffic.bytes, uiResponses: uiTraffic.responses, uiUnchanged: uiTraffic.unchanged,
  };
  rec.points.push(p);
  console.log(JSON.stringify(p));
  return p;
}

const docTokenNow = () => page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe').locator('script[data-vcide-doc]').first().getAttribute('data-vcide-doc', { timeout: 5000 }).catch(() => null);
async function gotoPath(p) {
  const n = Number(await pv().getAttribute('data-loads'));
  await pv().locator('input[aria-label="プレビューのパス"]').fill(p);
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  await page.waitForFunction((k) => Number(document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-loads')) > k, n, { timeout: 60000 });
}
async function selectField(field) {
  if ((await pv().getAttribute('data-select-mode')) !== 'on') await pv().locator('.rt-b', { hasText: '選択' }).click();
  await sleep(500);
  lastLineage = null;
  await page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe').locator(`li[data-poc-field="${field}"]`).first().click();
  const t0 = Date.now();
  /* 一時的な未観測（応答を送り終える前など）の取り直しが落ち着くまで待つ */
  for (;;) {
    const l = await pv().getAttribute('data-lineage');
    if (l === 'linked' || (l && Date.now() - t0 > 9000) || Date.now() - t0 > 20000) break;
    await sleep(250);
  }
  await sleep(500);
  const x = {
    binding: await pv().getAttribute('data-doc-binding'), docSeq: Number(await pv().getAttribute('data-doc-seq')) || null,
    lineage: await pv().getAttribute('data-lineage'), reason: await pv().getAttribute('data-lineage-reason'),
    cands: await pv().getAttribute('data-lineage-cands'), line: await pv().locator('.pvlin').innerText().catch(() => ''),
    ms: Date.now() - t0,
  };
  await pv().locator('.rt-b', { hasText: '選択' }).click();
  return x;
}

async function pickNow(label) {
  await gotoPath('/lin-a');
  await sleep(800);
  const token = await docTokenNow();
  const x = { label, ...(await selectField('a-region')) };
  /* 誤接続が無いこと: 同定した通信 = iframe の文書の識別子を持つ通信。由来の SQL = その通信のトレースのもの */
  const full = (await obsCall({ run, detail: 'all' })).j.observation;
  const ex = full?.exchanges.find((e) => e.seq === x.docSeq);
  x.docMatches = !!ex && ex.docToken === token && ex.path === '/lin-a';
  const traceOf = new Map((full?.spans ?? []).map((s) => [s.spanId, s.traceId]));
  const rootTrace = (full?.spans ?? []).find((s) => s.attrs['vcide.relay.id'] === ex?.relayId && s.kind === 1)?.traceId ?? null;
  const sqlIds = lastLineage?.lineage?.sqlSpanIds ?? [];
  x.sqlSpans = sqlIds.length;
  x.sqlInDocTrace = sqlIds.length > 0 && sqlIds.every((id) => traceOf.get(id) === rootTrace);
  x.recordedAtPick = full?.session.recorded ?? null;
  x.evictedAtPick = full?.session.retention.evicted ?? null;
  rec.picks.push(x);
  console.log('PICK', JSON.stringify(x));
  check(`${label}: 由来が DB カラムまで結ぶ（linked・poc.listings.region）`, x.lineage === 'linked' && x.cands === 'poc.listings.region', x);
  check(`${label}: 同定した通信は、いま表示中の文書の識別子を持つ /lin-a の通信`, x.docMatches, { docSeq: x.docSeq });
  check(`${label}: 由来の SQL はすべて、その通信のトレースのもの（誤接続なし）`, x.sqlInDocTrace, { sqlSpans: x.sqlSpans });
  return x;
}

const send = async (p, n, html = true) => {
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fetch(`${origin}${p}`, { headers: { accept: html ? 'text/html' : 'application/json' } }).then((r) => r.arrayBuffer()).catch(() => null);
    const rest = 1000 / RPS - (performance.now() - t);
    if (rest > 0) await sleep(rest);
  }
};

/* ============================================================ main */
if (PHASES.has('main')) {
  await obsPoint(0);
  await pickNow('最初');
  let sent = 0;
  const gap = 1000 / RPS;
  while (sent < TOTAL) {
    const t = performance.now();
    const p = PATHS[sent % PATHS.length];
    await fetch(`${origin}${p}`, { headers: { accept: 'text/html' } }).then((r) => r.arrayBuffer()).catch(() => null);
    sent += 1;
    if (sent % 100 === 0) await obsPoint(sent);
    if (PICKS.has(sent)) await pickNow(`${sent} 要求の後`);
    const rest = gap - (performance.now() - t);
    if (rest > 0) await sleep(rest);
  }
  await pickNow(`最後（${sent} 要求の後）`);
  const last = await obsPoint(sent);
  const firstFull = rec.points.find((x) => x.sent >= 300);
  check('観測 API（画面の取得）の大きさが件数に比例して増えない（300 要求時の 1.5 倍以内）', !firstFull || last.bytesUi <= firstFull.bytesUi * 1.5, { at300: firstFull?.bytesUi, last: last.bytesUi });
  check('変化が無ければ中身を返さない（unchanged）', last.unchanged && last.bytesUnchanged < 200, { bytes: last.bytesUnchanged });
  check('持つ通信は保持範囲で頭打ち', last.exchanges <= 200 + 50 + 8, last.exchanges);
  check('持つスパンが上限以下', last.retainedSpans <= 60000 && !last.truncated, { spans: last.retainedSpans, truncated: last.truncated });
  /* 新しい通信が無い 30 秒のあいだに、画面が実際に受け取ったもの（指紋が同じなら中身を返さない） */
  const before = { ...uiTraffic };
  await sleep(30000);
  rec.idle = { seconds: 30, responses: uiTraffic.responses - before.responses, bytes: uiTraffic.bytes - before.bytes, unchanged: uiTraffic.unchanged - before.unchanged };
  console.log('IDLE', JSON.stringify(rec.idle));
  check('新しい通信が無い間、画面の取得はほぼすべて「変化なし」（9 割以上）', rec.idle.responses > 0 && rec.idle.unchanged >= rec.idle.responses * 0.9, rec.idle);
}

/* ============================================================ evicted: 保持範囲から外れた文書を選ぶ */
if (PHASES.has('evicted')) {
  await gotoPath('/lin-a');
  await sleep(800);
  const token = await docTokenNow();
  /* 表示中の文書を「直近 200 件」と「直近 50 件の文書」の両方から押し出す（HTML の要求 300 件） */
  await send('/lin-c', 300, true);
  await sleep(2000);
  const x = { label: '保持範囲から外れた文書を選ぶ', token: !!token, ...(await selectField('a-region')) };
  const hist = (await obsCall({ run, detail: 'all' })).j.observation;
  x.inRetained = !!hist?.exchanges.some((e) => e.docToken === token);
  rec.picks.push(x);
  console.log('PICK', JSON.stringify(x));
  check('保持範囲から外れた文書: exchange-evicted（保持対象外）で切れる', x.binding === 'exchange-evicted' && x.lineage === 'cut' && !x.inRetained, x);
  check('保持範囲から外れた文書: 画面の理由に「保持対象外」と番号がある', /保持対象外/.test(x.line) && /通信 #\d+（\/lin-a）/.test(x.line), x.line);
  /* 読み込み直せば、また結べる */
  const again = await pickNow('読み込み直した後');
  void again;
}

/* ============================================================ lifecycle: 停止・異常終了・再起動で混ぜない */
if (PHASES.has('lifecycle')) {
  const oldRun = run;
  const oldFile = spanFile;
  const tStop = Date.now();
  await stopRun();
  rec.stopMs = Date.now() - tStop;
  /* 停止の直後はワーカーが終わりきっていないことがある。IDE は少し後に整理をやり直す（最大 25 秒待つ） */
  const waitGone = async (f) => { const t = Date.now(); while (fs.existsSync(f) && Date.now() - t < 25000) await sleep(500); return Date.now() - t; };
  rec.lifecycle.push({ step: 'stop-file-gone-ms', ms: await waitGone(oldFile) });
  const s1 = await status();
  const stale1 = await obsCall({ run: oldRun });
  check('停止後: 前の起動の観測は返らない', stale1.j.observation === null && !!stale1.j.stale, stale1.j.stale);
  check('停止後: その起動の収集ファイルを削除した', !fs.existsSync(oldFile) && (s1.spanCleanup?.removed ?? []).some((f) => oldFile.endsWith(f.name)), s1.spanCleanup);
  check('停止後: 収集ファイルのディレクトリに IDE の起動のファイルが残っていない', spanDir().files === 0, spanDir());
  rec.lifecycle.push({ step: 'stop', spanCleanup: s1.spanCleanup, spanDir: spanDir() });

  st = await startRun(); run = runOf(st); origin = st.preview.origin; spanFile = st.runtime.instrumentation.spanFile;
  await sleep(2000);
  const o2 = (await obsCall({ run, detail: 'all' })).j.observation;
  check('再起動後: 新しいセッション（番号は 1 から・外した数 0・前の通信なし）', o2 && o2.session.retention.evicted === 0 && o2.exchanges.every((e) => e.seq <= o2.session.recorded) && o2.session.recorded < 20, o2?.session);
  check('再起動後: 前の起動の観測は返らない', (await obsCall({ run: oldRun })).j.observation === null);
  await pickNow('再起動の後');

  /* 開発サーバーの異常終了（プロセスグループごと SIGKILL）→ error。観測を閉じ、収集ファイルを整理する */
  const killedFile = spanFile;
  const killedRun = run;
  try { process.kill(-run.pid, 'SIGKILL'); } catch { try { process.kill(run.pid, 'SIGKILL'); } catch { /* 落ちている */ } }
  const t0 = Date.now();
  let s3 = await status();
  while (s3.runtime.state === 'running' && Date.now() - t0 < 30000) { await sleep(500); s3 = await status(); }
  check('異常終了: 状態は running ではない', s3.runtime.state !== 'running', s3.runtime.state);
  check('異常終了: その起動の観測は返らない', (await obsCall({ run: killedRun })).j.observation === null);
  rec.lifecycle.push({ step: 'killed-file-gone-ms', ms: await waitGone(killedFile) });
  s3 = await status();
  check('異常終了: その起動の収集ファイルを削除した（書き手が死んでいる）', !fs.existsSync(killedFile), { cleanup: s3.spanCleanup, exists: fs.existsSync(killedFile) });
  rec.lifecycle.push({ step: 'dev-server-killed', state: s3.runtime.state, spanCleanup: s3.spanCleanup, spanDir: spanDir() });
  await page.reload({ waitUntil: 'networkidle' });
  st = await startRun(); run = runOf(st); origin = st.preview.origin; spanFile = st.runtime.instrumentation.spanFile;
  await sleep(2000);
  const o4 = (await obsCall({ run, detail: 'all' })).j.observation;
  check('異常終了の後の起動: 新しいセッション', o4 && o4.session.retention.evicted === 0 && o4.session.recorded < 20, o4?.session);
  await pickNow('異常終了の後の起動');
  rec.lifecycle.push({ step: 'restarted', spanDir: spanDir() });
  if (process.env.VCIDE_SOAK_LEAVE_RUNNING !== '1') {
    await stopRun();
    rec.lifecycle.push({ step: 'final-stop', spanCleanup: (await status()).spanCleanup, spanDir: spanDir() });
  } else {
    rec.lifecycle.push({ step: 'left-running', run, spanFile, spanDir: spanDir() });
  }
}

rec.stoppedPid = run.pid;
rec.uiTraffic = uiTraffic;
rec.finishedAt = new Date().toISOString();
rec.failed = rec.checks.filter((c) => !c.ok).length;
if (OUT) fs.writeFileSync(OUT, JSON.stringify(rec, null, 1));
console.log(`\n${rec.failed ? '✗' : '✓'} 確認 ${rec.checks.length} 件中 失敗 ${rec.failed} 件`);
await browser.close();
process.exit(rec.failed ? 1 : 0);
