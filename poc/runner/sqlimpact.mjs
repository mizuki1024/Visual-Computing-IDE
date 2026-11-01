/* =============================================================================
 * Phase 6F — SQL 射影解析の修正が、**既存の観測結果の表示にどう影響するか**。
 *
 * やること:
 *   1. PoC-01 / 03 / 05 / 02 / 04 の **記録済みの観測結果**を読む
 *   2. そこに入っている「実測された SQL 文」を、旧実装と新実装の両方に通す
 *   3. 観測結果の `sqlAnalyses` だけを差し替えて、**同じ adapter / layout** を通す
 *   4. ノード数・ホップ数・表示カラム・実測/推定の分類・切断マーカー・
 *      右詳細パネルの説明を、変更前後で比べる
 *
 * **記録を書き換えない。** 読むだけで、結果は docs/06f-sqlimpact.json に出す。
 * 既存の src/data/observation.*.ts には一切触れない。
 *
 *   node poc/runner/sqlimpact.mjs
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { analyzeSql, sqlAnalysisRecord } from './lib/sqlparse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const require_ = createRequire(path.join(REPO, 'package.json'));

const adapter = require_(path.join(REPO, '.libjs/lib/adapter.js'));
const layoutMod = require_(path.join(REPO, '.libjs/lib/layout.js'));
const derive = require_(path.join(REPO, '.libjs/lib/derive.js'));

/* -------------------------------------------------------------------------- */
/* 旧実装の凍結コピー。**比較のためだけに置く。**                               */
/* これが Phase 6F 以前の poc/runner/lib/sqlparse.mjs の中身である。            */
/* 変更しないこと（変更すると「変更前」が変わってしまう）。                      */
/* -------------------------------------------------------------------------- */
const { Parser } = require_(path.join(REPO, 'poc/fixture-app/node_modules/node-sql-parser'));
const legacyParser = new Parser();

function legacySplitTable(entry) {
  const [, schema, name] = entry.split('::');
  return { schema: schema === 'null' ? null : schema, name };
}
function legacySplitColumn(entry) {
  const [, qualifier, column] = entry.split('::');
  if (qualifier === 'null') return { schema: null, table: null, column };
  const parts = qualifier.split('.');
  return parts.length === 2
    ? { schema: parts[0], table: parts[1], column }
    : { schema: null, table: parts[0], column };
}
function legacyAnalyzeSql(sql) {
  let r;
  try {
    r = legacyParser.parse(sql, { database: 'PostgreSQL' });
  } catch (e) {
    return {
      parseOk: false, error: String(e && e.message).slice(0, 200),
      tables: [], projections: [], unresolved: [], selectStar: false,
    };
  }
  const tables = (r.tableList ?? []).map(legacySplitTable)
    .filter((t) => t.name && t.name !== 'null');
  const cols = (r.columnList ?? []).map(legacySplitColumn);
  const selectStar = cols.some((c) => c.column === '*');
  const projections = [];
  const unresolved = [];
  for (const c of cols) {
    if (c.column === '*' || !c.column) { unresolved.push({ ...c, why: 'select-star-or-empty' }); continue; }
    if (c.schema && c.table) projections.push(c);
    else if (!c.table && tables.length === 1) {
      projections.push({ schema: tables[0].schema, table: tables[0].name, column: c.column, inferredQualifier: true });
    } else unresolved.push({ ...c, why: 'ambiguous-qualifier' });
  }
  return { parseOk: true, error: null, tables, projections, unresolved, selectStar };
}

