/* =============================================================================
 * 実測された SQL 文の構文解析（02d の source = sql-ast-parse / L1相当）。
 * 解析できなかったものは「解析できなかった」と返す。推測で埋めない。
 *
 * ---------------------------------------------------------------------------
 * **なぜ node-sql-parser の `columnList` を使わないか**（Phase 6F で修正）
 *
 * `columnList` は「文中のどこかで参照された列」の平らな一覧であり、**句の役割を
 * 区別しない。** `SELECT code FROM t ORDER BY id` では `id` も入る。これを射影と
 * して扱うと、**結果の行に存在しない列をノードとして描いてしまう。**
 *
 * 02a 3.5.1節の定義:
 *   `reads`    `SqlStatement` → `DbTable`    実測SQLの決定的な構文解析
 *   `projects` `SqlStatement` → `DbColumn`   **SELECT句の列挙**
 *
 * `projects` は SELECT 句（および RETURNING 句）に現れた**結果列**だけである。
 * WHERE / JOIN ON / ORDER BY / GROUP BY / HAVING での参照は、
 * **その列を読んではいるが結果列ではない。** よって `projects` にしてはならない。
 * 捨てるのではなく `references` に役割つきで残す（OBS-05: 隠さない）。
 *
 * 判断が付かないものは `unresolved` に理由つきで落とす。
 * **存在しない結果列を作らない**ことを、この関数の不変条件とする。
 * ========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { APP } from './util.mjs';

const require_ = createRequire(path.join(APP, 'package.json'));
const { Parser } = require_('node-sql-parser');
const parser = new Parser();

/* -------------------------------------------------------------------------- */
/* 参照の役割。02a 3.5.1節の関係種別に写せる粒度まで分ける                      */
/* -------------------------------------------------------------------------- */
export const REF_ROLE = {
  /** SELECT 句に結果列として現れた列。**これだけが `projects` になる** */
  select: 'select',
  /** SELECT 句の式・集計・関数の入力。結果列は1つの列に帰属しない */
  selectExpr: 'select-expr',
  where: 'where',
  join: 'join',
  orderBy: 'order-by',
  groupBy: 'group-by',
  having: 'having',
  /** INSERT の書き込み先の列。読み取りでも結果列でもない */
  insertTarget: 'insert-target',
  /** UPDATE の書き込み先の列。同上 */
  updateTarget: 'update-target',
};

/** `projections` にできなかった理由。UI の文言はここから引く（推測で埋めない） */
export const PROJECTION_REASON = {
  'select-star': 'SELECT * のため、実行されたSQLからも結果列を列挙できない',
  'aggregate-or-expression': 'SELECT句のその項目は集計・式・関数であり、1つの列に帰属しない',
  'ambiguous-qualifier': '修飾が書かれておらず、FROM句に表が複数あるため、どの表の列か決まらない',
  'unknown-qualifier': '書かれている修飾に対応する表が FROM 句に無い',
  'derived-table-qualifier': '副問い合わせ・CTE の出力を参照しており、元の表の列まで決まらない',
  'no-table-in-scope': 'FROM 句に表が無く、列の帰属先が決まらない',
  'schema-not-determined': '表は決まったがスキーマが書かれておらず、定義を一意に指せない',
  /* 旧 sqlparse.mjs / PoC-04 の観測結果が持つ理由コード。読めるようにしておく */
  'select-star-or-empty': 'SELECT * のため列を特定できなかった',
  'referenced-outside-select-list': 'SELECT句の外（ORDER BY 等）で参照された列であり、結果列ではない',
};

/* -------------------------------------------------------------------------- */
/* 名前の正規化。node-sql-parser は同じ位置に文字列・`{value}`・`{expr:{value}}` */
/* のどれを置くかが場面によって違う（引用の有無・別名・修飾の深さで変わる）      */
/* -------------------------------------------------------------------------- */
function nameOf(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'string') return x;
  if (typeof x !== 'object') return null;
  if (typeof x.value === 'string') return x.value;
  if (x.expr) return nameOf(x.expr);
  return null;
}

