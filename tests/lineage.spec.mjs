/* =============================================================================
 * PoC-04 — 変換結果を既存のキャンバスに流し込んだときの画面の検証。
 *   node tests/lineage.spec.mjs            既定 http://localhost:3100
 *
 * 見るのは「実測の関係と、静的解析による推定の関係が、画面の上で混ざらないか」
 * と「証拠が足りないときに線を引かずに切断のまま残すか」である。
 *
 * **UI の設計には手を入れていない。** データセットが3つ増えただけであり、
 * 描画部品・CSS・レイアウトの帯・詳細パネルの構成は PoC-02 のときと同じである。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const trace = require_('../.libjs/lib/trace.js');
const derive = require_('../.libjs/lib/derive.js');

const LIN_A = trace.buildDataset('lin-a');
const LIN_C = trace.buildDataset('lin-c');
const LIN_G = trace.buildDataset('lin-g');
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
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|404/.test(m.text())) pageErrors.push(m.text());
});

const count = (sel) => page.locator(sel).count();
const sceneText = async () => (await page.locator('svg.scene text').allTextContents()).join(' / ');
const open = async (key) => {
  await page.goto(`${BASE}/?data=${key}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(450);
};
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
/** 由来のホップ（推定）の DOM。aria-label に「推定」が入る */
const suppliesLabel = () => LIN_A.hops.find((h) => h.relation === 'supplies').label;

/* ========================================================================== */
console.log('\n1. ケースA — 由来を1列に絞れた場合');
await open('lin-a');
eq('キャンバスに9ノード出る', await count('g.nd'), 9);
eq('ホップは8本', await count('g.hp'), 8);
eq('追跡できない箇所は0件（由来を推定で結べたため）', await count('.ov-flag.cut'), 0);
ok('推定を含む旨が俯瞰に出る', (await page.locator('.ov-flag.est').innerText()).includes('1 か所'),
  await page.locator('.ov-flag.est').innerText());
ok('キャンバスに「由来は静的解析による推定」の語が残っている',
  (await sceneText()).includes('由来は静的解析による推定'), await sceneText());
await shot('lin-a-stage0');

console.log('\n1b. ケースA — 表示値を選ぶと、出所が列まで出る');
await page.locator('g.nd').first().click();
await page.waitForTimeout(350);
ok('出所の主張が「poc.listings . region」である',
  (await page.locator('.sum .claim .src').first().innerText()).includes('poc.listings . region'),
  await page.locator('.sum .claim .src').first().innerText());
eq('経路全体の語は「推定」である', await page.locator('.sum .chip-est').first().innerText(), '推定');
eq('★ブロック（いちばん弱いところ）が出る', await count('.weak'), 1);
ok('★ブロックの見出しが由来のホップである',
  (await page.locator('.weak .wh').innerText()).includes(suppliesLabel()),
  await page.locator('.weak .wh').innerText());
ok('★ブロックの説明が「静的解析による推定」と言っている',
  (await page.locator('.weak p').innerText()).includes('静的解析による推定'));
ok('★ブロックの説明が「実行時に観測したものではありません」と言っている',
  (await page.locator('.weak p').innerText()).includes('実行時に観測したものではありません'));
ok('★ブロックの説明に参照の連鎖が出る',
  (await page.locator('.weak p').innerText()).includes('参照の連鎖'));
ok('★ブロックの根拠に「SELECT 句」が出る',
  (await page.locator('.weak .ev').innerText()).includes('SELECT 句'));
ok('★ブロックに「値の一致」が根拠として出ていない',
  !(await page.locator('.weak .ev').innerText()).includes('値の一致'));
eq('番号付きリストの関係行のうち、推定は1本だけ', await count('.steps .rel.est'), 1);
await shot('lin-a-selected');

console.log('\n1c. ケースA — 由来のホップを選ぶ');
await page.locator('.steps .rel.est').click();
await page.waitForTimeout(300);
eq('選択された関係行がある', await count('.steps .rel.sel'), 1);
await shot('lin-a-supplies');

/* ========================================================================== */
console.log('\n2. ケースC — 候補が複数のまま');
await open('lin-c');
eq('キャンバスに10ノード出る', await count('g.nd'), 10);
await page.locator('g.nd').first().click();
await page.waitForTimeout(350);
const claimC = await page.locator('.sum .claim .src').first().innerText();
ok('主張を1列に断定していない', claimC.includes('候補のいずれか'), claimC);
ok('候補の件数（2）が主張に出る', claimC.includes('2 候補'), claimC);
ok('カラムのノードは3つ描かれている（到達できる列数と候補数は別である）',
  LIN_C.nodes.filter((n) => n.kind === 'column').length === 3);
