/* =============================================================================
 * PoC-01 手順6〜8 — 実際の1回の読み込みを観測し、観測結果 JSON を作る。
 *   node poc/runner/build-observation.mjs
 * 出力:
 *   poc/out/observation.json            観測結果（層1の入力）
 *   src/data/observation.measured.ts    IDE が読む形（型検査を通す）
 *
 * ここは「観測」だけを行う。オブジェクトモデルへの変換は IDE 側の adapter.ts。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { readSpans, startApp } from './lib/server.mjs';
import { drivePages } from './lib/drive.mjs';
import { sqlAnalysisRecord } from './lib/sqlparse.mjs';
import { introspectColumns, introspectRowEstimates, introspectTables } from './lib/introspect.mjs';
import { APP, OUT, REPO, sleep } from './lib/util.mjs';

const MODE = process.env.POC01_PICK_MODE ?? 'method2';     // 非追加(b) を満たす方式
const BUNDLER = process.env.POC01_PICK_BUNDLER ?? 'turbopack';
const PAGE = '/listings';
const FOCUS = { method: 'GET', path: '/api/listings' };

const SQL_TEXT = (a) => a['db.statement'] ?? a['db.query.text'] ?? null;

/* ----------------------------------------------------------------------------
 * 非追加(b) の確認: 方式2 の計測中は instrumentation.ts を退避し、
 * 「プロジェクトに計装用のファイルが無い状態」で走らせる。
 * -------------------------------------------------------------------------- */
const INSTR = path.join(APP, 'src', 'instrumentation.ts');
const PARKED = `${INSTR}.parked`;
const park = () => { if (MODE === 'method2' && fs.existsSync(INSTR)) fs.renameSync(INSTR, PARKED); };
const unpark = () => { if (fs.existsSync(PARKED)) fs.renameSync(PARKED, INSTR); };

park();
let app;
let browser;
let spans;
let notes;
try {
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  app = await startApp({ mode: MODE, bundler: BUNDLER, run: 'observation' });
  // 1回捨てて、初回コンパイルと接続確立のスパンを観測対象に混ぜない
  await drivePages([PAGE]);
  await drivePages([PAGE]);
  fs.writeFileSync(app.spanFile, '');
  browser = await drivePages([PAGE]);
  await sleep(1500);
  ({ spans, notes } = readSpans(app.spanFile));
} finally {
  if (app) await app.stop();
  unpark();
}

const page = browser[0];
const focus = page.requests.find((r) => r.method === FOCUS.method && r.path === FOCUS.path);
if (!focus) throw new Error(`focus request not observed: ${FOCUS.method} ${FOCUS.path}`);
if (!focus.server) throw new Error('Server-Timing からトレースIDを読めなかった');

/* この経路のトレースだけを残す。他のトレースは観測結果に入れない */
const traceId = focus.server.traceId;
const inTrace = spans.filter((s) => s.traceId === traceId);
const docReq = page.requests.find((r) => r.path === PAGE);

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
    poc: 'PoC-01',
    collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    app: {
      name: 'PoC-01 Fixture App',
      port: 3200,
      framework: 'Next.js 16.4.3 (App Router)',
      orm: ['Prisma 6.19.3', 'pg 8.23.1'],
      pages: [
        { icon: '⌂', name: 'ホーム', path: '/' },
        { icon: '▣', name: '物件一覧', path: '/listings', current: true },
        { icon: '▢', name: '物件詳細', path: '/listings/[id]' },
      ],
    },
    instrumentation: {
      method: MODE === 'method2' ? '方式2 NODE_OPTIONS=--require' : '方式1 instrumentation.ts',
      detail: MODE === 'method2'
        ? 'プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した'
        : 'IDE が生成した src/instrumentation.ts から計装モジュールを読み込んだ',
      bundler: BUNDLER,
    },
    droppedAttributeKeys: [...new Set(inTrace.flatMap((s) => s.droppedAttributeKeys ?? []))].sort(),
    notObserved: [
      { what: '表示された値（DOM上の文字列）', why: 'ブラウザのDOM読み取りは PoC-01 の範囲外（PoC-03 の検証対象）' },
      { what: 'コンポーネント定義との対応', why: '要素識別子の注入は PoC-01 の範囲外（PoC-03 の検証対象）' },
      { what: 'カラムと応答項目の対応づけ（maps）', why: '確認にはレスポンス本文の読み取りが必要で、収集禁止項目にあたるため行わなかった' },
      { what: 'SQL の取得件数（行数）', why: '使用した計装が行数の属性を付けないため、取得できなかった' },
      { what: 'SQL のパラメータ値', why: '方針として収集しない（NFR-20）。取得時点で除去している' },
      { what: 'Server Component から DB を直読みする経路', why: 'PoC-02 の検証対象。本PoCは Client Component + API ルートに限定した' },
    ],
    excluded: {
      staticAssetRequests: page.excludedAssets,
      note: '静的資材（/_next/*・画像・フォント）は「通信」として数えていない',
    },
  },
  page: {
    path: PAGE,
    name: '物件一覧',
    startMs: docReq?.startMsEpoch ?? focus.startMsEpoch,
  },
  focus: FOCUS,
  browserRequests: page.requests.map((r) => ({
    method: r.method,
    path: r.path,
    status: r.status,
    startMs: r.startMsEpoch,
    durationMs: r.durationMs,
    server: r.server,
    isDocument: r.path === PAGE,
  })),
  spans: inTrace.map((s) => ({
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    name: s.name,
    kind: s.kind,
    startMs: s.startMs,
    endMs: s.endMs,
    durationMs: s.durationMs,
    statusCode: s.statusCode,
    scope: s.scope,
    attrs: s.attrs,
    droppedAttributeKeys: s.droppedAttributeKeys ?? [],
  })),
  sqlAnalyses,
  dbObjects: { tables, columns },
};

/* ------------------------------------------------- 秘密情報が入っていないか */
const FORBIDDEN = [
  /postgres(ql)?:\/\//i, /poc01_local_only/, /\bcookie\b/i, /\bauthorization\b/i,
  /\bbearer\b/i, /\bpassword\b/i, /\baccess_token\b/i, /\bsecret\b/i,
  /db\.connection_string"\s*:\s*"[^"]/i,
];
const text = JSON.stringify(bundle);
const hits = FORBIDDEN.filter((re) => re.test(text)).map(String);
if (hits.length) {
  throw new Error(`観測結果に収集禁止の痕跡がある: ${hits.join(', ')}`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'observation.json'), JSON.stringify(bundle, null, 2));

const ts = `/* =============================================================================
 * 自動生成（poc/runner/build-observation.mjs）。手で編集しない。
 *
 * PoC-01 で実際に観測した1回のページ読み込みの記録である。合成データではない。
 * 収集禁止項目（SQLのパラメータ値・接続文字列・Cookie・Authorization・トークン・
 * 個人情報・行データ・本文）は、取得時点で除去されているため含まれない。
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const OBSERVATION: ObservationBundle = ${JSON.stringify(bundle, null, 2)} as const;
`;
fs.mkdirSync(path.join(REPO, 'src', 'data'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src', 'data', 'observation.measured.ts'), ts);

console.log(`spans(trace)=${inTrace.length} sql=${sqlAnalyses.length}`
  + ` browserReqs=${bundle.browserRequests.length} tables=${tables.length} columns=${columns.length}`);
console.log(`notes=${notes.length} traceId=${traceId}`);
console.log(`→ ${path.join(OUT, 'observation.json')}`);
console.log(`→ ${path.join(REPO, 'src', 'data', 'observation.measured.ts')}`);
