/* =============================================================================
 * PoC-02 Gate B 3/5 — **同じ SQL を複数箇所から実行する**。
 *
 * ページ本体と子の Server Component（別ファイル）が、**まったく同じ SQL 文**を
 * 実行する。SQL 文の一致で対応付けると取り違える題材である。
 * ========================================================================== */
import ListingCount from '../../components/ListingCount';
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function RscDup() {
  const r = await pool.query('SELECT count(*) AS n FROM poc.listings');
  return (
    <main className="rsc-dup">
      <h1>同じSQLを2箇所から</h1>
      <p data-poc-field="page">{String(r.rows[0].n)}</p>
      <ListingCount />
    </main>
  );
}
