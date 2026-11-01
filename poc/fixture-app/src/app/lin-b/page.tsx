/* =============================================================================
 * PoC-04 ケース B — **props の受け渡しと別名**。
 *
 * 2種類の別名を置く。
 *   b-label / b-tier  **props の別名**（code → label → text、plan → tier）
 *                     page → LinBCard → LinBLabel の多段
 *   b-sqlalias        **SQL の別名**（SELECT code AS listing_code）
 *                     行オブジェクトの鍵は別名のほうであり、由来の列は別名の下にある
 *                     （01b Q-04.2 C-2。ORM の @map も同じ構図である）
 *
 * 子のファイルだけを見ても由来は分からない。
 * ========================================================================== */
import LinBCard from '../../components/lin/LinBCard';
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function LinB() {
  const r = await pool.query('SELECT id, code, plan FROM poc.listings ORDER BY id LIMIT 2');
  const al = await pool.query('SELECT code AS listing_code FROM poc.listings ORDER BY id LIMIT 1');
  return (
    <main className="lin-b">
      <h1>ケースB props の受け渡し</h1>
      {r.rows.map((row: { id: number; code: string; plan: string }) => (
        <LinBCard key={row.id} label={row.code} tier={row.plan} />
      ))}
      <span data-poc-field="b-sqlalias">{al.rows[0].listing_code}</span>
    </main>
  );
}
