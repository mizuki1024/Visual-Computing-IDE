/* =============================================================================
 * 7C HMR 後のリネージ誤対応の安全対策（案A: A1＋A2＋A3）— **DB もブラウザも Next.js も使わない部分**。
 *   npm run build:lib && node tests/hmr-guard-unit.spec.mjs
 *
 *   1. 計装（A1 の印）: 本物の計装の束を NODE_OPTIONS=--require で前置し、
 *      ディスクの生成物から読んだコード / HMR と同じ形で eval したコード（sourceURL に ?moduleId あり・なし）/
 *      new Function のコードから pool.query を呼ぶ。eval のフレームに印（scope: 'evaluated'）が付き、
 *      ?moduleId・絶対パスを書かないこと
 *   2. 記録の読み取り（parseCallsiteRecord）: 印の付いたフレーム・未知の形のフレームを**黙って捨てない**
 *   3. 呼び出し位置の照合（resolveDataAccess。本物の dataAccess.ts ＋ PoC-02 の照合器）を試験用の小さな
 *      プロジェクトにかける — A1・A2・A3 をそれぞれ単独で破った入力、T5 の異常系
 *      （sourcesContent が無い・ソースマップが古い・要求の開始を確かめられない・eval のフレーム・未知のフレーム）、
 *      使ったソースマップの区画の特定、比較の決定性、正規化で意味のある差を消さないこと
 *   3b. 7C 最終（実行コードの版）: A4（実行中のスクリプト・モジュールの区画のハッシュとディスクの生成物）・A5（読み直した組・mapFit）・
 *      区画の切り方（chunkregions.cjs）。第3の経路（同じパスの生成物が書き直され、古い世代のコードが動く）を合成で再現する
 *   4. 要求の特定（requestOfSql）と観測の台帳: 要求の開始が分からない間は結果を使い回さない
 *   5. 由来の評価（evaluateLineage）: 呼び出し位置を確かめられない SQL があるとき、「SQL を観測していない」と
 *      言わずに、確かめられないことを理由に切る。確かめられた SQL の由来は保つ
 *
 * 実物の next dev・PostgreSQL・ブラウザでの確認は tests/hmr-lineage-guard-e2e.spec.mjs。
 * ========================================================================== */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(import.meta.dirname, '..');
const require_ = createRequire(import.meta.url);
const DA = require_('../.libjs/server/dataAccess.js');
const OB = require_('../.libjs/server/observations.js');
const LO = require_('../.libjs/lib/liveObservation.js');
const LL = require_('../.libjs/lib/liveLineage.js');
const LN = require_('../.libjs/server/lineage.js');
const XF = require_('../poc/anchor/transform.cjs');
const FIXTURE = path.join(REPO, 'poc', 'fixture-app');
const BOOT = path.join(FIXTURE, 'ide-instrumentation', 'boot.cjs');
const SQLP = await import(path.join(REPO, 'poc', 'runner', 'lib', 'sqlparse.mjs'));

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);
const TR = (n) => n.toString(16).padStart(32, '0');
const SP = (n) => n.toString(16).padStart(16, '0');
const RID = (n) => n.toString(16).padStart(32, 'a');
const DOC = (n) => n.toString(16).padStart(32, 'd');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-hmrguard-'));
process.on('exit', () => { fs.rmSync(TMP, { recursive: true, force: true }); });

/* ========================================================================== */
console.log('\n1. 計装（A1）: eval されたコードのフレームに印を付ける');
const havePg = fs.existsSync(path.join(FIXTURE, 'node_modules', 'pg', 'package.json'))
  && fs.existsSync(path.join(FIXTURE, 'node_modules', '@opentelemetry', 'instrumentation-pg', 'package.json'));
