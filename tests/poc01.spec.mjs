/* =============================================================================
 * PoC-01 — 観測結果とその変換の検証（ブラウザを使わない）。
 *   npx tsc -p tsconfig.lib.json && node tests/poc01.spec.mjs
 *
 * 見るのは次の5点である。
 *   1. 計測情報を取得できている
 *   2. 時刻と親子関係が正しく扱われている
 *   3. 実測と推定が区別されている（表示の都合で格上げできない）
 *   4. 未取得の情報を捏造していない
 *   5. 機密値が収集されていない
 * ========================================================================== */
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

const model = require_('../.libjs/lib/model.js');
const trace = require_('../.libjs/lib/trace.js');
const derive = require_('../.libjs/lib/derive.js');
const { OBSERVATION: OBS } = require_('../.libjs/data/observation.measured.js');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);

const measured = trace.buildDataset('measured');
const synthetic = trace.buildDataset('synthetic');
const measuredSources = () => [...measured.nodes, ...measured.hops].map((e) => e.source);

/* ------------------------------------------------- 1. 計測情報を取得できる */
console.log('\n1. 実際の計装から情報を取得できている');
ok('スパンを取得している', OBS.spans.length > 0, OBS.spans.length);
ok('ブラウザの通信記録を取得している', OBS.browserRequests.length > 0, OBS.browserRequests.length);
ok('実行された SQL 文を取得している', OBS.sqlAnalyses.length > 0, OBS.sqlAnalyses.length);
ok('HTTP のメソッド・パス・ステータスを取得している',
  OBS.browserRequests.every((r) => r.method && r.path && typeof r.status === 'number'));
ok('HTTP の所要時間を取得している',
  OBS.browserRequests.every((r) => typeof r.durationMs === 'number' && r.durationMs > 0),
  OBS.browserRequests.map((r) => r.durationMs));
ok('応答からサーバー側のトレースIDを受け取っている',
  OBS.browserRequests.every((r) => r.server && /^[0-9a-f]{32}$/.test(r.server.traceId)));
ok('DBオブジェクトの定義を情報スキーマから取得している',
  OBS.dbObjects.tables.length > 0 && OBS.dbObjects.columns.length > 0);
ok('SQL の構文解析に成功している', OBS.sqlAnalyses.every((a) => a.parseOk));
eq('経路のノードが構成できている', measured.nodes.length > 0, true);
ok('通信・サーバー処理・実行SQL・テーブル・カラムが揃っている',
  ['http', 'server', 'sql', 'table', 'column'].every((k) => measured.nodes.some((n) => n.kind === k)),
  measured.nodes.map((n) => n.kind));

/* ------------------------------------------ 2. 時刻と親子関係を正しく扱う */
console.log('\n2. 時刻と親子関係');
const byId = new Map(OBS.spans.map((s) => [s.spanId, s]));
const handler = OBS.spans.find((s) => s.attrs['next.span_type'] === 'AppRouteRouteHandlers.runHandler');
ok('ルートハンドラのスパンがある', !!handler);
const sqlSpans = OBS.spans.filter((s) => OBS.sqlAnalyses.some((a) => a.spanId === s.spanId));
const reaches = (s, targetId) => {
  let cur = s;
  for (let i = 0; i < 64 && cur?.parentSpanId; i++) {
    cur = byId.get(cur.parentSpanId);
    if (!cur) return false;
    if (cur.spanId === targetId) return true;
  }
  return false;
};
ok('SQLスパンはハンドラスパンの子孫である（L1 として成立）',
  sqlSpans.length > 0 && sqlSpans.every((s) => reaches(s, handler.spanId)));
ok('同一トレース内である', OBS.spans.every((s) => s.traceId === OBS.spans[0].traceId));
ok('どのスパンも 開始 ≤ 終了', OBS.spans.every((s) => s.startMs <= s.endMs));

/*
 * 時計の粒度についての実測。
 * Next.js 内蔵のトレーサは、スパンの**開始時刻をミリ秒単位に丸めて**出す。
 * 一方 Prisma と OpenTelemetry の HTTP 計装はミリ秒未満まで持つ。
 * そのため「親の区間が子の区間を含む」は、計装をまたぐと成立しないことがある。
 * これは取りこぼしではなく時計の粒度であり、
 * **親子は時刻ではなく spanId で決める**という設計判断の根拠になる。
 */
