/* =============================================================================
 * PoC-04 — 由来の推定と、その正確性の検証（ブラウザを使わない）。
 *   node tests/poc04.spec.mjs
 *
 * 読むもの:
 *   docs/06e-poc04-matrix.json      実測＋静的解析の判定（バンドラ2条件）
 *   src/data/observation.poc04.ts → .libjs 経由の変換結果
 *
 * 見るのは次の6つである（指示 第8節・第9節）。
 *   1. ケースA〜G について、正しい推定・曖昧な推定・誤推定防止ができていること
 *   2. **誤った候補を1件も出していないこと**（最重要）
 *   3. 決め切れないものを「確定」として出していないこと
 *   4. 静的解析の結果を実測へ格上げしていないこと
 *   5. 候補が無いときに関係を作らないこと（切断のまま）
 *   6. 収集禁止項目に触れていないこと
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const require_ = createRequire(import.meta.url);

const MATRIX = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', '06e-poc04-matrix.json'), 'utf8'));
const trace = require_('../.libjs/lib/trace.js');
const model = require_('../.libjs/lib/model.js');
const derive = require_('../.libjs/lib/derive.js');
const data = require_('../.libjs/data/observation.poc04.js');

const RUNS = Object.keys(MATRIX.byRun);
const runs = () => RUNS.map((k) => MATRIX.byRun[k]);
const A = trace.MEASURED_LIN_A;
const C = trace.MEASURED_LIN_C;
const G = trace.MEASURED_LIN_G;

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
const all = (xs, f) => xs.every(f);

/** ケース記号 → その行（全 run で同じであることも別に見る） */
const rowsOf = (r, caseKey) => r.cases.find((c) => c.case === caseKey).sites;
const rowOf = (r, field) => r.cases.flatMap((c) => c.sites).find((s) => s.field === field);
const everyRun = (f) => all(runs(), f);
const candOf = (r, field) => (rowOf(r, field).observed?.candidates ?? []).map((c) => c.key).sort();

/* ========================================================================== */
console.log('\n1. 計測の構成');
eq('バンドラ2条件で回している', RUNS.length, 2);
ok('Turbopack と webpack の両方で回している',
  RUNS.includes('turbopack') && RUNS.includes('webpack'));
ok('採用方式が「実測SQLの SELECT 句 ＋ ソースの静的解析」である',
  MATRIX.method.staticAnalysis.includes('TypeScript')
  && MATRIX.method.columnResolution.includes('SQL'));
eq('方式のレベルが L2 と記録されている', MATRIX.method.level.startsWith('L2（static-analysis）'), true);
for (const x of ['値の一致', '実行時刻の近さ', 'SQL 文の一致', 'ソース上の SQL リテラル']) {
  ok(`根拠に使っていないものが明記されている: ${x}`, MATRIX.method.notUsed.includes(x));
}
ok('ケースA〜G と補助ケースを分けて集計している',
  everyRun((r) => r.summary.main.total === 20 && r.summary.supplementary.total === 3),
  runs().map((r) => [r.summary.main.total, r.summary.supplementary.total]));
ok('2つのバンドラで判定が一致する',
  JSON.stringify(runs()[0].summary.main.buckets) === JSON.stringify(runs()[1].summary.main.buckets),
  runs().map((r) => r.summary.main.buckets));

/* ========================================================================== */
console.log('\n2. 誤推定を1件も作っていない（本PoCの最重要条件）');
ok('誤った候補を提示した件数が 0',
  everyRun((r) => r.summary.wrong === 0), runs().map((r) => r.summary.wrong));
eq('誤答率が 0%', everyRun((r) => r.summary.wrongRate === 0), true);
ok('決め切れないものを「確定」として出していない',
  everyRun((r) => r.summary.overclaimed === 0), runs().map((r) => r.summary.overclaimed));
ok('全ケースが合格している',
  everyRun((r) => r.summary.casesPass === r.summary.casesTotal),
  runs().map((r) => [r.summary.casesPass, r.summary.casesTotal]));
