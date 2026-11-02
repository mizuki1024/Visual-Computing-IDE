/* =============================================================================
 * Phase 7C-0 — MVP 受入の手動シナリオを、実ブラウザで画面の操作として通す記録用スクリプト。
 *   BASE=http://127.0.0.1:3100 SHOTS=docs/07c0-screenshots node scripts/acceptance-7c0.mjs
 *
 * 試験（tests/）ではない。合否の判定は報告書（docs/07c0-mvp-acceptance-report.md）で人が行う。
 * ここは「画面に何が出たか」を、浮かぶパネルを**隠さずに**撮り、DOM の属性と文字を JSON に残すだけ。
 * 前提: 新しく起動した IDE（BASE）・題材の DB（poc/README.md）。
 *   VCIDE_ACC_PROJECT  受入の題材（既定 poc/fixture-app）
 *   VCIDE_ACC_EXTRA    2つ目の題材（任意。検出・起動・プレビュー・選択・観測の成立範囲だけ見る）
 * ========================================================================== */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const SHOTS = process.env.SHOTS ?? null;
const PROJECT = process.env.VCIDE_ACC_PROJECT ?? path.join(REPO, 'poc', 'fixture-app');
const EXTRA = process.env.VCIDE_ACC_EXTRA ?? null;
const ONLY = process.env.VCIDE_ACC_ONLY ?? null; // 'main' | 'extra'
const VW = Number(process.env.VCIDE_ACC_W ?? 1600);
const VH = Number(process.env.VCIDE_ACC_H ?? 1000);
const OUT = process.env.VCIDE_ACC_OUT ?? (SHOTS ? path.join(SHOTS, 'evidence.json') : null);
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ev = { base: BASE, viewport: `${VW}x${VH}`, startedAt: new Date().toISOString(), scenarios: [] };
let cur = null;
const scen = (id, title) => { cur = { id, title, steps: [], notes: [], error: null }; ev.scenarios.push(cur); console.log(`\n## ${id} ${title}`); };
const step = (k, v) => { cur.steps.push({ k, v }); console.log(`  - ${k}: ${typeof v === 'string' ? v.slice(0, 260).replace(/\n/g, ' ⏎ ') : JSON.stringify(v)?.slice(0, 260)}`); };

const browser = await chromium.launch(CHANNEL === 'none' ? {} : { channel: CHANNEL });
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && (m.location().url ?? '').startsWith(BASE)) consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 200)}`));

const shot = async (name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  step('screenshot', `${name}.png`);
};
const rtPanel = () => page.locator('.fpnl[aria-label="プロジェクトと実行"]');
const pv = () => page.locator('section[aria-label="プレビュー"] .pvlive');
const pvAttr = (a) => pv().getAttribute(a, { timeout: 3000 }).catch(() => null);
const frame = () => page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe');
const status = () => page.evaluate(async () => (await fetch('/api/runtime/status')).json());
const dockText = () => page.locator('aside.dock').innerText({ timeout: 3000 }).catch(() => '');
const canvasText = () => page.locator('.canvas').innerText({ timeout: 3000 }).catch(() => '');
const pvText = () => pv().innerText({ timeout: 3000 }).catch(() => '');
const rtText = () => rtPanel().innerText({ timeout: 3000 }).catch(() => '');
const loadsNow = async () => Number(await pvAttr('data-loads'));
const waitLoads = (n, timeout = 120000) => page.waitForFunction(
  (k) => Number(document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-loads')) > k, n, { timeout },
);
const waitPv = (s, timeout = 240000) => page.waitForFunction(
  (x) => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') === x, s, { timeout },
);

/** 浮かぶパネルとキャンバスのノードの重なり（画面座標）。パネルを隠さずに測る */
async function overlap() {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll('.fpnl')].map((p) => ({ name: p.getAttribute('aria-label'), r: p.getBoundingClientRect() }));
    const dock = document.querySelector('aside.dock')?.getBoundingClientRect() ?? null;
    const nodes = [...document.querySelectorAll('g.nd')].map((g) => ({ label: g.getAttribute('aria-label'), r: g.getBoundingClientRect() }));
    const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const vw = innerWidth, vh = innerHeight;
    return {
      panels: panels.map((p) => ({ name: p.name, x: Math.round(p.r.left), y: Math.round(p.r.top), w: Math.round(p.r.width), h: Math.round(p.r.height) })),
      nodes: nodes.map((n) => {
        const area = n.r.width * n.r.height || 1;
        const by = panels.map((p) => ({ name: p.name, frac: inter(n.r, p.r) / area })).filter((x) => x.frac > 0.05);
        const off = n.r.right < 0 || n.r.left > (dock ? dock.left : vw) || n.r.bottom < 0 || n.r.top > vh;
        const underDock = dock ? inter(n.r, dock) / area > 0.05 : false;
        return { label: n.label, coveredBy: by.map((b) => `${b.name}:${Math.round(b.frac * 100)}%`), offscreen: off, underDock };
      }),
    };
  });
}
const summarizeOverlap = (o) => {
  const covered = o.nodes.filter((n) => n.coveredBy.length);
  return { nodes: o.nodes.length, covered: covered.length, offscreen: o.nodes.filter((n) => n.offscreen).length, coveredList: covered.map((n) => `${n.label} ← ${n.coveredBy.join(',')}`) };
};

/** Markdown の記号が文字として出ていないか（右ドック・キャンバス・パネル） */
async function markdownLeaks() {
  const t = [await dockText(), await canvasText(), await pvText(), await rtText()].join('\n');
  const hits = t.split('\n').filter((l) => /\*\*|(^|\s)__\S|`[^`]+`|^#{1,3}\s/.test(l)).map((l) => l.slice(0, 160));
  return hits.slice(0, 12);
}