if (!havePg) {
  console.log('  ⊘ poc/fixture-app に依存（pg・@opentelemetry/*）が入っていないため、この節は skip（未実行）。先に (cd poc/fixture-app && npm ci)');
} else {
  const closedPort = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const DSN = `postgresql://u:p@127.0.0.1:${closedPort}/x`;
  /* 使い捨てのプロジェクト（IDE のリポジトリの外）。pg は題材の node_modules から複製する（callsite-entry-unit と同じ） */
  const proj = path.join(TMP, 'app');
  fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'app', private: true }));
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    const pj = path.join(FIXTURE, 'node_modules', name, 'package.json');
    if (!fs.existsSync(pj)) return;
    seen.add(name);
    const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
    for (const d of Object.keys({ ...(p.dependencies ?? {}), ...(p.optionalDependencies ?? {}) })) visit(d);
  };
  visit('pg');
  for (const m of seen) fs.cpSync(path.join(FIXTURE, 'node_modules', m), path.join(proj, 'node_modules', m), { recursive: true, dereference: true });
  /* 生成物の形（Turbopack の .next/dev/server/chunks/ssr/*.js）。HmrM の pool.query は 3 行目 */
  const CHUNK_REL = '.next/dev/server/chunks/ssr/[root-of-the-server]__x._.js';
  fs.mkdirSync(path.dirname(path.join(proj, CHUNK_REL)), { recursive: true });
  /* 7C（A4）: Turbopack と同じ見出しの区画を1つ持つ生成物（require で読める形）。pool.query は 3 行目（区画の先頭から 1 行目） */
  const BODY = 'module.exports = [\n"[project]/src/app/hmr-m/page.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {\n  return function HmrM(pool) { return pool.query(\'select 1\').catch(() => {}); };\n}),\n][1]();\n';
  fs.writeFileSync(path.join(proj, CHUNK_REL), BODY);
  const chunkUrl = pathToFileURL(path.join(proj, CHUNK_REL)).href;
  const modId = encodeURIComponent('[project]/src/app/hmr-m/page.tsx [app-rsc] (ecmascript)');
  /* Turbopack の実行時（[turbopack]_runtime.js の inlineSourcemaps）と同じ形: (0, eval)(code + sourceURL) */
  const evalSrc = (url) => `(function HmrM(pool) {\n  // eval\n  return pool.query('select 1').catch(() => {});\n})\n//# sourceURL=${url}`;
  fs.writeFileSync(path.join(proj, 'probe.cjs'), [
    `const pg = require('pg');`,
    `const pool = new pg.Pool({ connectionString: ${JSON.stringify(DSN)}, connectionTimeoutMillis: 2000 });`,
    `const mode = process.argv[2];`,
    `const run = mode === 'disk' ? require(${JSON.stringify(path.join(proj, CHUNK_REL))})`,
    `  : mode === 'eval-query' ? (0, eval)(${JSON.stringify(evalSrc(`${chunkUrl}?${modId}`))})`,
    `  : mode === 'eval-plain' ? (0, eval)(${JSON.stringify(evalSrc(chunkUrl))})`,
    `  : new Function('pool', "return pool.query('select 1').catch(() => {});");`,
    `(async () => { await run(pool); await pool.end().catch(() => {}); })();`,
    '',
  ].join('\n'));
  const run = (mode) => {
    const spanFile = path.join(TMP, `${mode}.jsonl`);
    let exit = 0;
    try {
      execFileSync(process.execPath, [path.join(proj, 'probe.cjs'), mode], {
        cwd: proj,
        env: { PATH: process.env.PATH, NODE_OPTIONS: `--require "${BOOT}"`, POC01_MODE: 'method2', POC01_SPAN_FILE: spanFile, POC02_CALLSITE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      });
    } catch (e) { exit = e.status ?? -1; }
    const recs = fs.existsSync(spanFile) ? fs.readFileSync(spanFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { exit, recs, cs: recs.filter((r) => r.type === 'callsite' && r.target === 'sql') };
  };
  /** 計装・node_modules・Node 自身を除いた、最初のフレーム（呼び出しを書いた場所） */
  const firstUser = (c) => (c.entry?.frames ?? []).find((f) => !['outside', 'node_modules', 'node-builtin', 'native'].includes(f.scope)
    && !(f.scope === 'app-source' && f.file.startsWith('ide-instrumentation/'))) ?? null;

  const disk = run('disk');
  eq('前提: ディスクの生成物のコードから呼んだ — 計装を前置したアプリが正常に終わる', disk.exit, 0);
  ok('前提: 呼び出し位置の記録がある', disk.cs.length > 0, disk.cs.length);
  eq('ディスクの生成物: 最初のフレームは build-output（ファイル・行）', disk.cs.map((c) => { const f = firstUser(c); return f && `${f.scope}:${f.file}:${f.line}`; }).slice(0, 1), [`build-output:${CHUNK_REL}:3`]);
  ok('記録の作り方を書く（frameSource = v8-callsite: V8 の呼び出し位置の API で eval を判定した）', disk.cs.length > 0 && disk.cs.every((c) => c.entry?.frameSource === 'v8-callsite'), disk.cs.map((c) => c.entry?.frameSource ?? null));
  {
    const f = firstUser(disk.cs[0] ?? {});
    const want = require_('../poc/fixture-app/ide-instrumentation/chunkregions.cjs');
    const region = want.chunkRegions(BODY)[0];
    eq('A4（計装）: 生成物のフレームに、実行中のスクリプトの内容のハッシュ（V8 の CallSite.getScriptHash()）＝ 生成物のファイルの SHA-256', f?.scriptHash, want.sha256(BODY));
    eq('A4（計装）: 読み込んだときの内容から作った区画の表で、フレームが入る区画のハッシュと区画の先頭からの行を書く', f?.moduleRegion, { hash: region.hash, line: 1 });
    ok('A4（計装）: モジュールの名前（[project]/…）・絶対パスを記録しない', !JSON.stringify(disk.recs).includes('[project]') && !JSON.stringify(disk.recs).includes(TMP));
  }

  for (const [mode, label] of [
    ['eval-query', 'HMR と同じ形の eval（sourceURL に ?moduleId）'],
    ['eval-plain', 'sourceURL に ? が無い eval（形が変わった場合）'],
    ['new-function', 'new Function（eval at の形）'],
  ]) {
    const r = run(mode);
    ok(`${label}: 呼び出し位置の記録がある`, r.cs.length > 0, r.cs.length);
    const f = r.cs.map(firstUser);
    ok(`${label}: 最初のフレームに eval の印（scope: evaluated）。build-output と区別する`, f.length > 0 && f.every((x) => x?.scope === 'evaluated'), f);
    ok(`${label}: 印の付いたフレームを生成物のフレームとして記録しない`, !r.cs.some((c) => (c.entry?.frames ?? []).some((x) => x.scope === 'build-output' && x.file === CHUNK_REL)), r.cs.map((c) => c.entry?.frames?.filter((x) => x.scope === 'build-output')));
    ok(`${label}: ?moduleId・絶対パスを記録しない`, !JSON.stringify(r.recs).includes(TMP) && !JSON.stringify(r.recs).includes('%5Bproject%5D') && !JSON.stringify(r.recs).includes('[project]'));
  }
}

/* ========================================================================== */
console.log('\n2. 記録の読み取り（parseCallsiteRecord）: 印の付いたフレームを黙って捨てない');
const CHUNK = '.next/dev/server/chunks/ssr/x.js';
const INSTR = { functionName: 'captureFrames', file: 'ide-instrumentation/otel.cjs', scope: 'app-source', line: 125, col: 17 };
const recOf = (frames, extra = {}) => ({
  type: 'callsite', spanId: SP(10), traceId: TR(1), target: 'sql', proc: { pid: 42 },
  entry: { at: 'pg-pool.Pool.query', frameSource: 'v8-callsite', frames }, ...extra,
});
try {
  const c = DA.parseCallsiteRecord(recOf([
    INSTR,
    { functionName: 'x', file: '<node_modules>', scope: 'node_modules', line: 9, col: 1 },
    { functionName: 'HmrM', file: '<evaluated>', scope: 'evaluated', line: 21, col: 142 },
    { functionName: 'Other', file: CHUNK, scope: 'build-output', line: 3, col: 20 },
    { functionName: 'y', file: 'zzz', scope: 'future-scope', line: 1, col: 1 },
  ]));
  eq('印の付いたフレーム（evaluated）を順序どおりに残す', c.entry.frames.map((f) => f.scope), ['app-source', 'evaluated', 'build-output', 'unrecognized']);
  eq('未知の種別のフレームは「形を認識できない」印に置き換えて残す（ファイル名は読まない）', c.entry.frames[3].file, '<unrecognized>');
  eq('印の付いたフレームのファイル名は読まない（照合に使わない）', c.entry.frames[1].file, '<evaluated>');
  eq('記録の作り方（frameSource）を読む', c.entry.frameSource, 'v8-callsite');
  eq('作り方の書かれていない記録 → frameSource null', DA.parseCallsiteRecord({ ...recOf([INSTR]), entry: { at: 'pg-pool.Pool.query', frames: [INSTR] } }).entry.frameSource, null);
} catch (e) { fails.push(`例外: ${e?.stack ?? e}`); console.log(`  ✗ 例外: ${e?.stack ?? e}`); }

/* ========================================================================== */
console.log('\n3. 呼び出し位置の照合（本物の dataAccess.ts ＋ PoC-02 の照合器）— A1・A2・A3 と T5 の異常系');
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n) => { let v = n < 0 ? ((-n) << 1) | 1 : n << 1; let out = ''; do { let d = v & 31; v >>>= 5; if (v) d |= 32; out += B64[d]; } while (v); return out; };
const proj = path.join(TMP, 'proj');
fs.mkdirSync(path.join(proj, 'src', 'app', 'x'), { recursive: true });
fs.mkdirSync(path.join(proj, 'src', 'lib'), { recursive: true });
fs.mkdirSync(path.join(proj, '.next', 'dev', 'server', 'chunks', 'ssr'), { recursive: true });
const PAGE = 'src/app/x/page.tsx';
const OTHER = 'src/lib/other.ts';
const PAGE_SRC = [
  "import { pool } from '../../lib/db';",
  "export const dynamic = 'force-dynamic';",
  'export default async function XPage() {',
  "  const r = await pool.query('SELECT id, region FROM poc.listings');",
  "  const s = await pool.query('SELECT id, name AS region FROM poc.regions');",
  '  return <p data-poc-field="x">{r.rows[0].region}{s.rows.length}</p>;',
  '}',
  '',
].join('\n');
const OTHER_SRC = "export const other = 1;\n";
fs.writeFileSync(path.join(proj, PAGE), PAGE_SRC);
fs.writeFileSync(path.join(proj, OTHER), OTHER_SRC);
const QCOL = PAGE_SRC.split('\n')[3].indexOf('query') + 1;
const LOADED = XF.transform(PAGE_SRC, PAGE).code;    // ローダ（要素識別子の注入）の出力 = Turbopack の sourcesContent
ok('前提: .tsx はローダで内容が変わる（sourcesContent はいまのソースそのものではない）', LOADED !== PAGE_SRC);
const MANIFEST = new Map([[PAGE, XF.transform(PAGE_SRC, PAGE).components]]);
const CR = require_('../poc/fixture-app/ide-instrumentation/chunkregions.cjs');
const SM = await import(path.join(REPO, 'poc', 'runner', 'lib', 'srvmap.mjs'));
const sha = (t) => CR.sha256(t);
/**
 * 生成物の内容（Turbopack と同じ形: 行頭のモジュールの見出しで区画に分かれる）。other.ts の区画は 1〜9 行、page.tsx の区画は 10 行目から。
 * 7C（A4）: 実際の計装はフレームに実行中のスクリプトの内容のハッシュ（scriptHash）を書く。合成の入力も同じ契約にする
 */
