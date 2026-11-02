/* =============================================================================
 * キャンバス設計空間の幾何。ラベル札の幅と、全体表示のための内容の外接矩形。
 * ========================================================================== */
import type { LaidOutDataset } from './layout';
import type { TraceNode } from './trace';

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * ラベル札の幅。和文は約12.2px/字（12px・palt）、等幅の識別子は約6.9px/字。
 * gen_physical.py の chip() と同じ見積りである。
 */
export function chipWidth(n: Pick<TraceNode, 'title' | 'identifier'>, hasBadge = true): number {
  const title = n.title.length * 12.2;
  const sub = n.identifier.length * 6.9;
  return Math.max(title, sub) + (hasBadge ? 58 : 26);
}

export const CHIP_H = 44;

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const box = (cx: number, cy: number, w: number, h: number): Rect => ({
  x: cx - w / 2, y: cy - h / 2, w, h,
});

/** 全体表示が収めるべき内容の範囲。描いているものから算出する。 */
export function contentBounds(ds: LaidOutDataset): Rect {
  return boundsOf(ds, true);
}

/**
 * Phase 7C-2: 経路だけの範囲（経路外の減光した通信と、その見出しを含めない）。
 * 実ページの選択・観測の経路を描いた直後に、経路を覆われない領域へ収めるために使う
 * （全体表示は contentBounds で、経路外も含めて収める）
 */
export function pathBounds(ds: LaidOutDataset): Rect {
  return boundsOf(ds, false);
}

/** 切断の注記の幅。和文 11px・10px の字幅で見積もる（7C-2: 固定の 130px では長い理由がはみ出した） */
const cutTextWidth = (c: { head: string; sub: string }) =>
  Math.max(130, c.head.length * 11, c.sub.length * 10) + 20;

function boundsOf(ds: LaidOutDataset, withOffPath: boolean): Rect {
  let r: Rect | null = null;
  const add = (b: Rect) => { r = r ? union(r, b) : b; };

  for (const n of ds.nodes) {
    const s = n.size;
    add(box(n.x, n.y, s * 1.25, s * 1.45));
    // 札に実際に出るのは chipSub。identifier（計測値つきの長い文字列）ではない。
    // バッジが出る側（経路スコープ）の幅で取る — 全体表示が状態で動かないようにする。
    add(box(n.chip.x, n.chip.y, chipWidth({ title: n.title, identifier: n.chipSub }), CHIP_H));
    if (n.plinth) add(box(n.plinth.x, n.plinth.y + 7, 150, 40));
  }
  for (const h of ds.hops) {
    if (h.tag) add(h.tag.below ? { x: h.tag.x - 30, y: h.tag.y - 12, w: 30 + h.tag.label.length * 10.5 + 10, h: 44 } : box(h.tag.x, h.tag.y - 9, 180, 46));
  }
  if (withOffPath) {
    for (const o of ds.offPath.nodes) add(box(o.x, o.y, o.size * 1.6, o.size * 2.2));
    add(box(ds.offPath.caption.x + 120, ds.offPath.caption.y - 5, 250, 24));
  }
  for (const c of ds.cuts) {
    add({ x: c.text.x - 10, y: c.text.y - 16, w: cutTextWidth(c), h: 60 });
    add(box(c.mark.x, c.mark.y, 48, 36));
  }

  return r ?? { x: 0, y: 0, w: 1240, h: 952 };
}
