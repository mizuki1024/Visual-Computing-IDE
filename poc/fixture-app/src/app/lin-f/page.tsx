/* =============================================================================
 * PoC-04 ケース F — **RSC 直接取得**。
 *
 * 同じコンポーネントが取得して描く（f-own）のと、
 * **子の Server Component が自分で取得して自分で描く**（f-child）のを1枚に置く。
 * 1ページに2本の SQL があり、**取り違えてはいけない**。
 * ブラウザから見える API 通信は 0 件である（rsc-direct）。
 * ========================================================================== */
import LinFChild from '../../components/lin/LinFChild';
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function LinF() {
  const r = await pool.query('SELECT id, code FROM poc.listings ORDER BY id LIMIT 2');
  const row = r.rows[0];
  return (
    <main className="lin-f">
      <h1>ケースF RSC 直接取得</h1>
      <p data-poc-field="f-own">{row.code}</p>
      <LinFChild />
    </main>
  );
}
