/* =============================================================================
 * Phase 7C-3 — 限定試用前の表示改善（P1-9・P1-10）の受入を、実ブラウザで**利用者の操作**として通す。
 *   BASE=http://127.0.0.1:3100 SHOTS=docs/07c3-screenshots/1600x1000 VCIDE_ACC_W=1600 VCIDE_ACC_H=1000 \
 *     node scripts/acceptance-7c3.mjs
 *
 * 試験（tests/）ではない。合否は報告書（docs/07c3-trial-readiness-report.md）で人が判断する。
 *   P1-9  実プロジェクトを開いている間（起動前・起動中・観測前・停止後・再起動後）に、
 *         合成デモ（別のアプリの /listings・「千葉県」）を描かない。明示的に選べば見られる
 *   P1-10 描画位置（実測）と値の由来（未確認）を右ドックで区別し、切れた段と理由を出す
 *   回帰  /lin-a の推定経路は従来どおり。P0-2 の重なり（7C-0 / 7C-2 の計測）が 0 のまま
 * 浮かぶパネルは隠さない。前提: 新しく起動した IDE（BASE）・題材の DB（poc/README.md）。
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

const ev = { base: BASE, viewport: `${VW}x${VH}`, startedAt: new Date().toISOString(), scenarios: [], checks: [], phaseSamples: [] };
let cur = null;
const scen = (id, title) => { cur = { id, title, steps: [], error: null }; ev.scenarios.push(cur); console.log(`\n## ${id} ${title}`); };
const step = (k, v) => { cur.steps.push({ k, v }); console.log(`  - ${k}: ${typeof v === 'string' ? v.slice(0, 300).replace(/\n/g, ' ⏎ ') : JSON.stringify(v)?.slice(0, 300)}`); };
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

/**
 * 合成デモの痕跡（別のアプリ）。画面の文字（キャンバスの札・右ドック・浮かぶパネル・注記）と、
 * 描いているノードの数で判定する。題材にも /listings があるので、パスでは判定しない
 */
const SYNTH_MARKS = ['千葉県', 'Sample Property App', '合成シナリオ', 'シナリオは合成データ', 'エリアから', 'No.900001'];
async function synthState() {
  return page.evaluate((marks) => {
    const text = [
      document.querySelector('aside.dock')?.innerText ?? '',
      document.querySelector('.canvas')?.innerText ?? '',
      document.querySelector('header.n0')?.innerText ?? '',
    ].join('\n');
    return {
      marks: marks.filter((m) => text.includes(m)),
      nodes: document.querySelectorAll('g.nd').length,
      notice: document.querySelector('.note.synth')?.getAttribute('data-notice') ?? null,
      noticeText: document.querySelector('.note.synth')?.textContent ?? '',
      phase: document.querySelector('.cv-empty')?.getAttribute('data-project-phase') ?? null,
      dockPhase: document.querySelector('aside.dock [data-project-phase]')?.getAttribute('data-project-phase') ?? null,
      cardHead: document.querySelector('.cv-empty b')?.textContent ?? null,
      dockHead: document.querySelector('aside.dock .pe-head')?.textContent ?? null,
      banner: !!document.querySelector('.demo-banner'),
    };
  }, SYNTH_MARKS);
}
async function noSynth(id, label, { expectNodes = 0, phase } = {}) {
  const s = await synthState();
  step(`synth.${id}`, s);
  check(`${id}.noSynth`, `${label}: 合成デモの文字（千葉県・Sample Property App・合成シナリオ 等）が画面に無い`, s.marks.length === 0, s.marks);
  if (expectNodes === 0) check(`${id}.noNodes`, `${label}: キャンバスに経路のノードを描いていない`, s.nodes === 0, s.nodes);
  if (phase) check(`${id}.phase`, `${label}: キャンバスと右ドックが「${phase}」の空の状態を出す`, s.phase === phase && s.dockPhase === phase, { c: s.phase, d: s.dockPhase });
  return s;
}

