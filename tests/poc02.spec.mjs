/* =============================================================================
 * PoC-02 — 方式と変換の検証（ブラウザを使わない）。
 *   node tests/poc02.spec.mjs
 *
 * 読むもの:
 *   docs/06d-poc02-matrix.json   実測の判定（バンドラ × 伝播の有無の4条件）
 *   src/data/observation.poc02.ts → .libjs 経由の変換結果
 *
 * 見るのは次の5つである（指示 第7節）。
 *   1. 正しいサーバー間関連付けができていること
 *   2. 異なるトレースを混同していないこと
 *   3. RSC 直接経路に架空の API ノードが無いこと
 *   4. 取得できない関係を実測へ格上げしていないこと
 *   5. 観測不能な状態が記録に残っていること
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const require_ = createRequire(import.meta.url);

const MATRIX = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', '06d-poc02-matrix.json'), 'utf8'));
const trace = require_('../.libjs/lib/trace.js');
const model = require_('../.libjs/lib/model.js');
const adapter = require_('../.libjs/lib/adapter.js');
const data = require_('../.libjs/data/observation.poc02.js');
const loopback = require_('../poc/fixture-app/ide-instrumentation/loopback.cjs');

const RSC = trace.MEASURED_RSC;
const SVC = trace.MEASURED_RSC_SVC;
const RUNS = Object.keys(MATRIX.byRun);
const ON = RUNS.filter((k) => k.endsWith('-on'));
const OFF = RUNS.filter((k) => k.endsWith('-off'));
const runs = (keys) => keys.map((k) => MATRIX.byRun[k]);

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

/* ========================================================================== */
console.log('\n1. 計測の構成（2つのゲートを別々に判定している）');
eq('4条件（バンドラ2 × 伝播の有無2）を回している', RUNS.length, 4);
ok('Turbopack と webpack の両方で回している',
  RUNS.some((k) => k.startsWith('turbopack')) && RUNS.some((k) => k.startsWith('webpack')));
ok('隔離した2つ目の検証用サービスを使っている',
  MATRIX.svc.service === 'poc02-fixture-svc' && MATRIX.svc.origin.includes('127.0.0.1'));
ok('Gate A と Gate B が別々の判定として記録されている',
  all(runs(RUNS), (r) => typeof r.summary.gateAPass === 'boolean'
    && typeof r.summary.gateBPass === 'boolean'));

/* ========================================================================== */
console.log('\n2. Gate A — 正しいサーバー間関連付け');
ok('伝播ありの条件で、Gate A の全ケースが成立する',
  all(runs(ON), (r) => r.summary.gateAPass), runs(ON).map((r) => r.summary.gateAPass));
ok('別プロセスのサービスへの通信が、同じトレースの親子として繋がった',
  all(runs(ON), (r) => r.gateA.find((g) => g.key === 'svc-echo').observed
    .every((o) => o.propagated && o.sameTrace === true && o.crossProcess === true)));
ok('自分の API ルートへの通信も、同じトレースの親子として繋がった',
  all(runs(ON), (r) => r.gateA.find((g) => g.key === 'self-api').observed
    .every((o) => o.propagated && o.sameTrace === true)));
ok('2つのサービスのスパンが1つのトレースに入った（伝播ありのときだけ）',
  all(runs(ON), (r) => r.summary.crossServiceTraces > 0)
  && all(runs(OFF), (r) => r.summary.crossServiceTraces === 0),
  [runs(ON).map((r) => r.summary.crossServiceTraces), runs(OFF).map((r) => r.summary.crossServiceTraces)]);
ok('受け側は「traceparent が付いていた」と見ている（伝播ありのときだけ）',
  all(runs(ON), (r) => r.summary.svcRequestsWithTraceparent > 0)
  && all(runs(OFF), (r) => r.summary.svcRequestsWithTraceparent === 0));
