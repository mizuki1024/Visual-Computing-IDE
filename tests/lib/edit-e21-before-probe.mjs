/* =============================================================================
 * 視覚編集 E2.1 — 変更前後の挙動の実測（試験の本ではない。docs/08d 第12.2節の記録用）。
 *   VCIDE_LIBJS=<.libjs の場所> node tests/lib/edit-e21-before-probe.mjs
 * 変更前（feature/visual-editor @ 86ffbc8）の .libjs と変更後の .libjs の両方で回し、出力を比べる。
 *   P1 同じルートを開いた2枚のうち Mobile だけが RSC で取り直したとき、探索の bindDocument は Desktop の文書を同定するか
 *      （中継の記録に「どの文書の取り直しか」が無いことの再現）。変更後は編集専用の照合（editSyncBinding）も並べる
 *   P2 中継は RSC の要求の文書の名乗り（x-vcide-doc）を記録するか・開発サーバーへ渡すか
 *   P3 中継のスクリプトに、選んだ要素を IDE が観測し直す知らせ（edit-observe）があるか
 * ========================================================================== */
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const LIB = path.resolve(process.env.VCIDE_LIBJS ?? path.join(import.meta.dirname, '..', '..', '.libjs'));
const req = createRequire(import.meta.url);
const LO = req(path.join(LIB, 'lib', 'liveObservation.js'));
const GW = req(path.join(LIB, 'server', 'previewGateway.js'));
const ACC = req(path.join(LIB, 'server', 'access.js'));
let EB = null;
try { EB = req(path.join(LIB, 'lib', 'editSyncBinding.js')); } catch { /* 変更前には無い */ }
console.log(`.libjs: ${LIB}`);

const D = 'd'.repeat(32); const M = 'e'.repeat(32);
const ex = [
  { seq: 1, method: 'GET', path: '/properties', hasQuery: false, kind: 'document', status: 200, startMs: 1000, durationMs: 5, trace: null, failure: null, docToken: D },
  { seq: 2, method: 'GET', path: '/properties', hasQuery: false, kind: 'document', status: 200, startMs: 1010, durationMs: 5, trace: null, failure: null, docToken: M },
  { seq: 3, method: 'GET', path: '/properties', hasQuery: true, kind: 'rsc', status: 200, startMs: 2000, durationMs: 5, trace: null, failure: null },
];
const b = LO.bindDocument({ exchanges: ex }, { token: D, soft: false }, '/properties');
console.log(`P1 探索の bindDocument（Desktop の文書。取り直したのは Mobile だけ）: ${b.status}${b.reason ? ` / ${b.reason}` : ''}`);
if (EB) {
  const ledger = { run: 'r', documents: ex.filter((e) => e.docToken).map((e) => ({ token: e.docToken, path: e.path, status: e.status, startMs: e.startMs, endMs: e.startMs + 5, failed: false })),
    rsc: [{ seq: 1, path: '/properties', status: 200, startMs: 2000, endMs: 2005, failed: false, initiator: M, declaredUnknown: false }], lostDocumentsThroughMs: null, lostRscThroughMs: null };
  const e = EB.bindEditDocument({ ledger, token: D, soft: false, path: '/properties', artboard: 'desktop', otherArtboardTokens: [M], rsc: { started: 0, settled: 0 } });
  console.log(`P1 編集専用の照合（取り直しに Mobile の文書の名乗りがある）: ${e.level} / 取り直し ${e.refetch.status}`);
} else console.log('P1 編集専用の照合: 無い（変更前）');

const free = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const seen = [];
const up = http.createServer((q, s) => { seen.push(q.headers); s.writeHead(200, { 'content-type': 'text/x-component' }); s.end('0:[]'); });
await new Promise((r) => up.listen(0, '127.0.0.1', r));
const recs = [];
const gw = new GW.PreviewGateway({ config: ACC.accessConfig({}), port: await free(), editSync: true,
  target: () => ({ target: { port: up.address().port, run: 'r' }, reason: '' }), observer: { record: (_r, rec, meta) => recs.push({ rec, meta }), excludeStatic() {} } });
const info = await gw.ensure();
await new Promise((r) => http.get({ host: '127.0.0.1', port: info.port, path: '/properties?_rsc=1', headers: { host: `127.0.0.1:${info.port}`, rsc: '1', 'x-vcide-doc': M } }, (x) => { x.resume(); x.on('end', r); }));
await new Promise((r) => setTimeout(r, 50));
console.log(`P2 中継の記録に要求を出した文書の名乗り: ${recs[0]?.meta?.initiatorDoc ? 'ある' : '無い'}`);
console.log(`P2 名乗りのヘッダが開発サーバーへ渡った: ${'x-vcide-doc' in (seen[0] ?? {}) ? 'はい' : 'いいえ'}`);
const js = (() => { try { return GW.agentJs(ACC.accessConfig({}), { editSync: true }); } catch { return GW.agentJs(ACC.accessConfig({})); } })();
console.log(`P3 スクリプトに編集の観測の知らせ（edit-observe）: ${js.includes('edit-observe') ? 'ある' : '無い'}`);
await gw.close(); up.close();