/* -------------------------------------------------------------------------- */
/* 比較対象のデータセット。**記録済みのものだけ**                               */
/* -------------------------------------------------------------------------- */
const DATASETS = [
  { key: 'measured', poc: 'PoC-01', mod: 'observation.measured.js',名: 'OBSERVATION', build: 'fromObservation' },
  { key: 'elements', poc: 'PoC-03', mod: 'observation.poc03.js', 名: 'ELEMENT_OBSERVATION', build: 'fromObservation' },
  { key: 'flows', poc: 'PoC-05', mod: 'observation.poc05.js', 名: 'FLOW_OBSERVATION', build: 'fromObservation' },
  { key: 'rsc', poc: 'PoC-02', mod: 'observation.poc02.js', 名: 'RSC_OBSERVATION', build: 'fromRscObservation' },
  { key: 'rsc-svc', poc: 'PoC-02(Gate A)', mod: 'observation.poc02.js', 名: 'RSC_SVC_OBSERVATION', build: 'fromRscObservation' },
  { key: 'lin-a', poc: 'PoC-04 A', mod: 'observation.poc04.js', 名: 'LIN_A_OBSERVATION', build: 'fromRscObservation' },
  { key: 'lin-c', poc: 'PoC-04 C', mod: 'observation.poc04.js', 名: 'LIN_C_OBSERVATION', build: 'fromRscObservation' },
  { key: 'lin-g', poc: 'PoC-04 G', mod: 'observation.poc04.js', 名: 'LIN_G_OBSERVATION', build: 'fromRscObservation' },
];

/**
 * 観測結果の sqlAnalyses だけを差し替えた複製を作る（元は変えない）。
 *
 * **観測生成スクリプトと同じ道を通す。** `dbObjects.columns` も作り直す。
 * 記録済みの `dbObjects` は、そのときの射影から絞った結果が入っているので、
 * 射影だけ差し替えると「定義が無いから作らなかった」が混ざり、
 * **修正そのものの影響が見えなくなる**（PoC-04 G で実際にそうなった）。
 */
function withAnalyses(obs, make) {
  const copy = structuredClone(obs);
  copy.sqlAnalyses = copy.sqlAnalyses.map((a) => make({
    spanId: a.spanId, sql: a.sql, redacted: a.redacted ?? null,
  }));
  /* 情報スキーマの定義は、PoC の題材の poc スキーマ全体を模す。
   * 記録に入っている定義の和をとる（新たに DB へ照会しない） */
  const allColumns = ALL_COLUMNS;
  const wanted = new Set(copy.sqlAnalyses.flatMap(
    (a) => a.projections.map((p) => `${p.schema}.${p.table}.${p.column}`),
  ));
  copy.dbObjects = {
    ...copy.dbObjects,
    columns: allColumns.filter((c) => wanted.has(`${c.schema}.${c.table}.${c.column}`)),
  };
  return copy;
}

/** 旧実装の出力を、観測結果の1件の形に合わせる（比較の「変更前」） */
const legacyRecord = ({ spanId, sql, redacted }) => {
  const a = legacyAnalyzeSql(sql);
  return {
    spanId, sql, redacted,
    parseOk: a.parseOk, parseError: a.error, tables: a.tables,
    projections: a.projections,
    unresolved: a.unresolved.map((u) => ({ column: u.column ?? null, why: u.why })),
    selectStar: a.selectStar,
  };
};

/** 画面に出る形まで通して、比べたいものを取り出す */
function snapshot(obs, build) {
  const { dataset, skipped } = adapter[build](obs);
  const laid = layoutMod.layout(dataset);
  const sum = derive.summarize(laid);
  return {
    nodeCount: laid.nodes.length,
    hopCount: laid.hops.length,
    /* ホップ数 = 経路のホップ。表示カラムは ⑦ のラベル */
    columns: laid.nodes.filter((n) => n.kind === 'column')
      .map((n) => n.identifier).sort(),
    columnChips: laid.nodes.filter((n) => n.kind === 'column')
      .map((n) => n.chipSub).sort(),
    projectsHops: laid.hops.filter((h) => h.relation === 'projects').length,
    readsHops: laid.hops.filter((h) => h.relation === 'reads').length,
    measured: sum.measured,
    estimated: sum.estimated,
    total: sum.total,
    pathObservability: sum.observability,
    weakestHop: sum.weakest ? `${sum.weakest.id}/${sum.weakest.relation}` : null,
    claim: sum.claim,
    truncated: sum.truncated,
    summaryLine: derive.summaryLine(sum),
    cuts: laid.cuts.map((c) => `${c.head} / ${c.sub} / ${c.kind}`).sort(),
    nodeObservability: Object.fromEntries(
      ['value', 'component', 'http', 'server', 'sql', 'table', 'column'].map((k) => [
        k,
        laid.nodes.filter((n) => n.kind === k)
          .map((n) => n.observability).sort().join(','),
      ]).filter(([, v]) => v !== ''),
    ),
    /* 右詳細パネルの説明の材料。変換で作らなかったものの一覧 */
    skipped: skipped.map((s) => `${s.what} — ${s.why}`).sort(),
  };
}