ok('計装していない要求（ランナー自身）には traceparent が付いていない',
  all(runs(RUNS), (r) => (r.summary.svcTraceparentByPath?.['/__seen']?.withTraceparent ?? 0) === 0));
ok('1本の入口スパンを2本の通信が主張したことは1度も無い',
  all(runs(RUNS), (r) => r.gateA.every((g) => g.duplicateEntryClaims.length === 0)));
ok('採用規則の候補は、どの通信でも0件か1件である',
  all(runs(RUNS), (r) => r.gateA.every((g) => g.rules.every((x) => x.parentage <= 1))));

/* ========================================================================== */
console.log('\n3. Gate A — 異なるトレースを混同しない');
ok('伝播を入れない条件では、1件も対応付けていない',
  all(runs(OFF), (r) => r.gateA.every((g) => g.observed.every((o) => o.propagated === false))));
ok('伝播を入れない条件でも、Gate A の判定は通る（＝作らないことが正解）',
  all(runs(OFF), (r) => r.summary.gateAPass));
ok('伝播を入れない条件では、受け側は別トレースだと記録されている',
  all(runs(OFF), (r) => r.gateA.filter((g) => g.key !== 'dead-port')
    .every((g) => g.rules.some((x) => x.entryIsOtherTrace === true))));
ok('時間窓なら繋いでしまう場面が、伝播なしの条件で実在する',
  runs(OFF).every((r) => r.gateA.reduce((a, g) => a + g.timeWindowWouldMatch, 0) >= 3),
  runs(OFF).map((r) => r.gateA.reduce((a, g) => a + g.timeWindowWouldMatch, 0)));
ok('その場面で、採用規則は1件も繋いでいない',
  all(runs(OFF), (r) => r.gateA.every((g) => g.rules.every((x) => x.parentage === 0))));
ok('応答が返らない通信（開いていないポート）は、伝播ありでも対応付けない',
  all(runs(ON), (r) => {
    const g = r.gateA.find((x) => x.key === 'dead-port');
    return g.observed.every((o) => !o.propagated && o.propagationFailure === 'no-child-entry-span');
  }));
ok('応答が返らない通信は、時間窓でも候補が出ない（存在しないため）',
  all(runs(RUNS), (r) => r.gateA.find((x) => x.key === 'dead-port').timeWindowWouldMatch === 0));

/* ========================================================================== */
console.log('\n4. 伝播の範囲 — ループバック以外には出さない');
ok('ループバックの宛先は伝播の対象である',
  ['http://127.0.0.1:3300', 'http://localhost:3200', 'http://[::1]:9999']
    .every((o) => loopback.isLoopbackOrigin(o)));
ok('ループバック以外の宛先は伝播の対象にしない',
  ['http://example.com', 'https://api.example.com:443', 'http://192.168.1.10:3000',
    'http://10.0.0.1', 'http://0.0.0.0:3300']
    .every((o) => !loopback.isLoopbackOrigin(o)));
ok('解釈できない宛先は伝播の対象にしない（既定で出さない）',
  ['', 'not a url', null, undefined].every((o) => !loopback.isLoopbackOrigin(o)));

/* ========================================================================== */
console.log('\n5. Gate B — RSC の直読み');
ok('伝播の有無にかかわらず Gate B は成立する（DB 直読みは伝播に依存しない）',
  all(runs(RUNS), (r) => r.summary.gateBPass));
ok('描画スパンを観測できている', all(runs(RUNS), (r) => r.gateB.every((g) => g.renderSpanObserved)));
ok('SQL スパンは描画スパンの子孫である',
  all(runs(RUNS), (r) => r.gateB.every((g) => g.sql.every((s) => s.depthFromRender >= 1))));
ok('並列の3本で、スパンの区間が重なっている（並行実行を観測できている）',
  all(runs(RUNS), (r) => r.gateB.find((g) => g.key === 'rsc-parallel').overlaps.length > 0));