ok('候補を出した表示箇所は、すべて正解を含んでいる',
  everyRun((r) => r.cases.flatMap((c) => c.sites)
    .filter((s) => (s.observed?.candidates ?? []).length)
    .every((s) => s.truth.every((t) => s.observed.candidates.some((c) => c.key === t)))));

/* ========================================================================== */
console.log('\n3. ケースA 単純な直接対応');
ok('a-region を1列に確定できた',
  everyRun((r) => rowOf(r, 'a-region').bucket === 'correct-single'));
ok('確定した列は poc.listings.region である',
  everyRun((r) => candOf(r, 'a-region').join() === 'poc.listings.region'),
  candOf(runs()[0], 'a-region'));
ok('その表示箇所のコンポーネントとファイルが正解表と一致する',
  everyRun((r) => rowOf(r, 'a-region').componentOk && rowOf(r, 'a-region').fileOk));

/* ========================================================================== */
console.log('\n4. ケースB props の別名と多段の受け渡し／SQL の別名');
ok('b-label（2段の別名: code → label → text）を確定できた',
  everyRun((r) => rowOf(r, 'b-label').bucket === 'correct-single'
    && candOf(r, 'b-label').join() === 'poc.listings.code'),
  candOf(runs()[0], 'b-label'));
ok('b-label は子のファイルで描かれている（由来は2段さかのぼった先）',
  everyRun((r) => rowOf(r, 'b-label').observed.file === 'src/components/lin/LinBLabel.tsx'));
ok('b-tier（1段の別名: plan → tier）を確定できた',
  everyRun((r) => rowOf(r, 'b-tier').bucket === 'correct-single'
    && candOf(r, 'b-tier').join() === 'poc.listings.plan'),
  candOf(runs()[0], 'b-tier'));
ok('b-sqlalias（SQL の AS）で、別名ではなく由来の列を返した',
  everyRun((r) => rowOf(r, 'b-sqlalias').bucket === 'correct-single'
    && candOf(r, 'b-sqlalias').join() === 'poc.listings.code'),
  candOf(runs()[0], 'b-sqlalias'));
ok('SQL の別名であることが候補の注記に残っている',
  everyRun((r) => rowOf(r, 'b-sqlalias').observed.candidates[0].note?.includes('listing_code')),
  rowOf(runs()[0], 'b-sqlalias').observed.candidates[0].note);
ok('b-label と b-tier を取り違えていない',
  everyRun((r) => candOf(r, 'b-label').join() !== candOf(r, 'b-tier').join()));

/* ========================================================================== */
console.log('\n5. ケースC 値の加工');
ok('c-title（2列の連結）は候補を複数のままにした',
  everyRun((r) => rowOf(r, 'c-title').bucket === 'candidates-correct'
    && candOf(r, 'c-title').length === 2),
  candOf(runs()[0], 'c-title'));
ok('c-title を1列に確定していない',
  everyRun((r) => rowOf(r, 'c-title').observed.outcome !== 'confirmed'));
ok('c-upper（String + toUpperCase）は候補のままにした',
  everyRun((r) => rowOf(r, 'c-upper').bucket === 'candidates-correct'
    && rowOf(r, 'c-upper').observed.outcome === 'candidates'));
ok('c-len（文字数）も候補のままにした',
  everyRun((r) => rowOf(r, 'c-len').bucket === 'candidates-correct'
    && rowOf(r, 'c-len').observed.outcome === 'candidates'));
ok('加工を通ったことが記録されている',
  everyRun((r) => ['c-title', 'c-upper', 'c-len']
    .every((f) => rowOf(r, f).observed.transformed === true)));
ok('加工があることが理由として説明されている',
  everyRun((r) => rowOf(r, 'c-upper').observed.reasons.some((x) => x.includes('加工'))),
  rowOf(runs()[0], 'c-upper').observed.reasons);

/* ========================================================================== */
console.log('\n6. ケースD 複数候補と同名変数');
ok('d-dynamic（動的キー）は候補を複数のままにした',
  everyRun((r) => rowOf(r, 'd-dynamic').bucket === 'candidates-correct'));
