/* =============================================================================
 * PoC-04 — **表示値の由来の推定と、その正確性の測定**。
 *   node poc/runner/poc04.mjs
 * 出力:
 *   poc/out/poc04.json           全文
 *   docs/06e-poc04-matrix.json   判定の要約（テストが読む。絶対パスを落とす）
 *
 * 2つの情報源を組み合わせる。**どちらも相手を補強しない。役割が違う。**
 *   L1相当  実行された SQL 文の構文解析   → その SQL が取った列が何か
 *   L2      ソースの静的解析（TypeScript） → 表示値がその結果の何を参照しているか
 *
 * 結論は**つねに L2（推定）**である。実測の SQL を使っても格上げしない。
 *
 * 使わないもの:
 *   * 表示された値 / 応答本文 / 行データ / SQL のパラメータ値
 *   * 値の一致（02d 3.3節）
 *   * 実行時刻の近さ
 *   * SQL 文の一致（同じ文が複数箇所から出る題材がある — 06d 3.1節）
 *   * ソース上の SQL リテラル（動的に組み立てた SQL では存在しない）
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { readRecords, startApp } from './lib/server.mjs';
import { observePage } from './lib/netobs.mjs';
import { resolveRscAttribution } from './lib/rscattr.mjs';
import { resetSrvMaps, srvMapStats } from './lib/srvmap.mjs';
import { ancestryTo, treeOf } from './lib/propagate.mjs';
import { analyzeSql } from './lib/sqlparse.mjs';
import { introspectColumns, introspectTables } from './lib/introspect.mjs';
import { analyzeLineage, resolveLineage, selectList, LINEAGE_REASON } from './lib/lineage.mjs';
import {
  ALL_PAGES, CLIENT_FETCH_SITES, FORBIDDEN, LINEAGE_CASES, MAIN_CASES, SUPP_CASES,
} from './lib/probe04.mjs';
import { APP, OUT, REPO, sleep } from './lib/util.mjs';

const BASE = 'http://localhost:3200';
const BUNDLERS = (process.env.POC04_BUNDLERS ?? 'turbopack,webpack').split(',');
const ANCHORS = path.join(OUT, 'anchors04');
const INSTR = path.join(APP, 'src', 'instrumentation.ts');
const PARKED = `${INSTR}.parked`;
const park = () => { if (fs.existsSync(INSTR)) fs.renameSync(INSTR, PARKED); };
const unpark = () => { if (fs.existsSync(PARKED)) fs.renameSync(PARKED, INSTR); };

const PAGES = [...ALL_PAGES, ...new Set(CLIENT_FETCH_SITES.map((s) => s.page))];

const isSqlSpan = (s) => !!(s.attrs['db.query.text'] || s.attrs['db.statement']);
const sqlTextOf = (s) => s.attrs['db.query.text'] ?? s.attrs['db.statement'] ?? null;
const isRenderSpan = (s) => s.attrs['next.span_type'] === 'AppRender.getBodyResult';

function manifestComponents() {
  const m = new Map();
  if (!fs.existsSync(ANCHORS)) return m;
  for (const f of fs.readdirSync(ANCHORS)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ANCHORS, f), 'utf8'));
      if (j.components?.length) m.set(j.file, j.components);
    } catch { /* 並列に書かれる断片は無視する */ }
  }
  return m;
}

/* -------------------------------------------------------------------------- */
/* 判定 — 01b Q-04.3 の4分類を、誤答を独立に数える形に広げたもの               */
/* -------------------------------------------------------------------------- */
const key3 = (c) => `${c.schema}.${c.table}.${c.column}`;
const key2 = (t) => `${t.schema}.${t.table ?? t.name}`;

/**
 * @returns {{bucket:string, detail:string, overclaimed:boolean, underclaimed:boolean}}
 *   correct-single       正しい候補を1件に確定できた
 *   candidates-correct   複数候補のままにした（正解を含む）
 *   table-only-correct   テーブルまでに粒度を落とした（正解のテーブルを含む）
 *   refused-correct      候補を出さなかった（DB由来でない値 — 正しく諦めた）
 *   missed               特定できなかった（DB由来だが候補が出なかった）
 *   missing-site          表示箇所として検出できなかった
 *   wrong                **誤った候補を提示した**
 */