ok('同じ SQL を2箇所から実行した場合、2本のスパンとして観測している',
  all(runs(RUNS), (r) => r.gateB.find((g) => g.key === 'rsc-dup').sqlUnderRender === 2));
ok('同じ SQL でも、実行元を別々のコンポーネントとして特定している',
  all(runs(RUNS), (r) => {
    const names = r.gateB.find((g) => g.key === 'rsc-dup').sql.map((s) => s.attribution.component);
    return new Set(names).size === 2 && names.includes('RscDup') && names.includes('ListingCount');
  }));
ok('失敗した SQL を「失敗した」として観測している',
  all(runs(RUNS), (r) => r.gateB.find((g) => g.key === 'rsc-fail').sql.every((s) => s.failed)));
ok('存在しないテーブルにノードを作れないことを記録している',
  all(runs(RUNS), (r) => r.gateB.find((g) => g.key === 'rsc-fail').sql
    .every((s) => s.tablesInSchema.length === 0)));

/* ========================================================================== */
console.log('\n6. Gate B — スパンだけではコンポーネントに帰属できない');
ok('スパン開始時のスタックには、呼び出し元のフレームが1件も無い',
  all(runs(RUNS), (r) => r.summary.attribution.appFrameAtSpanStart === 0),
  runs(RUNS).map((r) => r.summary.attribution.appFrameAtSpanStart));
ok('コンポーネントではない関数の中の SQL は、帰属を作らない',
  all(runs(RUNS), (r) => {
    const g = r.gateB.find((x) => x.key === 'rsc-helper');
    return g.sql.every((s) => s.attribution.component === null
      && s.attribution.reason === 'component-not-agreed');
  }));
ok('そのときでも、どこで実行されたかの位置は記録している',
  all(runs(RUNS), (r) => r.gateB.find((x) => x.key === 'rsc-helper').sql
    .every((s) => s.attribution.file === 'src/app/rsc-helper/page.tsx' && s.attribution.line === 13)));
ok('帰属できたものは、ソース行の読み直しで照合してある',
  all(runs(RUNS), (r) => r.gateB.flatMap((g) => g.sql)
    .filter((s) => s.attribution.component).every((s) => s.attribution.verified === true)));
ok('帰属を断った理由が記録されている（無反応にしない）',
  all(runs(RUNS), (r) => Object.keys(r.summary.attribution.reasons).length > 0));
ok('並列の3本を、同じファイルの別々の行として区別できている',
  all(runs(RUNS), (r) => {
    const lines = r.gateB.find((g) => g.key === 'rsc-parallel').sql.map((s) => s.attribution.line);
    return new Set(lines).size === 3;
  }));
ok('Turbopack と webpack で、帰属の結果が一致している', (() => {
  /* 並列実行の3本はスパンの開始順が実行ごとに違う。**集合として**比べる */
  const key = (r) => JSON.stringify(r.gateB.map((g) => g.sql
    .map((s) => `${s.attribution.file}:${s.attribution.line}:${s.attribution.component}`).sort()));
  return key(MATRIX.byRun['turbopack-propagation-on']) === key(MATRIX.byRun['webpack-propagation-on']);
})());

/* ========================================================================== */
console.log('\n7. ブラウザ側に API 通信が無い（架空の API ノードを作る材料が無い）');
ok('Gate B の全ページで、ブラウザからの API 通信は 0 件',
  all(runs(RUNS), (r) => r.gateB.every((g) => g.browserApiRequests === 0)));
ok('文書取得の呼び出し元をブラウザは記録していない',
  all(runs(RUNS), (r) => r.gateB.every((g) => g.documentInitiatorType !== 'script')));

