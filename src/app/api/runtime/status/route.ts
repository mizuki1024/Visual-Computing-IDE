/* 実行状態の取得。**実際のプロセスを確かめてから返す**（指示 2.D）。
 * Phase 7B-1: プレビューの中継の情報も返す（この要求を出したブラウザから見た中継の URL）。 */
import { devServer } from '@/server/devServer';
import { handle, json } from '@/server/apiShared';
import { previewInfo } from '@/server/preview';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(req, false, async () => {
    const m = devServer();
    await m.refresh();
    const preview = await previewInfo(req.headers.get('host'));
    return json({ runtime: m.snapshot(), inspection: m.lastInspection(), preview, spanCleanup: m.lastSpanCleanup() });
  });
}
