/* =============================================================================
 * Phase 6F — SQL 射影解析の修正が既存の観測結果にどう影響するかを**固定する**。
 *   node tests/sqlimpact.spec.mjs
 *
 * 報告書に書いた影響の内容を、文章ではなくテストで押さえる。
 * **既存の記録は読むだけである。書き換えない。**
 *
 * いちばん大事な不変条件:
 *   既存のデータセットが **いま画面に出しているカラム**は、修正後も1つも
 *   消えてはならない。消えるなら、それは修正ではなく退行である。
 * ========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSql } from '../poc/runner/lib/sqlparse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const require_ = createRequire(import.meta.url);

const adapter = require_('../.libjs/lib/adapter.js');
const layoutMod = require_('../.libjs/lib/layout.js');
const derive = require_('../.libjs/lib/derive.js');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);

const DATASETS = [
  { key: 'measured', poc: 'PoC-01', mod: '../.libjs/data/observation.measured.js', name: 'OBSERVATION', build: 'fromObservation' },
  { key: 'elements', poc: 'PoC-03', mod: '../.libjs/data/observation.poc03.js', name: 'ELEMENT_OBSERVATION', build: 'fromObservation' },
  { key: 'flows', poc: 'PoC-05', mod: '../.libjs/data/observation.poc05.js', name: 'FLOW_OBSERVATION', build: 'fromObservation' },
  { key: 'rsc', poc: 'PoC-02', mod: '../.libjs/data/observation.poc02.js', name: 'RSC_OBSERVATION', build: 'fromRscObservation' },
  { key: 'rsc-svc', poc: 'PoC-02(Gate A)', mod: '../.libjs/data/observation.poc02.js', name: 'RSC_SVC_OBSERVATION', build: 'fromRscObservation' },
  { key: 'lin-a', poc: 'PoC-04 A', mod: '../.libjs/data/observation.poc04.js', name: 'LIN_A_OBSERVATION', build: 'fromRscObservation' },
  { key: 'lin-c', poc: 'PoC-04 C', mod: '../.libjs/data/observation.poc04.js', name: 'LIN_C_OBSERVATION', build: 'fromRscObservation' },
  { key: 'lin-g', poc: 'PoC-04 G', mod: '../.libjs/data/observation.poc04.js', name: 'LIN_G_OBSERVATION', build: 'fromRscObservation' },
];

const load = (d) => {
  const obs = require_(d.mod)[d.name];
  if (!obs) throw new Error(`観測結果が無い: ${d.mod}#${d.name}`);
  return obs;
};

/* ------------------------------------------------- 1. 記録したカラムが消えない */
console.log('\n1. いま画面に出ているカラムが、修正後も消えない');

for (const d of DATASETS) {
  const obs = load(d);
  const laid = layoutMod.layout(adapter[d.build](obs).dataset);
  const shown = laid.nodes.filter((n) => n.kind === 'column').map((n) => n.chipSub).sort();

  /* 記録された SQL を新実装に通して得られる結果列（情報スキーマで引けるものだけ） */
  const defs = new Set((obs.dbObjects.columns ?? [])
    .map((c) => `${c.schema}.${c.table}.${c.column}`));
  const after = [...new Set(obs.sqlAnalyses.flatMap((a) => analyzeSql(a.sql).projections
    .filter((p) => defs.has(`${p.schema}.${p.table}.${p.column}`))
    .map((p) => p.column)))].sort();

  ok(`[${d.poc}] 表示カラムが1つも消えない`,
    shown.every((c) => after.includes(c)), { shown, after });
  ok(`[${d.poc}] 表示カラムが勝手に増えない`,
    after.every((c) => shown.includes(c)), { shown, after });
}

/* ------------------------------------------- 2. SQL 文ごとの射影の変化を固定する */
console.log('\n2. 実測された SQL 文ごとの射影（期待値はソースを読んで手で書いた）');

