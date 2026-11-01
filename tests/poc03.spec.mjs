/* =============================================================================
 * PoC-03 — 要素 → コンポーネント → ソース位置 の検証（ブラウザを使わない）。
 *   npx tsc -p tsconfig.lib.json && node tests/poc03.spec.mjs
 *
 * 見るのは次の6点である。
 *   1. 方式の実測結果（誤答を出していないこと）
 *   2. 必須の React パターンごとの成否
 *   3. 特定できない場合に「特定不能」と返すこと（誤特定しないこと）
 *   4. 変換が観測できない関係を作らないこと（実測へ格上げしないこと）
 *   5. 値そのものを保存していないこと・機密値が無いこと
 *   6. 変換器そのもの（行番号を動かさない・注入先を誤らない）
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const at = (...p) => path.join(HERE, '..', ...p);

const model = require_('../.libjs/lib/model.js');
const derive = require_('../.libjs/lib/derive.js');
const trace = require_('../.libjs/lib/trace.js');
const { transform } = require_('../poc/anchor/transform.cjs');
const { ELEMENT_OBSERVATION: OBS } = require_('../.libjs/data/observation.poc03.js');
/*
 * 計測記録は docs/ に置いた要約を読む。poc/out/ は .gitignore されており、
 * 判定の根拠がリポジトリに残らないとテストが再現できないためである。
 */
const MATRIX = JSON.parse(fs.readFileSync(at('docs', '06b-poc03-matrix.json'), 'utf8'));

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);

const BUNDLERS = ['turbopack', 'webpack'];
const el = OBS.elements;
const sel = (k) => el.selections.find((s) => s.key === k);
const anchorOf = (k) => el.anchors.find((a) => a.id === sel(k)?.anchorOnSelf);
const tgt = (b, k) => MATRIX.byBundler[b].targets.find((t) => t.key === k);
const ds = trace.buildDataset('elements');

/* ===================================================== 1. 方式の実測結果 */
console.log('\n1. 方式1（ビルド時の要素識別子注入）の実測結果');
ok('2つのバンドラで計測している', BUNDLERS.every((b) => MATRIX.byBundler[b]));
for (const b of BUNDLERS) {
  const s = MATRIX.byBundler[b].summary;
  eq(`${b}: 自作コンポーネントの誤答は0件`, s.own.wrong, 0);
  eq(`${b}: 自作コンポーネントを全件特定できた`, s.own.correct, s.own.total);
  eq(`${b}: 注入範囲外の要素を誤って特定していない`, s.nonOwn.wrong, 0);
  eq(`${b}: 注入範囲外の要素は「特定不能」と返す`, s.nonOwn.correctUnidentifiable, s.nonOwn.total);
}
ok('バンドラ間で判定が一致する（片方だけ成立ではない）',
  MATRIX.byBundler.turbopack.targets.every(
    (t, i) => t.method1Verdict.verdict === MATRIX.byBundler.webpack.targets[i].method1Verdict.verdict,
  ));
ok('照合は観測と独立に行っている（ソースを読み直して確認している）',
  el.anchors.length > 0 && el.anchors.every((a) => a.verified === true));
ok('20要素以上で照合している', MATRIX.byBundler.turbopack.targets.length >= 20,
  MATRIX.byBundler.turbopack.targets.length);

console.log('\n1b. React 19 の実測（内部プロパティを前提にしていないことの裏づけ）');
const r = tgt('turbopack', 'badge-text').react;
eq('React 19 の Fiber に _debugSource は無い', r.hasDebugSource, false);
eq('_debugStack は存在する（開発ビルド）', r.hasDebugStack, true);
eq('__source は props に載らない', r.propsHasSource, false);
ok('公開API captureOwnerStack はクリックされた要素のコンポーネントを返さない',
  typeof MATRIX.byBundler.turbopack.facts.ownerStack === 'string'
  && !MATRIX.byBundler.turbopack.facts.ownerStack.includes('RegionBadge'),
  MATRIX.byBundler.turbopack.facts.ownerStack);
ok('方式2（_debugStack + ソースマップ）はサーバー描画の要素で解けない',
  MATRIX.byBundler.turbopack.targets
    .filter((t) => t.group === 'own-server')
    .every((t) => t.method2.status !== 'resolved'));