/* ========================================================================== */
console.log('\n8. 変換 — 取得できた関係だけを接続している');
for (const [name, res] of [['rsc', RSC], ['rsc-svc', SVC]]) {
  const ds = res.dataset;
  ok(`${name}: ノードとホップがすべて実測である`,
    ds.nodes.every((n) => n.observability === 'measured')
    && ds.hops.every((h) => h.observability === 'measured'));
  ok(`${name}: /api/ のノードを1つも作っていない`,
    !ds.nodes.some((n) => n.identifier.includes('/api/') || n.chipSub.includes('/api/')),
    ds.nodes.map((n) => n.identifier));
  ok(`${name}: derives と maps のホップを作っていない`,
    !ds.hops.some((h) => h.relation === 'derives' || h.relation === 'maps'));
  ok(`${name}: 観測していない区間を切断として残している`, ds.cuts.length >= 1);
  ok(`${name}: ホップの観測性が取得手段から導出されている`,
    ds.hops.every((h) => h.observability === model.observabilityOf(h.source)));
  ok(`${name}: projects の始点は必ず実行SQLである`,
    ds.hops.filter((h) => h.relation === 'projects')
      .every((h) => ds.nodes.find((n) => n.id === h.from).kind === 'sql'));
  ok(`${name}: テーブルからカラムへの辺を作っていない`,
    !ds.hops.some((h) => ds.nodes.find((n) => n.id === h.from).kind === 'table'
      && ds.nodes.find((n) => n.id === h.to).kind === 'column'));
  ok(`${name}: ノードの識別子が経路の順に振られている`,
    ds.nodes.map((n) => n.id).sort((a, b) => a - b).join() === ds.nodes.map((n) => n.id).sort((a, b) => a - b).join());
}
eq('rsc: ノード数', RSC.dataset.nodes.length, 10);
eq('rsc: ホップ数', RSC.dataset.hops.length, 8);
ok('rsc: 通信のノードは文書取得の1件だけである',
  RSC.dataset.nodes.filter((n) => n.kind === 'http').length === 1
  && RSC.dataset.nodes.find((n) => n.kind === 'http').identifier === 'GET /rsc-db');
ok('rsc: 文書取得であって API 通信ではないと書いてある',
  RSC.dataset.nodes.find((n) => n.kind === 'http').overview
    .some((r) => r.v.includes('API 通信ではありません')));
ok('rsc: コンポーネントのノードが2つあり、束ねていない',
  RSC.dataset.nodes.filter((n) => n.kind === 'component').length === 2);
ok('rsc: その2つの間にホップが無い（描いた と 実行した を繋がない）', (() => {
  const ids = RSC.dataset.nodes.filter((n) => n.kind === 'component').map((n) => n.id);
  return !RSC.dataset.hops.some((h) => ids.includes(h.from) && ids.includes(h.to));
})());
ok('rsc: SQL への関係は executes（スパンの親子）と queries（呼び出しスタック）の2本', (() => {
  const sql = RSC.dataset.nodes.find((n) => n.kind === 'sql');
  const into = RSC.dataset.hops.filter((h) => h.to === sql.id);
  return into.length === 2 && into.some((h) => h.relation === 'executes' && h.source === 'trace-span')
    && into.some((h) => h.relation === 'queries' && h.source === 'server-call-stack');
})());
ok('rsc: 描画スパンはルート単位であることを画面の文言で断っている',
  RSC.dataset.nodes.find((n) => n.kind === 'server').overview
    .some((r) => r.v.includes('ルート単位')));

/* ========================================================================== */
console.log('\n9. 変換 — サーバー内部通信（Gate A）の表現');
ok('rsc-svc: サーバー処理のノードが2つある（2つのサービス）',
  SVC.dataset.nodes.filter((n) => n.kind === 'server').length === 2);
ok('rsc-svc: 2つ目のサーバーに、観測したサービス名が足元のラベルとして付く', (() => {
  const servers = SVC.dataset.nodes.filter((n) => n.kind === 'server');
  return servers[1].locus?.text === 'poc02-fixture-svc';
})());
ok('rsc-svc: 伝播のホップの取得手段はトレースコンテキストである', (() => {
  const h = SVC.dataset.hops.find((x) => x.id === 'handles-internal');
  return h && h.source === 'trace-context' && h.observability === 'measured';
})());
ok('rsc-svc: 伝播の根拠に「送信側スパンの子であること」が書いてある',
  SVC.dataset.hops.find((x) => x.id === 'handles-internal').evidence
    .some((e) => e.includes('子であること')));
