/* =============================================================================
 * PoC-05 — 観測結果 JSON を作る（IDE のキャンバスへ流し込む入力）。
 *   node poc/runner/build-poc05-observation.mjs
 * 出力:
 *   poc/out/poc05-observation.json
 *   src/data/observation.poc05.ts
 *
 * **1回の操作（ボタン1つ）・1つのアプリから** 次をまとめて観測する。
 *   ブラウザ側  通信の識別情報・通信を開始したコード（PoC-05）
 *               表示された値 → DOM要素 → コンポーネント（PoC-03 の機構）
 *   サーバー側  サーバー処理 → 実行SQL → テーブル → カラム（PoC-01 の機構）
 *
 * 作らない関係: derives（props の由来）/ maps（カラムと応答項目）。
 * 証拠が無いものは、線を引かずに切断として残す。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { readSpans, startApp } from './lib/server.mjs';
import { observePage } from './lib/netobs.mjs';
import { makeFetcher, resolveInitiator } from './lib/initiator.mjs';
import { matchByIdentity } from './lib/correlate.mjs';
import { INSTALL } from './lib/probe.mjs';
import { UI_TARGETS } from './lib/probe05.mjs';
import { lineText, verifyLocation } from './lib/srcverify.mjs';
import { sqlAnalysisRecord } from './lib/sqlparse.mjs';
import { introspectColumns, introspectRowEstimates, introspectTables } from './lib/introspect.mjs';
import { APP, OUT, REPO, sleep } from './lib/util.mjs';

const BASE = 'http://localhost:3200';
const ALT = 'http://127.0.0.1:3200';
const BUNDLER = process.env.POC05_PICK_BUNDLER ?? 'turbopack';
const MODE = 'method2';
const PAGE = '/flows';
const FOCUS = { method: 'GET', path: '/api/listings' };
const ANCHORS = path.join(OUT, 'anchors05ui');
const SQL_TEXT = (a) => a['db.statement'] ?? a['db.query.text'] ?? null;

const INSTR = path.join(APP, 'src', 'instrumentation.ts');
const PARKED = `${INSTR}.parked`;
const park = () => { if (fs.existsSync(INSTR)) fs.renameSync(INSTR, PARKED); };
const unpark = () => { if (fs.existsSync(PARKED)) fs.renameSync(PARKED, INSTR); };

/** 要素識別子の対応表（ビルド時に書かれる）。コンポーネント範囲も持つ */
function readManifest() {
  const byId = new Map();
  const components = new Map();
  const files = [];
  for (const f of fs.readdirSync(ANCHORS)) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(ANCHORS, f), 'utf8'));
    files.push(j);
    for (const a of j.anchors) byId.set(a.id, a);
    if (j.components?.length) components.set(j.file, j.components);
  }
  return { byId, components, files };
}

