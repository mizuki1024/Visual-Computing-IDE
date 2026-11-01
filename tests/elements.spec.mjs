/* =============================================================================
 * PoC-03 — 変換結果を既存のキャンバスに流し込んだときの画面の検証。
 *   node tests/elements.spec.mjs            既定 http://localhost:3100
 *
 * 見るのは「①表示された値 と ②コンポーネントが、既存の描画部品のまま出るか」
 * と「観測していないことが画面から読めるか」である。
 * UI の設計には手を入れていない。データセットが増えただけである。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const trace = require_('../.libjs/lib/trace.js');
const DS = trace.buildDataset('elements');
const MEASURED = trace.buildDataset('measured');
const SYNTH = trace.buildDataset('synthetic');

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
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) pageErrors.push(m.text()); });

await page.goto(`${BASE}/?data=elements`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const count = (sel) => page.locator(sel).count();
const sceneText = async () => (await page.locator('svg.scene text').allTextContents()).join(' / ');

/* ----------------------------- 1. ①② が既存の描画部品のまま出る */
console.log('\n1. 表示された値とコンポーネントがキャンバスに出る');
eq('変換結果のノードをすべて描いている', await count('g.nd'), DS.nodes.length);
eq('変換結果のホップをすべて描いている', await count('g.hp'), DS.hops.length);
eq('「表示された値」のノードが出る', await count('g.nd[aria-label^="表示された値"]'), 1);
eq('「コンポーネント」のノードが出る', await count('g.nd[aria-label^="コンポーネント"]'), 1);
ok('コンポーネント名が札に出る', (await sceneText()).includes('RegionBadge'));
ok('実測データであることを常時表示している',
  (await page.locator('.note.synth').innerText()).includes('実測データ'));
ok('要素識別子の注入方式を明示している',
  (await page.locator('.note.synth').innerText()).includes('要素識別子'));
ok('観測したページは /cards',
  (await page.locator('section[aria-label="このページの概要"] .claim .src').innerText()).includes('/cards'));

/* ------------------------- 2. つながっていないところは切断として出る */
console.log('\n2. 観測していない関係は線を引かずに切断で示す');
ok('追跡できない箇所が2件ある', (await page.locator('.ov-flag.cut').innerText()).includes('2 件'));
const svg = await sceneText();
ok('props の由来を観測していないと書いてある', svg.includes('props の由来'), svg.slice(0, 300));
ok('通信の呼び出し元を特定していないと書いてある',
  svg.includes('この通信を起こした箇所は特定していません'), svg.slice(0, 300));
ok('推定の関係を1本も描いていない',
  DS.hops.every((h) => h.observability === 'measured'));
eq('derives の線を描いていない', await count('g.hp[aria-label*="derives"]'), 0);

console.log('\n2b. 到達していない終点を「出所」と言い切らない');
await page.locator('g.nd[aria-label^="表示された値"]').first().click();
await page.waitForTimeout(250);
const claim = await page.locator('.dock .claim .src').innerText();
ok('主張はたどり着けたソース位置', claim.includes('RegionBadge.tsx'), claim);
ok('到達していないテーブル・カラムを出所と書かない',
  !claim.includes('listings') && !claim.includes('region ('), claim);
ok('途中で途切れていることを書いてある',
  (await page.locator('.dock .sum').innerText()).includes('ここから先はたどれていません'));

/* --------------------------------- 3. 値を選ぶと出所が読める */
console.log('\n3. 値を選ぶと、描いたコンポーネントとソース位置まで読める');
await page.locator('g.nd[aria-label^="表示された値"]').first().click();
await page.waitForTimeout(250);
eq('選択できる', await count('.nd.sel'), 1);
eq('選択した行は「表示された値」', await page.locator('.dock .st.cur .tt').innerText(), '表示された値');
const ovw1 = await page.locator('.ovw').innerText();
ok('取得手段は DOM の直接読み取り', ovw1.includes('ブラウザのDOM直接読み取り'), ovw1);
ok('値の形だけを出す（文字数と文字種）', /\d+ 文字・/.test(ovw1), ovw1);
ok('値そのものを保存していないと書いてある', ovw1.includes('保存していません'), ovw1);
ok('表示された文字列そのものはキャンバスに出ていない',
  !svg.includes('アオバ台') && !svg.includes('シラカワ野'), svg.slice(0, 300));