ok('d-dynamic の候補は、その SQL が取った列すべてである（4件）',
  everyRun((r) => candOf(r, 'd-dynamic').length === 4),
  candOf(runs()[0], 'd-dynamic'));
ok('ORDER BY だけに現れる列（id）を候補にしていない',
  everyRun((r) => !candOf(r, 'd-dynamic').includes('poc.listings.id')),
  candOf(runs()[0], 'd-dynamic'));
ok('キーが動的であることが候補の注記に残っている',
  everyRun((r) => rowOf(r, 'd-dynamic').observed.candidates
    .every((c) => c.via === 'anyfield')));
ok('同名変数 row を取り違えていない（a は listings.code）',
  everyRun((r) => rowOf(r, 'd-same-name-a').bucket === 'correct-single'
    && candOf(r, 'd-same-name-a').join() === 'poc.listings.code'),
  candOf(runs()[0], 'd-same-name-a'));
ok('同名変数 row を取り違えていない（b は regions.name）',
  everyRun((r) => rowOf(r, 'd-same-name-b').bucket === 'correct-single'
    && candOf(r, 'd-same-name-b').join() === 'poc.regions.name'),
  candOf(runs()[0], 'd-same-name-b'));
ok('同名の2箇所が別のテーブルに解決されている',
  everyRun((r) => candOf(r, 'd-same-name-a')[0].split('.')[1]
    !== candOf(r, 'd-same-name-b')[0].split('.')[1]));

/* ========================================================================== */
console.log('\n7. ケースE 条件分岐');
ok('e-either（分岐で別の列）は候補を2件のままにした',
  everyRun((r) => rowOf(r, 'e-either').bucket === 'candidates-correct'
    && candOf(r, 'e-either').length === 2),
  candOf(runs()[0], 'e-either'));
ok('e-orconst（列 または 固定値）を確定にしていない',
  everyRun((r) => rowOf(r, 'e-orconst').observed.outcome === 'candidates'
    && rowOf(r, 'e-orconst').observed.literalPaths >= 1));
ok('固定値になる経路があることが理由に出ている',
  everyRun((r) => rowOf(r, 'e-orconst').observed.reasons.some((x) => x.includes('固定値'))),
  rowOf(runs()[0], 'e-orconst').observed.reasons);
ok('**e-inline（条件の判定だけに列を使う）に候補を出していない**',
  everyRun((r) => rowOf(r, 'e-inline').bucket === 'refused-correct'
    && rowOf(r, 'e-inline').observed.outcome === 'none'
    && rowOf(r, 'e-inline').observed.candidates.length === 0),
  rowOf(runs()[0], 'e-inline').observed);
ok('e-inline は条件式に現れた plan を由来にしていない',
  everyRun((r) => !candOf(r, 'e-inline').includes('poc.listings.plan')));

/* ========================================================================== */
console.log('\n8. ケースF RSC 直接取得（同一／子コンポーネント）');
ok('f-own（同じコンポーネントが取得して描く）を確定できた',
  everyRun((r) => rowOf(r, 'f-own').bucket === 'correct-single'
    && candOf(r, 'f-own').join() === 'poc.listings.code'),
  candOf(runs()[0], 'f-own'));
ok('f-child（子が自分で取得して描く）を確定できた',
  everyRun((r) => rowOf(r, 'f-child').bucket === 'correct-single'
    && candOf(r, 'f-child').join() === 'poc.regions.name'),
  candOf(runs()[0], 'f-child'));
ok('親の SQL と子の SQL を混同していない（別のテーブルに解決した）',
  everyRun((r) => candOf(r, 'f-own')[0].startsWith('poc.listings')
    && candOf(r, 'f-child')[0].startsWith('poc.regions')));
ok('f-child-cast（型変換を1つ通す）は確定にせず候補のままにした',
  everyRun((r) => rowOf(r, 'f-child-cast').observed.outcome === 'candidates'
    && rowOf(r, 'f-child-cast').bucket === 'candidates-correct'));
