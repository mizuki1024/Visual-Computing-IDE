/* SQL発行箇所 4/5, 5/5 — 素の pg と、Prisma の生SQL。
 * ORM計装とドライバ計装の双方がフックできるかを比べるために、わざと2経路にする。 */
import { NextResponse } from 'next/server';
import { pool, prisma } from '@/lib/db';

export async function GET() {
  const byRegion = await pool.query(
    'SELECT region, count(*) AS n FROM poc.listings GROUP BY region ORDER BY region',
  );
  const scales = await prisma.$queryRaw<{ scale: string; n: bigint }[]>`
    SELECT scale, count(*) AS n FROM poc.listings GROUP BY scale ORDER BY scale
  `;
  return NextResponse.json({
    byRegion: byRegion.rows.map((r) => ({ region: r.region, n: Number(r.n) })),
    scales: scales.map((r) => ({ scale: r.scale, n: Number(r.n) })),
  });
}
