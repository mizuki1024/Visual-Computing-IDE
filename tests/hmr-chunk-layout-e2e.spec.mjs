/* =============================================================================
 * 7C HMR — **第3の経路**の回帰試験（安全対策の実装中に見つけた。案A の A1〜A3 では止まらないことを実測した）。
 *
 *   npm run build && npm run build:lib
 *   PW_CHANNEL=none [SHOTS=<dir>] [RESULTS=<json>] node tests/hmr-chunk-layout-e2e.spec.mjs
 *
 * Turbopack は1つの生成物（.next/dev/server/chunks/ssr/*.js）に複数のモジュールを連結する。
 * /hmr-s では page.tsx（先）と子の SA.tsx（後）が同じ生成物に入る。
 * **page.tsx だけ**を変えると、server fast refresh は page のモジュールだけを eval し直し、SA は
 * 前に読み込んだ生成物のコード（古い配置の行）のまま実行される。一方ディスクの生成物は書き直され、
 * SA の区画は後ろへずれる。古い行を新しいソースマップで戻すと、SA の中の別の行に当たる。
 *   A1: SA のフレームは eval ではない（ディスクから読んだコード）→ 印が付かない
 *   A2: 2回目以降の要求では、生成物の更新は要求の開始より前 → 通る
 *   A3: SA.tsx は変えていない → 区画の sourcesContent はいまのソースと一致 → 通る
 * この試験は「誤ったカラム（poc.regions.name）を値 a の由来として出さない」を確かめる。
 * **案A の実装の後も失敗する（未解決）**ことを、隠さずに記録するための試験である。
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

const PAGE = 'src/app/hmr-s/page.tsx';
const SA = 'src/components/SA.tsx';
const FILES = {
  [PAGE]: `/* HMR 試験の題材: 子の Server Component（SA）が同じ生成物の後ろに入る */
import SA from '../../components/SA';
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function HmrS() {
  const p = await pool.query('SELECT id, plan FROM poc.listings ORDER BY id LIMIT 1');
  return (
    <main className="hmr-s">
      <p data-poc-field="s-plan">{p.rows[0].plan}</p>
      <SA />
    </main>
  );
}
`,
  [SA]: `/* HMR 試験の題材: 子の Server Component に SQL が2つ（a と b の生成物の行の差 = page を伸ばす行数） */
import { pool } from '../lib/db';

