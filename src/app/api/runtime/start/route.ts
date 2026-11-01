/* 開発サーバーの起動。**利用者の明示操作だけが到達する**（指示 2.E）。 */
import { BusyError, devServer } from '@/server/devServer';
import { body, handle, json } from '@/server/apiShared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(req, true, async () => {
    const b = await body(req);
    if (!b || typeof b.project !== 'string') {
      return json({ error: { code: 'bad-request', message: 'project（文字列）が必要です。' } }, 400);
    }
    const port = typeof b.port === 'number' ? b.port
      : typeof b.port === 'string' && b.port.trim() ? Number(b.port) : undefined;
    const m = devServer();
    try {
      const runtime = await m.start({
        project: b.project,
        port: Number.isFinite(port) ? port : undefined,
        instrument: b.instrument !== false,
      });
      return json({ runtime, inspection: m.lastInspection() });
    } catch (e) {
      if (e instanceof BusyError) {
        // 二重起動の拒否。状態そのものは壊れていないので 409 で返す
        return json({
          error: { code: 'conflict', message: e.message, state: e.state },
          runtime: m.snapshot(),
        }, 409);
      }
      throw e;
    }
  });
}