ok('f-child と f-child-cast は同じ列を指している（差は確定の可否だけ）',
  everyRun((r) => candOf(r, 'f-child').join() === candOf(r, 'f-child-cast').join()));

/* ========================================================================== */
console.log('\n9. ケースG 否定例 — 同一コンポーネント内の無関係な SQL');
for (const f of ['g-env', 'g-computed', 'g-shadow']) {
  ok(`${f} に候補を出していない`,
    everyRun((r) => rowOf(r, f).bucket === 'refused-correct'
      && rowOf(r, f).observed.outcome === 'none'
      && rowOf(r, f).observed.candidates.length === 0
      && rowOf(r, f).observed.tableCandidates.length === 0),
    rowOf(runs()[0], f).observed);
}
ok('**g-shadow（局所変数の名前が SQL の列名と同じ）でも候補を出していない**',
  everyRun((r) => !candOf(r, 'g-shadow').length));
ok('g-literal（JSX 直書き）は表示箇所として現れない',
  everyRun((r) => rowOf(r, 'g-literal').observed === null
    && rowOf(r, 'g-literal').bucket === 'refused-correct'));
ok('ケースG のページでも SQL は実測できている（無関係なだけである）',
  everyRun((r) => r.measuredSql.filter((m) => m.page === '/lin-g').length >= 1),
  runs()[0].measuredSql.filter((m) => m.page === '/lin-g').length);
ok('ケースG の SQL も実行したコンポーネントには帰属できている',
  everyRun((r) => r.measuredSql.filter((m) => m.page === '/lin-g')
    .every((m) => m.attribution.component === 'LinG')));

/* ========================================================================== */
console.log('\n10. 不完全なソース解析（補助ケースX）');
ok('x-dynamic（ソースに SQL リテラルが無い）でも列を確定できた',
  everyRun((r) => rowOf(r, 'x-dynamic').bucket === 'correct-single'
    && candOf(r, 'x-dynamic').join() === 'poc.listings.code'),
  candOf(runs()[0], 'x-dynamic'));
ok('その取得がソース上は動的な SQL だと記録されている',
  everyRun((r) => r.staticQueries.some((q) => q.file === 'src/app/lin-x/page.tsx'
    && q.sqlIsDynamic === true)));
ok('x-star（SELECT *）は列を特定せず、テーブルまでに粒度を落とした',
  everyRun((r) => rowOf(r, 'x-star').observed.outcome === 'table-only'
    && rowOf(r, 'x-star').observed.candidates.length === 0
    && rowOf(r, 'x-star').observed.tableCandidates.some((t) => t.key === 'poc.regions')),
  rowOf(runs()[0], 'x-star').observed);
ok('x-star の理由に SELECT * が出ている',
  everyRun((r) => rowOf(r, 'x-star').observed.unresolved.some((u) => u.why === 'select-star')));
ok('x-outside（解析範囲の外の関数が返す値）に候補を出していない',
  everyRun((r) => rowOf(r, 'x-outside').bucket === 'refused-correct'
    && rowOf(r, 'x-outside').observed.untracked.some((u) => u.startsWith('call-not-whitelisted'))),
  rowOf(runs()[0], 'x-outside').observed.untracked);

/* ========================================================================== */
console.log('\n11. 実行されていない SQL の列を由来にしない');
ok('静的解析が見つけた取得のうち、実測 SQL に結びついたものだけを使っている',
  everyRun((r) => r.summary.joinedQueries < r.summary.staticQueries
    && r.summary.joinedQueries > 0),
  runs().map((r) => [r.summary.joinedQueries, r.summary.staticQueries]));
ok('結びつかなかった取得には理由が付いている',
  everyRun((r) => r.join.filter((j) => j.measuredCount === 0).every((j) => !!j.why)));
ok('読み込んでいないページの表示箇所には候補が出ていない',
  everyRun((r) => r.outOfScopeSites.every((s) => s.outcome === 'none')),
  runs()[0].outOfScopeSites.filter((s) => s.outcome !== 'none'));