/**
 * 選択された要素1つの出所を解く。**その要素自身の識別子だけ**を出所にする
 * （祖先の識別子は文脈であって出所ではない — PoC-03 の中心的な規則）。
 */
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
let obs;
let spans;
try {
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  fs.rmSync(ANCHORS, { recursive: true, force: true });
  app = await startApp({
    mode: MODE, bundler: BUNDLER, run: 'poc05-observation',
    env: {
      POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCHORS,
      POC05_TRACE_HEADER: '1', POC05_SELF_ORIGIN: BASE,
    },
  });
  // 2回捨てる。初回コンパイルと接続確立のスパンを観測対象に混ぜない
  for (let i = 0; i < 2; i++) {
    await observePage(BASE, PAGE, async (p) => { await p.click('#btn-one'); }, { settleMs: 1200 });
  }
  fs.writeFileSync(app.spanFile, '');

  obs = await observePage(BASE, PAGE, async (p) => {
    // 1回の操作で1件の通信を起こす。主経路をあいまいにしない
    await p.click('#btn-one');
    await p.waitForSelector('article.card', { timeout: 30000 });
    await p.waitForTimeout(400);

    // 表示された値の選択（PoC-03 の機構。値そのものは読まない）
    await p.evaluate(INSTALL);
    const facts = {
      anchoredElements: await p.evaluate('document.querySelectorAll("[data-vcide]").length'),
      totalElements: await p.evaluate('document.querySelectorAll("*").length'),
    };
    const picks = [];
    for (const t of UI_TARGETS) {
      const found = await p.evaluate(
        `(() => { const l = document.querySelectorAll(${JSON.stringify(t.sel)});
           const el = l[${t.ord}]; if (!el) return false;
           el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`,
      );
      picks.push({ ...t, pick: found ? await p.evaluate('window.__vcidePick') : { found: false } });
    }

    // 識別子の公開範囲（第5節）。値は持ち出さず、読めたかどうかだけを数える
    const cross = await p.evaluate(`(async () => {
      try {
        const r = await fetch('${ALT}/api/cors');
        return { ok: r.ok, serverTiming: r.headers.get('server-timing') !== null,
          dedicated: r.headers.get('x-vcide-trace') !== null };
      } catch (e) { return { error: String(e).slice(0, 120) }; }
    })()`);
    await p.waitForTimeout(300);
    const timing = await p.evaluate(`(() => {
      const rs = performance.getEntriesByType('resource');
      let own = 0; let withSt = 0; let dedicated = 0;
      for (const r of rs) {
        let origin = null; try { origin = new URL(r.name).origin; } catch {}
        if (origin === '${BASE}') own++;
        const st = r.serverTiming || [];
        if (st.some((s) => s.name === 'traceparent' && !!s.description)) withSt++;
        if (st.some((s) => s.name === 'x-vcide-trace')) dedicated++;
      }
      return { entries: rs.length, own, withSt, dedicated };
    })()`);
    return { facts, picks, cross, timing };
  }, { settleMs: 1500, resolve: async (records, { scriptSource }) => {
    const fetcher = makeFetcher(scriptSource);
    const { components } = readManifest();
    const out = {};
    for (const r of records) out[r.browserRequestId] = await resolveInitiator(r, fetcher, BASE, components);
    return out;
  } });
  await sleep(1500);
  ({ spans } = readSpans(app.spanFile));
} finally {
  if (app) await app.stop();
  unpark();
}

/* ------------------------------------------------------- 対応付け（A / B） */
const focus = obs.records.find((r) => r.method === FOCUS.method && r.path === FOCUS.path);
if (!focus) throw new Error(`focus request not observed: ${FOCUS.method} ${FOCUS.path}`);
if (!focus.server) throw new Error('応答ヘッダからトレース識別子を読めなかった');

const bySpanId = new Map(spans.map((s) => [s.spanId, s]));
const match = matchByIdentity(focus, bySpanId);
if (!match.span) throw new Error(`サーバー側スパンへ対応付けられなかった: ${match.reason}`);

const traceId = match.span.traceId;
const inTrace = spans.filter((s) => s.traceId === traceId);
const docReq = obs.records.find((r) => r.path === PAGE && r.isDocument);
const initiator = obs.resolved[focus.browserRequestId] ?? null;