/** 'select::poc::listings' → {schema:'poc', name:'listings', op:'select'} */
function splitTable(entry) {
  const [op, schema, name] = entry.split('::');
  return { schema: schema === 'null' ? null : schema, name, op };
}

/* -------------------------------------------------------------------------- */
/* FROM句の有効範囲。別名・副問い合わせ・CTE を区別して持つ                     */
/*                                                                            */
/* 区別が要る理由: 副問い合わせや CTE を参照している列は、**元の表の列まで**     */
/* 決まらない。別名が付いた表と同じに扱うと、ありえない列を作ってしまう。        */
/* -------------------------------------------------------------------------- */
function buildScope(ast, cteNames) {
  /** 参照に書ける名前（別名があれば別名のみ。SQL は元の表名で参照できない） */
  const byKey = new Map();
  /** 実在の表（情報スキーマで引ける候補） */
  const real = [];
  /** 中身の見えない入力（副問い合わせ・CTE）の数。1つでもあれば修飾の省略は曖昧 */
  let opaque = 0;

  const sources = [
    ...(Array.isArray(ast?.from) ? ast.from : []),
    /* UPDATE / DELETE の対象表。FROM 句に出ないことがある */
    ...(Array.isArray(ast?.table) ? ast.table : []),
  ];
  for (const f of sources) {
    if (!f || typeof f !== 'object') continue;
    const as = nameOf(f.as);
    if (f.expr && f.expr.ast) {            // FROM (SELECT …) x — 派生表
      if (as) byKey.set(as, { kind: 'derived' });
      opaque += 1;
      continue;
    }
    const t = nameOf(f.table);
    if (!t) continue;
    if (cteNames.has(t)) {                 // WITH q AS (…) … FROM q
      byKey.set(as ?? t, { kind: 'cte', name: t });
      opaque += 1;
      continue;
    }
    const entry = { kind: 'table', schema: nameOf(f.db) ?? nameOf(f.schema) ?? null, name: t };
    if (byKey.has(as ?? t)) continue;      // 同じ表を2回（自己結合）。片方だけ入れる
    byKey.set(as ?? t, entry);
    if (!real.some((r) => r.schema === entry.schema && r.name === entry.name)) real.push(entry);
  }
  /* 自己結合（同じ表を別名2つで）では、修飾を省いた列はどちらのものか決まらない。
   * `real` は重複を畳んでいるので、別名の数で曖昧さを判定する */
  const selfJoin = [...byKey.values()].filter((e) => e.kind === 'table').length > real.length;
  return { byKey, real, opaque, selfJoin };
}

/**
 * 1つの列参照を、情報スキーマで引ける `{schema, table, column}` まで解く。
 * **解けないときは解けないと返す。** 推測で埋めない。
 */
function resolveRef(ref, scope) {
  const column = nameOf(ref.column);
  const qTable = nameOf(ref.table);
  const qSchema = nameOf(ref.schema);

  if (qTable) {
    const e = scope.byKey.get(qTable);
    if (!e) return { ok: false, why: 'unknown-qualifier', column };
    if (e.kind !== 'table') return { ok: false, why: 'derived-table-qualifier', column };
    const schema = qSchema ?? e.schema;
    if (!schema) return { ok: false, why: 'schema-not-determined', column };
    return { ok: true, schema, table: e.name, column };
  }
  /* 修飾が書かれていない。**表が1つに決まるときだけ**一意に定まる。
   * これは構文解析による決定であり推測ではない（旧実装と同じ規則） */
  if (scope.real.length === 0) {
    /* 中身の見えない入力しか無い（派生表・CTE だけ）か、そもそも表が無い。
     * **どちらも「元の表の列まで決まらない」であり、曖昧とは理由が違う** */
    return {
      ok: false,
      why: scope.opaque > 0 ? 'derived-table-qualifier' : 'no-table-in-scope',
      column,
    };
  }
  if (scope.real.length !== 1 || scope.opaque > 0 || scope.selfJoin) {
    return { ok: false, why: 'ambiguous-qualifier', column };
  }
  const e = scope.real[0];
  if (!e.schema) return { ok: false, why: 'schema-not-determined', column };
  return { ok: true, schema: e.schema, table: e.name, column, inferredQualifier: true };
}

