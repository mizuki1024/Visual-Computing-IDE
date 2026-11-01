/* =============================================================================
 * PoC-02 — 観測結果 JSON を作る（IDE のキャンバスへ流し込む入力）。
 *   node poc/runner/build-poc02-observation.mjs
 * 出力:
 *   poc/out/poc02-observation.json
 *   src/data/observation.poc02.ts
 *
 * **2つの経路を別々に観測する。** 1枚の画面に混ぜない。
 *   Gate B  /rsc-db    Server Component → サーバー描画 → SQL → PostgreSQL
 *                      （ブラウザの API 通信は 0 件。API ノードは作らない）
 *   Gate A  /rsc-svc   Server Component → サーバー内部通信 → 別サービス → SQL
 *
 * 作らない関係: derives（props の由来）/ maps（カラムと応答項目）。
 * 証拠が無いものは、線を引かずに切断として残す。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { readRecords, startApp } from './lib/server.mjs';
import { startSvc, SVC_ORIGIN } from './lib/svc.mjs';
import { observePage } from './lib/netobs.mjs';
import { resolveRscAttribution } from './lib/rscattr.mjs';
import { resetSrvMaps } from './lib/srvmap.mjs';
import { ancestryTo, clientSpans, destPathOf, entrySpans, matchByParentage, overlaps, statusOf, treeOf } from './lib/propagate.mjs';
import { INSTALL } from './lib/probe.mjs';
import { UI_PAGES, UI_TARGETS_02 } from './lib/probe02.mjs';
import { lineText, verifyLocation } from './lib/srcverify.mjs';
import { sqlAnalysisRecord } from './lib/sqlparse.mjs';
import { introspectColumns, introspectRowEstimates, introspectTables } from './lib/introspect.mjs';
import { APP, OUT, REPO, sleep } from './lib/util.mjs';

const BASE = 'http://localhost:3200';
const BUNDLER = process.env.POC02_PICK_BUNDLER ?? 'turbopack';
const ANCHORS = path.join(OUT, 'anchors02ui');
const SQL_TEXT = (a) => a['db.statement'] ?? a['db.query.text'] ?? null;

/** 観測する2つの経路 */
const SCENES = [
  {
    key: 'rsc', gate: 'Gate B', page: '/rsc-db', name: '直読み（1本）',
    renderRoute: '/rsc-db', withElements: true, focusExchange: null,
  },
  {
    key: 'rscSvc', gate: 'Gate A', page: '/rsc-svc', name: '別サービスへの通信',
    renderRoute: '/rsc-svc', withElements: false, focusExchange: '/rows',
  },
];

const INSTR = path.join(APP, 'src', 'instrumentation.ts');
const PARKED = `${INSTR}.parked`;
const park = () => { if (fs.existsSync(INSTR)) fs.renameSync(INSTR, PARKED); };
const unpark = () => { if (fs.existsSync(PARKED)) fs.renameSync(PARKED, INSTR); };

/** 要素識別子の対応表（ビルド時に書かれる）。コンポーネント範囲も持つ */
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
let svc;
const observed = {};
let records;
try {
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  fs.rmSync(ANCHORS, { recursive: true, force: true });
  svc = await startSvc({ run: 'poc02-observation', undici: true, callsite: true });
  app = await startApp({
    mode: 'method2', bundler: BUNDLER, run: 'poc02-observation',
    env: {
      POC02_UNDICI: '1', POC02_CALLSITE: '1', POC02_SVC_ORIGIN: SVC_ORIGIN,
      POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCHORS,
      POC05_TRACE_HEADER: '1', POC05_SELF_ORIGIN: BASE,
    },
  });
  // 2回捨てる。初回コンパイルと接続確立のスパンを観測対象に混ぜない
  for (let i = 0; i < 2; i++) {
    for (const s of SCENES) await observePage(BASE, s.page, null, { settleMs: 900 });
  }
  fs.writeFileSync(app.spanFile, '');
  fs.writeFileSync(svc.spanFile, '');
  resetSrvMaps();

  for (const s of SCENES) {
    observed[s.key] = await observePage(BASE, s.page, s.withElements
      ? async (p) => {
        /* 表示された値の選択（PoC-03 の機構。値そのものは読まない） */
        await p.evaluate(INSTALL);
        const facts = {
          anchoredElements: await p.evaluate('document.querySelectorAll("[data-vcide]").length'),
          totalElements: await p.evaluate('document.querySelectorAll("*").length'),
        };
        const picks = [];
        for (const t of UI_TARGETS_02.filter((x) => x.page === s.page)) {
          const found = await p.evaluate(
            `(() => { const l = document.querySelectorAll(${JSON.stringify(t.sel)});
               const el = l[${t.ord}]; if (!el) return false;
               el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`,
          );
          picks.push({ ...t, pick: found ? await p.evaluate('window.__vcidePick') : { found: false } });
        }
        return { facts, picks };
      }
      : null, { settleMs: 1500 });
    await sleep(300);
  }
  await sleep(1500);
  const appRec = readRecords(app.spanFile, 'poc01-fixture-app');
  const svcRec = readRecords(svc.spanFile, 'poc02-fixture-svc');
  records = {
    spans: [...appRec.spans, ...svcRec.spans],
    callsites: [...appRec.callsites, ...svcRec.callsites],
  };
} finally {
  if (app) await app.stop();
  if (svc) await svc.stop();
  unpark();
}