ok('採点していない表示箇所も記録に残っている（隠していない）',
  everyRun((r) => r.outOfScopeSites.length > 0 && r.unannotatedSites.length >= 0));

/* ========================================================================== */
console.log('\n12. 既存の client-fetch 経路でどこまで届くか（母数の外）');
ok('client-fetch の表示箇所は候補を出せなかった（誤答ではない）',
  everyRun((r) => r.clientFetch.every((s) => s.bucket === 'missed'
    && s.candidates.length === 0)),
  runs()[0].clientFetch.map((s) => [s.field, s.bucket]));
ok('どこで追えなくなったかが記録されている（useState）',
  everyRun((r) => r.clientFetch.some((s) => s.untracked.some((u) => u.includes('useState')))),
  runs()[0].clientFetch[0].untracked);

/* ========================================================================== */
console.log('\n13. 取得手段と観測性の規約 — 格上げしていない');
eq('static-analysis のレベルは L2', model.SOURCE_LEVEL['static-analysis'], 'L2');
eq('static-analysis は推定である', model.observabilityOf('static-analysis'), 'estimated');
ok('由来のホップは3つのデータセットで必ず推定である',
  [A, C].every((m) => m.dataset.hops.filter((h) => h.relation === 'supplies')
    .every((h) => h.observability === 'estimated')));
ok('由来のホップの取得手段は static-analysis である',
  [A, C].every((m) => m.dataset.hops.filter((h) => h.relation === 'supplies')
    .every((h) => h.source === 'static-analysis')));
ok('実測 SQL を使って列を解決しても、ホップは実測にならない',
  [A, C].every((m) => {
    const h = m.dataset.hops.find((x) => x.relation === 'supplies');
    return h.evidence.some((e) => e.includes('SELECT 句')) && h.observability === 'estimated';
  }));
ok('由来のホップに「値の一致」を根拠として挙げていない',
  [A, C].every((m) => m.dataset.hops.every((h) => !h.evidence.includes(derive.VALUE_MATCH))));
ok('実測のホップ（executes / queries / reads / projects）は実測のまま',
  [A, C, G].every((m) => m.dataset.hops
    .filter((h) => h.relation !== 'supplies')
    .every((h) => h.observability === 'measured')));

/* ========================================================================== */
console.log('\n14. 変換 — 証拠のある関係だけを接続している');
eq('ケースA: 由来のホップが1本ある', A.dataset.hops.filter((h) => h.relation === 'supplies').length, 1);
eq('ケースC: 由来のホップが1本ある', C.dataset.hops.filter((h) => h.relation === 'supplies').length, 1);
eq('ケースG: 由来のホップを作っていない', G.dataset.hops.filter((h) => h.relation === 'supplies').length, 0);
eq('ケースG: 切断が残っている', G.dataset.cuts.length, 1);
ok('ケースG の切断に、候補を出せなかった理由が書いてある',
  G.dataset.cuts[0].sub.includes('静的解析でも候補を出せませんでした'), G.dataset.cuts[0].sub);
eq('ケースA: 解決状態は resolved',
  A.dataset.hops.find((h) => h.relation === 'supplies').linkStatus, 'resolved');
eq('ケースC: 解決状態は multiple-candidates',
  C.dataset.hops.find((h) => h.relation === 'supplies').linkStatus, 'multiple-candidates');
eq('ケースC: 候補を2件持っている',
  C.dataset.hops.find((h) => h.relation === 'supplies').candidates.length, 2);
ok('候補ごとに根拠が付いている',
  C.dataset.hops.find((h) => h.relation === 'supplies').candidates
    .every((c) => c.evidence.length >= 2 && c.identifier.startsWith('poc.')));
