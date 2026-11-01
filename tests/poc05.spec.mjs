/* =============================================================================
 * PoC-05 — ブラウザの通信とサーバーの計測の接続（ブラウザを使わない検証）。
 *   npx tsc -p tsconfig.lib.json && node tests/poc05.spec.mjs
 *
 * 見るのは次の8点である。
 *   1. 必須ケースが実際に観測できていること
 *   2. A（ブラウザHTTP ↔ サーバーHTTP）が識別子だけで成立していること
 *   3. **誤った通信どうしを接続していないこと**・別トレースを混同しないこと
 *   4. B（コンポーネント ↔ HTTP）を、証拠があるときだけ作っていること
 *   5. C（応答 ↔ 表示値）をやっていないこと
 *   6. センシティブなデータを収集していないこと
 *   7. 観測不能な状態を正しく表現していること
 *   8. PoC-03 のコンパイルコストを、条件をそろえて再計測していること
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
const { FLOW_OBSERVATION: OBS } = require_('../.libjs/data/observation.poc05.js');
/* 計測記録は docs/ に置いた要約を読む（poc/out/ は .gitignore されている） */
const MATRIX = JSON.parse(fs.readFileSync(at('docs', '06c-poc05-matrix.json'), 'utf8'));
const COST = JSON.parse(fs.readFileSync(at('docs', '06c-anchorcost.json'), 'utf8'));

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);

const BUNDLERS = Object.keys(MATRIX.byBundler);
const ds = trace.buildDataset('flows');
const req = (k) => OBS.browserRequests.find((r) => r.path === k);
const focus = OBS.browserRequests.find(
  (r) => r.method === OBS.focus.method && r.path === OBS.focus.path,
);

/* ============================================= 1. 必須ケースが観測できている */
console.log('\n1. 必須ケースの実測');
ok('2つのバンドラで計測している', BUNDLERS.length === 2, BUNDLERS);
const REQUIRED = [
  '1回の操作で1リクエスト', '複数リクエストの同時実行', '同じURLへの連続リクエスト',
  '失敗したリクエスト', 'リダイレクト', 'Client Component からの fetch',
];
for (const b of BUNDLERS) {
  const cases = MATRIX.byBundler[b].caseResults;
  for (const r of REQUIRED) {
    ok(`${b}: 必須ケース「${r}」を実測している`, cases.some((c) => c.required.includes(r)));
  }
  ok(`${b}: すべてのケースが期待どおり（誤りなし）`,
    cases.every((c) => c.pass), cases.filter((c) => !c.pass).map((c) => c.key));
  ok(`${b}: 期待しなかった通信が紛れ込んでいない`,
    cases.every((c) => c.unexpected.length === 0), cases.flatMap((c) => c.unexpected));
}
ok('Server Component のページも実測している',
  BUNDLERS.every((b) => MATRIX.byBundler[b].rscResult.documentMatched));

/* ================================= 2. A: 識別子だけで対応付けが成立している */
console.log('\n2. A ブラウザHTTP ↔ サーバーHTTP');
for (const b of BUNDLERS) {
  const s = MATRIX.byBundler[b].summary;
  eq(`${b}: 識別子を読めた通信は、すべてサーバー側のスパンへ対応付いた`,
    s.matched, s.withIdentity);
  ok(`${b}: 対応付けが1件に絞れなかったことが一度も無い`, s.identityNeverAmbiguous);
  ok(`${b}: 2つの通信が同じサーバースパンを主張していない`, s.duplicateSpanClaims === 0);
  ok(`${b}: 2つのヘッダから読んだ識別子が食い違っていない`, s.headersAgreeAlways);
  eq(`${b}: 読んだ応答ヘッダは2つのキーだけ`, s.headerKeysRead.join(','),
    'server-timing,x-vcide-trace');
}
ok('変換した通信はサーバー側のスパンと同じトレースである',
  !!focus.server && OBS.spans.some(
    (s) => s.spanId === focus.server.spanId && s.traceId === focus.server.traceId,
  ));
ok('ブラウザ側の要求識別子を持っている（どの通信の話かを言える）', !!focus.browserRequestId);

