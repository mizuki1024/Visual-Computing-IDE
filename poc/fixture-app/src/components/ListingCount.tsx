/* PoC-02 Gate B — 子の Server Component。ページ本体と**同じ SQL** を実行する。
 * 'use client' を付けない。サーバーで描かれ、サーバーで DB を読む。 */
import { pool } from '../lib/db';

export default async function ListingCount() {
  const r = await pool.query('SELECT count(*) AS n FROM poc.listings');
  return <span className="child-count" data-poc-field="child">{String(r.rows[0].n)}</span>;
}