ok('方式2 は webpack では行位置まで解けていない（ファイルのみ）',
  MATRIX.byBundler.webpack.summary.method2.lineCorrect === 0
  && MATRIX.byBundler.webpack.summary.method2.fileWrong === 0);
ok('採用した方式は React の内部プロパティを使っていない',
  el.method.includes('ビルド時') && !JSON.stringify(el.anchors).includes('_debug'));

/* =============================================== 2. React パターンごとの成否 */
console.log('\n2. 必須の React パターン');
const a = {
  h1: anchorOf('h1'), code: anchorOf('card-code'), body: anchorOf('card-body'),
  card0: anchorOf('card-0'), card2: anchorOf('card-2'),
  badge: anchorOf('badge-text'), badge2: anchorOf('badge-text-2'),
};
ok('単純な Client Component の要素を特定できる',
  a.h1 && a.h1.file === 'src/app/cards/page.tsx' && a.h1.component === 'Cards', a.h1);
ok('props で値を受け取るコンポーネントを特定できる',
  a.code && a.code.file === 'src/components/ListingCard.tsx' && a.code.component === 'ListingCard', a.code);
ok('ネストしたコンポーネントは、内側の定義元を指す',
  a.badge && a.badge.file === 'src/components/RegionBadge.tsx' && a.badge.component === 'RegionBadge', a.badge);
ok('ネストの外側（親コンポーネント）を誤って指さない',
  a.badge && a.badge.component !== 'ListingCard' && a.badge.component !== 'Cards');
ok('包含関係は祖先の識別子から読める（文脈として）',
  sel('badge-text').ancestorAnchors.length >= 3, sel('badge-text').ancestorAnchors);

console.log('\n2b. 同じコンポーネントを複数回表示');
eq('同じ JSX から生まれた DOM 要素は同じ識別子を持つ',
  sel('card-0').anchorOnSelf, sel('card-2').anchorOnSelf);
eq('同じ識別子はいずれも同じソース位置を指す', a.card0 && a.card0.line, a.card2 && a.card2.line);
eq('何個の要素が生まれたかを観測している', sel('card-0').anchorInstanceCount, 3);
ok('インスタンスは順番で区別する（値では区別しない）',
  sel('card-0').anchorOrdinal === 0 && sel('card-2').anchorOrdinal === 2,
  [sel('card-0').anchorOrdinal, sel('card-2').anchorOrdinal]);
ok('どの使用箇所がどのインスタンスを描いたかは「観測していない」と書いてある',
  OBS.meta.notObserved.some((n) => n.what.includes('使用箇所')));

/* ========================================= 3. 特定できない場合の振る舞い */
console.log('\n3. ソース位置が取得できない場合');
for (const k of ['vendor-root', 'vendor-title', 'vendor-slot', 'dynamic']) {
  const s = sel(k);
  ok(`${k}: 要素識別子を持たない`, s.anchorOnSelf === null, s.anchorOnSelf);
  ok(`${k}: 理由付きで「特定不能」を返す（null で無反応にしない）`,
    !!s.failure && typeof s.failure.reason === 'string', s.failure);
}
ok('祖先に識別子があっても、それをこの要素の出所にしない（誤特定の防止）',
  ['vendor-root', 'vendor-title', 'vendor-slot', 'dynamic']
    .every((k) => sel(k).ancestorAnchors.length > 0 && sel(k).failure));
ok('ライブラリ由来の要素を、自作ファイルへ割り当てていない',
  BUNDLERS.every((b) => ['vendor-root', 'vendor-title', 'vendor-slot']
    .every((k) => tgt(b, k).method1.status === 'failure')));
ok('ライブラリ由来か動的生成かを区別できていないことを隠していない',
  OBS.meta.notObserved.some((n) => n.what.includes('ライブラリ由来か動的生成か')));
ok('注入範囲を画面から読める', el.injectedScope === 'src/', el.injectedScope);
ok('注入しなかった要素と理由が残っている',
  el.files.some((f) => f.skipped.some((x) => x.why === 'framework-owned-element')));