const HEAD = (m) => `"[project]/${m} [app-rsc] (ecmascript)", ((__turbopack_context__) => {`;
const chunkText = ({ otherExtra = 0 } = {}) => [
  HEAD(OTHER), ...Array(8 + otherExtra).fill('/* gen */'),
  HEAD(PAGE), '/* gen */', '/* gen */', '  return __turbopack_context__.x(pool.query("SELECT id, region FROM poc.listings"));', ...Array(7).fill('/* gen */'), '',
].join('\n');
const CHUNK_TEXT = chunkText();
const CHUNK_SHA = sha(CHUNK_TEXT);
/** 区画の中の genLine 行の先頭を、元の srcLine 行 srcCol 列へ写す（行・列は 1 始まり） */
const inner = (absSrc, genLine, srcLine, srcCol, sourcesContent) => ({
  version: 3, sources: [`file://${absSrc}`], names: [],
  ...(sourcesContent === undefined ? {} : { sourcesContent: [sourcesContent] }),
  mappings: `${';'.repeat(genLine - 1)}${vlq(0)}${vlq(0)}${vlq(srcLine - 1)}${vlq(srcCol - 1)}`,
});
/**
 * Turbopack と同じ sections 形式。区画 0 = other.ts（生成物の 1〜10 行）、区画 1 = page.tsx（11 行目から）。
 * page の区画の 3 行目（生成物の 13 行目）→ page.tsx 4 行目の query（SQL a）
 */
