/* プレビューの浮かぶパネルの位置と幅（合成の見本と実プレビューで共通） */
/**
 * 7C-2: プレビューの幅。設計寸法（キャンバス幅 1240）では 392px のまま。
 * 狭い窓（1440×900 ではキャンバス幅 1080）では、右上の操作バー（約 480px）とヘッダの
 * ［畳む / ページを表示］が重ならない幅まで縮める（7C-0 までは操作バーがヘッダの右端を覆っていた）
 */
export const PREVIEW_LEFT = 232;
const TOOLBAR_W = 480;
export function previewWidth(canvasW: number): number {
  return Math.max(300, Math.min(392, canvasW - PREVIEW_LEFT - 16 - TOOLBAR_W - 16));
}
