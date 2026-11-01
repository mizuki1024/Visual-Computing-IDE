/* =============================================================================
 * M1 — 関係モデルの契約の検証。
 *   node tests/model.spec.mjs
 *
 * 見るのは次の7点である（指示 第2節 A〜H / 第5節の完了条件）。
 *   1. 関係種別と取得手段の定義が一貫していること（表が1つしか無いこと）
 *   2. 既存の8データセット＋合成が、その契約に**適合**していること
 *   3. 契約を破ったデータを、検査が**実際に検出**できること（否定例）
 *   4. 通信の観測位置（ブラウザ／サーバー内部）がモデルで区別されていること
 *   5. 同じノードへの流入が、データの合流として表されていないこと
 *   6. 描画インスタンスを同定したと読める表示をしていないこと
 *   7. 実測と推定の分類が維持されていること
 *
 * 否定例の節が本体である。検査が何も検出できないなら、契約は飾りである。
 * ========================================================================== */
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const trace = require_('../.libjs/lib/trace.js');
const model = require_('../.libjs/lib/model.js');
const obsPoc02 = require_('../.libjs/data/observation.poc02.js');
const obsPoc04 = require_('../.libjs/data/observation.poc04.js');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);
const deep = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);

const NAMES = ['explore', 'measured', 'elements', 'flows', 'rsc', 'rsc-svc', 'lin-a', 'lin-c', 'lin-g'];
const DS = Object.fromEntries(NAMES.map((n) => [n, trace.buildDataset(n)]));
const S = model.RELATION_SPEC;

/** データセットを壊して検査にかける。**元のデータは書き換えない。** */
const broken = (name, mutate) => {
  const src = DS[name];
  const copy = {
    origin: src.origin,
    nodes: src.nodes.map((n) => ({ ...n })),
    hops: src.hops.map((h) => ({ ...h })),
  };
  mutate(copy);
  return model.validateDataset(copy);
};
const hopOf = (ds, rel) => ds.hops.find((h) => h.relation === rel);

/* ========================================================================== */
console.log('\n1. 関係種別の表（02a 3.5.1 の実体）');

deep('関係種別は12件の閉じた集合である',
  Object.keys(S).sort(),
  ['binds', 'derives', 'executes', 'handles', 'invokes', 'maps', 'projects',
    'queries', 'reads', 'renders', 'requests', 'supplies']);

ok('すべての関係が、どこで決まったかを書いている',
  Object.values(S).every((r) => typeof r.spec === 'string' && r.spec.length > 0));

ok('すべての関係が、認める取得手段を1つ以上持つ',
  Object.values(S).every((r) => r.sources.length > 0));

ok('認める取得手段は、すべて 02d 1.3節の表に在る識別子である',
  Object.values(S).every((r) => r.sources.every((s) => s in model.SOURCE_LEVEL)));

/* --- A. queries ------------------------------------------------------------ */
eq('queries: 始点は取得位置であって、コンポーネント定義ではない', S.queries.from, 'DataAccessSite');
deep('queries: 終点は実行SQLである', S.queries.to, ['SqlStatement']);
deep('queries: 取得手段はサーバー側の呼び出しスタックだけ', S.queries.sources, ['server-call-stack']);
eq('queries: 既定レベルは L1相当', S.queries.defaultLevel, 'L1-equivalent');
eq('queries: 帰属はソース位置まで（描画インスタンスではない）',
  S.queries.attribution, 'source-location');
ok('queries と executes は始点の型が違う（重複した関係ではない）',
  S.queries.from !== S.executes.from, [S.queries.from, S.executes.from]);
ok('queries の始点はソース位置で同定される端点である',
  model.SITE_IDENTIFIED.includes(S.queries.from));

/* --- B. supplies ----------------------------------------------------------- */
ok('supplies: ComponentDef → ComponentDef として正式化していない',
  !(S.supplies.from === 'ComponentDef' && S.supplies.to.includes('ComponentDef')),
  [S.supplies.from, S.supplies.to]);
