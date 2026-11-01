/* =============================================================================
 * PoC-04 ケース E — **条件分岐**。
 *
 * 3種類の分岐を置く。
 *   e-either   条件によって**別のカラム**を描く        → 候補は2件。1つに絞れない
 *   e-orconst  カラム または **固定値** を描く          → 候補1件 + 固定値の可能性
 *   e-inline   条件の判定にはカラムを使うが、**描くのは固定値だけ** → 由来は無い
 *
 * e-inline が本ケースの要点である。条件式に現れた列を表示値の由来にすると
 * **誤対応になる。** 分岐の判定に使った列は、表示値の由来ではない。
 * ========================================================================== */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function LinE() {
  const r = await pool.query('SELECT id, code, region, plan FROM poc.listings ORDER BY id LIMIT 2');
  const row = r.rows[0];
  const either = row.plan === '標準プラン' ? row.region : row.code;
  const orConst = row.region ? row.region : '未設定';
  return (
    <main className="lin-e">
      <h1>ケースE 条件分岐</h1>
      <p data-poc-field="e-either">{either}</p>
      <p data-poc-field="e-orconst">{orConst}</p>
      <p data-poc-field="e-inline">{row.plan === '標準プラン' ? '標準' : '拡張'}</p>
    </main>
  );
}
