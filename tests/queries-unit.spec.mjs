/* =============================================================================
 * Phase 7B-3B-1 — SQL を実行したデータ取得の呼び出し位置（DataAccessSite）と `queries`（ブラウザを使わない部分）。
 *   npm run build:lib && node tests/queries-unit.spec.mjs
 *
 *   1. 契約: 関係・取得手段の表を変えていない（queries は M1 のまま）
 *   2. 収集ファイルの呼び出し位置の記録の読み取り（形の検査・使わないフレームを捨てる）
 *   3. 計装のマスク: 中継の識別子は 16 進 32 桁だけ
 *   4. 中継（本物の PreviewGateway ＋ 代役の開発サーバー）: 要求ごとの識別子・ブラウザの値を通さない・
 *      **同じパスの2要求で応答ヘッダを入れ替える**と結ばない（7B-3A の規則なら結んでしまう）
 *   5. 照合（本物の dataAccess.ts ＋ PoC-02 の rscattr.mjs / srvmap.mjs / srcverify.mjs）を、
 *      試験用の小さなプロジェクト（ソース・生成物・ソースマップを手で書いたもの）にかける。
 *      成立・記録0件/2件・別トレース/別プロセス・行の不一致・コンポーネント外・対応表なし・
 *      **実行の後に生成物/ソースが書き換わった**・注入範囲の外（シンボリックリンク）・仮想モジュール
 *   6. 観測の台帳: 同じ起動の収集ファイルの記録だけ・通信のトレースの SQL だけ・再起動で捨てる
 *   7. 変換（fromLiveRun）: 根拠のある queries だけ・executes と混同しない・選択した要素と結ばない
 *
 * ここで使う入力は**試験のために組んだもの**（模擬）。実物の next dev・PostgreSQL での確認は queries-e2e。
 * ========================================================================== */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const M = require_('../.libjs/lib/model.js');
const A = require_('../.libjs/lib/adapter.js');
const L = require_('../.libjs/lib/layout.js');
const LO = require_('../.libjs/lib/liveObservation.js');
const OB = require_('../.libjs/server/observations.js');
const DA = require_('../.libjs/server/dataAccess.js');
const GW = require_('../.libjs/server/previewGateway.js');
const AC = require_('../.libjs/server/access.js');
const AN = require_('../.libjs/server/anchors.js');
const REPO = path.resolve(import.meta.dirname, '..');
const MASK = require_('../poc/fixture-app/ide-instrumentation/mask.cjs');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TR = (n) => n.toString(16).padStart(32, '0');
const SP = (n) => n.toString(16).padStart(16, '0');
const RID = (n) => n.toString(16).padStart(32, 'a');

/* ========================================================================== */
console.log('\n1. 契約: queries は M1 のまま（DataAccessSite → SqlStatement / server-call-stack / ソース位置まで）');
eq('関係種別は12件のまま', Object.keys(M.RELATION_SPEC).length, 12);
eq('queries の始点・終点', [M.RELATION_SPEC.queries.from, M.RELATION_SPEC.queries.to], ['DataAccessSite', ['SqlStatement']]);
eq('queries の取得手段は server-call-stack だけ', M.RELATION_SPEC.queries.sources, ['server-call-stack']);
eq('queries の帰属はソース位置まで（インスタンスではない）', M.RELATION_SPEC.queries.attribution, 'source-location');
eq('server-call-stack は L1相当（実測）', [M.SOURCE_LEVEL['server-call-stack'], M.observabilityOf('server-call-stack')], ['L1-equivalent', 'measured']);
eq('executes は従来どおり Span → SqlStatement（始点の型が違う）', M.RELATION_SPEC.executes.from, 'Span');
eq('handles の取得手段は変えていない（中継の識別子は trace-context の一種として扱う）', M.RELATION_SPEC.handles.sources, ['trace-context', 'time-window']);
ok('supplies は推定のまま（static-analysis・上限 estimated）', M.RELATION_SPEC.supplies.ceiling === 'estimated' && M.RELATION_SPEC.supplies.sources.join() === 'static-analysis');
ok('preview-relay はどの関係の取得手段でもない（requests にも使えない）', Object.values(M.RELATION_SPEC).every((r) => !r.sources.includes('preview-relay')));

