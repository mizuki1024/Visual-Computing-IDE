/* プロジェクトの検出。**読むだけ**で、起動は行わない（指示 2.A）。 */
import { devServer } from '@/server/devServer';
import { body, handle, json } from '@/server/apiShared';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(req, true, async () => {
    const b = await body(req);
    if (!b || typeof b.path !== 'string') {
      return json({ error: { code: 'bad-request', message: 'path（文字列）が必要です。' } }, 400);
    }
    const m = devServer();
    const inspection = await m.inspect(b.path);
    return json({ inspection, runtime: m.snapshot() });
  });
}
