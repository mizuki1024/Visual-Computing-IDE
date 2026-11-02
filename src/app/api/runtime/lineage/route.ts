/* =============================================================================
 * Phase 7B-3B-2 — 選択した要素の値の由来（`supplies`）を評価する。
 *
 * 受け取るもの: どの起動のページか・プレビューのスクリプトが送った選択（識別子・タグ・何番目か・値の形）・
 * その文書について知らせたもの（中継が応答に付けた文書の識別子・クライアント側の遷移の有無）。
 * **位置は受け取らない。** 要素の位置は IDE がもう一度、対応表とソースの読み直しで決める（7B-2 の照合に F-01 のソースの版を足した7段）。
 *
 * 返すもの: その時点の観測（描画に使う）・文書の同定の結果・由来の評価（結んだか、どの段の条件で切れたか）。
 * 観測と評価を同じ1回の取得から作るので、画面が「評価に使っていない SQL」に線を引くことは無い。
 *
 * Phase 7C-1: 評価はサーバーが保持しているすべての証拠と「保持対象外」の記録で行い、返す観測は
 * 同定した文書の通信（と `detail` で求めた通信）の証拠だけに絞る。同定した通信の保持を頼む。
 * ========================================================================== */
import { body, handle, json } from '@/server/apiShared';
import { collectCurrent } from '@/server/liveCollect';
import { resolveSelection } from '@/server/anchors';
import { analyzeProject } from '@/server/lineage';
import { parseRunKey, parseSelection, DOC_TOKEN_RE } from '@/lib/previewProtocol';
import { bindDocument } from '@/lib/liveObservation';
import { observationView, parseViewRequest } from '@/server/observationView';
import { evaluateLineage } from '@/lib/liveLineage';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return handle(req, true, async () => {
    const b = await body(req);
    const run = parseRunKey(b?.run);
    const selection = parseSelection(b?.selection);
    const d = b?.document as { token?: unknown; soft?: unknown } | null | undefined;
    const docOk = d === null || d === undefined || (typeof d === 'object'
      && (d.token === null || (typeof d.token === 'string' && DOC_TOKEN_RE.test(d.token)))
      && (d.soft === null || typeof d.soft === 'boolean')
      && Object.keys(d).every((k) => k === 'token' || k === 'soft'));
    const want = parseViewRequest(b ? { detail: b.detail, pin: b.pin } : null);
    if (!b || !run || !selection || !docOk || !want) {
      return json({ error: { code: 'bad-request', message: '選択の形が正しくありません。' } }, 400);
    }
    const document = d ? { token: (d.token as string | null) ?? null, soft: (d.soft as boolean | null) ?? null } : null;
    const r = await collectCurrent(run, { pin: want.pin });
    if (!r.ok) return json({ error: { code: r.code, message: r.message } }, 409);
    const s = r.snapshot;
    const anchors = s.anchors ?? { state: 'unavailable' as const, reason: '起動の記録に注入の情報がありません。', scope: 'src' };
    const resolution = resolveSelection(s.project!.root, anchors, selection);
    const binding = bindDocument(r.observation, document, selection.path, r.history);
    if (binding.status === 'identified') r.pin([binding.seq]);
    const pl = await analyzeProject(s.project!.root);
    const lineage = evaluateLineage({
      obs: r.observation, binding,
      anchor: resolution.status === 'resolved'
        ? { file: resolution.anchor.file, line: resolution.anchor.line, col: resolution.anchor.col, tag: resolution.anchor.tag, component: resolution.anchor.component }
        : null,
      analysis: pl.analysis, analyzerError: pl.error, resolveLineage: pl.resolveLineage,
      changedAfter: pl.changedAfter, reasonText: pl.reasonText,
    });
    const detail = want.detail === 'all' ? 'all'
      : [...(binding.status === 'identified' ? [binding.seq] : []), ...want.detail];
    return json({ observation: observationView(r.observation, detail), resolution, binding, lineage });
  });
}