/* ========================================================================== */
console.log('\n2. 収集ファイルの呼び出し位置の記録（形の検査）');
{
  const base = {
    type: 'callsite', spanId: SP(5), traceId: TR(5), target: 'sql', proc: { pid: 42 },
    entry: {
      at: 'pg-pool.Pool.query',
      frames: [
        { functionName: 'captureFrames', file: 'ide-instrumentation/otel.cjs', scope: 'app-source', line: 125, col: 17 },
        { functionName: 'RscDb', file: '.next/dev/server/chunks/ssr/a.js', scope: 'build-output', line: 33, col: 142 },
        { functionName: 'x', file: '<node_modules>', scope: 'node_modules', line: 99, col: 1 },
        { functionName: 'run', file: 'node:internal/async_local_storage/async_hooks', scope: 'node-builtin', line: 91, col: 14 },
        { functionName: 'evil', file: '.next/../../etc/passwd.js', scope: 'build-output', line: 1, col: 1 },
        { functionName: 'abs', file: '/etc/x.js', scope: 'build-output', line: 1, col: 1 },
        { functionName: 'v', file: 'webpack-internal:///(rsc)/./src/app/a/page.tsx', scope: 'bundler-virtual', line: 3, col: 4 },
        { functionName: 'bad', file: '.next/dev/server/b.js', scope: 'build-output', line: 0, col: 1 },
      ],
    },
    atSpanStart: [{ file: 'x' }],
  };
  const c = DA.parseCallsiteRecord(base);
  eq('spanId / traceId / pid を読む', [c.spanId, c.traceId, c.pid, c.target], [SP(5), TR(5), 42, 'sql']);
  eq('使うフレームだけを残す（計装・生成物・仮想モジュール）', c.entry.frames.map((f) => f.file), ['ide-instrumentation/otel.cjs', '.next/dev/server/chunks/ssr/a.js', 'webpack-internal:///(rsc)/./src/app/a/page.tsx']);
  eq('元のフレーム数は数として残す', c.entry.frameCount, 8);
  ok('`..` を含む・絶対パスの生成物は捨てる（IDE が任意のファイルを読まない）', !c.entry.frames.some((f) => f.file.includes('..') || f.file.startsWith('/')));
  ok('スパン開始時のスタックは持たない（根拠にしない）', !('atSpanStart' in c));
  eq('形の違う spanId は読まない', DA.parseCallsiteRecord({ ...base, spanId: 'zz' }), null);
  eq('type が callsite でなければ読まない', DA.parseCallsiteRecord({ ...base, type: 'span' }), null);
  eq('入口のスタックが無い記録は entry: null', DA.parseCallsiteRecord({ ...base, entry: null }).entry, null);
  eq('pid が無ければ null（比べない）', DA.parseCallsiteRecord({ ...base, proc: undefined }).pid, null);
}