/* ============================ 4. 観測できない関係を実測へ格上げしないこと */
console.log('\n4. 変換が観測できない関係を作らない');
const rel = ds.hops.map((h) => h.relation);
ok('renders を作っている', rel.includes('renders'));
ok('derives を作っていない（props の由来は観測していない）', !rel.includes('derives'));
ok('maps を作っていない（カラムと応答項目の対応は観測していない）', !rel.includes('maps'));
ok('binds を作っていない', !rel.includes('binds'));
ok('requests を作っていない（通信の呼び出し元は観測していない）', !rel.includes('requests'));
eq('renders の取得手段は「ビルド時に注入した要素識別子」',
  ds.hops.find((h) => h.relation === 'renders').source, 'element-anchor');
eq('renders は実測である',
  ds.hops.find((h) => h.relation === 'renders').observability, 'measured');
eq('表示された値の取得手段は DOM の直接読み取り',
  ds.nodes.find((n) => n.kind === 'value').source, 'dom-read');
ok('構造的に推定の取得手段は、どの経路でも実測にならない',
  ['static-analysis', 'orm-schema-map', 'value-match', 'structural-match']
    .every((s) => model.observabilityOf(s) !== 'measured'));
ok('観測性はデータに書けない（取得手段から導出される）',
  !('observability' in { id: 0 }) && ds.nodes.every((n) => n.observability === model.observabilityOf(n.source)));

console.log('\n4b. ブラウザ側とサーバー側を勝手につながない');
ok('コンポーネントと通信の間にホップが無い',
  !ds.hops.some((h) => h.from === 2 && h.to === 3));
eq('切断は2件（props の由来・通信の呼び出し元）', ds.cuts.length, 2);
ok('切断はコンポーネント側から生える', ds.cuts.some((c) => c.from === 2));
ok('切断は通信側からも生える', ds.cuts.some((c) => c.from === 3));
ok('切断の理由に「証拠が無い」と書いてある',
  ds.cuts.some((c) => c.kind.includes('証拠が無い')), ds.cuts.map((c) => c.kind));
ok('作らなかったものが記録されている', trace.MEASURED_ELEMENTS.skipped.length >= 4,
  trace.MEASURED_ELEMENTS.skipped.length);

console.log('\n4c. たどり着いていない終点を「出所」と言い切らない');
const sum = derive.summarize(ds);
eq('経路は途中で途切れていると判定される', sum.truncated, true);
ok('主張はたどり着けたところ（ソース位置）である',
  sum.claim === 'src/components/RegionBadge.tsx:8', sum.claim);
ok('到達していないテーブル・カラムを出所として主張しない',
  !sum.claim.includes('listings') && !sum.claim.includes('region'), sum.claim);
eq('合成データは従来どおり終点まで到達している',
  derive.summarize(trace.buildDataset('synthetic')).truncated, false);
eq('PoC-01 の実測も従来どおり終点まで到達している',
  derive.summarize(trace.buildDataset('measured')).truncated, false);
eq('合成データの主張は変わっていない',
  derive.summarize(trace.buildDataset('synthetic')).claim, 'listings . region');
eq('PoC-01 の実測の主張は変わっていない',
  derive.summarize(trace.buildDataset('measured')).claim, 'poc.listings . 3 列');

/* ============================================ 5. 値を保存していないこと */
console.log('\n5. データ保護');
const RAW = fs.readFileSync(at('src', 'data', 'observation.poc03.ts'), 'utf8');
/* 検査の対象はデータ本体である。ファイル冒頭の説明文（禁止項目の列挙）は含めない */
const DATA = JSON.stringify(OBS);
/* DOM から読んだ観測だけを取り出す。ソースコードの行はここに入らない */
const DOM_OBS = JSON.stringify(el.selections);

const VALUES = ['アオバ台', 'シラカワ野', 'ミナト浜', 'ヒガシ丘', '直接生成', '物件カード'];
for (const v of VALUES) {
  ok(`DOM の観測に表示文字列「${v}」が入っていない`, !DOM_OBS.includes(v));
}
ok('値について持つのは文字数と文字種だけ',
  el.selections.filter((s) => s.valueShape).every(
    (s) => Object.keys(s.valueShape).sort().join(',') === 'chars,cls'),
  el.selections.find((s) => s.valueShape)?.valueShape);