export default async function SA() {
  const a = await pool.query('SELECT id, region FROM poc.listings ORDER BY id DESC LIMIT 1');
  const n1 = a.rows.length;
  const n2 = n1 + 1;
  const n3 = n2 + 1;
  const n4 = n3 + 1;
  const n5 = n4 + 1;
  const n6 = n5 + 1;
  const b = await pool.query('SELECT id, name AS region FROM poc.regions ORDER BY id LIMIT 1');
  return (
    <div className="sa">
      <p data-poc-field="s-a">{a.rows[0].region}</p>
      <p data-poc-field="s-b">{b.rows[0].region}{String(n6)}</p>
    </div>
  );
}
`,
};
const NEEDLE_A = "'SELECT id, region FROM poc.listings";
const NEEDLE_B = "'SELECT id, name AS region FROM poc.regions";
const TRUE_COL = 'poc.listings.region';
const WRONG_COL = 'poc.regions.name';
const EL = 'p[data-poc-field="s-a"]';

const H = await startHarness({ name: 'hmr-chunk-layout-e2e', files: FILES, shots: SHOTS, portBase: 4000 });
const out = { startedAt: new Date().toISOString(), phases: {} };
const isWrong = (s) => s.lineage === 'linked' && (s.cands ?? '').includes(WRONG_COL);
const record = (key, s) => {
  const v = isWrong(s) ? `WRONG（${WRONG_COL}）` : s.lineage === 'linked' && s.cands === TRUE_COL ? 'correct' : `cut（${s.lineageReason ?? '-'}）`;
  out.phases[key] = { verdict: v, lineage: s.lineage, reason: s.lineageReason, cands: s.cands, dockOrigin: s.dockOrigin, dataAccess: s.response?.dataAccess ?? [] };
  note(`${key}: ${v} / 右ドック「${s.dockOrigin ?? '（この値の出所なし）'}」`);
  for (const x of s.response?.dataAccess ?? []) note(`  SQL「${x.sql.slice(0, 44)}」 呼び出し位置 ${x.site ?? '-'}${x.failure ? ` / ${x.failure}` : ''}`);
  return v;
};

try {
  const db = await H.dbReachable();
  ok('前提: 題材の DB（使い捨ての PostgreSQL）に届く', db === null, db);
  console.log('\n0. 使い捨ての題材を起動する');
  await H.startProject();
  const T = { el: H.elOf(SA, 's-a'), callA: H.callOf(SA, NEEDLE_A), callB: H.callOf(SA, NEEDLE_B) };
  out.truth = T;

  console.log('\n1. 基準: 読み込み直した文書で SA の値 a を選ぶ');
  await H.gotoPath('/hmr-s');
  /* 初回のコンパイルは要求の中で生成物を書くので、その文書と、書き込みから A2 の幅（2 秒）以内の文書は未観測になる。幅を空けて読み込み直す */
  await sleep(2500);
  await H.gotoPath('/hmr-s');
  const s1 = await H.pick(EL, { want: 'linked' });
  record('1-baseline', s1);
  eq('1 基準: 正しく結ぶ（poc.listings.region・取得位置は SA の SQL a）', [s1.lineage, s1.cands, s1.response?.fetch], ['linked', TRUE_COL, T.callA]);

  console.log('\n2. page.tsx だけを変える（SQL より前へ 7 文）。SA.tsx は変えない → 読み込み直して SA の値 a を選び直す');
  H.put(PAGE, H.srcOf(PAGE).replace('export default async function HmrS() {\n',
    `export default async function HmrS() {\n${Array.from({ length: 7 }, (_, i) => `  const z${i} = ${i};\n`).join('')}`));
  await sleep(3500);
  for (const k of ['2a 変更の後の1回目の読み込み', '2b 変更の後の2回目の読み込み']) {
    await H.gotoPath('/hmr-s');
    const s = await H.pick(EL);
    const v = record(k, s);
    eq(`${k} 前提: 選択は SA.tsx の <p>（SA.tsx は変えていないので F-01 は通る）`, [s.selection, s.at], ['resolved', T.el]);
    const da = s.response?.dataAccess ?? [];
    ok(`${k}: 【第3の経路】SA の SQL b を SA の SQL a の位置に対応させない`, !da.some((d) => d.sql.startsWith(NEEDLE_B.slice(1)) && d.site === T.callA), da);
    ok(`${k}: 【第3の経路】${WRONG_COL} を値 a の由来として出さない`, !isWrong(s), v);
    ok(`${k}: 【第3の経路】右ドックに「この値の出所 ${WRONG_COL}」を出さない`, !(s.dockOrigin ?? '').includes('poc.regions'), s.dockOrigin);
    await H.shot(`chunk-layout-${k.slice(0, 2)}`);
  }

  console.log('\n3. 開発サーバーを起動し直す');
  await H.restartDev();
  await H.gotoPath('/hmr-s');
  await sleep(2500);
  await H.gotoPath('/hmr-s');
  const s3 = await H.pick(EL, { want: 'linked' });
  record('3-after-restart', s3);
  eq('3: 再起動の後は正しい由来に戻る', [s3.lineage, s3.cands, s3.response?.fetch], ['linked', TRUE_COL, T.callA]);
  ok('画面にエラーが出ていない', H.ideErrors.length === 0, H.ideErrors);
} catch (e) {
  R.fails.push(`例外: ${e?.stack ?? e}`);
  console.log(`  ✗ 例外: ${e?.stack ?? e}`);
} finally {
  await H.cleanup(R);
}
out.finishedAt = new Date().toISOString();
out.pass = R.pass; out.fail = R.fails.length; out.items = R.log;
if (RESULTS) { fs.mkdirSync(path.dirname(RESULTS), { recursive: true }); fs.writeFileSync(RESULTS, `${JSON.stringify(out, null, 2)}\n`); }
console.log(`\n判定: ${Object.entries(out.phases).map(([k, v]) => `${k}=${v.verdict}`).join(' / ')}`);
console.log(`${R.fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${R.pass} 件通過 / ${R.fails.length} 件失敗`);
for (const f of R.fails) console.log(`  ✗ ${f}`);
process.exit(R.fails.length ? 1 : 0);
