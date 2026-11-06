/* =============================================================================
 * 視覚編集 E2.1 — プレビューと編集対象の同期（単体。docs/08d 第12節）。
 *   npm run build:lib && node tests/edit-sync21-unit.spec.mjs
 *
 * 製品のコード（.libjs）を、使い捨ての題材（OS の一時ディレクトリ）と、製品の中継（PreviewGateway）・台帳・同期のセッションで回す。
 * 正解は試験がソースを自分で読んで決める（対応表・IDE の照合とは別の情報源）。
 *
 *   E21-01 選んだ要素の正しいソース位置          E21-11 別の要素への置き換わり
 *   E21-02 同じコンポーネントの複数インスタンス    E21-12 Server Component の RSC の取り直し（2枚とも）
 *   E21-03 Desktop と Mobile の接続の分離          E21-13 別のアートボードの RSC の取り直し
 *   E21-04 片方の読み込み直し                      E21-14 文書の識別子と中継の記録の照合
 *   E21-05 両方の読み込み直し                      E21-15 偽の・古い検証の報告の拒否
 *   E21-06 古い MessagePort の知らせの拒否         E21-16 未確認を verified としない
 *   E21-07 nonce の不一致の拒否                    E21-17 復旧の状態を読むだけで確かめる
 *   E21-08 起動（IDE・開発サーバー）の不一致の拒否 E21-18 既定で書き込みが無効・書き込みの道が無い
 *   E21-09 HMR の後の古い版の無効化                E21-19 探索の既存の選択・知らせ・スクリプトが変わらない
 *   E21-10 正しい版と指紋での再照合（選び直し）    E21-20 HMR の安全対策 A1〜A5・探索の bindDocument が変わらない
 * ========================================================================== */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { counter, makeProject, selectionOf, loadEdit, readFixture, CARD, REPO, LIB, require_, transform } from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note, guard } = C;
const load = (rel) => { try { return require_(path.join(LIB, rel)); } catch (e) { ok(`製品のモジュール ${rel} を読み込める`, false, String(e.message).split('\n')[0]); return null; } };
const P = load('lib/previewProtocol.js');
const EP = load('lib/editPreviewProtocol.js');
const EB = load('lib/editSyncBinding.js');
const LG = load('server/editSync/relayLedger.js');
const SS = load('server/editSync/session.js');
const RO = load('server/editSync/readonlyEdit.js');
const GW = load('server/previewGateway.js');
const ACC = load('server/access.js');
const LO = load('lib/liveObservation.js');
if (!EP || !EB || !LG || !SS || !RO) { note('E2.1 のモジュールが無いため、ここで止める（変更前のコード）'); C.finish(); }

import net from 'node:net';
const freePort = async (from) => {
  for (let q = from; q < from + 200; q++) {
    const free = await new Promise((res) => { const sv = net.createServer(); sv.once('error', () => res(false)); sv.once('listening', () => sv.close(() => res(true))); sv.listen(q, '127.0.0.1'); });
    if (free) return q;
  }
  throw new Error('空きポートが見つかりません');
};
const hex = (n) => crypto.randomBytes(n).toString('hex');
const sha1rev = (text) => crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
const DESK = { width: 1440, height: 900 };
const MOB = { width: 375, height: 812 };
const obs = (token, sel = null, o = {}) => ({
  state: sel ? 'ok' : (o.state ?? 'none'), selection: sel, document: { token, soft: o.soft === undefined ? false : o.soft },
  rsc: o.rsc ?? { started: 0, settled: 0 }, viewport: o.viewport ?? DESK,
});

