/* =============================================================================
 * PoC-03 — 観測結果 JSON を作る（IDE のキャンバスへ流し込む入力）。
 *   node poc/runner/build-element-observation.mjs
 * 出力:
 *   poc/out/element-observation.json
 *   src/data/observation.poc03.ts
 *
 * **1回の読み込み・1つのアプリから** 次の両方を観測する。
 *   ブラウザ側  表示された値 → DOM要素 → コンポーネント → ソース位置（PoC-03）
 *   サーバー側  通信 → サーバー処理 → 実行SQL → テーブル → カラム（PoC-01 の機構）
 * 両者を結ぶ関係（derives / requests）は観測していない。作らない。
 *
 * 収集しないもの: 表示された値そのもの / DOM の全文 / Cookie / 認証情報 /
 * SQL のパラメータ値 / 行データ / 本文。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { readSpans, startApp } from './lib/server.mjs';
import { drivePages } from './lib/drive.mjs';
import { INSTALL, TARGETS } from './lib/probe.mjs';
import { lineText, verifyLocation } from './lib/srcverify.mjs';
import { sqlAnalysisRecord } from './lib/sqlparse.mjs';
import { introspectColumns, introspectRowEstimates, introspectTables } from './lib/introspect.mjs';
import { APP, OUT, REPO, sleep } from './lib/util.mjs';

const BUNDLER = process.env.POC03_PICK_BUNDLER ?? 'turbopack';
const MODE = 'method2';                 // 非追加(b): プロジェクトへファイルを足さない
const PAGE = '/cards';
const FOCUS = { method: 'GET', path: '/api/listings' };
/** キャンバスの主経路の起点にする要素 */
const PRIMARY = TARGETS.find((t) => t.primary);
/** 観測結果に載せる要素（/cards のものだけ。必須ケースを網羅する） */
const PICKED = TARGETS.filter((t) => t.page === PAGE);

const ANCHOR_OUT = path.join(OUT, 'anchors');
const SQL_TEXT = (a) => a['db.statement'] ?? a['db.query.text'] ?? null;

/* 非追加(b) の確認: 方式2 の計測中は instrumentation.ts を退避する */
const INSTR = path.join(APP, 'src', 'instrumentation.ts');
const PARKED = `${INSTR}.parked`;
const park = () => { if (fs.existsSync(INSTR)) fs.renameSync(INSTR, PARKED); };
const unpark = () => { if (fs.existsSync(PARKED)) fs.renameSync(PARKED, INSTR); };

/** ページ上で、指定した要素をクリックして対応付けの鍵を取る */
async function pickAll(page) {
  await page.evaluate(INSTALL);
  const facts = {
    anchoredElements: await page.evaluate('document.querySelectorAll("[data-vcide]").length'),
    totalElements: await page.evaluate('document.querySelectorAll("*").length'),
  };
  const picks = [];
  for (const t of PICKED) {
    const ok = await page.evaluate(
      `(() => { const l = document.querySelectorAll(${JSON.stringify(t.sel)});
         const el = l[${t.ord}]; if (!el) return false;
         el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`,
    );
    picks.push({ key: t.key, sel: t.sel, ord: t.ord, group: t.group, primary: !!t.primary,
      pick: ok ? await page.evaluate('window.__vcidePick') : { found: false } });
  }
  return { facts, picks };
}

/* ------------------------------------------------------------------ 観測 */
park();
let app;
let browser;
let spans;
try {
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  fs.rmSync(ANCHOR_OUT, { recursive: true, force: true });
  app = await startApp({
    mode: MODE, bundler: BUNDLER, run: 'poc03-observation',
    env: { POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCHOR_OUT },
  });
  // 2回捨てる。初回コンパイルと接続確立のスパンを観測対象に混ぜない
  await drivePages([PAGE], { waitFor: 'article.card' });
  await drivePages([PAGE], { waitFor: 'article.card' });
  fs.writeFileSync(app.spanFile, '');
  browser = await drivePages([PAGE], { waitFor: 'article.card', after: pickAll });
  await sleep(1500);
  ({ spans } = readSpans(app.spanFile));
} finally {
  if (app) await app.stop();
  unpark();
}

const page = browser[0];
const focus = page.requests.find((r) => r.method === FOCUS.method && r.path === FOCUS.path);
if (!focus) throw new Error(`focus request not observed: ${FOCUS.method} ${FOCUS.path}`);
if (!focus.server) throw new Error('Server-Timing からトレースIDを読めなかった');

const traceId = focus.server.traceId;
const inTrace = spans.filter((s) => s.traceId === traceId);
const docReq = page.requests.find((r) => r.path === PAGE);

/* ----------------------------------------------------- 要素識別子の解決 */
const byId = new Map();
const manifestFiles = [];
for (const f of fs.readdirSync(ANCHOR_OUT)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(fs.readFileSync(path.join(ANCHOR_OUT, f), 'utf8'));
  manifestFiles.push(j);
  for (const a of j.anchors) byId.set(a.id, a);
}

