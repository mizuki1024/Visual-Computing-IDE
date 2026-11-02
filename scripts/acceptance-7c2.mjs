/* =============================================================================
 * Phase 7C-2 — キャンバスと浮かぶパネルの重なり（P0-2）の受入を、実ブラウザで**利用者の操作**として通す。
 *   BASE=http://127.0.0.1:3100 SHOTS=docs/07c2-screenshots/1600x1000 VCIDE_ACC_W=1600 VCIDE_ACC_H=1000 \
 *     node scripts/acceptance-7c2.mjs
 *
 * 試験（tests/）ではない。合否は報告書（docs/07c2-canvas-layout-report.md）で人が判断する。
 * - 浮かぶパネルは**隠さない**。テスト用の強制非表示（shotCanvas の visibility:hidden）は使わない
 * - 重なりは 7C-0 と同じ関数（scripts/lib/overlap.mjs の overlap）と、7C-2 で足した measureCanvas で測る
 * - パネルの開閉は、マウスだけでなくキーボード（Tab で移動・Enter / Space）でも行う
 * 前提: 新しく起動した IDE（BASE）・題材の DB（poc/README.md）。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { overlap, summarizeOverlap, measureCanvas, summarizeCanvas } from './lib/overlap.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const SHOTS = process.env.SHOTS ?? null;
const PROJECT = process.env.VCIDE_ACC_PROJECT ?? path.join(REPO, 'poc', 'fixture-app');
const VW = Number(process.env.VCIDE_ACC_W ?? 1600);
const VH = Number(process.env.VCIDE_ACC_H ?? 1000);
const OUT = process.env.VCIDE_ACC_OUT ?? (SHOTS ? path.join(SHOTS, 'evidence.json') : null);
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ev = { base: BASE, viewport: `${VW}x${VH}`, startedAt: new Date().toISOString(), scenarios: [], checks: [] };
let cur = null;
const scen = (id, title) => { cur = { id, title, steps: [], error: null }; ev.scenarios.push(cur); console.log(`\n## ${id} ${title}`); };
const step = (k, v) => { cur.steps.push({ k, v }); console.log(`  - ${k}: ${typeof v === 'string' ? v.slice(0, 300).replace(/\n/g, ' ⏎ ') : JSON.stringify(v)?.slice(0, 300)}`); };
/** 合否の材料。報告書の表はここから作る */
const check = (id, name, okv, got) => { ev.checks.push({ scenario: cur?.id, id, name, ok: !!okv, got }); console.log(`  ${okv ? '✓' : '✗'} [${id}] ${name}${okv ? '' : ` — ${JSON.stringify(got)?.slice(0, 300)}`}`); };

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
const pvSection = () => page.locator('section[aria-label="プレビュー"]');
const pv = () => page.locator('section[aria-label="プレビュー"] .pvlive');
const pvAttr = (a) => pv().getAttribute(a, { timeout: 3000 }).catch(() => null);
const frame = () => page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe');
const status = () => page.evaluate(async () => (await fetch('/api/runtime/status')).json());
const dockText = () => page.locator('aside.dock').innerText({ timeout: 3000 }).catch(() => '');
const loadsNow = async () => Number(await pvAttr('data-loads'));
const waitLoads = (n, timeout = 120000) => page.waitForFunction(
  (k) => Number(document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-loads')) > k, n, { timeout },
);
const waitPv = (s, timeout = 240000) => page.waitForFunction(
  (x) => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') === x, s, { timeout },
);
/** 視点の移動（260ms）が終わるまで待つ */
const settle = async () => {
  let prev = null;
  for (let i = 0; i < 30; i++) {
    const t = await page.locator('.scene > g').getAttribute('transform').catch(() => null);
    if (t === prev) break;
    prev = t;
    await sleep(120);
  }
  await sleep(150);
};
const rtCompact = () => rtPanel().locator('.rt').getAttribute('data-compact').catch(() => null);
const pvFolded = () => pvAttr('data-folded');

/** 計測して記録する。expectZero なら、経路の要素（ノード・札・推定の印・切断の印・接続線）の隠れが 0 か判定する */
async function measure(label, { expectZero = false } = {}) {
  await settle();
  const m = await measureCanvas(page);
  const s = summarizeCanvas(m);
  const o = summarizeOverlap(await overlap(page));
  step(`measure.${label}`, s);
  step(`overlap7c0.${label}`, o);
  ev.measures = ev.measures ?? [];
  ev.measures.push({ scenario: cur.id, label, summary: s, overlap7c0: o, raw: m });
  if (expectZero) {
    check(`${label}.nodes`, `${label}: 経路のノードが隠れていない（7C-0 の計測 / 7C-2 の計測）`, o.covered === 0 && s.nodesHidden === 0, { o: o.coveredList, s: s.hiddenList });
    check(`${label}.all`, `${label}: 札・推定の印・切断の印・接続線も隠れていない`, s.hiddenList.length === 0, s.hiddenList);
  }
  return { m, s, o };
}

async function inspectProject(p) {
  await rtPanel().locator('#rt-path').fill(p);
  await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((x) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === x, p, { timeout: 30000 });
  return rtPanel().locator('.rt-ins').getAttribute('data-verdict');
}
async function startRun() {
  const t0 = Date.now();
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  for (;;) {
    const v = await pvAttr('data-preview-state');
    if (v === 'live' || v === 'error' || v === 'unavailable' || v === 'unreachable') return { preview: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > 240000) return { preview: v, ms: Date.now() - t0, timeout: true };
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
const selectBtn = () => pv().locator('.rt-b', { hasText: '選択' });
/** 選択モードに入り、要素を選ぶ。選択モードは抜けない（「選ぶ」の途中の状態を測るため） */
async function pickOnly(locator, { waitLineage = true, timeout = 45000 } = {}) {
  if ((await pvAttr('data-select-mode')) !== 'on') await selectBtn().click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-agent-mode') === 'on', null, { timeout: 15000 }).catch(() => {});
  await frame().locator(locator.sel).nth(locator.nth ?? 0).click({ timeout: 30000, ...(locator.position ? { position: locator.position } : {}) });
  const t0 = Date.now();
  for (;;) {
    const s = await pvAttr('data-selection');
    const lin = await pvAttr('data-lineage');
    if ((s === 'resolved' && (!waitLineage || lin)) || s === 'unresolved' || s === 'error') break;
    if (Date.now() - t0 > timeout) break;
    await sleep(250);
  }
  await sleep(400);
  return {
    selection: await pvAttr('data-selection'), at: await pvAttr('data-sel-at'), reason: await pvAttr('data-sel-reason'),
    lineage: await pvAttr('data-lineage'), lineageReason: await pvAttr('data-lineage-reason'), outcome: await pvAttr('data-lineage-outcome'),
    cands: await pvAttr('data-lineage-cands'), docSeq: await pvAttr('data-doc-seq'),
  };
}
const exitSelect = async () => { if ((await pvAttr('data-select-mode')) === 'on') await selectBtn().click(); await sleep(200); };
async function showBound() {
  const seq = await pvAttr('data-doc-seq');
  const row = pv().locator('.pvobsrow');
  await page.waitForFunction(() => Number(document.querySelector('.pvobsrow')?.getAttribute('data-obs-count') ?? 0) > 0, null, { timeout: 60000 }).catch(() => {});
  if (seq) await row.locator('select').selectOption(seq).catch(() => {});
  await row.locator('.rt-b', { hasText: '表示' }).click();
  await page.waitForFunction(() => document.querySelector('.pvobsrow')?.getAttribute('data-obs-shown'), null, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  return { shown: await row.getAttribute('data-obs-shown'), withSel: await row.getAttribute('data-obs-with-sel') };
}
async function stopRun() {
  const t0 = Date.now();
  await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
  await waitPv('stopped', 60000).catch(() => {});
  return Date.now() - t0;
}
/** 状態の指紋。開閉の前後で、選択・表示経路・観測・文書が失われていないかを比べる */
const keep = async () => ({
  selection: await pvAttr('data-selection'), at: await pvAttr('data-sel-at'), lineage: await pvAttr('data-lineage'),
  docSeq: await pvAttr('data-doc-seq'), loads: await pvAttr('data-loads'), conn: await pvAttr('data-conn'),
  obsShown: await pv().locator('.pvobsrow').getAttribute('data-obs-shown').catch(() => null),
  session: await pv().locator('.pvobsrow').getAttribute('data-obs-session').catch(() => null),
  nodes: await page.locator('g.nd').count(),
});
const sameKeep = (a, b, keys = ['selection', 'at', 'lineage', 'docSeq', 'loads', 'conn', 'obsShown', 'session', 'nodes']) => keys.every((k) => a[k] === b[k]);

/** Tab だけで目的のボタンまで移動する（何回押したかを返す）。Shift なし・最大 120 回 */
async function tabTo(selector) {
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  await page.locator('header.n0').click({ position: { x: 2, y: 2 } }).catch(() => {});
  for (let i = 1; i <= 120; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate((s) => document.activeElement?.matches?.(s) ?? false, selector);
    if (hit) return i;
  }
  return null;
}
const focusVisible = () => page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false);

async function main() {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await sleep(600);

  scen('K1', 'IDE を初めて開く');
  await measure('open');
  await shot('01-open-ide');
  // 合成の見本（未選択）でも、全体表示ではパネルに隠れない
  await page.locator('[role="toolbar"][aria-label="キャンバス操作"] button', { hasText: '全体表示' }).click();
  await measure('open.fit', { expectZero: true });
  await shot('01b-open-fit');

  scen('K2', '開発サーバーを起動する（実行中は「プロジェクトと実行」を1段に畳む）');
  step('verdict', await inspectProject(PROJECT));
  await shot('02a-inspected');
  const r = await startRun();
  step('start', r);
  await sleep(800);
  check('run.compact', '実行中は「プロジェクトと実行」が畳まれる', (await rtCompact()) === 'on', await rtCompact());
  const rtBox = await rtPanel().boundingBox();
  step('runtimePanel.box', rtBox);
  check('run.height', '畳んだ「プロジェクトと実行」の高さが 110px 以下', rtBox && rtBox.height <= 110, rtBox);
  check('run.stopVisible', '畳んでも［停止する］が見えて押せる', await rtPanel().locator('.rt-b', { hasText: '停止する' }).isVisible(), null);
  step('runtimePanel.text', await rtPanel().innerText());
  await shot('02b-running');

  scen('K3', 'プレビューでページを操作する');
  await gotoPath('/lin-a');
  const n = await loadsNow();
  await pv().locator('button[aria-label="再読み込み"]').click();
  await waitLoads(n);
  await gotoPath('/no-such-page');
  step('404', { http: await pvAttr('data-http-status') });
  await gotoPath('/lin-a');
  check('pv.expanded', 'ページを操作している間、プレビューは広がっている', (await pvFolded()) === 'off', await pvFolded());
  await shot('03-preview-lin-a');

  scen('K4', '/lin-a の値を選び、DB カラムまで表示する');
  const a = await pickOnly({ sel: 'li[data-poc-field="a-region"]' });
  step('pick', a);
  check('pick.linked', '/lin-a の値が DB カラムまで結ばれる', a.lineage === 'linked' && /poc\.listings\.region/.test(a.cands ?? ''), a);
  check('pick.expandedWhileSelecting', '選択モードの間は、プレビューは広がったまま（選び直せる）', (await pvFolded()) === 'off', await pvFolded());
  await measure('selecting');            // 選んでいる最中（参考。経路は覆われない領域へ収まっているか）
  await shot('04a-selecting');
  await exitSelect();
  check('pick.folded', '選択モードを抜けると、プレビューのページ表示が畳まれる', (await pvFolded()) === 'on', await pvFolded());
  check('pick.selKept', '畳んでも選択の行は残る', (await pvAttr('data-selection')) === 'resolved', await pvAttr('data-selection'));
  await measure('explore', { expectZero: true });
  await shot('04b-explore-lineage');
  {
    const hit = await page.evaluate(() => {
      const t = document.querySelector('.ctl').getBoundingClientRect();
      return [...document.querySelectorAll('.fpnl button')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.left < t.right && t.left < r.right && r.top < t.bottom && t.top < r.bottom;
      }).map((b) => b.textContent);
    });
    check('toolbar.noCover', '右上の操作バーが、パネルのボタン（畳む・閉じる等）を覆っていない', hit.length === 0, hit);
  }
  const b = await showBound();
  step('showBound', b);
  await measure('explore.withObs', { expectZero: true });
  await shot('04c-explore-with-observation');
  step('previewPanel.text', await pvSection().innerText());

  scen('K5', '推定の接続線と最弱環を確かめる（キャンバスと右ドック）');
  const m5 = await measure('estimate', { expectZero: true });
  const est = m5.m.hops.filter((h) => h.estimated);
  check('est.lines', '推定の接続線がある・破線で描かれ・隠れていない', est.length >= 1 && est.every((h) => h.dashed && h.hiddenPct === 0 && h.outsidePct === 0), est);
  check('est.tag', '推定の接続線に添えた「推定」の印がキャンバスで見える', m5.m.tags.length >= 1 && m5.m.tags.every((t) => !t.coveredBy.length && !t.outside), m5.m.tags);
  step('weakestOnCanvas', { starTags: m5.m.tags.filter((t) => /weakest/.test(t.label)).length, note: '実ページの経路では ★ の印をキャンバスに付けていない（7B-3B-2 からの仕様。右ドックの ★ と［ここを見る］で示す）' });
  check('est.font', 'ラベル札の文字が 9px 以上（12px × 倍率）', m5.s.chipFontPx >= 9, m5.s.chipFontPx);
  const d = await dockText();
  check('dock.weakest', '右ドックに ★ いちばん弱いところ と推定の説明', d.includes('いちばん弱いところ') && d.includes('推定'), d.slice(0, 300));
  await page.locator('aside.dock button', { hasText: 'ここを見る' }).click();
  await sleep(200);
  const mw = await measure('dock.lookHere', { expectZero: true });
  const dl = await dockText();
  check('dock.lookHere', '右ドックの［ここを見る］で最弱環のホップを選ぶ（右ドックがホップの説明に変わり、経路は隠れない）', /推定/.test(dl) && mw.s.hiddenList.length === 0, { hidden: mw.s.hiddenList, dock: dl.slice(0, 200) });
  await shot('05a-dock-look-here');
  // 右ドックの経路のステップ（番号）でノードを選ぶ
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  await page.keyboard.press('6');
  await sleep(300);
  check('dock.badge', '番号キー 6 でステップを選ぶと右ドックが追従する', (await page.locator('.dock .st.cur').count()) >= 1, null);
  await measure('dock.badge6', { expectZero: true });
  await shot('05b-step6');
  await page.keyboard.press('Escape');

  scen('K6', '［全体表示］を押す');
  await page.locator('[role="toolbar"][aria-label="キャンバス操作"] button', { hasText: '全体表示' }).click();
  await measure('fit.folded', { expectZero: true });
  await shot('06a-fit');
  // パネルを広げた状態から全体表示（領域が足りないときは、ズームだけでなく畳んで収める）
  await pvSection().locator('button.fold').click();
  await rtPanel().locator('button.fold').click();
  await sleep(300);
  check('fit.pre', '前提: プレビューと「プロジェクトと実行」を広げた', (await pvFolded()) === 'off' && (await rtCompact()) === 'off', { pv: await pvFolded(), rt: await rtCompact() });
  await measure('expanded.both');        // 広げた直後（全体表示のままなので、広げたパネルを避けて収め直す）
  await shot('06b-both-expanded');
  await page.evaluate(() => { document.activeElement?.blur?.(); });
  await page.keyboard.press('0');
  await sleep(200);
  check('fit.folds', '［全体表示］（0 キー）でプレビューと「プロジェクトと実行」が畳まれる', (await pvFolded()) === 'on' && (await rtCompact()) === 'on', { pv: await pvFolded(), rt: await rtCompact() });
  await measure('fit.fromExpanded', { expectZero: true });
  await shot('06c-fit-from-expanded');

  scen('K7', '特定不能な要素・由来が切れる要素を選ぶ');
  await gotoPath('/lin-g');
  check('nav.expands', '移動するとページの表示が広がる', (await pvFolded()) === 'off', await pvFolded());
  const g = await pickOnly({ sel: 'p[data-poc-field="g-shadow"]' });
  step('pick g-shadow', g);
  await exitSelect();
  check('cut.lineage', '由来が切れる（理由つき）', g.lineage === 'cut' && !!g.lineageReason, g);
  await measure('cut', { expectZero: true });
  step('dock', (await dockText()).slice(0, 600));
  await shot('07a-lineage-cut');
  await gotoPath('/cards');
  // 外部 UI の <section> 自身の余白を押す（中央はプレビューの幅によって子の要素に当たる）
  const u = await pickOnly({ sel: '[data-poc-kind="vendor-panel"]', position: { x: 4, y: 4 } }, { waitLineage: false, timeout: 20000 });
  step('pick vendor', u);
  await exitSelect();
  check('unres.status', '外部 UI の要素は「特定できません」', u.selection === 'unresolved', u);
  check('unres.folded', '特定できなくても、選んだ後は経路図（理由の図）を優先する', (await pvFolded()) === 'on', await pvFolded());
  await measure('unresolved', { expectZero: true });
  const du = await dockText();
  check('unres.dock', '右ドックに特定できない理由', /特定でき(ません|なかった)/.test(du), du.slice(0, 300));
  await shot('07b-unresolved');

  scen('K8', '実行パネルとプレビューを展開・収納する（マウスとキーボード）');
  await gotoPath('/lin-a');
  await pickOnly({ sel: 'li[data-poc-field="a-region"]' });
  await exitSelect();
  await showBound();
  await measure('k8.base', { expectZero: true });
  const k0 = await keep();
  step('keep.before', k0);
  // キーボード: Tab でプレビューの［ページを表示］へ
  const tabsPv = await tabTo('section[aria-label="プレビュー"] button.fold');
  step('tabs to preview fold', tabsPv);
  check('kbd.reachPv', 'Tab だけでプレビューの［ページを表示］に届く', tabsPv !== null, tabsPv);
  check('kbd.focusRing', 'フォーカスが見える（:focus-visible）', await focusVisible(), null);
  await page.keyboard.press('Enter');
  await sleep(300);
  check('kbd.pvExpand', 'Enter でページの表示を広げる', (await pvFolded()) === 'off', await pvFolded());
  const k1 = await keep();
  check('kbd.pvKeep', '広げても選択・表示経路・観測・文書が変わらない（再読み込みしない）', sameKeep(k0, k1), { k0, k1 });
  await measure('pv.expanded');
  await shot('08a-preview-expanded-by-keyboard');
  // 広げたページで、同じ文書がそのまま見えている
  check('pv.sameDoc', '広げると同じページ（/lin-a）がそのまま見える', (await frame().locator('h1').innerText({ timeout: 5000 }).catch(() => '')).includes('ケースA'), null);
  await page.keyboard.press('Enter');    // フォーカスはボタンに残っている
  await sleep(300);
  check('kbd.pvFold', 'もう一度 Enter で畳む', (await pvFolded()) === 'on', await pvFolded());
  check('kbd.pvKeep2', '畳んでも選択・表示経路・観測・文書が変わらない', sameKeep(k0, await keep()), await keep());
  await measure('pv.refolded', { expectZero: true });
  // キーボード: 「プロジェクトと実行」の［詳細］
  const tabsRt = await tabTo('section[aria-label="プロジェクトと実行"] button.fold');
  step('tabs to runtime fold', tabsRt);
  check('kbd.reachRt', 'Tab だけで「プロジェクトと実行」の［詳細］に届く', tabsRt !== null, tabsRt);
  await page.keyboard.press('Space');
  await sleep(300);
  check('kbd.rtExpand', 'Space で詳細を開く（所見・計装・環境変数が見える）', (await rtCompact()) === 'off' && await rtPanel().locator('.rt-env').isVisible(), await rtCompact());
  await measure('rt.expanded');          // 全体表示のままなら、広げたパネルを避けて収め直す
  await shot('08b-runtime-details-by-keyboard');
  await page.keyboard.press('Space');
  await sleep(300);
  check('kbd.rtFold', 'もう一度 Space で畳む', (await rtCompact()) === 'on', await rtCompact());
  check('kbd.rtKeep', '開閉しても選択・表示経路・観測・文書が変わらない', sameKeep(k0, await keep()), await keep());
  // 操作バーのパネルの開閉（キーボード）
  const tb = page.locator('[role="toolbar"][aria-label="キャンバス操作"]');
  await tb.locator('button', { hasText: '実行' }).focus();
  await page.keyboard.press('Enter');
  await sleep(200);
  check('kbd.rtClose', '操作バーの［実行］を Enter で閉じられる', (await rtPanel().count()) === 0, null);
  await page.keyboard.press('Enter');
  await sleep(200);
  check('kbd.rtOpen', 'もう一度 Enter で開く（実行中なので畳んだまま）', (await rtPanel().count()) === 1 && (await rtCompact()) === 'on', await rtCompact());
  await measure('rt.reopened', { expectZero: true });
  // 狭い画面での余地: 左の列（ページ・表示設定・全体）を操作バーで閉じると、経路図はどこまで大きくなるか
  for (const name of ['ページ', '表示設定', '全体']) await tb.locator('button', { hasText: new RegExp(`^${name}$`) }).click();
  await measure('leftClosed', { expectZero: true });
  await shot('08d-left-column-closed');
  for (const name of ['ページ', '表示設定', '全体']) await tb.locator('button', { hasText: new RegExp(`^${name}$`) }).click();
  await measure('leftReopened', { expectZero: true });
  // プレビューに戻って別の要素を選ぶ
  await selectBtn().click();
  await sleep(200);
  check('repick.expand', '畳んだ状態の［選択］で、ページの表示が広がり選択モードに入る', (await pvFolded()) === 'off' && (await pvAttr('data-select-mode')) === 'on', { f: await pvFolded(), m: await pvAttr('data-select-mode') });
  const a2 = await pickOnly({ sel: 'li[data-poc-field="a-region"]', nth: 1 });
  step('repick', a2);
  check('repick.linked', '別の要素（2つ目の li）を選べる・DB カラムまで結ばれる', a2.lineage === 'linked' && a2.at === a.at, a2);
  await exitSelect();
  await measure('repick.explore', { expectZero: true });
  await shot('08c-repick');

  scen('K9', '停止・再起動する');
  const before = await status();
  const ms = await stopRun();
  step('stop', { ms, preview: await pvAttr('data-preview-state'), selection: await pvAttr('data-selection') });
  check('stop.full', '停止中は「プロジェクトと実行」を全部出す（起動し直せる）', (await rtCompact()) === 'off' && await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).isVisible(), await rtCompact());
  check('stop.pv', '停止中のプレビューは、停止していると読める（畳まない）', (await pvFolded()) === 'off' && (await pvSection().innerText()).includes('停止しています'), await pvFolded());
  await measure('stopped');
  await shot('09a-stopped');
  const r2 = await startRun();
  step('restart', r2);
  const after = await status();
  check('restart.newPid', '再起動で別のプロセスになる', after.runtime?.pid !== before.runtime?.pid, { a: after.runtime?.pid, b: before.runtime?.pid });
  check('restart.compact', '再起動後、実行中はまた畳む', (await rtCompact()) === 'on', await rtCompact());
  check('restart.selCleared', '前の起動の選択は残らない', (await pvAttr('data-selection')) !== 'resolved', await pvAttr('data-selection'));
  await gotoPath('/lin-a');
  const a3 = await pickOnly({ sel: 'li[data-poc-field="a-region"]' });
  await exitSelect();
  check('restart.linked', '再起動後も DB カラムまで結ばれる', a3.lineage === 'linked', a3);
  await measure('restart.explore', { expectZero: true });
  await shot('09b-restarted-explore');
  await stopRun();
}

try {
  await main();
} catch (e) {
  if (cur) cur.error = String(e?.stack ?? e).slice(0, 800);
  console.log('ERROR', e);
  await shot('zz-error').catch(() => {});
} finally {
  ev.consoleErrors = consoleErrors;
  ev.finishedAt = new Date().toISOString();
  const failed = ev.checks.filter((c) => !c.ok);
  ev.result = { checks: ev.checks.length, failed: failed.length, failedIds: failed.map((c) => c.id) };
  console.log(`\n判定の材料: ${ev.checks.length} 件中 ${failed.length} 件が不成立`, failed.map((c) => c.id));
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    // raw（全要素の矩形）は大きいので別ファイルに分ける
    const raw = (ev.measures ?? []).map((x) => ({ scenario: x.scenario, label: x.label, raw: x.raw }));
    const slim = { ...ev, measures: (ev.measures ?? []).map(({ raw: _r, ...x }) => x) };
    fs.writeFileSync(OUT, JSON.stringify(slim, null, 1));
    fs.writeFileSync(OUT.replace(/\.json$/, '.raw.json'), JSON.stringify(raw));
  }
  await browser.close();
}