eq('supplies: データの供給方向の始点は取得位置', S.supplies.from, 'DataAccessSite');
deep('supplies: データの供給方向の終点は props 束縛位置', S.supplies.to, ['PropBindingSite']);
ok('supplies: 両端がソース位置で同定される端点である',
  model.SITE_IDENTIFIED.includes(S.supplies.from)
  && S.supplies.to.every((t) => model.SITE_IDENTIFIED.includes(t)));
eq('supplies: 構造的に推定（実測にならない）', S.supplies.ceiling, 'estimated');
eq('supplies のホップは、探索の向き（描画位置 → 取得位置）に描かれている',
  hopOf(DS['lin-a'], 'supplies').orientation, 'against-data');
deep('supplies のホップは両端のソース位置を持つ（PoC-04 ケースA）',
  (() => {
    const e = hopOf(DS['lin-a'], 'supplies').endpoints;
    return [e.from.type, `${e.from.file}:${e.from.line}:${e.from.col}`,
      e.to.type, `${e.to.file}:${e.to.line}`];
  })(),
  ['PropBindingSite', 'src/app/lin-a/page.tsx:18:54',
    'DataAccessSite', 'src/app/lin-a/page.tsx:12']);
ok('supplies の2つの端点は、同じ行ではない（描画位置と取得位置は別の場所である）',
  (() => {
    const e = hopOf(DS['lin-a'], 'supplies').endpoints;
    return e.from.line !== e.to.line;
  })());
ok('向きを解くと、ホップの from は props 束縛位置になる',
  model.hopEndpointTypes({ relation: 'supplies', orientation: 'against-data' }).fromType
  === 'PropBindingSite');

/* --- C. requests ----------------------------------------------------------- */
eq('requests: 始点は通信を開始した位置であって、コンポーネント定義ではない',
  S.requests.from, 'DataAccessSite');
deep('requests: 開始元の帰属は呼び出しスタックの2手段だけ',
  [...S.requests.sources].sort(), ['request-initiator', 'server-call-stack']);
ok('requests: ブラウザのネットワーク計測は開始元の帰属に使えない',
  !S.requests.sources.includes('browser-network'));
eq('requests: 既定レベルは L1相当（02a の L0 を改訂）', S.requests.defaultLevel, 'L1-equivalent');
ok('requests の実装は、呼び出しスタックが取れたデータセットにだけ在る',
  ['flows', 'rsc-svc'].every((n) => !!hopOf(DS[n], 'requests'))
  && ['measured', 'elements', 'rsc', 'lin-a', 'lin-c', 'lin-g']
    .every((n) => !hopOf(DS[n], 'requests')));
deep('requests のホップは開始位置のソース位置を持つ（PoC-05）',
  (() => {
    const e = hopOf(DS.flows, 'requests').endpoints.from;
    return [e.type, typeof e.file, typeof e.line];
  })(), ['DataAccessSite', 'string', 'number']);
ok('通信のノード自体は、従来どおりブラウザの計測で作っている（ノードと関係を分けている）',
  DS.flows.nodes.find((n) => n.kind === 'http').source === 'browser-network');

/* --- D. 取得手段は別の軸である -------------------------------------------- */
ok('request-initiator / server-call-stack は取得手段の表に在る',
  'request-initiator' in model.SOURCE_LEVEL && 'server-call-stack' in model.SOURCE_LEVEL);
ok('どちらも関係種別の表には無い（軸が違う）',
  !('request-initiator' in S) && !('server-call-stack' in S));
eq('request-initiator の既定レベルは L1相当', model.SOURCE_LEVEL['request-initiator'], 'L1-equivalent');
eq('server-call-stack の既定レベルは L1相当', model.SOURCE_LEVEL['server-call-stack'], 'L1-equivalent');
ok('1つの取得手段が複数の関係を支えている（server-call-stack は requests と queries）',
  S.requests.sources.includes('server-call-stack') && S.queries.sources.includes('server-call-stack'));

/* --- H. RSC の確度 --------------------------------------------------------- */
ok('較正されていない確度の順序を、モデルが持っていない',
  !('confidence' in S.supplies) && !('pathKindConfidence' in model));

