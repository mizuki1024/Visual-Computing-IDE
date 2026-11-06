/* =============================================================================
 * 視覚編集 E2.1 — 開発用の同期の API（**読むだけ**。docs/08d 第10・11節）。
 *
 * VCIDE_EDIT_SYNC_DEV=1 で IDE を起動したときだけ応答する。無効なら、どの操作も 404（通常の起動に入口は無い）。
 *   GET  state       同期の状態・書き込みの可否（既定で無効）・選んだプロジェクトの復旧の点検（inspectRecovery。読むだけ）
 *   POST connect     アートボードの新しい接続（文書）の登録
 *   POST disconnect  アートボードの接続を外す
 *   POST select      プレビューで選んだ要素 → 編集対象（探索の7段の照合 ＋ 範囲 ＋ 版 ＋ 指紋）と文書の照合
 *   POST recheck     再描画の後の再照合（版・指紋が違えば stale。引き継がない）
 *   POST bind-report 検証の報告の文書を、いまの接続・中継の台帳に結び付ける（検証の評価・記録はしない）
 * 適用・取り消し・復旧（書き込み）・下書きの操作は**無い**（このファイルにも readonlyEdit にも道が無い）。
 * 変更操作と同じ入口の検査（POST + JSON + 独自ヘッダ + 同一オリジン）を通す。
 * ========================================================================== */
import { body, handle, json } from '@/server/apiShared';
import { editSyncRuntime } from '@/server/editSync/runtime';

export const dynamic = 'force-dynamic';

const notFound = (): Response => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const POST_OPS = new Set(['connect', 'disconnect', 'select', 'recheck', 'bind-report']);

export async function GET(req: Request, ctx: { params: Promise<{ op: string }> }): Promise<Response> {
  const rt = editSyncRuntime();
  const { op } = await ctx.params;
  if (!rt || op !== 'state') return notFound();
  return handle(req, false, async () => json(rt.session.state()));
}

export async function POST(req: Request, ctx: { params: Promise<{ op: string }> }): Promise<Response> {
  const rt = editSyncRuntime();
  const { op } = await ctx.params;
  if (!rt || !POST_OPS.has(op)) return notFound();
  return handle(req, true, async () => {
    const b = await body(req);
    const s = rt.session;
    const r = op === 'connect' ? s.connect(b) : op === 'disconnect' ? s.disconnect(b) : op === 'select' ? s.select(b)
      : op === 'recheck' ? s.recheck(b) : s.bindReport(b);
    return r.ok ? json(r.body) : json({ error: r.error }, r.status);
  });
}