/* -------------------------------------------------------------------------- */
/* 式の中の列参照を、役割つきで集める。入れ子の問い合わせは別の文として扱う      */
/* -------------------------------------------------------------------------- */
const SKIP_KEYS = new Set(['type', 'operator', 'keyword', 'symbol', 'parentheses', 'collate', 'dataType']);

function walkExpr(n, role, scope, out) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const x of n) walkExpr(x, role, scope, out); return; }
  /* 入れ子の SELECT。**外側の結果列ではない。** 独立した文として解く */
  if (n.ast && typeof n.ast === 'object') { walkStatement(n.ast, out, 'nested'); return; }
  if (n.type === 'column_ref') {
    const column = nameOf(n.column);
    const star = column === '*' || column === null;
    const r = star ? { ok: false, why: 'select-star' } : resolveRef(n, scope);
    out.references.push({
      role,
      column: star ? null : column,
      qualifier: nameOf(n.table) ?? null,
      schema: r.ok ? r.schema : null,
      table: r.ok ? r.table : null,
      resolved: r.ok,
      ...(star ? { star: true } : {}),
      ...(r.ok ? {} : { why: r.why }),
    });
    return;
  }
  for (const k of Object.keys(n)) {
    if (SKIP_KEYS.has(k)) continue;
    walkExpr(n[k], role, scope, out);
  }
}

/**
 * **結果列の一覧**を取り出す。ここが `projects` の定義域である。
 *   SELECT                     → SELECT 句
 *   INSERT / UPDATE / DELETE   → RETURNING 句（無ければ結果列は存在しない）
 */
function resultColumnsOf(ast) {
  if (ast.type === 'select') {
    if (Array.isArray(ast.columns)) return ast.columns;
    /* `columns` が '*' という形で来る版への備え */
    if (ast.columns === '*') return [{ expr: { type: 'column_ref', table: null, column: '*' }, as: null }];
    return [];
  }
  const ret = ast.returning;
  if (ret && Array.isArray(ret.columns)) return ret.columns;
  return [];
}