/* ========================================================================== */
console.log('\n3. 計装のマスク: 中継の識別子は 16 進 32 桁だけを残す');
{
  const good = RID(1);
  eq('16 進 32 桁は残す', MASK.maskAttributes({ 'vcide.relay.id': good }).attrs['vcide.relay.id'], good);
  for (const v of ['ABC', `${good}0`, 'secret-token-value-0000000000000', 'g'.repeat(32), 12]) {
    ok(`形の違う値（${String(v).slice(0, 12)}…）は捨てる`, MASK.maskAttributes({ 'vcide.relay.id': v }).attrs['vcide.relay.id'] === undefined);
  }
  const otel = fs.readFileSync(path.join(REPO, 'poc', 'fixture-app', 'ide-instrumentation', 'otel.cjs'), 'utf8');
  ok('計装は POC07_RELAY_ID=1 のときだけ識別子を写す（既定では PoC の条件を変えない）', otel.includes("process.env.POC07_RELAY_ID === '1'"));
  ok('計装が読む要求ヘッダは x-vcide-relay の1つだけ（requestHook）', /requestHook\(span, request\)[\s\S]{0,400}RELAY_ID_HEADER/.test(otel) && (otel.match(/request\.headers\[/g) ?? []).length === 1);
}

/* ========================================================================== */
console.log('\n4. 中継（本物の PreviewGateway ＋ 代役の開発サーバー）: 要求ごとの識別子と、応答ヘッダの付け替えの検出');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-q-'));
{
  /* 代役の開発サーバー: 受けた x-vcide-relay を覚え、応答に x-vcide-trace を返す。
   * swap=true のときは /same への2要求が揃うまで待ち、**互いのトレース識別子を返す**（アプリが書き換えた場合を模す） */
  const seen = [];
  const waiting = [];
  const mode = { swap: false };
  const traceOf = new Map();       // relayId → traceparent
  let n = 0;
  const upstream = http.createServer((req, res) => {
    const rid = req.headers['x-vcide-relay'] ?? null;
    seen.push({ url: req.url, rid });
    n += 1;
    const tp = `00-${TR(100 + n)}-${SP(100 + n)}-01`;
    if (rid) traceOf.set(rid, { tp, traceId: TR(100 + n), spanId: SP(100 + n), url: req.url });
    const answer = (r, t) => { r.writeHead(200, { 'content-type': 'application/json', 'x-vcide-trace': t }); r.end('{}'); };
    if (req.url === '/same' && mode.swap) {
      waiting.push({ res, tp });
      if (waiting.length === 2) { answer(waiting[0].res, waiting[1].tp); answer(waiting[1].res, waiting[0].tp); waiting.length = 0; }
      return;
    }
    answer(res, tp);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const store = new OB.ObservationStore();
  store.begin('RUN');
  const cfg = AC.accessConfig({});
  const gw = new GW.PreviewGateway({
    config: cfg, port: await freePort(),
    target: () => ({ target: { port: upstream.address().port, run: 'RUN' }, reason: '' }),
    observer: store,
  });
  const info = await gw.ensure();
  const get = (p, headers = {}) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: info.port, path: p, headers: { host: `127.0.0.1:${info.port}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', (e) => resolve({ error: e.code }));
  });
  const r1 = await get('/a', { 'x-vcide-relay': 'f'.repeat(32), 'sec-fetch-dest': 'empty' });
  await get('/b');
  await get('/_next/static/c.js');
  await sleep(50);
  eq('応答は届く', r1.status, 200);
  ok('開発サーバーへの要求に、中継が作った識別子（16 進 32 桁）を載せる', /^[0-9a-f]{32}$/.test(seen[0]?.rid ?? ''), seen[0]);
  ok('ブラウザから来た x-vcide-relay は通さず、中継の値に置き換える', seen[0]?.rid !== 'f'.repeat(32));
  ok('要求ごとに別の値', seen[0]?.rid !== seen[1]?.rid);
  eq('静的資材（記録しない通信）には載せない', seen[2]?.rid, null);
  eq('ブラウザへの応答に x-vcide-relay を返さない', r1.headers['x-vcide-relay'], undefined);
  const spanFile = path.join(tmp, 'gw.jsonl');
  const runInput = (f) => ({ run: { instance: 'i', pid: 1, startedAt: 's' }, runString: 'RUN', project: 'p', port: 1, instrumentation: { state: 'enabled', reason: null, spanFile: f }, traceHeader: true });
  {
    const o = await store.collect(runInput(path.join(tmp, 'none.jsonl')));
    eq('台帳の記録は、中継が開発サーバーへ載せた値を持つ', o.exchanges.map((e) => e.relayId), [seen[0].rid, seen[1].rid]);
  }

  /* --- 同じパスへの2要求で、応答ヘッダを入れ替える */
  mode.swap = true;
  const [sa, sb] = await Promise.all([get('/same'), get('/same')]);
  eq('2要求とも応答は届く', [sa.status, sb.status], [200, 200]);
  await sleep(50);
  const sameRids = seen.filter((x) => x.url === '/same').map((x) => x.rid);
  /* 計装が書くはずの収集ファイル: 受付スパンは「自分が受けた識別子」を持つ */
  const rootSpan = (rid) => {
    const t = traceOf.get(rid);
    return { type: 'span', traceId: t.traceId, spanId: t.spanId, parentSpanId: null, name: 'GET', kind: 1, startMs: 1, endMs: 2, durationMs: 1, statusCode: 0, scope: '@opentelemetry/instrumentation-http', attrs: { 'http.target': '/same', 'vcide.relay.id': rid }, droppedAttributeKeys: [], proc: { pid: 7 } };
  };
  fs.writeFileSync(spanFile, `${sameRids.map((rid) => JSON.stringify(rootSpan(rid))).join('\n')}\n`);
  const o = await store.collect(runInput(spanFile));
  const same = o.exchanges.filter((e) => e.path === '/same');
  eq('前提: 2要求とも、応答ヘッダが**もう一方**の受付スパンを指している', same.map((e) => traceOf.get(e.relayId).traceId !== e.trace.traceId), [true, true]);
  for (const e of same) {
    const l = A.liveExchangeLinks(o, e);
    eq(`#${e.seq}: 7B-3B-1 の規則は結ばない（食い違いを検出）`, [l.server, l.basis], [null, null]);
    ok(`#${e.seq}: 理由に「食い違います」`, /食い違います/.test(l.reason ?? ''), l.reason);
    const legacy = A.liveExchangeLinks(o, { ...e, relayId: undefined });
    ok(`#${e.seq}: 比較 — 7B-3A の規則（応答ヘッダ＋パス）は**もう一方の要求**に結んでしまう`, legacy.basis === 'trace-header' && legacy.root?.attrs['vcide.relay.id'] !== e.relayId, legacy.reason);
  }
  /* --- 応答ヘッダが正しい場合（入れ替えない）: どちらも自分の受付スパンへ */
  mode.swap = false;
  await Promise.all([get('/same'), get('/same')]);
  await sleep(50);
  const honest = seen.filter((x) => x.url === '/same').slice(2).map((x) => x.rid);
  fs.appendFileSync(spanFile, `${honest.map((rid) => JSON.stringify(rootSpan(rid))).join('\n')}\n`);
  const o2 = await store.collect(runInput(spanFile));
  const hon = o2.exchanges.filter((e) => honest.includes(e.relayId));
  eq('入れ替えなければ、2要求とも中継の識別子で自分の受付スパンへ', hon.map((e) => { const l = A.liveExchangeLinks(o2, e); return `${l.basis}:${l.root?.attrs['vcide.relay.id'] === e.relayId}`; }), ['relay-id:true', 'relay-id:true']);
  /* --- 同じ識別子の受付スパンが2本（1つに決まらない） */
  fs.appendFileSync(spanFile, `${JSON.stringify({ ...rootSpan(honest[0]), spanId: SP(999) })}\n`);
  const o3 = await store.collect(runInput(spanFile));
  const dup = A.liveExchangeLinks(o3, o3.exchanges.find((e) => e.relayId === honest[0]));
  ok('同じ識別子の受付スパンが2本あれば結ばない（1つに決まらない）', dup.server === null && /2 本/.test(dup.reason), dup.reason);
  /* --- 受付スパンがまだ無い */
  const pend = A.liveExchangeLinks(o3, o3.exchanges.find((e) => e.path === '/b'));
  ok('識別子を受け取った受付スパンがまだ無ければ結ばない（応答ヘッダだけでは結ばない）', pend.server === null && /まだ収集ファイルに書かれていません/.test(pend.reason), pend.reason);
  await gw.close(); upstream.close();
}

/* ========================================================================== */
console.log('\n5. 照合（本物の dataAccess.ts ＋ PoC-02 の照合器）を、試験用の小さなプロジェクトにかける');
/* VLQ（ソースマップの mappings）を書く。試験のために最小限 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n) => { let v = n < 0 ? ((-n) << 1) | 1 : n << 1; let out = ''; do { let d = v & 31; v >>>= 5; if (v) d |= 32; out += B64[d]; } while (v); return out; };
/** 生成物の genLine 行の先頭を、元のソース srcLine 行 srcCol 列へ写すマップ（行・列は 1 始まり） */
/* 7C（A3）: Turbopack と同じく、元のソースの内容（sourcesContent）を持たせる（いまのソースそのもの） */
const contentOf = (srcPath) => { try { return fs.readFileSync(path.join(proj, srcPath), 'utf8'); } catch { return null; } };
const mapTo = (srcPath, genLine, srcLine, srcCol) => ({
  version: 3, sources: [`turbopack:///[project]/${srcPath}`], names: [], sourcesContent: [contentOf(srcPath)],
  mappings: `${';'.repeat(genLine - 1)}${vlq(0)}${vlq(0)}${vlq(srcLine - 1)}${vlq(srcCol - 1)}`,
});
const proj = path.join(tmp, 'proj');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(path.join(proj, 'src', 'app', 'x'), { recursive: true });
fs.mkdirSync(path.join(proj, '.next', 'dev', 'server', 'chunks', 'ssr'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
const PAGE = 'src/app/x/page.tsx';
fs.writeFileSync(path.join(proj, PAGE), [
  "import { pool } from '../../lib/db';",
  '',
  'export default async function XPage() {',
  "  const r = await pool.query('SELECT 1');",
  '  return <p>{String(r.rowCount)}</p>;',
  '}',
  'async function helper() {',
  "  await pool.query('SELECT 2');",
  '}',
].join('\n'));
fs.writeFileSync(path.join(outside, 'leak.tsx'), "export default async function Leak() { await pool.query('SELECT 3'); }\n");
fs.symlinkSync(path.join(outside, 'leak.tsx'), path.join(proj, 'src', 'app', 'link.tsx'));
const CHUNK = '.next/dev/server/chunks/ssr/x.js';
const writeChunk = (srcPath, srcLine, srcCol) => {
  fs.writeFileSync(path.join(proj, CHUNK), '/* gen */\n\nfunction XPage(){ pool.query() }\n');
  fs.writeFileSync(path.join(proj, `${CHUNK}.map`), JSON.stringify(mapTo(srcPath, 3, srcLine, srcCol)));
};
const MANIFEST = new Map([[PAGE, [{ name: 'XPage', file: PAGE, line: 3, endLine: 6 }]]]);
const T0 = Date.now() + 60_000;             // SQL の開始時刻（ファイルを書いた後）
const sqlSpan = (id, trace = TR(1)) => ({ traceId: trace, spanId: SP(id), parentSpanId: SP(2), name: 'pg.query:SELECT', kind: 2, startMs: T0, endMs: T0 + 1, durationMs: 1, statusCode: 0, scope: '@opentelemetry/instrumentation-pg', attrs: { 'db.statement': 'SELECT $0' }, droppedAttributeKeys: [] });
const callsite = (id, extra = {}) => DA.parseCallsiteRecord({
  type: 'callsite', spanId: SP(id), traceId: TR(1), target: 'sql', proc: { pid: 42 },
  /* 7C（A1）: 計装は V8 の CallSite で eval を判定した記録に frameSource: 'v8-callsite' を書く */
  entry: { at: 'pg-pool.Pool.query', frameSource: 'v8-callsite', frames: [
    { functionName: 'captureFrames', file: 'ide-instrumentation/otel.cjs', scope: 'app-source', line: 125, col: 17 },
    { functionName: 'XPage', file: CHUNK, scope: 'build-output', line: 3, col: 20 },
  ] },
  ...extra,
});
const resolve1 = async ({ span = sqlSpan(10), pid = 42, recs = [callsite(10)], manifest = MANIFEST, enabled = true } = {}) => (await DA.resolveDataAccess({
  /* 7C（A2）: その SQL が属する要求の開始（受付スパン）。ファイルを書いた後・SQL の前 */
  projectRoot: proj, sql: [{ span, pid, request: { spanId: SP(1), startMs: T0 - 5000 } }], callsites: new Map(recs.length ? [[span.spanId, recs]] : []), manifest, enabled,
}))[0];
{
  writeChunk(PAGE, 4, 19);
  const d = await resolve1();
  eq('成立: ソースマップで戻した位置（行・列）', d.site && `${d.site.file}:${d.site.line}:${d.site.col}`, `${PAGE}:4:19`);
  eq('成立: 囲むコンポーネント（2つの情報源が一致）', d.site?.component, { name: 'XPage', file: PAGE, line: 3, endLine: 6 });
  eq('成立: 読み直した1行', d.site?.sourceLine, "const r = await pool.query('SELECT 1');");
  /* 7C: 照合は 7 → 10（A1・A2・A3 を足した） */
  eq('成立: 理由なし・照合10（7C で A1・A2・A3 を足した）', [d.failure, d.checks.length], [null, 10]);
  ok('結果に絶対パスが無い', !JSON.stringify(d).includes(tmp));

  eq('記録が0件 → no-callsite-record', (await resolve1({ recs: [] })).failure?.reason, 'no-callsite-record');
  eq('記録が2件 → multiple-callsite-records（断定しない）', (await resolve1({ recs: [callsite(10), callsite(10)] })).failure?.reason, 'multiple-callsite-records');
  eq('記録のトレースが違う → callsite-mismatch', (await resolve1({ recs: [callsite(10, { traceId: TR(9) })] })).failure?.reason, 'callsite-mismatch');
  eq('記録を書いたプロセスが違う → callsite-mismatch', (await resolve1({ pid: 43 })).failure?.reason, 'callsite-mismatch');
  /* 7B-3B-2: PID の欠損。7B-3B-1 は片方が欠けると比べずに通していた（下の3件はその時点では成立になった） */
  {
    const noRecPid = await resolve1({ recs: [callsite(10, { proc: undefined })] });
    eq('7B-3B-2: 記録に PID が無い → callsite-pid-missing（比べずに通さない）', noRecPid.failure?.reason, 'callsite-pid-missing');
    eq('7B-3B-2: 記録に PID が無いとき位置を出さない', noRecPid.site, null);
    eq('7B-3B-2: SQL のスパンに PID が無い → callsite-pid-missing', (await resolve1({ pid: null })).failure?.reason, 'callsite-pid-missing');
    eq('7B-3B-2: 両方に PID が無い → callsite-pid-missing', (await resolve1({ pid: null, recs: [callsite(10, { proc: undefined })] })).failure?.reason, 'callsite-pid-missing');
    eq('7B-3B-2: PID の形が違う（文字列）記録 → 欠損として断定しない', (await resolve1({ recs: [callsite(10, { proc: { pid: '42' } })] })).failure?.reason, 'callsite-pid-missing');
    eq('7B-3B-2: 両方に PID があり一致 → 成立', (await resolve1()).failure, null);
    eq('7B-3B-2: 照合の項目に「PID が両方にあり一致」を書く', (await resolve1()).checks.some((c) => c.includes('PID が記録とスパンの両方にあり一致')), true);
  }
  eq('記録の種類が SQL でない → callsite-mismatch', (await resolve1({ recs: [callsite(10, { target: 'server-fetch' })] })).failure?.reason, 'callsite-mismatch');
  eq('入口のスタックが無い → no-entry-callsite', (await resolve1({ recs: [callsite(10, { entry: null })] })).failure?.reason, 'no-entry-callsite');
  eq('記録を有効にしていない起動 → callsite-disabled', (await resolve1({ enabled: false })).failure?.reason, 'callsite-disabled');
  eq('対応表が無い → manifest-unavailable（1つの情報源だけでは決めない）', (await resolve1({ manifest: null })).failure?.reason, 'manifest-unavailable');
  eq('対応表のコンポーネント名が違う → component-not-agreed', (await resolve1({ manifest: new Map([[PAGE, [{ name: 'Other', file: PAGE, line: 3, endLine: 6 }]]]) })).failure?.reason, 'component-not-agreed');

  writeChunk(PAGE, 5, 3);
  eq('戻した行にデータ取得の呼び出しが無い → source-line-mismatch', (await resolve1()).failure?.reason, 'source-line-mismatch');
  writeChunk(PAGE, 8, 9);
  const h = await resolve1();
  eq('コンポーネントでない関数の中 → component-not-agreed', h.failure?.reason, 'component-not-agreed');
  eq('戻した位置は参考として持つ（関係は作らない）', [h.site, h.located && `${h.located.file}:${h.located.line}`], [null, `${PAGE}:8`]);

  writeChunk('src/app/link.tsx', 1, 40);
  eq('シンボリックリンクで src/ の外へ出る → outside-scope', (await resolve1()).failure?.reason, 'outside-scope');
  writeChunk('src/../outside/leak.tsx', 1, 40);
  eq('`..` で src/ の外へ出る → outside-scope', (await resolve1()).failure?.reason, 'outside-scope');

  writeChunk(PAGE, 4, 19);
  const later = new Date(T0 + 5000);
  fs.utimesSync(path.join(proj, CHUNK), later, later);
  eq('SQL の実行の後に生成物が書き換わった → build-changed-after-call', (await resolve1()).failure?.reason, 'build-changed-after-call');
  writeChunk(PAGE, 4, 19);
  fs.utimesSync(path.join(proj, PAGE), later, later);
  eq('SQL の実行の後にソースが書き換わった → source-changed-after-call', (await resolve1()).failure?.reason, 'source-changed-after-call');
  const now = new Date();
  fs.utimesSync(path.join(proj, PAGE), now, now);
  eq('書き換えが実行の前なら成立に戻る（判定は時刻の前後だけ）', (await resolve1()).site?.line, 4);

  /* webpack の仮想モジュール（eval に包まれたモジュール）: 戻せても、実行の後に書き換わっていないかを確かめられない */
  const code = `function XPage(){}\n\nfoo()\n//# sourceURL=webpack-internal:///(rsc)/./${PAGE}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(mapTo(PAGE, 3, 4, 19))).toString('base64')}`;
  fs.writeFileSync(path.join(proj, '.next', 'dev', 'server', 'w.js'), `eval(${JSON.stringify(code)});\n`);
  const virt = await resolve1({ recs: [callsite(10, { entry: { at: 'pg-pool.Pool.query', frameSource: 'v8-callsite', frames: [{ functionName: 'XPage', file: `webpack-internal:///(rsc)/./${PAGE}`, scope: 'bundler-virtual', line: 3, col: 1 }] } })] });
  eq('webpack の仮想モジュール → build-freshness-unverified（戻せても断定しない）', [virt.failure?.reason, virt.located?.line], ['build-freshness-unverified', 4]);
}

/* ========================================================================== */
console.log('\n6. 観測の台帳: 同じ起動の収集ファイルの記録だけを使う');
const span = (traceId, spanId, parent, name, attrs = {}, extra = {}) => ({
  type: 'span', traceId, spanId, parentSpanId: parent, name, kind: 0, startMs: T0, endMs: T0 + 2,
  durationMs: 2, statusCode: 0, scope: 'next.js', attrs, droppedAttributeKeys: [], sqlRedacted: null, proc: { pid: 42 }, ...extra,
});
let liveObs;
{
  writeChunk(PAGE, 4, 19);
  const f = path.join(tmp, 'run.jsonl');
  const lines = [
    // 通信 #1 のトレース T1: 受付 → 描画 → SQL（記録あり）・SQL（記録の trace が違う）
    callsite(10),
    { ...callsite(11), traceId: TR(77) },
    span(TR(1), SP(1), null, 'GET', { 'http.target': '/x', 'vcide.relay.id': RID(1) }, { kind: 1, scope: '@opentelemetry/instrumentation-http' }),
    span(TR(1), SP(2), SP(1), 'render route (app) /x', { 'next.span_type': 'AppRender.getBodyResult', 'next.route': '/x' }),
    span(TR(1), SP(10), SP(2), 'pg.query:SELECT', { 'db.statement': 'SELECT code FROM poc.listings' }, { scope: '@opentelemetry/instrumentation-pg' }),
    span(TR(1), SP(11), SP(2), 'pg.query:SELECT', { 'db.statement': 'SELECT code FROM poc.listings' }, { scope: '@opentelemetry/instrumentation-pg', startMs: T0 + 1 }),
    // 中継を通っていないトレース T2 の SQL（記録あり）。照合しない
    { ...callsite(20), traceId: TR(2) },
    span(TR(2), SP(30), null, 'GET', { 'http.target': '/y' }, { kind: 1, scope: '@opentelemetry/instrumentation-http' }),
    span(TR(2), SP(20), SP(30), 'pg.query:SELECT', { 'db.statement': 'SELECT code FROM poc.listings' }, { scope: '@opentelemetry/instrumentation-pg' }),
  ].map((x) => JSON.stringify(x.type ? x : { type: 'callsite', ...x, proc: { pid: 42 }, entry: { at: x.entry.at, frameSource: x.entry.frameSource, frames: x.entry.frames } }));
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  const st = new OB.ObservationStore();
  st.begin('r1');
  st.record('r1', { method: 'GET', path: '/x', hasQuery: false, kind: 'document', status: 200, startMs: T0, durationMs: 5, trace: { traceId: TR(1), spanId: SP(1) }, failure: null }, { relayId: RID(1) });
  st.record('r1', { method: 'GET', path: '/z', hasQuery: false, kind: 'document', status: 200, startMs: T0, durationMs: 5, trace: null, failure: null }, { relayId: 'not-hex' });
  const input = (run) => ({
    run: { instance: 'i', pid: 1, startedAt: 's' }, runString: run, project: 'p', port: 1,
    instrumentation: { state: 'enabled', reason: null, spanFile: f }, traceHeader: true,
    dataAccess: { projectRoot: proj, enabled: true, manifest: MANIFEST },
  });
  liveObs = await st.collect(input('r1'));
  eq('呼び出し位置の記録を数える（SQL のものだけ・同じファイル）', liveObs.callsite.records, 3);
  eq('照合は通信のトレースの SQL だけ（中継を通っていない T2 の SQL は照合しない）', liveObs.dataAccess.map((d) => d.spanId), [SP(10), SP(11)]);
  eq('SQL #10: 位置を特定', liveObs.dataAccess[0].site?.line, 4);
  eq('SQL #11: 記録のトレースが違う → 断定しない', liveObs.dataAccess[1].failure?.reason, 'callsite-mismatch');
  eq('形の違う中継の識別子は記録に持たない', liveObs.exchanges.find((e) => e.path === '/z').relayId, undefined);
  eq('中継が書き足すヘッダを明示する', liveObs.session.writtenRequestHeaders, ['x-vcide-relay']);
  ok('返す形に絶対パス（プロジェクト・収集ファイル）が無い', !JSON.stringify(liveObs).includes(tmp));
  ok('返す形にスタックのフレーム（生成物のパス）が無い', !JSON.stringify(liveObs).includes('.next/dev'));
  // 再起動: 新しいセッションでは前の照合結果を使わない（同じ spanId でも）
  st.begin('r2');
  const o2 = await st.collect({ ...input('r2'), instrumentation: { state: 'enabled', reason: null, spanFile: path.join(tmp, 'empty.jsonl') } });
  eq('再起動後: 前の起動の照合結果・記録を持たない', [o2.dataAccess.length, o2.callsite.records, o2.exchanges.length], [0, 0, 0]);
  st.end();
  eq('停止後は観測を返さない', await st.collect(input('r2')), null);
  // 7B-3A の形（dataAccess を渡さない）では照合しない
  const st3 = new OB.ObservationStore();
  st3.begin('r3');
  const o3 = await st3.collect({ ...input('r3'), dataAccess: undefined });
  ok('dataAccess を渡さなければ 7B-3A の形のまま（dataAccess / callsite を持たない）', !('dataAccess' in o3) && !('callsite' in o3));
}

/* ========================================================================== */
console.log('\n7. 変換（fromLiveRun）: 根拠のある queries だけ。executes と混同しない。選択した要素と結ばない');
{
  const ds = (o, seq, opts) => A.fromLiveRun(o, seq, opts).dataset;
  const d1 = ds(liveObs, 1);
  eq('validateDataset() を通過する', M.validateDataset(d1), []);
  ok('layout を通る', !!L.layout(d1).nodes.length);
  eq('ノード: 通信・サーバー処理・呼び出し位置・SQL・SQL（2本目は位置なし）・テーブル・カラム×2', d1.nodes.map((n) => n.kind), ['http', 'server', 'component', 'sql', 'sql', 'table', 'column', 'column']);
  const q = d1.hops.filter((h) => h.relation === 'queries');
  eq('queries は照合が通った1本だけ', q.length, 1);
  eq('queries: component → 1本目の SQL・server-call-stack・端点は DataAccessSite（列まで）',
    [d1.nodes.find((n) => n.id === q[0].from).kind, q[0].to, q[0].source, q[0].endpoints.from],
    ['component', d1.nodes[3].id, 'server-call-stack', { type: 'DataAccessSite', file: PAGE, line: 4, col: 19, inComponent: 'XPage' }]);
  const x = d1.hops.filter((h) => h.relation === 'executes');
  eq('executes は2本とも server → sql・trace-span（queries とは別）', x.map((h) => `${d1.nodes.find((n) => n.id === h.from).kind}:${h.source}`), ['server:trace-span', 'server:trace-span']);
  eq('queries の入る SQL では、executes も queries も shared-object', [q[0].convergence, x.find((h) => h.to === q[0].to).convergence], ['shared-object', 'shared-object']);
  ok('2本目の SQL（記録のトレースが違う）には queries を作らない', !d1.hops.some((h) => h.relation === 'queries' && h.to === d1.nodes[4].id));
  ok('2本目の SQL の詳細に「特定していません」と理由', d1.nodes[4].overview.some((r) => r.k === '実行した呼び出し位置' && r.v.startsWith('特定していません') && r.v.includes('別のトレース')));
  ok('supplies / derives / maps / binds / requests を作らない', !d1.hops.some((h) => ['supplies', 'derives', 'maps', 'binds', 'requests'].includes(h.relation)));
  ok('呼び出し位置のノードに「結果の行き先は未確認」の切断', d1.cuts.some((c) => c.from === q[0].from && c.head.includes('未確認')));
  ok('呼び出し位置のノードは帰属の範囲（インスタンスを同定しない）を書く', d1.nodes[2].overview.some((r) => r.k === '帰属の範囲' && r.v === M.ATTRIBUTION_SCOPE_NOTE.definitionOnly));
  ok('サーバー処理の主張: スパンだけではどのコードかは言えない（別の根拠で出している）', d1.nodes[1].overview.some((r) => r.k === '主張の範囲' && r.v.includes('別の根拠')));
  eq('handles は中継の識別子で結んだ（根拠に書く）', d1.hops.find((h) => h.relation === 'handles').evidence[0].startsWith('中継がこの要求のために作って'), true);
  eq('すべて実測（推定の関係を作っていない）', [...d1.nodes, ...d1.hops].every((v) => v.observability === 'measured'), true);

  /* 同じ位置から2本 → 位置のノードは1つ、線は2本（インスタンスは同定しない） */
  const both = { ...liveObs, dataAccess: [liveObs.dataAccess[0], { ...liveObs.dataAccess[0], spanId: SP(11) }] };
  const d2 = ds(both, 1);
  eq('同じ位置から2本: 位置のノード1つ・queries 2本', [d2.nodes.filter((n) => n.kind === 'component').length, d2.hops.filter((h) => h.relation === 'queries').length], [1, 2]);
  eq('validateDataset() を通過する（同じ位置から2本）', M.validateDataset(d2), []);

  /* 照合結果の traceId が SQL のスパンと違えば使わない（spanId が同じでも） */
  const alien = { ...liveObs, dataAccess: [{ ...liveObs.dataAccess[0], traceId: TR(66) }] };
  eq('照合結果のトレースが SQL と違えば queries を作らない', ds(alien, 1).hops.filter((h) => h.relation === 'queries').length, 0);

  /* 7B-3A の形の観測（照合なし）: 何も足さない */
  const plain = { ...liveObs, dataAccess: undefined, callsite: undefined };
  const d3 = ds(plain, 1);
  eq('照合の無い観測: コンポーネントのノード・queries を作らない', [d3.nodes.filter((n) => n.kind === 'component').length, d3.hops.filter((h) => h.relation === 'queries').length], [0, 0]);
  ok('照合の無い観測: サーバー処理の主張は 7B-3A の文言のまま', d3.nodes[1].overview.some((r) => r.v === 'ルート単位の処理です。どのコンポーネント・どの行が SQL を実行したかは観測していません'));

  /* 契約を破った複製を検査が検出する */
  const qh = d1.hops.find((h) => h.relation === 'queries');
  const noEnd = { ...d1, hops: d1.hops.map((h) => (h === qh ? { ...h, endpoints: undefined } : h)) };
  ok('queries の端点（ソース位置）を外すと validateDataset が検出する', M.validateDataset(noEnd).some((v) => v.includes('endpoints')));
  const wrongSrc = { ...d1, hops: d1.hops.map((h) => (h === qh ? M.hop({ ...h, source: 'element-anchor' }) : h)) };
  ok('queries を要素識別子（element-anchor）で作ると validateDataset が拒否する', M.validateDataset(wrongSrc).some((v) => v.includes('element-anchor')));
  const fromServer = { ...d1, hops: d1.hops.map((h) => (h === qh ? { ...h, from: d1.nodes[1].id } : h)) };
  ok('queries をサーバー処理（Span）から張ると validateDataset が拒否する（executes と混同しない）', M.validateDataset(fromServer).some((v) => v.includes('DataAccessSite')));
  const noConv = { ...d1, hops: d1.hops.map((h) => (h === qh ? { ...h, convergence: undefined } : h)) };
  ok('流入の意味（shared-object）を外すと validateDataset が検出する', M.validateDataset(noConv).some((v) => v.includes('convergence')));

  /* 選択した要素（7B-2）と並べる */
  const selection = {
    project: 'p', port: 1, page: { path: '/x', title: '' }, selectedAt: 't',
    selection: { tag: 'p', anchorOnSelf: 'aaaaaaaaaa', anchorOrdinal: 0, anchorInstanceCount: 1, ancestorAnchors: [], textNodeIndex: 0, valueShape: { chars: 1, cls: 'digit' }, formControl: false, path: '/x' },
    resolution: { status: 'resolved', anchor: { id: 'aaaaaaaaaa', tag: 'p', file: PAGE, line: 5, col: 10, component: 'XPage', componentLine: 3, sourceLine: '<p>' }, ancestors: [], chain: ['XPage'], directive: 'none', checks: ['c'] },
  };
  const d4 = ds(liveObs, 1, { selection });
  eq('validateDataset() を通過する（選択＋観測）', M.validateDataset(d4), []);
  eq('ノード: 値・描いた位置・通信・サーバー処理・実行した位置・SQL・SQL・テーブル・カラム×2', d4.nodes.map((n) => n.kind), ['value', 'component', 'http', 'server', 'component', 'sql', 'sql', 'table', 'column', 'column']);
  const ids = new Set(d4.nodes.map((n) => n.id));
  eq('ノードの識別子は重ならない', ids.size, d4.nodes.length);
  const drew = d4.nodes[1];
  const ran = d4.nodes[4];
  const touching = (id) => d4.hops.filter((h) => h.from === id || h.to === id).map((h) => h.relation).sort().join(',');
  eq('値に触れる関係は renders だけ', touching(d4.nodes[0].id), 'renders');
  eq('描いた位置に触れる関係は renders だけ（同じ XPage でも SQL へ線を引かない）', touching(drew.id), 'renders');
  eq('実行した位置に触れる関係は queries だけ', touching(ran.id), 'queries');
  eq('描いた位置と実行した位置は同じ定義（XPage）だが別のノード', [drew.chipSub, ran.chipSub, drew.id !== ran.id], ['XPage', 'XPage', true]);
  ok('描いた位置: 「同じ定義の中にあることは根拠にしていません」', drew.overview.some((r) => r.k === 'SQL との関係' && r.v.includes('同じ定義の中にあることは根拠にしていません')));
  ok('描いた位置の切断: 「この値の由来は未確認です」', d4.cuts.some((c) => c.from === drew.id && c.head === 'この値の由来は未確認です'));
  ok('値: この要素を描いた文書取得がこの通信かは特定していない', d4.nodes[0].overview.some((r) => r.k === '通信との関係' && r.v.includes('特定していません')));
  ok('選択と並べたとき、実行した位置には二重に切断を付けない（値の側の切断だけ）', !d4.cuts.some((c) => c.from === ran.id));
  ok('provenance に「選択した要素を描いた文書取得の同定」を観測していないと書く', d4.provenance.notObserved.some((n) => n.what.includes('文書取得の同定')));
  ok('supplies / derives を作らない（選択＋観測）', !d4.hops.some((h) => ['supplies', 'derives', 'maps', 'binds'].includes(h.relation)));
  /* 未証明の supplies を足すと検査が拒否する（構造的に推定であり、実測の取得手段で作れない） */
  const forgedSupplies = { ...d4, hops: [...d4.hops, M.hop({ id: 'sup', order: 99, from: ran.id, to: drew.id, relation: 'supplies', label: 'x', source: 'server-call-stack', evidence: [], endpoints: { from: { type: 'DataAccessSite', file: PAGE, line: 4 }, to: { type: 'PropBindingSite', file: PAGE, line: 5 } } })] };
  ok('server-call-stack で supplies を作ると validateDataset が拒否する', M.validateDataset(forgedSupplies).some((v) => v.includes('supplies')));

  /* 選択と並べるとコンポーネントは2つまで: 実行した位置が2つあれば、2つ目はノードを描かず詳細に書く */
  const two = { ...liveObs, dataAccess: [liveObs.dataAccess[0], { ...liveObs.dataAccess[0], spanId: SP(11), site: { ...liveObs.dataAccess[0].site, line: 8, col: 9 } }] };
  const d5 = ds(two, 1, { selection });
  eq('選択＋位置2つ: コンポーネントのノードは2つまで（3つ目は描かない）', d5.nodes.filter((n) => n.kind === 'component').length, 2);
  ok('描かなかった位置は SQL の詳細に書く（線は描いていないと明記）', d5.nodes.some((n) => n.kind === 'sql' && n.overview.some((r) => r.k === '実行した呼び出し位置' && r.v.includes('ノードと線は描いていません'))));
  eq('validateDataset() を通過する（上限）', M.validateDataset(d5), []);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