/* ========================================================================== */
console.log('\n2. 既存のデータセットが契約に適合している');

for (const n of NAMES) {
  const v = model.validateDataset(DS[n]);
  deep(`${n}: 契約違反が無い`, v, []);
}

ok('ノード数・ホップ数は M1 の前後で変わっていない（表示を変えていない）',
  JSON.stringify(NAMES.map((n) => [DS[n].nodes.length, DS[n].hops.length]))
  === JSON.stringify([[7, 7], [7, 6], [9, 7], [10, 8], [10, 8], [9, 8], [9, 8], [10, 9], [9, 7]]),
  NAMES.map((n) => [n, DS[n].nodes.length, DS[n].hops.length]));

/* ========================================================================== */
console.log('\n3. 否定例 — 契約を破ったデータを検出できる');

ok('supplies から端点のソース位置を外すと違反になる',
  broken('lin-a', (d) => { delete d.hops.find((h) => h.relation === 'supplies').endpoints; })
    .some((m) => m.includes('endpoints が無い')));

ok('supplies の端点をコンポーネント定義にすり替えると違反になる',
  broken('lin-a', (d) => {
    d.hops.find((h) => h.relation === 'supplies').endpoints = {
      from: { type: 'ComponentDef', file: 'a.tsx', line: 1 },
      to: { type: 'ComponentDef', file: 'a.tsx', line: 2 },
    };
  }).some((m) => m.includes('型が ComponentDef')));

ok('supplies の向きの宣言を外すと、端点の型が合わなくなる',
  broken('lin-a', (d) => { delete d.hops.find((h) => h.relation === 'supplies').orientation; })
    .length > 0);

ok('requests をブラウザのネットワーク計測で作ると違反になる',
  broken('flows', (d) => { d.hops.find((h) => h.relation === 'requests').source = 'browser-network'; })
    .some((m) => m.includes('認められていない')));

ok('queries をスパンの親子だけで作ると違反になる',
  broken('rsc', (d) => { d.hops.find((h) => h.relation === 'queries').source = 'trace-span'; })
    .some((m) => m.includes('認められていない')));

ok('通信のノードから観測位置を外すと違反になる',
  broken('rsc-svc', (d) => { delete d.nodes.find((n) => n.kind === 'http').exchangeScope; })
    .some((m) => m.includes('exchangeScope')));

ok('流入が2本あるノードで、流入の意味の宣言を外すと違反になる',
  broken('rsc', (d) => { delete d.hops.find((h) => h.relation === 'queries').convergence; })
    .some((m) => m.includes('convergence')));

ok('データの合流を宣言すると違反になる（観測手段が無い）',
  broken('rsc', (d) => { d.hops.find((h) => h.relation === 'queries').convergence = 'data-merge'; })
    .some((m) => m.includes('data-merge')));

ok('推定しかありえない関係を実測の取得手段で作ると違反になる',
  broken('lin-a', (d) => {
    const h = d.hops.find((x) => x.relation === 'supplies');
    h.source = 'sql-ast-parse';
    h.observability = 'measured';
  }).some((m) => m.includes('構造的に推定')));

ok('maps をキー構成の照合だけで作ると違反になる（決定 #9）',
  broken('explore', (d) => { d.hops.find((h) => h.relation === 'maps').source = 'structural-match'; })
    .some((m) => m.includes('単独では根拠にならない')));

ok('derives を値の一致だけで作ると違反になる',
  broken('explore', (d) => { d.hops.find((h) => h.relation === 'derives').source = 'value-match'; })
    .length > 0);

ok('未知の関係種別は通らない',
  broken('measured', (d) => { d.hops[0].relation = 'causes'; })
    .some((m) => m.includes('未知の関係種別')));

ok('端点の型が入れ替わっていると違反になる（reads の終点をカラムにする）',
  broken('measured', (d) => {
    const col = d.nodes.find((n) => n.kind === 'column');
    d.hops.find((h) => h.relation === 'reads').to = col.id;
  }).some((m) => m.includes('to は DbTable')));