ok('由来のホップは「描いたコンポーネント」から「取得を実行したコンポーネント」へ向かう',
  [A, C].every((m) => {
    const h = m.dataset.hops.find((x) => x.relation === 'supplies');
    const from = m.dataset.nodes.find((n) => n.id === h.from);
    const to = m.dataset.nodes.find((n) => n.id === h.to);
    return from.kind === 'component' && to.kind === 'component' && from.id !== to.id;
  }));
ok('derives / maps を作っていない（rsc-direct に対応するノードが無い）',
  [A, C, G].every((m) => !m.dataset.hops.some((h) => h.relation === 'derives' || h.relation === 'maps')));
ok('テーブル → カラム の辺を作っていない（02a 3.5節）',
  [A, C, G].every((m) => !m.dataset.hops.some((h) => {
    const from = m.dataset.nodes.find((n) => n.id === h.from);
    const to = m.dataset.nodes.find((n) => n.id === h.to);
    return from?.kind === 'table' && to?.kind === 'column';
  })));
ok('projects の始点は必ず実行SQLである',
  [A, C, G].every((m) => m.dataset.hops.filter((h) => h.relation === 'projects')
    .every((h) => m.dataset.nodes.find((n) => n.id === h.from).kind === 'sql')));
ok('ORDER BY だけに現れる列をカラムのノードにしていない',
  !G.dataset.nodes.some((n) => n.kind === 'column' && n.identifier.startsWith('id ')),
  G.dataset.nodes.filter((n) => n.kind === 'column').map((n) => n.identifier));

/* ========================================================================== */
console.log('\n15. 経路全体の確実性を、最も弱い関係より高くしていない');
for (const [name, m] of [['ケースA', A], ['ケースC', C]]) {
  const ds = trace.buildDataset(name === 'ケースA' ? 'lin-a' : 'lin-c');
  const s = derive.summarize(ds);
  eq(`${name}: 経路全体は推定である`, s.observability, 'estimated');
  eq(`${name}: 最弱環は由来のホップである`, s.weakest?.relation, 'supplies');
  eq(`${name}: 推定の数は1である（由来のホップだけ）`, s.estimated, 1);
  ok(`${name}: 最弱環に説明文が付いている`, (s.weakest?.weakness ?? '').length > 80);
  ok(`${name}: 説明文に「推定」と「実行時に観測していない」が入っている`,
    s.weakest.weakness.includes('静的解析による推定')
    && s.weakest.weakness.includes('実行時に観測したものではありません'));
  ok(`${name}: 説明文に参照の連鎖が入っている`, s.weakest.weakness.includes('参照の連鎖'));
  void m;
}
{
  const ds = trace.buildDataset('lin-g');
  const s = derive.summarize(ds);
  eq('ケースG: 終点まで到達していないと記録される', s.truncated, true);
  ok('ケースG: 主張はコードの位置までで止まる', s.claim.startsWith('src/app/lin-g/page.tsx'), s.claim);
  ok('ケースG: テーブル・カラムを出所と書いていない',
    !s.claim.includes('poc.listings'), s.claim);
  eq('ケースG: 最弱環は無い（推定の関係が1つも無い）', s.weakest, null);
}
{
  const ds = trace.buildDataset('lin-a');
  const s = derive.summarize(ds);
  eq('ケースA: 主張は確定した1列である', s.claim, 'poc.listings . region');
}
{
  const ds = trace.buildDataset('lin-c');
  const s = derive.summarize(ds);
  ok('ケースC: 主張を1列に断定していない', s.claim.includes('候補のいずれか'), s.claim);
  ok('ケースC: 経路から到達できる列数（3）ではなく候補数（2）で書いている',
    s.claim.includes('2 候補') && ds.nodes.filter((n) => n.kind === 'column').length === 3,
    s.claim);
}