const nextSpans = OBS.spans.filter((x) => x.scope === 'next.js');
ok('Next.js のスパンの開始時刻はミリ秒単位に丸められている（実測）',
  nextSpans.length > 0 && nextSpans.every((x) => Math.abs(x.startMs - Math.round(x.startMs)) < 1e-6),
  nextSpans.slice(0, 3).map((x) => x.startMs));
ok('同じ計装の中では、親の区間が子の区間を含む',
  OBS.spans.filter((x) => x.parentSpanId && byId.get(x.parentSpanId)
    && byId.get(x.parentSpanId).scope === x.scope).every((x) => {
    const p = byId.get(x.parentSpanId);
    return p.startMs <= x.startMs + 1 && x.endMs <= p.endMs + 1;
  }));
ok('親子の判定に時刻を使っていない（source が time-window になっていない）',
  measuredSources().every((src) => src !== 'time-window'), measuredSources());

const n = (k) => measured.nodes.filter((x) => x.kind === k);
ok('スパンに対応するノードは時間窓を持つ（05c 7章）',
  ['http', 'server', 'sql'].every((k) => n(k).every((x) => x.span
    && typeof x.span.startMs === 'number' && typeof x.span.endMs === 'number')));
ok('定義であってスパンでないノードは時間窓を持たない',
  ['table', 'column'].every((k) => n(k).every((x) => x.span === undefined)));
const http = n('http')[0];
const server = n('server')[0];
/* 上の実測のとおり Next.js のスパンは 1ms 刻みなので、計装をまたぐ比較には
 * その分の許容を置く。許容の根拠は丸めの粒度であって、都合ではない。 */
const MS_GRANULARITY = 1.0;
ok('サーバー処理の区間は通信の区間に収まる',
  server.span.startMs >= http.span.startMs - MS_GRANULARITY
  && server.span.endMs <= http.span.endMs + MS_GRANULARITY,
  [http.span, server.span]);
ok('SQL の区間はサーバー処理の区間に収まる（丸めの粒度ぶんを許容）',
  n('sql').every((s) => s.span.startMs >= server.span.startMs - MS_GRANULARITY
    && s.span.endMs <= server.span.endMs + MS_GRANULARITY),
  [server.span, ...n('sql').map((s) => s.span)]);
ok('時間窓はページ読み込みを 0 とした相対値である', http.span.startMs >= 0, http.span.startMs);
const order = derive.spanOrder(measured);
ok('スパンを開始時刻順に並べられる',
  order.every((x, i) => i === 0 || order[i - 1].span.startMs <= x.span.startMs),
  order.map((x) => x.span.startMs));

/* --------------------------------------------- 3. 実測と推定を区別している */
console.log('\n3. 実測と推定の区別');
const all = [...measured.nodes, ...measured.hops, ...synthetic.nodes, ...synthetic.hops];
ok('観測性はすべて取得手段から導出されている（手で書けない）',
  all.every((e) => e.observability === model.observabilityOf(e.source)));
ok('L0 / L1 / L1相当 の取得手段は実測になる',
  ['dom-read', 'browser-network', 'db-introspection', 'trace-span', 'trace-context',
    'orm-instrumentation', 'element-anchor', 'sql-ast-parse']
    .every((s) => model.observabilityOf(s) === 'measured'));
ok('L2 / L3 の取得手段は推定にしかならない',
  ['static-analysis', 'orm-schema-map', 'structural-match', 'value-match', 'time-window',
    'schematic', 'none'].every((s) => model.observabilityOf(s) === 'estimated'));
ok('構造的に L2 から上がれない関係は、実測にならない（02a 3.5.1）',
  ['static-analysis', 'orm-schema-map'].every((s) => model.observabilityOf(s) !== 'measured'));
ok('取得手段はすべて 02d 1.3節の語彙である',
  all.every((e) => e.source in model.SOURCE_LEVEL), all.map((e) => e.source));
ok('合成データ側では推定が2か所ある（従来どおり）',
  derive.summarize(synthetic).estimated === 2, derive.summarize(synthetic).estimated);
ok('実測データの経路に推定は混ざっていない',
  measured.nodes.concat(measured.hops).every((e) => e.observability === 'measured'));

