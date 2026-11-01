/* =============================================================================
 * PoC-05 — 変換結果を既存のキャンバスに流し込んだときの画面の検証。
 *   node tests/flows.spec.mjs            既定 http://localhost:3100
 *
 * 見るのは「②' 通信を開始したコンポーネント と requests が、既存の描画部品の
 * まま出るか」と「証拠の無い関係を線でつないでいないか」である。
 * UI の設計には手を入れていない。データセットが増えただけである。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const trace = require_('../.libjs/lib/trace.js');
const DS = trace.buildDataset('flows');
const ELEMENTS = trace.buildDataset('elements');
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

await page.goto(`${BASE}/?data=flows`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const count = (sel) => page.locator(sel).count();
const sceneText = async () => (await page.locator('svg.scene text').allTextContents()).join(' / ');
const zoom = () => page.locator('.ctl .val').innerText();

/* ------------------------- 1. 既存の描画部品のまま描けている */
console.log('\n1. PoC-05 の実測データをキャンバスに描ける');
eq('変換結果のノードをすべて描いている', await count('g.nd'), DS.nodes.length);
eq('変換結果のホップをすべて描いている', await count('g.hp'), DS.hops.length);
eq('コンポーネントのノードが2つある', await count('g.nd[aria-label^="コンポーネント"]'), 2);
const svg = await sceneText();
ok('通信を開始したコンポーネント名が札に出る', svg.includes('Flows'), svg.slice(0, 300));
ok('値を描いたコンポーネント名も札に出る', svg.includes('RegionBadge'), svg.slice(0, 300));
ok('実測データであることを常時表示している',
  (await page.locator('.note.synth').innerText()).includes('PoC-05 実測データ'));
ok('応答ヘッダで対応付けたことを計装表示に出している',
  (await page.locator('header.n0').innerText()).includes('応答ヘッダへの識別子'));
ok('観測したページは /flows',
  (await page.locator('section[aria-label="このページの概要"] .claim .src').innerText()).includes('/flows'));

/* ----------------- 2. 証拠のある関係だけを描き、無いところは切断のまま */
console.log('\n2. 証拠のある関係だけを描く');
ok('推定の関係を1本も描いていない', DS.hops.every((h) => h.observability === 'measured'));
ok('追跡できない箇所は1件（props の由来だけ）',
  (await page.locator('.ov-flag.cut').innerText()).includes('1 件'));
ok('props の由来を観測していないと書いてある', svg.includes('props の由来'), svg.slice(0, 300));
ok('「この通信を起こした箇所は特定していません」は、もう出ない',
  !svg.includes('この通信を起こした箇所は特定していません'));
const comp = DS.nodes.filter((n) => n.kind === 'component');
ok('2つのコンポーネントの間に線が無い',
  !DS.hops.some((h) => comp.some((a) => a.id === h.from) && comp.some((b) => b.id === h.to)));
/* 番号付きリストは選択してから出る（段階0 はページの概要である） */
await page.locator('g.nd[aria-label^="表示された値"]').first().click();
await page.waitForTimeout(250);
eq('番号付きリストでも、関係の無いステップ間に縦線を引いていない',
  await page.locator('.st .conn').count(), DS.nodes.length - 2);
ok('引かなかったのは ② と ②\' の間だけである',
  DS.nodes.filter((n, i) => i > 0
    && !DS.hops.some((h) => h.to === n.id)).length === 1);

/* --------------------- 3. 通信を開始したコンポーネントを選べる */
console.log('\n3. 通信を開始したコンポーネントの詳細');
await page.locator('g.nd[aria-label^="コンポーネント"]').nth(1).click();
await page.waitForTimeout(250);
eq('選択できる', await count('.nd.sel'), 1);
const ovw = await page.locator('.ovw').innerText();
ok('取得手段は、ブラウザが記録した呼び出しスタック',
  ovw.includes('ブラウザが記録した通信開始時の呼び出しスタック'), ovw);
ok('呼び出し位置（ファイル・行・列）が出る', /src\/app\/flows\/page\.tsx:\d+:\d+/.test(ovw), ovw);
ok('照合したソース行が出る', ovw.includes('fetch('), ovw);
ok('囲んでいるコンポーネントが出る', ovw.includes('Flows'), ovw);
ok('主張の範囲を明示している', ovw.includes('観測していません'), ovw);
ok('応答と表示値の対応は主張していない', !ovw.includes('この値の出所です'), ovw);

