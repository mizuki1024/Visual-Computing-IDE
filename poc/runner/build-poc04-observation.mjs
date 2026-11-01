/* =============================================================================
 * PoC-04 — 観測結果 JSON を作る（IDE のキャンバスへ流し込む入力）。
 *   node poc/runner/build-poc04-observation.mjs
 * 出力:
 *   poc/out/poc04-observation.json
 *   src/data/observation.poc04.ts
 *
 * **3つの場面を別々に観測する。** 1枚の画面に混ぜない。
 *   linA  由来を1列に絞れた       → 推定のホップを1本引く（実測ではない）
 *   linC  候補が複数のまま        → ホップは引くが1つに断定しない
 *   linG  由来を作らない          → **切断のまま。** 線を引かない
 *
 * 推定（L2）と実測（L0/L1/L1相当）は、取得手段によって分かれる。
 * 表示の都合で格上げする経路は無い（model.ts の observabilityOf だけが決める）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { readRecords, startApp } from './lib/server.mjs';
import { observePage } from './lib/netobs.mjs';
import { resolveRscAttribution } from './lib/rscattr.mjs';
import { resetSrvMaps } from './lib/srvmap.mjs';
import { ancestryTo, overlaps, treeOf } from './lib/propagate.mjs';
import { INSTALL } from './lib/probe.mjs';
import { lineText, verifyLocation } from './lib/srcverify.mjs';
import { analyzeSql, sqlAnalysisRecord } from './lib/sqlparse.mjs';
import { analyzeLineage, resolveLineage, selectList, LINEAGE_REASON } from './lib/lineage.mjs';
import { UI_SCENES_04 } from './lib/probe04.mjs';
import { introspectColumns, introspectRowEstimates, introspectTables } from './lib/introspect.mjs';
import { APP, OUT, REPO, sleep } from './lib/util.mjs';

const BASE = 'http://localhost:3200';
const BUNDLER = process.env.POC04_PICK_BUNDLER ?? 'turbopack';
const ANCHORS = path.join(OUT, 'anchors04ui');
const SQL_TEXT = (a) => a['db.statement'] ?? a['db.query.text'] ?? null;

const INSTR = path.join(APP, 'src', 'instrumentation.ts');
const PARKED = `${INSTR}.parked`;
const park = () => { if (fs.existsSync(INSTR)) fs.renameSync(INSTR, PARKED); };
const unpark = () => { if (fs.existsSync(PARKED)) fs.renameSync(PARKED, INSTR); };

/** キャンバスのページ一覧。PoC-04 の題材を足した */
const UI_PAGES_04 = [
  { icon: '⌂', name: 'ホーム', path: '/' },
  { icon: '▣', name: '物件一覧', path: '/listings' },
  { icon: '◆', name: '直読み（1本）', path: '/rsc-db' },
  { icon: '①', name: 'ケースA 直接対応', path: '/lin-a' },
  { icon: '③', name: 'ケースC 値の加工', path: '/lin-c' },
  { icon: '✕', name: 'ケースG 否定例', path: '/lin-g' },
];

function readManifest() {
  const byId = new Map();
  const components = new Map();
  const files = [];
  if (!fs.existsSync(ANCHORS)) return { byId, components, files };
  for (const f of fs.readdirSync(ANCHORS)) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(ANCHORS, f), 'utf8'));
    files.push(j);
    for (const a of j.anchors) byId.set(a.id, a);
    if (j.components?.length) components.set(j.file, j.components);
  }
  return { byId, components, files };
}

/** 選択された要素1つの出所を解く（PoC-03 の規則をそのまま使う） */
function resolveElement(p, byId) {
  if (!p.found) return { failure: { reason: 'unidentifiable', detail: 'element-not-found' } };
  if (!p.documentHasAnchors) return { failure: { reason: 'not-instrumented-build', detail: null } };
  if (!p.anchorOnSelf) {
    return { failure: { reason: 'anchor-missing', detail: p.ancestorAnchors.length
      ? '祖先には識別子があるが、この要素自身には無い' : null } };
  }
  const a = byId.get(p.anchorOnSelf);
  if (!a) return { failure: { reason: 'unidentifiable', detail: 'manifest-miss' } };
  if (a.tag !== p.tag) {
    return { failure: { reason: 'unidentifiable', detail: `tag-mismatch:${a.tag}/${p.tag}` } };
  }
  const v = verifyLocation({ file: a.file, line: a.line, col: a.col, tag: a.tag, component: a.component });
  return { anchor: { ...a, verified: v.ok, sourceLine: v.ok ? lineText(a.file, a.line) : null } };
}