/* ====================== 3. 誤接続しない・別トレースを混同しない */
console.log('\n3. 誤った通信どうしを接続しない');
for (const b of BUNDLERS) {
  const m = MATRIX.byBundler[b];
  const rows = m.caseResults.flatMap((c) => c.rules);
  ok(`${b}: 識別子による候補は、どの通信でも1件以下`, rows.every((r) => r.identity <= 1));
  ok(`${b}: メソッドとパスだけでは絞れない通信が実在する（${
    m.summary.corroborationOnlyAmbiguous} 件）`, m.summary.corroborationOnlyAmbiguous > 0);
  const same = m.caseResults.find((c) => c.key === 'parallel-same-url');
  ok(`${b}: 同じURLの同時実行では、時間窓だと候補が複数になる`,
    same.rules.every((r) => r.timeWindow > 1), same.rules.map((r) => r.timeWindow));
  ok(`${b}: その同時実行でも、識別子なら1件ずつに決まる`,
    same.rules.every((r) => r.identity === 1));
  ok(`${b}: 同じURLの同時実行で、3件が別々のサーバースパンに対応した`,
    new Set(same.a.map((x) => x.spanId)).size === 3, same.a.map((x) => x.spanId));
  ok(`${b}: 時間窓が1件に絞れたとき、識別子の答えと食い違っていない`,
    m.summary.timeWindowDisagreed === 0);
  ok(`${b}: 識別子が無いのに時間窓なら候補が出る通信が実在する（推定してはいけない）`,
    m.summary.timeWindowClaimsWithoutIdentity > 0);
  // 別トレースの混同
  ok(`${b}: サーバー側の入口スパンは1本ごとに別のトレースである`,
    m.summary.distinctTracesOnEntrySpans === m.summary.serverEntrySpans);
  const redirect = m.caseResults.find((c) => c.key === 'redirect');
  ok(`${b}: リダイレクトの段は、段ごとに別のトレースとして扱っている`,
    redirect.a[0].redirects.length === 1
    && redirect.a[0].redirects[0].traceId !== redirect.a[0].traceId);
  ok(`${b}: リダイレクトの両方の段がサーバースパンに対応している`,
    redirect.a[0].matched && redirect.a[0].redirects.every((h) => h.matched));
}
ok('変換に使ったスパンは、すべて主経路のトレースのものである',
  new Set(OBS.spans.map((s) => s.traceId)).size === 1);
ok('別トレースのスパンを経路へ混ぜていない',
  ds.nodes.filter((n) => ['server', 'sql'].includes(n.kind)).length > 0
  && OBS.spans.every((s) => s.traceId === focus.server.traceId));

/* ========================= 4. B: 証拠があるときだけ関係を作る */
console.log('\n4. B コンポーネント ↔ HTTP');
for (const b of BUNDLERS) {
  const m = MATRIX.byBundler[b];
  eq(`${b}: 操作で起きた通信は、すべて呼び出し元を解決できた`,
    m.initiatorSummary.resolved, m.initiatorSummary.total);
  ok(`${b}: 解決した呼び出し元は、すべてソースの読み直しで照合している`,
    m.initiatorSummary.verified === m.initiatorSummary.total);
  const child = m.caseResults.find((c) => c.key === 'child-component');
  eq(`${b}: 子コンポーネントからの通信は、ページではなく子を指す`,
    child.b[0].component, 'FetchButton');
  ok(`${b}: 文書の取得には呼び出し元を作らない（スタックが無い）`,
    m.document.initiatorComponent === null
    && m.document.initiatorReason === m.document.expectedReason);
  const same = m.caseResults.find((c) => c.key === 'parallel-same-url');
  ok(`${b}: 同じURLの同時実行3件を、別々の呼び出し位置に対応づけた`,
    new Set(same.b.map((x) => x.line)).size === 3, same.b.map((x) => x.line));
}
const initiator = ds.nodes.find((n) => n.kind === 'component'
  && n.overview.some((r) => r.k === '呼び出し位置'));
const renders = ds.nodes.find((n) => n.kind === 'component' && n !== initiator);
ok('「この通信を開始したコンポーネント」のノードがある', !!initiator);
ok('「この値を描いたコンポーネント」とは別のノードである', !!renders && renders !== initiator);
ok('両者のあいだに関係（線）を作っていない',
  !ds.hops.some((h) => (h.from === initiator.id && h.to === renders.id)
    || (h.from === renders.id && h.to === initiator.id)));
const requests = ds.hops.find((h) => h.relation === 'requests');
ok('requests の始点は、通信を開始したコンポーネントである', requests.from === initiator.id);
ok('requests の終点は通信である',
  trace.nodeOf(ds, requests.to).kind === 'http');
eq('requests の取得手段は、ブラウザが記録した呼び出しスタックである',
  requests.source, 'request-initiator');
ok('主張の範囲を概要に書いている',
  initiator.overview.some((r) => r.k === '主張の範囲' && r.v.includes('観測していません')));