/** 記録に入っている実測 SQL と、その SELECT 句の列（人が読んで書いた期待値） */
const EXPECTED = [
  {
    sql: 'SELECT "poc"."listings"."id", "poc"."listings"."code", "poc"."listings"."region" FROM "poc"."listings" WHERE $0=$0 ORDER BY "poc"."listings"."id" ASC LIMIT $1 OFFSET $2',
    projects: ['poc.listings.code', 'poc.listings.id', 'poc.listings.region'],
    outsideSelect: ['order-by:poc.listings.id'],
  },
  {
    sql: 'SELECT id, code, plan FROM poc.listings ORDER BY id LIMIT $0',
    projects: ['poc.listings.code', 'poc.listings.id', 'poc.listings.plan'],
    outsideSelect: ['order-by:poc.listings.id'],
  },
  {
    sql: 'SELECT code, name FROM poc.regions ORDER BY code LIMIT $0',
    projects: ['poc.regions.code', 'poc.regions.name'],
    outsideSelect: ['order-by:poc.regions.code'],
  },
  {
    sql: 'SELECT id, region FROM poc.listings ORDER BY id LIMIT $0',
    projects: ['poc.listings.id', 'poc.listings.region'],
    outsideSelect: ['order-by:poc.listings.id'],
  },
  {
    sql: 'SELECT id, code, region FROM poc.listings ORDER BY id LIMIT $0',
    projects: ['poc.listings.code', 'poc.listings.id', 'poc.listings.region'],
    outsideSelect: ['order-by:poc.listings.id'],
  },
  {
    /* **ここだけが変わる。** `id` は ORDER BY にしか無く、結果の行には無い */
    sql: 'SELECT code, region FROM poc.listings ORDER BY id LIMIT $0',
    projects: ['poc.listings.code', 'poc.listings.region'],
    outsideSelect: ['order-by:poc.listings.id'],
  },
];

const recorded = new Set();
for (const d of DATASETS) for (const a of load(d).sqlAnalyses) recorded.add(a.sql);

eq('記録されている実測 SQL は6通り', recorded.size, 6);
ok('期待値の表が、記録されている SQL をすべて覆っている',
  [...recorded].every((s) => EXPECTED.some((e) => e.sql === s)),
  [...recorded].filter((s) => !EXPECTED.some((e) => e.sql === s)));

for (const e of EXPECTED) {
  const a = analyzeSql(e.sql);
  const got = a.projections.map((p) => `${p.schema}.${p.table}.${p.column}`).sort();
  const outside = [...new Set(a.references
    .filter((r) => r.resolved && r.role !== 'select')
    .map((r) => `${r.role}:${r.schema}.${r.table}.${r.column}`))].sort();
  const short = e.sql.length > 56 ? `${e.sql.slice(0, 56)}…` : e.sql;
  ok(`射影: ${short}`, JSON.stringify(got) === JSON.stringify([...e.projects].sort()), got);
  ok(`結果列でない参照: ${short}`,
    JSON.stringify(outside) === JSON.stringify([...e.outsideSelect].sort()), outside);
}

/* ---------------------------------------- 3. 旧実装との差が1件だけであること */
console.log('\n3. 旧実装（columnList 由来）との差');

/** 旧実装の凍結コピー。**比較のためだけに置く。変更しないこと** */
const { Parser } = require_(path.join(REPO, 'poc/fixture-app/node_modules/node-sql-parser'));
const legacyParser = new Parser();
function legacyProjections(sql) {
  let r;
  try { r = legacyParser.parse(sql, { database: 'PostgreSQL' }); } catch { return []; }
  const tables = (r.tableList ?? []).map((e) => {
    const [, schema, name] = e.split('::');
    return { schema: schema === 'null' ? null : schema, name };
  }).filter((t) => t.name && t.name !== 'null');
  const out = [];
  for (const entry of r.columnList ?? []) {
    const [, qualifier, column] = entry.split('::');
    const parts = qualifier === 'null' ? [] : qualifier.split('.');
    const c = qualifier === 'null'
      ? { schema: null, table: null, column }
      : parts.length === 2
        ? { schema: parts[0], table: parts[1], column }
        : { schema: null, table: parts[0], column };
    if (c.column === '*' || !c.column) continue;
    if (c.schema && c.table) out.push(`${c.schema}.${c.table}.${c.column}`);
    else if (!c.table && tables.length === 1) out.push(`${tables[0].schema}.${tables[0].name}.${c.column}`);
  }
  return [...new Set(out)].sort();
}