eq('経路全体の語は「推定」である', await page.locator('.sum .chip-est').first().innerText(), '推定');
ok('★ブロックの説明に「候補が 2 件ある」が出る',
  (await page.locator('.weak p').innerText()).includes('候補が 2 件ある'),
  await page.locator('.weak p').innerText());
ok('★ブロックの説明に加工の注意が出る',
  (await page.locator('.weak p').innerText()).includes('表示値がその列の値そのままとは限りません'));
ok('根拠に2つの候補が両方並ぶ',
  (await page.locator('.weak .ev').innerText()).includes('poc.listings.region')
  && (await page.locator('.weak .ev').innerText()).includes('poc.listings.code'),
  await page.locator('.weak .ev').innerText());
await shot('lin-c-candidates');

/* ========================================================================== */
console.log('\n3. ケースG — 由来を作らない（切断のまま）');
await open('lin-g');
eq('キャンバスに9ノード出る', await count('g.nd'), 9);
eq('ホップは7本（由来のホップが無い）', await count('g.hp'), 7);
ok('追跡できない箇所が1件ある',
  (await page.locator('.ov-flag.cut').innerText()).includes('1 件'),
  await page.locator('.ov-flag.cut').innerText());
eq('推定を含む旨は出ない（推定の関係が0である）', await count('.ov-flag.est'), 0);
const sceneG = await sceneText();
ok('キャンバスに「ここから先は観測していません」が残る',
  sceneG.includes('ここから先は観測していません'), sceneG);
ok('キャンバスに「静的解析でも候補を出せませんでした」が出る',
  sceneG.includes('静的解析でも候補を出せませんでした'), sceneG);
ok('キャンバスに「由来は静的解析による推定」の語は出ない',
  !sceneG.includes('由来は静的解析による推定'));
await shot('lin-g-stage0');

await page.locator('g.nd').first().click();
await page.waitForTimeout(350);
/* 7C-3（P1-10）: 描画位置（実測）と値の由来（未確認）を分け、切れた段と理由を右ドックに出す */
const claimG = await page.locator('.sum [data-vo="render"]').first().innerText();
ok('描画位置はコードの位置までで止まる', claimG.includes('src/app/lin-g/page.tsx'), claimG);
ok('描画位置にテーブル名・カラム名が出ない',
  !claimG.includes('poc.listings') && !claimG.includes('region'), claimG);
eq('描画位置の語は「実測」である（嘘の推定を足していない）',
  await page.locator('.sum [data-vo="render"] .chip-est').first().innerText(), '実測');
ok('値の由来は「未確認」', (await page.locator('.sum [data-vo="lineage"]').innerText()).includes('未確認'));
eq('切れた段は「静的解析」', await page.locator('.sum [data-vo="stage"]').innerText(), '静的解析');
ok('理由（静的解析でも候補を出せなかった）が右ドックにある',
  (await page.locator('.sum [data-vo="reason"]').innerText()).includes('静的解析でも候補を出せませんでした'));
ok('見出し「この値の出所」を出さない（出所が実測で分かったように読ませない）',
  !(await page.locator('.sum').first().innerText()).includes('この値の出所'));
eq('★ブロックは出ない（推定の関係が1つも無い）', await count('.weak'), 0);
ok('「実測」は描画位置までの話だと明示される',
  (await page.locator('.sum').first().innerText()).includes('描画位置までの話'));
eq('番号付きリストに推定の関係行は無い', await count('.steps .rel.est'), 0);
await shot('lin-g-selected');

/* ========================================================================== */
console.log('\n4. 実測と推定が画面の上で混ざっていない');
for (const [name, ds] of [['ケースA', LIN_A], ['ケースC', LIN_C], ['ケースG', LIN_G]]) {
  ok(`${name}: 推定の要素は由来のホップだけである`,
    [...ds.nodes, ...ds.hops].filter((x) => x.observability === 'estimated')
      .every((x) => x.relation === 'supplies'),
    [...ds.nodes, ...ds.hops].filter((x) => x.observability === 'estimated')
      .map((x) => x.relation ?? x.title));
  ok(`${name}: ノードはすべて実測である`, ds.nodes.every((n) => n.observability === 'measured'));
  ok(`${name}: キャンバスに語を残しているのは推定のホップだけである`,
    ds.hops.filter((h) => h.tagLabel).every((h) => h.observability === 'estimated'));
}
ok('経路全体の観測性は、最弱環より高くならない',
  [['lin-a', 'estimated'], ['lin-c', 'estimated'], ['lin-g', 'measured']]
    .every(([k, want]) => derive.summarize(trace.buildDataset(k)).observability === want));

