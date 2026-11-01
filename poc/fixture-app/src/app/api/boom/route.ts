/* PoC-05 題材 — **失敗したリクエスト**。意図的に例外を投げて 500 を出す。
 * 本文に意味のある値を入れない（収集禁止項目を作らないため）。 */
export async function GET() {
  throw new Error('intentional failure for PoC-05');
}