ok('複数候補なのに候補を持たないと違反になる',
  broken('lin-c', (d) => { delete d.hops.find((h) => h.relation === 'supplies').candidates; })
    .some((m) => m.includes('candidates が無い')));

/* ========================================================================== */
console.log('\n4. 通信の観測位置（02a 3.2 / 決定 E）');

eq('ブラウザの通信は browser として記録されている',
  DS.flows.nodes.find((n) => n.kind === 'http').exchangeScope, 'browser');
eq('RSC の文書取得も browser である',
  DS.rsc.nodes.find((n) => n.kind === 'http').exchangeScope, 'browser');
deep('サーバー内部の通信は server-internal である（ブラウザの記録には無い）',
  DS['rsc-svc'].nodes.filter((n) => n.kind === 'http').map((n) => n.exchangeScope).sort(),
  ['browser', 'server-internal']);
ok('server-internal の通信は、ブラウザのネットワーク記録に存在しない',
  (() => {
    const dest = obsPoc02.RSC_SVC_OBSERVATION.rsc.exchanges[0].destPath;
    return !obsPoc02.RSC_SVC_OBSERVATION.browserRequests.some((r) => r.path === dest);
  })());
eq('server-internal の通信のノードは、その旨を表示している',
  DS['rsc-svc'].nodes.filter((n) => n.exchangeScope === 'server-internal')
    .every((n) => n.overview.some((r) => r.v.includes('ブラウザには現れません'))), true);
ok('観測位置の文言が1か所に定義されている',
  Object.keys(model.EXCHANGE_SCOPE_LABEL).sort().join(',') === 'browser,server-internal');
ok('ブラウザで観測した通信の件数を、サーバー内部の通信で膨らませていない',
  obsPoc02.RSC_SVC_OBSERVATION.rsc.browserApiRequests === 0);

/* ========================================================================== */
console.log('\n5. 同じノードへの流入（02a 3.5.3 / 決定 F）');

const fanIns = [];
for (const n of NAMES) {
  const inc = new Map();
  for (const h of DS[n].hops) inc.set(h.to, [...(inc.get(h.to) ?? []), h]);
  for (const [to, hs] of inc) {
    if (hs.length > 1) {
      fanIns.push({
        ds: n, kind: DS[n].nodes.find((x) => x.id === to).kind,
        rels: hs.map((h) => h.relation).sort(),
        conv: [...new Set(hs.map((h) => h.convergence))],
      });
    }
  }
}

eq('流入が2本以上あるノードは6件ある', fanIns.length, 6);
/* 期待値は 9 データセットのホップを読んで手で書いたものである */
deep('その内訳（データセット／ノード種別／入ってくる関係）',
  fanIns.map((f) => `${f.ds}/${f.kind}/${f.rels.join('+')}`),
  [
    'explore/http/derives+maps',       // 合成: 応答のキーを両側から指している
    'rsc/sql/executes+queries',        // どのスパンの下で走ったか ＋ どのコードが実行したか
    'rsc-svc/http/invokes+requests',   // どのスパンの下で起きたか ＋ どのコードが始めたか
    'lin-a/sql/executes+queries',
    'lin-c/sql/executes+queries',
    'lin-g/sql/executes+queries',
  ]);
ok('流入が2本以上あるのは SQL の⑤と通信のノードだけである（カラム・テーブルには無い）',
  fanIns.every((f) => ['sql', 'http'].includes(f.kind)));
ok('すべての流入が「同じ対象を指している」であり、データの合流ではない',
  fanIns.every((f) => f.conv.length === 1 && f.conv[0] === 'shared-object'), fanIns);
ok('どのデータセットもデータの合流を宣言していない',
  NAMES.every((n) => !DS[n].hops.some((h) => h.convergence === 'data-merge')));
ok('⑤ への流入は、根拠の異なる2本である（取得手段が違う）',
  (() => {
    const hs = DS.rsc.hops.filter((h) => ['executes', 'queries'].includes(h.relation));
    return new Set(hs.map((h) => h.source)).size === 2;
  })());
