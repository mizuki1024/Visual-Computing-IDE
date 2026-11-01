/* =============================================================================
 * Phase 7B-3B-2 — 文書の同定と、値の由来（`supplies`）の評価（**DB もブラウザも使わない部分**）。
 *   npm run build:lib && node tests/lineage-live-unit.spec.mjs
 *
 *   1. 契約: 関係の表は M1 のまま（supplies = DataAccessSite → PropBindingSite / L2 / static-analysis）
 *   2. 中継（本物の PreviewGateway ＋ 代役の開発サーバー）: HTML の応答ごとに文書の識別子を作り、
 *      差し込むスクリプトに書き、記録に持つ。中継の識別子・トレース識別子はブラウザに出さない
 *   3. プレビューの知らせの形（select に doc / soft）
 *   4. 文書の同定（bindDocument）: 再読み込み・同じパスの並行・停止と再起動・クライアント側の遷移・
 *      失敗した応答・同じパスの再取得
 *   5. 由来の評価（evaluateLineage）: **静的解析は本物**（PoC-04 の lineage.mjs を poc/fixture-app の
 *      ソースにかける）。実測の側（通信・スパン・呼び出し位置）は試験のために組んだ**模擬**
 *      — /lin-a の成立と、否定例（同じ SQL の2か所・並行・定数・条件分岐・関数・同名・SELECT 句に無い列・
 *      未実行・別の起動/文書・候補が複数・ソースの書き換え・PID 欠損）
 *   6. 変換（fromLiveRun）: supplies の端点・向き・観測性・validateDataset、成立しないときは線を作らず理由を出す
 *
 * 実物の next dev・PostgreSQL・ブラウザでの確認は tests/lineage-e2e.spec.mjs。
 * ========================================================================== */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const M = require_('../.libjs/lib/model.js');
const A = require_('../.libjs/lib/adapter.js');
const LO = require_('../.libjs/lib/liveObservation.js');
const LL = require_('../.libjs/lib/liveLineage.js');
const PP = require_('../.libjs/lib/previewProtocol.js');
const OB = require_('../.libjs/server/observations.js');
const GW = require_('../.libjs/server/previewGateway.js');
const AC = require_('../.libjs/server/access.js');
const LN = require_('../.libjs/server/lineage.js');
const REPO = path.resolve(import.meta.dirname, '..');
const FIX = path.join(REPO, 'poc', 'fixture-app');
const SQLP = await import(path.join(REPO, 'poc', 'runner', 'lib', 'sqlparse.mjs'));

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
const DOC = (n) => n.toString(16).padStart(32, 'd');

/* ========================================================================== */
console.log('\n1. 契約: 関係の表は M1 のまま（新しい関係種別を作っていない）');
eq('関係種別は12件のまま', Object.keys(M.RELATION_SPEC).length, 12);
eq('supplies: DataAccessSite → PropBindingSite', [M.RELATION_SPEC.supplies.from, M.RELATION_SPEC.supplies.to], ['DataAccessSite', ['PropBindingSite']]);
eq('supplies: L2・static-analysis だけ・上限は推定', [M.RELATION_SPEC.supplies.defaultLevel, M.RELATION_SPEC.supplies.sources, M.RELATION_SPEC.supplies.ceiling], ['L2', ['static-analysis'], 'estimated']);
eq('static-analysis は推定', M.observabilityOf('static-analysis'), 'estimated');
ok('文書の同定は関係種別にしていない（表に document / delivers 等が無い）', !Object.keys(M.RELATION_SPEC).some((k) => /doc|deliver/i.test(k)));