function walkStatement(ast, out, context) {
  if (!ast || typeof ast !== 'object') return;

  const withList = Array.isArray(ast.with) ? ast.with : [];
  const cteNames = new Set(withList.map((w) => nameOf(w?.name)).filter(Boolean));
  const scope = buildScope(ast, cteNames);

  /* CTE の本体・派生表の本体は、独立した文として解く（外側の結果列ではない） */
  for (const w of withList) walkStatement(w?.stmt, out, 'nested');
  for (const f of (Array.isArray(ast.from) ? ast.from : [])) {
    if (f?.expr?.ast) walkStatement(f.expr.ast, out, 'nested');
  }

  /* ------------------------------------------------------------ 結果列 */
  /* 入れ子の問い合わせの結果列は、**この文の結果列ではない。** 役割を落とす */
  const isTop = context === 'top';
  for (const item of resultColumnsOf(ast)) {
    const e = item && item.expr;
    if (!e || typeof e !== 'object') continue;
    const as = nameOf(item.as);

    if (e.type === 'column_ref') {
      const column = nameOf(e.column);
      if (column === '*' || column === null) {
        /* SELECT * / t.* — 実行されたSQLからも結果列を列挙できない。
         * **ここで列を作ってはならない**（旧実装は `(.*)` という列を作っていた） */
        if (isTop) {
          out.selectStar = true;
          out.selectItems.push({ key: '*', column: null, table: nameOf(e.table), kind: 'star', resolved: null, why: 'select-star' });
          out.unresolved.push({ column: null, why: 'select-star' });
        }
        out.references.push({
          role: isTop ? REF_ROLE.select : 'nested-select',
          column: null, qualifier: nameOf(e.table) ?? null,
          schema: null, table: null, resolved: false, star: true, why: 'select-star',
        });
        continue;
      }
      const r = resolveRef(e, scope);
      out.references.push({
        role: isTop ? REF_ROLE.select : 'nested-select',
        column, qualifier: nameOf(e.table) ?? null,
        schema: r.ok ? r.schema : null, table: r.ok ? r.table : null,
        resolved: r.ok, ...(r.ok ? {} : { why: r.why }),
      });
      if (!isTop) continue;
      out.selectItems.push({
        key: as ?? column, column, table: nameOf(e.table) ?? null, kind: 'column',
        resolved: r.ok ? { schema: r.schema, table: r.table, column } : null,
        ...(r.ok ? {} : { why: r.why }),
      });
      if (r.ok) {
        out.projections.push({
          schema: r.schema, table: r.table, column,
          ...(r.inferredQualifier ? { inferredQualifier: true } : {}),
        });
      } else out.unresolved.push({ column, why: r.why });
      continue;
    }

    /* 集計・式・関数・スカラ副問い合わせ。**1つの列に帰属しない。**
     * 中の列参照は読んではいるが結果列ではないので `select-expr` に落とす */
    if (isTop) {
      out.selectItems.push({
        key: as ?? null, column: null, table: null,
        kind: e.ast ? 'subquery' : (e.type ?? 'expr'),
        resolved: null, why: 'aggregate-or-expression',
      });
      out.unresolved.push({ column: as ?? null, why: 'aggregate-or-expression' });
    }
    walkExpr(e, REF_ROLE.selectExpr, scope, out);
  }

  /* -------------------------------------------- 結果列ではない参照（役割つき） */
  walkExpr(ast.where, REF_ROLE.where, scope, out);
  for (const f of (Array.isArray(ast.from) ? ast.from : [])) walkExpr(f?.on, REF_ROLE.join, scope, out);
  for (const o of (Array.isArray(ast.orderby) ? ast.orderby : [])) {
    walkExpr(o && 'expr' in o ? o.expr : o, REF_ROLE.orderBy, scope, out);
  }
  const groupby = ast.groupby;
  const groupCols = Array.isArray(groupby) ? groupby
    : (groupby && Array.isArray(groupby.columns) ? groupby.columns : []);
  for (const g of groupCols) walkExpr(g && 'expr' in g ? g.expr : g, REF_ROLE.groupBy, scope, out);
  walkExpr(ast.having, REF_ROLE.having, scope, out);

  /* INSERT の書き込み先列（`columns` は結果列ではない）／UPDATE の SET の左辺 */
  if (ast.type === 'insert' && Array.isArray(ast.columns)) {
    for (const c of ast.columns) {
      const column = nameOf(c);
      if (column) out.references.push({ role: REF_ROLE.insertTarget, column, qualifier: null, schema: null, table: null, resolved: false, why: 'write-target' });
    }
  }
  if (ast.type === 'update' && Array.isArray(ast.set)) {
    for (const s of ast.set) {
      const column = nameOf(s?.column);
      if (column) out.references.push({ role: REF_ROLE.updateTarget, column, qualifier: nameOf(s?.table) ?? null, schema: null, table: null, resolved: false, why: 'write-target' });
      walkExpr(s?.value, REF_ROLE.updateTarget, scope, out);
    }
  }

  /* 集合演算（UNION 等）。**各枝がそれぞれ結果列を持つ。** 同じ役割で続ける */
  if (ast._next) {
    out.setOperation = true;
    walkStatement(ast._next, out, context);
  }
}

/**
 * 実測された SQL 1文を解析する。
 *
 * @returns {{
 *   parseOk: boolean, error: string|null,
 *   statementType: string,
 *   tables: {schema: string|null, name: string, op: string}[],
 *   projections: {schema: string, table: string, column: string, inferredQualifier?: boolean}[],
 *   selectItems: {key: string|null, column: string|null, table: string|null, kind: string,
 *                 resolved: {schema: string, table: string, column: string}|null, why?: string}[],
 *   references: {role: string, column: string|null, qualifier: string|null,
 *                schema: string|null, table: string|null, resolved: boolean,
 *                star?: boolean, why?: string}[],
 *   unresolved: {column: string|null, why: string}[],
 *   selectStar: boolean, setOperation: boolean,
 * }}
 *   `projections` は **SELECT / RETURNING 句の結果列のうち、情報スキーマで引ける
 *   `{schema, table, column}` まで解けたものだけ**である（02a `projects`）。
 *   `references` は結果列でない参照を役割つきで保持する（捨てない）。
 */
