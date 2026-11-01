/* =============================================================================
 * PoC-04 ケース D — **複数候補**。
 *
 * 1本の SQL が同じ型の列を4つ取り、表示側は**動的なキー**で引く。
 * どの列かはソースから決まらない。**1つに絞ってはいけない**題材である。
 *
 * あわせて **同名変数**（別スコープの `row` が別の SQL に属する）を置く。
 * 名前の一致で対応づけると取り違える。
 * ========================================================================== */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

const FIELDS = ['region', 'plan', 'scale'];

export default async function LinD() {
  const wide = await pool.query('SELECT code, region, plan, scale FROM poc.listings ORDER BY id LIMIT 1');
  const bag = wide.rows[0];
  const a = await pool.query('SELECT code FROM poc.listings ORDER BY id LIMIT 1');
  const b = await pool.query('SELECT name FROM poc.regions ORDER BY id LIMIT 1');
  return (
    <main className="lin-d">
      <h1>ケースD 複数候補</h1>
      <ul>
        {FIELDS.map((f) => (
          <li key={f} data-poc-field="d-dynamic">{String(bag[f])}</li>
        ))}
      </ul>
      <ul>
        {a.rows.map((row: { code: string }) => (
          <li key={row.code} data-poc-field="d-same-name-a">{row.code}</li>
        ))}
      </ul>
      <ul>
        {b.rows.map((row: { name: string }) => (
          <li key={row.name} data-poc-field="d-same-name-b">{row.name}</li>
        ))}
      </ul>
    </main>
  );
}
