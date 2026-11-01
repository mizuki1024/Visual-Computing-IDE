/* =============================================================================
 * 探索画面（S-04）の回帰確認。
 *   node tests/explore.spec.mjs            既定 http://localhost:3100
 *   BASE=http://localhost:3100 node tests/explore.spec.mjs
 *
 * Phase 5A で動いていた操作と、Phase 5B で足した段階0 の両方を見る。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { installCanvasPrecondition } from './lib/canvas-precondition.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, actual, expected) => ok(name, actual === expected, actual);

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
// 前提状態をそろえる: IDE の履歴で伸びる右上のパネルを、開くたびに閉じる（lib/canvas-precondition.mjs）
installCanvasPrecondition(page);
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) pageErrors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const transform = () => page.locator('.scene > g').getAttribute('transform');
const zoom = () => page.locator('.ctl .val').innerText();
const dockHas = (sel) => page.locator(sel).count();

/* ---------------------------------------------------------- 1. 初期＝俯瞰 */
console.log('\n1. 初期状態で俯瞰できる');
eq('選択は無い（強調されたノードが0）', await dockHas('.nd.sel'), 0);
eq('詳細パネルにページの概要が出る', await dockHas('section[aria-label="このページの概要"]'), 1);
eq('経路サマリは出ない', await dockHas('.dock .claim .chip-est'), 0);
eq('番号付きリストは出ない', await dockHas('.dock .steps'), 0);
eq('タブは並べない（IX-16）', await dockHas('.dtabs'), 0);
eq('ドックは固定のまま', await dockHas('aside.dock'), 1);
eq('スコープ表示はページ', (await page.locator('.dh .r span').first().innerText()), 'ページ');

const stats = await page.locator('.ov-stats dd').allInnerTexts();
eq('通信件数（経路内1 + 経路外1）', stats[0], '2 件');
eq('SQL件数', stats[1], '2 件');
ok('計測できた時間が導出されている', /^124 ms/.test(stats[2]), stats[2]);
ok('計測できていない通信があることを明示', /1 \/ 2 件/.test(stats[2]), stats[2]);
eq('表示中の経路', stats[3], '1 / 2（他 1 件は詳細が未取得）');
ok('推定を含む旨', (await page.locator('.ov-flag.est').innerText()).includes('2 か所'));
ok('追跡できない箇所', (await page.locator('.ov-flag.cut').innerText()).includes('1 件'));
ok('合成データである旨', (await page.locator('.ov-synth').innerText()).includes('実際の計装結果ではありません'));
// セレクタをミニマップのパネルに限定した（Phase 7A で浮かぶパネルが1枚増えたため）。
// 期待値は変えていない
eq('ミニマップの経路数も同じ導出値',
  (await page.locator('.fpnl[aria-label="全体"] i').last().innerText()), '1 / 2 経路');
eq('N0 の対応範囲も導出値', (await page.locator('.sup b').innerText()), '部分対応・1件');

/* ------------------------------- 1b. ステップバッジは表示順であって識別子ではない */
console.log('\n1b. ステップバッジ（02 5.3 / 03c 5.2）');
eq('段階0（ページスコープ）ではバッジを出さない', await dockHas('.chipbadge'), 0);
eq('札そのものは出ている（種別名・短い識別子）', await dockHas('g.nd'), 7);
ok('凡例は減光の理由で書かれている',
  (await page.locator('.lgb .lt').last().innerText()).startsWith('詳細が未取得の通信'));

console.log('\n1c. 経路外の通信はホバーで理由が読める');
await page.locator('g.nd').first().hover();          // いったん別の場所へ
await page.mouse.move(462, 900);                      // 経路外のノードの上
await page.waitForTimeout(200);
const note = await page.locator('.hovcard').innerText();
ok('「このページの他の通信」と読める', note.includes('このページの他の通信'), note);
ok('詳細を持たない理由が読める', note.includes('詳細を持ちません'), note);
ok('実測／推定の語を付けない（経路ではない）', !/実測|推定/.test(note), note);
eq('押せる見た目を与えない', await dockHas('g.nd[aria-label*="saved"]'), 0);
await page.mouse.move(760, 200);
await page.waitForTimeout(150);

