/* 起動時の標準出力・エラー出力（指示 2.B）。秘密情報らしきものは落として返す。 */
import { devServer } from '@/server/devServer';
import { handle, json } from '@/server/apiShared';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return handle(req, false, async () => {
    const limit = Number(new URL(req.url).searchParams.get('limit') ?? '200');
    return json(devServer().logs(Number.isFinite(limit) ? limit : 200));
  });
}
