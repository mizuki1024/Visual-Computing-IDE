/* =============================================================================
 * 7C HMR 後のリネージ誤対応の安全対策（案A: A1＋A2＋A3）— 実ブラウザでの回帰試験。
 *
 *   npm run build && npm run build:lib
 *   PW_CHANNEL=none [SHOTS=<dir>] [RESULTS=<json>] node tests/hmr-lineage-guard-e2e.spec.mjs
 *
 * 実ブラウザ・実際の IDE（next start）・実際の開発サーバー（Turbopack・server fast refresh は既定のまま。
 * --no-server-fast-refresh は付けない）・実際の HMR・実 DB。題材は使い捨てのコピーに一時的なページを足したもの。
 *
 *   T0 初回のコンパイル（記録）と、読み込み直した後の基準（正しく結ぶ）
 *   T3 無関係なファイル・共有の lib/db.ts の変更: 正しく確かめられる SQL の由来を保つ
 *   T1 HMR の後の誤ったカラム: 同じコンポーネントの SQL a・b。HMR の後に SQL b を a の位置へ戻してしまう配置
 *      → poc.regions.name を値 a の由来として出さない。観測画面（キャンバス）にも誤った呼び出し位置を出さない
 *   T4 同じモジュールを続けて変更（3回）: どの回も誤対応しない。再起動で正しい由来に戻る
 *   T2 要求の処理中の変更（in-flight）: SQL a → 5 秒待つ → SQL b の要求の途中でソースを書き換える
 *      → SQL b を書き換え後のソースの a の行に対応させない。観測画面にも出さない
 *
 * 誤対応（WRONG）は失敗として数える。未観測（cut）は許容する。
 * 同じ生成物に連結された「変更していない」モジュールの位置のずれ（第3の経路）は tests/hmr-chunk-layout-e2e.spec.mjs。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { results, skipReason, startHarness, sleep } from './hmr-e2e-harness.mjs';

const skip = skipReason();
if (skip) { console.log(`\n⊘ ${skip}。全件 skip（未実行）`); process.exit(0); }
const SHOTS = process.env.SHOTS ?? null;
const RESULTS = process.env.RESULTS ?? null;
const R = results();
const { ok, eq, note } = R;

const HMR_M = 'src/app/hmr-m/page.tsx';
const HMR_R = 'src/app/hmr-r/page.tsx';
const M_SRC = `/* HMR 安全対策の試験の題材: 同じコンポーネントに SQL が2つ（a と b の生成物の行の差 = モジュールの開始のずれ） */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function HmrM() {
  const a = await pool.query('SELECT id, region FROM poc.listings ORDER BY id DESC LIMIT 1');
  const n1 = a.rows.length;
  const n2 = n1 + 1;
  const n3 = n2 + 1;
  const n4 = n3 + 1;
  const n5 = n4 + 1;
  const n6 = n5 + 1;
  const b = await pool.query('SELECT id, name AS region FROM poc.regions ORDER BY id LIMIT 1');
  return (
    <main className="hmr-m">
      <p data-poc-field="m-a">{a.rows[0].region}</p>
      <p data-poc-field="m-b">{b.rows[0].region}</p>
      <p data-poc-field="m-n">{String(n6)}</p>
    </main>
  );
}
`;
const R_SRC = `/* HMR 安全対策の試験の題材: SQL の間で待つ（要求の処理中にソースを書き換える） */
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
const NEEDLE_A = "'SELECT id, region FROM poc.listings";
const NEEDLE_B = "'SELECT id, name AS region FROM poc.regions";
const TRUE_COL = 'poc.listings.region';
const WRONG_COL = 'poc.regions.name';
const GUARD = new Set(['hmr-evaluated-code', 'changed-during-request', 'map-source-mismatch', 'map-source-unverified', 'unrecognized-frame', 'frame-origin-unverified']);