const PAGE_GEN_LINE = 13;
/* pageContent: 'OMIT' = 区画に sourcesContent を持たせない（undefined は既定値になるので使わない） */
const writeChunk = ({ pageContent = LOADED, otherContent = OTHER_SRC, srcLine = 4, srcCol = QCOL, js = CHUNK_TEXT, pageOffset = 10, pageGenLine = 3 } = {}) => {
  fs.writeFileSync(path.join(proj, CHUNK), js);
  fs.writeFileSync(path.join(proj, `${CHUNK}.map`), JSON.stringify({
    version: 3, sources: [],
    sections: [
      { offset: { line: 0, column: 0 }, map: inner(path.join(proj, OTHER), 1, 1, 1, otherContent) },
      { offset: { line: pageOffset, column: 0 }, map: inner(path.join(proj, PAGE), pageGenLine, srcLine, srcCol, pageContent === 'OMIT' ? undefined : pageContent) },
    ],
  }));
};
const T0 = Date.now() + 60_000;            // SQL の開始（ファイルを書いた後）
const REQ0 = T0 - 400;                      // その SQL が属する要求の開始（受付スパン）
const sqlSpan = (id = 10) => ({ traceId: TR(1), spanId: SP(id), parentSpanId: SP(2), name: 'pg.query:SELECT', kind: 2, startMs: T0, endMs: T0 + 1, durationMs: 1, statusCode: 0, scope: '@opentelemetry/instrumentation-pg', attrs: { 'db.statement': 'SELECT $0' }, droppedAttributeKeys: [] });
const APPF = { functionName: 'XPage', file: CHUNK, scope: 'build-output', line: PAGE_GEN_LINE, col: 20, scriptHash: CHUNK_SHA };
const callsite = (frames = [INSTR, APPF], extra = {}) => DA.parseCallsiteRecord(recOf(frames, extra));
const resolve1 = async ({ recs = [callsite()], request = { spanId: SP(1), startMs: REQ0 }, manifest = MANIFEST } = {}) => (await DA.resolveDataAccess({
  projectRoot: proj, sql: [{ span: sqlSpan(), pid: 42, request }], callsites: new Map([[SP(10), recs]]), manifest, enabled: true,
}))[0];
const why = (d) => d.failure?.reason ?? null;
const setTime = (rel, ms) => { const t = new Date(ms); fs.utimesSync(path.join(proj, rel), t, t); };
const resetTimes = () => { const t = new Date(T0 - 3_600_000); for (const f of [PAGE, OTHER, CHUNK, `${CHUNK}.map`]) fs.utimesSync(path.join(proj, f), t, t); };
const unsafe = (d) => d.site === null && d.located === null;   // 位置も「参考の位置」も出さない
try {
  writeChunk(); resetTimes();
  const d = await resolve1();
  eq('基準: A1〜A3 がすべて通る → 位置を特定（page.tsx 4 行目の query）', d.site && `${d.site.file}:${d.site.line}:${d.site.col}`, `${PAGE}:4:${QCOL}`);
  eq('基準: 理由なし', why(d), null);
  ok('基準: 通った照合に A1・A2・A3 を書く', ['eval', '受付スパン', 'sourcesContent'].every((w) => d.checks.some((c) => c.includes(w))), d.checks);

  /* ---------------- A1 */
  const evalBefore = await resolve1({ recs: [callsite([INSTR, { functionName: 'HmrM', file: '<evaluated>', scope: 'evaluated', line: 6, col: 142 }, APPF])] });
  eq('A1（T1・T5）: eval のフレームが呼び出し側より内側にある → hmr-evaluated-code', why(evalBefore), 'hmr-evaluated-code');
  ok('A1: eval のフレームを飛ばして、外側の生成物のフレームを採らない（位置を出さない）', unsafe(evalBefore), evalBefore);
  const evalOnly = await resolve1({ recs: [callsite([INSTR, { functionName: 'HmrM', file: '<evaluated>', scope: 'evaluated', line: 6, col: 142 }])] });
  eq('A1: eval のフレームしか無い → hmr-evaluated-code（no-app-frame ではなく、実行したコードが差し替わったことを理由にする）', why(evalOnly), 'hmr-evaluated-code');
  const evalOuter = await resolve1({ recs: [callsite([INSTR, APPF, { functionName: 'Outer', file: '<evaluated>', scope: 'evaluated', line: 1, col: 1 }])] });
  eq('A1: 呼び出しを書いたフレームより外側（呼び出し元）の eval は、その位置の座標を変えない → 特定する', evalOuter.site?.line, 4);
  const unk = await resolve1({ recs: [callsite([INSTR, { functionName: 'y', file: 'zzz', scope: 'future-scope', line: 1, col: 1 }, APPF])] });
  eq('A1（T5）: 未知の形のフレームが内側にある → unrecognized-frame（飛ばして外側を採らない）', [why(unk), unsafe(unk)], ['unrecognized-frame', true]);
  const noSrc = await resolve1({ recs: [DA.parseCallsiteRecord({ ...recOf([INSTR, APPF]), entry: { at: 'pg-pool.Pool.query', frames: [INSTR, APPF] } })] });
  eq('A1（T5）: eval を判定した方法が記録に無い（印の有無を確かめられない）→ frame-origin-unverified', [why(noSrc), unsafe(noSrc)], ['frame-origin-unverified', true]);
  const strSrc = await resolve1({ recs: [DA.parseCallsiteRecord({ ...recOf([INSTR, APPF]), entry: { at: 'pg-pool.Pool.query', frameSource: 'stack-string', frames: [INSTR, APPF] } })] });
  eq('A1: スタックの文字列から推した記録（V8 の判定ではない）→ frame-origin-unverified', why(strSrc), 'frame-origin-unverified');

  /* ---------------- A2 */
  const noReq = await resolve1({ request: null });
  eq('A2（T5）: その SQL の要求の開始を確かめられない → request-start-unknown', [why(noReq), unsafe(noReq)], ['request-start-unknown', true]);
  resetTimes(); setTime(PAGE, REQ0 + 100);
  const srcDuring = await resolve1();
  eq('A2（T2）: 要求の開始の後・SQL の前にソースが書き換わった → changed-during-request（修正前の D は通していた）', [why(srcDuring), unsafe(srcDuring)], ['changed-during-request', true]);
  /* 7C 最終: A2 の生成物・ソースマップの更新時刻は、A4（実行したコードとディスクの生成物の内容の一致）・A5（読み直した組）に置き換えた。
   * 「要求の処理中に生成物が書かれた」だけでは、初回のコンパイル（書いた生成物を実行した＝正しい）と古いコードの実行を区別できない。
   * 置き換えた後も、実行したコードが違えば止まることを、同じ時刻の条件で対にして確かめる */
  resetTimes(); setTime(CHUNK, REQ0 + 100);
  eq('A2→A4（初回のコンパイル）: 要求の処理中に生成物が書かれ、実行したコード＝その生成物 → 特定する', why(await resolve1()), null);
  eq('A2→A4（保存から適用までの間）: 要求の処理中に生成物が書き換わり、実行したコード ≠ ディスクの生成物 → changed-during-request（位置を出さない）',
    (await resolve1({ recs: [callsite([INSTR, { ...APPF, scriptHash: sha('old generation') }])] })).failure?.reason, 'changed-during-request');
  resetTimes(); setTime(`${CHUNK}.map`, REQ0 + 100);
  eq('A2→A5: 要求の処理中にソースマップだけが書かれ、その組が生成物に合い、実行したコード＝生成物 → 特定する', why(await resolve1()), null);
  writeChunk({ pageOffset: 8, pageGenLine: 5 }); resetTimes(); setTime(`${CHUNK}.map`, REQ0 + 100);
  eq('A2→A5: 要求の処理中に書かれたソースマップが生成物に合わない（別の世代の並び）→ build-map-unbound', why(await resolve1()), 'build-map-unbound');
  writeChunk();
  resetTimes(); setTime(PAGE, REQ0);
  eq('A2: 更新時刻が要求の開始と同時刻 → 変わったとみなす（changed-during-request）', why(await resolve1()), 'changed-during-request');
  resetTimes(); setTime(PAGE, REQ0 - (DA.FRESHNESS_MARGIN_MS - 500));
  eq(`A2: 要求の開始の直前（${DA.FRESHNESS_MARGIN_MS} ms の分解能の幅の内）→ 変わったとみなす`, why(await resolve1()), 'changed-during-request');
  resetTimes(); setTime(PAGE, REQ0 - (DA.FRESHNESS_MARGIN_MS + 1000));
  eq('A2: 幅より前の書き換え → 通す（ほかの照合が通れば特定）', why(await resolve1()), null);
  resetTimes(); setTime(OTHER, REQ0 + 100);
  eq('A2（T3）: 無関係なファイル（戻した先ではないソース）の書き換えでは止めない', why(await resolve1()), null);
  resetTimes(); setTime(PAGE, T0 + 5000);
  eq('既存の D は残す: SQL の実行の後のソースの書き換え → source-changed-after-call', why(await resolve1()), 'source-changed-after-call');
  resetTimes(); setTime(CHUNK, T0 + 5000);
  eq('既存の D は残す: SQL の実行の後の生成物の書き換え → build-changed-after-call', why(await resolve1()), 'build-changed-after-call');
  resetTimes();

  /* ---------------- A3 */
  writeChunk({ pageContent: 'OMIT' }); resetTimes();
  const noSc = await resolve1();
  eq('A3（T5）: 使った区画に sourcesContent が無い → map-source-unverified（一致とは扱わない）', [why(noSc), unsafe(noSc)], ['map-source-unverified', true]);
  writeChunk({ pageContent: null }); resetTimes();
  eq('A3（T5）: sourcesContent の該当が null → map-source-unverified', why(await resolve1()), 'map-source-unverified');
  const OLD_SRC = PAGE_SRC.replace("export default async function XPage() {\n", "export default async function XPage() {\n  const pre = 0;\n");
  writeChunk({ pageContent: XF.transform(OLD_SRC, PAGE).code }); resetTimes();
  const stale = await resolve1();
  eq('A3（T5）: ソースマップが古い（区画の sourcesContent ≠ いまのソースの変換結果）→ map-source-mismatch', [why(stale), unsafe(stale)], ['map-source-mismatch', true]);
  writeChunk({ pageContent: PAGE_SRC }); resetTimes();
  eq('A3: sourcesContent が、ローダを通さない、いまのソースそのもの → 一致（要素識別子の注入を無効にした起動）', why(await resolve1()), null);
  writeChunk({ pageContent: `${LOADED} ` }); resetTimes();
  eq('A3: 末尾の空白1文字だけの差でも一致にしない（正規化で差を消さない）', why(await resolve1()), 'map-source-mismatch');
  writeChunk({ pageContent: LOADED.replace(/\n/g, '\r\n') }); resetTimes();
  eq('A3: 改行コードだけの差でも一致にしない', why(await resolve1()), 'map-source-mismatch');
  writeChunk({ otherContent: 'export const other = 2;\n' }); resetTimes();
  eq('A3: 使っていない区画（other.ts）の sourcesContent が古くても、使った区画（page.tsx）で照合する → 特定', why(await resolve1()), null);
  writeChunk({ pageContent: XF.transform(OLD_SRC, PAGE).code, otherContent: OTHER_SRC }); resetTimes();
  eq('A3: 使った区画が古ければ、ほかの区画が一致していても止める', why(await resolve1()), 'map-source-mismatch');
  writeChunk(); resetTimes();
  const a = JSON.stringify(await resolve1());
  const b = JSON.stringify(await resolve1());
  ok('A3: 比較は決定的（同じ入力で同じ結果）', a === b && JSON.parse(a).failure === null);
  ok('A3: ローダの変換は決定的（同じソースから同じ出力）', XF.transform(PAGE_SRC, PAGE).code === XF.transform(PAGE_SRC, PAGE).code);

  /* ---------------- A1〜A3 は独立した条件（どれか1つだけ破っても止まる） */
  writeChunk(); resetTimes();
  eq('独立性: A2・A3 が通っても A1 だけで止まる', why(evalBefore), 'hmr-evaluated-code');
  setTime(PAGE, REQ0 + 100);
  writeChunk(); setTime(CHUNK, T0 - 3_600_000); setTime(`${CHUNK}.map`, T0 - 3_600_000); setTime(OTHER, T0 - 3_600_000);
  eq('独立性: A1・A3 が通っても A2 だけで止まる', why(await resolve1()), 'changed-during-request');
  writeChunk({ pageContent: XF.transform(OLD_SRC, PAGE).code }); resetTimes();
  eq('独立性: A1・A2 が通っても A3 だけで止まる（ソースとマップのどちらも要求の前の書き換え）', why(await resolve1()), 'map-source-mismatch');
  writeChunk(); resetTimes();
  ok('結果に絶対パスが無い', !JSON.stringify(await resolve1()).includes(TMP));
} catch (e) { fails.push(`例外: ${e?.stack ?? e}`); console.log(`  ✗ 例外: ${e?.stack ?? e}`); }


