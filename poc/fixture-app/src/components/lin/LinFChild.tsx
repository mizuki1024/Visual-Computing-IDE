/* PoC-04 ケース F — 子の Server Component。**自分で取得して自分で描く。**
 * 親の SQL と混同してはいけない（親は poc.listings、ここは poc.regions）。
 *
 * 加工なしの表示（f-child）と、型変換を1つ通した表示（f-child-cast）を並べる。
 * 前者は確定できる。後者は**加工として扱うため確定にしない** — その差を測る。 */
import { pool } from '../../lib/db';

export default async function LinFChild() {
  const r = await pool.query('SELECT name FROM poc.regions ORDER BY id LIMIT 1');
  const row = r.rows[0];
  return (
    <span className="lin-f-child">
      <b data-poc-field="f-child">{row.name}</b>
      <i data-poc-field="f-child-cast">{String(row.name)}</i>
    </span>
  );
}
