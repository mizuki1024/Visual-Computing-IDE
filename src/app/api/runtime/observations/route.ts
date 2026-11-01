/* =============================================================================
 * いまの起動で観測した HTTP・サーバー処理・SQL を返す（Phase 7B-3A）。
 *
 * 要求は「どの起動のページを見ているか」（instance・PID・開始時刻）を持つ。いまの起動と
 * 一致しなければ **観測を返さない**（`observation: null` と理由。起動をまたいで混ぜない）。
 * 停止中・異常終了後も同じ（停止後に実測中であるかのように見せない）。
 *
 * 状態は 200 で返す（7B-2 の選択の解決は 409）。画面はこの API を一定間隔で取りに来るので、
 * 停止・再起動の直後に前の起動の鍵で届くのは**正常な行き違い**である。4xx にすると
 * ブラウザが IDE の画面の console にエラーとして記録する（7B-1 の E2E が検出した）。
 *
 * 返すのは中継が転送した通信と、そのトレースに属するスパン・SQL の構文解析だけである。
 * ヘッダの一覧・本文・Cookie・SQL のパラメータ値は、台帳にも収集ファイルにも入っていない。
 * 入口の検査は変更操作と同じ（POST + JSON + 独自ヘッダ + 同一オリジン）。
 * ========================================================================== */
import { body, handle, json } from '@/server/apiShared';
import { collectCurrent } from '@/server/liveCollect';
import { parseRunKey } from '@/lib/previewProtocol';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(req, true, async () => {
    const b = await body(req);
    const run = parseRunKey(b?.run);
    if (!b || !run) {
      return json({ error: { code: 'bad-request', message: '起動の指定の形が正しくありません。' } }, 400);
    }
    const r = await collectCurrent(run);
    if (!r.ok) return json({ observation: null, stale: { code: r.code, message: r.message } });
    return json({ observation: r.observation });
  });
}