/* ========================================================================== */
console.log('\n2. 中継: HTML の応答ごとに文書の識別子を作り、差し込むスクリプトに書く');
{
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-vcide-trace': `00-${TR(7)}-${SP(7)}-01` });
      res.end('<!doctype html><html><head><title>t</title></head><body>x</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const store = new OB.ObservationStore();
  store.begin('RUN');
  const gw = new GW.PreviewGateway({
    config: AC.accessConfig({}), port: await freePort(),
    target: () => ({ target: { port: upstream.address().port, run: 'RUN' }, reason: '' }),
    observer: store,
  });
  const info = await gw.ensure();
  const get = (p, headers = {}) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: info.port, path: p, headers: { host: `127.0.0.1:${info.port}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    }).on('error', (e) => resolve({ error: e.code }));
  });
  const [p1, p2] = await Promise.all([get('/page'), get('/page')]);
  const api = await get('/api/x');
  await sleep(50);
  const tok = (b) => /data-vcide-doc="([0-9a-f]{32})"/.exec(b)?.[1] ?? null;
  ok('HTML の応答に文書の識別子（16 進 32 桁）を差し込む', !!tok(p1.body) && !!tok(p2.body));
  ok('同じパスの並行する2つの応答で、識別子が別', tok(p1.body) !== tok(p2.body));
  const st = await store.collect({ run: { instance: 'i', pid: 1, startedAt: 's' }, runString: 'RUN', project: 'p', port: 1, instrumentation: { state: 'disabled', reason: null, spanFile: null }, traceHeader: false });
  const pages = st.exchanges.filter((e) => e.path === '/page');
  eq('記録の文書の識別子が、差し込んだ値と一致する（2件とも）', pages.map((e) => e.docToken).sort(), [tok(p1.body), tok(p2.body)].sort());
  ok('文書の識別子は中継の識別子（relayId）と別の値', pages.every((e) => e.docToken !== e.relayId));
  eq('HTML でない応答には文書の識別子を作らない', st.exchanges.find((e) => e.path === '/api/x')?.docToken, undefined);
  ok('ブラウザへの HTML に中継の識別子（relayId）が無い', pages.every((e) => !p1.body.includes(e.relayId) && !p2.body.includes(e.relayId)));
  ok('ブラウザへの HTML・ヘッダにトレース識別子が無い', !p1.body.includes(TR(7)) && p1.headers['x-vcide-trace'] === undefined);
  ok('API の応答にも中継の識別子を返さない', api.headers['x-vcide-relay'] === undefined);
  const agent = GW.agentJs(AC.accessConfig({}));
  ok('スクリプトは文書の識別子を、アプリのスクリプトより前（自分の読み込み時）に読む', /var doc = s && s\.getAttribute\('data-vcide-doc'\)/.test(agent));
  ok('スクリプトは選択の知らせに doc と soft を載せる', /kind: 'select', seq: seq, selection: d, doc: doc, soft: soft/.test(agent));
  ok('スクリプトは送信の関数を先に取っておく（後からの書き換えに影響されにくくする。保証ではない）', /pm\.call\(port, m\)/.test(agent));
  ok('pushState / popstate で soft にする（クライアント側の遷移）', /pushState = function\(\)\{[^}]*soft = true/.test(agent) && /popstate', function\(\)\{ soft = true/.test(agent));
  // 別の起動の記録は受けない（再起動）
  store.begin('RUN2');
  const st2 = await store.collect({ run: { instance: 'i', pid: 2, startedAt: 's2' }, runString: 'RUN2', project: 'p', port: 1, instrumentation: { state: 'disabled', reason: null, spanFile: null }, traceHeader: false });
  eq('再起動の後のセッションに、前の起動の文書の識別子は無い', st2.exchanges.length, 0);
  // 形の違う識別子・relayId と同じ値は記録しない
  store.record('RUN2', { method: 'GET', path: '/q', hasQuery: false, kind: 'document', status: 200, startMs: 1, durationMs: 1, trace: null, failure: null }, { relayId: RID(1), docToken: RID(1) });
  store.record('RUN2', { method: 'GET', path: '/q', hasQuery: false, kind: 'document', status: 200, startMs: 1, durationMs: 1, trace: null, failure: null }, { relayId: RID(2), docToken: 'xyz' });
  const st3 = await store.collect({ run: { instance: 'i', pid: 2, startedAt: 's2' }, runString: 'RUN2', project: 'p', port: 1, instrumentation: { state: 'disabled', reason: null, spanFile: null }, traceHeader: false });
  eq('relayId と同じ値・形の違う値は文書の識別子として持たない', st3.exchanges.map((e) => e.docToken ?? null), [null, null]);
  await gw.close();
  upstream.close();
}

/* ========================================================================== */
console.log('\n3. プレビューの知らせ: select に doc / soft');
{
  const nonce = 'n'.repeat(20);
  const sel = { tag: 'li', anchorOnSelf: 'abcdef0123', anchorOrdinal: 0, anchorInstanceCount: 1, ancestorAnchors: [], textNodeIndex: 0, valueShape: { chars: 2, cls: 'cjk' }, formControl: false, path: '/lin-a' };
  const base = { source: 'vcide-preview', v: 2, nonce, kind: 'select', seq: 1, selection: sel };
  eq('doc と soft を受け取る', PP.parseAgentMessage({ ...base, doc: DOC(1), soft: false }, nonce)?.document, { token: DOC(1), soft: false });
  eq('doc が無い（古いスクリプト）→ token null', PP.parseAgentMessage(base, nonce)?.document, { token: null, soft: null });
  eq('doc の形が違えば捨てる', PP.parseAgentMessage({ ...base, doc: 'zz', soft: false }, nonce), null);
  eq('soft が真偽でなければ捨てる', PP.parseAgentMessage({ ...base, doc: DOC(1), soft: 'no' }, nonce), null);
}

/* ========================================================================== */
/* 模擬の観測。通信ごとに 受付スパン → 描画スパン → SQL スパン、SQL ごとに呼び出し位置の照合結果 */
function makeObs({ exchanges, sql }) {
  const spans = [];
  const sqlAnalyses = [];
  const dataAccess = [];
  for (const e of exchanges) {
    spans.push({ traceId: TR(e.seq), spanId: SP(e.seq * 100), parentSpanId: null, name: 'GET', kind: 1, startMs: e.startMs ?? 1000 * e.seq, endMs: (e.startMs ?? 1000 * e.seq) + 50, durationMs: 50, statusCode: 0, scope: '@opentelemetry/instrumentation-http', attrs: { 'http.target': e.path, 'vcide.relay.id': RID(e.seq) }, droppedAttributeKeys: [] });
    spans.push({ traceId: TR(e.seq), spanId: SP(e.seq * 100 + 1), parentSpanId: SP(e.seq * 100), name: `render route (app) ${e.path}`, kind: 0, startMs: 1000 * e.seq + 1, endMs: 1000 * e.seq + 40, durationMs: 39, statusCode: 0, scope: 'next.js', attrs: { 'next.span_type': 'AppRender.getBodyResult', 'next.route': e.path }, droppedAttributeKeys: [] });
  }
  sql.forEach((q, i) => {
    const spanId = SP(q.ex * 100 + 10 + i);
    spans.push({ traceId: TR(q.ex), spanId, parentSpanId: SP(q.ex * 100 + 1), name: 'pg.query:SELECT', kind: 2, startMs: 1000 * q.ex + 5 + i, endMs: 1000 * q.ex + 6 + i, durationMs: 1, statusCode: 0, scope: '@opentelemetry/instrumentation-pg', attrs: { 'db.statement': q.text }, droppedAttributeKeys: [] });
    sqlAnalyses.push(SQLP.sqlAnalysisRecord({ spanId, sql: q.text }));
    dataAccess.push({
      spanId, traceId: TR(q.ex), at: 'pg-pool.Pool.query',
      site: q.site ? { ...q.site, functionName: q.site.component, sourceLine: 'pool.query(…)', component: { name: q.site.component, file: q.site.file, line: 1, endLine: 99 } } : null,
      located: q.located ?? (q.site ? { file: q.site.file, line: q.site.line, col: q.site.col } : null),
      failure: q.site ? null : { reason: q.failure ?? 'no-callsite-record', detail: '' },
      checks: q.site ? ['…'] : [],
    });
  });
  return {
    run: { instance: 'i', pid: 1, startedAt: 's' }, project: 'fixture', port: 3000,
    session: { startedAt: 'S', recorded: exchanges.length, overflow: 0, excludedStatic: 0, readRequestHeaders: ['sec-fetch-dest', 'rsc'], readResponseHeaders: ['x-vcide-trace'], writtenRequestHeaders: ['x-vcide-relay'] },
    instrumentation: { state: 'enabled', reason: null, traceHeader: true, spanRecords: spans.length, truncated: false },
    exchanges: exchanges.map((e) => ({
      seq: e.seq, method: 'GET', path: e.path, hasQuery: false, kind: e.kind ?? 'document', status: e.status ?? 200,
      startMs: e.startMs ?? 1000 * e.seq, durationMs: 50, trace: { traceId: TR(e.seq), spanId: SP(e.seq * 100) },
      failure: e.failure ?? null, relayId: RID(e.seq), ...(e.doc ? { docToken: e.doc } : {}),
    })),
    spans, sqlAnalyses, parser: { available: true, reason: null }, serverOnlyRequests: 0, collectedAt: 'C',
    dataAccess, callsite: { enabled: true, records: sql.length, resolver: { available: true, reason: null } },
  };
}

/* ========================================================================== */
console.log('\n4. 文書の同定（bindDocument）');
{
  const obs = makeObs({ exchanges: [
    { seq: 1, path: '/lin-a', doc: DOC(1) },
    { seq: 2, path: '/lin-a', doc: DOC(2) },                 // 再読み込み・同じパスの並行
    { seq: 3, path: '/lin-b', doc: DOC(3) },
    { seq: 4, path: '/lin-c', doc: DOC(4), status: 500 },
    { seq: 5, path: '/lin-e', doc: DOC(5) },
    { seq: 6, path: '/lin-e', kind: 'rsc' },                 // 文書の後の同じパスの再取得
  ], sql: [] });
  const b = (token, soft, p) => LO.bindDocument(obs, { token, soft }, p);
  eq('識別子が一致する通信に同定する（#1）', b(DOC(1), false, '/lin-a'), { status: 'identified', seq: 1, checks: b(DOC(1), false, '/lin-a').checks });
  eq('同じパスの別の文書（再読み込み・並行）を取り違えない（#2）', b(DOC(2), false, '/lin-a').seq, 2);
  eq('識別子の知らせが無い → no-document-token', b(null, false, '/lin-a').reason, 'no-document-token');
  eq('知らせ自体が無い → no-document-token', LO.bindDocument(obs, null, '/lin-a').reason, 'no-document-token');
  eq('クライアント側の遷移の後 → client-navigation（文書の取得と同一視しない）', b(DOC(1), true, '/lin-a').reason, 'client-navigation');
  eq('遷移の有無が不明 → client-navigation（同一視しない）', b(DOC(1), null, '/lin-a').reason, 'client-navigation');
  eq('いまの観測に無い識別子（別の起動・停止の前）→ token-not-in-session', b(DOC(99), false, '/lin-a').reason, 'token-not-in-session');
  eq('識別子の通信とパスが違う → path-mismatch', b(DOC(3), false, '/lin-a').reason, 'path-mismatch');
  eq('失敗した応答 → document-failed', b(DOC(4), false, '/lin-c').reason, 'document-failed');
  eq('文書の後に同じパスの RSC の再取得 → refetched-after-document', b(DOC(5), false, '/lin-e').reason, 'refetched-after-document');
  const dup = makeObs({ exchanges: [{ seq: 1, path: '/x', doc: DOC(1) }, { seq: 2, path: '/x', doc: DOC(1) }], sql: [] });
  eq('同じ識別子の通信が2件 → token-duplicated', LO.bindDocument(dup, { token: DOC(1), soft: false }, '/x').reason, 'token-duplicated');
  const restarted = makeObs({ exchanges: [{ seq: 1, path: '/lin-a', doc: DOC(50) }], sql: [] });
  eq('再起動後の観測（同じ番号 #1 でも別の文書）に、前の起動の識別子を当てない', LO.bindDocument(restarted, { token: DOC(1), soft: false }, '/lin-a').reason, 'token-not-in-session');
}

/* ========================================================================== */
console.log('\n5. 由来の評価（静的解析は本物 — PoC-04 の lineage.mjs を poc/fixture-app にかける）');
const PL = await LN.analyzeProject(FIX);
ok('静的解析器を使える（lineage.mjs）', !!PL.analysis && !PL.error, PL.error);
const siteOf = (file, field) => {
  /* 正解はこの試験がソースを読んで決める: data-poc-field="<field>" の要素の位置 */
  const src = fs.readFileSync(path.join(FIX, file), 'utf8').split('\n');
  const i = src.findIndex((l) => l.includes(`data-poc-field="${field}"`));
  const col = src[i].indexOf('<') + 1;
  return { file, line: i + 1, col, tag: /<([a-z]+)/.exec(src[i].slice(col - 1))[1] };
};
const callOf = (file, needle, nth = 0) => {
  const src = fs.readFileSync(path.join(FIX, file), 'utf8').split('\n');
  const hits = src.map((l, i) => [l, i]).filter(([l]) => l.includes(needle));
  const [l, i] = hits[nth];
  return { file, line: i + 1, col: l.indexOf('.query(') + 2 };
};
const evalWith = (obs, anchorAt, component, doc, opt = {}) => {
  const binding = LO.bindDocument(obs, doc, opt.path ?? obs.exchanges[0].path);
  return LL.evaluateLineage({
    obs, binding, anchor: anchorAt ? { ...anchorAt, component } : null,
    analysis: opt.analysis ?? PL.analysis, resolveLineage: PL.resolveLineage, reasonText: PL.reasonText,
    changedAfter: opt.changedAfter ?? (() => []),
  });
};
const sel = (p) => ({
  project: 'fixture', port: 3000, page: { path: p, title: '' },
  selection: { tag: 'li', anchorOnSelf: 'abcdef0123', anchorOrdinal: 0, anchorInstanceCount: 1, ancestorAnchors: [], textNodeIndex: 0, valueShape: { chars: 2, cls: 'cjk' }, formControl: false, path: p },
  resolution: null, selectedAt: 'T',
});
const selFor = (p, a, component) => ({
  ...sel(p),
  selection: { ...sel(p).selection, tag: a.tag },
  resolution: { status: 'resolved', anchor: { id: 'abcdef0123', tag: a.tag, file: a.file, line: a.line, col: a.col, component, componentLine: 1, sourceLine: '…' }, ancestors: [], chain: [component], directive: 'none', checks: ['…'] },
});
const draw = (obs, l, p, a, component) => A.fromLiveRun(obs, l.binding.status === 'identified' ? l.binding.seq : 1, { selection: selFor(p, a, component), binding: l.binding, lineage: l }).dataset;

/* ---------------------------------------------- 5.1 /lin-a 成立（最初の対象） */
const LINA = 'src/app/lin-a/page.tsx';
const aLinA = siteOf(LINA, 'a-region');
const cLinA = callOf(LINA, 'pool.query(');
{
  eq('前提: ソースから読んだ要素の位置（/lin-a の <li>）', [aLinA.line, aLinA.col, aLinA.tag], [18, 11, 'li']);
  eq('前提: ソースから読んだ取得の呼び出し位置（メソッド名の列）', [cLinA.line, cLinA.col], [12, 24]);
  const obs = makeObs({ exchanges: [{ seq: 1, path: '/lin-a', doc: DOC(1) }], sql: [
    { ex: 1, text: 'SELECT id, region FROM poc.listings ORDER BY id LIMIT $0', site: { ...cLinA, component: 'LinA' } },
  ] });
  const l = evalWith(obs, aLinA, 'LinA', { token: DOC(1), soft: false });
  eq('/lin-a: 結ぶ（linked）', [l.status, l.cut], ['linked', null]);
  eq('/lin-a: 1列に確定（poc.listings.region）', [l.outcome, l.candidates.map((c) => `${c.schema}.${c.table}.${c.column}`)], ['confirmed', ['poc.listings.region']]);
  eq('/lin-a: 値を描く式の位置（PropBindingSite・列まで）', [l.site.file, l.site.line, l.site.col, l.site.expr], [LINA, 18, 54, 'row.region']);
  eq('/lin-a: 実測した呼び出し位置（DataAccessSite・列まで）', [l.fetch.file, l.fetch.line, l.fetch.col, l.fetch.component], [LINA, 12, 24, 'LinA']);
  eq('/lin-a: 結びついた SQL は文書の通信の中の1本', l.sqlSpanIds.length, 1);
  ok('/lin-a: 通った条件に、文書・描画位置・参照の連鎖・実測の位置・SELECT 句が並ぶ', l.checks.length === 6, l.checks);
  ok('/lin-a: 結論は値を持たない（行データ・表示値の項目が無い）', !/"value"|"rows"|"text":"[^"]*大阪/.test(JSON.stringify(l)));

  const ds = draw(obs, l, '/lin-a', aLinA, 'LinA');
  const sup = ds.hops.filter((h) => h.relation === 'supplies');
  eq('変換: supplies が1本', sup.length, 1);
  const h = sup[0];
  eq('変換: 向きは against-data（データは取得位置 → 描画位置。探索は逆向き）', h.orientation, 'against-data');
  eq('変換: 端点 from = PropBindingSite（式の位置・列まで）', h.endpoints.from, { type: 'PropBindingSite', file: LINA, line: 18, col: 54, inComponent: 'LinA' });
  eq('変換: 端点 to = DataAccessSite（実測の位置・列まで）', h.endpoints.to, { type: 'DataAccessSite', file: LINA, line: 12, col: 24, inComponent: 'LinA' });
  eq('変換: 取得手段 static-analysis・観測性は推定（L2。実測と照合しても昇格しない）', [h.source, h.observability], ['static-analysis', 'estimated']);
  eq('変換: 1列に確定 → resolved・候補1件', [h.linkStatus, h.candidates?.map((c) => c.identifier)], ['resolved', ['poc.listings.region']]);
  const fromN = ds.nodes.find((n) => n.id === h.from);
  const toN = ds.nodes.find((n) => n.id === h.to);
  eq('変換: 始点は値を描いたコンポーネントのノード、終点は SQL を実行した位置のノード（別のノード）', [fromN.kind, toN.kind, fromN.id !== toN.id], ['component', 'component', true]);
  ok('変換: 終点のノードから queries が出ている（同じ呼び出し位置）', ds.hops.some((x) => x.relation === 'queries' && x.from === h.to));
  ok('変換: カラム poc.listings.region のノードがある', ds.nodes.some((n) => n.kind === 'column' && n.identifier === 'poc.listings.region'));
  eq('変換: validateDataset() を通過する', M.validateDataset(ds), []);
  ok('変換: 値のコンポーネントに「由来は未確認」の切断を付けない', !ds.cuts.some((c) => c.from === h.from));
  ok('変換: 値のノードに文書の同定（通信 #1）と「値と SQL 結果の対応ではない」を書く', ds.nodes.find((n) => n.kind === 'value').overview.some((r) => r.v.includes('通信 #1') && r.v.includes('表示された値と SQL の結果の対応ではありません')));
  // 否定: 同じ評価を別の通信の描画に使わない
  const obs2 = makeObs({ exchanges: [{ seq: 1, path: '/lin-a', doc: DOC(1) }, { seq: 2, path: '/lin-a', doc: DOC(2) }], sql: [
    { ex: 1, text: 'SELECT id, region FROM poc.listings ORDER BY id LIMIT $0', site: { ...cLinA, component: 'LinA' } },
    { ex: 2, text: 'SELECT id, region FROM poc.listings ORDER BY id LIMIT $0', site: { ...cLinA, component: 'LinA' } },
  ] });
  const l1 = evalWith(obs2, aLinA, 'LinA', { token: DOC(1), soft: false });
  const other = A.fromLiveRun(obs2, 2, { selection: selFor('/lin-a', aLinA, 'LinA'), binding: l1.binding, lineage: l1 }).dataset;
  eq('同じパスの別の文書（#2）の描画には supplies を作らない', other.hops.filter((x) => x.relation === 'supplies').length, 0);
  ok('別の文書の描画には評価そのものを使わない（「描けなかった」ではなく「別の文書」として扱う）',
    !other.cuts.some((c) => c.sub.includes('描けなかった')) && other.cuts.some((c) => c.sub.includes('別の通信')), other.cuts.map((c) => c.sub));
  ok('別の文書の描画では「この要素を描いた文書は通信 #1」と書く', other.nodes.find((n) => n.kind === 'value').overview.some((r) => r.v.includes('通信 #1 の応答です。いま表示している通信 #2 ではありません')));
  eq('並行: #1 の文書の評価は #1 の SQL だけを使う', l1.sqlSpanIds, [obs2.spans.find((s) => s.traceId === TR(1) && s.kind === 2).spanId]);
  const l2 = evalWith(obs2, aLinA, 'LinA', { token: DOC(2), soft: false });
  eq('並行: #2 の文書の評価は #2 の SQL だけを使う', l2.sqlSpanIds, [obs2.spans.find((s) => s.traceId === TR(2) && s.kind === 2).spanId]);
}

/* ---------------------------------------------- 5.2 否定例 */
const cutCase = (name, l, reason, stage) => {
  eq(`${name} → 結ばない（${reason}）`, [l.status, l.cut?.reason, l.cut?.stage], ['cut', reason, stage]);
};
const linAObs = (sqlText = 'SELECT id, region FROM poc.listings ORDER BY id LIMIT $0', extra = {}) => makeObs({
  exchanges: [{ seq: 1, path: '/lin-a', doc: DOC(1) }],
  sql: [{ ex: 1, text: sqlText, site: { ...cLinA, component: 'LinA' }, ...extra }],
});
{
  /* 同じ SQL を複数箇所で実行（/rsc-dup）: 文は同じでも、位置で結ぶので取り違えない */
  const P = 'src/app/rsc-dup/page.tsx';
  const C = 'src/components/ListingCount.tsx';
  const obs = makeObs({ exchanges: [{ seq: 1, path: '/rsc-dup', doc: DOC(1) }], sql: [
    { ex: 1, text: 'SELECT count(*) AS n FROM poc.listings', site: { ...callOf(P, 'pool.query('), component: 'RscDup' } },
    { ex: 1, text: 'SELECT count(*) AS n FROM poc.listings', site: { ...callOf(C, 'pool.query('), component: 'ListingCount' } },
  ] });
  const lc = evalWith(obs, siteOf(C, 'child'), 'ListingCount', { token: DOC(1), soft: false });
  eq('同じ SQL 文の2か所: 子の <span> は子の呼び出し位置（ListingCount.tsx:6:24）に結ぶ', [lc.status, lc.fetch && `${lc.fetch.file}:${lc.fetch.line}:${lc.fetch.col}`], ['linked', `${C}:6:24`]);
  const lp = evalWith(obs, siteOf(P, 'page'), 'RscDup', { token: DOC(1), soft: false });
  eq('同じ SQL 文の2か所: ページの <p> はページの呼び出し位置（page.tsx:13:24）に結ぶ', [lp.status, lp.fetch && `${lp.fetch.file}:${lp.fetch.line}`], ['linked', `${P}:13`]);
  eq('count(*) AS n は1列に帰属しない → テーブルまで（列は主張しない）', [lc.outcome, lc.candidates.length, lc.tableCandidates.map((t) => `${t.schema}.${t.name}`)], ['table-only', 0, ['poc.listings']]);
  const ds = draw(obs, lc, '/rsc-dup', siteOf(C, 'child'), 'ListingCount');
  eq('テーブルまで: supplies は untraceable（列の候補なし）で、切断「由来の列は特定していません」', [ds.hops.find((h) => h.relation === 'supplies')?.linkStatus, ds.cuts.some((c) => c.head === '由来の列は特定していません')], ['untraceable', true]);
  eq('テーブルまで: validateDataset() を通過する', M.validateDataset(ds), []);
}
{
  /* 値が定数由来・条件分岐・関数の内部が不明・同名の変数・候補が複数（PoC-04 のケースをそのまま使う） */
  const E = 'src/app/lin-e/page.tsx'; const G = 'src/app/lin-g/page.tsx'; const X = 'src/app/lin-x/page.tsx'; const D = 'src/app/lin-d/page.tsx';
  const one = (file, p, comp, text, field, nth = 0) => {
    const obs = makeObs({ exchanges: [{ seq: 1, path: p, doc: DOC(1) }], sql: [{ ex: 1, text, site: { ...callOf(file, 'pool.query(', nth), component: comp } }] });
    return { obs, l: evalWith(obs, siteOf(file, field), comp, { token: DOC(1), soft: false }) };
  };
  const ESQL = 'SELECT id, code, region, plan FROM poc.listings ORDER BY id LIMIT $0';
  cutCase('定数（g-shadow: 列名と同じ名前の局所変数）', one(G, '/lin-g', 'LinG', 'SELECT code, region FROM poc.listings ORDER BY id LIMIT $0', 'g-shadow').l, 'no-reference', 'static');
  cutCase('定数（g-env: 環境変数）', one(G, '/lin-g', 'LinG', 'SELECT code, region FROM poc.listings ORDER BY id LIMIT $0', 'g-env').l, 'no-reference', 'static');
  cutCase('定数（g-computed: 計算した定数）', one(G, '/lin-g', 'LinG', 'SELECT code, region FROM poc.listings ORDER BY id LIMIT $0', 'g-computed').l, 'no-reference', 'static');
  cutCase('定数（g-literal: 式の無い固定の文字）', one(G, '/lin-g', 'LinG', 'SELECT code, region FROM poc.listings ORDER BY id LIMIT $0', 'g-literal').l, 'no-value-site', 'static');
  cutCase('条件分岐（e-inline: 条件の判定に使った列は由来ではない — R2）', one(E, '/lin-e', 'LinE', ESQL, 'e-inline').l, 'no-reference', 'static');
  const either = one(E, '/lin-e', 'LinE', ESQL, 'e-either').l;
  eq('条件分岐（e-either）: 候補2件のまま（1つに決めない）', [either.status, either.outcome, either.candidates.map((c) => c.column).sort()], ['linked', 'candidates', ['code', 'region']]);
  const orc = one(E, '/lin-e', 'LinE', ESQL, 'e-orconst').l;
  eq('条件分岐（e-orconst）: 固定値の経路があり確定にしない（R3）', [orc.outcome, orc.literalPaths], ['candidates', 1]);
  const xo = one(X, '/lin-x', 'LinX', 'SELECT id, code FROM poc.listings ORDER BY id LIMIT 2', 'x-outside').l;
  cutCase('関数の内部が不明（x-outside: 白表に無い関数 — R4）', xo, 'no-reference', 'static');
  ok('関数の内部が不明: 理由に call-not-whitelisted を残す', /call-not-whitelisted/.test(xo.cut.detail), xo.cut.detail);
  const dObs = makeObs({ exchanges: [{ seq: 1, path: '/lin-d', doc: DOC(1) }], sql: [
    { ex: 1, text: 'SELECT code, region, plan, scale FROM poc.listings ORDER BY id LIMIT $0', site: { ...callOf(D, 'pool.query(', 0), component: 'LinD' } },
    { ex: 1, text: 'SELECT code FROM poc.listings ORDER BY id LIMIT $0', site: { ...callOf(D, 'pool.query(', 1), component: 'LinD' } },
    { ex: 1, text: 'SELECT name FROM poc.regions ORDER BY id LIMIT $0', site: { ...callOf(D, 'pool.query(', 2), component: 'LinD' } },
  ] });
  const sa = evalWith(dObs, siteOf(D, 'd-same-name-a'), 'LinD', { token: DOC(1), soft: false });
  const sb = evalWith(dObs, siteOf(D, 'd-same-name-b'), 'LinD', { token: DOC(1), soft: false });
  eq('同名の変数 row（a / b）を取り違えない', [sa.candidates.map((c) => `${c.table}.${c.column}`), sb.candidates.map((c) => `${c.table}.${c.column}`)], [['listings.code'], ['regions.name']]);
  ok('同名の変数: 別々の呼び出し位置に結ぶ', sa.fetch.line !== sb.fetch.line);
  const dyn = evalWith(dObs, siteOf(D, 'd-dynamic'), 'LinD', { token: DOC(1), soft: false });
  eq('候補が複数（d-dynamic: 動的なキー）: その SQL の全列が候補・1つに決めない', [dyn.status, dyn.outcome, dyn.candidates.length], ['linked', 'candidates', 4]);
  const dds = draw(dObs, dyn, '/lin-d', siteOf(D, 'd-dynamic'), 'LinD');
  const dh = dds.hops.find((h) => h.relation === 'supplies');
  eq('候補が複数: supplies は multiple-candidates で候補を4件持つ', [dh?.linkStatus, dh?.candidates?.length], ['multiple-candidates', 4]);
  eq('候補が複数: validateDataset() を通過する', M.validateDataset(dds), []);
}
{
  /* SELECT 句に存在しない列（R6）: 実測の SQL が region を取っていない */
  cutCase('SELECT 句に無い列（実測の SQL が region を取っていない）', evalWith(linAObs('SELECT id FROM poc.listings ORDER BY id LIMIT $0'), aLinA, 'LinA', { token: DOC(1), soft: false }), 'no-column', 'select-list');
  /* 未実行の SQL（R5）: この文書の通信の中で、その位置の SQL を観測していない */
  const none = makeObs({ exchanges: [{ seq: 1, path: '/lin-a', doc: DOC(1) }], sql: [] });
  cutCase('未実行の SQL（この文書の通信でその位置の SQL を観測していない）', evalWith(none, aLinA, 'LinA', { token: DOC(1), soft: false }), 'fetch-not-measured', 'measured');
  /* 別の位置で実行された SQL だけがある（列がずれた位置） */
  const shifted = makeObs({ exchanges: [{ seq: 1, path: '/lin-a', doc: DOC(1) }], sql: [{ ex: 1, text: 'SELECT id, region FROM poc.listings', site: { ...cLinA, col: 19, component: 'LinA' } }] });
  cutCase('静的解析の呼び出し位置と実測の位置が列で違う', evalWith(shifted, aLinA, 'LinA', { token: DOC(1), soft: false }), 'fetch-not-measured', 'measured');
  /* 実行位置を server-call-stack で確かめられない（PID 欠損など）: 戻した位置はあっても site が無い */
  const pid = linAObs(undefined, { site: null, located: { ...cLinA }, failure: 'callsite-pid-missing' });
  const lp = evalWith(pid, aLinA, 'LinA', { token: DOC(1), soft: false });
  cutCase('実行位置を確かめられない（呼び出し位置の照合が PID 欠損で不成立）', lp, 'fetch-site-unverified', 'measured');
  ok('PID 欠損の理由を残す', lp.cut.detail.includes('callsite-pid-missing'), lp.cut.detail);
  /* 同じ位置から SELECT 句の違う SQL が2本 */
  const two = makeObs({ exchanges: [{ seq: 1, path: '/lin-a', doc: DOC(1) }], sql: [
    { ex: 1, text: 'SELECT id, region FROM poc.listings', site: { ...cLinA, component: 'LinA' } },
    { ex: 1, text: 'SELECT id, code AS region FROM poc.listings', site: { ...cLinA, component: 'LinA' } },
  ] });
  cutCase('同じ位置から SELECT 句の構成が違う SQL が2本', evalWith(two, aLinA, 'LinA', { token: DOC(1), soft: false }), 'select-list-differs', 'measured');
  /* 異なる起動・異なる文書 */
  cutCase('異なる起動（いまの観測に無い文書の識別子）', evalWith(linAObs(), aLinA, 'LinA', { token: DOC(77), soft: false }), 'document-unidentified', 'document');
  cutCase('クライアント側の遷移の後の選択', evalWith(linAObs(), aLinA, 'LinA', { token: DOC(1), soft: true }), 'document-unidentified', 'document');
  cutCase('文書の識別子の知らせが無い', evalWith(linAObs(), aLinA, 'LinA', { token: null, soft: false }), 'document-unidentified', 'document');
  cutCase('異なるパスの文書（識別子は /lin-a、選択は /lin-b）', evalWith(linAObs(), aLinA, 'LinA', { token: DOC(1), soft: false }, { path: '/lin-b' }), 'document-unidentified', 'document');
  /* ソースが文書の取得の後に書き換わった */
  cutCase('文書の取得の後にソースが書き換わった', evalWith(linAObs(), aLinA, 'LinA', { token: DOC(1), soft: false }, { changedAfter: () => [LINA] }), 'source-changed-after-run', 'static');
  /* 要素の位置が静的解析の要素と合わない（祖先の <ul> を選んだ） */
  cutCase('値を直下に持たない要素（<ul>）', evalWith(linAObs(), { file: LINA, line: 16, col: 7, tag: 'ul' }, 'LinA', { token: DOC(1), soft: false }), 'no-value-site', 'static');
  cutCase('囲むコンポーネントが要素識別子の照合と違う', evalWith(linAObs(), aLinA, 'Other', { token: DOC(1), soft: false }), 'no-value-site', 'static');
  cutCase('要素の位置が無い（7B-2 で特定できなかった）', evalWith(linAObs(), null, 'LinA', { token: DOC(1), soft: false }), 'selection-unresolved', 'static');
  /* 静的解析器を使えない */
  const noAn = LL.evaluateLineage({ obs: linAObs(), binding: LO.bindDocument(linAObs(), { token: DOC(1), soft: false }, '/lin-a'), anchor: { ...aLinA, component: 'LinA' }, analysis: null, analyzerError: 'x', resolveLineage: null, changedAfter: () => [] });
  cutCase('静的解析器を使えない', noAn, 'analyzer-unavailable', 'static');
  /* 構造の否定（試験のために組んだ解析結果）: 固定の文字との混在・式が2つ・取得が2つ */
  const fake = (patch) => ({ ...PL.analysis, sites: PL.analysis.sites.map((s) => (s.element && s.element.line === 18 && s.file === LINA ? { ...s, ...patch(s) } : s)) });
  cutCase('固定の文字と式が混在する要素', evalWith(linAObs(), aLinA, 'LinA', { token: DOC(1), soft: false }, { analysis: fake((s) => ({ element: { ...s.element, textChildren: 1 } })) }), 'mixed-text-children', 'static');
  cutCase('式が2つある要素', evalWith(linAObs(), aLinA, 'LinA', { token: DOC(1), soft: false }, { analysis: fake((s) => ({ element: { ...s.element, exprChildren: 2 } })) }), 'multiple-value-sites', 'static');
  const q2 = PL.analysis.queries.find((q) => q.file !== LINA).id;
  cutCase('値が2つの取得の結果を参照しうる', evalWith(linAObs(), aLinA, 'LinA', { token: DOC(1), soft: false }, { analysis: fake((s) => ({ refs: [...s.refs, { ...s.refs[0], queryId: q2 }] })) }), 'multiple-fetch-sites', 'static');
}

/* ========================================================================== */
console.log('\n6. 変換: 成立しない経路では線を作らず、理由を出す');
{
  const cases = [
    ['文書を同定できない', linAObs(), { token: DOC(77), soft: false }, '文書の同定'],
    ['SELECT 句に無い列', linAObs('SELECT id FROM poc.listings'), { token: DOC(1), soft: false }, '実行SQLの SELECT 句'],
    ['未実行の SQL', makeObs({ exchanges: [{ seq: 1, path: '/lin-a', doc: DOC(1) }], sql: [] }), { token: DOC(1), soft: false }, '実測との照合'],
  ];
  for (const [name, obs, doc, stage] of cases) {
    const l = evalWith(obs, aLinA, 'LinA', doc);
    const ds = A.fromLiveRun(obs, 1, { selection: selFor('/lin-a', aLinA, 'LinA'), binding: l.binding, lineage: l }).dataset;
    eq(`${name}: supplies を作らない`, ds.hops.filter((h) => h.relation === 'supplies').length, 0);
    const comp = ds.nodes.find((n) => n.kind === 'component' && n.chipSub === 'LinA' && n.identifier.endsWith(':18'));
    const c = ds.cuts.find((x) => x.from === comp?.id);
    ok(`${name}: 値のコンポーネントの切断に、欠けた段（${stage}）と理由を書く`, !!c && c.sub.startsWith(stage), c?.sub);
    eq(`${name}: validateDataset() を通過する`, M.validateDataset(ds), []);
    // 選択だけの描画（文書を同定できなかったとき）でも理由を出す
    const only = A.fromLiveSelection({ ...selFor('/lin-a', aLinA, 'LinA'), lineage: l }).dataset;
    ok(`${name}: 選択だけの描画でも切断に理由を書く`, only.cuts.some((x) => x.sub.startsWith(stage)));
    eq(`${name}: 選択だけの描画に supplies は無い`, only.hops.filter((h) => h.relation === 'supplies').length, 0);
  }
  /* 評価を持たない（7B-3B-1 の形の）並べ方は従来どおり結ばない */
  const plain = A.fromLiveRun(linAObs(), 1, { selection: selFor('/lin-a', aLinA, 'LinA') }).dataset;
  eq('評価が無ければ従来どおり supplies を作らない', plain.hops.filter((h) => h.relation === 'supplies').length, 0);
  /* supplies を実測の取得手段で作ると validateDataset が拒否する（契約の検査が飾りでない） */
  const l = evalWith(linAObs(), aLinA, 'LinA', { token: DOC(1), soft: false });
  const ds = draw(linAObs(), l, '/lin-a', aLinA, 'LinA');
  const bad = { ...ds, hops: ds.hops.map((h) => (h.relation === 'supplies' ? { ...h, source: 'server-call-stack' } : h)) };
  ok('supplies を server-call-stack で作ると validateDataset が拒否する', M.validateDataset(bad).some((v) => v.includes('supplies')));
  const noEnd = { ...ds, hops: ds.hops.map((h) => (h.relation === 'supplies' ? { ...h, endpoints: undefined } : h)) };
  ok('supplies の端点（ソース位置）を落とすと validateDataset が拒否する', M.validateDataset(noEnd).some((v) => v.includes('endpoints')));
  const noOri = { ...ds, hops: ds.hops.map((h) => (h.relation === 'supplies' ? { ...h, orientation: 'along-data' } : h)) };
  ok('supplies の向きを along-data にすると validateDataset が拒否する（端点の型が合わない）', M.validateDataset(noOri).length > 0);
}

console.log(fails.length ? `\n✗ ${fails.length} 件失敗 / ${pass} 件通過` : `\n✓ すべて通過 — ${pass} 件通過 / 0 件失敗`);
process.exit(fails.length ? 1 : 0);
