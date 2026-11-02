/* =============================================================================
 * Phase 7B-3A — いまの起動の HTTP・サーバー処理・SQL の観測（ブラウザを使わない部分）。
 *   npm run build:lib && node tests/observe-unit.spec.mjs
 *
 *   1. 契約: 取得手段 preview-relay（L0）の追加が、関係の表を変えていないこと
 *   2. 中継での分類: クエリの値・URL の全体を持たない／静的資材は数だけ／トレース識別子の形
 *   3. 観測の台帳: 起動ごとのセッション・別の起動の記録を捨てる・停止で閉じる
 *   4. 収集ファイル: 通信のトレースに属するスパンだけ・Phase 6F の解析器で SQL を解析する
 *   5. 中継（本物の PreviewGateway ＋ 代役の開発サーバー）: 記録・ヘッダを落とす・失敗
 *   6. 変換（fromLiveRun）: 観測できない関係を作らない（否定例）・validateDataset
 *   7. 7C-1 保持の方式: 古い通信を外す・文書の保持・保持の依頼・保持対象外の理由・起動をまたがない
 *   8. 7C-1 スパンの整理と、画面へ返す形（要約・詳細・指紋）
 *   9. 7C-1 収集ファイルの整理（消してよいものだけを消す）
 *
 * ここで使う観測は**試験のために組んだ入力**である（画面には出ない）。実データでの確認は observe-e2e。
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
const GW = require_('../.libjs/server/previewGateway.js');
const AC = require_('../.libjs/server/access.js');
const REPO = path.resolve(import.meta.dirname, '..');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/* ========================================================================== */
console.log('\n1. 契約: preview-relay は L0 の取得手段。関係の表は変えていない');
eq('preview-relay の既定レベルは L0', M.SOURCE_LEVEL['preview-relay'], 'L0');
eq('preview-relay は実測', M.observabilityOf('preview-relay'), 'measured');
ok('画面の文言がある', typeof M.SOURCE_LABEL['preview-relay'] === 'string' && M.SOURCE_LABEL['preview-relay'].includes('中継'));
ok('preview-relay は requests（開始元の帰属）の根拠にならない', !M.RELATION_SPEC.requests.sources.includes('preview-relay'));
ok('preview-relay はどの関係の取得手段でもない（ノードだけ）', Object.values(M.RELATION_SPEC).every((r) => !r.sources.includes('preview-relay')));
eq('handles は従来どおり trace-context / time-window', M.RELATION_SPEC.handles.sources, ['trace-context', 'time-window']);
eq('関係種別は12件のまま', Object.keys(M.RELATION_SPEC).length, 12);
{
  const doc = fs.readFileSync(path.join(REPO, 'docs', '02d-observability-information-model.md'), 'utf8');
  ok('02d 1.3 の表に preview-relay がある（表と実装を食い違わせない）', /\| \*\*`preview-relay`\*\* \|.*\| \*\*L0\*\* \|/.test(doc));
  ok('02d 1.3.3 に browser-network と分けた理由がある', doc.includes('#### 1.3.3 `preview-relay`'));
}