const changed = [];
for (const e of EXPECTED) {
  const before = legacyProjections(e.sql);
  const after = analyzeSql(e.sql).projections
    .map((p) => `${p.schema}.${p.table}.${p.column}`).sort();
  if (JSON.stringify(before) !== JSON.stringify(after)) changed.push({ sql: e.sql, before, after });
}
eq('記録された6通りのうち、射影が変わるのは1通りだけ', changed.length, 1);
ok('変わるのは ORDER BY の列が SELECT 句に無い文である',
  changed[0]?.sql === 'SELECT code, region FROM poc.listings ORDER BY id LIMIT $0',
  changed[0]?.sql);
ok('変化は「余計な列が消える」方向だけである（増えない）',
  changed.every((c) => c.after.every((x) => c.before.includes(x))), changed);
ok('消えるのは poc.listings.id の1件だけ',
  changed[0] && changed[0].before.filter((x) => !changed[0].after.includes(x)).join(',') === 'poc.listings.id',
  changed[0]);

/* --------------------------- 4. PoC-04 の記録は修正後の挙動と既に一致している */
console.log('\n4. PoC-04 G の記録は、修正後の挙動と既に一致している');

const ling = load(DATASETS.find((d) => d.key === 'lin-g'));
const lingSql = ling.sqlAnalyses[0];
eq('記録された射影は2件', lingSql.projections.length, 2);
ok('記録された射影に id が入っていない',
  !lingSql.projections.some((p) => p.column === 'id'), lingSql.projections);
ok('記録は id を referenced-outside-select-list として残している',
  lingSql.unresolved.some((u) => u.column === 'id' && u.why === 'referenced-outside-select-list'),
  lingSql.unresolved);
ok('新実装も同じ2件を射影にする（記録を作り直す必要が無い）',
  JSON.stringify(analyzeSql(lingSql.sql).projections.map((p) => p.column).sort())
    === JSON.stringify(['code', 'region']),
  analyzeSql(lingSql.sql).projections);

/* ------------------------------------- 5. 右詳細パネルの説明が理由ごとに違う */
console.log('\n5. 右詳細パネルの説明（変換で作らなかったもの）');

const lingSkipped = adapter.fromRscObservation(ling).skipped.map((s) => `${s.what} — ${s.why}`);
ok('ORDER BY の列について、ORDER BY だと言えている',
  lingSkipped.some((t) => t.includes('SELECT句の外') && t.includes('結果の行には無い')),
  lingSkipped);
ok('「修飾が一意に決まらず」という別の理由を当てていない',
  !lingSkipped.some((t) => t.includes('修飾が一意に決まらず')), lingSkipped);

for (const d of DATASETS) {
  const sk = adapter[d.build](load(d)).skipped;
  ok(`[${d.poc}] 説明に理由コードが生のまま出ていない`,
    !sk.some((s) => /理由コード:/.test(s.why)), sk);
}

/* ----------------------------- 6. 実測/推定の分類が修正で動いていないこと */
console.log('\n6. 実測・推定の分類');

for (const d of DATASETS) {
  const laid = layoutMod.layout(adapter[d.build](load(d)).dataset);
  const sum = derive.summarize(laid);
  const sqlParsed = [...laid.nodes, ...laid.hops].filter((e) => e.source === 'sql-ast-parse');
  ok(`[${d.poc}] 構文解析由来の要素はすべて実測である`,
    sqlParsed.length > 0 && sqlParsed.every((e) => e.observability === 'measured'),
    sqlParsed.map((e) => e.observability));
  ok(`[${d.poc}] 推定は supplies（PoC-04）のときだけ在る`,
    (sum.estimated > 0) === laid.hops.some((h) => h.relation === 'supplies'),
    { estimated: sum.estimated, hasSupplies: laid.hops.some((h) => h.relation === 'supplies') });
}

if (fails.length) {
  console.log(`\n✗ 失敗 ${fails.length} 件 / 通過 ${pass} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ すべて通過 — ${pass} 件通過 / 0 件失敗`);
