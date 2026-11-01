/* 開発サーバーの停止。プロセスグループごと止め、ポートの解放を確認する（指示 2.C）。 */
import { BusyError, devServer } from '@/server/devServer';
import { handle, json } from '@/server/apiShared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(req, true, async () => {
    const m = devServer();
    try {
      return json({ runtime: await m.stop(), inspection: m.lastInspection() });
    } catch (e) {
      if (e instanceof BusyError) {
        return json({
          error: { code: 'conflict', message: e.message, state: e.state },
          runtime: m.snapshot(),
        }, 409);
      }
      throw e;
    }
  });
}
