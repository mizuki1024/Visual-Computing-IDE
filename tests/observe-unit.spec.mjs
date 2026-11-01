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
  eq('上限（200件）を超えた分は数だけ', [oC.exchanges.length, oC.session.overflow], [200, 5]);
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

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
