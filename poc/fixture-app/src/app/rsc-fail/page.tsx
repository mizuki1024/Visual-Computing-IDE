/* =============================================================================
 * PoC-02 Gate B 4/5 — **SQL と通信の失敗**。
 *
 * 1本目: 存在しないテーブルへの SELECT（SQL の失敗）
 * 2本目: 開いていないポートへの fetch（サーバー内部通信の失敗）
 * どちらも捕まえてページは描き切る。**失敗したこと**が観測できるかを見る。
 * ========================================================================== */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

const DEAD = process.env.POC02_DEAD_ORIGIN ?? 'http://127.0.0.1:3399';

export default async function RscFail() {
  let sqlError = false;
  try {
    await pool.query('SELECT id FROM poc.table_that_does_not_exist');
  } catch {
    sqlError = true;
  }
  let fetchError = false;
  try {
    await fetch(`${DEAD}/echo`, { cache: 'no-store' });
  } catch {
    fetchError = true;
  }
  return (
    <main className="rsc-fail">
      <h1>失敗</h1>
      <p data-poc-field="sql">{sqlError ? 'sql-failed' : 'sql-ok'}</p>
      <p data-poc-field="fetch">{fetchError ? 'fetch-failed' : 'fetch-ok'}</p>
    </main>
  );
}