console.log('\n3b. 根拠タブ');
await page.getByRole('tab', { name: '根拠' }).click();
await page.waitForTimeout(250);
const ev = await page.locator('.ev-card').innerText();
ok('観測性は実測', ev.includes('実測'), ev);
ok('根拠が3件出る', ev.includes('3 件'), ev);
ok('ソースマップで戻したことを根拠に書いている', ev.includes('ソースマップ'), ev);
ok('2つの情報源の一致を根拠に書いている', ev.includes('マニフェスト'), ev);

/* ------------------------------- 4. 通信のノードは読んだヘッダを明示する */
console.log('\n4. 通信のノード');
await page.getByRole('tab', { name: '概要' }).click();
await page.locator('g.nd[aria-label^="通信"]').first().click();
await page.waitForTimeout(250);
const httpOvw = await page.locator('.ovw').innerText();
ok('読んだ応答ヘッダのキーを出す', httpOvw.includes('server-timing'), httpOvw);
ok('他のヘッダも本文も読んでいないと書いてある',
  httpOvw.includes('他のヘッダも本文も読んでいません'), httpOvw);

/* ------------------------------------- 5. 既存キャンバスの操作が壊れていない */
console.log('\n5. 既存のキャンバス操作');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
eq('Esc で未選択へ戻る', await count('.nd.sel'), 0);
await page.keyboard.press('3');
await page.waitForTimeout(250);
eq('数字キーでバッジの対象を選べる', await count('.nd.sel'), 1);
eq('3 は「コンポーネント」である', await page.locator('.dock .st.cur .tt').innerText(), 'コンポーネント');
const zBefore = await zoom();
await page.keyboard.press('4');
await page.waitForTimeout(250);
eq('選択してもズームは維持', await zoom(), zBefore);
eq('4 は「通信」である', await page.locator('.dock .st.cur .tt').innerText(), '通信');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.mouse.move(900, 200); await page.mouse.down();
await page.mouse.move(850, 170, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(200);
eq('空白のドラッグで選択は起きない', await count('.nd.sel'), 0);
await page.getByRole('button', { name: '全体表示', exact: true }).click();
await page.waitForTimeout(350);
ok('全体表示が効く', /%$/.test(await zoom()), await zoom());

/* ------------------------------------- 6. 既存のデータセットは壊れていない */
console.log('\n6. 既存のデータセットは壊れていない');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
eq('合成は7ノードのまま', await count('g.nd'), SYNTH.nodes.length);
eq('合成は7ホップのまま', await count('g.hp'), SYNTH.hops.length);
await page.locator('g.nd').first().click();
await page.waitForTimeout(250);
eq('合成の縦線は従来どおり全ステップ間に出る', await count('.st .conn'), SYNTH.nodes.length - 1);
await page.goto(`${BASE}/?data=measured`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
eq('PoC-01 の実測は7ノードのまま', await count('g.nd'), MEASURED.nodes.length);
await page.locator('g.nd').first().click();
await page.waitForTimeout(250);
eq('PoC-01 の縦線も従来どおり', await count('.st .conn'), MEASURED.nodes.length - 1);
await page.goto(`${BASE}/?data=elements`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
eq('PoC-03 の実測は9ノードのまま', await count('g.nd'), ELEMENTS.nodes.length);
eq('PoC-03 の切断は2件のまま', ELEMENTS.cuts.length, 2);
ok('PoC-03 側では requests を作っていない',
  !ELEMENTS.hops.some((h) => h.relation === 'requests'));

if (SHOTS) {
  await page.goto(`${BASE}/?data=flows`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/flows-stage0.png` });
  await page.locator('g.nd[aria-label^="コンポーネント"]').nth(1).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/flows-initiator-selected.png` });
  await page.getByRole('tab', { name: '根拠' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/flows-evidence.png` });
  await page.getByRole('tab', { name: '概要' }).click();
  await page.locator('g.nd[aria-label^="通信"]').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/flows-http-selected.png` });
}

eq('JS エラーなし', pageErrors.length, 0);
await browser.close();

console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