/* ========================================================================== */
console.log('\n16. 観測していないものが記録に残っている');
for (const [name, b] of [['ケースA', data.LIN_A_OBSERVATION], ['ケースC', data.LIN_C_OBSERVATION],
  ['ケースG', data.LIN_G_OBSERVATION]]) {
  ok(`${name}: 観測しなかったものが列挙されている`, b.meta.notObserved.length >= 5);
  ok(`${name}: 「表示値と列の値が一致すること」を観測していないと書いてある`,
    b.meta.notObserved.some((x) => x.what.includes('一致')));
  ok(`${name}: derives を作れない理由が書いてある`,
    b.meta.notObserved.some((x) => x.what.includes('derives') && x.why.includes('レスポンス')));
  ok(`${name}: maps を作れない理由が書いてある`,
    b.meta.notObserved.some((x) => x.what.includes('maps')));
  ok(`${name}: 由来の推定が記録に入っている`, !!b.lineage && typeof b.lineage.outcome === 'string');
  ok(`${name}: 追えなかった経路・解決できない参照の欄がある`,
    Array.isArray(b.lineage.untracked) && Array.isArray(b.lineage.unresolved));
  ok(`${name}: 推定の理由が記録されている`, b.lineage.reasons.length >= 1);
}
eq('ケースG: 推定の結果は none である', data.LIN_G_OBSERVATION.lineage.outcome, 'none');
ok('ケースG: 候補が空である',
  data.LIN_G_OBSERVATION.lineage.candidates.length === 0
  && data.LIN_G_OBSERVATION.lineage.tableCandidates.length === 0);
ok('3つの場面すべてで、ブラウザからの API 通信は 0 件（rsc-direct）',
  [data.LIN_A_OBSERVATION, data.LIN_C_OBSERVATION, data.LIN_G_OBSERVATION]
    .every((b) => b.rsc.browserApiRequests === 0));

/* ========================================================================== */
console.log('\n17. 収集していないもの');
const texts = {
  matrix: JSON.stringify(MATRIX),
  observation: fs.readFileSync(path.join(REPO, 'src', 'data', 'observation.poc04.ts'), 'utf8'),
};
const FORBIDDEN = [
  ['接続文字列', /postgres(ql)?:\/\//i],
  ['DBのパスワード', /poc01_local_only/],
  ['Cookie', /\bcookie\b/i],
  ['Authorizationヘッダ', /\bauthorization\b/i],
  ['アクセストークン', /\baccess_token\b/i],
  ['パスワード', /\bpassword\b/i],
  ['表示された値（DBの行データ）', /アオバ台|シラカワ野|ミナト浜|ヒガシ丘/],
  ['絶対パス', /\/Users\//],
];
for (const [name, re] of FORBIDDEN) {
  ok(`${name} を含まない`, !re.test(texts.matrix) && !re.test(texts.observation));
}
ok('リクエスト・レスポンス本文を持つ場所が無い',
  !/"(requestBody|responseBody|requestText|responseText|payload)"/.test(texts.observation));
ok('DBから返った行データを持っていない',
  !/"rows"\s*:\s*\[\s*\{/.test(texts.observation));
ok('表示された値は「文字数と文字種」だけを持っている',
  [data.LIN_A_OBSERVATION, data.LIN_C_OBSERVATION, data.LIN_G_OBSERVATION]
    .every((b) => b.elements.selections.every((s) => !s.valueShape
      || (Object.keys(s.valueShape).sort().join() === 'chars,cls'))));
ok('静的解析が持ち出すソースは「描いている式1つ」だけである（全文を持たない）',
  [data.LIN_A_OBSERVATION, data.LIN_C_OBSERVATION, data.LIN_G_OBSERVATION]
    .every((b) => b.lineage.site.expr.length <= 90 && !b.lineage.site.expr.includes('\n')),
  [data.LIN_A_OBSERVATION.lineage.site.expr, data.LIN_C_OBSERVATION.lineage.site.expr]);
ok('SQL のパラメータ値を除去した記録がある',
  [data.LIN_A_OBSERVATION, data.LIN_C_OBSERVATION]
    .every((b) => b.sqlAnalyses.every((a) => a.redacted !== undefined)));
ok('計測結果に外部送信の痕跡が無い（ローカルのファイルだけ）',
  !/https?:\/\/(?!localhost|127\.0\.0\.1)/.test(texts.observation));

/* ========================================================================== */
console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
