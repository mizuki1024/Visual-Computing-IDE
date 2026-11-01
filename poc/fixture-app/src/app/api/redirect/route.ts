/* PoC-05 題材 — **リダイレクト**。307 で /api/listings へ送る。
 * 1回の fetch に対して応答が2つ返る（307 と 200）。段ごとに別のスパンになる。 */
import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  return NextResponse.redirect(new URL('/api/listings', req.url), 307);
}
