/* =============================================================================
 * Phase 6F — SQL の射影解析の検証。
 *   node tests/sqlparse.spec.mjs
 *
 * 見るのは次の4点である。
 *   1. 射影（`projects`）は **SELECT / RETURNING 句の結果列だけ**である
 *   2. WHERE / JOIN ON / ORDER BY / GROUP BY / HAVING の参照は区別され、
 *      **結果列にされない**（捨てられもしない）
 *   3. 確定できないときに **存在しない結果列を作らない**
 *   4. `selectList()` の契約（PoC-04 が依存している）が保たれている
 *
 * 正例 = その射影が出ること。否定例 = **その射影が出ないこと**。
 * 02a 3.5.1節:  `reads` = SqlStatement → DbTable
 *               `projects` = SqlStatement → DbColumn（SELECT句の列挙）
 * ========================================================================== */
import { analyzeSql, selectList, REF_ROLE } from '../poc/runner/lib/sqlparse.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);
const deep = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);

/** 射影を 'schema.table.column' の並べ替え済み配列にする */
const proj = (sql) => analyzeSql(sql).projections
  .map((p) => `${p.schema}.${p.table}.${p.column}`).sort();
/** ある役割で参照された列 */
const refs = (sql, role) => [...new Set(analyzeSql(sql).references
  .filter((r) => r.role === role)
  .map((r) => (r.resolved ? `${r.schema}.${r.table}.${r.column}` : `?${r.column ?? '*'}`)))].sort();
/** 解決できなかった理由コード */
const whys = (sql) => [...new Set(analyzeSql(sql).unresolved.map((u) => u.why))].sort();

/* ========================================================================== */
console.log('\n1. 正例 — SELECT 句の結果列が射影になる');

deep('単純な列の列挙',
  proj('SELECT id, code FROM poc.listings'),
  ['poc.listings.code', 'poc.listings.id']);

deep('スキーマ・テーブルで修飾された列（PoC-01 が実測した形）',
  proj('SELECT "poc"."listings"."id", "poc"."listings"."code", "poc"."listings"."region"'
    + ' FROM "poc"."listings" WHERE $0=$0 ORDER BY "poc"."listings"."id" ASC LIMIT $1 OFFSET $2'),
  ['poc.listings.code', 'poc.listings.id', 'poc.listings.region']);

deep('別名（AS）があっても由来の列が射影になる',
  proj('SELECT code AS c FROM poc.listings'),
  ['poc.listings.code']);

deep('テーブル結合でも、SELECT 句の列だけが射影になる',
  proj('SELECT l.code AS c, r.name FROM poc.listings l'
    + ' JOIN poc.regions r ON l.region = r.code WHERE l.plan = $1'),
  ['poc.listings.code', 'poc.regions.name']);

deep('RETURNING 句のある UPDATE は、その列が結果列になる',
  proj('UPDATE poc.listings SET code = $1 WHERE id = $2 RETURNING id, code'),
  ['poc.listings.code', 'poc.listings.id']);

deep('同じ列を2つの別名で取っても、カラムは1つにまとまる',
  proj('SELECT code AS a, code AS b FROM poc.listings'),
  ['poc.listings.code']);

deep('集合演算（UNION）は、どちらの枝の結果列も射影になる',
  proj('SELECT id FROM poc.listings UNION SELECT id FROM poc.regions'),
  ['poc.listings.id', 'poc.regions.id']);
eq('集合演算であることを記録している',
  analyzeSql('SELECT id FROM poc.listings UNION SELECT id FROM poc.regions').setOperation, true);

deep('FROM 句のテーブルは `reads` の材料として取れている',
  analyzeSql('SELECT l.code FROM poc.listings l JOIN poc.regions r ON l.region = r.code')
    .tables.map((t) => `${t.schema}.${t.name}`).sort(),
  ['poc.listings', 'poc.regions']);

/* ========================================================================== */
console.log('\n2. 否定例 — 結果列でない参照を射影にしない');

const ORDER_ONLY = 'SELECT code, region FROM poc.listings ORDER BY id LIMIT $0';
deep('ORDER BY だけに現れる列は射影にならない（06e 5.3節 #1 の不具合）',
  proj(ORDER_ONLY), ['poc.listings.code', 'poc.listings.region']);
ok('ORDER BY の列を捨てずに役割つきで残している',
  refs(ORDER_ONLY, REF_ROLE.orderBy).includes('poc.listings.id'),
  refs(ORDER_ONLY, REF_ROLE.orderBy));
ok('ORDER BY の列は SELECT の役割では現れない',
  !refs(ORDER_ONLY, REF_ROLE.select).includes('poc.listings.id'),
  refs(ORDER_ONLY, REF_ROLE.select));

const WHERE_ONLY = 'SELECT code FROM poc.listings WHERE plan = $1';
deep('WHERE だけに現れる列は射影にならない', proj(WHERE_ONLY), ['poc.listings.code']);
deep('WHERE の参照は where の役割で残る', refs(WHERE_ONLY, REF_ROLE.where), ['poc.listings.plan']);

