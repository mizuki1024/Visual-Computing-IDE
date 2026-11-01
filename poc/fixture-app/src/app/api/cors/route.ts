/* PoC-05 題材 — **クロスオリジン**での識別子の見え方を測るための応答。
 * Access-Control-Allow-Origin だけを付け、Timing-Allow-Origin は付けない。
 * ブラウザがどこまで Server-Timing を読めるかを、この差で測る。 */
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ ok: true }, {
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
}
