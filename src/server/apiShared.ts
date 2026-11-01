/* =============================================================================
 * ルートハンドラの共通部分。例外を素のまま返さず、必ず形の決まった JSON にする
 * （ER-01 無反応を作らない）。
 * ========================================================================== */
import { guardRequest, type GuardFailure } from './guard';

/** ブラウザへ返す JSON。キャッシュさせない。 */
export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

export const guardFail = (f: GuardFailure): Response =>
  json({ error: { code: f.code, message: f.message } }, f.status);

/** 入口の検査を通したうえで処理を呼ぶ。例外は 500 の JSON にする。 */
export async function handle(
  req: Request, mutating: boolean, run: () => Promise<Response>,
): Promise<Response> {
  const bad = guardRequest(req, { mutating });
  if (bad) return guardFail(bad);
  try {
    return await run();
  } catch (e) {
    return json({
      error: {
        code: 'internal-error',
        message: e instanceof Error ? e.message : String(e),
      },
    }, 500);
  }
}

/** 本文の読み取り。壊れた JSON を 400 で返す。 */
export async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' ? v as Record<string, unknown> : null;
  } catch { return null; }
}
