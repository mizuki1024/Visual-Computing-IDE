/* =============================================================================
 * 視覚編集 E2.1 — 編集専用の、文書と中継の記録の厳格な照合（D-3。docs/08d 第8・9節）。純粋な関数だけ。
 *
 * **探索の bindDocument（liveObservation.ts）は変えない。** 探索は「文書の後に同じパスの RSC の取り直しがあれば
 * 同定しない（refetched-after-document）」を保つ。2枚のアートボードが同じルートを開くと、もう一方の取り直しでも
 * 同定しない（安全側）。
 *
 * 編集側はそれと別に、次を**段ごとに**確かめ、段ごとの結果を返す（1つの「成功」にまとめない）:
 *   文書     文書の識別子が、いまの起動の中継の台帳（EditRelayLedger）の HTML の応答ちょうど1件にあり、
 *            正常な応答（2xx）を送り終え、パスが一致し、その文書の中でページ内の遷移が無い
 *   取り直し その文書の後の RSC の取り直しを、**どの文書が出したか**で分ける。中継の台帳には、RSC の要求に文書のスクリプトが
 *            載せた文書の識別子（x-vcide-doc）がある。
 *              - 識別子の無い（または台帳に無い識別子の）同じパスの RSC がある → 未確認（どの文書を描き直したか分からない）
 *              - その文書の識別子を持つ RSC の数が、文書のスクリプトが数えた数と一致し、すべて応答を送り終えている → 取り直しは自分だけ
 *              - 数が合わない（応答待ち・別の誰かがこの識別子を名乗った）→ 未確認
 *              - 別の文書の識別子を持つ RSC は、この文書を描き直していない（別のアートボードの取り直しで同定を落とさない）
 *   描画     **確かめていない（not-verified）**。DOM が文書の応答・RSC の結果どおりに描かれたかは、サーバーが測っていない。
 *            選んだ要素がいまのソースから描かれたことは、別の段（探索の7段の照合: DOM の版＝対応表の版＝ファイルの版）で確かめる
 *
 * 信頼の境界: 文書の識別子・RSC の名乗り・数はすべて**アプリと同じ JavaScript の世界で動くスクリプトの申告**。
 * 中継の台帳と照らせるのは「その識別子を持つ応答・要求が実際に中継を通った」ことまで。悪意のあるアプリに対する認証ではない。
 * 根拠が足りないときは推測で埋めず、未確認（unverified）と理由を返す。
 * ========================================================================== */
import type { ArtboardId } from './editPreviewProtocol';

/** 中継の台帳の、HTML の応答（文書）1件 */
export interface LedgerDocument {
  token: string; path: string; status: number | null; startMs: number; endMs: number; failed: boolean;
}
/** 中継の台帳の、RSC の要求1件。initiator は文書のスクリプトが申告した識別子のうち、**台帳に文書として有る**もの（無ければ null） */
export interface LedgerRsc {
  seq: number; path: string; status: number | null; startMs: number; endMs: number; failed: boolean;
  initiator: string | null;
  /** 識別子を名乗っていたが、台帳の文書に無かった（別の起動・偽の識別子） */
  declaredUnknown: boolean;
}
export interface LedgerView {
  run: string;
  documents: LedgerDocument[];
  rsc: LedgerRsc[];
  /** 保持の上限で外した記録の、いちばん新しい開始時刻（外していなければ null）。これより前の事実は確かめられない */
  lostDocumentsThroughMs: number | null;
  lostRscThroughMs: number | null;
}

export type EditDocReason =
  | 'no-document-token' | 'client-navigation' | 'ledger-unavailable' | 'token-not-in-relay' | 'token-duplicated'
  | 'path-mismatch' | 'document-failed' | 'ledger-evicted' | 'token-of-other-artboard';
export type EditRefetchReason =
  | 'rsc-unattributed' | 'rsc-pending' | 'rsc-count-mismatch' | 'rsc-failed' | 'ledger-evicted';