const diffOf = (a, b) => {
  const out = {};
  for (const k of Object.keys(a)) {
    const x = JSON.stringify(a[k]);
    const y = JSON.stringify(b[k]);
    if (x !== y) out[k] = { before: a[k], after: b[k] };
  }
  return out;
};

/* 記録に入っている DB カラム定義の和。**新たに DB へ照会しない。**
 * 各データセットの dbObjects は「そのとき必要だった列」に絞られているので、
 * 和をとらないと「定義が無い」が修正の影響に化けてしまう */
const ALL_COLUMNS = (() => {
  const m = new Map();
  for (const d of DATASETS) {
    const obs = require_(path.join(REPO, '.libjs/data', d.mod))[d.名];
    for (const c of obs?.dbObjects?.columns ?? []) {
      m.set(`${c.schema}.${c.table}.${c.column}`, c);
    }
  }
  return [...m.values()];
})();

const report = {
  generatedFor: 'Phase 6F',
  note: '既存の記録は書き換えていない。読んで比べただけである。',
  knownColumnDefinitions: ALL_COLUMNS.map((c) => `${c.schema}.${c.table}.${c.column}`).sort(),
  datasets: [],
  sqlStatements: [],
};
const seenSql = new Map();

for (const d of DATASETS) {
  const mod = require_(path.join(REPO, '.libjs/data', d.mod));
  const obs = mod[d.名];
  if (!obs) throw new Error(`観測結果が見つからない: ${d.mod}#${d.名}`);

  /* 記録された sqlAnalyses をそのまま使った場合（＝いまの画面） */
  const asRecorded = snapshot(obs, d.build);
  /* 旧実装で再計算した場合（記録と一致するはず。一致しなければ記録が別物） */
  const before = snapshot(withAnalyses(obs, legacyRecord), d.build);
  /* 新実装で再計算した場合（＝修正後の画面） */
  const after = snapshot(withAnalyses(obs, sqlAnalysisRecord), d.build);

  for (const a of obs.sqlAnalyses) {
    if (seenSql.has(a.sql)) continue;
    const L = legacyAnalyzeSql(a.sql);
    const N = analyzeSql(a.sql);
    const key3 = (p) => `${p.schema}.${p.table}.${p.column}`;
    seenSql.set(a.sql, true);
    report.sqlStatements.push({
      poc: d.poc,
      sql: a.sql,
      recordedProjections: a.projections.map(key3).sort(),
      beforeProjections: L.projections.map(key3).sort(),
      afterProjections: N.projections.map(key3).sort(),
      removed: L.projections.map(key3).filter((x) => !N.projections.map(key3).includes(x)).sort(),
      added: N.projections.map(key3).filter((x) => !L.projections.map(key3).includes(x)).sort(),
      beforeSelectStar: L.selectStar,
      afterSelectStar: N.selectStar,
      afterStatementType: N.statementType,
      afterReferencesByRole: N.references.reduce((m, r) => {
        const k = r.role;
        (m[k] ??= []).push(r.resolved ? `${r.schema}.${r.table}.${r.column}` : `(${r.why})`);
        return m;
      }, {}),
      afterUnresolved: N.unresolved,
    });
  }

  report.datasets.push({
    key: d.key,
    poc: d.poc,
    recordedMatchesLegacy: Object.keys(diffOf(asRecorded, before)).length === 0,
    recordedVsLegacyDiff: diffOf(asRecorded, before),
    before,
    after,
    diff: diffOf(before, after),
    changed: Object.keys(diffOf(before, after)).length > 0,
  });
}

