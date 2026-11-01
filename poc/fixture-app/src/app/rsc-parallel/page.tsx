/* =============================================================================
 * PoC-02 Gate B 2/5 — **複数の並列データ取得**。
 *
 * 3本の SQL を Promise.all で同時に投げる。3本は**別々の行**に書いてある。
 * スパンの時間区間は重なる（01b Q-02 C-2）。
 * ========================================================================== */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function RscParallel() {
  const [a, b, c] = await Promise.all([
    pool.query('SELECT count(*) AS n FROM poc.listings'),
    pool.query('SELECT count(*) AS n FROM poc.regions'),
    pool.query('SELECT count(*) AS n FROM poc.listing_views'),
  ]);
  return (
    <main className="rsc-parallel">
      <h1>並列（3本）</h1>
      <ul>
        <li data-poc-field="n1">{String(a.rows[0].n)}</li>
        <li data-poc-field="n2">{String(b.rows[0].n)}</li>
        <li data-poc-field="n3">{String(c.rows[0].n)}</li>
      </ul>
    </main>
  );
}