/* ========================================================================== */
console.log('\n3b. 実行コードの版（A4）と、読み直した生成物・ソースマップの組（A5）— 第3の経路');
try {
  writeChunk(); resetTimes();
  const at = (d) => d.site && `${d.site.file}:${d.site.line}:${d.site.col}`;
  const PAGE_REGION = CR.chunkRegions(CHUNK_TEXT).find((r) => r.module.includes(PAGE));
  ok('前提: 区画の切り方は計装と IDE で同じファイル（chunkregions.cjs）。page.tsx の区画は 10 行目から', PAGE_REGION?.start === 10, PAGE_REGION);
  const noHash = await resolve1({ recs: [callsite([INSTR, { ...APPF, scriptHash: undefined }])] });
  eq('A4（T5）: 記録に実行中のスクリプトのハッシュが無い → executed-code-unverified（位置を出さない）', [why(noHash), unsafe(noHash)], ['executed-code-unverified', true]);
  const badHash = await resolve1({ recs: [callsite([INSTR, { ...APPF, scriptHash: 'ABC' }])] });
  eq('A4（T5）: ハッシュの形が違う（16 進 64 桁でない）→ 読まない → executed-code-unverified', why(badHash), 'executed-code-unverified');
  /* 第3の経路: 同じパスの生成物が書き直された（other の区画が 2 行伸び、page の区画は後ろへずれた）が、実行中のコードは古い世代 */
  const OLD_TEXT = chunkText({ otherExtra: 2 });
  const OLD_REGION = CR.chunkRegions(OLD_TEXT).find((r) => r.module.includes(PAGE));
  const oldLine = PAGE_GEN_LINE + 2;
  ok('前提: 古い世代の page の区画は内容が同じ（ハッシュが同じ）で、2 行後ろにある', OLD_REGION.hash === PAGE_REGION.hash && OLD_REGION.start === 12, OLD_REGION);
  const OLDF = { ...APPF, line: oldLine, scriptHash: sha(OLD_TEXT) };
  const noRegion = await resolve1({ recs: [callsite([INSTR, OLDF])] });
  eq('A4（第3の経路）: 実行中のコードが古い世代で、区画の証拠が無い → executed-code-mismatch（古い行を新しいソースマップで戻さない）', [why(noRegion), unsafe(noRegion)], ['executed-code-mismatch', true]);
  const moved = await resolve1({ recs: [callsite([INSTR, { ...OLDF, moduleRegion: { hash: OLD_REGION.hash, line: oldLine - OLD_REGION.start } }])] });
  eq('A4（第3の経路）: 区画の内容が同じ → いまの生成物の同じ区画の同じ行へ移して戻す → 正しい位置（page.tsx 4 行目の query）', at(moved), `${PAGE}:4:${QCOL}`);
  ok('A4: 位置を移したことを通った照合に書く', moved.checks.some((c) => c.includes('前の世代')), moved.checks);
  const otherRegion = await resolve1({ recs: [callsite([INSTR, { ...OLDF, moduleRegion: { hash: sha('changed module'), line: 3 } }])] });
  eq('A4: 実行したコードの区画と同じ内容の区画がディスクに無い（そのモジュール自身が変わった）→ executed-code-mismatch', [why(otherRegion), unsafe(otherRegion)], ['executed-code-mismatch', true]);
  /* 同じ内容の区画が2つある生成物（見出しまで同じ）→ 1つに決まらない */
  const DUP = [HEAD(PAGE), '/* gen */', HEAD(PAGE), '/* gen */', ''].join('\n');
  const dupRegions = CR.chunkRegions(DUP);
  const id = SM.verifyExecutedFrame({ file: CHUNK, scope: 'build-output', line: 2, col: 1, scriptHash: sha('x'), moduleRegion: { hash: dupRegions[0].hash, line: 1 } }, proj, new Map([[path.join(proj, CHUNK), { sha: sha(DUP), text: DUP, regions: dupRegions }]]));
  eq('A4: 同じ内容の区画が2つ → 1つに決まらないので mismatch（推測で選ばない）', id.status, 'mismatch');
  /* 呼び出しを書いたフレームより内側の生成物のフレームが古い世代 → そこで切る（外側の新しいフレームを採らない） */
  const HELPER = '.next/dev/server/chunks/ssr/helper.js';
  fs.writeFileSync(path.join(proj, HELPER), 'module.exports = 1;\n');
  const innerStale = await resolve1({ recs: [callsite([INSTR, { functionName: 'helper', file: HELPER, scope: 'build-output', line: 1, col: 1, scriptHash: sha('older helper') }, APPF])] });
  eq('A4: 内側の生成物のフレームの版が違う → executed-code-mismatch（それより外側のフレームを採らない）', [why(innerStale), unsafe(innerStale)], ['executed-code-mismatch', true]);
  const outerStale = await resolve1({ recs: [callsite([INSTR, APPF, { functionName: 'outer', file: HELPER, scope: 'build-output', line: 1, col: 1, scriptHash: sha('older helper') }])] });
  eq('A4: 呼び出しを書いたフレームより外側（呼び出し元）の版の違いは、その位置を変えない → 特定する', at(outerStale), `${PAGE}:4:${QCOL}`);
  /* 初回のコンパイル: 生成物もソースマップも要求の処理中に書かれた。実行したコード＝その生成物 → 特定（A2 の過剰な未観測を解いた） */
  resetTimes(); setTime(CHUNK, REQ0 + 245); setTime(`${CHUNK}.map`, REQ0 + 240);
  const first = await resolve1();
  eq('A2 の改善（初回のコンパイル）: 生成物・ソースマップが要求の開始の後・SQL の前に書かれ、実行したコード＝その生成物 → 特定', at(first), `${PAGE}:4:${QCOL}`);
  const firstStale = await resolve1({ recs: [callsite([INSTR, { ...APPF, scriptHash: sha('older') }])] });
  eq('同じ時刻の条件で、実行したコード ≠ その生成物 → 止める（changed-during-request）', [why(firstStale), unsafe(firstStale)], ['changed-during-request', true]);
  resetTimes();
  /* A5: 位置を戻した後の読み直し（srvmap.mjs の bindChunkAndMap） */
  const prov = SM.serverFrameProvenance(APPF, proj);
  eq('A5: 版を確かめた生成物と、位置を戻すのに使ったソースマップのまま → 組として通る', SM.bindChunkAndMap(CHUNK, proj, CHUNK_SHA, prov.mapSha).ok, true);
  eq('A5: 版を確かめた後に生成物の内容が変わった → chunk-changed', SM.bindChunkAndMap(CHUNK, proj, sha('other'), prov.mapSha).reason, 'chunk-changed');
  eq('A5: 位置を戻すのに使ったソースマップが、いまのものと違う → map-changed', SM.bindChunkAndMap(CHUNK, proj, CHUNK_SHA, sha('older map')).reason, 'map-changed');
  eq('A5: 使ったソースマップの記録が無い → map-changed（一致とは扱わない）', SM.bindChunkAndMap(CHUNK, proj, CHUNK_SHA, null).reason, 'map-changed');
  /* mapFit: 同じ世代の組は合う。並びのずれた別の世代の組は合わない */
  const mapOf = (o) => ({ version: 3, sections: [
    { offset: { line: 0, column: 0 }, map: inner(path.join(proj, OTHER), 1, 1, 1, OTHER_SRC) },
    { offset: { line: o.pageOffset, column: 0 }, map: { ...inner(path.join(proj, PAGE), o.genLine, 4, QCOL, LOADED), mappings: `${';'.repeat(o.genLine - 1)}${vlq(o.col)}${vlq(0)}${vlq(3)}${vlq(QCOL - 1)}` } },
  ] });
  eq('mapFit: 同じ世代（page の区画が page のモジュールの中・列が行に収まる）→ 合う', SM.mapFit(CHUNK_TEXT, mapOf({ pageOffset: 10, genLine: 3, col: 40 })).fit, true);
  eq('mapFit: page の区画の開始が別のモジュール（other）の中 → 合わない', SM.mapFit(CHUNK_TEXT, { version: 3, sections: [mapOf({ pageOffset: 7, genLine: 6, col: 0 }).sections[1]] }).reason, 'section-module-mismatch');
  eq('mapFit: 2つの区画が同じモジュールの中（並びが合わない）→ 合わない', SM.mapFit(CHUNK_TEXT, mapOf({ pageOffset: 7, genLine: 6, col: 0 })).reason, 'section-order');
  eq('mapFit: セグメントの列が行の長さを超える（並びのずれた世代の組）→ 合わない', SM.mapFit(CHUNK_TEXT, mapOf({ pageOffset: 10, genLine: 2, col: 40 })).reason, 'segment-outside-line');
  eq('mapFit: モジュールの見出しが無い生成物 → 合わない（未観測にする側）', SM.mapFit('/* gen */\n'.repeat(20), mapOf({ pageOffset: 10, genLine: 3, col: 0 })).reason, 'no-module-regions');
  eq('mapFit: sections の形でないソースマップ → 合わない', SM.mapFit(CHUNK_TEXT, inner(path.join(proj, PAGE), 13, 4, QCOL, LOADED)).reason, 'not-index-map');
  /* 区画の切り方 */
  const HEADS = [
    '"[project]/src/a.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {',
    '"[project]/node_modules/x.js [app-rsc] (ecmascript)", ((__turbopack_context__, module, exports) => {',
    '"[project]/src/app/layout.tsx [app-rsc] (ecmascript, Next.js Server Component)", (function(__turbopack_context__){',
    '"[project]/node_modules/t.js?page=/a { MODULE_0 => \\"[project]/src/b.tsx\\" }", ((__turbopack_context__) => {',
  ];
  eq('区画: 見出しの4つの形（実測）を区画の先頭とみなす', CR.chunkRegions(['module.exports = [', ...HEADS.flatMap((h) => [h, '  x;']), ''].join('\n')).map((r) => r.start), [2, 4, 6, 8]);
  eq('区画: 行の途中の見出しに似た文字列は区画の先頭にしない', CR.chunkRegions(['  "[project]/src/a.tsx", ((__turbopack_context__) => {', 'x'].join('\n')).length, 0);
  ok('区画: 区画のハッシュは見出しを含む（同じコードでもモジュールが違えば別の区画）', CR.chunkRegions([HEADS[0], 'x', ''].join('\n'))[0].hash !== CR.chunkRegions([HEADS[1], 'x', ''].join('\n'))[0].hash);
  ok('区画: 決定的（同じ内容から同じ表）', JSON.stringify(CR.chunkRegions(CHUNK_TEXT)) === JSON.stringify(CR.chunkRegions(CHUNK_TEXT)));
  const ws = CR.chunkRegions(CHUNK_TEXT.replace('/* gen */\n"', '/* gen */ \n"'));
  ok('区画: 空白1文字の違いで、その区画のハッシュだけが変わる（正規化しない・ほかの区画は同じ）', ws[0].hash !== CR.chunkRegions(CHUNK_TEXT)[0].hash && ws[1].hash === CR.chunkRegions(CHUNK_TEXT)[1].hash, ws.map((r) => r.hash.slice(0, 8)));
  writeChunk(); resetTimes();
  ok('結果に絶対パスが無い（A4・A5 の詳細を含む）', !JSON.stringify([noHash, noRegion, moved, innerStale]).includes(TMP));
} catch (e) { fails.push(`例外: ${e?.stack ?? e}`); console.log(`  ✗ 例外: ${e?.stack ?? e}`); }