/* ----------------------------------------------------- 要素識別子の解決 */
const { byId, files: manifestFiles } = readManifest();
const selections = [];
const anchors = [];
for (const t of obs.extra.picks) {
  const r = resolveElement(t.pick, byId);
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
const primarySel = selections.find((s) => s.primary);
if (!primarySel?.anchorOnSelf) throw new Error('主対象の要素識別子が取れなかった');

/* ------------------------------------------------- 実測SQLの構文解析 */
const sqlAnalyses = [];
for (const s of inTrace) {
  const sql = SQL_TEXT(s.attrs);
  if (!sql) continue;
  sqlAnalyses.push(sqlAnalysisRecord({ spanId: s.spanId, sql, redacted: s.sqlRedacted ?? null }));
}

/* ------------------------------------------------- 情報スキーマ（定義のみ） */
const wantedTables = new Set(sqlAnalyses.flatMap((a) => a.tables.map((t) => t.name)));
const rowEst = introspectRowEstimates('poc');
const tables = introspectTables('poc')
  .filter((t) => wantedTables.has(t.name))
  .map((t) => ({ ...t, rowEstimate: rowEst[t.name] ?? null }));
const wantedCols = new Set(sqlAnalyses.flatMap((a) => a.projections.map((p) => `${p.table}.${p.column}`)));
const columns = introspectColumns('poc').filter((c) => wantedCols.has(`${c.table}.${c.column}`));

/* ------------------------------------------------------------- 観測結果 */
const toRequest = (r) => ({
  method: r.method, path: r.path, status: r.status ?? 0,
  startMs: r.startMs, durationMs: r.durationMs, server: r.server,
  isDocument: !!r.isDocument,
  browserRequestId: r.browserRequestId,
  via: r.via, headersAgree: r.headersAgree, readHeaderKeys: r.readHeaderKeys,
  redirects: (r.redirects ?? []).map((h) => ({ path: h.path, status: h.status, server: h.server, via: h.via })),
  failure: r.failure ?? null,
  hasQuery: !!r.hasQuery,
  crossOrigin: r.external ? r.origin : null,
  initiator: obs.resolved[r.browserRequestId] ?? null,
});

const bundle = {
  meta: {
    poc: 'PoC-05',
    collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    app: {
      name: 'PoC Fixture App',
      port: 3200,
      framework: 'Next.js 16.4.3 (App Router)',
      orm: ['Prisma 6.19.3', 'pg 8.23.1'],
      pages: [
        { icon: '⌂', name: 'ホーム', path: '/' },
        { icon: '▣', name: '物件一覧', path: '/listings' },
        { icon: '▤', name: '物件カード', path: '/cards' },
        { icon: '◈', name: '通信の経路', path: '/flows', current: true },
        { icon: '◇', name: '通信の経路（サーバー描画）', path: '/flows-rsc' },
      ],
    },
    instrumentation: {
      method: '方式2 NODE_OPTIONS=--require ＋ 応答ヘッダへの識別子 ＋ ビルド時の要素識別子注入',
      detail: 'プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。'
        + 'ブラウザとサーバーの対応付けは応答の専用ヘッダに載せた識別子の一致で行い、'
        + '通信を開始したコードはブラウザが記録した呼び出しスタックから解いた',
      bundler: BUNDLER,
    },
    droppedAttributeKeys: [...new Set(inTrace.flatMap((s) => s.droppedAttributeKeys ?? []))].sort(),
    notObserved: [
      { what: 'props の由来（derives）',
        why: 'この通信の応答のどの項目が、画面のどの値になったかは観測できない。'
          + '02a 3.5.1 により構造的に推定であり、関係を作らない' },
      { what: 'カラムと応答項目の対応づけ（maps）',
        why: '確認にはレスポンス本文の読み取りが必要で、収集禁止項目にあたるため行わなかった' },
      { what: '表示された値そのもの',
        why: '方針として保存しない。対応付けは要素識別子・同一識別子内の順番・'
          + 'テキストノード索引で行い、値を鍵に使わない' },
      { what: 'ブラウザからサーバーへのトレース伝播',
        why: 'ブラウザ側に計装を入れないため、要求に traceparent を載せていない。'
          + 'サーバー側の入口スパンはすべて根であり、対応付けは応答側で行っている' },
      { what: 'サーバーの中で起きる通信の相手（Server Component の fetch）',
        why: 'Next.js の fetch は node:http を通らず、要求にトレースコンテキストが'
          + '載らない。呼び出し側のスパンは観測できるが、相手のハンドラは別トレースになる' },
      { what: '応答が返らなかった通信のサーバー側',
        why: '識別子は応答ヘッダから読む。応答が無い通信は対応付けられない。'
          + '時間の重なりで推定することはしない' },
      { what: 'SQL の取得件数（行数）', why: '使用した計装が行数の属性を付けないため、取得できなかった' },
      { what: 'SQL のパラメータ値', why: '方針として収集しない（NFR-20）。取得時点で除去している' },
      { what: 'どの使用箇所がこのインスタンスを描いたか',
        why: '同じコンポーネントが複数箇所で使われる場合、DOM からは使用箇所を一意に決められない' },
    ],
    excluded: {
      staticAssetRequests: obs.excludedAssets,
      note: '静的資材（/_next/*・画像・フォント）は「通信」として数えていない',
    },
  },
  page: { path: PAGE, name: '通信の経路', startMs: docReq?.startMs ?? focus.startMs },
  focus: FOCUS,
  browserRequests: obs.records.map(toRequest),
  spans: inTrace.map((s) => ({
    traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, name: s.name,
    kind: s.kind, startMs: s.startMs, endMs: s.endMs, durationMs: s.durationMs,
    statusCode: s.statusCode, scope: s.scope, attrs: s.attrs,
    droppedAttributeKeys: s.droppedAttributeKeys ?? [],
  })),
  sqlAnalyses,
  dbObjects: { tables, columns },
  elements: {
    method: '方式1 ビルド時の要素識別子注入（JSX へ data-vcide を挿入）',
    bundler: BUNDLER,
    injectedScope: 'src/',
    transform: '挿入のみ。再出力しないため行番号はずれない。ソースマップに依存しない',
    page: PAGE,
    anchoredElements: obs.extra.facts.anchoredElements,
    totalElements: obs.extra.facts.totalElements,
    primaryKey: UI_TARGETS.find((t) => t.primary).key,
    selections,
    anchors,
    files: manifestFiles.map((f) => ({
      file: f.file, anchors: f.anchors.length, usages: f.usages.length, skipped: f.skipped,
    })),
  },
  exposure: {
    serverTimingVisibleToPageScript: obs.extra.timing.withSt,
    resourceEntries: obs.extra.timing.entries,
    dedicatedHeaderVisibleToPageScript: obs.extra.timing.dedicated > 0,
    crossOrigin: {
      origin: ALT,
      serverTimingReadable: obs.extra.cross.serverTiming === true,
      dedicatedReadable: obs.extra.cross.dedicated === true,
    },
    readableViaCdp: !!obs.records.find((r) => r.path === '/api/cors')?.server,
  },
};

/* ------------------------------------------- 秘密情報・値が入っていないか */
const FORBIDDEN = [
  /postgres(ql)?:\/\//i, /poc01_local_only/, /\bcookie\b/i, /\bauthorization\b/i,
  /\bbearer\b/i, /\bpassword\b/i, /\baccess_token\b/i, /\bsecret\b/i,
  /db\.connection_string"\s*:\s*"[^"]/i,
  /アオバ台|シラカワ野|ミナト浜|ヒガシ丘/,     // 表示された値を保存していないことの検査
  /\/Users\//,                                 // 絶対パスを残さない
];
const text = JSON.stringify(bundle);
const hits = FORBIDDEN.filter((re) => re.test(text)).map(String);
if (hits.length) throw new Error(`観測結果に収集禁止の痕跡がある: ${hits.join(', ')}`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'poc05-observation.json'), JSON.stringify(bundle, null, 2));

const ts = `/* =============================================================================
 * 自動生成（poc/runner/build-poc05-observation.mjs）。手で編集しない。
 *
 * PoC-05 で実際に観測した1回の操作の記録である。合成データではない。
 * **表示された値そのもの・レスポンス本文・ヘッダ一覧は含まない。**
 * 相関のために読んだ応答ヘッダは2つのキーだけである。
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const FLOW_OBSERVATION: ObservationBundle = ${JSON.stringify(bundle, null, 2)} as const;
`;
fs.writeFileSync(path.join(REPO, 'src', 'data', 'observation.poc05.ts'), ts);

console.log(`focus=${FOCUS.method} ${FOCUS.path} span=${match.span.spanId}`
  + ` initiator=${initiator?.component?.name ?? 'なし'}@${initiator?.frame?.file ?? '-'}:${initiator?.frame?.line ?? '-'}`
  + ` requests=${obs.records.length} spans=${inTrace.length} sql=${sqlAnalyses.length}`
  + ` tables=${tables.length} columns=${columns.length}`
  + ` selections=${selections.length}`);
console.log(`→ ${path.join(OUT, 'poc05-observation.json')}`);
console.log('→ src/data/observation.poc05.ts');
