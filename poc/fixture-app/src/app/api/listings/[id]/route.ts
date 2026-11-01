/* SQL発行箇所 2/5, 3/5 — findUnique と、別テーブルの集計。 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const n = Number(id);
  const listing = await prisma.listing.findUnique({
    where: { id: n },
    select: { id: true, code: true, region: true, plan: true, scale: true },
  });
  const views = await prisma.listingView.aggregate({
    where: { listingId: n },
    _sum: { views: true },
  });
  if (!listing) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ listing, views: views._sum.views ?? 0 });
}