/* ========================================================================== */
console.log('\n4. 要求の特定（requestOfSql）と観測の台帳');
try {
  const root = (id, start, extra = {}) => ({ traceId: TR(1), spanId: SP(id), parentSpanId: null, name: 'GET', kind: 1, startMs: start, endMs: start + 50, durationMs: 50, statusCode: 0, scope: '@opentelemetry/instrumentation-http', attrs: {}, droppedAttributeKeys: [], ...extra });
  const q = sqlSpan();
  eq('同じトレースの受付スパンがちょうど1本 → その開始', DA.requestOfSql([root(1, REQ0), q], q).request, { spanId: SP(1), startMs: REQ0 });
  ok('受付スパンがまだ無い（応答を送り終えていない）→ 特定しない', DA.requestOfSql([q], q).request === null);
  ok('受付スパンが2本 → 特定しない（1つに決まらない）', DA.requestOfSql([root(1, REQ0), root(3, REQ0), q], q).request === null);
  ok('受付スパンが SQL より後に始まっている → 特定しない（時刻の向きが合わない）', DA.requestOfSql([root(1, T0 + 10), q], q).request === null);
  ok('別のトレースの受付スパンは使わない', DA.requestOfSql([root(1, REQ0, { traceId: TR(9) }), q], q).request === null);

  /* 台帳: 受付スパンがまだ無い間の結果は使い回さない（後で書かれたら照合し直す） */
  writeChunk(); resetTimes();
  const f = path.join(TMP, 'run.jsonl');
  const span = (o) => JSON.stringify({ type: 'span', sqlRedacted: null, proc: { pid: 42 }, ...o });
  const csLine = JSON.stringify({ ...recOf([INSTR, APPF]) });
  fs.writeFileSync(f, `${[csLine, span(sqlSpan())].join('\n')}\n`);
  const st = new OB.ObservationStore();
  st.begin('r1');
  st.record('r1', { method: 'GET', path: '/x', hasQuery: false, kind: 'document', status: 200, startMs: REQ0, durationMs: 5, trace: { traceId: TR(1), spanId: SP(1) }, failure: null }, { relayId: RID(1) });
  const input = { run: { instance: 'i', pid: 1, startedAt: 's' }, runString: 'r1', project: 'p', port: 1, instrumentation: { state: 'enabled', reason: null, spanFile: f }, traceHeader: true, dataAccess: { projectRoot: proj, enabled: true, manifest: MANIFEST } };
  const o1 = await st.collect(input);
  eq('台帳: 受付スパンがまだ無い → request-start-unknown', o1.dataAccess.map((d) => d.failure?.reason ?? 'site'), ['request-start-unknown']);
  fs.appendFileSync(f, `${span(root(1, REQ0, { attrs: { 'vcide.relay.id': RID(1) } }))}\n`);
  const o2 = await st.collect(input);
  eq('台帳: 受付スパンが書かれた後に照合し直す（前の「確かめられない」を使い回さない）→ 特定', o2.dataAccess.map((d) => d.site ? `${d.site.line}` : d.failure?.reason), ['4']);
} catch (e) { fails.push(`例外: ${e?.stack ?? e}`); console.log(`  ✗ 例外: ${e?.stack ?? e}`); }