/* ------------------------------------------------------------------ 観測 */
park();
let app;
const observed = {};
let records;
try {
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  fs.rmSync(ANCHORS, { recursive: true, force: true });
  app = await startApp({
    mode: 'method2', bundler: BUNDLER, run: 'poc04-observation',
    env: {
      POC02_CALLSITE: '1',
      POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCHORS,
      POC05_TRACE_HEADER: '1', POC05_SELF_ORIGIN: BASE,
    },
  });
  // 2回捨てる。初回コンパイルと接続確立のスパンを観測対象に混ぜない
  for (let i = 0; i < 2; i++) {
    for (const s of UI_SCENES_04) await observePage(BASE, s.page, null, { settleMs: 900 });
  }
  fs.writeFileSync(app.spanFile, '');
  resetSrvMaps();

  for (const s of UI_SCENES_04) {
    observed[s.key] = await observePage(BASE, s.page, async (p) => {
      /* 表示された値の選択（PoC-03 の機構。**値そのものは読まない**） */
      await p.evaluate(INSTALL);
      const facts = {
        anchoredElements: await p.evaluate('document.querySelectorAll("[data-vcide]").length'),
        totalElements: await p.evaluate('document.querySelectorAll("*").length'),
      };
      const found = await p.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(s.selector)});
           if (!el) return false;
           el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
           return true; })()`,
      );
      return {
        facts,
        pick: found ? await p.evaluate('window.__vcidePick') : { found: false },
      };
    }, { settleMs: 1500 });
    await sleep(300);
  }
  await sleep(1500);
  records = readRecords(app.spanFile, 'poc01-fixture-app');
} finally {
  if (app) await app.stop();
  unpark();
}

/* ------------------------------------------------------------------ 変換 */
const { byId: anchorById, components, files: manifestFiles } = readManifest();
const allSpans = records.spans;
const callsiteBySpan = new Map(records.callsites.map((c) => [c.spanId, c]));

const toCallsite = (spanId) => {
  const cs = callsiteBySpan.get(spanId);
  if (!cs) return null;
  const a = resolveRscAttribution(cs, components);
  return {
    at: a.at, frame: a.frame, verified: a.verified, sourceLine: a.sourceLine,
    component: a.component, appFrameAtSpanStart: a.appFrameAtSpanStart, failure: a.failure,
  };
};

/* ソースの静的解析は1度で足りる。場面ごとに走らせる必要がない */
const lin = analyzeLineage({ scope: 'src/' });
const dbColumnsAll = introspectColumns('poc');
const knownTablesAll = new Set(introspectTables('poc').map((t) => t.name));

/** 実行された SQL 1本の SELECT 句を、行の鍵と由来の列に分けて解く */
function selectItemsOf(sqlText) {
  const a = analyzeSql(sqlText);
  const tables = a.tables.filter((t) => knownTablesAll.has(t.name))
    .map((t) => ({ schema: t.schema ?? 'poc', name: t.name }));
  const sl = selectList(sqlText);
  const items = sl.items.map((it) => {
    const t = it.table
      ? tables.find((x) => x.name === it.table)
      : tables.length === 1 ? tables[0] : null;
    const def = (it.column && t)
      ? dbColumnsAll.find((c) => c.schema === t.schema && c.table === t.name
        && c.column === it.column)
      : null;
    return {
      key: it.key, kind: it.kind, column: it.column,
      resolved: def ? { schema: def.schema, table: def.table, column: def.column } : null,
    };
  });
  return { selectOk: sl.ok, selectStar: sl.star, tables, items };
}

const bundles = {};
for (const scene of UI_SCENES_04) {
  const obs = observed[scene.key];
  const doc = obs.records.find((r) => r.isDocument && r.path === scene.page);
  if (!doc) throw new Error(`document request not observed: ${scene.page}`);
  if (!doc.server) throw new Error(`応答ヘッダからトレース識別子を読めなかった: ${scene.page}`);
  const docSpan = allSpans.find((s) => s.spanId === doc.server.spanId
    && s.traceId === doc.server.traceId && s.kind === 1);
  if (!docSpan) throw new Error(`文書取得の入口スパンを収集できなかった: ${scene.page}`);

  const traceId = docSpan.traceId;
  const { inTrace, byId } = treeOf(allSpans, traceId);
  const render = inTrace.find((s) => s.attrs['next.span_type'] === 'AppRender.getBodyResult'
    && s.attrs['next.route'] === scene.renderRoute);
  if (!render) throw new Error(`描画スパンを観測できなかった: ${scene.renderRoute}`);

  const sqlUnderRender = inTrace
    .filter((s) => SQL_TEXT(s.attrs))
    .map((s) => ({ span: s, chain: ancestryTo(byId, s, render.spanId) }))
    .filter((x) => x.chain)
    .sort((a, b) => a.span.startMs - b.span.startMs);

  const spans = [...inTrace].sort((a, b) => a.startMs - b.startMs);

  /* ---- 実測SQLの構文解析（PoC-01 以来と同じ） ----
   *
   * **Phase 6F で絞り込みをやめた。** PoC-04 の時点では `analyzeSql` の射影が
   * `columnList`（文中で参照された列）に由来していて `ORDER BY id` のような
   * SELECT 句の外の列まで入ったため、ここで SELECT 句の列だけに絞っていた
   * （06e 5.3節 #1）。`sqlparse.mjs` を直したので、絞り込みは不要である。
   *
   * SELECT 句の外で参照された列は、捨てずに `references` から理由つきで残す
   * （OBS-05: 観測できたことは隠さない。ただし結果列として扱わない）。 */
  const sqlAnalyses = [];
  for (const s of spans) {
    const sql = SQL_TEXT(s.attrs);
    if (!sql) continue;
    sqlAnalyses.push(sqlAnalysisRecord({ spanId: s.spanId, sql, redacted: s.sqlRedacted ?? null }));
  }

  /* ---- 情報スキーマ（定義のみ） ---- */
  const wantedTables = new Set(sqlAnalyses.flatMap((a) => a.tables.map((t) => t.name)));
  const rowEst = introspectRowEstimates('poc');
  const tables = introspectTables('poc')
    .filter((t) => wantedTables.has(t.name))
    .map((t) => ({ ...t, rowEstimate: rowEst[t.name] ?? null }));
  const wantedCols = new Set(
    sqlAnalyses.flatMap((a) => a.projections.map((p) => `${p.table}.${p.column}`)),
  );
  const columns = introspectColumns('poc').filter((c) => wantedCols.has(`${c.table}.${c.column}`));

  /* ---- 要素識別子の解決（①② を作るのに要る） ---- */
  const r = resolveElement(obs.extra.pick, anchorById);
  const anchors = r.anchor ? [r.anchor] : [];
  const selections = [{
    key: scene.field, selector: scene.selector, ordinal: 0, group: 'poc04', primary: true,
    tag: obs.extra.pick.found ? obs.extra.pick.tag : null,
    anchorOnSelf: obs.extra.pick.anchorOnSelf ?? null,
    anchorOrdinal: obs.extra.pick.anchorOrdinal ?? null,
    anchorInstanceCount: obs.extra.pick.anchorInstanceCount ?? 0,
    ancestorAnchors: (obs.extra.pick.ancestorAnchors ?? []).filter((a) => !a.self).map((a) => a.id),
    textNodeIndex: obs.extra.pick.textNodeIndex ?? null,
    valueShape: obs.extra.pick.valueShape ?? null,
    failure: r.failure ?? null,
  }];
  if (!selections[0].anchorOnSelf) throw new Error(`主対象の要素識別子が取れなかった: ${scene.page}`);

  /* =================================================== 由来の推定（PoC-04） */
  /*
   * 静的解析で見つけた取得の呼び出しを、**この読み込みで実行された SQL** に
   * 結びつける。鍵は (ファイル, 行) である。SQL 文の一致では結びつけない。
   */
  const measuredByCallsite = new Map();
  for (const x of sqlUnderRender) {
    const cs = toCallsite(x.span.spanId);
    if (!cs?.frame || !cs.verified) continue;
    const k = `${cs.frame.file}:${cs.frame.line}`;
    if (!measuredByCallsite.has(k)) measuredByCallsite.set(k, []);
    measuredByCallsite.get(k).push({ span: x.span, ...selectItemsOf(SQL_TEXT(x.span.attrs)) });
  }
  const sqlByQuery = new Map();
  for (const q of lin.queries) {
    const hits = measuredByCallsite.get(`${q.file}:${q.line}`) ?? [];
    if (!hits.length) continue;
    const sig = (h) => `${h.selectStar}|${h.items.map((i) => `${i.key}=${i.resolved ? `${i.resolved.schema}.${i.resolved.table}.${i.resolved.column}` : '-'}`).sort().join(',')}`;
    if (new Set(hits.map(sig)).size > 1) continue;
    sqlByQuery.set(q.id, {
      spanId: hits[0].span.spanId,
      selectOk: hits[0].selectOk, selectStar: hits[0].selectStar,
      tables: hits[0].tables, items: hits[0].items,
    });
  }

  /* その場面で選んだ表示箇所。**注記（data-poc-field）で引く** */
  const site = lin.sites.find((s) => s.field === scene.field);
  if (!site) throw new Error(`表示箇所を静的解析で見つけられなかった: ${scene.field}`);
  const res = resolveLineage(site, sqlByQuery);

  const lineage = {
    method: 'TypeScript Compiler API（AST ＋ 記号解決によるスコープ解決）。'
      + '参照の連鎖（分解束縛・別名・props の受け渡し・反復）を前向きにたどる。'
      + '値の一致・実行時刻・SQL 文の一致・ソース上の SQL リテラルは使わない',
    scope: lin.scope,
    site: {
      file: site.file, line: site.line, col: site.col,
      component: site.component, field: site.field, expr: site.expr,
    },
    outcome: res.outcome,
    candidates: res.candidates.map((c) => ({
      schema: c.schema, table: c.table, column: c.column, via: c.via,
      note: c.note ?? null,
      query: (() => {
        const q = lin.queries.find((x) => x.id === c.queryId);
        return { file: q.file, line: q.line };
      })(),
      trail: c.trail,
    })),
    tableCandidates: res.tableCandidates.map((t) => ({
      schema: t.schema, name: t.name, why: LINEAGE_REASON[t.why] ?? t.why,
    })),
    transformed: res.transformed,
    literalPaths: site.literalCount,
    untracked: site.unknowns.map((u) => ({
      why: u.why, detail: u.trail.length ? u.trail.join(' ← ') : null,
    })),
    unresolved: res.unresolved.map((u) => ({
      why: u.why, text: LINEAGE_REASON[u.why] ?? u.why,
    })),
    reasons: res.reasons,
    sqlSpanIds: [...new Set(res.candidates.concat(res.tableCandidates)
      .map((c) => sqlByQuery.get(c.queryId)?.spanId).filter(Boolean))],
  };

  const toRequest = (rq) => ({
    method: rq.method, path: rq.path, status: rq.status ?? 0,
    startMs: rq.startMs, durationMs: rq.durationMs, server: rq.server,
    isDocument: !!rq.isDocument,
    browserRequestId: rq.browserRequestId,
    via: rq.via, headersAgree: rq.headersAgree, readHeaderKeys: rq.readHeaderKeys,
    failure: rq.failure ?? null,
    hasQuery: !!rq.hasQuery,
    crossOrigin: rq.external ? rq.origin : null,
    initiator: rq.isDocument
      ? {
        type: rq.initiator?.type ?? null, frameCount: 0, frame: null, verified: false,
        sourceLine: null, component: null,
        failure: { reason: 'no-script-stack', detail: `initiator.type=${rq.initiator?.type ?? 'null'}` },
      }
      : null,
  });

  bundles[scene.key] = {
    meta: {
      poc: 'PoC-04',
      collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      app: {
        name: 'PoC Fixture App',
        port: 3200,
        framework: 'Next.js 16.4.3 (App Router)',
        orm: ['Prisma 6.19.3', 'pg 8.23.1'],
        pages: UI_PAGES_04.map((p) => (p.path === scene.page ? { ...p, current: true } : p)),
      },
      instrumentation: {
        method: '方式2 NODE_OPTIONS=--require ＋ 呼び出し入口での呼び出しスタック記録'
          + ' ＋ ビルド時の要素識別子注入 ＋ **ソースの静的解析による由来の推定**',
        detail: 'プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。'
          + '表示値の由来は、TypeScript の AST と記号解決で参照の連鎖をたどり、'
          + '**実行された SQL の SELECT 句**で列を解決した。'
          + '参照の連鎖そのものは実行時に観測していないため、この関係は推定である',
        bundler: BUNDLER,
      },
      droppedAttributeKeys: [...new Set(spans.flatMap((s) => s.droppedAttributeKeys ?? []))].sort(),
      notObserved: [
        {
          what: '表示値と由来の列の値が一致すること',
          why: '表示された値も取得した行も読んでいない（NFR-20）。'
            + '一致の確認はできないし、一致は十分条件でもない（01b Q-04.0 #3）',
        },
        {
          what: '参照の連鎖が実行時に本当にその通り通ったこと',
          why: 'ソースの形から推定している。条件分岐のどちらを通ったかは観測していない。'
            + 'この関係は構造的に L2 であり、いかなる実装でも昇格しない（02a 3.5.1）',
        },
        {
          what: 'カラムと応答項目の対応づけ（maps）',
          why: 'rsc-direct には応答（JSON）そのものが存在しない。'
            + '対応づける相手のノードが無いため、関係を作らない',
        },
        {
          what: 'props の由来（derives）',
          why: 'derives はレスポンスのキーを始点とする関係である（02a 3.5.1）。'
            + 'rsc-direct にはレスポンスが無いため、この関係は構成できない。'
            + '代わりに `supplies`（描いたコンポーネント → 取得を実行したコンポーネント）を'
            + '静的解析の推定として提案している',
        },
        {
          what: '解析範囲（src/）の外で作られる値の由来',
          why: 'ライブラリの内部まで追わない。追えないものは候補を出さない',
        },
        {
          what: 'コンポーネント単位のサーバー処理のスパン',
          why: 'Next.js の描画スパンはルート単位である（PoC-02 の実測）',
        },
        {
          what: 'SQL の取得件数（行数）',
          why: '使用した計装が行数の属性を付けないため、取得できなかった',
        },
        { what: 'SQL のパラメータ値', why: '方針として収集しない（NFR-20）。取得時点で除去している' },
        {
          what: '本番ビルドでの由来の推定',
          why: 'ソースマップと要素識別子の注入に依存するため、開発ビルドに限る（01b Q-03 C-5）',
        },
      ],
      excluded: {
        staticAssetRequests: obs.excludedAssets,
        note: '静的資材（/_next/*・画像・フォント）は「通信」として数えていない',
      },
    },
    page: { path: scene.page, name: scene.name, startMs: doc.startMs },
    focus: { method: doc.method, path: doc.path },
    browserRequests: obs.records.map(toRequest),
    spans: spans.map((s) => ({
      traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, name: s.name,
      kind: s.kind, startMs: s.startMs, endMs: s.endMs, durationMs: s.durationMs,
      statusCode: s.statusCode, scope: s.scope, attrs: s.attrs,
      droppedAttributeKeys: s.droppedAttributeKeys ?? [],
      service: s.service,
    })),
    sqlAnalyses,
    dbObjects: { tables, columns },
    elements: {
      method: '方式1 ビルド時の要素識別子注入（JSX へ data-vcide を挿入）',
      bundler: BUNDLER,
      injectedScope: 'src/',
      transform: '挿入のみ。再出力しないため行番号はずれない。ソースマップに依存しない',
      page: scene.page,
      anchoredElements: obs.extra.facts.anchoredElements,
      totalElements: obs.extra.facts.totalElements,
      primaryKey: scene.field,
      selections,
      anchors,
      files: manifestFiles.map((f) => ({
        file: f.file, anchors: f.anchors.length, usages: f.usages.length, skipped: f.skipped,
      })),
    },
    rsc: {
      documentSpanId: docSpan.spanId,
      renderSpanId: render.spanId,
      renderRoute: render.attrs['next.route'] ?? null,
      renderSpanName: render.name,
      sql: sqlUnderRender.map((x) => ({
        spanId: x.span.spanId,
        depthFromRender: x.chain.depth,
        callsite: toCallsite(x.span.spanId),
      })),
      exchanges: [],
      browserApiRequests: obs.records.filter((rq) => rq.path.startsWith('/api/')).length,
      overlaps: overlaps(sqlUnderRender.map((x) => x.span)),
      propagation: {
        mode: 'off',
        method: 'サーバー内部の通信はこの題材に無い（DB アクセスは HTTP を経由しない）',
        scope: '—',
      },
      services: [{ name: 'poc01-fixture-app', role: 'app', origin: BASE }],
    },
    lineage,
  };
}

/* ------------------------------------------- 秘密情報・値が入っていないか */
const FORBIDDEN = [
  /postgres(ql)?:\/\//i, /poc01_local_only/, /\bcookie\b/i, /\bauthorization\b/i,
  /\bbearer\b/i, /\bpassword\b/i, /\baccess_token\b/i, /\bsecret\b/i,
  /db\.connection_string"\s*:\s*"[^"]/i,
  /アオバ台|シラカワ野|ミナト浜|ヒガシ丘/,     // 表示された値を保存していないことの検査
  /\/Users\//,                                 // 絶対パスを残さない
  /\btraceparent\s*[:=]\s*"?00-/i,
];
const text = JSON.stringify(bundles);
const hits = FORBIDDEN.filter((re) => re.test(text)).map(String);
if (hits.length) throw new Error(`観測結果に収集禁止の痕跡がある: ${hits.join(', ')}`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'poc04-observation.json'), JSON.stringify(bundles, null, 2));

const ts = `/* =============================================================================
 * 自動生成（poc/runner/build-poc04-observation.mjs）。手で編集しない。
 *
 * PoC-04 で実際に観測した3回の読み込みの記録である。合成データではない。
 *   LIN_A_OBSERVATION  由来を1列に絞れた場合（推定のホップが1本増える）
 *   LIN_C_OBSERVATION  候補が複数のままの場合（1つに断定しない）
 *   LIN_G_OBSERVATION  由来を作らない場合（**切断のまま。線を引かない**）
 *
 * 由来の関係は **static-analysis（L2・推定）** である。
 * 列の解決に実測の SQL を使っているが、参照の連鎖そのものは推定であり、
 * 昇格しない（02a 3.5.1 / observabilityOf）。
 *
 * **表示された値そのもの・取得結果の中身・ヘッダ一覧は含まない。**
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const LIN_A_OBSERVATION: ObservationBundle = ${JSON.stringify(bundles.linA, null, 2)} as const;

export const LIN_C_OBSERVATION: ObservationBundle = ${JSON.stringify(bundles.linC, null, 2)} as const;

export const LIN_G_OBSERVATION: ObservationBundle = ${JSON.stringify(bundles.linG, null, 2)} as const;
`;
fs.writeFileSync(path.join(REPO, 'src', 'data', 'observation.poc04.ts'), ts);

for (const s of UI_SCENES_04) {
  const b = bundles[s.key];
  console.log(`${s.page} (${s.field}): spans=${b.spans.length} sql=${b.rsc.sql.length}`
    + ` attributed=${b.rsc.sql.filter((x) => x.callsite?.component).length}`
    + ` outcome=${b.lineage.outcome} cand=${b.lineage.candidates.length}`
    + ` tbl=${b.lineage.tableCandidates.length}`
    + ` tables=${b.dbObjects.tables.length} columns=${b.dbObjects.columns.length}`);
}
console.log(`→ ${path.join(OUT, 'poc04-observation.json')}`);
console.log('→ src/data/observation.poc04.ts');