function classify(exp, res) {
  const truthKeys = exp.truth.map(key3);
  const truthTables = [...new Set(exp.truth.map(key2))];
  const mk = (bucket, detail) => ({
    bucket, detail,
    overclaimed: exp.conclusive === false && res?.outcome === 'confirmed',
    underclaimed: exp.conclusive === true && !!res && res.outcome !== 'confirmed',
  });

  if (!res) {
    return exp.expectSite === false
      ? mk('refused-correct', 'JSX に式が無いため表示箇所にならない（static-literal）')
      : mk('missing-site', '表示箇所として検出できなかった');
  }
  const candKeys = res.candidates.map(key3);
  const tableKeys = res.tableCandidates.map(key2);

  /* DB 由来でない値。**候補を1つでも出したら誤答である** */
  if (!truthKeys.length) {
    return (candKeys.length || tableKeys.length)
      ? mk('wrong', `DB由来でない値に候補を出した: ${[...candKeys, ...tableKeys].join(' / ')}`)
      : mk('refused-correct', '候補を出さなかった');
  }

  if (res.outcome === 'confirmed') {
    return (candKeys.length === 1 && truthKeys.length === 1 && candKeys[0] === truthKeys[0])
      ? mk('correct-single', candKeys[0])
      : mk('wrong', `1件に確定したが正解と一致しない: ${candKeys.join(' / ')}`);
  }
  if (res.outcome === 'candidates') {
    return truthKeys.every((k) => candKeys.includes(k))
      ? mk('candidates-correct', `候補 ${candKeys.length} 件（正解 ${truthKeys.length} 件を含む）`)
      : mk('wrong', `候補に正解が含まれない: ${candKeys.join(' / ')}`);
  }
  if (res.outcome === 'table-only') {
    return truthTables.every((t) => tableKeys.includes(t))
      ? mk('table-only-correct', `テーブルまで: ${tableKeys.join(' / ')}`)
      : mk('wrong', `テーブル候補に正解が含まれない: ${tableKeys.join(' / ')}`);
  }
  return mk('missed', '候補を出せなかった');
}

/* ========================================================================== */
const result = {
  collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  app: { framework: 'Next.js', service: 'poc01-fixture-app', port: 3200 },
  method: {
    staticAnalysis: 'TypeScript Compiler API（AST + 記号解決によるスコープ解決）',
    columnResolution: '実行された SQL 文の構文解析（sql-ast-parse / L1相当）',
    attribution: 'サーバー側でデータ取得の呼び出し時に記録したスタック（server-call-stack / L1相当）',
    level: 'L2（static-analysis）。実測の SQL を使っても格上げしない',
    notUsed: ['値の一致', '実行時刻の近さ', 'SQL 文の一致', 'ソース上の SQL リテラル'],
  },
  byRun: {},
};