/* ========================================================================== */
console.log('\n5. 由来の評価: 呼び出し位置を確かめられない SQL と「SQL を観測していない」を区別する');
try {
  const FIX = path.join(REPO, 'poc', 'fixture-app');
  const PL = await LN.analyzeProject(FIX);
  ok('前提: 静的解析器を使える（lineage.mjs）', !!PL.analysis && !PL.error, PL.error);
  const LINA = 'src/app/lin-a/page.tsx';
  const srcA = fs.readFileSync(path.join(FIX, LINA), 'utf8').split('\n');
  const li = srcA.findIndex((l) => l.includes('data-poc-field="a-region"'));
  const anchor = { file: LINA, line: li + 1, col: srcA[li].indexOf('<') + 1, tag: 'li', component: 'LinA' };
  const qi = srcA.findIndex((l) => l.includes('pool.query('));
  const call = { file: LINA, line: qi + 1, col: srcA[qi].indexOf('.query(') + 2 };
  const makeObs = (sql) => {
    const spans = [
      { traceId: TR(1), spanId: SP(100), parentSpanId: null, name: 'GET', kind: 1, startMs: 1000, endMs: 1050, durationMs: 50, statusCode: 0, scope: '@opentelemetry/instrumentation-http', attrs: { 'http.target': '/lin-a', 'vcide.relay.id': RID(1) }, droppedAttributeKeys: [] },
      { traceId: TR(1), spanId: SP(101), parentSpanId: SP(100), name: 'render route (app) /lin-a', kind: 0, startMs: 1001, endMs: 1040, durationMs: 39, statusCode: 0, scope: 'next.js', attrs: { 'next.span_type': 'AppRender.getBodyResult', 'next.route': '/lin-a' }, droppedAttributeKeys: [] },
    ];
    const sqlAnalyses = []; const dataAccess = [];
    sql.forEach((q, i) => {
      const spanId = SP(110 + i);
      spans.push({ traceId: TR(1), spanId, parentSpanId: SP(101), name: 'pg.query:SELECT', kind: 2, startMs: 1005 + i, endMs: 1006 + i, durationMs: 1, statusCode: 0, scope: '@opentelemetry/instrumentation-pg', attrs: { 'db.statement': q.text }, droppedAttributeKeys: [] });
      sqlAnalyses.push(SQLP.sqlAnalysisRecord({ spanId, sql: q.text }));
      dataAccess.push({
        spanId, traceId: TR(1), at: 'pg-pool.Pool.query',
        site: q.site ? { ...q.site, functionName: 'LinA', sourceLine: 'pool.query(…)', component: { name: 'LinA', file: q.site.file, line: 1, endLine: 99 } } : null,
        located: null, failure: q.site ? null : { reason: q.failure, detail: '' }, checks: [],
      });
    });
    return {
      run: { instance: 'i', pid: 1, startedAt: 's' }, project: 'fixture', port: 3000,
      session: { startedAt: 'S', recorded: 1, excludedStatic: 0, readRequestHeaders: ['sec-fetch-dest', 'rsc'], readResponseHeaders: ['x-vcide-trace'] },
      instrumentation: { state: 'enabled', reason: null, traceHeader: true, spanRecords: spans.length, truncated: false },
      exchanges: [{ seq: 1, method: 'GET', path: '/lin-a', hasQuery: false, kind: 'document', status: 200, startMs: 1000, durationMs: 50, trace: { traceId: TR(1), spanId: SP(100) }, failure: null, relayId: RID(1), docToken: DOC(1) }],
      spans, sqlAnalyses, parser: { available: true, reason: null }, serverOnlyRequests: 0, collectedAt: 'C',
      dataAccess, callsite: { enabled: true, records: sql.length, resolver: { available: true, reason: null } },
    };
  };
  const ev = (obs) => LL.evaluateLineage({
    obs, binding: LO.bindDocument(obs, { token: DOC(1), soft: false }, '/lin-a'), anchor,
    analysis: PL.analysis, resolveLineage: PL.resolveLineage, reasonText: PL.reasonText, changedAfter: () => [],
  });
  for (const reason of ['hmr-evaluated-code', 'changed-during-request', 'map-source-mismatch', 'map-source-unverified', 'request-start-unknown']) {
    const l = ev(makeObs([{ text: 'SELECT id, name AS region FROM poc.regions', failure: reason }]));
    eq(`SQL は観測したが呼び出し位置を確かめられない（${reason}）→ fetch-callsite-unverifiable（fetch-not-measured にしない）`, [l.status, l.cut?.reason, l.cut?.stage], ['cut', 'fetch-callsite-unverifiable', 'measured']);
    ok(`（${reason}）理由を詳細に残す・候補を出さない`, l.cut?.detail.includes(reason) && l.candidates.length === 0, l.cut);
  }
  const none = ev(makeObs([]));
  eq('SQL そのものを観測していない → 従来どおり fetch-not-measured', none.cut?.reason, 'fetch-not-measured');
  const other = ev(makeObs([{ text: 'SELECT 1', failure: 'component-not-agreed' }]));
  eq('ほかの理由（コンポーネントの外の取得関数など）→ 従来どおり fetch-not-measured', other.cut?.reason, 'fetch-not-measured');
  const kept = ev(makeObs([
    { text: 'SELECT id, region FROM poc.listings ORDER BY id LIMIT $0', site: call },
    { text: 'SELECT id, code FROM poc.regions', failure: 'hmr-evaluated-code' },
  ]));
  eq('T3: 同じ文書のほかの SQL が確かめられなくても、確かめられた SQL の由来は保つ', [kept.status, kept.candidates.map((c) => `${c.schema}.${c.table}.${c.column}`)], ['linked', ['poc.listings.region']]);
  ok('文言: 理由の表（観測画面）に、利用者に分かる言葉と再起動の案内がある',
    ['hmr-evaluated-code', 'changed-during-request', 'map-source-mismatch', 'map-source-unverified'].every((r) => typeof LO.DATA_ACCESS_FAILURE_LABEL[r] === 'string' && LO.DATA_ACCESS_FAILURE_LABEL[r].length > 10)
    && /再起動/.test(LO.DATA_ACCESS_FAILURE_LABEL['hmr-evaluated-code']));
} catch (e) { fails.push(`例外: ${e?.stack ?? e}`); console.log(`  ✗ 例外: ${e?.stack ?? e}`); }

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
for (const x of fails) console.log(`  ✗ ${x}`);
process.exit(fails.length ? 1 : 0);