/* -------------------------------------------------- 2. ノードを選択できる */
console.log('\n2. ノードを選択できる');
const v0 = await transform();
await page.locator('g.nd[aria-label^="カラム"]').first().click();
await page.waitForTimeout(150);
eq('選択ノードが1つ', await dockHas('.nd.sel'), 1);
eq('経路サマリが出る', await dockHas('.dock .claim .chip-est'), 1);
eq('番号付きリストが出る', await dockHas('.dock .steps'), 1);
eq('タブが出る', await dockHas('.dtabs'), 1);
eq('スコープ表示は経路', (await page.locator('.dh .r span').first().innerText()), '経路');
eq('選択しても視点は動かない', await transform(), v0);
eq('経路スコープになるとバッジが現れる', await dockHas('.chipbadge'), 7);
eq('リストの識別子は metrics を連結した導出値',
  (await page.locator('.dock .st').nth(2).locator('.ts').innerText()),
  'GET /api/listings — 200 — 124ms');

console.log('\n2b. バッジ番号で直接移動する（表示順で引く）');
await page.keyboard.press('3');
await page.waitForTimeout(120);
eq('③ は経路の論理順の3番目＝通信',
  (await page.locator('.dock .st.cur .tt').innerText()), '通信');
eq('キャンバスの札のバッジも③', 
  (await page.locator('.dock .st.cur .bd').innerText()), '3');

/* ------------------------------------------ 3. 空白クリックで選択解除できる */
console.log('\n3. 空白クリックで選択解除できる');
await page.mouse.click(760, 200);                       // キャンバスの空白
await page.waitForTimeout(150);
eq('未選択に戻る', await dockHas('.nd.sel'), 0);
eq('ページの概要に戻る', await dockHas('section[aria-label="このページの概要"]'), 1);
eq('解除で視点は動かない', await transform(), v0);

console.log('\n3b. 誤って解除されない');
await page.keyboard.press('5');
await page.waitForTimeout(120);
await page.locator('.fpnl .pglist').click();            // 浮かぶパネルの中
await page.waitForTimeout(120);
eq('パネル内クリックでは解除されない', await dockHas('.nd.sel'), 1);
await page.locator('g.nd[aria-label^="テーブル"]').first().click();
await page.waitForTimeout(120);
eq('ノードクリックでは解除されず選択が移る', await dockHas('.nd.sel'), 1);
await page.locator('g.hp').first().click();
await page.waitForTimeout(120);
eq('接続線クリックでは解除されずホップが選択される', await dockHas('.dock .rel.sel'), 1);
// 移動（ドラッグ）では解除しない
await page.keyboard.press('1');
await page.waitForTimeout(120);
await page.mouse.move(760, 200); await page.mouse.down();
await page.mouse.move(700, 160, { steps: 6 }); await page.mouse.up();
await page.waitForTimeout(120);
eq('ドラッグでは解除されない', await dockHas('.nd.sel'), 1);
const vPanned = await transform();
ok('ドラッグで視点は動く', vPanned !== v0, vPanned);

