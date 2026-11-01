/* 実行状態の取得。**実際のプロセスを確かめてから返す**（指示 2.D）。 */
import { devServer } from '@/server/devServer';
import { handle, json } from '@/server/apiShared';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(req, false, async () => {
    const m = devServer();
    await m.refresh();
    return json({ runtime: m.snapshot(), inspection: m.lastInspection() });
  });
}