const H = await startHarness({ name: 'hmr-guard-e2e', files: { [HMR_M]: M_SRC, [HMR_R]: R_SRC }, shots: SHOTS, portBase: 3800 });
const out = { startedAt: new Date().toISOString(), phases: {} };
const EL_A = 'p[data-poc-field="m-a"]';
const isWrong = (s) => s.lineage === 'linked' && (s.cands ?? '').includes(WRONG_COL);
const verdict = (s) => (isWrong(s) ? `WRONG（${WRONG_COL}）` : s.lineage === 'linked' && s.cands === TRUE_COL ? 'correct' : `cut（${s.lineageReason ?? '-'}）`);
const record = (key, s) => {
  const r = s.response;
  out.phases[key] = { verdict: verdict(s), lineage: s.lineage, reason: s.lineageReason, cands: s.cands, docBinding: s.docBinding, dockOrigin: s.dockOrigin, dataAccess: r?.dataAccess ?? [], fetch: r?.fetch ?? null };
  note(`${key}: ${verdict(s)} / 右ドック「${s.dockOrigin ?? '（この値の出所なし）'}」`);
  for (const x of r?.dataAccess ?? []) note(`  SQL「${x.sql.slice(0, 44)}」 呼び出し位置 ${x.site ?? '-'}${x.failure ? ` / ${x.failure}` : ''}`);
};
/** 値 a の選び直し: 誤ったカラムを出していないこと（画面の属性・右ドック・キャンバスのカラムのノード） */
function noWrongShown(label, s) {
  ok(`${label}: ${WRONG_COL} を値 a の由来として出さない（パネル）`, !isWrong(s), { lineage: s.lineage, cands: s.cands });
  ok(`${label}: 右ドックに「この値の出所 ${WRONG_COL}」を出さない`, !(s.dockOrigin ?? '').includes('poc.regions'), s.dockOrigin);
  /* キャンバスのカラムのノードは、実行された SQL の SELECT 句の列として描かれる（由来ではない）ので数えない。
   * 由来の主張は、パネルの属性・右ドックの「この値の出所」・由来の評価の応答（候補）で確かめる */
  ok(`${label}: 由来の評価の応答に ${WRONG_COL} を候補として返さない`, !(s.response?.candidates ?? []).includes(WRONG_COL), s.response?.candidates);
}