/* ------------------------------------------------ 4. Esc で未選択まで戻れる */
console.log('\n4. Esc の階段');
await page.getByRole('button', { name: 'ここを見る' }).click();
await page.waitForTimeout(400);
await page.getByRole('tab', { name: '根拠' }).click();
await page.waitForTimeout(120);
eq('いま: 根拠タブ + ホップ選択', await dockHas('.ev-sec'), 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
eq('Esc 1回目 → 概要タブ', (await page.locator('.dtabs button.on').innerText()), '概要');
eq('まだホップ選択のまま', await dockHas('.dock .ret.cur'), 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
eq('Esc 2回目 → 直前のノード選択へ', await dockHas('.dock .st.cur'), 1);
eq('ホップ選択は解けている', await dockHas('.dock .ret.cur'), 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
eq('Esc 3回目 → 未選択', await dockHas('section[aria-label="このページの概要"]'), 1);
const vBeforeNoop = await transform();
const panelsBefore = await page.locator('.fpnl').count();
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
eq('Esc 4回目 → 何も起こらない（選択）', await dockHas('section[aria-label="このページの概要"]'), 1);
eq('Esc 4回目 → 何も起こらない（パネル）', await page.locator('.fpnl').count(), panelsBefore);
eq('Esc 4回目 → 何も起こらない（視点）', await transform(), vBeforeNoop);

/* --------------------------------------------- 5. 再選択しても正常に動作する */
console.log('\n5. 再選択');
await page.keyboard.press('3');
await page.waitForTimeout(120);
eq('再選択できる', await dockHas('.dock .st.cur'), 1);
eq('タブは概要から始まる（IX-17）', (await page.locator('.dtabs button.on').innerText()), '概要');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
eq('もう一度未選択へ戻れる', await dockHas('section[aria-label="このページの概要"]'), 1);

/* ------------------------------------------------- 7. パン・ズームが維持される */
console.log('\n7. パン・ズームの維持');
await page.getByRole('button', { name: '拡大（＋）' }).click();
await page.waitForTimeout(150);
const zAfter = await zoom();
const vAfterZoom = await transform();
await page.keyboard.press('4');
await page.waitForTimeout(150);
eq('選択してもズームは維持', await zoom(), zAfter);
eq('選択しても視点は維持', await transform(), vAfterZoom);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
eq('解除してもズームは維持', await zoom(), zAfter);
eq('解除しても視点は維持', await transform(), vAfterZoom);

/* --------------------------------- Phase 5A の操作が壊れていないこと（回帰） */
console.log('\nR. Phase 5A の回帰');
await page.getByRole('button', { name: '全体表示', exact: true }).click();
await page.waitForTimeout(400);
// 93% は内容の外接矩形を、浮かぶパネルに覆われない領域へ収めた結果の導出値
eq('全体表示', await zoom(), '93%');
await page.getByRole('button', { name: 'ページを閉じる' }).click();
eq('ページパネルを閉じる', await page.locator('section[aria-label="ページ"]').count(), 0);
await page.getByRole('button', { name: 'ページ', exact: true }).click();
eq('ページパネルを開く', await page.locator('section[aria-label="ページ"]').count(), 1);
await page.getByRole('button', { name: 'プレビューを閉じる' }).click();
eq('プレビューを閉じる', await page.locator('section[aria-label="プレビュー"]').count(), 0);
await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
eq('プレビューを開く', await page.locator('section[aria-label="プレビュー"]').count(), 1);
await page.locator('.trk').click();
await page.waitForTimeout(400);
eq('プレビューの値 → ① を選択', (await page.locator('.dock .st.cur .tt').innerText()), '表示された値');
eq('経路サマリの件数は導出値',
  (await page.locator('.dock .sum p').first().innerText()),
  '14 か所のうち 2 か所が推定です。経路全体は、いちばん弱いところに合わせて「推定」になります。');
eq('主張', (await page.locator('.dock .claim .src').innerText()), 'listings . region');
const hops = await page.locator('g.hp').count();
eq('ホップは7本（⑥→⑦ を描かない）', hops, 7);
ok('合成データの常時表示', (await page.locator('.note.synth').innerText()).includes('合成データ'));

if (SHOTS) {
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '全体表示', exact: true }).click();
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/stage0.png` });
  // 既定の視点のまま ① を選ぶ（プレビュー経由だとフォーカスで視点が動き、比較できない）
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/stage2.png` });
}

eq('JS エラーなし', pageErrors.length, 0);
await browser.close();

console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