export const EDIT_DOC_REASON_TEXT: Record<EditDocReason | EditRefetchReason, string> = {
  'no-document-token': '文書から、中継が応答に付けた識別子の知らせがありません（中継の説明のページ・HTML 以外など）',
  'client-navigation': 'この文書の中でページ内の遷移がありました。表示中の DOM は文書の取得が描いたものとは限りません',
  'ledger-unavailable': 'いまの起動の中継の台帳がありません（開発用の同期を有効にする前の起動・別の起動）',
  'token-not-in-relay': '文書の識別子が、いまの起動の中継の台帳にありません（別の起動・まだ応答を送り終えていない・偽の識別子）',
  'token-duplicated': '文書の識別子を持つ応答が台帳に2件以上あり、1つに決まりません',
  'path-mismatch': '識別子が指す応答のパスが、選んだページのパスと違います',
  'document-failed': '識別子が指す応答は、正常な応答（2xx）を送り終えていません',
  'ledger-evicted': '台帳の保持の上限で、この文書より後の記録を外したため確かめられません。プレビューを読み込み直してください',
  'token-of-other-artboard': 'この文書の識別子は、別のアートボードの文書として登録されています（同じ文書を2枚が表示することはありません）',
  'rsc-unattributed': 'この文書の後に、どの文書が出したか分からない同じパスの RSC の取り直しがありました。どの文書を描き直したかを決めません',
  'rsc-pending': 'この文書が出した RSC の取り直しのうち、中継が応答を送り終えていないものがあります（少し待って確かめ直します）',
  'rsc-count-mismatch': 'この文書の識別子を名乗る RSC の数が、文書のスクリプトが数えた数と一致しません（別の誰かがこの識別子を名乗った可能性）',
  'rsc-failed': 'この文書が出した RSC の取り直しが、正常な応答を送り終えていません',
};

/** 時間が経てば満たされうる理由（画面は少し待って確かめ直す） */
export const EDIT_TRANSIENT_REASONS: ReadonlySet<string> = new Set(['token-not-in-relay', 'rsc-pending']);

export type EditDocStage =
  | { status: 'identified'; startMs: number; endMs: number }
  | { status: 'unidentified'; reason: EditDocReason; detail: string };
export type EditRefetchStage =
  | { status: 'none' }
  | { status: 'self'; count: number; samePath: number; lastEndMs: number }
  | { status: 'unverified'; reason: EditRefetchReason; detail: string }
  | { status: 'not-checked' };

export interface EditDocBinding {
  /** document-identified = 文書の段と取り直しの段がどちらも通った（**描画は確かめていない**）。それ以外は unverified */
  level: 'document-identified' | 'unverified';
  document: EditDocStage;
  refetch: EditRefetchStage;
  /** 描画（DOM が応答どおりか）は、サーバーが測っていない */
  render: 'not-verified';
  reasons: (EditDocReason | EditRefetchReason)[];
  transient: boolean;
  checks: string[];
}

export interface EditDocInput {
  ledger: LedgerView | null;
  token: string | null;
  soft: boolean | null;
  /** 選んだ要素のページのパス（クエリ・ハッシュを含めない） */
  path: string;
  artboard: ArtboardId;
  /** 別のアートボードに登録されている文書の識別子 */
  otherArtboardTokens: readonly string[];
  /** 文書のスクリプトが数えた、この文書が出した RSC の要求の数（申告） */
  rsc: { started: number; settled: number };
}

const CHECKS = {
  doc: '文書の識別子が、いまの起動の中継の台帳の HTML の応答ちょうど1件にあり、パスが同じで、正常な応答（2xx）を送り終えている',
  soft: 'その文書の中でページ内の遷移が無い（スクリプトの申告）',
  artboard: '同じ識別子の文書が、別のアートボードに登録されていない',
  refetch: 'その文書の後の同じパスの RSC の取り直しは、すべて出した文書の識別子を持つ（どの文書の取り直しかを区別できる）',
  count: 'この文書の識別子を持つ RSC の数が、文書のスクリプトが数えた数と一致し、すべて応答を送り終えている',
};