/** 要素自身の識別子だけを出所として扱う。祖先は文脈にすぎない */
function resolveOne(p) {
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

const selections = [];
const anchors = [];
for (const { key, sel, ord, group, primary, pick } of browser[0].extra.picks) {
  const r = resolveOne(pick);
  if (r.anchor && !anchors.some((a) => a.id === r.anchor.id)) anchors.push(r.anchor);
  selections.push({
    key, selector: sel, ordinal: ord, group, primary,
    tag: pick.found ? pick.tag : null,
    anchorOnSelf: pick.anchorOnSelf ?? null,
    anchorOrdinal: pick.anchorOrdinal ?? null,
    anchorInstanceCount: pick.anchorInstanceCount ?? 0,
    ancestorAnchors: (pick.ancestorAnchors ?? []).filter((a) => !a.self).map((a) => a.id),
    textNodeIndex: pick.textNodeIndex ?? null,
    valueShape: pick.valueShape ?? null,
    failure: r.failure ?? null,
  });
}
const primarySel = selections.find((s) => s.primary);
if (!primarySel || !primarySel.anchorOnSelf) throw new Error('主対象の要素識別子が取れなかった');

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
const bundle = {
  meta: {
    poc: 'PoC-03',
    collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    app: {
      name: 'PoC Fixture App',
      port: 3200,
      framework: 'Next.js 16.4.3 (App Router)',
      orm: ['Prisma 6.19.3', 'pg 8.23.1'],
      pages: [
        { icon: '⌂', name: 'ホーム', path: '/' },
        { icon: '▣', name: '物件一覧', path: '/listings' },
        { icon: '▤', name: '物件カード', path: '/cards', current: true },
        { icon: '▥', name: '物件カード（サーバー描画）', path: '/cards-rsc' },
      ],
    },
    instrumentation: {
      method: '方式2 NODE_OPTIONS=--require ＋ 方式1 ビルド時の要素識別子注入',
      detail: 'プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。'
        + '要素識別子はバンドラのローダで JSX へ注入した（src/ のみ）',
      bundler: BUNDLER,
    },
    droppedAttributeKeys: [...new Set(inTrace.flatMap((s) => s.droppedAttributeKeys ?? []))].sort(),
    notObserved: [
      { what: 'props の由来（derives）',
        why: 'コンポーネントが props で受け取った値が、応答のどの項目から来たかは観測できない。'
          + '02a 3.5.1 により構造的に推定であり、本PoCでは関係を作らない' },
      { what: 'この通信を起こした箇所（requests）',
        why: 'コンポーネントと通信を結ぶ共通の証拠が得られなかったため、関係を作らない' },
      { what: 'カラムと応答項目の対応づけ（maps）',
        why: '確認にはレスポンス本文の読み取りが必要で、収集禁止項目にあたるため行わなかった' },
      { what: '表示された値そのもの',
        why: '方針として保存しない。対応付けは要素識別子・同一識別子内の順番・'
          + 'テキストノード索引で行い、値を鍵に使わない' },
      { what: 'ライブラリ由来か動的生成かの区別',
        why: '識別子を持たない要素について、両者を DOM からは区別できなかった。'
          + 'いずれも「特定不能」と返す' },
      { what: 'どの使用箇所がこのインスタンスを描いたか',
        why: '同じコンポーネントが複数箇所で使われる場合、DOM からは使用箇所を一意に決められない' },
      { what: 'SQL の取得件数（行数）', why: '使用した計装が行数の属性を付けないため、取得できなかった' },
      { what: 'SQL のパラメータ値', why: '方針として収集しない（NFR-20）。取得時点で除去している' },
      { what: 'Server Component から DB を直読みする経路', why: 'PoC-02 の検証対象' },
    ],
    excluded: {
      staticAssetRequests: page.excludedAssets,
      note: '静的資材（/_next/*・画像・フォント）は「通信」として数えていない',
    },
  },
  page: { path: PAGE, name: '物件カード', startMs: docReq?.startMsEpoch ?? focus.startMsEpoch },
  focus: FOCUS,
  browserRequests: page.requests.map((r) => ({
    method: r.method, path: r.path, status: r.status,
    startMs: r.startMsEpoch, durationMs: r.durationMs, server: r.server,
    isDocument: r.path === PAGE,
  })),
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
    anchoredElements: browser[0].extra.facts.anchoredElements,
    totalElements: browser[0].extra.facts.totalElements,
    primaryKey: PRIMARY.key,
    selections,
    anchors,
    files: manifestFiles.map((f) => ({
      file: f.file, anchors: f.anchors.length, usages: f.usages.length, skipped: f.skipped,
    })),
  },
};

/* ------------------------------------------------- 秘密情報・値が入っていないか */
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
fs.writeFileSync(path.join(OUT, 'element-observation.json'), JSON.stringify(bundle, null, 2));

const ts = `/* =============================================================================
 * 自動生成（poc/runner/build-element-observation.mjs）。手で編集しない。
 *
 * PoC-03 で実際に観測した1回のページ読み込みの記録である。合成データではない。
 * **表示された値そのものは含まない**（文字数と文字種だけを持つ）。
 * 収集禁止項目（SQLのパラメータ値・接続文字列・Cookie・Authorization・トークン・
 * 個人情報・行データ・本文・DOM の全文）は、取得時点で除去されているため含まれない。
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const ELEMENT_OBSERVATION: ObservationBundle = ${JSON.stringify(bundle, null, 2)} as const;
`;
fs.mkdirSync(path.join(REPO, 'src', 'data'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src', 'data', 'observation.poc03.ts'), ts);

const resolved = selections.filter((s) => !s.failure).length;
console.log(`selections=${selections.length} resolved=${resolved} failures=${selections.length - resolved}`
  + ` anchors=${anchors.length} spans=${inTrace.length} sql=${sqlAnalyses.length}`
  + ` tables=${tables.length} columns=${columns.length}`);
console.log(`→ ${path.join(OUT, 'element-observation.json')}`);
console.log(`→ ${path.join(REPO, 'src', 'data', 'observation.poc03.ts')}`);