ok('証拠が無ければ requests を作らない（PoC-03 のデータでは作っていない）',
  !trace.buildDataset('elements').hops.some((h) => h.relation === 'requests'));
ok('PoC-03 のデータでは、通信から切断マーカーが出たままである',
  trace.buildDataset('elements').cuts.some(
    (c) => c.head.includes('この通信を起こした箇所は特定していません'),
  ));

/* ======================================= 5. C: 応答と表示値は対応づけない */
console.log('\n5. C 応答 ↔ 表示値（やらない）');
const rel = ds.hops.map((h) => h.relation);
ok('maps を作っていない', !rel.includes('maps'));
ok('derives を作っていない', !rel.includes('derives'));
ok('binds を作っていない', !rel.includes('binds'));
ok('props の由来を切断として残している',
  ds.cuts.some((c) => c.sub.includes('props の由来')));
ok('経路が終点まで到達していないことを、主張の側で明示している',
  derive.summarize(ds).truncated === true);
eq('主張は、たどり着けたところまでである',
  derive.summarize(ds).claim, 'src/components/RegionBadge.tsx:8');

/* ============================= 6. センシティブなデータを収集していない */
console.log('\n6. 収集禁止項目');
const text = JSON.stringify(OBS);
const FORBIDDEN = [
  [/postgres(ql)?:\/\//i, '接続文字列'],
  [/poc01_local_only/, 'DBのパスワード'],
  [/"cookie"/i, 'Cookie'],
  [/"authorization"/i, 'Authorizationヘッダ'],
  [/\bbearer\b/i, 'アクセストークン'],
  [/\baccess_token\b/i, 'アクセストークン'],
  [/アオバ台|シラカワ野|ミナト浜|ヒガシ丘/, '画面に表示された値'],
  [/\/Users\//, '絶対パス'],
];
for (const [re, label] of FORBIDDEN) ok(`${label} を含まない`, !re.test(text));
ok('応答ヘッダは2つのキーしか読んでいない',
  OBS.browserRequests.every((r) => (r.readHeaderKeys ?? []).every(
    (k) => k === 'server-timing' || k === 'x-vcide-trace')));
ok('リクエスト／レスポンスの本文を持つ場所が無い',
  // 属性名として現れないことを見る（<body> タグ名などの値は対象外）
  !/"(requestBody|responseBody|body|payload|postData|content)"\s*:/.test(text));
ok('クエリ文字列の値を持っていない（有無だけ）',
  OBS.browserRequests.every((r) => !r.path.includes('?')) && 'hasQuery' in focus);
ok('SQL 文に文字列リテラルが残っていない',
  OBS.sqlAnalyses.every((a) => !/'[^']*[A-Za-z　-鿿][^']*'/.test(a.sql)));
ok('識別子の公開範囲を実測している', !!OBS.exposure);
ok('専用ヘッダはページ上のスクリプトから読めない',
  OBS.exposure.dedicatedHeaderVisibleToPageScript === false);
ok('Server-Timing はページ上のスクリプトから読めてしまう（記録してある）',
  OBS.exposure.serverTimingVisibleToPageScript > 0);
ok('クロスオリジンでは、ページ上のスクリプトはどちらのヘッダも読めない',
  OBS.exposure.crossOrigin.serverTimingReadable === false
  && OBS.exposure.crossOrigin.dedicatedReadable === false);
ok('クロスオリジンでも IDE（CDP）からは読める', OBS.exposure.readableViaCdp === true);
for (const b of BUNDLERS) {
  const e = MATRIX.byBundler[b].exposureResult;
  ok(`${b}: クロスオリジンの公開範囲を実測している`,
    e.crossOrigin.serverTimingReadable === false && e.crossOrigin.readableViaCdp === true);
}

/* ============================ 7. 観測不能な状態を正しく表現している */
console.log('\n7. 観測不能な状態');
for (const b of BUNDLERS) {
  const m = MATRIX.byBundler[b];
  const abort = m.caseResults.find((c) => c.key === 'no-response');
  ok(`${b}: 応答が返らない通信には識別情報が無い`, abort.a[0].hasIdentity === false);
  ok(`${b}: その通信をサーバー側へ対応付けていない`, abort.a[0].matched === false);
  eq(`${b}: 対応付けなかった理由を残している`, abort.a[0].reason, 'no-identity-in-response');
  eq(`${b}: 失敗の種別を「応答なし」として区別している`, abort.a[0].failure.kind, 'no-response');
  const fail500 = m.caseResults.find((c) => c.key === 'failed-500');
  ok(`${b}: 500 の通信は、失敗していても対応付けられる`,
    fail500.a[0].matched === true && fail500.a[0].status === 500);
  ok(`${b}: サーバー側のスパンも 500 を記録している`, fail500.a[0].serverStatus === 500);
  const rsc = m.rscResult;
  ok(`${b}: Server Component の文書取得は対応付けられる`, rsc.documentMatched);
  ok(`${b}: サーバーの中で起きた通信を、スパンとしては観測できている`,
    rsc.serverInternalFetchObserved);
  ok(`${b}: その相手のハンドラは別トレースであり、同一と主張していない`,
    rsc.innerHandlerInSameTrace === false);
}
ok('観測しなかったものを列挙している（空にしない）', OBS.meta.notObserved.length > 0);
for (const what of ['ブラウザからサーバーへのトレース伝播', 'props の由来（derives）',
  '応答が返らなかった通信のサーバー側']) {
  ok(`観測していないものに「${what}」が挙がっている`,
    OBS.meta.notObserved.some((n) => n.what.includes(what)));
}

/* ========================================= 8. 変換の規約（既存の約束） */
console.log('\n8. 変換の規約');
ok('観測性はすべて取得手段から導出されている',
  [...ds.nodes, ...ds.hops].every(
    (e) => e.observability === model.observabilityOf(e.source),
  ));
eq('推定に落ちた要素は無い（すべて実測の手段で取れている）',
  [...ds.nodes, ...ds.hops].filter((e) => e.observability === 'estimated').length, 0);
ok('テーブルからカラムへの辺を作っていない',
  !ds.hops.some((h) => trace.nodeOf(ds, h.from).kind === 'table'));
ok('projects の始点はすべて実行SQLである',
  ds.hops.filter((h) => h.relation === 'projects')
    .every((h) => trace.nodeOf(ds, h.from).kind === 'sql'));
ok('ステップバッジを変換結果に持たせていない',
  ds.nodes.every((n) => !('badge' in n) && !('step' in n)));
ok('キャンバスのバッジと、番号付きリストの番号が一致する',
  ds.nodes.every((n) => derive.stepBadge(ds, n.id, 'path') === n.id));
ok('スパンを持つノードだけが時間窓を持つ',
  ds.nodes.every((n) => (!!n.span) === ['http', 'server', 'sql'].includes(n.kind)));
ok('既存のデータセットが壊れていない（合成）', trace.buildDataset('synthetic').nodes.length === 7);
ok('既存のデータセットが壊れていない（PoC-01）', trace.buildDataset('measured').nodes.length === 7);
ok('既存のデータセットが壊れていない（PoC-03）', trace.buildDataset('elements').nodes.length === 9);

/* ========================== 9. PoC-03 のコンパイルコストの再計測 */
console.log('\n9. PoC-03 のコンパイルコスト（条件をそろえた再計測）');
ok('構文解析器の読み込みを独立に測っている', COST.parserLoad.medianMs > 0);
ok('ファイル1枚の変換時間を測っている', COST.perFile.files.length > 0);
ok('変換そのものは、解析器の読み込みより桁違いに軽い',
  COST.perFile.totalWarmMs < COST.parserLoad.medianMs,
  { transform: COST.perFile.totalWarmMs, parser: COST.parserLoad.medianMs });
ok('ローダが解析器を読み込んだ回数（ワーカー数）を測っている',
  COST.loader.workerProcesses > 0);
ok('初回コンパイルと再コンパイルの両方を測っている',
  Object.values(COST.dev).every((d) => d.cold.firstCompileMs > 0 && d.cold.recompileMs > 0));
ok('ビルドのキャッシュが残っている場合も測っている',
  Object.values(COST.dev).every((d) => d.warmCache.firstCompileMs > 0));
ok('2つのバンドラで測っている',
  ['turbopack-on', 'turbopack-off', 'webpack-on', 'webpack-off']
    .every((k) => COST.dev[k]));
ok('増分を割合と絶対値の両方で出している',
  Object.values(COST.comparison).every(
    (c) => typeof c.cold.firstCompilePct === 'number'
      && typeof c.cold.firstCompileDeltaMs === 'number',
  ));
ok('注入の結果は変えていない（計測は環境変数でのみ有効）',
  fs.readFileSync(at('poc', 'anchor', 'loader.cjs'), 'utf8')
    .includes("const COST = process.env.POC03_ANCHOR_COST || '';"));

/* -------------------------------------------------------------------- */
console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