/** 編集専用の文書の照合。**1つでも欠ければ unverified**（理由を返す。推測で埋めない） */
export function bindEditDocument(i: EditDocInput): EditDocBinding {
  const out = (document: EditDocStage, refetch: EditRefetchStage, checks: string[]): EditDocBinding => {
    const reasons: (EditDocReason | EditRefetchReason)[] = [];
    if (document.status === 'unidentified') reasons.push(document.reason);
    if (refetch.status === 'unverified') reasons.push(refetch.reason);
    const level = document.status === 'identified' && (refetch.status === 'none' || refetch.status === 'self') ? 'document-identified' : 'unverified';
    return { level, document, refetch, render: 'not-verified', reasons, transient: reasons.length > 0 && reasons.every((r) => EDIT_TRANSIENT_REASONS.has(r)), checks };
  };
  const noDoc = (reason: EditDocReason, detail = ''): EditDocBinding => out({ status: 'unidentified', reason, detail }, { status: 'not-checked' }, []);
  if (!i.token) return noDoc('no-document-token');
  if (i.soft !== false) return noDoc('client-navigation', i.soft === null ? 'スクリプトが遷移の有無を知らせていません' : '');
  if (i.otherArtboardTokens.includes(i.token)) return noDoc('token-of-other-artboard');
  const L = i.ledger;
  if (!L) return noDoc('ledger-unavailable');
  const hits = L.documents.filter((d) => d.token === i.token);
  if (hits.length > 1) return noDoc('token-duplicated', `${hits.length} 件`);
  if (!hits.length) {
    return L.lostDocumentsThroughMs !== null
      ? noDoc('ledger-evicted', '台帳の保持の上限で外した文書の記録があり、それより古い文書かどうかは確かめられません')
      : noDoc('token-not-in-relay');
  }
  const d = hits[0];
  if (d.path !== i.path) return noDoc('path-mismatch', `応答は ${d.path}、選択は ${i.path}`);
  if (d.failed || d.status === null || d.status < 200 || d.status > 299) return noDoc('document-failed', `応答: ${d.status ?? 'なし'}`);
  const docStage: EditDocStage = { status: 'identified', startMs: d.startMs, endMs: d.endMs };
  const checks = [CHECKS.doc, CHECKS.soft, CHECKS.artboard];
  const bad = (reason: EditRefetchReason, detail = ''): EditDocBinding => out(docStage, { status: 'unverified', reason, detail }, checks);
  if (L.lostRscThroughMs !== null && L.lostRscThroughMs >= d.startMs) return bad('ledger-evicted', 'この文書より後の RSC の記録の一部を外しました');
  const after = L.rsc.filter((r) => r.startMs >= d.startMs);
  const unattributed = after.filter((r) => r.path === d.path && r.initiator === null);
  if (unattributed.length) {
    return bad('rsc-unattributed', `${unattributed.length} 件（${unattributed.some((r) => r.declaredUnknown) ? '台帳に無い識別子を名乗ったものを含む' : '出した文書の識別子なし'}）`);
  }
  const mine = L.rsc.filter((r) => r.initiator === i.token);
  if (mine.some((r) => r.failed || r.status === null || r.status < 200 || r.status > 299)) return bad('rsc-failed');
  if (i.rsc.settled < i.rsc.started || i.rsc.started > mine.length) {
    return bad('rsc-pending', `スクリプトの数 ${i.rsc.started}（応答済み ${i.rsc.settled}）・中継が送り終えた数 ${mine.length}`);
  }
  if (i.rsc.started < mine.length) return bad('rsc-count-mismatch', `スクリプトの数 ${i.rsc.started}・中継の数 ${mine.length}`);
  checks.push(CHECKS.refetch, CHECKS.count);
  if (!mine.length) return out(docStage, { status: 'none' }, checks);
  return out(docStage, {
    status: 'self', count: mine.length, samePath: mine.filter((r) => r.path === d.path).length,
    lastEndMs: Math.max(...mine.map((r) => r.endMs)),
  }, checks);
}
