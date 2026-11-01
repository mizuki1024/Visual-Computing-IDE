/* SQL発行箇所 1/5 — Prisma の findMany。射影する列を明示する。 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
  const rows = await prisma.listing.findMany({
    select: { id: true, code: true, region: true },
    orderBy: { id: 'asc' },
    take: 12,
  });
  return NextResponse.json({ listings: rows });
}