const JOIN_ONLY = 'SELECT l.code FROM poc.listings l JOIN poc.regions r ON l.region = r.code';
deep('JOIN 条件だけに現れる列は射影にならない', proj(JOIN_ONLY), ['poc.listings.code']);
deep('JOIN 条件の参照は join の役割で残る',
  refs(JOIN_ONLY, REF_ROLE.join), ['poc.listings.region', 'poc.regions.code']);

const GROUP_ONLY = 'SELECT code FROM poc.listings GROUP BY code, plan HAVING count(*) > 1';
deep('GROUP BY だけに現れる列は射影にならない', proj(GROUP_ONLY), ['poc.listings.code']);
ok('GROUP BY の参照は group-by の役割で残る',
  refs(GROUP_ONLY, REF_ROLE.groupBy).includes('poc.listings.plan'),
  refs(GROUP_ONLY, REF_ROLE.groupBy));

const HAVING_ONLY = 'SELECT code FROM poc.listings GROUP BY code HAVING max(plan) > $1';
deep('HAVING だけに現れる列は射影にならない', proj(HAVING_ONLY), ['poc.listings.code']);
deep('HAVING の参照は having の役割で残る',
  refs(HAVING_ONLY, REF_ROLE.having), ['poc.listings.plan']);

/* ========================================================================== */
console.log('\n3. 否定例 — 存在しない結果列を作らない');

for (const [name, sql] of [
  ['SELECT *', 'SELECT * FROM poc.listings'],
  ['別名つきの t.*', 'SELECT l.* FROM poc.listings l'],
  ['スキーマつきの t.*', 'SELECT "poc"."listings".* FROM "poc"."listings"'],
]) {
  const a = analyzeSql(sql);
  deep(`${name}: 射影を作らない`, a.projections, []);
  eq(`${name}: selectStar を立てる`, a.selectStar, true);
  ok(`${name}: '(.*)' のような列名を作らない`,
    !JSON.stringify(a).includes('(.*)'), a.projections);
  ok(`${name}: 理由を select-star として残す`, whys(sql).includes('select-star'), whys(sql));
}

deep('集計関数（別名あり）は1つの列に帰属しない',
  proj('SELECT count(*) AS n FROM poc.listings'), []);
deep('集計関数（別名あり）の理由',
  whys('SELECT count(*) AS n FROM poc.listings'), ['aggregate-or-expression']);
deep('集計の入力列は select-expr の役割で残る（結果列にはしない）',
  refs('SELECT max(id) AS m FROM poc.listings', REF_ROLE.selectExpr), ['poc.listings.id']);
deep('集計の入力列を射影にしない',
  proj('SELECT max(id) AS m FROM poc.listings'), []);
deep('連結式は1つの列に帰属しない',
  proj('SELECT code || region AS both FROM poc.listings'), []);
deep('型変換も1つの列に帰属しない（安全側。06e 11.3節 #4）',
  proj('SELECT code::text AS c FROM poc.listings'), []);
deep('CASE 式も1つの列に帰属しない',
  proj('SELECT CASE WHEN plan = $1 THEN code ELSE region END AS c FROM poc.listings'), []);

deep('RETURNING の無い UPDATE には結果列が無い',
  proj('UPDATE poc.listings SET code = $1 WHERE id = $2'), []);
eq('RETURNING の無い UPDATE の文の種別を記録している',
  analyzeSql('UPDATE poc.listings SET code = $1 WHERE id = $2').statementType, 'update');
deep('RETURNING の無い INSERT には結果列が無い',
  proj('INSERT INTO poc.listings (code) VALUES ($1)'), []);
deep('INSERT の書き込み先列は insert-target の役割に入る（結果列ではない）',
  analyzeSql('INSERT INTO poc.listings (code) VALUES ($1)').references
    .filter((r) => r.role === REF_ROLE.insertTarget).map((r) => r.column),
  ['code']);

const SUB_IN_WHERE = 'SELECT code FROM poc.listings WHERE id IN (SELECT id FROM poc.regions)';
deep('WHERE の副問い合わせの列は外側の結果列にならない',
  proj(SUB_IN_WHERE), ['poc.listings.code']);
ok('副問い合わせの列は役割を落として残る',
  analyzeSql(SUB_IN_WHERE).references.some((r) => r.role === 'nested-select' && r.column === 'id'),
  analyzeSql(SUB_IN_WHERE).references.map((r) => `${r.role}:${r.column}`));

deep('SELECT 句のスカラ副問い合わせは1つの列に帰属しない',
  proj('SELECT (SELECT max(id) FROM poc.regions) AS m FROM poc.listings'), []);

const DERIVED = 'SELECT id FROM (SELECT id, code FROM poc.listings) t WHERE t.id > 1';
deep('派生表（FROM の副問い合わせ）の出力は元の列まで決めない',
  proj(DERIVED), []);
deep('派生表の理由を取り違えない', whys(DERIVED), ['derived-table-qualifier']);