/* ========================================================================== */
console.log('\n2. 中継での分類（URL の全体を持たない）');
{
  const c = LO.classifyRelayRequest('/api/listings?token=SECRET-Q&x=1', 'empty', undefined);
  eq('パスだけを返す', c.path, '/api/listings');
  eq('クエリは「付いていた」だけ', c.hasQuery, true);
  ok('クエリの値はどこにも無い', !JSON.stringify(c).includes('SECRET-Q'));
  eq('sec-fetch-dest: empty → fetch', c.kind, 'fetch');
  eq('sec-fetch-dest: document → document', LO.classifyRelayRequest('/', 'document').kind, 'document');
  eq('sec-fetch-dest: iframe → document（プレビューの中の文書）', LO.classifyRelayRequest('/', 'iframe').kind, 'document');
  eq('rsc: 1 → rsc（ページ内の遷移）', LO.classifyRelayRequest('/listings?_rsc=abc', 'empty', '1').kind, 'rsc');
  eq('Sec-Fetch-Dest が無い → unknown（推測しない）', LO.classifyRelayRequest('/x', undefined).kind, 'unknown');
  eq('それ以外 → other', LO.classifyRelayRequest('/x', 'image').kind, 'other');
  eq('/_next/* は静的資材', LO.classifyRelayRequest('/_next/static/chunks/a.js', 'script').static, true);
  eq('拡張子つきの資材は静的資材', LO.classifyRelayRequest('/logo.svg', 'image').static, true);
  eq('favicon は静的資材', LO.classifyRelayRequest('/favicon.ico', 'image').static, true);
  eq('?  だけ（値なし）はクエリ無し扱い', LO.classifyRelayRequest('/a?', 'empty').hasQuery, false);
  eq('# 以降は持たない', LO.classifyRelayRequest('/a#frag', 'empty').path, '/a');
}
eq('traceparent を読む', LO.parseTraceparent(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`), { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
eq('全ゼロのトレース識別子は無効', LO.parseTraceparent(`00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`), null);
eq('形の違うものは受けない', LO.parseTraceparent('00-xyz-1-01'), null);
eq('文字列でなければ受けない', LO.parseTraceparent(['00-a']), null);

/* ========================================================================== */
console.log('\n3. 観測の台帳（起動ごとのセッション）');
const TR = (n) => n.toString(16).padStart(32, '0');
const SP = (n) => n.toString(16).padStart(16, '0');
const rec = (p, trace, extra = {}) => ({
  method: 'GET', path: p, hasQuery: false, kind: 'fetch', status: 200, startMs: 1000, durationMs: 10,
  trace, failure: null, ...extra,
});
{
  const st = new OB.ObservationStore();
  st.record('run-A', rec('/x', null));
  eq('セッションが無ければ記録しない', st.current(), null);
  st.begin('run-A');
  st.record('run-A', rec('/a', null));
  st.record('run-B', rec('/b', null));
  st.excludeStatic('run-A');
  st.excludeStatic('run-B');
  const inp = (run) => ({ run: { instance: 'i', pid: 1, startedAt: 's' }, runString: run, project: 'p', port: 3000, instrumentation: { state: 'disabled', reason: 'test', spanFile: null }, traceHeader: false });
  const oA = await st.collect(inp('run-A'));
  eq('いまの起動の記録だけを持つ（別の起動の記録は捨てる）', oA.exchanges.map((e) => e.path), ['/a']);
  eq('静的資材は数だけ（別の起動の分は数えない）', oA.session.excludedStatic, 1);
  eq('通し番号は1から', oA.exchanges[0].seq, 1);
  eq('別の起動を指す取得は null（呼び出し側で 409）', await st.collect(inp('run-B')), null);
  st.begin('run-B');
  const oB = await st.collect(inp('run-B'));
  eq('新しい起動では新しいセッション（前の記録は無い）', oB.exchanges.length, 0);
  st.end();
  eq('停止で閉じる', await st.collect(inp('run-B')), null);
  st.begin('run-C');
  for (let i = 0; i < 205; i++) st.record('run-C', rec(`/n${i}`, null));
  const oC = await st.collect(inp('run-C'));
  /* 7C-1: 7C-0 までは「上限（200件）を超えた**新しい**通信は数だけ」だった（P0-1 の原因）。
   * 意図（観測が際限なく増えない）は保ち、捨てる側を**古い**通信に変えた */
  eq('7C-1: 200件を超えたら古い通信を外す（新しい通信は記録する）', [oC.exchanges.length, oC.session.retention.evicted, oC.exchanges[0].seq, oC.exchanges.at(-1).seq], [200, 5, 6, 205]);
  eq('7C-1: 最新の通信（#205 /n204）を持っている', oC.exchanges.at(-1).path, '/n204');
  eq('7C-1: 記録した数は外したものを含む累計（＝最新の番号）', oC.session.recorded, 205);
}

/* ========================================================================== */
console.log('\n4. 収集ファイル: 通信のトレースに属するスパンだけ・Phase 6F の解析器');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-obs-'));
const spanFile = path.join(tmp, 'run.jsonl');
const span = (traceId, spanId, parent, name, attrs = {}, extra = {}) => ({
  type: 'span', traceId, spanId, parentSpanId: parent, name, kind: 0, startMs: 1000, endMs: 1010,
  durationMs: 10, statusCode: 0, scope: 'next.js', attrs, droppedAttributeKeys: [], sqlRedacted: null, ...extra,
});
const lines = [
  { type: 'note', kind: 'registered', detail: 'x' },
  span(TR(1), SP(1), null, 'GET', { 'http.target': '/api/x' }, { kind: 1, scope: '@opentelemetry/instrumentation-http' }),
  span(TR(1), SP(2), SP(1), 'executing api route (app) /api/x', { 'next.span_type': 'AppRouteRouteHandlers.runHandler', 'next.route': '/api/x' }, { startMs: 1001 }),
  span(TR(1), SP(3), SP(2), 'pg.query:SELECT', { 'db.statement': 'SELECT code FROM poc.listings ORDER BY id LIMIT $0' }, { scope: '@opentelemetry/instrumentation-pg', startMs: 1002, sqlRedacted: { strings: 0, numbers: 1 } }),
  span(TR(1), SP(4), SP(2), 'pg.query:INSERT', { 'db.statement': 'INSERT INTO poc.listing_views (listing_id, viewed_on, views) VALUES ($0, $0, $0)' }, { scope: '@opentelemetry/instrumentation-pg', startMs: 1003 }),
  // 同じ時刻・同じ SQL の、**別のトレース**（中継を通っていない処理）
  span(TR(2), SP(10), null, 'GET', { 'http.target': '/' }, { kind: 1, scope: '@opentelemetry/instrumentation-http' }),
  span(TR(2), SP(11), SP(10), 'pg.query:SELECT', { 'db.statement': 'SELECT name FROM poc.regions' }, { scope: '@opentelemetry/instrumentation-pg', startMs: 1002 }),
];
fs.writeFileSync(spanFile, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"span","traceId":"書きかけ`);
let liveObs;
{
  const st = new OB.ObservationStore();
  st.begin('r');
  st.record('r', rec('/api/x', { traceId: TR(1), spanId: SP(1) }));
  st.record('r', rec('/no-trace', null));
  liveObs = await st.collect({ run: { instance: 'i', pid: 1, startedAt: 's' }, runString: 'r', project: 'p', port: 3000, instrumentation: { state: 'enabled', reason: null, spanFile }, traceHeader: true });
  ok('通信のトレースのスパンだけを返す（別のトレースの同時刻の SQL を入れない）', liveObs.spans.every((s) => s.traceId === TR(1)), liveObs.spans.map((s) => s.traceId));
  eq('書きかけの最終行は読まない', liveObs.instrumentation.spanRecords, 6);
  eq('中継を通らない HTTP 処理は数だけ', liveObs.serverOnlyRequests, 1);
  eq('解析器を使えた', liveObs.parser.available, true);
  const sel = liveObs.sqlAnalyses.find((a) => a.spanId === SP(3));
  eq('Phase 6F: 結果列は SELECT 句だけ（ORDER BY id の id は入らない）', sel.projections.map((p) => p.column), ['code']);
  ok('Phase 6F: id は「SELECT句の外で参照」として残す', sel.unresolved.some((u) => u.column === 'id' && u.why === 'referenced-outside-select-list'));
  eq('取得時点の除去の件数を運ぶ', sel.redacted, { strings: 0, numbers: 1 });
  ok('返す形に収集ファイルの絶対パスが無い', !JSON.stringify(liveObs).includes(tmp));
  // 差分の読み取り: 書きかけの行が書き終わると読む
  fs.appendFileSync(spanFile, `${'x'.repeat(0)}"}\n`);
  const again = await st.collect({ run: { instance: 'i', pid: 1, startedAt: 's' }, runString: 'r', project: 'p', port: 3000, instrumentation: { state: 'enabled', reason: null, spanFile }, traceHeader: true });
  eq('壊れた行は飛ばし、件数は変わらない（差分だけ読む）', again.instrumentation.spanRecords, 6);
}

/* ========================================================================== */
console.log('\n5. 中継（本物の PreviewGateway ＋ 代役の開発サーバー）');
{
  const TP = `00-${TR(7)}-${SP(7)}-01`;
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/slow')) { setTimeout(() => { res.writeHead(200); res.end('x'); }, 2000); return; }
    res.writeHead(req.url.startsWith('/missing') ? 404 : 200, {
      'content-type': req.url.startsWith('/page') ? 'text/html' : 'application/json',
      'x-vcide-trace': TP,
      'server-timing': 'app;dur=1',
    });
    res.end(req.url.startsWith('/page') ? '<html><head></head><body>hi</body></html>' : '{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const recs = [];
  let statics = 0;
  const observer = { record: (run, r) => recs.push({ run, ...r }), excludeStatic: () => { statics++; } };
  const cfg = AC.accessConfig({});
  let run = 'RUN-1';
  let alive = true;
  const gw = new GW.PreviewGateway({
    config: cfg, port: await freePort(),
    target: () => (alive ? { target: { port: upPort, run }, reason: '' } : { target: null, reason: 'stopped' }),
    observer,
  });
  const info = await gw.ensure();
  const get = (p, headers = {}) => new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: info.port, path: p, headers: { host: `127.0.0.1:${info.port}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ error: e.code }));
  });
  const wait = (n) => new Promise((r) => { const t = setInterval(() => { if (recs.length >= n) { clearInterval(t); r(); } }, 10); setTimeout(() => { clearInterval(t); r(); }, 3000); });

  const r1 = await get('/api/x?token=SECRET-GW', { 'sec-fetch-dest': 'empty', cookie: 'sid=SECRET-COOKIE', authorization: 'Bearer SECRET-AUTH' });
  await wait(1);
  eq('応答は届く', r1.status, 200);
  eq('ブラウザへ X-Vcide-Trace を渡さない', r1.headers['x-vcide-trace'], undefined);
  eq('アプリ自身の Server-Timing は変えない', r1.headers['server-timing'], 'app;dur=1');
  eq('記録: 起動の鍵', recs[0]?.run, 'RUN-1');
  eq('記録: パス・クエリの有無・種類・状態', [recs[0]?.path, recs[0]?.hasQuery, recs[0]?.kind, recs[0]?.status], ['/api/x', true, 'fetch', 200]);
  eq('記録: トレース識別子', recs[0]?.trace, { traceId: TR(7), spanId: SP(7) });
  ok('記録にクエリの値・Cookie・Authorization が無い', !/SECRET/.test(JSON.stringify(recs)), recs);
  eq('記録のキーは決めたものだけ', Object.keys(recs[0] ?? {}).sort(), ['durationMs', 'failure', 'hasQuery', 'kind', 'method', 'path', 'run', 'startMs', 'status', 'trace']);
  await get('/_next/static/a.js', { 'sec-fetch-dest': 'script' });
  await new Promise((r) => setTimeout(r, 100));
  eq('静的資材は記録せず数だけ', [recs.length, statics], [1, 1]);
  const r404 = await get('/missing', { 'sec-fetch-dest': 'empty' });
  await wait(2);
  eq('404 も開発サーバーの応答として記録する', [r404.status, recs[1]?.status], [404, 404]);
  const page = await get('/page', { 'sec-fetch-dest': 'iframe' });
  await wait(3);
  ok('HTML には従来どおりスクリプトを差し込む', page.body.includes('/__vcide_preview/agent.js'));
  eq('文書の取得として記録', recs[2]?.kind, 'document');
  run = 'RUN-2';
  await get('/api/y', { 'sec-fetch-dest': 'empty' });
  await wait(4);
  eq('別の起動の転送は別の鍵で記録する（台帳が捨てる）', recs[3]?.run, 'RUN-2');
  // 転送先が落ちている: 応答なしとして記録（中継の説明 502 は開発サーバーの応答ではない）
  const deadGw = new GW.PreviewGateway({ config: cfg, port: await freePort(), target: () => ({ target: { port: 1, run: 'RUN-D' }, reason: '' }), observer });
  const dInfo = await deadGw.ensure();
  await new Promise((resolve) => http.get({ host: '127.0.0.1', port: dInfo.port, path: '/api/z', headers: { host: `127.0.0.1:${dInfo.port}` } }, (res) => { res.resume(); res.on('end', resolve); }));
  await wait(5);
  eq('転送先に届かない → status null・failure upstream-error', [recs[4]?.status, recs[4]?.failure?.kind, recs[4]?.trace], [null, 'upstream-error', null]);
  alive = false;
  await get('/api/stopped', { 'sec-fetch-dest': 'empty' });
  await new Promise((r) => setTimeout(r, 100));
  eq('実行中でなければ転送も記録もしない', recs.length, 5);
  await gw.close(); await deadGw.close(); upstream.close();
}

/* ========================================================================== */
console.log('\n6. 変換（fromLiveRun）: 観測できない関係を作らない');
{
  const ds = (o, seq) => A.fromLiveRun(o, seq).dataset;
  const d1 = ds(liveObs, 1);
  eq('validateDataset() を通過する', M.validateDataset(d1), []);
  ok('layout を通る', !!L.layout(d1).nodes.length);
  eq('ノード: 通信・サーバー処理・SQL 2本・テーブル1（書き込み先は reads にしない）・カラム1',
    d1.nodes.map((n) => n.kind), ['http', 'server', 'sql', 'sql', 'table', 'column']);
  eq('通信の取得手段は preview-relay・観測位置は browser', [d1.nodes[0].source, d1.nodes[0].exchangeScope], ['preview-relay', 'browser']);
  eq('サーバー処理はルート単位のスパン（runHandler）', d1.nodes[1].identifier, 'executing api route (app) /api/x');
  eq('関係: handles(trace-context) / executes×2 / reads / projects',
    d1.hops.map((h) => `${h.relation}:${h.source}`),
    ['handles:trace-context', 'executes:trace-span', 'executes:trace-span', 'reads:sql-ast-parse', 'projects:sql-ast-parse']);
  ok('INSERT の書き込み先を reads にしない', !d1.nodes.some((n) => n.identifier === 'poc.listing_views'));
  ok('requests / derives / maps / supplies / binds を作らない', !d1.hops.some((h) => ['requests', 'derives', 'maps', 'supplies', 'binds'].includes(h.relation)));
  ok('表示された値・コンポーネントのノードを作らない', !d1.nodes.some((n) => n.kind === 'value' || n.kind === 'component'));
  ok('別のトレースの同時刻の SQL（poc.regions）を結ばない', !d1.nodes.some((n) => /regions/.test(n.identifier)));
  ok('上流の切断を必ず置く', d1.cuts.some((c) => c.from === 1 && c.head.includes('上流')));
  ok('テーブル・カラムの型は「未取得」（情報スキーマに照会していない）', d1.nodes.find((n) => n.kind === 'column').overview.some((r) => r.v.includes('未取得')));
  eq('すべて実測（推定の関係を作っていない）', [...d1.nodes, ...d1.hops].every((x) => x.observability === 'measured'), true);

  const d2 = ds(liveObs, 2);
  eq('トレース識別子が無い通信: ノードは通信だけ・ホップ0本', [d2.nodes.length, d2.hops.length], [1, 0]);
  ok('理由を書く（時間の重なりで結ばない）', d2.nodes[0].overview.some((r) => r.k === 'サーバー処理' && r.v.includes('専用ヘッダがありませんでした')));
  eq('validateDataset() を通過する', M.validateDataset(d2), []);

  // スパンがまだ書かれていない（応答の後に閉じる）
  const pending = { ...liveObs, exchanges: [{ ...liveObs.exchanges[0], seq: 9, trace: { traceId: TR(99), spanId: SP(99) } }] };
  const d3 = ds(pending, 9);
  eq('トレース識別子が指すスパンが無い → サーバー処理を作らない', d3.nodes.map((n) => n.kind), ['http']);
  ok('理由: まだ収集ファイルに書かれていない', d3.nodes[0].overview.some((r) => r.v.includes('まだ収集ファイルに書かれていません')));

  // 識別子が別の通信のトレースを指している（アプリが書き換えた場合など）: 断る
  const forgedTrace = { ...liveObs, exchanges: [{ ...liveObs.exchanges[0], seq: 8, path: '/other' }] };
  eq('受付スパンのパスと通信のパスが違えば結ばない', ds(forgedTrace, 8).nodes.map((n) => n.kind), ['http']);
  ok('理由: パスが一致しない', ds(forgedTrace, 8).nodes[0].overview.some((r) => r.v.includes('パスが、この通信のパスと一致しません')));

  // 計装なし
  const noIns = { ...liveObs, instrumentation: { ...liveObs.instrumentation, state: 'disabled', reason: '利用者が計装なしを選びました。' } };
  eq('計装なし → 通信だけ', ds(noIns, 1).nodes.map((n) => n.kind), ['http']);

  // 解析器を使えない → SQL は描くが、テーブル・カラムは作らない（推測で埋めない）
  const noParser = { ...liveObs, sqlAnalyses: [], parser: { available: false, reason: '読み込めません' } };
  const d4 = ds(noParser, 1);
  eq('解析器なし → SQL は描く・テーブル・カラムは作らない', d4.nodes.map((n) => n.kind), ['http', 'server', 'sql', 'sql']);
  eq('validateDataset() を通過する', M.validateDataset(d4), []);

  // 構文解析に失敗した SQL
  const bad = { ...liveObs, sqlAnalyses: liveObs.sqlAnalyses.map((a) => ({ ...a, parseOk: false, parseError: 'x', tables: [], projections: [] })) };
  eq('解析に失敗 → テーブル・カラムを作らない', ds(bad, 1).nodes.filter((n) => n.kind === 'table' || n.kind === 'column').length, 0);

  // 同じテーブルを2本の SQL が読む → shared-object
  const two = {
    ...liveObs,
    sqlAnalyses: liveObs.sqlAnalyses.map((a) => ({ ...a, tables: [{ schema: 'poc', name: 'listings', op: 'select' }] })),
  };
  const d5 = ds(two, 1);
  eq('同じテーブルへの reads は shared-object', d5.hops.filter((h) => h.relation === 'reads').map((h) => h.convergence), ['shared-object', 'shared-object']);
  eq('validateDataset() を通過する（流入2本）', M.validateDataset(d5), []);
  // 契約を破った複製を検査が検出する（検査が飾りでないこと）
  const broken = { ...d5, hops: d5.hops.map((h) => (h.relation === 'reads' ? { ...h, convergence: undefined } : h)) };
  ok('convergence を外すと validateDataset が検出する', M.validateDataset(broken).some((v) => v.includes('convergence')));
  const forged = { ...d1, hops: [...d1.hops, M.hop({ id: 'x', order: 99, from: 1, to: 2, relation: 'requests', label: 'x', source: 'preview-relay', evidence: [] })] };
  ok('中継の記録で requests を作ると validateDataset が拒否する', M.validateDataset(forged).some((v) => v.includes('preview-relay')));

  eq('一覧の見出し（クエリは …）', A.liveExchangeLabel({ seq: 3, method: 'GET', path: '/a', hasQuery: true, status: 200, failure: null }), '#3 GET /a?… — 200');
}
fs.rmSync(tmp, { recursive: true, force: true });

/* ========================================================================== */
console.log('\n7. 7C-1 保持の方式（スライディングウィンドウ・文書の保持・保持の依頼・保持対象外）');
const OV = require_('../.libjs/server/observationView.js');
const SF = require_('../.libjs/server/spanFiles.js');
const RID = (n) => `a${n.toString(16).padStart(31, '0')}`;
const DOCT = (n) => `d${n.toString(16).padStart(31, '0')}`;
{
  eq('定数: 直近200件・文書50件・依頼8件', [OB.WINDOW, OB.DOC_RESERVE, OB.PIN_LIMIT], [200, 50, 8]);
  const st = new OB.ObservationStore();
  let clock = 1_000_000;
  st.now = () => clock;
  const inp = (run) => ({ run: { instance: 'i', pid: 1, startedAt: 's' }, runString: run, project: 'p', port: 3000, instrumentation: { state: 'disabled', reason: 'test', spanFile: null }, traceHeader: false });
  st.begin('R');
  // #1: 文書（文書の識別子つき）、#2: その後の同じパスの RSC、#3..: API の連打
  st.record('R', rec('/doc', null, { kind: 'document' }), { relayId: RID(1), docToken: DOCT(1) });
  st.record('R', rec('/doc', null, { kind: 'rsc', startMs: 2000 }), { relayId: RID(2) });
  st.record('R', rec('/pinned', null), { relayId: RID(3) });
  st.pin('R', [3]);
  for (let i = 4; i <= 260; i++) st.record('R', rec(`/api/${i}`, null), { relayId: RID(i) });
  let o = await st.collect(inp('R'));
  const seqs = o.exchanges.map((e) => e.seq);
  ok('通し番号は単調増加で重複しない', seqs.every((x, i) => i === 0 || x > seqs[i - 1]), seqs.slice(0, 5));
  ok('直近200件（#61〜#260）を持つ', seqs.includes(61) && seqs.includes(260) && !seqs.includes(60));
  ok('文書（#1）は直近200件の外でも持つ（文書の保持）', seqs.includes(1));
  ok('RSC（#2）は外す', !seqs.includes(2));
  ok('保持を頼まれた通信（#3）は外さない', seqs.includes(3));
  eq('保持の状態', [o.session.retention.retained, o.session.retention.evicted, o.session.retention.pinned], [202, 58, [3]]);

  // 外した通信を参照した文書の同定（保持対象外の理由）
  const hist = st.history('R');
  eq('外した通信の記録はサーバーの中にある', hist.evicted.length, 58);
  ok('外した記録に中継の識別子・トレースを持たない（必要なものだけ）', hist.evicted.every((e) => !('relayId' in e) && !('trace' in e)));
  const b1 = LO.bindDocument(o, { token: DOCT(1), soft: false }, '/doc', hist);
  eq('文書を持っていても、外した RSC の再取得を見落とさない', [b1.status, b1.reason], ['unidentified', 'refetched-after-document']);
  st.record('R', rec('/old', null, { kind: 'document', startMs: 3000 }), { relayId: RID(900), docToken: DOCT(900) });
  for (let i = 0; i < 60; i++) st.record('R', rec('/doc2', null, { kind: 'document', startMs: 4000 + i }), { relayId: RID(1000 + i), docToken: DOCT(1000 + i) });
  for (let i = 0; i < 200; i++) st.record('R', rec(`/flood/${i}`, null), { relayId: RID(2000 + i) });
  o = await st.collect(inp('R'));
  const hist2 = st.history('R');
  const b2 = LO.bindDocument(o, { token: DOCT(900), soft: false }, '/old', hist2);
  eq('保持範囲から外れた文書 → exchange-evicted（保持対象外）', b2.reason, 'exchange-evicted');
  ok('理由に番号と保持範囲を書く', /通信 #261（\/old）/.test(b2.detail) && b2.detail.includes('直近 200 件'), b2.detail);
  ok('理由の文に「保持対象外」がある', LO.DOC_UNBOUND_LABEL['exchange-evicted'].includes('保持対象外'));
  const newestDoc = o.exchanges.filter((e) => e.docToken).at(-1);
  eq('API の連打の後も、直近の文書は持っている（文書の保持）', newestDoc?.path, '/doc2');
  eq('直近の文書は同定できる', LO.bindDocument(o, { token: newestDoc.docToken, soft: false }, '/doc2', hist2).status, 'identified');
  eq('いまの起動に無い識別子 → token-not-in-session（従来どおり）', LO.bindDocument(o, { token: DOCT(77777), soft: false }, '/doc2', hist2).reason, 'token-not-in-session');
  // 期限切れの依頼は外れる
  clock += OB.PIN_LEASE_MS + 1;
  st.record('R', rec('/tick', null), { relayId: RID(5000) });
  o = await st.collect(inp('R'));
  ok('期限の切れた依頼は外れ、頼まれていた通信も外れる', !o.exchanges.some((e) => e.seq === 3) && o.session.retention.pinned.length === 0);
  st.pin('R', [3]);
  ok('外した通信は頼んでも生き返らない', !(await st.collect(inp('R'))).exchanges.some((e) => e.seq === 3));
  // 依頼の上限
  const recent = o.exchanges.slice(-12).map((e) => e.seq);
  st.pin('R', recent);
  eq('依頼は最大8件', (await st.collect(inp('R'))).session.retention.pinned.length, 8);
  // 記録の上限（HISTORY_LIMIT）を超えたら、範囲だけを残し、それより後の文書は保守的に断る
  const st2 = new OB.ObservationStore();
  st2.begin('H');
  st2.record('H', rec('/keep', null, { kind: 'document' }), { relayId: RID(1), docToken: DOCT(1) });
  st2.pin('H', [1]);
  for (let i = 0; i < OB.HISTORY_LIMIT + 300; i++) { st2.record('H', rec(`/x${i}`, null), { relayId: RID(10 + i) }); if (i % 1000 === 0) st2.pin('H', [1]); }
  const oH = await st2.collect(inp('H'));
  const hH = st2.history('H');
  eq('記録の上限: 外した通信の記録は HISTORY_LIMIT 件まで', hH.evicted.length, OB.HISTORY_LIMIT);
  ok('整理した番号の範囲を持つ', hH.lostThroughSeq > 1 && oH.session.retention.historyLostThroughSeq === hH.lostThroughSeq);
  eq('保持中の文書でも、後の記録を整理済みなら断る（history-evicted）', LO.bindDocument(oH, { token: DOCT(1), soft: false }, '/keep', hH).reason, 'history-evicted');
  // 起動をまたいで混ぜない
  st.begin('R2');
  const oN = await st.collect(inp('R2'));
  eq('新しい起動: 通信・外した記録・依頼を持たない', [oN.exchanges.length, oN.session.retention.evicted, st.history('R2').evicted.length, oN.session.retention.pinned], [0, 0, 0, []]);
  st.record('R2', rec('/a', null));
  eq('新しい起動の番号は1から', (await st.collect(inp('R2'))).exchanges[0].seq, 1);
  eq('前の起動の記録は返さない', st.history('R'), null);
  ok('要約でない観測を bindDocument に渡す（画面の観測を誤って使わない）', (() => { try { LO.bindDocument({ ...oN, detailSeqs: [] }, { token: DOCT(1), soft: false }, '/a'); return false; } catch { return true; } })());
}

/* ========================================================================== */
console.log('\n8. 7C-1 スパンの整理: 外した通信のトレースを消す・誤接続しない・猶予・上限');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-ret-'));
  const f = path.join(dir, 'run.jsonl');
  fs.writeFileSync(f, '');
  const st = new OB.ObservationStore();
  let clock = 5_000_000;
  st.now = () => clock;
  const inp = { run: { instance: 'i', pid: 1, startedAt: 's' }, runString: 'S', project: 'p', port: 3000, instrumentation: { state: 'enabled', reason: null, spanFile: f }, traceHeader: true };
  st.begin('S');
  const httpRoot = (n, p) => span(TR(n), SP(n * 10), null, 'GET', { 'http.target': p, 'vcide.relay.id': RID(n) }, { kind: 1, scope: '@opentelemetry/instrumentation-http' });
  const sql = (n) => span(TR(n), SP(n * 10 + 1), SP(n * 10), 'pg.query:SELECT', { 'db.statement': `SELECT c${n} FROM poc.t${n}` }, { scope: '@opentelemetry/instrumentation-pg' });
  const add = (n, p) => {
    fs.appendFileSync(f, `${JSON.stringify(httpRoot(n, p))}\n${JSON.stringify(sql(n))}\n`);
    st.record('S', rec(p, { traceId: TR(n), spanId: SP(n * 10) }), { relayId: RID(n) });
  };
  for (let n = 1; n <= 250; n++) add(n, `/p${n}`);
  // どの通信にも属さないトレース（IDE の生存確認など）
  fs.appendFileSync(f, `${JSON.stringify(span(TR(9999), SP(99990), null, 'GET', { 'http.target': '/health' }, { kind: 1, scope: '@opentelemetry/instrumentation-http' }))}\n`);
  let o = await st.collect(inp);
  eq('持つスパン = 持っている200件 × 2本 + 属さない1本', o.session.retention.retainedSpans, 401);
  eq('読んだスパンは全件を数える', o.instrumentation.spanRecords, 501);
  ok('返す観測に、外した通信のトレースのスパンが無い', !o.spans.some((s) => s.traceId === TR(10)));
  const full = o;
  const last = full.exchanges.at(-1);
  const links = A.liveExchangeLinks(full, last);
  eq('最新の通信は自分のトレースの SQL に結ぶ（外した通信の SQL に誤接続しない）', links.sql.map((s) => s.spanId), [SP(2501)]);
  eq('中継を通らない処理は数だけ', o.serverOnlyRequests, 1);
  // 外した通信の遅れて書かれたスパン → どの通信にも属さない。猶予の後に整理
  fs.appendFileSync(f, `${JSON.stringify(sql(5))}\n`);
  o = await st.collect(inp);
  eq('外した通信の遅れて書かれたスパンは、読んだ時点で整理する（持たない）', o.session.retention.retainedSpans, 401);
  ok('……どの通信にも結ばない', !o.exchanges.some((e) => A.liveExchangeLinks(o, e).sql.some((s) => s.traceId === TR(5))));
  eq('……中継を通らない処理には数えない', o.serverOnlyRequests, 1);
  // 書き終わる前の通信のスパン（まだ記録が無い）は猶予の間は持つ
  fs.appendFileSync(f, `${JSON.stringify(httpRoot(251, '/p251'))}\n`);
  o = await st.collect(inp);
  eq('まだ記録の無い通信のスパンは猶予の間は持つ', o.session.retention.retainedSpans, 402);
  clock += OB.ORPHAN_GRACE_MS + 1;
  o = await st.collect(inp);
  eq('新しい書き込みが無くても、猶予の後に整理する（属さないトレース2つ）', o.session.retention.retainedSpans, 400);
  eq('整理した受付スパンも「中継を通らない処理」に数える', o.serverOnlyRequests, 2);

  // 7C-1 画面へ返す形: 要約＋選んだ通信の詳細＋指紋
  const view = OV.observationView(o, [last.seq]);
  eq('詳細は選んだ通信だけ', view.detailSeqs, [last.seq]);
  ok('スパンは選んだ通信のトレースだけ', view.spans.length === 2 && view.spans.every((s) => s.traceId === TR(250)));
  eq('要約は全件', view.summaries.length, o.exchanges.length);
  ok('要約は全件の証拠での判定と一致する', o.exchanges.every((e, i) => {
    const l = A.liveExchangeLinks(o, e);
    const x = view.summaries[i];
    return x.seq === e.seq && x.server === !!l.server && x.sql === l.sql.length;
  }));
  ok('選んでいない通信には中継の識別子・文書の識別子を返さない', view.exchanges.filter((e) => e.seq !== last.seq).every((e) => !e.relayId && !e.docToken));
  ok('選んだ通信は変換に使える（hasDetail）', LO.hasDetail(view, last.seq) && !LO.hasDetail(view, view.exchanges[0].seq));
  eq('選んだ通信の変換は、全件の観測での変換と同じ', A.fromLiveRun(view, last.seq).dataset.nodes.map((n) => n.identifier), A.fromLiveRun(o, last.seq).dataset.nodes.map((n) => n.identifier));
  eq('指紋は中身が同じなら同じ', OV.observationView(o, [last.seq]).etag, view.etag);
  ok('指紋は詳細の選び方で変わる', OV.observationView(o, [view.exchanges[0].seq]).etag !== view.etag);
  {
    const noisy = { ...o, serverOnlyRequests: o.serverOnlyRequests + 5, collectedAt: 'later',
      instrumentation: { ...o.instrumentation, spanRecords: o.instrumentation.spanRecords + 9 },
      session: { ...o.session, retention: { ...o.session.retention, retainedSpans: o.session.retention.retainedSpans + 1 } } };
    eq('指紋は、画面が描かない累計の数（生存確認で増える）では変わらない', OV.observationView(noisy, [last.seq]).etag, view.etag);
    const moved = { ...o, session: { ...o.session, retention: { ...o.session.retention, evicted: o.session.retention.evicted + 1 } } };
    ok('指紋は、画面が描く数（外した通信の数）では変わる', OV.observationView(moved, [last.seq]).etag !== view.etag);
  }
  const allBytes = JSON.stringify(OV.observationView(o, 'all')).length;
  ok(`要約の形は全件の形より小さい（${JSON.stringify(view).length} < ${allBytes} バイト）`, JSON.stringify(view).length < allBytes / 2);
  eq('取得の条件の検査: 正しい形', OV.parseViewRequest({ detail: [1, 2], pin: [1], etag: 'abc_-' }), { detail: [1, 2], pin: [1], etag: 'abc_-' });
  eq('取得の条件の検査: 省略は空', OV.parseViewRequest({}), { detail: [], pin: [], etag: null });
  eq('取得の条件の検査: 5件以上・負の数・形の違う指紋は受けない', [OV.parseViewRequest({ detail: [1, 2, 3, 4, 5] }), OV.parseViewRequest({ pin: [-1] }), OV.parseViewRequest({ etag: '../x' })], [null, null, null]);

  // スパンの上限: 1つの通信に大量のスパン → 古い通信から外す（最新と依頼中は外さない）
  const g = path.join(dir, 'big.jsonl');
  const st3 = new OB.ObservationStore();
  st3.begin('B');
  const big = (n, k) => Array.from({ length: k }, (_, i) => JSON.stringify(span(TR(n), `${n.toString(16).padStart(4, '0')}${i.toString(16).padStart(12, '0')}`, null, 'x', {}, { kind: i === 0 ? 1 : 0 }))).join('\n') + '\n';
  fs.writeFileSync(g, big(1, 25_000) + big(2, 25_000) + big(3, 25_000));
  for (const n of [1, 2, 3]) st3.record('B', rec(`/b${n}`, { traceId: TR(n), spanId: `${n.toString(16).padStart(4, '0')}${'0'.repeat(12)}` }));
  st3.pin('B', [1]);
  const oB = await st3.collect({ ...inp, runString: 'B', instrumentation: { ...inp.instrumentation, spanFile: g } });
  eq('上限を超えたら、依頼中（#1）・最新（#3）を残して古い通信（#2）を外す', oB.exchanges.map((e) => e.seq), [1, 3]);
  ok(`持つスパンは上限以下（${oB.session.retention.retainedSpans}）`, oB.session.retention.retainedSpans <= OB.SPAN_BUDGET);
  eq('上限で外した数', oB.session.retention.spanBudgetEvicted, 1);
  eq('外した理由は span-budget', st3.history('B').evicted[0].reason, 'span-budget');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ========================================================================== */
console.log('\n9. 7C-1 収集ファイルの整理（IDE の spans/ の直下・IDE の名前・書き手が死んでいるものだけ）');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-outside-'));
  const spans = path.join(root, '.ide-runtime', 'spans');
  fs.mkdirSync(spans, { recursive: true });
  const line = (run, pid) => `${JSON.stringify({ type: 'note', kind: 'registered', proc: { pid, run } })}\n`;
  const DEAD = 999_999_01;
  const LIVE = 4242;
  const files = {
    'app-1700000000001.jsonl': line('app-1700000000001', DEAD),            // 停止済み → 消す
    'app-1700000000002.jsonl': line('app-1700000000002', LIVE),            // 書き手が生きている → 残す
    'app-1700000000003.jsonl': line('app-1700000000003', DEAD),            // いまの起動として守る → 残す
    'app-1700000000004.jsonl': line('someone-else', DEAD),                 // 名乗る起動が違う → 残す
    'notes.txt': 'user file',                                             // IDE の名前ではない → 残す
    'app-1700000000006.jsonl': 'not json at all\n',                       // 記録が無い → 残す
  };
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(spans, n), c);
  fs.writeFileSync(path.join(spans, 'app-1700000000007.jsonl'), '');      // 空・古い → 消す
  fs.utimesSync(path.join(spans, 'app-1700000000007.jsonl'), new Date(Date.now() - SF.EMPTY_GRACE_MS - 5000), new Date(Date.now() - SF.EMPTY_GRACE_MS - 5000));
  fs.writeFileSync(path.join(spans, 'app-1700000000008.jsonl'), '');      // 空・新しい → 残す
  const target = path.join(outside, 'victim-1700000000009.jsonl');
  fs.writeFileSync(target, line('app-1700000000009', DEAD));
  fs.symlinkSync(target, path.join(spans, 'app-1700000000009.jsonl'));   // リンク → 辿らずに残す
  fs.mkdirSync(path.join(spans, 'app-1700000000010.jsonl'));              // ディレクトリ → 残す
  // 対象プロジェクトのソース（spans の外）: 見ない
  const src = path.join(root, 'src.ts');
  fs.writeFileSync(src, 'export {}');
  const r = SF.cleanupSpanFiles({ ideRoot: root, protect: [path.join(spans, 'app-1700000000003.jsonl')], trigger: 'test', alive: (p) => p === LIVE });
  eq('消したもの', r.removed.map((x) => x.name), ['app-1700000000001.jsonl', 'app-1700000000007.jsonl']);
  const why = Object.fromEntries(r.kept.map((k) => [k.name, k.why]));
  eq('残した理由', [why['app-1700000000002.jsonl'], why['app-1700000000003.jsonl'], why['app-1700000000004.jsonl'], why['notes.txt'], why['app-1700000000006.jsonl'], why['app-1700000000008.jsonl'], why['app-1700000000009.jsonl'], why['app-1700000000010.jsonl']],
    ['writer-alive', 'protected', 'owner-mismatch', 'not-run-file', 'no-owner-record', 'recent-empty', 'not-regular-file', 'not-regular-file']);
  ok('リンクの先（管理範囲の外）は残る', fs.existsSync(target));
  ok('spans の外（ソース）は残る', fs.existsSync(src));
  eq('失敗は無い', r.failed, []);
  // spans 自体がリンク → ディレクトリごと見送る
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-root2-'));
  fs.mkdirSync(path.join(root2, '.ide-runtime'));
  const real = path.join(outside, 'spans-real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'app-1700000000011.jsonl'), line('app-1700000000011', DEAD));
  fs.symlinkSync(real, path.join(root2, '.ide-runtime', 'spans'));
  const r2 = SF.cleanupSpanFiles({ ideRoot: root2, protect: [], trigger: 'test', alive: () => false });
  ok('spans がリンクならディレクトリごと見送る（リンクの先を消さない）', r2.skipped !== null && fs.existsSync(path.join(real, 'app-1700000000011.jsonl')), r2.skipped);
  const r3 = SF.cleanupSpanFiles({ ideRoot: path.join(root2, 'none'), protect: [], trigger: 'test' });
  ok('ディレクトリが無ければ何もしない', r3.skipped !== null && r3.removed.length === 0);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(root2, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
}

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
