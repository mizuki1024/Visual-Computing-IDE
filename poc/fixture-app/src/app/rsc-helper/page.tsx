/* =============================================================================
 * PoC-02 Gate B 5/5 — **Server Component に帰属できない SQL**。
 *
 * SQL を実行するのはモジュール直下の普通の関数であり、コンポーネントではない。
 * 「囲んでいるコンポーネント」が決まらないので、**帰属を作らないのが正解**である。
 * ========================================================================== */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

/** コンポーネントではない。名前も PascalCase にしていない */
async function loadScaleCounts() {
  const r = await pool.query('SELECT scale, count(*) AS n FROM poc.listings GROUP BY scale');
  return r.rowCount ?? 0;
}

export default async function RscHelper() {
  const n = await loadScaleCounts();
  return (
    <main className="rsc-helper">
      <h1>関数の中のSQL</h1>
      <p data-poc-field="n">{String(n)}</p>
    </main>
  );
}
