/* =============================================================================
 * 実行状態の観測結果の新旧判定（Phase 7A / R2）。
 *
 * 画面は操作中も状態の取得を止めない（止めると、最長 180 秒の起動の間ずっと
 * クリック前の「未起動」を出し続けてしまう）。その代わり、届いた応答が
 * 手元のものより古ければ捨てる。**応答の入れ違いはここだけで防ぐ。**
 * ========================================================================== */

/** 新旧の判定に要る最小の形。`DevServerSnapshot` はこれを満たす */
export interface OrderedSnapshot {
  /** サーバーが状態を変えるたびに増やす番号 */
  seq: number;
  /** 管理実体の識別子。IDE のプロセスが入れ替わると seq は数え直しになる */
  instance: string;
}

/**
 * 届いた観測結果を反映してよいか。
 *   - instance が違う → 新しい管理実体の観測なので反映する（seq は比べられない）
 *   - 同じ instance  → seq が手元以上なら反映する
 * 同じ seq を受け付けるのは、状態を変えずに進む情報（起動中の出力・HTTP の観測）があるため。
 */
export function isNewerSnapshot<T extends OrderedSnapshot>(current: T | null, incoming: T): boolean {
  if (!current) return true;
  if (incoming.instance !== current.instance) return true;
  return incoming.seq >= current.seq;
}