/* ------------------------------------------- 4. 未取得の情報を捏造しない */
console.log('\n4. 未取得の情報を捏造しない');
ok('取得できなかった行数を数値で埋めていない',
  n('sql').every((s) => s.metrics?.rows === undefined));
ok('観測していない「表示された値」のノードを作っていない',
  !measured.nodes.some((x) => x.kind === 'value'));
ok('観測していない「コンポーネント」のノードを作っていない',
  !measured.nodes.some((x) => x.kind === 'component'));
ok('観測していない renders / derives / maps のホップを作っていない',
  !measured.hops.some((h) => ['renders', 'derives', 'maps'].includes(h.relation)),
  measured.hops.map((h) => h.relation));
ok('上流を省略せず、切断として表現している（OBS-05）',
  measured.cuts.length === 1 && measured.cuts[0].from === http.id);
ok('観測していないものを理由つきで列挙している',
  measured.provenance.notObserved.length > 0, measured.provenance.notObserved.length);
ok('解決できなかった射影はノードにしていない',
  OBS.sqlAnalyses.every((a) => a.unresolved.every((u) =>
    !measured.nodes.some((x) => x.kind === 'column' && x.chipSub === u.column))));
ok('カラムのノードは情報スキーマに実在する列だけである',
  n('column').every((c) => OBS.dbObjects.columns.some((d) => d.column === c.chipSub)));
ok('変換で作らなかったものは記録されている（配列として存在する）',
  Array.isArray(trace.MEASURED.skipped));
ok('テーブル → カラム の辺を作っていない（02a 3.5節）',
  !measured.hops.some((h) => {
    const from = measured.nodes.find((x) => x.id === h.from);
    const to = measured.nodes.find((x) => x.id === h.to);
    return from?.kind === 'table' && to?.kind === 'column';
  }));
ok('projects の始点は必ず実行SQLである',
  measured.hops.filter((h) => h.relation === 'projects')
    .every((h) => measured.nodes.find((x) => x.id === h.from)?.kind === 'sql'));
ok('変換結果はステップバッジを持たない（揮発値である）',
  all.every((e) => !('badge' in e) && !('step' in e)));

/* ------------------------------------------------- 5. 機密値を収集しない */
console.log('\n5. 収集禁止項目');
const dump = JSON.stringify(OBS) + JSON.stringify(measured);
const FORBIDDEN = [
  [/postgres(ql)?:\/\//i, '接続文字列'],
  [/poc01_local_only/, 'DBのパスワード'],
  [/"[^"]*cookie[^"]*"\s*:/i, 'Cookie'],
  [/\bauthorization\b/i, 'Authorizationヘッダ'],
  [/\bbearer\s/i, 'アクセストークン'],
  [/"password"/i, 'パスワード'],
  [/db\.connection_string"\s*:/i, '接続文字列の属性'],
  [/\bdb\.user"\s*:/i, 'DBユーザー'],
];
for (const [re, label] of FORBIDDEN) ok(`${label} を含まない`, !re.test(dump));
ok('SQL 文に文字列リテラルが残っていない',
  OBS.sqlAnalyses.every((a) => !/'(?:[^']|'')*'/.test(a.sql)), OBS.sqlAnalyses.map((a) => a.sql));
ok('SQL のパラメータ値を除去した記録がある',
  OBS.sqlAnalyses.every((a) => a.redacted !== null));
ok('値を読まずに捨てた属性キーが記録されている',
  OBS.meta.droppedAttributeKeys.length > 0, OBS.meta.droppedAttributeKeys.length);
ok('捨てた属性に接続文字列が含まれている（＝落としている）',
  OBS.spans.some((s) => s.droppedAttributeKeys.includes('db.connection_string'))
  || OBS.meta.droppedAttributeKeys.includes('db.connection_string')
  || !OBS.spans.some((s) => 'db.connection_string' in s.attrs));
ok('リクエスト／レスポンスの本文を持つ場所が無い',
  !/"(request|response)Body"/.test(dump));
ok('DBから返った行データを持っていない', !/"rows"\s*:\s*\[/.test(dump));

console.log(`\n${fails.length === 0 ? '✓ すべて通過' : '✗ 失敗あり'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