/* ------------------------------------------------------------------ 変換 */
const { byId: anchorById, components, files: manifestFiles } = readManifest();
const allSpans = records.spans;
const callsiteBySpan = new Map(records.callsites.map((c) => [c.spanId, c]));
const allEntries = entrySpans(allSpans);
const allClients = clientSpans(allSpans);

const toCallsite = (spanId) => {
  const cs = callsiteBySpan.get(spanId);
  if (!cs) return null;
  const a = resolveRscAttribution(cs, components);
  return {
    at: a.at,
    frame: a.frame,
    verified: a.verified,
    sourceLine: a.sourceLine,
    component: a.component,
    appFrameAtSpanStart: a.appFrameAtSpanStart,
    failure: a.failure,
  };
};

const bundles = {};
for (const scene of SCENES) {
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

  /* ---- 描画スパンの子孫である SQL（同一トレースにあるだけでは採らない） ---- */
  const sqlUnderRender = inTrace
    .filter((s) => SQL_TEXT(s.attrs))
    .map((s) => ({ span: s, chain: ancestryTo(byId, s, render.spanId) }))
    .filter((x) => x.chain)
    .sort((a, b) => a.span.startMs - b.span.startMs);

  /* ---- サーバー内部の通信（client スパン）と、その相手側 ---- */
  const exchanges = allClients
    .filter((s) => s.traceId === traceId)
    .sort((a, b) => a.startMs - b.startMs)
    .map((client) => {
      const m = matchByParentage(client, allEntries);
      const entry = m.entry;
      const entryTree = entry ? treeOf(allSpans, entry.traceId) : null;
      const sqlSpanIds = entry
        ? entryTree.inTrace
          .filter((s) => SQL_TEXT(s.attrs) && ancestryTo(entryTree.byId, s, entry.spanId))
          .sort((a, b) => a.startMs - b.startMs)
          .map((s) => s.spanId)
        : [];
      return {
        clientSpanId: client.spanId,
        destPath: destPathOf(client) ?? '',
        destHost: client.attrs['server.address'] ?? null,
        destPort: client.attrs['server.port'] ?? null,
        status: statusOf(client) ?? null,
        entrySpanId: entry?.spanId ?? null,
        propagationFailure: m.reason,
        crossProcess: entry ? entry.service !== client.service : null,
        entryService: entry?.service ?? null,
        sqlSpanIds,
        callsite: toCallsite(client.spanId),
      };
    });

  /* ---- 変換に必要なスパンだけを集める（主経路の外は入れない） ---- */
  const keep = new Map();
  for (const s of inTrace) keep.set(s.spanId, s);
  for (const e of exchanges) {
    if (!e.entrySpanId) continue;
    const t = treeOf(allSpans, allSpans.find((s) => s.spanId === e.entrySpanId).traceId);
    for (const s of t.inTrace) keep.set(s.spanId, s);
  }
  const spans = [...keep.values()].sort((a, b) => a.startMs - b.startMs);

  /* ---- 実測SQLの構文解析 ---- */
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

  /* ---- 要素識別子の解決（Gate B のページだけ） ---- */
  let elements;
  if (scene.withElements) {
    const selections = [];
    const anchors = [];
    for (const t of obs.extra.picks) {
      const r = resolveElement(t.pick, anchorById);
      if (r.anchor && !anchors.some((a) => a.id === r.anchor.id)) anchors.push(r.anchor);
      selections.push({
        key: t.key, selector: t.sel, ordinal: t.ord, group: t.group, primary: !!t.primary,
        tag: t.pick.found ? t.pick.tag : null,
        anchorOnSelf: t.pick.anchorOnSelf ?? null,
        anchorOrdinal: t.pick.anchorOrdinal ?? null,
        anchorInstanceCount: t.pick.anchorInstanceCount ?? 0,
        ancestorAnchors: (t.pick.ancestorAnchors ?? []).filter((a) => !a.self).map((a) => a.id),
        textNodeIndex: t.pick.textNodeIndex ?? null,
        valueShape: t.pick.valueShape ?? null,
        failure: r.failure ?? null,
      });
    }
    if (!selections.find((s) => s.primary)?.anchorOnSelf) {
      throw new Error('主対象の要素識別子が取れなかった');
    }
    elements = {
      method: '方式1 ビルド時の要素識別子注入（JSX へ data-vcide を挿入）',
      bundler: BUNDLER,
      injectedScope: 'src/',
      transform: '挿入のみ。再出力しないため行番号はずれない。ソースマップに依存しない',
      page: scene.page,
      anchoredElements: obs.extra.facts.anchoredElements,
      totalElements: obs.extra.facts.totalElements,
      primaryKey: UI_TARGETS_02.find((t) => t.primary && t.page === scene.page).key,
      selections,
      anchors,
      files: manifestFiles.map((f) => ({
        file: f.file, anchors: f.anchors.length, usages: f.usages.length, skipped: f.skipped,
      })),
    };
  }

  const toRequest = (r) => ({
    method: r.method, path: r.path, status: r.status ?? 0,
    startMs: r.startMs, durationMs: r.durationMs, server: r.server,
    isDocument: !!r.isDocument,
    browserRequestId: r.browserRequestId,
    via: r.via, headersAgree: r.headersAgree, readHeaderKeys: r.readHeaderKeys,
    failure: r.failure ?? null,
    hasQuery: !!r.hasQuery,
    crossOrigin: r.external ? r.origin : null,
    /* ブラウザは文書取得の呼び出し元を記録しない（PoC-05 第3章 #4） */
    initiator: r.isDocument
      ? {
        type: r.initiator?.type ?? null, frameCount: 0, frame: null, verified: false,
        sourceLine: null, component: null,
        failure: { reason: 'no-script-stack', detail: `initiator.type=${r.initiator?.type ?? 'null'}` },
      }
      : null,
  });

  bundles[scene.key] = {
    meta: {
      poc: 'PoC-02',
      collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      app: {
        name: 'PoC Fixture App',
        port: 3200,
        framework: 'Next.js 16.4.3 (App Router)',
        orm: ['Prisma 6.19.3', 'pg 8.23.1'],
        pages: UI_PAGES.map((p) => (p.path === scene.page ? { ...p, current: true } : p)),
      },
      instrumentation: {
        method: '方式2 NODE_OPTIONS=--require ＋ undici 計装による W3C 伝播'
          + ' ＋ 呼び出し入口での呼び出しスタック記録 ＋ ビルド時の要素識別子注入',
        detail: 'プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。'
          + 'サーバー内部の通信は undici の計装で client スパンを作り、'
          + 'ループバック宛にのみ W3C traceparent を注入した。'
          + 'データ取得の実行元は、呼び出しの入口（Pool.query / globalThis.fetch）で'
          + '取った呼び出しスタックを、ソースマップで元の位置へ戻して照合した',
        bundler: BUNDLER,
      },
      droppedAttributeKeys: [...new Set(spans.flatMap((s) => s.droppedAttributeKeys ?? []))].sort(),
      notObserved: [
        {
          what: 'props の由来（derives）',
          why: '取得した結果のどの項目が、画面のどの値になったかは観測できない。'
            + '02a 3.5.1 により構造的に推定であり、関係を作らない',
        },
        {
          what: 'カラムと応答項目の対応づけ（maps）',
          why: '確認には取得結果の中身の読み取りが必要で、収集禁止項目にあたるため行わなかった',
        },
        {
          what: 'コンポーネント単位のサーバー処理のスパン',
          why: 'Next.js の描画スパンはルート単位である。コンポーネント単位のスパンは'
            + '存在しないため、スパンの親子関係だけでは特定のコンポーネントへ帰属できない。'
            + '帰属は呼び出しスタックという別の証拠で行っている',
        },
        {
          what: 'スパン開始時のスタックによる実行元',
          why: 'SQL スパンは接続プールが空いた時点のコールバックの中で作られるため、'
            + 'スパン開始時のスタックには呼び出した側のフレームが無い（実測）。'
            + 'そのため呼び出しの入口で取ったスタックだけを根拠にしている',
        },
        {
          what: '文書取得の呼び出し元',
          why: 'ブラウザはナビゲーションの呼び出しスタックを記録しない（initiator.type=other）',
        },
        {
          what: 'SQL の取得件数（行数）',
          why: '使用した計装が行数の属性を付けないため、取得できなかった',
        },
        { what: 'SQL のパラメータ値', why: '方針として収集しない（NFR-20）。取得時点で除去している' },
        {
          what: 'トレースコンテキストの値',
          why: '受け側が「付いていたか」の真偽だけを記録した。値そのものは保存していない',
        },
        {
          what: '本番ビルドでの実行元',
          why: 'ソースマップと要素識別子の注入に依存するため、開発ビルドに限る（01b Q-03 C-5）',
        },
      ],
      excluded: {
        staticAssetRequests: obs.excludedAssets,
        note: '静的資材（/_next/*・画像・フォント）は「通信」として数えていない',
      },
    },
    page: { path: scene.page, name: scene.name, startMs: doc.startMs },
    /* rsc-direct にはブラウザ側の API 通信が無い。focus は文書取得そのものである */
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
    ...(elements ? { elements } : {}),
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
      exchanges,
      ...(scene.focusExchange ? { focusExchange: scene.focusExchange } : {}),
      browserApiRequests: obs.records.filter((r) => r.path.startsWith('/api/')).length,
      overlaps: overlaps(sqlUnderRender.map((x) => x.span)),
      propagation: {
        mode: 'on',
        method: 'undici 計装が W3C Trace Context（traceparent）を注入し、'
          + '受け側の HTTP 計装がそれを取り出して入口スパンの親にする',
        scope: 'ループバック宛の要求にだけ注入する。それ以外の宛先は計装しないため、'
          + 'スパンも作られず traceparent も付かない',
      },
      services: [
        { name: 'poc01-fixture-app', role: 'app', origin: BASE },
        { name: 'poc02-fixture-svc', role: 'svc', origin: SVC_ORIGIN },
      ],
    },
  };
}