async function measure(label, { expectZero = false } = {}) {
  await settle();
  const m = await measureCanvas(page);
  const s = summarizeCanvas(m);
  const o = summarizeOverlap(await overlap(page));
  step(`measure.${label}`, s);
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
/** 起動して、途中の段階（キャンバスの空の状態）を標本として記録する */
async function startRun(tag) {
  const t0 = Date.now();
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  const seen = new Set();
  for (;;) {
    const s = await synthState();
    const key = `${s.phase}|${s.marks.length}|${s.nodes}`;
    if (!seen.has(key)) { seen.add(key); ev.phaseSamples.push({ tag, ms: Date.now() - t0, ...s }); }
    const v = await pvAttr('data-preview-state');
    if (v === 'live' || v === 'error' || v === 'unavailable' || v === 'unreachable') return { preview: v, ms: Date.now() - t0, samples: [...seen] };
    if (Date.now() - t0 > 240000) return { preview: v, ms: Date.now() - t0, timeout: true, samples: [...seen] };
    await sleep(250);
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
async function pick(locator, { waitLineage = true, timeout = 45000 } = {}) {
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
  await sleep(500);
  if ((await pvAttr('data-select-mode')) === 'on') await selectBtn().click();
  await sleep(300);
  return {
    selection: await pvAttr('data-selection'), at: await pvAttr('data-sel-at'),
    lineage: await pvAttr('data-lineage'), lineageReason: await pvAttr('data-lineage-reason'),
    lineageStage: await pvAttr('data-lineage-stage'), cands: await pvAttr('data-lineage-cands'),
  };
}
async function showBound() {
  const seq = await pvAttr('data-doc-seq');
  const row = pv().locator('.pvobsrow');
  await page.waitForFunction(() => Number(document.querySelector('.pvobsrow')?.getAttribute('data-obs-count') ?? 0) > 0, null, { timeout: 60000 }).catch(() => {});
  if (seq) await row.locator('select').selectOption(seq).catch(() => {});
  await row.locator('.rt-b', { hasText: '表示' }).click();
  await page.waitForFunction(() => document.querySelector('.pvobsrow')?.getAttribute('data-obs-shown'), null, { timeout: 15000 }).catch(() => {});
  await sleep(700);
  return { shown: await row.getAttribute('data-obs-shown'), withSel: await row.getAttribute('data-obs-with-sel') };
}
async function stopRun() {
  const t0 = Date.now();
  await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
  await waitPv('stopped', 60000).catch(() => {});
  await sleep(400);
  return Date.now() - t0;
}
/** 右ドックの「描画位置と値の由来」の行 */
const voRows = () => page.evaluate(() => {
  const el = document.querySelector('aside.dock [data-value-origin]');
  if (!el) return null;
  const g = (k) => el.querySelector(`[data-vo="${k}"]`)?.textContent?.trim() ?? null;
  return { head: el.querySelector('.k')?.textContent ?? null, render: g('render'), lineage: g('lineage'), stage: g('stage'), reason: g('reason') };
});

async function main() {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await sleep(600);

  scen('C1', 'IDE を開く（プロジェクト未指定）— 合成デモは従来どおり');
  {
    const s = await synthState();
    step('state', s);
    check('open.demo', 'プロジェクト未指定では合成デモを描く（Phase 5 の基準のまま）', s.nodes > 0 && s.notice === 'synthetic', s);
  }
  await shot('01-open-no-project');

  scen('C2', 'プロジェクトを開く（起動前）');
  step('verdict', await inspectProject(PROJECT));
  await sleep(500);
  await noSynth('opened', '起動前', { phase: 'opened' });
  check('opened.card', 'キャンバスに「まだ起動していません」と［起動］の案内', /まだ起動していません/.test((await synthState()).cardHead ?? '') && (await page.locator('.cv-empty').innerText()).includes('起動'), await page.locator('.cv-empty').innerText().catch(() => ''));
  check('opened.preview', 'プレビューは合成の見本サイトではなく、起動の案内', (await pvSection().locator('[data-preview-state="project-empty"]').count()) === 1, null);
  check('opened.bar', '上の帯は「開発サーバー 未起動」（合成デモの記録の実行環境を出さない）', (await page.locator('header.n0 [data-runtime-chip="not-started"]').count()) === 1, await page.locator('header.n0').innerText());
  await shot('02a-opened');
  // 明示的に合成デモを選ぶ
  await page.locator('.cv-empty .pe-demo').click();
  await sleep(400);
  {
    const s = await synthState();
    step('demo', s);
    check('demo.shown', '［合成デモを見る］で合成デモを描ける（明示的に選んだとき）', s.nodes > 0 && s.marks.length > 0, s);
    check('demo.banner', '合成デモの間は「別のアプリの見本」「あなたのプロジェクトのデータではありません」と［デモを閉じる］', s.banner && (await page.locator('.demo-banner').innerText()).includes('データではありません'), null);
    check('demo.dockBanner', '右ドックにも合成デモであることを出す', (await dockText()).includes('合成デモを表示中'), (await dockText()).slice(0, 200));
  }
  await shot('02b-demo-chosen');
  await page.locator('.demo-banner .rt-b', { hasText: 'デモを閉じる' }).click();
  await sleep(300);
  await noSynth('demoClosed', '［デモを閉じる］の後', { phase: 'opened' });

  scen('C3', '起動する（起動中 → 実行中・観測前）');
  const r = await startRun('first');
  step('start', { preview: r.preview, ms: r.ms, samples: r.samples });
  const firstSamples = ev.phaseSamples.filter((x) => x.tag === 'first');
  check('starting.noSynth', '起動中の全標本で合成デモの文字・ノードが無い', firstSamples.every((x) => x.marks.length === 0 && x.nodes === 0), firstSamples.map((x) => ({ p: x.phase, m: x.marks, n: x.nodes })));
  check('starting.phase', '起動中は「開発サーバーを起動しています」を出した', firstSamples.some((x) => x.phase === 'starting'), firstSamples.map((x) => x.phase));
  await sleep(800);
  const sRun = await noSynth('running', '実行中・選択前', { phase: 'running' });
  check('running.head', '実行中・選択前は「まだ経路がありません」', sRun.cardHead === 'まだ経路がありません' && sRun.dockHead === 'まだ経路がありません', sRun);
  check('running.guide', 'ページを開いて［選択］で値を選ぶ操作を案内する', /［選択］/.test(await page.locator('.cv-empty').innerText()), null);
  await measure('running.empty');
  await shot('03-running-no-path');

  scen('C4', '/lin-a の値を選ぶ（推定経路は従来どおり）');
  await gotoPath('/lin-a');
  const a = await pick({ sel: 'li[data-poc-field="a-region"]' });
  step('pick', a);
  check('lina.linked', '/lin-a の値が DB カラム（poc.listings.region）まで結ばれる', a.lineage === 'linked' && /poc\.listings\.region/.test(a.cands ?? ''), a);
  const dA = await dockText();
  check('lina.dock', '右ドックは従来の「この値の出所 … 推定」（P1-10 の分けた表示にならない）', dA.includes('この値の出所') && dA.includes('listings . region') && dA.includes('推定') && !(await voRows()), dA.slice(0, 200));
  check('lina.weakest', '★ いちばん弱いところ（由来は静的解析による推定）が出る', dA.includes('いちばん弱いところ'), null);
  await measure('lina', { expectZero: true });
  await shot('04-lin-a-linked');

  scen('C5', '/lin-g の値を選ぶ（由来が切れる）— 描画位置と値の由来を分ける');
  await gotoPath('/lin-g');
  const g = await pick({ sel: 'p[data-poc-field="g-shadow"]' });
  step('pick', g);
  check('ling.cut', '由来が切れる（理由つき）', g.lineage === 'cut' && !!g.lineageReason, g);
  const vo = await voRows();
  step('dock.vo', vo);
  check('ling.render', '右ドック: 描画位置は「特定済み」（実測）とソース位置', !!vo && /特定済み/.test(vo.render) && /実測/.test(vo.render) && /src\/app\/lin-g\/page\.tsx:\d+/.test(vo.render), vo);
  check('ling.lineage', '右ドック: 値の由来は「未確認」', !!vo && /未確認/.test(vo.lineage), vo);
  check('ling.stage', '右ドック: 切れた段階（静的解析）', !!vo && vo.stage === '静的解析' && g.lineageStage === 'static', { vo, g });
  check('ling.reason', '右ドック: 理由（参照の連鎖を解けない）', !!vo && /参照の連鎖/.test(vo.reason), vo);
  const dG = await dockText();
  check('ling.noClaim', '右ドックに「この値の出所 <描画位置> 実測」の見出しを出さない', !dG.includes('この値の出所'), dG.slice(0, 300));
  await measure('ling', { expectZero: true });
  await shot('05a-lin-g-cut-dock');
  const b = await showBound();
  step('showBound', b);
  const vo2 = await voRows();
  check('ling.withObs', '同じ文書の通信（SQL）を並べても、値の由来は「未確認」のまま・段と理由も同じ', !!vo2 && /未確認/.test(vo2.lineage) && vo2.stage === '静的解析' && /参照の連鎖/.test(vo2.reason), vo2);
  await measure('ling.withObs', { expectZero: true });
  await shot('05b-lin-g-cut-with-observation');

  scen('C6', '特定できない要素を選ぶ（描画位置も分からない）');
  await gotoPath('/cards');
  const u = await pick({ sel: '[data-poc-kind="vendor-panel"]', position: { x: 4, y: 4 } }, { waitLineage: false, timeout: 20000 });
  step('pick', u);
  const vu = await voRows();
  step('dock.vo', vu);
  check('unres.render', '右ドック: 描画位置「特定できません」・値の由来「未確認」・段「描画位置の特定」', !!vu && /特定できません/.test(vu.render) && /未確認/.test(vu.lineage) && vu.stage === '描画位置の特定', vu);
  await measure('unresolved', { expectZero: true });
  await shot('06-unresolved');

  scen('C7', '停止する（以前の実測も合成デモも出さない）');
  const before = await status();
  step('stop', { ms: await stopRun() });
  await noSynth('stopped', '停止後', { phase: 'stopped' });
  check('stopped.noPrev', '停止後は以前の実測（/lin-g・/cards の選択や通信）をキャンバスに描かない', (await page.locator('g.nd').count()) === 0 && (await synthState()).notice === 'project-empty', await synthState());
  await shot('07-stopped');

  scen('C8', '再起動する（新しい観測を待つ）');
  const r2 = await startRun('restart');
  step('restart', { preview: r2.preview, ms: r2.ms, samples: r2.samples });
  const restartSamples = ev.phaseSamples.filter((x) => x.tag === 'restart');
  check('restart.noSynth', '再起動中の全標本で合成デモの文字・ノードが無い', restartSamples.every((x) => x.marks.length === 0 && x.nodes === 0), restartSamples.map((x) => ({ p: x.phase, m: x.marks, n: x.nodes })));
  const after = await status();
  check('restart.newPid', '再起動で別のプロセスになる', after.runtime?.pid !== before.runtime?.pid, { a: after.runtime?.pid, b: before.runtime?.pid });
  await sleep(800);
  await noSynth('restarted', '再起動後・選択前', { phase: 'running' });
  check('restart.wait', '再起動後は「前の起動で観測した経路は表示しません（新しい観測を待っています）」', (await dockText()).includes('新しい観測を待っています'), (await dockText()).slice(0, 300));
  await shot('08a-restarted-waiting');
  await gotoPath('/lin-a');
  const a3 = await pick({ sel: 'li[data-poc-field="a-region"]' });
  check('restart.linked', '再起動後も /lin-a は DB カラムまで結ばれる', a3.lineage === 'linked', a3);
  await measure('restart.lina', { expectZero: true });
  await shot('08b-restarted-lin-a');
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
    const raw = (ev.measures ?? []).map((x) => ({ scenario: x.scenario, label: x.label, raw: x.raw }));
    const slim = { ...ev, measures: (ev.measures ?? []).map(({ raw: _r, ...x }) => x) };
    fs.writeFileSync(OUT, JSON.stringify(slim, null, 1));
    fs.writeFileSync(OUT.replace(/\.json$/, '.raw.json'), JSON.stringify(raw));
  }
  await browser.close();
}
