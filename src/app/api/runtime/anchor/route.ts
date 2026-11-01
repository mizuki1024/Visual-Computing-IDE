/* =============================================================================
 * 選択した要素の識別子を、React のソース位置に解決する（Phase 7B-2）。
 *
 * 受け取るのは「どの開発サーバーのページで選んだか」と、プレビューの中のスクリプトが
 * 送った選択（識別子・タグ・何番目か・値の形）だけである。**位置は受け取らない。**
 * 位置は、いま実行中の開発サーバーのビルドが書いた対応表とソースの読み直しから IDE が決める。
 *
 * 古いページ・終了したプロセスからの選択は解決しない（409）。
 * 変更操作と同じ入口の検査（POST + JSON + 独自ヘッダ + 同一オリジン）を通す。
 * ========================================================================== */
import { devServer } from '@/server/devServer';
import { body, handle, json } from '@/server/apiShared';
import { resolveSelection } from '@/server/anchors';
import { pidAlive } from '@/server/net';
import { parseRunKey, parseSelection } from '@/lib/previewProtocol';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(req, true, async () => {
    const b = await body(req);
    const run = parseRunKey(b?.run);
    const selection = parseSelection(b?.selection);
    if (!b || !run || !selection) {
      return json({ error: { code: 'bad-request', message: '選択の形が正しくありません。' } }, 400);
    }
    const s = devServer().snapshot();
    const current = s.state === 'running' && s.pid !== null && s.startedAt !== null
      && s.instance === run.instance && s.pid === run.pid && s.startedAt === run.startedAt
      && pidAlive(s.pid);
    if (!current || !s.project) {
      return json({
        error: {
          code: 'stale-run',
          message: s.state === 'running'
            ? 'この選択は、いま実行中の開発サーバーとは別の起動のページから来ました。解決しません。'
            : '開発サーバーは実行中ではありません。選択は解決しません。',
        },
      }, 409);
    }
    const anchors = s.anchors ?? { state: 'unavailable' as const, reason: '起動の記録に注入の情報がありません。', scope: 'src' };
    const resolution = resolveSelection(s.project.root, anchors, selection);
    return json({ resolution, run });
  });
}