/* ========================================================================== */
console.log('\n5. 既存のキャンバス操作');
await open('lin-a');
const transform = () => page.locator('.scene > g').getAttribute('transform');
const zoom = () => page.locator('.ctl .val').innerText();
const t0 = await transform();
await page.mouse.move(700, 500);
await page.mouse.down();
await page.mouse.move(760, 540, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
ok('パンできる', (await transform()) !== t0);
await page.getByRole('button', { name: '拡大（＋）' }).click();
await page.waitForTimeout(250);
ok('ズームできる', (await zoom()) !== '100%', await zoom());
await page.locator('.ctl button.b', { hasText: '全体表示' }).first().click();
await page.waitForTimeout(250);
ok('全体表示に戻せる', (await zoom()).endsWith('%'), await zoom());
ok('浮かぶパネルは従来どおり出ている', (await count('.fpnl')) >= 1, await count('.fpnl'));
eq('N0 の対応範囲は「切断なし」と出る（0件を「部分対応・0件」と書かない）',
  await page.locator('.sup b').innerText(), '切断なし');
eq('ドックは固定のまま', await count('aside.dock'), 1);
eq('タブを並べていない（IX-16）', await count('.dtabs'), 0);

/* ========================================================================== */
console.log('\n6. 既存のデータセットは壊れていない');
ok('既存のデータセットは由来のホップを持たない',
  [SYNTH, MEASURED, ELEMENTS, FLOWS, RSC, SVC]
    .every((d) => !d.hops.some((h) => h.relation === 'supplies')));
ok('既存のデータセットは解決状態・候補を持たない（省略されたまま）',
  [SYNTH, MEASURED, ELEMENTS, FLOWS, RSC, SVC]
    .every((d) => d.hops.every((h) => h.linkStatus === undefined && h.candidates === undefined)));
ok('既存の RSC データセットでは ② と ②" の間に線が無いまま',
  !RSC.hops.some((h) => {
    const a = RSC.nodes.find((n) => n.id === h.from);
    const b = RSC.nodes.find((n) => n.id === h.to);
    return a?.kind === 'component' && b?.kind === 'component';
  }));
ok('既存の RSC データセットの主張は従来どおりコードの位置までである',
  derive.summarize(RSC).truncated === true, derive.summarize(RSC).claim);
/* 7C-3（P1-10）: DB に届いていない値だけ、描画位置と値の由来を分ける。届いている経路は従来どおり */
eq('valueOrigin: DB に届いている経路（合成・PoC-01・ケースA・ケースC）では使わない',
  [SYNTH, MEASURED, LIN_A, LIN_C].map((d) => derive.valueOrigin(d)).every((v) => v === null), true);
eq('valueOrigin: 値のノードが無い経路（Gate A）では使わない', derive.valueOrigin(SVC), null);
{
  const g = derive.valueOrigin(LIN_G);
  eq('valueOrigin(ケースG): 描画位置は特定済み・実測', `${g?.render.status}/${g?.render.observability}`, 'identified/measured');
  eq('valueOrigin(ケースG): 切れた段は静的解析', g?.stage, '静的解析');
  for (const [name, d] of [['PoC-03', ELEMENTS], ['PoC-05', FLOWS], ['PoC-02', RSC]]) {
    eq(`valueOrigin(${name}): 由来を評価していない記録だと言う`, derive.valueOrigin(d)?.stage, '値の由来の評価（この記録では行っていません）');
  }
}
for (const [name, key, n] of [['合成', 'synthetic', 7], ['PoC-01', 'measured', 7],
  ['PoC-03', 'elements', 9], ['PoC-05', 'flows', 10], ['PoC-02', 'rsc', 10],
  ['PoC-02(Gate A)', 'rsc-svc', 9]]) {
  await open(key);
  eq(`${name} のキャンバスは従来どおり描ける`, await count('g.nd'), n);
}

eq('JS エラーなし', pageErrors.length, 0, pageErrors);
await browser.close();

console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