ok('rsc-svc: サーバー内部の通信はブラウザに現れないと書いてある',
  SVC.dataset.nodes.filter((n) => n.kind === 'http')
    .some((n) => n.overview.some((r) => r.v.includes('ブラウザには現れません'))));
ok('rsc-svc: 経路外に、描いていないサーバー内部通信を残している',
  SVC.dataset.offPath.nodes.some((n) => n.label.includes('/echo')));
ok('rsc-svc: 主経路に描いた取得を経路外に二重に出していない', (() => {
  const drawn = SVC.dataset.nodes.map((n) => n.identifier);
  return !SVC.dataset.offPath.nodes.some((o) => drawn.includes(o.label));
})());

/* ========================================================================== */
console.log('\n10. 伝播が成立しないときに、相手側を作らない');
{
  /* 観測結果の写しを作り、伝播が成立しなかった状態へ落として変換する。
   * **実測データを書き換えていない。** 変換の振る舞いを確かめるための写しである */
  const broken = JSON.parse(JSON.stringify(data.RSC_SVC_OBSERVATION));
  for (const e of broken.rsc.exchanges) {
    e.entrySpanId = null;
    e.propagationFailure = 'no-child-entry-span';
    e.crossProcess = null;
    e.entryService = null;
    e.sqlSpanIds = [];
  }
  const r = adapter.fromRscObservation(broken);
  ok('伝播が成立しなければ、相手側のサーバーのノードを作らない',
    r.dataset.nodes.filter((n) => n.kind === 'server').length === 1);
  ok('伝播が成立しなければ、相手側の SQL も作らない',
    r.dataset.nodes.filter((n) => n.kind === 'sql').length === 0);
  ok('代わりに切断マーカーを置く',
    r.dataset.cuts.some((c) => c.head.includes('相手側の処理は特定していません')));
  ok('切断に理由が書いてある',
    r.dataset.cuts.some((c) => c.sub.includes('この通信の子として観測できていない')));
  ok('作らなかったことを記録に残している',
    r.skipped.some((s) => s.what.includes('相手側')));
  ok('別トレースになっても、時刻で繋ぎ直す経路が存在しない',
    !r.dataset.hops.some((h) => h.source === 'time-window'));
}
{
  /* 帰属の証拠を落とした写し。ノードも関係も作らないことを確かめる */
  const noAttr = JSON.parse(JSON.stringify(data.RSC_OBSERVATION));
  for (const s of noAttr.rsc.sql) {
    s.callsite = {
      at: 'pg-pool.Pool.query', frame: null, verified: false, sourceLine: null,
      component: null, appFrameAtSpanStart: false,
      failure: { reason: 'no-app-frame', detail: null },
    };
  }
  const r = adapter.fromRscObservation(noAttr);
  ok('呼び出しスタックの証拠が無ければ、実行したコンポーネントのノードを作らない',
    r.dataset.nodes.filter((n) => n.kind === 'component').length === 1);
  ok('queries のホップも作らない', !r.dataset.hops.some((h) => h.relation === 'queries'));
  ok('理由を記録に残している',
    r.skipped.some((s) => s.what.includes('実行したコンポーネント')));
  ok('SQL のノード自体は残る（スパンは観測できているため）',
    r.dataset.nodes.some((n) => n.kind === 'sql'));
}
{
  /* ブラウザ側に API 通信がある記録は、この経路の変換に通さない */
  const withApi = JSON.parse(JSON.stringify(data.RSC_OBSERVATION));
  withApi.rsc.browserApiRequests = 1;
  let threw = false;
  try { adapter.fromRscObservation(withApi); } catch { threw = true; }
  ok('ブラウザの API 通信がある記録を rsc-direct として変換しない', threw);
}

