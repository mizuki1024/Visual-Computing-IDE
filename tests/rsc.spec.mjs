/* =============================================================================
 * PoC-02 — 変換結果を既存のキャンバスに流し込んだときの画面の検証。
 *   node tests/rsc.spec.mjs              既定 http://localhost:3100
 *
 * 見るのは「API ノードの無い経路（rsc-direct）と、サーバー内部の通信が
 * 既存の描画部品のまま出るか」と「証拠の無い関係を線でつないでいないか」である。
 * UI の設計には手を入れていない。データセットが2つ増えただけである。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { installCanvasPrecondition, n0Shows } from './lib/canvas-precondition.mjs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const trace = require_('../.libjs/lib/trace.js');
const RSC = trace.buildDataset('rsc');
const SVC = trace.buildDataset('rsc-svc');
const FLOWS = trace.buildDataset('flows');
const ELEMENTS = trace.buildDataset('elements');
const MEASURED = trace.buildDataset('measured');
const SYNTH = trace.buildDataset('synthetic');

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`);
    console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`);
  }
};
const eq = (name, a, b) => ok(name, a === b, a);

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
// 前提状態をそろえる: IDE の履歴で伸びる右上のパネルを、開くたびに閉じる（lib/canvas-precondition.mjs）
installCanvasPrecondition(page);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|404/.test(m.text())) pageErrors.push(m.text());
});

const count = (sel) => page.locator(sel).count();
const sceneText = async () => (await page.locator('svg.scene text').allTextContents()).join(' / ');
const zoom = () => page.locator('.ctl .val').innerText();

await page.goto(`${BASE}/?data=rsc`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

/* ------------------------- 1. 既存の描画部品のまま描けている */
console.log('\n1. PoC-02 の実測データ（RSC 直読み）をキャンバスに描ける');
eq('変換結果のノードをすべて描いている', await count('g.nd'), RSC.nodes.length);
eq('変換結果のホップをすべて描いている', await count('g.hp'), RSC.hops.length);
eq('コンポーネントのノードが2つある', await count('g.nd[aria-label^="コンポーネント"]'), 2);
eq('サーバー処理のノードは1つ', await count('g.nd[aria-label^="サーバー処理"]'), 1);
const svg = await sceneText();
ok('Server Component の名前が札に出る', svg.includes('RscDb'), svg.slice(0, 400));
ok('実測データであることを常時表示している',
  (await page.locator('.note.synth').innerText()).includes('PoC-02 実測データ'));
// N0 が実際の開発サーバーの状態を出しているとき（起動・停止の後。7A の設計）は、記録の表示（常時の注記）で確かめる
ok('伝播と呼び出しスタックを使ったことを計装表示に出している',
  (await n0Shows(page) === 'recorded' ? await page.locator('header.n0').innerText()
    : await page.locator('.note.synth').innerText()).includes('W3C 伝播'));
ok('観測したページは /rsc-db',
  (await page.locator('section[aria-label="このページの概要"] .claim .src').innerText())
    .includes('/rsc-db'));

/* -------------------- 2. 架空の API ノードが無い（rsc-direct の要） */
console.log('\n2. 架空の API ノードを作っていない');
ok('通信のノードは1つだけ（文書の取得）', RSC.nodes.filter((n) => n.kind === 'http').length === 1);
ok('/api/ を含むノードが画面に1つも無い', !svg.includes('/api/'), svg.slice(0, 400));
ok('画面に出ている通信は文書取得である', svg.includes('GET /rsc-db'));
ok('ブラウザの API 通信が 0 件であることを概要で言っている',
  (await page.locator('section[aria-label="このページの概要"]').innerText()).includes('API 通信は 0 件'));

/* ----------------- 3. 証拠のある関係だけを描き、無いところは切断のまま */
console.log('\n3. 証拠のある関係だけを描く');
ok('推定の関係を1本も描いていない', RSC.hops.every((h) => h.observability === 'measured'));
ok('追跡できない箇所は1件（props の由来だけ）',
  (await page.locator('.ov-flag.cut').innerText()).includes('1 件'));
ok('「描いたコンポーネント」と「実行したコンポーネント」を線で結んでいない', (() => {
  const ids = RSC.nodes.filter((n) => n.kind === 'component').map((n) => n.id);
  return !RSC.hops.some((h) => ids.includes(h.from) && ids.includes(h.to));
})());
ok('切断の文言が画面に出ている', svg.includes('ここから先は観測していません'), svg.slice(0, 400));
ok('props の由来が切断の理由として書いてある', svg.includes('props の由来'));