ok('流入が2本でも、ノードの観測性は取得手段から1つに決まる（合流で変わらない）',
  DS.rsc.nodes.find((n) => n.kind === 'sql').observability === 'measured');

/* ========================================================================== */
console.log('\n6. 描画インスタンス（決定 G）');

ok('インスタンスへの帰属を宣言する関係が無い',
  Object.values(S).every((r) => r.attribution !== 'runtime-instance'));
ok('帰属の粒度は定義かソース位置のどちらかである',
  Object.values(S).every((r) => ['definition', 'source-location'].includes(r.attribution)));
ok('呼び出しスタックで帰属したノードは、帰属の範囲を表示している',
  ['rsc', 'rsc-svc', 'lin-a', 'lin-c', 'lin-g', 'flows'].every((n) => DS[n].nodes
    .filter((x) => x.source === 'server-call-stack' || x.source === 'request-initiator')
    .every((x) => x.overview.some((r) => r.v === model.ATTRIBUTION_SCOPE_NOTE.definitionOnly))));
ok('その文言は「同定していない」と書いている',
  model.ATTRIBUTION_SCOPE_NOTE.definitionOnly.includes('同定していません'));
ok('要素識別子のノードは、1つの JSX が生んだ要素数と「何番目かは未観測」を書いている',
  ['elements', 'flows', 'rsc', 'lin-a'].every((n) => DS[n].nodes
    .filter((x) => x.source === 'element-anchor')
    .every((x) => x.overview.some((r) => r.v.includes(model.ATTRIBUTION_SCOPE_NOTE.instanceUnknown)))));
ok('renders の帰属は定義までである',
  S.renders.attribution === 'definition');
ok('観測した要素識別子のインスタンス数は、記録から読んでいる（固定値ではない）',
  obsPoc04.LIN_A_OBSERVATION.elements.selections
    .every((s) => typeof s.anchorInstanceCount === 'number'));

/* ========================================================================== */
console.log('\n7. 実測と推定の分類が維持されている');

ok('supplies はすべてのデータセットで推定である',
  NAMES.flatMap((n) => DS[n].hops.filter((h) => h.relation === 'supplies'))
    .every((h) => h.observability === 'estimated'));
ok('queries はすべてのデータセットで実測である',
  NAMES.flatMap((n) => DS[n].hops.filter((h) => h.relation === 'queries'))
    .every((h) => h.observability === 'measured'));
ok('requests はすべてのデータセットで実測である',
  NAMES.flatMap((n) => DS[n].hops.filter((h) => h.relation === 'requests'))
    .every((h) => h.observability === 'measured'));
deep('構造的に推定の関係は4つである（02a 3.5.1 の注記）',
  Object.entries(S).filter(([, r]) => r.ceiling === 'estimated').map(([k]) => k).sort(),
  ['binds', 'derives', 'maps', 'supplies']);
ok('構造的に推定の関係に認めた取得手段は、すべて推定の手段である（表と導出が矛盾しない）',
  Object.values(S).filter((r) => r.ceiling === 'estimated')
    .every((r) => r.sources.every((src) => model.observabilityOf(src) === 'estimated')));
ok('実測になりうる関係の取得手段は、すべて実測の手段である',
  Object.values(S).filter((r) => r.ceiling === undefined)
    .every((r) => r.sources.every((src) => model.observabilityOf(src) === 'measured'
      /* handles だけは結合失敗時に時間窓へ降格する（02a 3.5.1 の降格条件） */
      || src === 'time-window')));
ok('推定のホップを持つのは supplies / derives / maps のデータセットだけである',
  NAMES.every((n) => DS[n].hops.filter((h) => h.observability === 'estimated')
    .every((h) => ['supplies', 'derives', 'maps'].includes(h.relation))));

/* ========================================================================== */
console.log(fails.length
  ? `\n✗ ${fails.length} 件失敗 / ${pass} 件通過\n${fails.map((f) => `  - ${f}`).join('\n')}`
  : `\n✓ すべて通過 — ${pass} 件通過 / 0 件失敗`);
process.exit(fails.length ? 1 : 0);