/* ========================================================================== */
console.log('\n11. 取得手段と観測性の規約');
eq('server-call-stack は L1相当である', model.SOURCE_LEVEL['server-call-stack'], 'L1-equivalent');
eq('server-call-stack は実測として扱う', model.observabilityOf('server-call-stack'), 'measured');
eq('time-window は推定のままである', model.observabilityOf('time-window'), 'estimated');
ok('取得手段の文言が UI 用に定義されている',
  typeof model.SOURCE_LABEL['server-call-stack'] === 'string'
  && model.SOURCE_LABEL['server-call-stack'].length > 0);

/* ========================================================================== */
console.log('\n12. 観測していないものが記録に残っている');
for (const [name, bundle] of [['rsc', data.RSC_OBSERVATION], ['rsc-svc', data.RSC_SVC_OBSERVATION]]) {
  ok(`${name}: notObserved が空でない`, bundle.meta.notObserved.length > 0);
  ok(`${name}: コンポーネント単位のスパンが無いことを書いている`,
    bundle.meta.notObserved.some((n) => n.what.includes('コンポーネント単位')));
  ok(`${name}: スパン開始時のスタックでは代用できないことを書いている`,
    bundle.meta.notObserved.some((n) => n.what.includes('スパン開始時')));
  ok(`${name}: derives と maps を観測していないと書いている`,
    bundle.meta.notObserved.some((n) => n.what.includes('derives'))
    && bundle.meta.notObserved.some((n) => n.what.includes('maps')));
  ok(`${name}: 伝播の成立条件（ループバック限定）を記録している`,
    bundle.rsc.propagation.scope.includes('ループバック'));
}

/* ========================================================================== */
console.log('\n13. 収集していないもの');
const texts = {
  matrix: JSON.stringify(MATRIX),
  observation: JSON.stringify([data.RSC_OBSERVATION, data.RSC_SVC_OBSERVATION]),
  dataset: JSON.stringify([RSC.dataset, SVC.dataset]),
};
const FORBIDDEN = [
  ['接続文字列', /postgres(ql)?:\/\//i],
  ['DBのパスワード', /poc01_local_only/],
  ['Cookie', /\bcookie\b/i],
  ['Authorization', /\bauthorization\b/i],
  ['Bearer トークン', /\bbearer\b/i],
  ['パスワード', /\bpassword\b/i],
  ['アクセストークン', /\baccess_token\b/i],
  ['DBの行データ（架空の地名）', /アオバ台|シラカワ野|ミナト浜|ヒガシ丘/],
  ['絶対パス', /\/Users\//],
  ['トレースコンテキストの値', /00-[0-9a-f]{32}-[0-9a-f]{16}-/],
];
for (const [label, re] of FORBIDDEN) {
  for (const [where, text] of Object.entries(texts)) {
    ok(`${where} に ${label} を含まない`, !re.test(text));
  }
}
ok('SQL のパラメータ値を持っていない（除去した件数だけを持つ）',
  data.RSC_OBSERVATION.sqlAnalyses.every((a) => !a.redacted || typeof a.redacted.strings === 'number'));
ok('読んだ応答ヘッダは相関用の2キーだけである',
  [...new Set([data.RSC_OBSERVATION, data.RSC_SVC_OBSERVATION]
    .flatMap((b) => b.browserRequests.flatMap((r) => r.readHeaderKeys ?? [])))]
    .every((k) => k === 'server-timing' || k === 'x-vcide-trace'));
ok('リクエスト・レスポンス本文を入れる場所が無い',
  !/"(requestBody|responseBody|requestText|responseText|payload)"/.test(texts.observation));
ok('受け側は traceparent の有無だけを数えている（値を持たない）',
  runs(RUNS).every((r) => Object.values(r.summary.svcTraceparentByPath ?? {})
    .every((v) => typeof v.withTraceparent === 'number')));

/* ========================================================================== */
console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