for (const bundler of BUNDLERS) {
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  fs.rmSync(ANCHORS, { recursive: true, force: true });
  const runKey = `${bundler}`;
  console.log(`\n=== ${runKey} ===`);
  park();
  let app;
  const per = { bundler, pages: {}, notes: [] };
  try {
    app = await startApp({
      mode: 'method2', bundler, run: `poc04-${runKey}`,
      env: {
        POC02_CALLSITE: '1',
        POC05_TRACE_HEADER: '1',
        POC05_SELF_ORIGIN: BASE,
        POC03_ANCHOR: '1',
        POC03_ANCHOR_OUT: ANCHORS,
      },
    });

    /* 初回コンパイルと接続確立を観測に混ぜない。1周捨てる */
    for (const p of PAGES) {
      await fetch(`${BASE}${p}`).then((r) => r.text()).catch(() => null);
    }
    await sleep(1000);
    fs.writeFileSync(app.spanFile, '');
    resetSrvMaps();

    for (const p of PAGES) {
      const obs = await observePage(BASE, p, null, { settleMs: 1200 });
      per.pages[p] = {
        requests: obs.records.map((r) => ({
          method: r.method, path: r.path, status: r.status,
          isDocument: r.isDocument, hasIdentity: !!r.server, server: r.server,
        })),
        excludedAssets: obs.excludedAssets,
      };
      await sleep(250);
    }
    await sleep(1200);
    const rec = readRecords(app.spanFile, 'app');
    per.notes = rec.notes.map((n) => ({ kind: n.kind, detail: n.detail }));
    per.raw = { spans: rec.spans, callsites: rec.callsites };
  } finally {
    if (app) await app.stop();
    unpark();
  }

  /* ===================================================== 実測 SQL の収集 */
  const spans = per.raw.spans;
  const callsiteBySpan = new Map(per.raw.callsites.map((c) => [c.spanId, c]));
  const comps = manifestComponents();
  const knownTables = new Set(introspectTables('poc').map((t) => t.name));
  const dbColumns = introspectColumns('poc');

  /** 実測した SQL を「どのソース行が実行したか」で引ける表にする */
  const measuredByCallsite = new Map();
  const measured = [];
  for (const p of PAGES) {
    const docRec = (per.pages[p].requests ?? []).find((r) => r.isDocument && r.path === p);
    const trace = docRec?.server?.traceId ?? null;
    if (!trace) { per.notes.push({ kind: 'no-document-identity', detail: p }); continue; }
    const { inTrace, byId } = treeOf(spans, trace);
    const render = inTrace.find((s) => isRenderSpan(s) && s.attrs['next.route'] === p) ?? null;
    for (const s of inTrace.filter(isSqlSpan)) {
      const chain = render ? ancestryTo(byId, s, render.spanId) : null;
      const text = sqlTextOf(s);
      const a = analyzeSql(text);
      const cs = callsiteBySpan.get(s.spanId) ?? null;
      const attr = cs ? resolveRscAttribution(cs, comps) : null;
      const tables = a.tables.filter((t) => knownTables.has(t.name))
        .map((t) => ({ schema: t.schema ?? 'poc', name: t.name }));

      /* SELECT 句だけを読み直す。**行オブジェクトの鍵と由来の列を分けて持つ。**
       * 修飾が書かれていなければ、テーブルが1つのときだけ一意に決まる
       * （analyzeSql と同じ規則。推測ではなく解析による決定である） */
      const sl = selectList(text);
      const items = sl.items.map((it) => {
        const t = it.table
          ? tables.find((x) => x.name === it.table || x.name === it.table.replace(/^.*\./, ''))
          : tables.length === 1 ? tables[0] : null;
        const def = (it.column && t)
          ? dbColumns.find((c) => c.schema === t.schema && c.table === t.name
            && c.column === it.column)
          : null;
        return {
          key: it.key, kind: it.kind, column: it.column, qualifier: it.table ?? null,
          resolved: def ? { schema: def.schema, table: def.table, column: def.column } : null,
          /* 列として書かれているのに情報スキーマに無い場合。隠さずに残す */
          ...(it.column && !def ? { unresolvedWhy: 'column-not-in-information-schema' } : {}),
        };
      });
      const row = {
        page: p, spanId: s.spanId, scope: s.scope,
        depthFromRender: chain?.depth ?? null,
        durationMs: +s.durationMs.toFixed(2),
        parseOk: a.parseOk,
        selectOk: sl.ok,
        selectStar: sl.star,
        selectError: sl.error,
        tables,
        /** SELECT 句の項目。別名は key、由来の列は resolved */
        items,
        /* 参考: sqlparse.mjs の射影。**Phase 6F で SELECT 句だけを見るようになった**
         * ので `items` と一致する。かつては ORDER BY 等の列も入っていた
         * （06e 5.3節 #1）。比較できるように、引き続き別に出しておく */
        projectionsFromSelectList: a.projections.filter((x) => dbColumns.some((c) => c.schema === x.schema
          && c.table === x.table && c.column === x.column)),
        /** 結果列ではないが、文中で参照された列。役割つきで残す（捨てない） */
        referencedOutsideSelectList: [...new Set(a.references
          .filter((rf) => rf.resolved && rf.role !== 'select')
          .map((rf) => `${rf.role}:${rf.schema}.${rf.table}.${rf.column}`))],
        unresolved: a.unresolved.map((u) => u.why),
        attribution: attr ? {
          file: attr.frame?.file ?? null, line: attr.frame?.line ?? null,
          component: attr.component?.name ?? null,
          verified: attr.verified, sourceLine: attr.sourceLine,
          reason: attr.failure?.reason ?? null,
        } : { reason: 'no-callsite-record' },
      };
      measured.push(row);
      if (row.attribution.file && row.attribution.line && row.attribution.verified) {
        const k = `${row.attribution.file}:${row.attribution.line}`;
        if (!measuredByCallsite.has(k)) measuredByCallsite.set(k, []);
        measuredByCallsite.get(k).push(row);
      }
    }
  }

  /* ================================================ 静的解析（ソースを読む） */
  const lin = analyzeLineage({ scope: 'src/' });

  /**
   * 静的解析で見つけた取得の呼び出しを、**実測された SQL** に結びつける。
   * 鍵は (ファイル, 行) である。**SQL 文の一致では結びつけない。**
   */
  const sqlByQuery = new Map();
  const joinLog = [];
  for (const q of lin.queries) {
    const k = `${q.file}:${q.line}`;
    const hits = measuredByCallsite.get(k) ?? [];
    joinLog.push({
      queryId: q.id, at: k, method: q.method, sqlIsDynamic: q.sqlIsDynamic,
      measuredCount: hits.length,
      pages: [...new Set(hits.map((h) => h.page))],
      why: hits.length ? null : 'この呼び出しに対応する実行された SQL を観測していない',
    });
    if (!hits.length) continue;
    /* 同じ行から複数本走った場合、SELECT 句の構成が一致しなければ結びつけない。
     * 「どちらかの列」と言えないので、候補を出さないほうが正しい */
    const sigOf = (h) => `${h.selectStar}|${h.items.map((i) => `${i.key}=${i.resolved ? key3(i.resolved) : '-'}`).sort().join(',')}`;
    const sigs = new Set(hits.map(sigOf));
    if (sigs.size > 1) {
      joinLog[joinLog.length - 1].why = '同じ行から SELECT 句の構成が違う SQL が複数走っている';
      continue;
    }
    const h = hits[0];
    sqlByQuery.set(q.id, {
      spanId: h.spanId, selectOk: h.selectOk, selectStar: h.selectStar, parseOk: h.parseOk,
      tables: h.tables, items: h.items,
      component: h.attribution.component, sourceLine: h.attribution.sourceLine,
      observedOnPages: [...new Set(hits.map((x) => x.page))],
    });
  }

  /* ------------------------------------------------- 表示箇所ごとの由来の推定 */
  const siteByField = new Map();
  for (const s of lin.sites) {
    if (!s.field) continue;
    if (!siteByField.has(s.field)) siteByField.set(s.field, s);
  }
  const resolvedByField = new Map();
  for (const [field, s] of siteByField) {
    resolvedByField.set(field, { site: s, res: resolveLineage(s, sqlByQuery) });
  }

  /* ---------------------------------------------------------------- 採点 */
  const cases = [];
  for (const c of LINEAGE_CASES) {
    const rows = [];
    for (const exp of c.sites) {
      const got = resolvedByField.get(exp.field) ?? null;
      const cls = classify(exp, got?.res ?? null);
      rows.push({
        field: exp.field, difficulty: exp.difficulty,
        truth: exp.truth.map(key3),
        conclusiveExpected: exp.conclusive,
        why: exp.why,
        observed: got ? {
          file: got.site.file, line: got.site.line, component: got.site.component,
          expr: got.site.expr, transformed: got.site.transformed,
          literalPaths: got.site.literalCount,
          untracked: got.site.unknowns.map((u) => u.why),
          outcome: got.res.outcome,
          candidates: got.res.candidates.map((x) => ({ key: key3(x), via: x.via, note: x.note ?? null })),
          tableCandidates: got.res.tableCandidates.map((x) => ({ key: key2(x), why: x.why })),
          unresolved: got.res.unresolved.map((u) => ({
            why: u.why, text: LINEAGE_REASON[u.why] ?? u.why,
          })),
          reasons: got.res.reasons,
          trail: got.res.candidates[0]?.trail ?? got.site.unknowns[0]?.trail ?? [],
        } : null,
        componentOk: got ? got.site.component === exp.component : null,
        fileOk: got ? got.site.file === exp.file : null,
        ...cls,
      });
    }
    cases.push({
      case: c.case, page: c.page, label: c.label, note: c.note,
      supplementary: !!c.supplementary,
      sites: rows,
      pass: rows.every((r) => r.bucket !== 'wrong' && r.bucket !== 'missing-site'
        && !r.overclaimed),
    });
  }

  /* 既存の client-fetch 経路。**ケースA〜G の母数には入れない** */
  const clientFetch = CLIENT_FETCH_SITES.map((exp) => {
    const got = resolvedByField.get(exp.field) ?? null;
    const cls = classify({ ...exp, conclusive: false }, got?.res ?? null);
    return {
      field: exp.field, page: exp.page, truth: exp.truth.map(key3), why: exp.why,
      outcome: got?.res.outcome ?? null,
      candidates: (got?.res.candidates ?? []).map(key3),
      untracked: got?.site.unknowns.map((u) => u.why) ?? [],
      ...cls,
    };
  });

  /* ---------------------------------------------------------------- 集計 */
  const mainRows = cases.filter((c) => !c.supplementary).flatMap((c) => c.sites);
  const suppRows = cases.filter((c) => c.supplementary).flatMap((c) => c.sites);
  const tally = (rows) => rows.reduce((acc, r) => {
    acc[r.bucket] = (acc[r.bucket] ?? 0) + 1;
    return acc;
  }, {});
  const byDifficulty = {};
  for (const r of mainRows) {
    const d = String(r.difficulty);
    byDifficulty[d] ??= { total: 0, buckets: {} };
    byDifficulty[d].total++;
    byDifficulty[d].buckets[r.bucket] = (byDifficulty[d].buckets[r.bucket] ?? 0) + 1;
  }

  per.summary = {
    spans: spans.length,
    sqlSpans: measured.length,
    callsites: per.raw.callsites.length,
    /** 実測 SQL のうち、実行したコンポーネントまで帰属できた件数（PoC-02 の方式） */
    attributedSql: measured.filter((m) => m.attribution.component).length,
    /** 静的解析が見つけた取得の呼び出しと、実測 SQL に結びついた件数 */
    staticQueries: lin.queries.length,
    joinedQueries: sqlByQuery.size,
    analyzedFiles: lin.files.length,
    displaySites: lin.sites.length,
    annotatedSites: siteByField.size,
    main: { total: mainRows.length, buckets: tally(mainRows) },
    supplementary: { total: suppRows.length, buckets: tally(suppRows) },
    byDifficulty,
    /** **最重要の指標。** 誤った候補を提示した件数 */
    wrong: mainRows.filter((r) => r.bucket === 'wrong').length,
    wrongRate: +(mainRows.filter((r) => r.bucket === 'wrong').length / mainRows.length).toFixed(4),
    /** 決め切れないものを「確定」として出した件数。0 でなければならない */
    overclaimed: mainRows.filter((r) => r.overclaimed).length,
    /** 決め切れるのに確定にしなかった件数（安全側の取りこぼし） */
    underclaimed: mainRows.filter((r) => r.underclaimed).length,
    casesPass: cases.filter((c) => c.pass).length,
    casesTotal: cases.length,
  };
  per.cases = cases;
  per.clientFetch = clientFetch;
  per.measuredSql = measured;
  per.staticQueries = lin.queries;
  per.join = joinLog;
  per.unannotatedSites = lin.sites.filter((s) => !s.field).map((s) => ({
    file: s.file, line: s.line, component: s.component, expr: s.expr,
    outcome: resolveLineage(s, sqlByQuery).outcome,
  }));
  /* 注記はあるが、本PoCの正解表に無い表示箇所（PoC-01/02/03/05 の題材のページ）。
   * **母数には入れない。** 隠さずに残す — 何を採点していないかを辿れるようにする */
  const scored = new Set([
    ...LINEAGE_CASES.flatMap((c) => c.sites.map((s) => s.field)),
    ...CLIENT_FETCH_SITES.map((s) => s.field),
  ]);
  per.outOfScopeSites = [...siteByField.entries()]
    .filter(([f]) => !scored.has(f))
    .map(([f, s]) => {
      const r = resolveLineage(s, sqlByQuery);
      return {
        field: f, file: s.file, line: s.line, component: s.component, expr: s.expr,
        outcome: r.outcome,
        candidates: r.candidates.map(key3),
        tableCandidates: r.tableCandidates.map(key2),
        note: '本PoCの正解表の対象外（他のPoCの題材ページ）。採点していない',
      };
    });
  per.lineageNotes = lin.notes;
  per.srvMapStats = srvMapStats();
  delete per.raw;
  result.byRun[runKey] = per;

  console.log(`  ケース ${per.summary.casesPass}/${per.summary.casesTotal} 合格`
    + ` / 誤答 ${per.summary.wrong} 件`
    + ` / 過剰な確定 ${per.summary.overclaimed} 件`
    + ` / 実測SQL ${per.summary.sqlSpans} 本（帰属 ${per.summary.attributedSql}）`
    + ` / 結合 ${per.summary.joinedQueries}/${per.summary.staticQueries}`);
  console.log(`  内訳: ${JSON.stringify(per.summary.main.buckets)}`);
}

/* -------------------------------------------- 秘密情報が入っていないかの検査 */
const text = JSON.stringify(result);
const hits = FORBIDDEN.filter((re) => re.test(text)).map(String);
if (hits.length) throw new Error(`計測結果に収集禁止の痕跡がある: ${hits.join(', ')}`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'poc04.json'), JSON.stringify(result, null, 2));
const summary = JSON.parse(JSON.stringify(result).replaceAll(REPO, '<repo>'));
fs.writeFileSync(path.join(REPO, 'docs', '06e-poc04-matrix.json'), JSON.stringify(summary, null, 2));
console.log(`\n→ ${path.join(OUT, 'poc04.json')}`);
console.log('→ docs/06e-poc04-matrix.json');
