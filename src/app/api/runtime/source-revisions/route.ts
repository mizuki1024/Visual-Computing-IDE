/* =============================================================================
 * 06h 独立レビュー F-01 — 解決済みの選択が依存するソースの、**いまの**版を返す。
 *
 * 要素識別子は位置（ファイル:行:列）だけから決まる。コードが変わると、同じ位置に別の要素が来ても
 * 識別子は同じになる。画面は選択を解決したときの版（選んだ要素のファイルと、照合に通った祖先のファイル）を
 * 覚えておき、この API で版を取り直して、違えば選択を無効にする（右ドック・キャンバスの情報も消す）。
 *
 * 受け取るもの: どの起動のページか・ファイル（注入範囲 src/ の相対パス）の一覧。
 * 返すもの: ファイルごとの版（内容のハッシュ）。内容そのものは返さない。注入範囲の外・読めないものは null。
 * 古い起動・停止中は 409（anchor の API と同じ）。変更操作と同じ入口の検査（POST + JSON + 独自ヘッダ + 同一オリジン）を通す。
 * ========================================================================== */
import { devServer } from '@/server/devServer';
import { body, handle, json } from '@/server/apiShared';
import { MAX_REVISION_FILES, sourceRevisionsOf } from '@/server/anchors';
import { pidAlive } from '@/server/net';
import { parseRunKey } from '@/lib/previewProtocol';

export const dynamic = 'force-dynamic';

const FILE_RE = /^src\/[^\0\\]{1,400}\.(tsx|jsx)$/;

export async function POST(req: Request): Promise<Response> {
  return handle(req, true, async () => {
    const b = await body(req);
    const run = parseRunKey(b?.run);
    const files = b?.files;
    const filesOk = Array.isArray(files) && files.length >= 1 && files.length <= MAX_REVISION_FILES
      && files.every((f) => typeof f === 'string' && FILE_RE.test(f));
    if (!b || !run || !filesOk || Object.keys(b).some((k) => k !== 'run' && k !== 'files')) {
      return json({ error: { code: 'bad-request', message: '版の確かめの形が正しくありません。' } }, 400);
    }
    const s = devServer().snapshot();
    const current = s.state === 'running' && s.pid !== null && s.startedAt !== null
      && s.instance === run.instance && s.pid === run.pid && s.startedAt === run.startedAt
      && pidAlive(s.pid);
    if (!current || !s.project) {
      return json({ error: { code: 'stale-run', message: 'この確かめは、いま実行中の開発サーバーとは別の起動についてのものです。' } }, 409);
    }
    return json({ revisions: sourceRevisionsOf(s.project.root, files as string[]), run });
  });
}
