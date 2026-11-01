/* =============================================================================
 * PoC-04 ケース G — **否定例**。
 *
 * SQL は実行する。その結果は**どの表示値にも使わない**。
 * 同じコンポーネントの中に SQL と表示値が同居しているが、両者は無関係である。
 *
 *   g-env      環境変数由来                         → 由来は DB ではない
 *   g-literal  JSX に直書き                          → 由来は無い
 *   g-computed 定数の計算                            → 由来は無い
 *   g-shadow   **SQL の列と同じ名前の局所変数**      → 名前が一致するだけの罠
 *
 * ここで候補を出したら誤対応である。**本PoCの最重要条件はこのページで測る。**
 * ========================================================================== */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function LinG() {
  await pool.query('SELECT code, region FROM poc.listings ORDER BY id LIMIT 1');
  const region = '表示用の固定ラベル';
  const label = process.env.POC04_LABEL ?? '環境由来';
  return (
    <main className="lin-g">
      <h1>ケースG 否定例</h1>
      <p data-poc-field="g-env">{label}</p>
      <p data-poc-field="g-literal">固定の見出し</p>
      <p data-poc-field="g-computed">{String(2026 - 1991)}</p>
      <p data-poc-field="g-shadow">{region}</p>
    </main>
  );
}