/* ------------------------------------------- 秘密情報・値が入っていないか */
const FORBIDDEN = [
  /postgres(ql)?:\/\//i, /poc01_local_only/, /\bcookie\b/i, /\bauthorization\b/i,
  /\bbearer\b/i, /\bpassword\b/i, /\baccess_token\b/i, /\bsecret\b/i,
  /db\.connection_string"\s*:\s*"[^"]/i,
  /アオバ台|シラカワ野|ミナト浜|ヒガシ丘/,     // 表示された値を保存していないことの検査
  /\/Users\//,                                 // 絶対パスを残さない
  /\btraceparent\s*[:=]\s*"?00-/i,             // トレースコンテキストの値を残さない
];
const text = JSON.stringify(bundles);
const hits = FORBIDDEN.filter((re) => re.test(text)).map(String);
if (hits.length) throw new Error(`観測結果に収集禁止の痕跡がある: ${hits.join(', ')}`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'poc02-observation.json'), JSON.stringify(bundles, null, 2));

const ts = `/* =============================================================================
 * 自動生成（poc/runner/build-poc02-observation.mjs）。手で編集しない。
 *
 * PoC-02 で実際に観測した2回の読み込みの記録である。合成データではない。
 *   RSC_OBSERVATION      Gate B — Server Component がサーバー内部で直接 DB を読む
 *   RSC_SVC_OBSERVATION  Gate A — サーバーから別のサーバーへの通信（W3C 伝播）
 *
 * **表示された値そのもの・取得結果の中身・ヘッダ一覧・トレースコンテキストの値は
 * 含まない。** 相関のために読んだ応答ヘッダは2つのキーだけである。
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const RSC_OBSERVATION: ObservationBundle = ${JSON.stringify(bundles.rsc, null, 2)} as const;

export const RSC_SVC_OBSERVATION: ObservationBundle = ${JSON.stringify(bundles.rscSvc, null, 2)} as const;
`;
fs.writeFileSync(path.join(REPO, 'src', 'data', 'observation.poc02.ts'), ts);

for (const s of SCENES) {
  const b = bundles[s.key];
  console.log(`${s.gate} ${s.page}: spans=${b.spans.length} sql=${b.rsc.sql.length}`
    + ` exchanges=${b.rsc.exchanges.length} browserApi=${b.rsc.browserApiRequests}`
    + ` attributed=${b.rsc.sql.filter((x) => x.callsite?.component).length}`
    + ` tables=${b.dbObjects.tables.length} columns=${b.dbObjects.columns.length}`);
}
console.log(`→ ${path.join(OUT, 'poc02-observation.json')}`);
console.log('→ src/data/observation.poc02.ts');