const outPath = path.join(REPO, 'docs/06f-sqlimpact.json');
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

/* ------------------------------------------------------------------ 画面出力 */
console.log('\n=== SQL 文ごとの射影の変化 ===');
for (const s of report.sqlStatements) {
  const same = s.removed.length === 0 && s.added.length === 0 && s.beforeSelectStar === s.afterSelectStar;
  console.log(`\n[${s.poc}] ${s.sql}`);
  console.log(`  変更前の射影: ${s.beforeProjections.join(', ') || '(なし)'}`);
  console.log(`  変更後の射影: ${s.afterProjections.join(', ') || '(なし)'}`);
  if (s.removed.length) console.log(`  → 消えた: ${s.removed.join(', ')}`);
  if (s.added.length) console.log(`  → 増えた: ${s.added.join(', ')}`);
  if (s.beforeSelectStar !== s.afterSelectStar) console.log(`  → selectStar: ${s.beforeSelectStar} → ${s.afterSelectStar}`);
  console.log(`  結果列でない参照: ${Object.entries(s.afterReferencesByRole)
    .filter(([r]) => r !== 'select').map(([r, v]) => `${r}=[${[...new Set(v)].join(' ')}]`).join(' ') || '(なし)'}`);
  if (same) console.log('  （射影は変わらない）');
}

console.log('\n=== データセットごとの表示の変化 ===');
let changedCount = 0;
for (const d of report.datasets) {
  const marks = [];
  if (!d.recordedMatchesLegacy) marks.push('※記録と旧実装の再計算が一致しない');
  console.log(`\n[${d.poc}] (${d.key}) ${d.changed ? '**変化あり**' : '変化なし'} ${marks.join(' ')}`);
  console.log(`  ノード数 ${d.before.nodeCount} → ${d.after.nodeCount}`
    + ` / ホップ数 ${d.before.hopCount} → ${d.after.hopCount}`
    + ` / projects ${d.before.projectsHops} → ${d.after.projectsHops}`
    + ` / reads ${d.before.readsHops} → ${d.after.readsHops}`);
  console.log(`  表示カラム  ${d.before.columnChips.join(', ') || '(なし)'}`
    + `  →  ${d.after.columnChips.join(', ') || '(なし)'}`);
  console.log(`  実測/推定   ${d.before.measured}/${d.before.estimated} (${d.before.pathObservability})`
    + `  →  ${d.after.measured}/${d.after.estimated} (${d.after.pathObservability})`);
  console.log(`  最弱環      ${d.before.weakestHop ?? '(なし)'}  →  ${d.after.weakestHop ?? '(なし)'}`);
  console.log(`  主張        ${d.before.claim || '(なし)'}  →  ${d.after.claim || '(なし)'}`);
  console.log(`  切断        ${d.before.cuts.length} 件  →  ${d.after.cuts.length} 件`);
  if (d.changed) {
    changedCount += 1;
    for (const [k, v] of Object.entries(d.diff)) {
      console.log(`    差分 ${k}:\n      前: ${JSON.stringify(v.before)}\n      後: ${JSON.stringify(v.after)}`);
    }
  }
  if (!d.recordedMatchesLegacy) {
    for (const [k, v] of Object.entries(d.recordedVsLegacyDiff)) {
      console.log(`    記録と旧実装の差 ${k}:\n      記録: ${JSON.stringify(v.before)}\n      旧再計算: ${JSON.stringify(v.after)}`);
    }
  }
}
console.log(`\n変化のあったデータセット: ${changedCount} / ${report.datasets.length}`);
console.log(`書き出し: ${path.relative(REPO, outPath)}`);