export function analyzeSql(sql) {
  let r;
  try {
    r = parser.parse(sql, { database: 'PostgreSQL' });
  } catch (e) {
    return {
      parseOk: false, error: String(e && e.message).slice(0, 200),
      statementType: 'unknown',
      tables: [], projections: [], selectItems: [], references: [],
      unresolved: [], selectStar: false, setOperation: false,
    };
  }
  const tables = (r.tableList ?? []).map(splitTable)
    .filter((t) => t.name && t.name !== 'null');

  const out = {
    projections: [], selectItems: [], references: [], unresolved: [],
    selectStar: false, setOperation: false,
  };
  const statements = Array.isArray(r.ast) ? r.ast : [r.ast];
  for (const ast of statements) walkStatement(ast, out, 'top');

  /* 同じ `DbColumn` を2回描かない（`SELECT code AS a, code AS b` は列1つ）。
   * 別名の違いは `selectItems` が保持している */
  const seen = new Set();
  const projections = out.projections.filter((p) => {
    const k = `${p.schema}.${p.table}.${p.column}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const first = statements[0];
  return {
    parseOk: true, error: null,
    statementType: (first && first.type) || 'unknown',
    tables,
    projections,
    selectItems: out.selectItems,
    references: out.references,
    unresolved: out.unresolved,
    selectStar: out.selectStar,
    setOperation: out.setOperation,
  };
}

/**
 * SELECT 句だけを、行オブジェクトの鍵（別名があれば別名）と由来の列に分けて返す。
 * PoC-04 の `lineage.mjs` が持っていた `selectList()` を**共通実装へ寄せたもの**。
 * 構文解析器を2つ持つことがこの種の不具合の原因だったため、入口を1つにする。
 *
 * @returns {{ok:boolean, star:boolean, error:string|null,
 *            items:{key:string, column:string|null, table:string|null, kind:string,
 *                   resolved:{schema,table,column}|null}[]}}
 */
export function selectList(sql) {
  const a = analyzeSql(sql);
  if (!a.parseOk) return { ok: false, star: false, error: a.error, items: [] };
  return {
    ok: true,
    star: a.selectStar,
    error: null,
    /* 鍵が無い式（別名なしの集計）は行オブジェクトの鍵にならないので出さない。
     * 旧 `selectList()` と同じ扱いである */
    items: a.selectItems
      .filter((i) => i.kind !== 'star' && i.key !== null)
      .map((i) => ({
        key: i.key, column: i.column, table: i.table, kind: i.kind,
        resolved: i.resolved ?? null,
      })),
  };
}

/**
 * 観測結果（`ObsSqlAnalysis`）1件を組み立てる。
 *
 * **5つの観測生成スクリプトが同じ写しを持っていたのを1つにまとめたもの**
 * （Phase 6F）。同じ写しが複数あることが、`columnList` の不具合が
 * 5つのデータセットすべてに入った原因である。
 *
 * `unresolved` には、**SELECT 句の外（ORDER BY 等）で参照されただけの列**も
 * `referenced-outside-select-list` として記録する。結果列ではないので
 * `projections` には入れないが、**観測できたことを隠さない**（OBS-05）。
 *
 * @param {{spanId:string, sql:string, redacted?:object|null}} span
 */
export function sqlAnalysisRecord({ spanId, sql, redacted = null }) {
  const a = analyzeSql(sql);
  const projected = new Set(a.projections.map((p) => `${p.schema}.${p.table}.${p.column}`));
  const outside = [...new Set(
    a.references
      .filter((r) => r.resolved && r.role !== 'select'
        && !projected.has(`${r.schema}.${r.table}.${r.column}`))
      .map((r) => r.column),
  )];
  return {
    spanId,
    sql,
    redacted,
    parseOk: a.parseOk,
    parseError: a.error,
    statementType: a.statementType,
    tables: a.tables,
    projections: a.projections,
    selectItems: a.selectItems,
    references: a.references,
    unresolved: [
      ...a.unresolved.map((u) => ({ column: u.column ?? null, why: u.why })),
      ...outside.map((column) => ({ column, why: 'referenced-outside-select-list' })),
    ],
    selectStar: a.selectStar,
    setOperation: a.setOperation,
  };
}
