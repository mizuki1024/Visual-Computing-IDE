/* =============================================================================
 * 編集 E1（安全なコード変更の基盤）の取り決め。
 *
 * **既定で無効。** 対象プロジェクトのソースへの書き込みは、IDE を起動した環境で
 * `VCIDE_EDIT_E1_WRITE=1` を明示したときだけ行う（docs/07d 6.2 E1-1）。値は "1" だけを有効とみなす
 * （"true"・"yes"・前後の空白などを有効と解釈しない）。E1 には画面・API の入口が無く、
 * このモジュール群は製品のどこからも読み込まれない（tests/edit-disabled.spec.mjs が確かめる）。
 * ========================================================================== */

export const EDIT_WRITE_ENV = 'VCIDE_EDIT_E1_WRITE';

/** 書き込みが有効か。呼ぶたびに読む（起動の途中で変えた値も、そのときの値で判断する） */
export function editWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EDIT_WRITE_ENV] === '1';
}

/** 書き込んでよい範囲（プロジェクトの根からの相対）。探索の注入範囲（anchors.ANCHOR_SCOPE）と同じ */
export const EDIT_SCOPE = 'src';

/** 書き込んでよい拡張子（E1: JSX/TSX の className だけ）。探索の safeSourcePath と同じ */
export const EDIT_EXTENSIONS: readonly string[] = ['.tsx', '.jsx'];

/** 1ファイルの大きさの上限（これより大きいファイルは扱わない） */
export const MAX_SOURCE_BYTES = 2_000_000;

/** 一時ファイルの名前に入れる印（`.<名前>.vcide-edit-<txId>.tmp`） */
export const TEMP_MARK = '.vcide-edit-';

export interface RequiredViewport { name: string; width: number }

/** 検証に必須の幅（docs/07d 1.2・04e: Desktop 1440×900・Mobile 375×812） */
export const REQUIRED_VIEWPORTS: readonly RequiredViewport[] = [
  { name: 'desktop', width: 1440 },
  { name: 'mobile', width: 375 },
];

/** 検証の報告を受け付ける古さの上限（確定の後・受け取った時点から） */
export const MAX_VERIFICATION_AGE_MS = 10 * 60 * 1000;
/** 時計のずれとして許す未来側の幅 */
export const CLOCK_SKEW_MS = 2_000;

/** 終わった（committed・failed）ジャーナルを残す期間。終わっていないものは期間に関係なく消さない */
export const JOURNAL_RETENTION_MS = 30 * 24 * 3600 * 1000;
