/* =============================================================================
 * PoC-04 補助ケース X — **不完全なソース解析**。
 *
 * ソースだけでは列構成が決まらない3つを置く。
 *   x-dynamic  SQL をソース上で組み立てる（リテラルが無い）
 *              → **実測された SQL 文**があれば列は分かる（01b Q-04.2 C-7）
 *   x-star     SELECT *                 → 列を特定できない。候補を出さない
 *   x-outside  解析範囲の外のモジュール由来 → 候補を出さない
 *
 * 本ケースはケースA〜Gの数には含めない。解析が欠けたときの挙動を測るためにある。
 * ========================================================================== */
import { pool } from '../../lib/db';
import { outsideLabel } from '../../../vendor-ui/index.js';

export const dynamic = 'force-dynamic';

const LIMIT = 2;

export default async function LinX() {
  const dyn = await pool.query(`SELECT id, code FROM poc.listings ORDER BY id LIMIT ${LIMIT}`);
  const star = await pool.query('SELECT * FROM poc.regions ORDER BY id LIMIT 1');
  return (
    <main className="lin-x">
      <h1>補助ケースX 不完全な解析</h1>
      <p data-poc-field="x-dynamic">{dyn.rows[0].code}</p>
      <p data-poc-field="x-star">{String(star.rows[0].name)}</p>
      <p data-poc-field="x-outside">{outsideLabel()}</p>
    </main>
  );
}
