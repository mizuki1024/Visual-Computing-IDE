/* =============================================================================
 * PoC-04 ケース C — **値の加工**。
 *
 * 連結・関数呼び出し・プロパティ参照を通した値を描く。
 * **由来のカラムは言えても、「この表示値がそのカラムである」とは言えない。**
 * 候補として出すことと、確定として出すことを分ける題材である。
 * ========================================================================== */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function LinC() {
  const r = await pool.query('SELECT id, code, region FROM poc.listings ORDER BY id LIMIT 2');
  const row = r.rows[0];
  const title = `${row.region} / ${row.code}`;          // 2カラムの連結
  const upper = String(row.code).toUpperCase();         // 1カラムに関数を2段
  return (
    <main className="lin-c">
      <h1>ケースC 値の加工</h1>
      <p data-poc-field="c-title">{title}</p>
      <p data-poc-field="c-upper">{upper}</p>
      <p data-poc-field="c-len">{row.code.length}</p>
    </main>
  );
}
