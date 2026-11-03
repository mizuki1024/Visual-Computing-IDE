/* =============================================================================
 * 7C HMR × 由来の安全性調査 — 診断用スクリプト（試験ではない。製品のコードは変えない）。
 * **実行中の要求の途中でソースが変わる**（in-flight）場合の確認。
 *
 *   npm run build:lib
 *   node docs/07c-hmr-lineage-safety-results/hmr-race-probe.mjs [--no-server-fast-refresh] [--kick]
 *   --kick: ソースを書き換えた直後（実行中の要求が SQL b を実行する前）に、同じページへ2本目の要求を出し、
 *           生成物の書き直し（--no-server-fast-refresh では require キャッシュの破棄と読み直し、既定では HMR の適用）を起こす。
 *           診断用の前置（rawstack-preload.cjs）も読み、Node の findSourceMap が実行中の古いコードのフレームを正しく戻せるかを見る（案B の限界）。
 *
 * 題材 /hmr-r: SQL a → 5 秒待つ → SQL b（a と b の生成物の行の差は 7）。
 * 要求を投げて a が走った後（1.5 秒後）に、a より前へ 7 文を足す。生成物とソースマップはすぐ書き直されるが、
 * 実行中の関数は**読み込み済みの古いコード**のまま b を実行する。b の実行時のフレーム（古い配置の行）を、
 * 新しい生成物のソースマップで戻すと、新しい配置では a の行に当たる。
 * 製品の鮮度の照合 D（生成物・ソースマップ・ソースの更新時刻 ≤ SQL の開始時刻）はこれを止められるかを見る。
 * 由来の評価（evaluateLineage）は「文書の取得の後にソースが変わった」で切れるはずなので、それも確かめる。
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NSFR = process.argv.includes('--no-server-fast-refresh');
const KICK = process.argv.includes('--kick');
const SRC_FIXTURE = path.join(REPO, 'poc', 'fixture-app');
const WORK = path.join(REPO, 'poc', 'out', `hmr-race-probe${NSFR ? '-nsfr' : ''}${KICK ? '-kick' : ''}`);
const APP = path.join(WORK, 'poc', 'fixture-app');
const RT = path.join(WORK, 'runtime');
const SPAN = path.join(RT, 'spans.jsonl');
const ANCH = path.join(RT, 'anchors');
const PORT = (NSFR ? 3488 : 3487) + (KICK ? 2 : 0);
const RAW = path.join(RT, 'rawstack.jsonl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.chdir(REPO);
const req = createRequire(path.join(REPO, 'package.json'));
const DA = req('./.libjs/server/dataAccess.js');
const AN = req('./.libjs/server/anchors.js');
const LN = req('./.libjs/server/lineage.js');
const LL = req('./.libjs/lib/liveLineage.js');
const SQLP = await import(path.join(REPO, 'poc', 'runner', 'lib', 'sqlparse.mjs'));

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(RT, { recursive: true });
fs.cpSync(path.join(REPO, 'poc', 'anchor'), path.join(WORK, 'poc', 'anchor'), { recursive: true });
fs.cpSync(SRC_FIXTURE, APP, { recursive: true, filter: (s) => { const r = path.relative(SRC_FIXTURE, s).split(path.sep); return r[0] !== 'node_modules' && r[0] !== '.next'; } });
execFileSync('cp', ['-al', path.join(SRC_FIXTURE, 'node_modules'), path.join(APP, 'node_modules')]);
const PAGE = 'src/app/hmr-r/page.tsx';
const ORIGINAL = `/* HMR 調査の一時的な題材: SQL の間で待つ */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function HmrR() {
  const a = await pool.query('SELECT id, region FROM poc.listings ORDER BY id DESC LIMIT 2');
  await new Promise((r) => setTimeout(r, 5000));
  const n2 = a.rows.length + 1;
  const n3 = n2 + 1;
  const n4 = n3 + 1;
  const n5 = n4 + 1;
  const n6 = n5 + 1;
  const b = await pool.query('SELECT id, name AS region FROM poc.regions ORDER BY id DESC LIMIT 2');
  return (
    <main className="hmr-r">
      <p data-poc-field="r-a">{a.rows[0].region}</p>
      <p data-poc-field="r-b">{b.rows[0].region}</p>
      <p data-poc-field="r-n">{String(n6)}</p>
    </main>
  );
}
`;
fs.mkdirSync(path.dirname(path.join(APP, PAGE)), { recursive: true });
fs.writeFileSync(path.join(APP, PAGE), ORIGINAL);
const EDITED = ORIGINAL.replace('export default async function HmrR() {\n',
  `export default async function HmrR() {\n${[1, 2, 3, 4, 5, 6, 7].map((i) => `  const pad${i} = ${i};\n`).join('')}`);

let child = null;
const env = {
  ...process.env,
  NODE_OPTIONS: `--require "${path.join(REPO, 'poc/fixture-app/ide-instrumentation/boot.cjs')}"${KICK ? ` --require "${path.join(import.meta.dirname, 'rawstack-preload.cjs')}"` : ''}`,
  RAWSTACK_OUT: RAW,
  POC01_MODE: 'method2', POC01_RUN: 'hmr-race', POC01_SPAN_FILE: SPAN, NEXT_OTEL_VERBOSE: '1',
  POC05_TRACE_HEADER: '1', POC05_SERVER_TIMING: '0', POC02_CALLSITE: '1', POC07_RELAY_ID: '1', POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCH,
};
function get(p) {
  return new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { r.resume(); r.on('end', () => res({ status: r.statusCode, trace: r.headers['x-vcide-trace'] ?? null })); })
      .on('error', (e) => res({ status: String(e.code), trace: null }));
  });
}
child = spawn(process.execPath, [path.join(APP, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(PORT), '-H', '127.0.0.1', ...(NSFR ? ['--no-server-fast-refresh'] : [])],
  { cwd: APP, env, stdio: 'ignore', detached: true });
process.on('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* */ } });
for (let i = 0; i < 240; i++) { const r = await get('/'); if (r.status === 200 || r.status === 404) break; await sleep(500); }
await get('/hmr-r'); // 初回のコンパイル

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SQL_TEXT = (a) => a['db.statement'] ?? a['db.query.text'] ?? null;
const mt = (rel) => fs.statSync(path.join(APP, rel)).mtimeMs;
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

console.log(`# hmr-race-probe ${new Date().toISOString()} mode=${NSFR ? '--no-server-fast-refresh' : '既定（server fast refresh 有効）'}${KICK ? ' --kick（書き換えの直後に2本目の要求）' : ''}`);
const t0 = Date.now();
const pending = get('/hmr-r');
await sleep(1500);
fs.writeFileSync(path.join(APP, PAGE), EDITED);
const tEdit = Date.now();
let kick = null;
if (KICK) { await sleep(500); const tk = Date.now(); kick = await get('/hmr-r'); console.log(`2本目の要求 +${tk - t0} ms → ${kick.status}（+${Date.now() - t0} ms に応答）`); }
const r = await pending;
await sleep(1500);
console.log(`要求の開始 +0 ms / ソースの書き換え +${tEdit - t0} ms / 応答 ${r.status}`);

const tp = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(r.trace ?? '');
const [, traceId, rootId] = tp;
const recs = readJsonl(SPAN);
const spans = []; const pidOf = new Map(); const callsites = new Map();
for (const o of recs) {
  if (o.type === 'callsite') { const c = DA.parseCallsiteRecord(o); if (c && c.traceId === traceId) callsites.set(c.spanId, [...(callsites.get(c.spanId) ?? []), c]); continue; }
  if (o.type !== 'span' || o.traceId !== traceId) continue;
  spans.push({ traceId, spanId: o.spanId, parentSpanId: o.parentSpanId ?? null, name: String(o.name ?? ''), kind: Number(o.kind ?? 0), startMs: Number(o.startMs), endMs: Number(o.endMs), durationMs: Number(o.durationMs), statusCode: Number(o.statusCode ?? 0), scope: String(o.scope ?? ''), attrs: o.attrs ?? {}, droppedAttributeKeys: [] });
  if (typeof o.proc?.pid === 'number') pidOf.set(o.spanId, o.proc.pid);
}
const sqlSpans = spans.filter((s) => SQL_TEXT(s.attrs)).sort((a, b) => a.startMs - b.startMs);
const dataAccess = await DA.resolveDataAccess({ projectRoot: APP, sql: sqlSpans.map((s) => ({ span: s, pid: pidOf.get(s.spanId) ?? null })), callsites, manifest: AN.readManifestComponents(ANCH), enabled: true });
const chunk = (callsites.get(sqlSpans[1]?.spanId)?.[0]?.entry?.frames ?? []).find((f) => f.scope === 'build-output')?.file;
const tChunk = chunk ? Math.max(fs.statSync(path.join(APP, chunk)).mtimeMs, fs.statSync(path.join(APP, `${chunk}.map`)).mtimeMs) : null;
console.log(`生成物（${chunk?.split('/').pop()}）とソースマップの更新 +${tChunk ? Math.round(tChunk - t0) : '?'} ms（最後に書かれた時刻。応答の後にも書かれうる）/ ソース +${Math.round(mt(PAGE) - t0)} ms`);
const now = fs.readFileSync(path.join(APP, PAGE), 'utf8');
for (const s of sqlSpans) {
  const sql = SQL_TEXT(s.attrs);
  const d = dataAccess.find((x) => x.spanId === s.spanId);
  const f = (callsites.get(s.spanId)?.[0]?.entry?.frames ?? []).find((x) => x.scope === 'build-output');
  const isA = sql.includes('poc.listings');
  const oldLine = lineOf(ORIGINAL, isA ? "'SELECT id, region FROM" : "'SELECT id, name AS region");
  const newLine = lineOf(now, isA ? "'SELECT id, region FROM" : "'SELECT id, name AS region");
  const site = d?.site ? `${d.site.file}:${d.site.line}:${d.site.col}` : null;
  console.log(`SQL ${isA ? 'a' : 'b'}「${sql.slice(0, 60)}」 開始 +${Math.round(s.startMs - t0)} ms`);
  console.log(`  実行したコード = 書き換え前のソース ${PAGE}:${oldLine}（書き換え後のソースでは同じ呼び出しは ${newLine} 行）`);
  console.log(`  実行時のフレーム ${f ? `${f.file.split('/').pop()}:${f.line}:${f.col}` : '-'}`);
  if (KICK) {
    const head = sql.split('$')[0].trim();
    const rr = readJsonl(RAW).filter((o) => o.type === 'rawstack' && o.sql.startsWith(head)).sort((x, y) => Math.abs(x.t - s.startMs) - Math.abs(y.t - s.startMs))[0];
    const rf = rr?.frames.find((x) => x.line === f?.line && x.col === f?.col) ?? rr?.frames[0];
    console.log(`  生の URL に ?moduleId: ${rf?.hasQuery ?? '-'} / Node の findSourceMap: ${rf?.node?.source ? `${rf.node.source.replace(/^<APP>\//, '')}:${rf.node.line}:${rf.node.col}` : JSON.stringify(rf?.node ?? null)}（実行したコードの正解は書き換え前の ${oldLine} 行。書き換え後のソースで同じ呼び出しは ${newLine} 行）`);
  }
  console.log(`  製品 resolveDataAccess: ${site ?? '-'}${d?.failure ? ` / ${d.failure.reason}: ${d.failure.detail.slice(0, 80)}` : ''}`);
  const verdict = !site ? '未特定（安全側）' : (d.site.line === newLine ? '書き換え後のソースの同じ呼び出しを指す（行は今のソース基準）' : `WRONG（別の呼び出し ${d.site.sourceLine.slice(0, 50)}）`);
  console.log(`  判定: ${verdict}`);
}
/* 由来の評価 */
const ex = { seq: 1, kind: 'document', method: 'GET', path: '/hmr-r', startMs: t0, status: r.status, relayId: null, trace: { traceId, spanId: rootId }, failure: null };
const obs = { instrumentation: { state: 'enabled', reason: null }, exchanges: [ex], spans, sqlAnalyses: sqlSpans.map((s) => SQLP.sqlAnalysisRecord({ spanId: s.spanId, sql: SQL_TEXT(s.attrs), redacted: null })), parser: { available: true, reason: null }, dataAccess };
const pl = await LN.analyzeProject(APP);
for (const field of ['r-a', 'r-b']) {
  const i = now.split('\n').findIndex((l) => l.includes(`data-poc-field="${field}"`));
  const anchor = { file: PAGE, line: i + 1, col: now.split('\n')[i].indexOf('<p') + 1, tag: 'p', component: 'HmrR' };
  const l = LL.evaluateLineage({ obs, binding: { status: 'identified', seq: 1, reason: null, detail: null }, anchor, analysis: pl.analysis, analyzerError: pl.error, resolveLineage: pl.resolveLineage, changedAfter: pl.changedAfter, reasonText: pl.reasonText });
  console.log(`由来 ${field}: ${l.status}${l.cut ? ` / ${l.cut.reason}（${l.cut.detail.slice(0, 60)}）` : ''} ${(l.candidates ?? []).map((c) => `${c.schema}.${c.table}.${c.column}`).join(',')}`);
}
/* 変更後の新しい要求（参考） */
const t1 = Date.now();
const r2 = await get('/hmr-r');
await sleep(1500);
const tp2 = /^00-([0-9a-f]{32})-/.exec(r2.trace ?? '');
const recs2 = readJsonl(SPAN);
const sql2 = recs2.filter((o) => o.type === 'span' && o.traceId === tp2?.[1] && SQL_TEXT(o.attrs ?? {}));
const cs2 = new Map();
for (const o of recs2) if (o.type === 'callsite' && o.traceId === tp2?.[1]) { const c = DA.parseCallsiteRecord(o); if (c) cs2.set(c.spanId, [c]); }
const da2 = await DA.resolveDataAccess({ projectRoot: APP, sql: sql2.map((o) => ({ span: { ...o, startMs: Number(o.startMs) }, pid: o.proc?.pid ?? null })), callsites: cs2, manifest: AN.readManifestComponents(ANCH), enabled: true });
console.log(`（参考）変更後の新しい要求 +${t1 - t0} ms:`);
for (const d of da2) {
  const o = sql2.find((x) => x.spanId === d.spanId);
  const f = cs2.get(d.spanId)?.[0]?.entry?.frames.find((x) => x.scope === 'build-output');
  console.log(`  ${SQL_TEXT(o.attrs).slice(0, 50)} フレーム ${f ? `${f.line}:${f.col}` : '-'} → 製品 ${d.site ? `${d.site.file}:${d.site.line}:${d.site.col}` : '-'}${d.failure ? ` / ${d.failure.reason}` : ''}`);
}
try { process.kill(-child.pid, 'SIGTERM'); } catch { /* */ }
process.exit(0);