const CTE = 'WITH q AS (SELECT id, code FROM poc.listings) SELECT id FROM q';
deep('CTE の出力も元の列まで決めない', proj(CTE), []);
deep('CTE の理由を取り違えない', whys(CTE), ['derived-table-qualifier']);

deep('自己結合では、修飾を省いた列はどちらの別名のものか決めない',
  proj('SELECT code FROM poc.listings a JOIN poc.listings b ON a.id = b.id'), []);
deep('自己結合の理由', whys('SELECT code FROM poc.listings a JOIN poc.listings b ON a.id = b.id'),
  ['ambiguous-qualifier']);

deep('FROM 句に無い修飾は解決しない',
  proj('SELECT x.code FROM poc.listings l'), []);
deep('FROM 句に無い修飾の理由', whys('SELECT x.code FROM poc.listings l'), ['unknown-qualifier']);

deep('スキーマが書かれていない表の列は、定義を一意に指さない',
  proj('SELECT code FROM listings'), []);
deep('スキーマが決まらない理由', whys('SELECT code FROM listings'), ['schema-not-determined']);

/* ========================================================================== */
console.log('\n4. 構文解析できなかったものは「できなかった」と返す');

const BAD = analyzeSql('SELCT this is not sql');
eq('parseOk が false', BAD.parseOk, false);
ok('理由の文言がある', typeof BAD.error === 'string' && BAD.error.length > 0, BAD.error);
deep('射影を作らない', BAD.projections, []);
deep('テーブルも作らない', BAD.tables, []);
eq('selectStar を立てない（「*だった」と言わない）', BAD.selectStar, false);

/* ========================================================================== */
console.log('\n5. selectList() の契約（PoC-04 が依存している）');

const sl = selectList('SELECT id, code AS c, count(*) AS n, max(id) FROM poc.listings ORDER BY id');
eq('ok である', sl.ok, true);
eq('star は立たない', sl.star, false);
deep('鍵は別名のほう、由来の列は別名の下にある',
  sl.items.map((i) => `${i.key}=${i.column ?? '-'}`),
  ['id=id', 'c=code', 'n=-']);
ok('ORDER BY の列は項目に入らない', !sl.items.some((i) => i.key === 'id' && i.column !== 'id'),
  sl.items);
ok('別名の無い集計は鍵にならない（行オブジェクトの鍵が決まらない）',
  sl.items.length === 3, sl.items);
ok('解決できた項目は resolved を持つ',
  sl.items[0].resolved && sl.items[0].resolved.table === 'listings', sl.items[0]);

const slStar = selectList('SELECT * FROM poc.listings');
eq('SELECT * では star が立つ', slStar.star, true);
deep('SELECT * では項目を作らない', slStar.items, []);

const slBad = selectList('SELCT nope');
eq('構文解析できなければ ok が false', slBad.ok, false);
deep('構文解析できなければ項目を作らない', slBad.items, []);

/* ========================================================================== */
console.log('\n6. 射影と参照の不変条件');

const ALL = [
  'SELECT id, code FROM poc.listings ORDER BY id',
  'SELECT code, region FROM poc.listings ORDER BY id LIMIT $0',
  'SELECT l.code AS c, r.name FROM poc.listings l JOIN poc.regions r ON l.region = r.code'
    + ' WHERE l.plan = $1 GROUP BY l.code, r.name HAVING count(*) > 1 ORDER BY r.name',
  'SELECT * FROM poc.listings',
  'UPDATE poc.listings SET code = $1 WHERE id = $2',
  'SELECT count(*) AS n FROM poc.listings',
  'WITH q AS (SELECT id FROM poc.listings) SELECT id FROM q',
];
ok('射影はすべて schema・table・column が揃っている',
  ALL.every((s) => analyzeSql(s).projections.every((p) => p.schema && p.table && p.column)));
ok('射影に `*` やパターン文字が混ざらない',
  ALL.every((s) => analyzeSql(s).projections.every((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.column))),
  ALL.map((s) => analyzeSql(s).projections.map((p) => p.column)));
ok('射影に重複が無い',
  ALL.every((s) => {
    const k = analyzeSql(s).projections.map((p) => `${p.schema}.${p.table}.${p.column}`);
    return new Set(k).size === k.length;
  }));
ok('射影は必ず select の役割の参照として現れている（別経路で足していない）',
  ALL.every((s) => {
    const a = analyzeSql(s);
    const sel = new Set(a.references.filter((r) => r.role === REF_ROLE.select && r.resolved)
      .map((r) => `${r.schema}.${r.table}.${r.column}`));
    return a.projections.every((p) => sel.has(`${p.schema}.${p.table}.${p.column}`));
  }));
ok('結果列を1つも解決できないときは projections が空である（部分的に作らない）',
  analyzeSql('SELECT * FROM poc.listings').projections.length === 0);
ok('文の種別を必ず返す', ALL.every((s) => typeof analyzeSql(s).statementType === 'string'));

/* ========================================================================== */
if (fails.length) {
  console.log(`\n✗ 失敗 ${fails.length} 件 / 通過 ${pass} 件`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ すべて通過 — ${pass} 件通過 / 0 件失敗`);