await page.locator('g.nd[aria-label^="コンポーネント"]').first().click();
await page.waitForTimeout(250);
const ovw2 = await page.locator('.ovw').innerText();
ok('取得手段はビルド時に注入した要素識別子', ovw2.includes('ビルド時に注入した要素識別子'), ovw2);
ok('ソースファイルと行が出る', /src\/components\/RegionBadge\.tsx:\d+/.test(ovw2), ovw2);
ok('JSX の行が出る', ovw2.includes('className="badge-text"'), ovw2);
ok('包含関係（ネスト）が出る', /RegionBadge ← ListingCard ← Cards/.test(ovw2), ovw2);
ok('同じ JSX が生んだ要素の数が出る', /\d+ 個/.test(ovw2), ovw2);
ok('どの使用箇所かは観測していないと書いてある', ovw2.includes('観測していません'), ovw2);
ok('注入範囲を明示している', ovw2.includes('src/'), ovw2);

console.log('\n4. 根拠タブ');
await page.getByRole('tab', { name: '根拠' }).click();
await page.waitForTimeout(250);
const ev = await page.locator('.ev-card').innerText();
ok('観測性は実測', ev.includes('実測'), ev);
ok('取得手段は 02d の語彙で出る', ev.includes('ビルド時に注入した要素識別子'), ev);
ok('根拠に対応表と照合が出る', ev.includes('対応表') && ev.includes('確認'), ev);
ok('コンポーネントはスパンではないので時間窓を出さない', !ev.includes('読み込み開始から'), ev);

/* ---------------------------------- 5. プレビューが嘘をつかない */
console.log('\n5. プレビュー（現物）');
const pv = await page.locator('section[aria-label="プレビュー"]').innerText();
ok('観測した要素の参照を出す', pv.includes('<span>'), pv);
ok('描いたコンポーネント名を出す', pv.includes('RegionBadge'), pv);
ok('値そのものは出さない', !pv.includes('アオバ台') && !pv.includes('シラカワ野'), pv);
ok('合成の見本サイトを出さない', !pv.includes('千葉県'), pv);
ok('値を保存していないと書いてある', pv.includes('保存していません'), pv);

/* ------------------------------------- 6. 既存のデータセットは壊れていない */
console.log('\n6. 既存のデータセットは壊れていない');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
eq('合成は7ノードのまま', await count('g.nd'), SYNTH.nodes.length);
eq('合成は7ホップのまま', await count('g.hp'), SYNTH.hops.length);
ok('合成のプレビューは従来どおり', (await page.locator('section[aria-label="プレビュー"]').innerText()).includes('千葉県'));
await page.goto(`${BASE}/?data=measured`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
eq('PoC-01 の実測は7ノードのまま', await count('g.nd'), MEASURED.nodes.length);
eq('PoC-01 の実測の切断は1件のまま', MEASURED.cuts.length, 1);
ok('PoC-01 側では値のノードを作らない', !MEASURED.nodes.some((n) => n.kind === 'value'));
await page.locator('g.nd[aria-label^="通信"]').first().click();
await page.waitForTimeout(250);
ok('PoC-01 側は終点まで到達しているので途切れの注記を出さない',
  !(await page.locator('.dock .sum').innerText()).includes('たどれていません'));
ok('PoC-01 側の主張は従来どおりテーブルと列',
  (await page.locator('.dock .claim .src').innerText()).startsWith('poc.listings'));

if (SHOTS) {
  await page.goto(`${BASE}/?data=elements`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/elements-stage0.png` });
  await page.locator('g.nd[aria-label^="表示された値"]').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/elements-value-selected.png` });
  await page.locator('g.nd[aria-label^="コンポーネント"]').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/elements-component-selected.png` });
  await page.getByRole('tab', { name: '根拠' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/elements-evidence.png` });
}

eq('JS エラーなし', pageErrors.length, 0);
await browser.close();

console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