/* ------------------------------------------------------------ 使い捨ての題材と、正解（ソースを読む） */
const PL = 'src/components/PropertyList.tsx';
const SN = 'src/components/SiteNotice.tsx';
const p = makeProject({ [CARD]: readFixture(CARD), [PL]: readFixture(PL), [SN]: readFixture(SN) }, { name: 'e21' });
for (const f of [CARD, PL, SN]) p.compile(f);
/** needle を含む行の最初の '<' の位置（対応表を使わない正解） */
const locate = (rel, needle) => {
  const lines = p.read(rel).split('\n');
  const hits = lines.map((l, i) => (l.includes(needle) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw new Error(`正解が1つに決まりません: ${needle}`);
  return { file: rel, line: hits[0] + 1, col: lines[hits[0]].indexOf('<') + 1 };
};
const selAt = (rel, needle, extra = {}) => selectionOf(p.anchorAt(rel, needle), undefined, { path: '/properties', ...extra });

/* ------------------------------------------------------------ セッション（製品の EditSyncSession。起動は偽の値） */
const RUN = { instance: 'e21-inst', pid: process.pid, startedAt: '2026-11-06T00:00:00.000Z' };
const RUNS = `${RUN.instance}:${RUN.pid}:${RUN.startedAt}`;
const ledger = new LG.EditRelayLedger();
let clock = Date.now();
const now = () => clock;
let current = { run: RUN, runString: RUNS, projectRoot: p.root, projectName: 'e21' };
const session = new SS.EditSyncSession({
  current: () => current, project: () => ({ root: p.root, name: 'e21' }), ledger,
  viewFor: (root) => RO.readonlyEditView(root, { journalDir: p.journalDir }), now,
});
const BOOT = session.ideBoot;
const docRec = (token, pathname = '/properties', status = 200, startMs = clock) =>
  ledger.record(RUNS, { method: 'GET', path: pathname, hasQuery: false, kind: 'document', status, startMs, durationMs: 5, trace: null, failure: null }, { relayId: hex(16), docToken: token });
const rscRec = (initiator, pathname = '/properties', startMs = clock, status = 200) =>
  ledger.record(RUNS, { method: 'GET', path: pathname, hasQuery: true, kind: 'rsc', status, startMs, durationMs: 5, trace: null, failure: null }, { relayId: hex(16), ...(initiator ? { initiatorDoc: initiator } : {}) });
const req = (artboard, conn, observation, extra = {}) => ({ ideBoot: BOOT, run: RUN, artboard, conn, observation, ...extra });
const body = (r) => { if (!r.ok) throw new Error(`400: ${JSON.stringify(r.error)}`); return r.body; };

const connD1 = `cd1-${hex(8)}`; const D1 = hex(16);
const connM1 = `cm1-${hex(8)}`; const M1 = hex(16);
clock += 10; docRec(D1); clock += 10; docRec(M1); clock += 10;

/* ============================================================ E21-01 */
console.log('\nE21-01 プレビューで選んだ要素 → 正しいソース位置（サーバーが決める）');
let deskTarget = null;
guard('E21-01', () => {
  const c = body(session.connect(req('desktop', connD1, obs(D1))));
  eq('Desktop の接続を登録する', c.connection.status, 'identified');
  const truth = locate(CARD, 'p-4 md:p-6');
  const s = selAt(CARD, 'p-4 md:p-6', { anchorOrdinal: 0, anchorInstanceCount: 3 });
  const v = body(session.select(req('desktop', connD1, obs(D1, s))));
  eq('状態は selected', v.status, 'selected');
  eq('ファイル（正解はソースを読んで決めた）', v.source?.file, truth.file);
  eq('行', v.source?.line, truth.line);
  eq('列', v.source?.col, truth.col);
  eq('コンポーネント', v.source?.component, 'PropertyCard');
  eq('ソースの版 = 試験が読み直した内容の sha1（先頭16桁）', v.source?.sourceRev, sha1rev(p.read(CARD)));
  ok('DOM の版・対応表の版・ソースの版が一致', v.source && v.source.domRev === v.source.sourceRev && v.source.manifestRev === v.source.sourceRev, v.source);
  eq('文書の段: 中継の台帳の応答と照合済み', v.document?.document.status, 'identified');
  eq('取り直しの段: 無し', v.document?.refetch.status, 'none');
  eq('描画は確かめていない（not-verified）', v.document?.render, 'not-verified');
  eq('文書の照合の水準は document-identified（verified と言わない）', v.document?.level, 'document-identified');
  ok('位置を受け取る入口が無い: 観測に位置（file・line）を足すと形の検査で拒む',
    session.select(req('desktop', connD1, { ...obs(D1, s), file: CARD, line: 1 })).ok === false);
  ok('矩形・計算済みスタイルもサーバーは受け取らない（表示用で、照合の根拠にしない）',
    session.select(req('desktop', connD1, { ...obs(D1, s), rect: { x: 0, y: 0, width: 1, height: 1 } })).ok === false);
  deskTarget = v.source;
  const v2 = body(session.select(req('desktop', connD1, obs(D1, s))));
  deskTarget = v2.source;
});

/* ============================================================ E21-02 */
console.log('\nE21-02 同じコンポーネントの複数インスタンス（DOM のインスタンスとソースの定義を分ける）');
guard('E21-02', () => {
  const a = body(session.select(req('desktop', connD1, obs(D1, selAt(CARD, 'p-4 md:p-6', { anchorOrdinal: 0, anchorInstanceCount: 3 })))));
  const b = body(session.select(req('desktop', connD1, obs(D1, selAt(CARD, 'p-4 md:p-6', { anchorOrdinal: 2, anchorInstanceCount: 3 })))));
  ok('2つともソースの定義は同じ（ファイル・行・列・識別子）', a.source && b.source && a.source.file === b.source.file && a.source.line === b.source.line
    && a.source.col === b.source.col && a.source.anchorId === b.source.anchorId, [a.source, b.source]);
  ok('DOM のインスタンスは別（何番目か）', a.instance?.ordinal === 0 && b.instance?.ordinal === 2 && a.instance?.count === 3, [a.instance, b.instance]);
  ok('インスタンスとソースを別の項目で返す（instance / source）', 'instance' in a && 'source' in a);
  deskTarget = b.source;
});

/* ============================================================ E21-03 */
console.log('\nE21-03 Desktop と Mobile の接続の分離');
let mobTarget = null;
guard('E21-03', () => {
  const c = body(session.connect(req('mobile', connM1, obs(M1, null, { viewport: MOB }))));
  eq('Mobile の接続を登録する', c.connection.status, 'identified');
  const sn = locate(SN, 'p-4 md:p-6');
  const v = body(session.select(req('mobile', connM1, obs(M1, selAt(SN, 'p-4 md:p-6'), { viewport: MOB }))));
  eq('Mobile で別の要素（SiteNotice）を選ぶ', v.source?.component, 'SiteNotice');
  eq('（同）位置', `${v.source?.file}:${v.source?.line}:${v.source?.col}`, `${sn.file}:${sn.line}:${sn.col}`);
  mobTarget = v.source;
  const d = body(session.recheck(req('desktop', connD1, obs(D1, selAt(CARD, 'p-4 md:p-6', { anchorOrdinal: 2, anchorInstanceCount: 3 })), { targetId: deskTarget.targetId })));
  eq('Desktop の選択は Mobile の選択で変わらない（再照合も selected・同じ対象）', `${d.status}:${d.source?.targetId}`, `selected:${deskTarget.targetId}`);
  const x = body(session.select(req('mobile', connM1, obs(D1, selAt(SN, 'p-4 md:p-6'), { viewport: MOB }))));
  eq('Mobile の接続で Desktop の文書の識別子を名乗る選択は受けない', `${x.status}:${x.reason}`, 'disconnected:document-not-registered');
  const y = body(session.connect(req('mobile', `cmx-${hex(8)}`, obs(D1, null, { viewport: MOB }))));
  eq('Desktop の文書を Mobile の接続として登録しない', `${y.status}:${y.reason}`, 'disconnected:token-of-other-artboard');
  const z = body(session.select(req('desktop', connD1, obs(D1, selAt(CARD, 'p-4 md:p-6'), { viewport: MOB }))));
  eq('Desktop の接続から Mobile の大きさの観測は受けない', `${z.status}:${z.reason}`, 'disconnected:viewport-mismatch');
  const w = body(session.recheck(req('mobile', connM1, obs(M1, selAt(SN, 'p-4 md:p-6'), { viewport: MOB }), { targetId: mobTarget.targetId })));
  eq('上の拒否の後も Mobile の選択は selected のまま', w.status, 'selected');
});

/* ============================================================ E21-04 / E21-06 */
console.log('\nE21-04・E21-06 片方の読み込み直し・古い MessagePort');
const connD2 = `cd2-${hex(8)}`; const D2 = hex(16);
guard('E21-04', () => {
  clock += 10; docRec(D2); clock += 10;
  body(session.connect(req('desktop', connD2, obs(D2))));
  const old = body(session.recheck(req('desktop', connD1, obs(D1, selAt(CARD, 'p-4 md:p-6')), { targetId: deskTarget.targetId })));
  eq('前の文書の接続（古い MessagePort）からの再照合は disconnected（stale-connection）', `${old.status}:${old.reason}`, 'disconnected:stale-connection');
  const old2 = body(session.select(req('desktop', connD1, obs(D1, selAt(CARD, 'p-4 md:p-6')))));
  eq('前の文書の接続からの選択も受けない', `${old2.status}:${old2.reason}`, 'disconnected:stale-connection');
  const n = body(session.recheck(req('desktop', connD2, obs(D2, selAt(CARD, 'p-4 md:p-6')), { targetId: deskTarget.targetId })));
  eq('新しい文書では前の選択を引き継がない（stale・再選択）', `${n.status}:${n.reason}:${n.reselect}`, 'stale:selection-unknown:true');
  const m = body(session.recheck(req('mobile', connM1, obs(M1, selAt(SN, 'p-4 md:p-6'), { viewport: MOB }), { targetId: mobTarget.targetId })));
  eq('Mobile の接続・選択は変わらない', `${m.status}:${m.source?.targetId}`, `selected:${mobTarget.targetId}`);
  eq('Mobile の文書の照合も変わらない', m.document?.level, 'document-identified');
  const accept = (from, cur, data) => EP.acceptEditPortMessage(from, cur, 'desktop', { serverKey: 'k', ideBoot: BOOT }, data);
  const c1 = { artboard: 'desktop', id: 'conn-aaaaaaaaaaaaaaaa', nonce: 'nonce-aaaaaaaaaaaaaaaa', serverKey: 'k', ideBoot: BOOT };
  const c2 = { ...c1, id: 'conn-bbbbbbbbbbbbbbbb', nonce: 'nonce-bbbbbbbbbbbbbbbb' };
  const msg = (c, x = {}) => ({ source: 'vcide-preview', v: 3, kind: 'edit-observation', ev: 1, nonce: c.nonce, req: 1, state: 'none', selection: null, rect: null, style: null, doc: D2, soft: false, rsc: { started: 0, settled: 0 }, vw: 1440, vh: 900, ...x });
  eq('E21-06: 画面の側でも、古い接続の port の知らせは捨てる', accept(c1, c2, msg(c1)).reason, 'not-current-connection');
  eq('いまの接続の知らせは受ける', accept(c2, c2, msg(c2)).ok, true);
  eq('別のアートボードの接続の知らせは捨てる', EP.acceptEditPortMessage({ ...c2, artboard: 'mobile' }, c2, 'desktop', { serverKey: 'k', ideBoot: BOOT }, msg(c2)).reason, 'other-artboard');
});

/* ============================================================ E21-05 */
console.log('\nE21-05 両方の読み込み直し');
const connD3 = `cd3-${hex(8)}`; const D3 = hex(16); const connM2 = `cm2-${hex(8)}`; const M2 = hex(16);
guard('E21-05', () => {
  clock += 10; docRec(D3); docRec(M2); clock += 10;
  body(session.connect(req('desktop', connD3, obs(D3))));
  body(session.connect(req('mobile', connM2, obs(M2, null, { viewport: MOB }))));
  const m = body(session.recheck(req('mobile', connM1, obs(M1, selAt(SN, 'p-4 md:p-6'), { viewport: MOB }), { targetId: mobTarget.targetId })));
  eq('Mobile の前の接続は disconnected', `${m.status}:${m.reason}`, 'disconnected:stale-connection');
  const m2 = body(session.recheck(req('mobile', connM2, obs(M2, selAt(SN, 'p-4 md:p-6'), { viewport: MOB }), { targetId: mobTarget.targetId })));
  eq('Mobile の新しい文書でも前の選択を引き継がない', m2.status, 'stale');
  const st = session.state();
  ok('状態に、2枚それぞれのいまの接続（別の文書）が出る', st.connections.desktop?.token === D3 && st.connections.mobile?.token === M2, st.connections);
  const d = body(session.select(req('desktop', connD3, obs(D3, selAt(CARD, 'p-4 md:p-6')))));
  const mm = body(session.select(req('mobile', connM2, obs(M2, selAt(CARD, 'p-4 md:p-6'), { viewport: MOB }))));
  ok('選び直せば、両方とも新しい対象として selected（同じ定義でも別の対象）', d.status === 'selected' && mm.status === 'selected' && d.source.targetId !== mm.source.targetId, [d.status, mm.status]);
  deskTarget = d.source; mobTarget = mm.source;
});

/* ============================================================ E21-07 / E21-08 */
console.log('\nE21-07・E21-08 nonce・起動の不一致');
guard('E21-07', () => {
  const n = 'nonce-cccccccccccccccc';
  const m = { source: 'vcide-preview', v: 3, kind: 'edit-observation', ev: 1, nonce: n, req: 4, state: 'none', selection: null, rect: null, style: null, doc: null, soft: false, rsc: { started: 0, settled: 0 }, vw: 375, vh: 812 };
  ok('形の合う観測は受ける', !!EP.parseEditObservation(m, n));
  eq('nonce が違えば捨てる', EP.parseEditObservation(m, 'nonce-dddddddddddddddd'), null);
  eq('求めた番号と違う答え（遅れた答え）は捨てる', EP.parseEditObservation(m, n, 5), null);
  eq('知らないキーがあれば捨てる', EP.parseEditObservation({ ...m, cookie: 'x' }, n), null);
  eq('版が違えば捨てる', EP.parseEditObservation({ ...m, v: 2 }, n), null);
  eq('拡張の版が違えば捨てる', EP.parseEditObservation({ ...m, ev: 2 }, n), null);
  eq('許していない計算済みスタイル（background-image）は捨てる', EP.parseEditObservation({ ...m, state: 'ok', selection: selAt(CARD, 'p-4 md:p-6'), style: { 'background-image': 'none' } }, n), null);
  eq('URL を含みうる値は捨てる', EP.parseEditObservation({ ...m, state: 'ok', selection: selAt(CARD, 'p-4 md:p-6'), style: { color: 'url(http://x/)' } }, n), null);
  eq('選んでいないのに選択があるものは捨てる', EP.parseEditObservation({ ...m, selection: selAt(CARD, 'p-4 md:p-6') }, n), null);
  eq('応答済みの数が要求の数を超えるものは捨てる', EP.parseEditObservation({ ...m, rsc: { started: 1, settled: 2 } }, n), null);
  const c = { artboard: 'mobile', id: 'conn-eeeeeeeeeeeeeeee', nonce: n, serverKey: 'k', ideBoot: BOOT };
  eq('画面の側: nonce が違う知らせは捨てる', EP.acceptEditPortMessage(c, c, 'mobile', { serverKey: 'k', ideBoot: BOOT }, { ...m, nonce: 'nonce-ffffffffffffffff' }).reason, 'nonce-mismatch');
});
guard('E21-08', () => {
  const s = selAt(CARD, 'p-4 md:p-6');
  const a = body(session.select({ ...req('desktop', connD3, obs(D3, s)), ideBoot: hex(16) }));
  eq('IDE の起動が違う要求は disconnected（ide-restarted）', `${a.status}:${a.reason}`, 'disconnected:ide-restarted');
  const b = body(session.select({ ...req('desktop', connD3, obs(D3, s)), run: { ...RUN, pid: RUN.pid + 1 } }));
  eq('開発サーバーの起動が違う要求は disconnected（stale-run）', `${b.status}:${b.reason}`, 'disconnected:stale-run');
  const b2 = body(session.select({ ...req('desktop', connD3, obs(D3, s)), run: { ...RUN, startedAt: '2026-11-06T00:00:01.000Z' } }));
  eq('（同）開始時刻だけが違っても拒む', b2.reason, 'stale-run');
  const c = { artboard: 'desktop', id: 'conn-gggggggggggggggg', nonce: 'nonce-gggggggggggggggg', serverKey: 'k1', ideBoot: BOOT };
  const m = { source: 'vcide-preview', v: 3, kind: 'edit-observation', ev: 1, nonce: c.nonce, req: 1, state: 'none', selection: null, rect: null, style: null, doc: null, soft: false, rsc: { started: 0, settled: 0 }, vw: 1440, vh: 900 };
  eq('画面の側: 開発サーバーが入れ替わった後の知らせは捨てる', EP.acceptEditPortMessage(c, c, 'desktop', { serverKey: 'k2', ideBoot: BOOT }, m).reason, 'server-changed');
  eq('画面の側: IDE が起動し直した後の知らせは捨てる', EP.acceptEditPortMessage(c, c, 'desktop', { serverKey: 'k1', ideBoot: hex(16) }, m).reason, 'ide-restarted');
  const keep = body(session.recheck(req('desktop', connD3, obs(D3, s), { targetId: deskTarget.targetId })));
  eq('拒否の後も、正しい要求の選択は selected のまま', keep.status, 'selected');
});

/* ============================================================ E21-09 / E21-10 / E21-11 */
console.log('\nE21-09〜11 HMR の後の古い版・選び直し・別の要素への置き換わり');
guard('E21-09', () => {
  const before = p.read(CARD);
  const oldSel = selAt(CARD, 'p-4 md:p-6');
  p.write(CARD, before.replace('竣工', '完成'));   // 行・列を変えずに内容（版）だけ変える
  const a = body(session.recheck(req('desktop', connD3, obs(D3, oldSel), { targetId: deskTarget.targetId })));
  eq('HMR の前の DOM（古い版）での再照合は stale', a.status, 'stale');
  ok('理由は版の違い（source-changed 系）', ['source-changed', 'target-unresolved', 'element-mismatch'].includes(a.reason) && a.reselect === true, a);
  p.compile(CARD);
  const newSel = selAt(CARD, 'p-4 md:p-6');
  ok('前提: 新しい DOM の版は前と違う', newSel.anchorRev !== oldSel.anchorRev);
  const b = body(session.recheck(req('desktop', connD3, obs(D3, newSel), { targetId: deskTarget.targetId })));
  eq('HMR の後の DOM（新しい版）でも、前の対象は引き継がない（stale のまま）', b.status, 'stale');
  const c = body(session.recheck(req('desktop', connD3, obs(D3, newSel), { targetId: deskTarget.targetId })));
  eq('一度失効した選択は、何度確かめても戻らない', c.status, 'stale');
});
guard('E21-10', () => {
  const s = selAt(CARD, 'p-4 md:p-6');
  const v = body(session.select(req('desktop', connD3, obs(D3, s))));
  eq('選び直すと、新しい対象として selected', v.status, 'selected');
  eq('新しい版 = いまの内容の sha1（試験が読み直した）', v.source.sourceRev, sha1rev(p.read(CARD)));
  const T = loadEdit('target');
  const truth = locate(CARD, 'p-4 md:p-6');
  const el = T.inspectElementAt(p.read(CARD), CARD, truth.line, truth.col);
  eq('指紋 = いまの内容のその位置の要素の指紋', v.source.fingerprint, el.fingerprint.hash);
  eq('構造の指紋も一致', v.source.structureHash, el.fingerprint.structureHash);
  ok('前の対象とは別の対象（識別子が違う）', v.source.targetId !== deskTarget.targetId);
  deskTarget = v.source;
  const again = body(session.recheck(req('desktop', connD3, obs(D3, s), { targetId: deskTarget.targetId })));
  eq('変わっていなければ再照合は selected', again.status, 'selected');
  /* 古い DOM での再照合を経ずに、いきなり新しい版の DOM で確かめても引き継がない（新しい版の要素として扱わない） */
  const keep = p.read(CARD);
  p.write(CARD, keep.replace('{property.pref}', '{property.pref} '));
  p.compile(CARD);
  const direct = body(session.recheck(req('desktop', connD3, obs(D3, selAt(CARD, 'p-4 md:p-6')), { targetId: deskTarget.targetId })));
  ok('ソースが変わった後、新しい版の DOM で直接確かめても stale（自動で引き継がない）', direct.status === 'stale' && direct.reselect === true, direct);
  p.write(CARD, keep); p.compile(CARD);
  deskTarget = body(session.select(req('desktop', connD3, obs(D3, s)))).source;
});
guard('E21-11', () => {
  const before = p.read(CARD);
  const oldSel = selAt(CARD, 'p-4 md:p-6');
  const truth = locate(CARD, 'p-4 md:p-6');
  /* 同じ行・同じ列に、別の要素（タグとクラスが違う）を置く */
  p.write(CARD, before.replace('<div className="rounded-lg border bg-white p-4 md:p-6 shadow-sm">', '<article className="grid gap-1">').replace('    </div>\n  );', '    </article>\n  );'));
  p.compile(CARD);
  const t2 = transform(p.read(CARD), CARD);
  const same = t2.anchors.find((a) => a.line === truth.line && a.col === truth.col);
  ok('前提: 同じ行・列に要素があり、識別子（位置から決まる）は同じ', same && same.id === oldSel.anchorOnSelf, same);
  const newDom = selectionOf({ ...same, rev: t2.rev }, t2.rev, { path: '/properties' });
  const a = body(session.recheck(req('desktop', connD3, obs(D3, newDom), { targetId: deskTarget.targetId })));
  ok('同じ位置に別の要素が来ても、前の要素を維持しない（stale）', a.status === 'stale' && a.reselect, a);
  const b = body(session.select(req('desktop', connD3, obs(D3, newDom))));
  ok('選び直すと、いまの要素（別の要素）として解決する（前の指紋ではない）', b.status === 'selected' && b.source.fingerprint !== deskTarget.fingerprint, b);
  p.write(CARD, readFixture(CARD)); p.compile(CARD);
  deskTarget = body(session.select(req('desktop', connD3, obs(D3, selAt(CARD, 'p-4 md:p-6'))))).source;
});

/* ============================================================ E21-12 / E21-13 / E21-20 */
console.log('\nE21-12・E21-13 RSC の取り直しを、出した文書で区別する（探索の bindDocument は変えない）');
const bind = (token, others, rsc, o = {}) => EB.bindEditDocument({ ledger: ledger.view(RUNS), token, soft: false, path: '/properties', artboard: 'desktop', otherArtboardTokens: others, rsc, ...o });
const exploreObs = () => ({
  exchanges: (() => {
    const v = ledger.view(RUNS);
    const all = [...v.documents.map((d) => ({ kind: 'document', path: d.path, status: d.status, startMs: d.startMs, docToken: d.token, failure: null })),
      ...v.rsc.map((r) => ({ kind: 'rsc', path: r.path, status: r.status, startMs: r.startMs, failure: null }))];
    return all.sort((a, b) => a.startMs - b.startMs).map((e, i) => ({ seq: i + 1, method: 'GET', hasQuery: false, durationMs: 1, trace: null, ...e }));
  })(),
});
guard('E21-13', () => {
  clock += 10;
  rscRec(M2); clock += 10;   // Mobile の文書だけが取り直した
  const d = bind(D3, [M2], { started: 0, settled: 0 });
  eq('Desktop: Mobile の取り直しでは同定を落とさない（document-identified・取り直し無し）', `${d.level}:${d.refetch.status}`, 'document-identified:none');
  const m = bind(M2, [D3], { started: 1, settled: 1 }, { artboard: 'mobile' });
  eq('Mobile: 自分の取り直し1件（スクリプトの数と一致）', `${m.level}:${m.refetch.status}:${m.refetch.count}`, 'document-identified:self:1');
  const ex = LO.bindDocument(exploreObs(), { token: D3, soft: false }, '/properties');
  eq('E21-20: 探索の bindDocument は変えていない（同じ記録で refetched-after-document のまま。安全側）', ex.status === 'unidentified' ? ex.reason : ex.status, 'refetched-after-document');
});
guard('E21-12', () => {
  rscRec(D3); rscRec(M2); clock += 10;   // Server Component の更新で、2枚とも取り直した
  const d = bind(D3, [M2], { started: 1, settled: 1 });
  eq('Desktop: 自分の取り直し1件として照合済み', `${d.level}:${d.refetch.status}:${d.refetch.count}`, 'document-identified:self:1');
  const m = bind(M2, [D3], { started: 2, settled: 2 }, { artboard: 'mobile' });
  eq('Mobile: 自分の取り直し2件', `${m.level}:${m.refetch.count}`, 'document-identified:2');
  eq('描画は確かめていない', d.render, 'not-verified');
  const md = bind(M2, [D3], { started: 1, settled: 1 }, { artboard: 'mobile' });
  eq('スクリプトの数（1）が台帳（2）より少ない＝誰かがこの識別子を名乗った → 未確認', `${md.level}:${md.refetch.reason}`, 'unverified:rsc-count-mismatch');
});

/* ============================================================ E21-14 / E21-16 */
console.log('\nE21-14・E21-16 文書の識別子と中継の記録の照合・未確認を verified としない');
guard('E21-14', () => {
  eq('台帳に無い識別子は token-not-in-relay', bind(hex(16), [], { started: 0, settled: 0 }).reasons.join(), 'token-not-in-relay');
  eq('識別子が無ければ no-document-token', bind(null, [], { started: 0, settled: 0 }).reasons.join(), 'no-document-token');
  eq('パスが違えば path-mismatch', bind(D3, [], { started: 1, settled: 1 }, { path: '/favorites' }).reasons.join(), 'path-mismatch');
  const F = hex(16); docRec(F, '/properties', 500); clock += 10;
  eq('2xx でない応答の文書は document-failed', bind(F, [], { started: 0, settled: 0 }).reasons.join(), 'document-failed');
  eq('別のアートボードの文書の識別子は token-of-other-artboard', bind(D3, [D3], { started: 1, settled: 1 }).reasons.join(), 'token-of-other-artboard');
  const small = new LG.EditRelayLedger({ documents: 2 });
  const R = 'small-run';
  const rec = (t) => small.record(R, { method: 'GET', path: '/', hasQuery: false, kind: 'document', status: 200, startMs: clock++, durationMs: 1, trace: null, failure: null }, { docToken: t });
  const t1 = hex(16); rec(t1); rec(hex(16)); rec(hex(16));
  eq('保持の上限で外した文書は ledger-evicted（推測で token-not-in-relay と言わない）',
    EB.bindEditDocument({ ledger: small.view(R), token: t1, soft: false, path: '/', artboard: 'desktop', otherArtboardTokens: [], rsc: { started: 0, settled: 0 } }).reasons.join(), 'ledger-evicted');
  eq('別の起動の台帳には無い（起動ごとに分ける）', ledger.view('other-run'), null);
});
guard('E21-16', () => {
  const soft = bind(D3, [], { started: 1, settled: 1 }, { soft: true });
  eq('ページ内の遷移の後は client-navigation（未確認）', `${soft.level}:${soft.reasons.join()}`, 'unverified:client-navigation');
  const pend = bind(D3, [], { started: 2, settled: 1 });
  ok('応答待ちの取り直しは rsc-pending（未確認・一時的）', pend.level === 'unverified' && pend.reasons[0] === 'rsc-pending' && pend.transient === true, pend);
  rscRec(null); clock += 10;   // どの文書が出したか分からない取り直し
  const un = bind(D3, [], { started: 1, settled: 1 });
  eq('出した文書が分からない同じパスの取り直しがあれば rsc-unattributed（未確認）', `${un.level}:${un.reasons.join()}`, 'unverified:rsc-unattributed');
  const D4 = hex(16); docRec(D4); clock += 10; rscRec(hex(16)); clock += 10;   // 台帳に無い識別子を名乗る取り直し
  const un2 = bind(D4, [], { started: 0, settled: 0 });
  ok('台帳に無い識別子を名乗る取り直しも、出した文書が分からないものとして扱う', un2.level === 'unverified' && un2.reasons[0] === 'rsc-unattributed', un2);
  const all = JSON.stringify([soft, pend, un, un2]);
  ok('文書の照合の結果に "verified" という水準は無い（document-identified / unverified だけ）', !/"level":"verified"/.test(all) && !/"status":"verified"/.test(all));
  const v = body(session.recheck(req('desktop', connD3, obs(D3, selAt(CARD, 'p-4 md:p-6'), { rsc: { started: 1, settled: 1 } }), { targetId: deskTarget.targetId })));
  ok('選択は selected でも、文書の照合が未確認ならそう返す（選択の成功を文書の照合に格上げしない）', v.status === 'selected' && v.document.level === 'unverified' && v.document.reasons.includes('rsc-unattributed'), v.document);
});

/* ============================================================ E21-15 */
console.log('\nE21-15 偽の・古い検証の報告の拒否（結び付けだけ。検証の評価・記録はしない）');
guard('E21-15', () => {
  /* 新しい文書（取り直しの混ざらない）で2枚を接続し直す */
  const D5 = hex(16); const M5 = hex(16);
  clock += 10; docRec(D5); docRec(M5); clock += 10;
  const cD = `cd5-${hex(8)}`; const cM = `cm5-${hex(8)}`;
  body(session.connect(req('desktop', cD, obs(D5))));
  body(session.connect(req('mobile', cM, obs(M5, null, { viewport: MOB }))));
  clock += 1000;
  const rev = sha1rev(p.read(CARD));
  const art = (w, h, token, at = new Date(clock).toISOString()) => ({ viewport: { width: w, height: h }, mode: 'measured', predictionMarkers: 0, measuredAt: at,
    document: { token, path: '/properties', sourceRevs: { [CARD]: rev } }, elements: [] });
  const rep = (arts, at = new Date(clock).toISOString()) => ({ txId: 'tx-20261106000000-deadbeef', anchorId: deskTarget.anchorId, file: CARD, sourceRev: rev, measuredAt: at, artboards: arts });
  const jBefore = fs.existsSync(p.journalDir) ? fs.readdirSync(p.journalDir).sort().join() : '';
  const good = body(session.bindReport({ ideBoot: BOOT, report: rep([art(1440, 900, D5), art(375, 812, M5)]) }));
  eq('いまの2枚の文書・接続で測った報告は bound', good.binding, 'bound');
  eq('（同）描画は報告の申告のまま（declared-by-report）', good.render, 'declared-by-report');
  eq('（同）検証の契約は評価していない（verified にしない）', good.verification, 'not-evaluated');
  const swap = body(session.bindReport({ ideBoot: BOOT, report: rep([art(1440, 900, M5), art(375, 812, D5)]) }));
  ok('Desktop と Mobile の文書を入れ替えた報告は unbound（other-artboard）', swap.binding === 'unbound' && swap.problems.some((x) => x.includes('connection-other-artboard')), swap.problems);
  const old = body(session.bindReport({ ideBoot: BOOT, report: rep([art(1440, 900, D3), art(375, 812, M5)]) }));
  ok('前の文書（読み込み直す前）の識別子の報告は unbound', old.binding === 'unbound' && old.problems.some((x) => x.startsWith('desktop:connection-')), old.problems);
  const fake = body(session.bindReport({ ideBoot: BOOT, report: rep([art(1440, 900, hex(16)), art(375, 812, M5)]) }));
  ok('中継が出していない識別子の報告は unbound', fake.binding === 'unbound', fake.problems);
  const early = body(session.bindReport({ ideBoot: BOOT, report: rep([art(1440, 900, D5, new Date(clock - 5000).toISOString()), art(375, 812, M5)]) }));
  ok('その文書を接続する前の時刻の計測は unbound（古い報告）', early.binding === 'unbound' && early.problems.some((x) => x.includes('measured-before')), early.problems);
  rscRec(D5); clock += 50;
  const stale = body(session.bindReport({ ideBoot: BOOT, report: rep([art(1440, 900, D5, new Date(clock - 40).toISOString()), art(375, 812, M5)]) }));
  ok('その文書の最後の取り直しより前の計測は unbound（計測の後に描き直された）', stale.binding === 'unbound', stale.problems);
  const one = body(session.bindReport({ ideBoot: BOOT, report: rep([art(1440, 900, D5)]) }));
  ok('Mobile が無い報告は unbound（viewport-missing）', one.binding === 'unbound' && one.problems.includes('mobile:viewport-missing'), one.problems);
  const boot = body(session.bindReport({ ideBoot: hex(16), report: rep([art(1440, 900, D5), art(375, 812, M5)]) }));
  eq('別の IDE の起動の画面からは unbound', boot.binding, 'unbound');
  const bad = body(session.bindReport({ ideBoot: BOOT, report: { nope: 1 } }));
  eq('形の合わない報告は unbound', bad.binding, 'unbound');
  const jAfter = fs.existsSync(p.journalDir) ? fs.readdirSync(p.journalDir).sort().join() : '';
  eq('結び付けは記録を書かない（ジャーナルのディレクトリは変わらない）', jAfter, jBefore);
});

/* ============================================================ E21-17 */
console.log('\nE21-17 復旧の状態を読むだけで確かめる');
guard('E21-17', () => {
  const sel = selAt(CARD, 'p-4 md:p-6');
  const r = spawnSync(process.execPath, [path.join(REPO, 'tests', 'lib', 'edit-crash-child.mjs'), JSON.stringify({
    libjs: LIB, root: p.root, journalDir: p.journalDir, selection: sel, change: { kind: 'class-token', from: 'p-4', to: 'p-5' }, mode: 'apply', at: 'applying', action: 'crash',
  })], { encoding: 'utf8' });
  ok('前提: 適用の途中で止まった子プロセス（SIGKILL）', r.signal === 'SIGKILL', { status: r.status, signal: r.signal, out: r.stdout.slice(0, 200) });
  const snap = () => {
    const m = {};
    for (const d of [p.journalDir, path.join(p.root, 'src')]) {
      const walk = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const q = path.join(x, e.name); const st = fs.lstatSync(q); if (e.isDirectory()) walk(q); else m[q] = `${st.ino}:${st.size}:${st.mtimeMs}:${st.nlink}:${crypto.createHash('sha256').update(fs.readFileSync(q)).digest('hex')}`; } };
      if (fs.existsSync(d)) walk(d);
    }
    return JSON.stringify(m);
  };
  const before = snap();
  const s1 = session.state(); session.state(); const s3 = session.state();
  eq('状態の復旧は点検（inspected）', s1.recovery.status, 'inspected');
  eq('（同）mutates: false', s1.recovery.mutates, false);
  ok('止まった適用の記録が、要確認として出る', s1.recovery.needsAttention >= 1 && s1.recovery.entries.some((e) => e.state === 'applying' && e.plannedAction !== 'none'), s1.recovery.entries);
  eq('3回点検しても、ジャーナル・src/ の下は1バイトも変わらない（種類・inode・大きさ・時刻・リンク数・内容）', snap(), before);
  eq('（同）点検の結果も変わらない（自動で片付けない）', JSON.stringify(s3.recovery.entries), JSON.stringify(s1.recovery.entries));
  eq('書き込みの可否は既定で無効（env-not-set）', s1.write.enabled, false);
});