try {
  const db = await H.dbReachable();
  ok('前提: 題材の DB（使い捨ての PostgreSQL）に届く', db === null, db);
  console.log('\n0. 使い捨ての題材を起動する');
  const st = await H.startProject();
  eq('前提: 計装は有効', st.runtime.instrumentation?.state, 'enabled');
  eq('前提: 要素識別子の注入は有効', st.runtime.anchors?.state, 'enabled');
  const T = { el: H.elOf(HMR_M, 'm-a'), callA: H.callOf(HMR_M, NEEDLE_A), callB: H.callOf(HMR_M, NEEDLE_B) };
  out.truth = T;

  /* ============================================ T0 */
  console.log('\nT0. 初回のコンパイルの文書（記録）→ 読み込み直した文書（基準）');
  {
    await H.gotoPath('/hmr-m');
    const s0 = await H.pick(EL_A);
    record('T0-first-compile', s0);
    noWrongShown('T0 初回のコンパイル', s0);
    await H.gotoPath('/hmr-m');
    const s = await H.pick(EL_A, { want: 'linked' });
    record('T0-baseline', s);
    eq('T0 前提: 選択の位置 = ソースの <p>', s.at, T.el);
    eq('T0 基準: 正しく結ぶ（poc.listings.region・取得位置は SQL a）', [s.lineage, s.cands, s.response?.fetch], ['linked', TRUE_COL, T.callA]);
    eq('T0 基準: この文書の SQL a・b の呼び出し位置はどちらも正しい', (s.response?.dataAccess ?? []).map((d) => d.site).sort(), [T.callA, T.callB].sort());
    await H.shot('guard-T0-baseline');
  }

  /* ============================================ T3 */
  console.log('\nT3. 無関係なファイル・共有の lib/db.ts を変更しても、正しく確かめられる由来を保つ');
  for (const [label, rel] of [['T3a 無関係なページ（listings/page.tsx）', 'src/app/listings/page.tsx'], ['T3b 共有の lib/db.ts', 'src/lib/db.ts']]) {
    H.put(rel, `${H.srcOf(rel)}\n// unrelated edit ${Date.now()}\n`);
    await sleep(3500);
    await H.gotoPath('/hmr-m');
    const s = await H.pick(EL_A, { want: 'linked' });
    record(label, s);
    eq(`${label}: 由来を保つ（poc.listings.region・取得位置は SQL a）`, [s.lineage, s.cands, s.response?.fetch], ['linked', TRUE_COL, T.callA]);
    eq(`${label}: SQL a・b の呼び出し位置を保つ`, (s.response?.dataAccess ?? []).map((d) => d.site).sort(), [T.callA, T.callB].sort());
  }

  /* ============================================ T1 */
  console.log('\nT1. 同じ起動のまま hmr-m/page.tsx の末尾にコメントだけ足す（サーバー側の HMR）→ 読み込み直して選び直す');
  {
    H.put(HMR_M, `${H.srcOf(HMR_M)}\n// comment only ${Date.now()}\n`);
    await sleep(3000);
    await H.gotoPath('/hmr-m');
    const s = await H.pick(EL_A);
    record('T1', s);
    eq('T1 前提: 選択はいまのソースの <p> に特定（F-01 は通る）', [s.selection, s.at], ['resolved', T.el]);
    eq('T1 前提: 文書は新しい要求に同定', s.docBinding, 'identified');
    noWrongShown('T1', s);
    eq('T1: 由来は結ばず、呼び出し位置を確かめられないことを理由にする（fetch-callsite-unverifiable）', [s.lineage, s.lineageReason], ['cut', 'fetch-callsite-unverifiable']);
    const da = s.response?.dataAccess ?? [];
    ok('T1: この文書の SQL を観測している（SQL そのものは観測できている）', da.length === 2, da);
    ok('T1: SQL b を SQL a の位置（誤った呼び出し位置）に対応させない', !da.some((d) => d.sql.startsWith(NEEDLE_B.slice(1)) && d.site === T.callA), da);
    ok('T1: どの SQL も呼び出し位置を作らず、理由は hmr-evaluated-code（HMR で eval されたコード）', da.length > 0 && da.every((d) => d.site === null && d.failure === 'hmr-evaluated-code'), da);
    ok('T1: 「参考の位置」も出さない（located なし）', da.every((d) => d.located === null), da);
    ok('T1: 右ドックに、コードの更新で確かめられないことと再起動の案内を出す', /更新/.test(s.dock) && /再起動/.test(s.dock), s.dock.slice(0, 400));
    await H.shot('guard-T1-after-hmr');
    const m = await H.pick('p[data-poc-field="m-b"]');
    ok('T1: 値 b も誤って結ばない（poc.listings.region を出さない）', !(m.lineage === 'linked' && (m.cands ?? '').includes(TRUE_COL)), { lineage: m.lineage, cands: m.cands });
    /* 観測画面: その文書の通信をキャンバスに描く */
    const obs = await H.obsOf();
    const seq = s.response?.exchangeSeq;
    await H.showExchange(seq);
    const labels = await H.nodeLabels();
    ok('T1 観測画面: SQL a の位置のコンポーネントのノード（誤った呼び出し位置）を描かない', !labels.some((l) => new RegExp(`${HMR_M.replace(/[/.]/g, '\\$&')}:${T.callA.split(':')[1]}(?!\\d)`).test(l ?? '')), labels);
    const rows = H.sqlRows(obs, seq);
    ok('T1 観測画面: SQL の詳細の「実行した呼び出し位置」は「特定していません」とその理由', rows.length === 2 && rows.every((r) => (r.row ?? '').startsWith('特定していません') && /更新/.test(r.row)), rows);
    out.phases.T1.canvas = { labels, rows };
    await H.shot('guard-T1-observation-canvas');
  }

  /* ============================================ T4 */
  console.log('\nT4. 同じモジュールを続けて変更する（SQL の前に1文 → SQL の SELECT 句を変える → 元に戻す）');
  {
    const steps = [
      ['T4a SQL より前に1文', () => H.put(HMR_M, H.srcOf(HMR_M).replace('export default async function HmrM() {\n', 'export default async function HmrM() {\n  const pre = 0;\n'))],
      ['T4b SQL a の SELECT 句に plan を足す', () => H.put(HMR_M, H.srcOf(HMR_M).replace("'SELECT id, region FROM poc.listings ORDER BY id DESC LIMIT 1'", "'SELECT id, region, plan FROM poc.listings ORDER BY id DESC LIMIT 1'"))],
      ['T4c 元に戻す', () => H.restore(HMR_M)],
    ];
    for (const [label, change] of steps) {
      change();
      await sleep(3000);
      await H.gotoPath('/hmr-m');
      const s = await H.pick(EL_A);
      record(label, s);
      noWrongShown(label, s);
      const da = s.response?.dataAccess ?? [];
      ok(`${label}: どの SQL にも呼び出し位置を作らない（HMR で eval されたコード）`, da.length > 0 && da.every((d) => d.site === null && GUARD.has(d.failure)), da);
    }
    console.log('  開発サーバーを起動し直す');
    await H.restartDev();
    await H.gotoPath('/hmr-m');
    await sleep(2500);   // 初回のコンパイルの書き込みから A2 の幅を空ける
    await H.gotoPath('/hmr-m');
    const s = await H.pick(EL_A, { want: 'linked' });
    record('T4 再起動の後', s);
    eq('T4: 再起動の後は正しい由来に戻る', [s.lineage, s.cands, s.response?.fetch], ['linked', TRUE_COL, H.callOf(HMR_M, NEEDLE_A)]);
  }

  /* ============================================ T2 */
  console.log('\nT2. 要求の処理中にソースを書き換える（SQL a → 5 秒待つ → SQL b）');
  {
    await H.gotoPath('/hmr-r');
    await sleep(2500);
    await H.gotoPath('/hmr-r');
    const tNav = Date.now();
    const n = await H.gotoPath('/hmr-r', { wait: false });
    await sleep(1500);
    const tEdit = Date.now();
    H.put(HMR_R, H.srcOf(HMR_R).replace('export default async function HmrR() {\n',
      `export default async function HmrR() {\n${Array.from({ length: 7 }, (_, i) => `  const z${i} = ${i};\n`).join('')}`));
    note('要求の開始の約 1.5 秒後に、SQL a より前へ 7 文を足した');
    await H.waitLoaded(n, '/hmr-r');
    await sleep(2500);
    const aNow = H.callOf(HMR_R, NEEDLE_A);
    const obs = await H.obsOf();
    /* http の転送ホストでは Sec-Fetch-Dest が来ないので種類は unknown。移動を押した後・書き換えの前に始まった /hmr-r の通信 */
    const doc = obs.exchanges.filter((e) => e.path === '/hmr-r' && e.startMs >= tNav - 200 && e.startMs < tEdit).at(0);
    ok('T2 前提: 書き換えの前に始まった文書の要求を観測した', !!doc, obs.exchanges.map((e) => `${e.seq}:${e.kind}:${e.path}`));
    const da = H.sqlOf(obs, doc?.seq);
    out.phases.T2 = { truthAfterEdit: aNow, dataAccess: da };
    for (const x of da) note(`  SQL「${x.sql.slice(0, 44)}」 呼び出し位置 ${x.site ?? '-'}${x.failure ? ` / ${x.failure}` : ''}`);
    ok('T2 前提: この要求の SQL a・b を観測した', da.length === 2, da);
    ok('T2: SQL b を、書き換え後のソースの a の行（誤った呼び出し位置）に対応させない', !da.some((d) => d.sql.startsWith(NEEDLE_B.slice(1)) && d.site === aNow), da);
    ok('T2: 取得位置を証明できない SQL は呼び出し位置を作らない（a・b とも）', da.every((d) => d.site === null), da);
    ok('T2: SQL b の理由は changed-during-request（要求の処理中の変更）', da.find((d) => d.sql.startsWith(NEEDLE_B.slice(1)))?.failure === 'changed-during-request', da);
    await H.showExchange(doc.seq);
    const labels = await H.nodeLabels();
    ok('T2 観測画面: hmr-r/page.tsx のコンポーネントのノード（呼び出し位置）を描かない', !labels.some((l) => /^コンポーネント src\/app\/hmr-r\/page\.tsx:/.test(l ?? '')), labels);
    const rows = H.sqlRows(obs, doc.seq);
    ok('T2 観測画面: SQL の詳細は「特定していません」とその理由', rows.length === 2 && rows.every((r) => (r.row ?? '').startsWith('特定していません')), rows);
    out.phases.T2.canvas = { labels, rows };
    await H.shot('guard-T2-inflight-observation-canvas');
    const s = await H.pick('p[data-poc-field="r-a"]');
    record('T2 値 a を選ぶ', s);
    noWrongShown('T2 値 a', s);
    H.restore(HMR_R);
  }
  ok('画面にエラーが出ていない', H.ideErrors.length === 0, H.ideErrors);
} catch (e) {
  R.fails.push(`例外: ${e?.stack ?? e}`);
  console.log(`  ✗ 例外: ${e?.stack ?? e}`);
} finally {
  await H.cleanup(R);
}
out.finishedAt = new Date().toISOString();
out.lineageResponses = H.linResponses;
out.pass = R.pass; out.fail = R.fails.length; out.items = R.log;
if (RESULTS) { fs.mkdirSync(path.dirname(RESULTS), { recursive: true }); fs.writeFileSync(RESULTS, `${JSON.stringify(out, null, 2)}\n`); }
console.log(`\n判定: ${Object.entries(out.phases).map(([k, v]) => `${k}=${v.verdict ?? '-'}`).join(' / ')}`);
console.log(`${R.fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${R.pass} 件通過 / ${R.fails.length} 件失敗`);
for (const f of R.fails) console.log(`  ✗ ${f}`);
process.exit(R.fails.length ? 1 : 0);