async function inspectProject(p) {
  await rtPanel().locator('#rt-path').fill(p);
  await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((x) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === x, p, { timeout: 30000 });
  return rtPanel().locator('.rt-ins').getAttribute('data-verdict');
}
async function startRun() {
  const t0 = Date.now();
  const seen = [];
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  for (;;) {
    const s = await rtPanel().locator('.rt-st b').innerText({ timeout: 2000 }).catch(() => '?');
    if (seen.at(-1) !== s) seen.push(s);
    const v = await pvAttr('data-preview-state');
    if (v === 'live' || v === 'error' || v === 'unavailable' || v === 'unreachable') return { states: seen, preview: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > 240000) return { states: seen, preview: v, ms: Date.now() - t0, timeout: true };
    await sleep(300);
  }
}
async function gotoPath(p) {
  const n = await loadsNow();
  await pv().locator('input[aria-label="プレビューのパス"]').fill(p);
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  await waitLoads(n);
  await sleep(300);
}
async function pick(locator, { waitLineage = true, timeout = 45000 } = {}) {
  if ((await pvAttr('data-select-mode')) !== 'on') await pv().locator('.rt-b', { hasText: '選択' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-agent-mode') === 'on', null, { timeout: 15000 }).catch(() => {});
  const before = await pvAttr('data-sel-at');
  await frame().locator(locator).first().click({ timeout: 30000 });
  const t0 = Date.now();
  for (;;) {
    const s = await pvAttr('data-selection');
    const lin = await pvAttr('data-lineage');
    if ((s === 'resolved' && (!waitLineage || lin)) || s === 'unresolved' || s === 'error') break;
    if (Date.now() - t0 > timeout) break;
    await sleep(250);
  }
  await sleep(400);
  await pv().locator('.rt-b', { hasText: '選択' }).click(); // 選択モードを抜ける
  return {
    selection: await pvAttr('data-selection'), at: await pvAttr('data-sel-at'), component: await pvAttr('data-sel-component'),
    reason: await pvAttr('data-sel-reason'), binding: await pvAttr('data-doc-binding'), docSeq: await pvAttr('data-doc-seq'),
    lineage: await pvAttr('data-lineage'), lineageReason: await pvAttr('data-lineage-reason'), lineageStage: await pvAttr('data-lineage-stage'),
    outcome: await pvAttr('data-lineage-outcome'), cands: await pvAttr('data-lineage-cands'), ms: Date.now() - t0, before,
  };
}
async function showBound() {
  const seq = await pvAttr('data-doc-seq');
  const row = pv().locator('.pvobsrow');
  await page.waitForFunction(() => Number(document.querySelector('.pvobsrow')?.getAttribute('data-obs-count') ?? 0) > 0, null, { timeout: 60000 }).catch(() => {});
  if (seq) await row.locator('select').selectOption(seq).catch(() => {});
  await row.locator('.rt-b', { hasText: '表示' }).click();
  await page.waitForFunction(() => document.querySelector('.pvobsrow')?.getAttribute('data-obs-shown'), null, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  return { shown: await row.getAttribute('data-obs-shown'), withSel: await row.getAttribute('data-obs-with-sel'), count: await row.getAttribute('data-obs-count'), sql: await row.getAttribute('data-obs-sql') };
}
async function stopRun() {
  const t0 = Date.now();
  await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
  await waitPv('stopped', 60000).catch(() => {});
  return Date.now() - t0;
}

async function scenarioMain() {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  scen('S0', 'IDE を開いた直後');
  await shot('00-open-ide');
  step('overlap.initial', summarizeOverlap(await overlap()));

  scen('S1', 'プロジェクトを開く（対応状況と制約が分かる）');
  step('verdict', await inspectProject(PROJECT));
  step('runtimePanel', await rtText());
  await shot('01-inspect-fixture');
  step('verdict.invalid', await inspectProject('/nonexistent/path/app'));
  step('runtimePanel.invalid', await rtText());
  await shot('01b-inspect-invalid');
  step('verdict.again', await inspectProject(PROJECT));

  scen('S2', '開発サーバーを起動する（状態が正確に表示される）');
  const r = await startRun();
  step('start', r);
  const st = await status();
  step('status.runtime', { state: st.runtime?.state, pid: st.runtime?.pid, port: st.runtime?.port, readyMs: st.runtime?.readyMs, instrumentation: st.runtime?.instrumentation?.state, anchors: st.runtime?.anchors?.state, env: st.runtime?.env });
  step('runtimePanel', await rtText());
  await shot('02-running');

  scen('S3', '実ページをプレビューする（遷移・再読み込み）');
  await gotoPath('/lin-a');
  step('after goto /lin-a', { path: await pvAttr('data-path'), http: await pvAttr('data-http-status'), loads: await pvAttr('data-loads') });
  const n = await loadsNow();
  await pv().locator('button[aria-label="再読み込み"]').click();
  await waitLoads(n);
  step('after reload', { path: await pvAttr('data-path'), http: await pvAttr('data-http-status'), loads: await pvAttr('data-loads') });
  await gotoPath('/no-such-page');
  step('after goto 404', { path: await pvAttr('data-path'), http: await pvAttr('data-http-status'), foot: await page.locator('section[aria-label="プレビュー"] .pvfoot').innerText() });
  await gotoPath('/lin-a');
  await shot('03-preview-lin-a');

  scen('S4', '要素を選ぶ（対応する React ソースが分かる）');
  const a = await pick('li[data-poc-field="a-region"]');
  step('pick li', a);
  step('previewPanel', await pvText());
  step('dock', (await dockText()).slice(0, 1200));
  await shot('04-select-li');
  step('overlap.afterSelect', summarizeOverlap(await overlap()));

  scen('S5', 'データの由来を追う（限定対象で DB カラムまで）');
  step('showBound', await showBound());
  step('previewPanel', await pvText());
  step('canvas', (await canvasText()).slice(0, 1500));
  step('dock', (await dockText()).slice(0, 2500));
  const ov = await overlap();
  step('overlap.lineage', summarizeOverlap(ov));
  step('overlap.raw', ov);
  step('markdownLeaks', await markdownLeaks());
  await shot('05-lineage-panels-visible');
  const tb = page.locator('[role="toolbar"][aria-label="キャンバス操作"]');
  await tb.locator('button', { hasText: '全体表示' }).click();
  await sleep(500);
  step('overlap.afterFit', summarizeOverlap(await overlap()));
  await shot('05b-lineage-after-fit');
  await tb.locator('button', { hasText: '実行' }).click(); // 「プロジェクトと実行」を閉じる
  await sleep(300);
  step('overlap.runtimeClosed', summarizeOverlap(await overlap()));
  await shot('05c-lineage-runtime-closed');
  await tb.locator('button', { hasText: '実行' }).click(); // 開き直す
  await sleep(300);

  scen('S6', '推定を見る（実測と推定を誤認しない）');
  const labels = await page.locator('g.nd').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  step('nodeLabels', labels);
  const edges = await page.locator('g.ed, g.edge, path[data-obs], [data-observability]').evaluateAll((els) => els.slice(0, 40).map((e) => `${e.tagName}:${e.getAttribute('data-observability') ?? e.getAttribute('class')}`)).catch(() => []);
  step('edgesObs', edges);
  // ステップバッジで描画位置のノード（値を描く式）を開き、ドックの文言を読む
  for (const b of [1, 2, 3, 4, 5, 6]) {
    await page.evaluate(() => { (document.activeElement)?.blur?.(); document.body.focus(); });
    await page.keyboard.press(String(b));
    await sleep(350);
    step(`dock.badge${b}`, (await dockText()).slice(0, 900));
    step(`markdownLeaks.badge${b}`, await markdownLeaks());
    if (b === 2) await shot('06-dock-badge2');
  }
  step('markdownLeaks', await markdownLeaks());

  scen('S7', '特定不能な値を選ぶ（理由と限界が理解できる）');
  await page.keyboard.press('Escape').catch(() => {});
  await gotoPath('/lin-g');
  const g = await pick('p[data-poc-field="g-shadow"]');
  step('pick g-shadow (lineage cut)', g);
  step('previewPanel', await pvText());
  step('dock', (await dockText()).slice(0, 1500));
  await shot('07a-lineage-cut');
  await gotoPath('/cards');
  const u = await pick('[data-poc-kind="vendor-panel"]', { waitLineage: false, timeout: 20000 }).catch((e) => ({ error: String(e).slice(0, 200) }));
  step('pick vendor/unresolvable', u);
  step('previewPanel', await pvText());
  step('dock', (await dockText()).slice(0, 1500));
  await shot('07b-unresolved');
  await gotoPath('/lin-c');
  const c = await pick('p[data-poc-field="c-title"]', { timeout: 30000 });
  step('pick lin-c (candidates)', c);
  step('previewPanel', await pvText());
  step('dock', (await dockText()).slice(0, 2500));
  step('markdownLeaks', await markdownLeaks());
  await shot('07c-candidates');

  scen('S8', '停止・再起動する（古い情報が混入しない）');
  await gotoPath('/lin-a');
  const a1 = await pick('li[data-poc-field="a-region"]');
  step('pick before stop', a1);
  const before = await status();
  const ms = await stopRun();
  step('stop', { ms, preview: await pvAttr('data-preview-state'), selection: await pvAttr('data-selection') });
  step('previewPanel', await pvText());
  step('canvas', (await canvasText()).slice(0, 600));
  step('dock', (await dockText()).slice(0, 600));
  await shot('08a-stopped');
  const pidAlive = (() => { try { process.kill(before.runtime.pid, 0); return true; } catch { return false; } })();
  step('old pid alive after stop', { pid: before.runtime.pid, alive: pidAlive });
  const r2 = await startRun();
  step('restart', r2);
  const after = await status();
  step('restart.runtime', { pid: after.runtime?.pid, startedAt: after.runtime?.startedAt, prevStartedAt: before.runtime?.startedAt });
  await sleep(1500);
  step('after restart', { selection: await pvAttr('data-selection'), lineage: await pvAttr('data-lineage'), obsCount: await pv().locator('.pvobsrow').getAttribute('data-obs-count').catch(() => null), obsShown: await pv().locator('.pvobsrow').getAttribute('data-obs-shown').catch(() => null) });
  step('previewPanel', await pvText());
  step('canvas', (await canvasText()).slice(0, 600));
  await shot('08b-restarted');
  // 古い起動の観測を、新しい起動の画面から要求しても返らない
  const stale = await page.evaluate(async (run) => {
    const r = await fetch('/api/runtime/observations', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: JSON.stringify({ run }) });
    const j = await r.json(); return { status: r.status, observation: j.observation ? 'returned' : null, stale: j.stale?.code ?? null };
  }, { instance: before.runtime.instance, pid: before.runtime.pid, startedAt: before.runtime.startedAt });
  step('old-run observations', stale);
  await gotoPath('/lin-a');
  const a2 = await pick('li[data-poc-field="a-region"]');
  step('pick after restart', a2);
  step('detect enabled after restart', !(await rtPanel().locator('.rt-b', { hasText: '検出' }).isDisabled()));
  await stopRun();
  step('detect enabled after stop', !(await rtPanel().locator('.rt-b', { hasText: '検出' }).isDisabled()));
  step('previewPanel.final', await pvText());
}

async function scenarioExtra() {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  scen('X1', `2つ目の題材を開く（${path.basename(EXTRA)}）`);
  step('verdict', await inspectProject(EXTRA));
  step('runtimePanel', await rtText());
  await shot('10-extra-inspect');
  scen('X2', '起動');
  const r = await startRun();
  step('start', r);
  const st = await status();
  step('status.runtime', { state: st.runtime?.state, port: st.runtime?.port, readyMs: st.runtime?.readyMs, instrumentation: st.runtime?.instrumentation, anchors: st.runtime?.anchors, error: st.runtime?.error });
  step('runtimePanel', await rtText());
  await shot('11-extra-running');
  if (r.preview !== 'live') return;
  scen('X3', 'プレビュー');
  await sleep(1500);
  step('home', { path: await pvAttr('data-path'), http: await pvAttr('data-http-status') });
  await gotoPath('/products');
  step('products', { path: await pvAttr('data-path'), http: await pvAttr('data-http-status') });
  await shot('12-extra-products');
  scen('X4', '要素選択');
  for (const sel of ['[data-sample="name"]', '[data-sample="price"]', '[data-sample="count"]']) {
    const x = await pick(sel, { timeout: 30000 }).catch((e) => ({ error: String(e).slice(0, 200) }));
    step(`pick ${sel}`, x);
    step('previewPanel', await pvText());
    step('dock', (await dockText()).slice(0, 900));
  }
  await shot('13-extra-select');
  scen('X5', '通信観測');
  const b = await showBound().catch((e) => ({ error: String(e).slice(0, 200) }));
  step('showBound', b);
  step('obsRow', await pv().locator('.pvobsrow').innerText().catch(() => ''));
  step('options', await pv().locator('.pvobsrow select option').allInnerTexts().catch(() => []));
  step('canvas', (await canvasText()).slice(0, 1200));
  await shot('14-extra-observe');
  await gotoPath('/client-products');
  await sleep(2500);
  step('client options', await pv().locator('.pvobsrow select option').allInnerTexts().catch(() => []));
  const cx = await pick('[data-sample="client-name"]', { timeout: 30000 }).catch((e) => ({ error: String(e).slice(0, 200) }));
  step('pick client-name', cx);
  step('previewPanel', await pvText());
  await shot('15-extra-client-fetch');
  // ナビゲーション（next/link）: 既定テンプレートのトップのリンクは外部なので、アドレスで戻る
  await gotoPath('/');
  step('home again', { path: await pvAttr('data-path'), http: await pvAttr('data-http-status') });
  await stopRun();
}

try {
  if (ONLY !== 'extra') await scenarioMain();
  if (EXTRA && ONLY !== 'main') await scenarioExtra();
} catch (e) {
  if (cur) cur.error = String(e?.stack ?? e).slice(0, 800);
  console.log('ERROR', e);
  await shot('zz-error').catch(() => {});
} finally {
  ev.consoleErrors = consoleErrors;
  ev.finishedAt = new Date().toISOString();
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(ev, null, 1)); }
  await browser.close();
}