/* ============================================================ E21-18 */
console.log('\nE21-18 既定で書き込みが無効・同期の層に書き込みの道が無い');
guard('E21-18', () => {
  eq('VCIDE_EDIT_E1_WRITE が無ければ書き込みは無効', RO.writeGate().enabled, false);
  eq('VCIDE_EDIT_SYNC_DEV の既定は無効', SS.editSyncEnabled({}), false);
  for (const v of ['', '0', 'true', 'yes', ' 1']) eq(`VCIDE_EDIT_SYNC_DEV=${JSON.stringify(v)} は無効`, SS.editSyncEnabled({ VCIDE_EDIT_SYNC_DEV: v }), false);
  eq('"1" のときだけ有効', SS.editSyncEnabled({ VCIDE_EDIT_SYNC_DEV: '1' }), true);
  const v = RO.readonlyEditView(p.root, { journalDir: p.journalDir });
  eq('読み取りの窓口が出すのは root・resolveTarget・reresolveTarget・inspectRecovery だけ', Object.keys(v).sort().join(), 'inspectRecovery,reresolveTarget,resolveTarget,root');
  ok('窓口は凍結（後から書き込みの関数を足せない）', Object.isFrozen(v));
  for (const k of ['apply', 'revert', 'recover', 'startupRecovery', 'submitVerification', 'createDraft', 'carrySelection']) {
    ok(`窓口にもセッションにも ${k} は無い`, typeof v[k] === 'undefined' && typeof session[k] === 'undefined');
  }
  const src = fs.readFileSync(path.join(REPO, 'src/server/editSync/readonlyEdit.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('窓口のソースは apply・revert・recover・createDraft・submitVerification・carrySelection を呼ばない',
    !/\.(apply|revert|recover|startupRecovery|createDraft|submitVerification|carrySelection)\s*\(/.test(src));
  const route = fs.readFileSync(path.join(REPO, 'src/app/api/edit-sync/[op]/route.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('API の操作は connect・disconnect・select・recheck・bind-report・state だけ（apply・revert・draft・recover が無い）',
    /'connect', 'disconnect', 'select', 'recheck', 'bind-report'/.test(route) && !/apply|revert|draft|recover/i.test(route));
});

/* ============================================================ E21-19 */
console.log('\nE21-19 探索の既存の知らせ・選択・スクリプトが変わらない');
guard('E21-19', () => {
  /* 変更前（feature/visual-editor @ 86ffbc8）の agentJs の出力の sha256。既定（editSync なし）は1バイトも変えない */
  const GOLD = {
    default: 'ee107cbb6ab2a3dcc25e9521db23308cfe00d196659565949c100b5592e4aa74',
    cloud: 'c0904ef24803fe45b4bad6c3a47ace38eb39e33c6531dd427ae1b7a9da3b8848',
  };
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  eq('既定のスクリプトは変更前と同じ（ループバック）', h(GW.agentJs(ACC.accessConfig({}))), GOLD.default);
  eq('既定のスクリプトは変更前と同じ（転送ホストを許した設定）', h(GW.agentJs(ACC.accessConfig({ VCIDE_ALLOWED_HOSTS: 'ide.cloud.test', VCIDE_PREVIEW_ORIGIN: 'http://preview.cloud.test' }))), GOLD.cloud);
  eq('editSync: false を明示しても同じ', h(GW.agentJs(ACC.accessConfig({}), { editSync: false })), GOLD.default);
  const e = GW.agentJs(ACC.accessConfig({}), { editSync: true });
  ok('editSync のスクリプトは構文として正しい', (() => { try { new Function(e); return true; } catch { return false; } })());
  ok('editSync のスクリプトは edit-observe に答え、RSC の要求に文書の識別子を載せる', e.includes("x.kind === 'edit-observe'") && e.includes("'x-vcide-doc'"));
  eq('探索の版は 3 のまま', P.PROTOCOL_VERSION, 3);
  const n = 'nonce-hhhhhhhhhhhhhhhh';
  eq('探索の parseAgentMessage は編集の知らせを受けない（知らない種類として捨てる）',
    P.parseAgentMessage({ source: 'vcide-preview', v: 3, kind: 'edit-observation', ev: 1, nonce: n, req: 1 }, n), null);
  const s = selAt(CARD, 'p-4 md:p-6');
  ok('探索の select の知らせは今までどおり受ける', !!P.parseAgentMessage({ source: 'vcide-preview', v: 3, kind: 'select', nonce: n, seq: 1, selection: s, doc: D3, soft: false }, n));
  eq('探索の select の知らせに編集の項目を足すと受けない（形を広げていない）',
    P.parseAgentMessage({ source: 'vcide-preview', v: 3, kind: 'select', nonce: n, seq: 1, selection: s, doc: D3, soft: false, rect: {} }, n), null);
});

/* ============================================================ 中継（実物）: 文書の識別子の名乗りの扱い */
console.log('\n中継（製品の PreviewGateway）: RSC の要求の文書の識別子');
await guard('gateway', async () => {
  const seen = [];
  const up = http.createServer((q, s) => {
    seen.push({ url: q.url, headers: q.headers });
    if (q.headers.rsc === '1') { s.writeHead(200, { 'content-type': 'text/x-component' }); s.end('0:[]'); return; }
    s.writeHead(200, { 'content-type': 'text/html' }); s.end('<html><head></head><body>x</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const run = async (editSync) => {
    const recs = [];
    const gw = new GW.PreviewGateway({ config: ACC.accessConfig({}), port: await freePort(3600), editSync,
      target: () => ({ target: { port: up.address().port, run: 'gw-run' }, reason: '' }), observer: { record: (r, rec, meta) => recs.push({ rec, meta }), excludeStatic() {} } });
    const info = await gw.ensure();
    const get = (pth, headers) => new Promise((res) => {
      http.get({ host: '127.0.0.1', port: info.port, path: pth, headers: { host: `127.0.0.1:${info.port}`, ...headers } }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res(b)); });
    });
    const tok = hex(16);
    await get('/x?_rsc=1', { rsc: '1', 'x-vcide-doc': tok });
    await get('/x', { 'x-vcide-doc': tok, 'sec-fetch-dest': 'empty' });
    await get('/y?_rsc=2', { rsc: '1', 'x-vcide-doc': 'not-a-token' });
    const html = await get('/doc', { 'sec-fetch-dest': 'document' });
    const js = await (await fetch(`http://127.0.0.1:${info.port}/__vcide_preview/agent.js`)).text();
    await new Promise((r) => setTimeout(r, 50));
    await gw.close();
    return { recs, tok, html, js };
  };
  seen.length = 0;
  const on = await run(true);
  eq('editSync: RSC の要求の名乗りを initiatorDoc として記録する', on.recs.find((x) => x.rec.path === '/x' && x.rec.kind === 'rsc')?.meta?.initiatorDoc, on.tok);
  ok('editSync: RSC でない要求の名乗りは記録しない', !on.recs.find((x) => x.rec.path === '/x' && x.rec.kind !== 'rsc')?.meta?.initiatorDoc);
  ok('editSync: 形の違う名乗りは記録しない', !on.recs.find((x) => x.rec.path === '/y')?.meta?.initiatorDoc);
  ok('名乗りのヘッダは開発サーバーへ渡さない', seen.every((s) => !('x-vcide-doc' in s.headers)), seen.map((s) => Object.keys(s.headers)));
  ok('editSync: 配るスクリプトは編集の知らせを含む', on.js.includes('edit-observe'));
  seen.length = 0;
  const off = await run(false);
  ok('editSync なし: 名乗りを記録しない', off.recs.every((x) => !x.meta?.initiatorDoc));
  ok('editSync なし: 名乗りのヘッダは開発サーバーへ渡さない', seen.every((s) => !('x-vcide-doc' in s.headers)));
  eq('editSync なし: 配るスクリプトは変更前と同じ', crypto.createHash('sha256').update(off.js).digest('hex'), 'ee107cbb6ab2a3dcc25e9521db23308cfe00d196659565949c100b5592e4aa74');
  up.close();
});

/* ============================================================ 台帳と探索の観測の並置 */
console.log('\n台帳（teeObserver）: 探索の観測の記録を変えない');
guard('tee', () => {
  const a = []; const L = new LG.EditRelayLedger();
  const first = { record: (r, rec, meta) => a.push(JSON.stringify([r, rec, meta])), excludeStatic: () => a.push('static') };
  const tee = LG.teeObserver(first, L);
  const rec = { method: 'GET', path: '/', hasQuery: false, kind: 'document', status: 200, startMs: 1, durationMs: 1, trace: null, failure: null };
  tee.record('r', rec, { docToken: D3 }); tee.excludeStatic('r');
  eq('探索の観測は同じ引数で受ける', a[0], JSON.stringify(['r', rec, { docToken: D3 }]));
  eq('台帳にも入る', L.view('r').documents.length, 1);
  const boom = LG.teeObserver(first, { record() { throw new Error('x'); }, excludeStatic() { throw new Error('x'); } });
  let threw = false; try { boom.record('r', rec, {}); boom.excludeStatic('r'); } catch { threw = true; }
  ok('台帳の失敗は探索の記録を止めない（例外を外へ出さない）', !threw && a.length === 4, a.length);
});

p.cleanup();
C.finish();