/* ------------------------------ 4. ノードを選んだときに根拠が出る */
console.log('\n4. 実行したコンポーネントの根拠');
await page.locator('g.nd[aria-label^="コンポーネント"]').nth(1).click();
await page.waitForTimeout(400);
const dock = () => page.locator('aside[aria-label="詳細"]').innerText();
const d1 = await dock();
ok('取得手段として呼び出しスタックを出している', d1.includes('呼び出し時に記録したスタック'), d1.slice(0, 500));
ok('呼び出し位置（ファイルと行）を出している', d1.includes('src/app/rsc-db/page.tsx:12'));
ok('照合したソース行を出している', d1.includes('pool.query'));
ok('主張の範囲を明示している', d1.includes('主張の範囲'));
ok('ブラウザの API 通信ではないと断っている', d1.includes('API 通信ではありません'));
/*
 * 1つの実行SQL に2本の関係（スパンの親子・呼び出しスタック）が入る。
 * これを「経路を戻ります（いちばん弱いところ）」の ★ 行として出すと嘘になる。
 * 戻っていないし、いちばん弱くもない（全部が実測である）。
 */
ok('戻るホップが無いので ★ 行を出していない', !d1.includes('の応答へ戻ります'), d1.slice(-600));
ok('2本目の関係は、関係の行として並んでいる',
  d1.includes('そのコンポーネントが実行したSQL') && d1.includes('その処理が実行したSQL'),
  d1.slice(-600));
await page.getByRole('tab', { name: '根拠' }).click();
await page.waitForTimeout(300);
const ev = await dock();
ok('根拠に「呼び出しの入口で記録した」と書いてある', ev.includes('呼び出しの入口'), ev.slice(0, 600));
ok('根拠に2つの情報源の一致が書いてある', ev.includes('マニフェスト'));
await page.getByRole('tab', { name: '概要' }).click();

/* ------------------------- 5. サーバー処理の粒度を正しく言っている */
console.log('\n5. サーバー処理の粒度');
await page.locator('g.nd[aria-label^="サーバー処理"]').first().click();
await page.waitForTimeout(400);
const d2 = await dock();
ok('描画スパンがルート単位であると断っている', d2.includes('ルート単位'), d2.slice(0, 500));
ok('このスパンだけではコンポーネントを特定できないと書いてある',
  d2.includes('特定のコンポーネントの処理とは言えません'));

