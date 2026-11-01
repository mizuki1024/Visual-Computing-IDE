/* =============================================================================
 * PoC-02 Gate B 1/5 — **Server Component がサーバー内部で直接 DB を読む**。
 *
 * API ルートを経由しない。ブラウザから見える通信は文書の取得1件だけであり、
 * その内部に SQL が1本だけ入っている。**API ノードは存在しない**（01b Q-02 C-1）。
 * ========================================================================== */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function RscDb() {
  const r = await pool.query('SELECT id, code, plan FROM poc.listings ORDER BY id LIMIT 6');
  return (
    <main className="rsc-db">
      <h1>直読み（1本）</h1>
      <p className="note">Server Component が API を経由せずに DB を読んでいる。</p>
      <ul>
        {r.rows.map((row: { id: number; code: string }) => (
          <li key={row.id} data-poc-field="code">{row.code}</li>
        ))}
      </ul>
    </main>
  );
}
