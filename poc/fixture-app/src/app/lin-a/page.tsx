/* =============================================================================
 * PoC-04 ケース A — **単純な直接対応**。
 *
 * SQL で取得した region を、同じ Server Component の JSX がそのまま描く。
 * 加工も受け渡しも分岐も無い、いちばん易しい題材である（01b Q-04.3 難易度1）。
 * ========================================================================== */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function LinA() {
  const r = await pool.query('SELECT id, region FROM poc.listings ORDER BY id LIMIT 3');
  return (
    <main className="lin-a">
      <h1>ケースA 直接対応</h1>
      <ul>
        {r.rows.map((row: { id: number; region: string }) => (
          <li key={row.id} data-poc-field="a-region">{row.region}</li>
        ))}
      </ul>
    </main>
  );
}