if (SHOTS) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/rsc-stage0.png` });
  await page.locator('g.nd[aria-label^="コンポーネント"]').nth(1).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/rsc-component-selected.png` });
  await page.getByRole('tab', { name: '根拠' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/rsc-evidence.png` });
  await page.getByRole('tab', { name: '概要' }).click();
}

/* ============================ Gate A のデータセット ============================ */
await page.goto(`${BASE}/?data=rsc-svc`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

console.log('\n6. サーバー内部の通信（Gate A）をキャンバスに描ける');
eq('変換結果のノードをすべて描いている', await count('g.nd'), SVC.nodes.length);
eq('変換結果のホップをすべて描いている', await count('g.hp'), SVC.hops.length);
eq('サーバー処理のノードが2つある（2つのサービス）',
  await count('g.nd[aria-label^="サーバー処理"]'), 2);
const svg2 = await sceneText();
ok('2つ目のサービスの名前が足元のラベルに出る', svg2.includes('poc02-fixture-svc'), svg2.slice(0, 500));
ok('1つ目は開発サーバーのままである', svg2.includes('開発サーバー'));
ok('ここにも /api/ のノードは無い', !svg2.includes('/api/'));

console.log('\n7. 伝播の根拠');
await page.locator('g.nd[aria-label^="サーバー処理"]').nth(1).click();
await page.waitForTimeout(400);
const d3 = await dock();
ok('取得手段としてトレースコンテキストの伝播を出している',
  d3.includes('トレースコンテキストの伝播'), d3.slice(0, 500));
ok('別プロセスであることを出している', d3.includes('別のプロセス'));
ok('伝播の方式を出している', d3.includes('traceparent'));
await page.getByRole('tab', { name: '根拠' }).click();
await page.waitForTimeout(300);
const ev3 = await dock();
ok('根拠に親子関係とトレースIDの一致が書いてある',
  ev3.includes('子である') && ev3.includes('トレースID'), ev3.slice(0, 600));
await page.getByRole('tab', { name: '概要' }).click();

console.log('\n8. サーバー内部の通信はブラウザに現れないと書いてある');
await page.locator('g.nd[aria-label^="通信"]').nth(1).click();
await page.waitForTimeout(400);
const d4 = await dock();
ok('ブラウザには現れないと明示している', d4.includes('ブラウザには現れません'), d4.slice(0, 500));
ok('宛先がループバックであることを出している', d4.includes('ループバック'));

if (SHOTS) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/rsc-svc-stage0.png` });
  await page.locator('g.nd[aria-label^="サーバー処理"]').nth(1).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/rsc-svc-propagation.png` });
}

/* ---------------------------------- 9. 既存のキャンバス操作 */
console.log('\n9. 既存のキャンバス操作');
await page.goto(`${BASE}/?data=rsc`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.locator('g.nd').first().click();
await page.waitForTimeout(300);
eq('選択できる', await count('g.nd.sel'), 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
eq('Esc で未選択へ戻る', await count('g.nd.sel'), 0);
await page.keyboard.press('5');
await page.waitForTimeout(300);
const b5 = await page.locator('g.nd.sel').getAttribute('aria-label');
ok('数字キーでバッジの対象を選べる', !!b5, b5);
ok('5 は「コンポーネント」である（経路の順に振られている）',
  (b5 ?? '').startsWith('コンポーネント'), b5);
const z0 = await zoom();
await page.keyboard.press('Escape');
await page.locator('g.nd[aria-label^="テーブル"]').first().click();
await page.waitForTimeout(400);
eq('選択してもズームは維持', await zoom(), z0);
await page.mouse.move(1100, 940);
await page.mouse.down();
await page.mouse.move(1140, 950);
await page.mouse.up();
await page.waitForTimeout(200);
eq('空白のドラッグで選択は変わらない', await count('g.nd.sel'), 1);
await page.locator('button:has-text("全体表示")').click();
await page.waitForTimeout(400);
ok('全体表示が効く', (await zoom()) !== z0, await zoom());

/* ---------------------------------- 10. 既存のデータセットの回帰 */
console.log('\n10. 既存のデータセットは壊れていない');
eq('合成は7ノードのまま', SYNTH.nodes.length, 7);
eq('合成は7ホップのまま', SYNTH.hops.length, 7);
eq('PoC-01 の実測は7ノードのまま', MEASURED.nodes.length, 7);
eq('PoC-03 の実測は9ノードのまま', ELEMENTS.nodes.length, 9);
eq('PoC-05 の実測は10ノードのまま', FLOWS.nodes.length, 10);
{
  /* 合成シナリオには経路を戻るホップ（maps）がある。★ 行は従来どおり出す */
  await page.goto(`${BASE}/?data=synthetic`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.locator('g.nd').first().click();
  await page.waitForTimeout(400);
  const t = await page.locator('aside[aria-label="詳細"]').innerText();
  ok('合成シナリオの ★ 行は従来どおり出る', t.includes('の応答へ戻ります'), t.slice(-500));
}
ok('既存のデータセットに queries のホップを足していない',
  [SYNTH, MEASURED, ELEMENTS, FLOWS].every((d) => !d.hops.some((h) => h.relation === 'queries')));
ok('既存のデータセットに server-call-stack を足していない',
  [SYNTH, MEASURED, ELEMENTS, FLOWS].every((d) => !d.nodes.some((n) => n.source === 'server-call-stack')));
ok('既存のデータセットに足元のラベルの上書きを足していない',
  [SYNTH, MEASURED, ELEMENTS, FLOWS].every((d) => !d.nodes.some((n) => n.locus)));
for (const [name, key, n] of [['合成', 'synthetic', 7], ['PoC-01', 'measured', 7],
  ['PoC-03', 'elements', 9], ['PoC-05', 'flows', 10]]) {
  await page.goto(`${BASE}/?data=${key}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  eq(`${name} のキャンバスは従来どおり描ける`, await count('g.nd'), n);
}

eq('JS エラーなし', pageErrors.length, 0);
await browser.close();

console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