ok('対応付けの鍵は識別子と位置であって値ではない',
  el.selections.every((s) => !('text' in s) && !('value' in s)));
ok('DOM の全文を持っていない', !/outerHTML|innerHTML|<html|<body/.test(DATA));
ok('絶対パスを持っていない', !RAW.includes('/Users/'));
for (const p of [/\bcookie\b/i, /\bauthorization\b/i, /\bbearer\b/i, /\bpassword\b/i,
  /postgres(ql)?:\/\//i, /\baccess_token\b/i]) {
  ok(`データ本体が ${p} を含まない`, !p.test(DATA));
}
ok('画面に「値を保存していない」と書いてある',
  ds.nodes.find((n) => n.kind === 'value').overview
    .some((row) => row.v.includes('保存していません')));

/*
 * 画面に出る文字列が記録に残りうる唯一の場所は「JSX のソース1行」である。
 * これは DOM の読み取りではなく、ソースファイルを読んだ結果である。
 * そのことを、実際にソースと突き合わせて確かめる。
 */
console.log('\n5b. 記録に残る文字列の出どころ');
ok('ソース行は、本当にそのソースファイルのその行である',
  el.anchors.every((x) => {
    if (x.sourceLine === null) return true;
    const abs = at('poc', 'fixture-app', x.file);
    if (!fs.existsSync(abs)) return false;
    return fs.readFileSync(abs, 'utf8').split('\n')[x.line - 1].trim() === x.sourceLine;
  }));
ok('ソース行は注入範囲の中のファイルからしか来ない',
  el.anchors.every((x) => x.file.startsWith(el.injectedScope)));
ok('ソースコードの全文は持っていない',
  el.anchors.every((x) => x.sourceLine === null || !x.sourceLine.includes('\n')));
ok('キャンバスに出すソース行は、主対象の1行だけ',
  ds.nodes.filter((n) => n.overview.some((r) => r.k === 'JSX')).length === 1);

/* ====================================== 6. 変換器そのもの（注入の正しさ） */
console.log('\n6. 変換器（JSX への注入）');
const SRC = fs.readFileSync(
  at('poc', 'fixture-app', 'src', 'components', 'ListingCard.tsx'), 'utf8');
const out = transform(SRC, 'src/components/ListingCard.tsx');
eq('行数を変えない', out.code.split('\n').length, SRC.split('\n').length);
ok('報告した行に、その識別子とタグがある',
  out.anchors.every((x) => {
    const line = out.code.split('\n')[x.line - 1];
    return line.includes(`data-vcide="${x.id}"`) && line.includes(`<${x.tag}`);
  }));
ok('報告した行は、元のソースでも同じ行である',
  out.anchors.every((x) => SRC.split('\n')[x.line - 1].includes(`<${x.tag}`)));
ok('コンポーネント要素（大文字タグ）には注入しない',
  !out.code.includes('<RegionBadge data-vcide'));
ok('コンポーネントの使用箇所は、注入ではなく別に記録する',
  out.usages.some((u) => u.component === 'RegionBadge'));
eq('同じ入力からは同じ識別子が出る（再ビルドで変わらない）',
  transform(SRC, 'src/components/ListingCard.tsx').anchors[0].id, out.anchors[0].id);
ok('ファイルが違えば識別子も違う',
  transform(SRC, 'src/other/ListingCard.tsx').anchors[0].id !== out.anchors[0].id);
const LAYOUT = fs.readFileSync(at('poc', 'fixture-app', 'src', 'app', 'layout.tsx'), 'utf8');
const lout = transform(LAYOUT, 'src/app/layout.tsx');
ok('フレームワークが持つ要素（html / body）には注入しない',
  lout.anchors.length === 0 && lout.skipped.every((x) => x.why === 'framework-owned-element'),
  lout.skipped);
ok('JSX を持たないコードは変換しない', transform('export const x = 1;\n', 'src/x.ts').anchors.length === 0);

/* -------------------------------------------------------------------- */
console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
