/* =============================================================================
 * PoC-01 — 実測データを既存のキャンバスに流し込んだときの画面の検証。
 *   node tests/measured.spec.mjs            既定 http://localhost:3100
 *
 * 合成データと同じ描画部品を通ることと、実測であることが画面から読めることを見る。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { installCanvasPrecondition, n0Shows } from './lib/canvas-precondition.mjs';
import { createRequire } from 'node:module';

/*
 * 期待値は変換結果（アダプタの出力）から取る。観測した内容は実行ごとに変わるので、
 * 件数を手で書くとテストが実測を縛ってしまう。ここで見たいのは
 * 「アダプタが作ったものが、そのままキャンバスに出ているか」である。
 */
const require_ = createRequire(import.meta.url);
const DS = require_('../.libjs/lib/trace.js').buildDataset('measured');

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
// 前提状態をそろえる: IDE の履歴で伸びる右上のパネルを、開くたびに閉じる（lib/canvas-precondition.mjs）
installCanvasPrecondition(page);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) pageErrors.push(m.text()); });

await page.goto(`${BASE}/?data=measured`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const count = (sel) => page.locator(sel).count();

/* -------------------------------------- 1. 実測データがキャンバスに描ける */
console.log('\n1. 実測データをキャンバスに表示できる');
eq('変換結果のノードをすべて描いている', await count('g.nd'), DS.nodes.length);
eq('変換結果のホップをすべて描いている', await count('g.hp'), DS.hops.length);
ok('ノードが1つ以上ある', DS.nodes.length > 0, DS.nodes.length);
eq('初期は未選択の俯瞰', await count('.nd.sel'), 0);
eq('ページの概要が出る', await count('section[aria-label="このページの概要"]'), 1);
ok('実測データであることを常時表示している',
  (await page.locator('.note.synth').innerText()).includes('実測データ'));
ok('合成データだと書いていない',
  !(await page.locator('.note.synth').innerText()).includes('合成'));
if (await n0Shows(page) === 'recorded') {
  ok('プロジェクト名は観測したアプリ',
    (await page.locator('.proj').innerText()).includes('Fixture'));
  ok('実行中のポートは観測したアプリのもの',
    (await page.locator('.chipbar .port').innerText()).includes('3200'));
  ok('計装方式が出ている',
    (await page.locator('.chipbar.ins').innerText()).includes('NODE_OPTIONS'));
} else {
  /* IDE が開発サーバーを扱った後は、N0 は実際のプロセスの状態を出す（7A の設計）。
   * そのときも記録の値は画面から読めることを確かめる（前提の違いで件数を変えない） */
  ok('（起動・停止の後）N0 は記録ではなく実際の開発サーバーの状態を出す',
    /未起動|実行中|停止しています|起動できていません/.test(await page.locator('header.n0').innerText()));
  ok('記録のポートはキャンバスの層のラベルに出ている',
    (await page.locator('.canvas').innerText()).includes('localhost:3200'));
  ok('記録の計装方式はキャンバスの常時の注記に出ている',
    (await page.locator('.note.synth').innerText()).includes('NODE_OPTIONS'));
}

const stats = await page.locator('.ov-stats dd').allInnerTexts();
eq('通信件数（主経路1 + 経路外1）', stats[0], '2 件');
ok('SQL件数が1件以上', /^[1-9]/.test(stats[1]), stats[1]);
ok('計測できた時間は実測の合算', /^\d+ ms$/.test(stats[2].trim()), stats[2]);
ok('計測できていない通信があるとは書かない（全件を計測できている）',
  !stats[2].includes('件ぶん'), stats[2]);
ok('数値の出所が実測であると書いてある',
  (await page.locator('.ov-synth').innerText()).includes('実際の計装から取得'));
ok('合成シナリオとは書いていない',
  !(await page.locator('.ov-synth').innerText()).includes('合成シナリオ'));
ok('除外した静的資材の件数を隠していない',
  /静的資材の通信 \d+ 件は件数に含めていません/.test(await page.locator('.ov-synth').innerText()));

/* ----------------------------- 2. 観測していない上流は切断として出ている */
console.log('\n2. 観測していない上流を切断として示す');
ok('追跡できない箇所がある', (await page.locator('.ov-flag.cut').innerText()).includes('1 件'));
const sceneText = async () =>
  (await page.locator('svg.scene text').allTextContents()).join(' / ');
const svg = await sceneText();
ok('「ここより上流は観測していません」と出ている', svg.includes('ここより上流は観測していません'), svg.slice(0, 200));
eq('観測していない「表示された値」のノードは描かない',
  await count('g.nd[aria-label^="表示された値"]'), 0);
eq('観測していない「コンポーネント」のノードは描かない',
  await count('g.nd[aria-label^="コンポーネント"]'), 0);
ok('プレビューは、値を観測していないことを述べている',
  (await page.locator('section[aria-label="プレビュー"]').innerText())
    .includes('表示された値を観測していません'));
eq('追跡できる値の見た目を作らない', await count('.trk'), 0);

/* -------------------------------- 3. ノードを選ぶと実測の詳細が出る */
console.log('\n3. ノード選択と詳細');
await page.locator('g.nd[aria-label^="通信"]').first().click();
await page.waitForTimeout(200);
eq('選択できる', await count('.nd.sel'), 1);
eq('経路スコープになる', (await page.locator('.dh .r span').first().innerText()), '経路');
eq('バッジが現れる', await count('.chipbadge'), DS.nodes.length);
eq('選択した行は「通信」', (await page.locator('.dock .st.cur .tt').innerText()), '通信');
ok('識別子は実測のメソッド・パス・ステータス・所要時間',
  /^GET \/api\/listings — 200 — \d+ms$/.test(
    await page.locator('.dock .st.cur .ts').innerText()),
  await page.locator('.dock .st.cur .ts').innerText());

const summary = await page.locator('.dock .sum p').first().innerText();
ok('経路サマリは導出値', /^\d+ か所のうち 0 か所が推定です。/.test(summary), summary);
ok('経路全体は実測', summary.includes('「実測」'), summary);
eq('推定が無いので最弱環の★ブロックは出ない', await count('.dock .ret'), 0);
ok('主張はテーブルと列から導出', /^poc\.listings \. /.test(
  await page.locator('.dock .claim .src').innerText()),
  await page.locator('.dock .claim .src').innerText());

await page.locator('g.nd[aria-label^="実行SQL"]').last().click();
await page.waitForTimeout(200);
eq('実行SQLを選べる', (await page.locator('.dock .st.cur .tt').innerText()), '実行SQL');
const ovw = await page.locator('.ovw').innerText();
ok('実行された SQL 文が出る', ovw.includes('SELECT'), ovw);
ok('パラメータ値は収集しないと明示', ovw.includes('収集しません'), ovw);
ok('取得件数は捏造せず「取得できていません」と書く',
  ovw.includes('計装から取得できていません'), ovw);
ok('SQL断片を札に置かない（表示規則3）', !(await sceneText()).includes('SELECT'), await sceneText());

console.log('\n4. 根拠タブに実測の証拠が出る');
await page.getByRole('tab', { name: '根拠' }).click();
await page.waitForTimeout(200);
const ev = await page.locator('.ev-card').innerText();
ok('観測性は実測', ev.includes('実測'), ev);
ok('取得手段は 02d の語彙で出る', ev.includes('ORM計装のスパン属性'), ev);
ok('根拠に計装の名前が出る', ev.includes('計装 prisma'), ev);
ok('根拠に親子関係が出る', /親子の連鎖|直接の子/.test(ev), ev);
ok('スパンの時間窓が出る', ev.includes('読み込み開始から'), ev);
ok('確度（高・中・低）は出さない', !/確度.*[高中低]/.test(ev.replace(/確度（高・中・低）は表示しません[\s\S]*/, '')), ev);

console.log('\n5. 合成データ側は壊れていない');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
eq('合成は7ノードのまま', await count('g.nd'), 7);
eq('合成は7ホップのまま', await count('g.hp'), 7);
ok('合成と実測で描画部品は同じものを使っている（同じクラス名で描かれる）',
  (await count('g.nd')) > 0 && (await count('g.hp')) > 0);
ok('合成データである旨を出す',
  (await page.locator('.note.synth').innerText()).includes('合成データ'));

if (SHOTS) {
  await page.goto(`${BASE}/?data=measured`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/measured-stage0.png` });
  await page.locator('g.nd[aria-label^="実行SQL"]').last().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/measured-sql-selected.png` });
  await page.getByRole('tab', { name: '根拠' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/measured-evidence.png` });
}

eq('JS エラーなし', pageErrors.length, 0);
await browser.close();

console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
