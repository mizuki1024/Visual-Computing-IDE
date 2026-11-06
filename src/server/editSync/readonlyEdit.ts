/* =============================================================================
 * 視覚編集 E2.1 — 編集エンジンの**読み取り・照合だけ**の窓口（docs/08d 第3節 D-4・第7節）。
 *
 * 製品の画面・API から編集のモジュール（src/server/edit/）へ届く道は、**このファイルだけ**（tests/edit-disabled 第3節が確かめる）。
 * ここから呼べるのは次の4つだけで、どれもファイルを書かない:
 *   resolveTarget     DOM の選択 → 編集対象（探索の7段 ＋ 書き込み範囲 ＋ 読み直した内容の版 ＋ 指紋）
 *   reresolveTarget   解決済みの対象を、新しい DOM の選択で確かめ直す（版・指紋が違えば拒む。引き継がない）
 *   inspectRecovery   復旧の点検（読むだけ。鍵を取らない・ディレクトリを作らない・何も消さない）
 *   writeGate         書き込みの可否（既定で無効・Linux だけ）を読む
 * apply・revert・recover・startupRecovery・submitVerification・createDraft・carrySelection は**出さない**
 * （エンジンの実体もこの外へ渡さない）。E2.1 で利用者・開発用の画面から書き込める道は無い。
 * ========================================================================== */
import { EditEngine, editWriteGate } from '../edit/engine';
import { parseVerificationReport, type VerificationReport } from '../edit/verification';

type Engine = InstanceType<typeof EditEngine>;
export type TargetResult = ReturnType<Engine['resolveTarget']>;
export type RecoveryInspectionView = ReturnType<Engine['inspectRecovery']>;

export interface ReadonlyEditView {
  readonly root: string;
  resolveTarget(selection: unknown): TargetResult;
  reresolveTarget(targetId: string, selection: unknown): TargetResult;
  inspectRecovery(): RecoveryInspectionView;
}

/** journalDir は試験用（製品は既定の IDE の .ide-runtime/edit-journal/<鍵>） */
export function readonlyEditView(projectRoot: string, opts: { journalDir?: string } = {}): ReadonlyEditView {
  const e = new EditEngine({ projectRoot, ...(opts.journalDir ? { journalDir: opts.journalDir } : {}) });
  return Object.freeze({
    root: e.root,
    resolveTarget: (s: unknown) => e.resolveTarget(s),
    reresolveTarget: (id: string, s: unknown) => e.reresolveTarget(id, s),
    inspectRecovery: () => e.inspectRecovery(),
  });
}

export const writeGate = (): { enabled: boolean; reason: string; detail: string } => {
  const g = editWriteGate();
  return { enabled: g.enabled, reason: g.reason, detail: g.detail };
};

/** 検証の報告の形の検査（純粋な関数。エンジンの記録には触れない） */
export const parseReport = (v: unknown): VerificationReport | null => parseVerificationReport(v);
export type { VerificationReport };
