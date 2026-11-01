/* =============================================================================
 * パン・ズーム・全体表示。screen = content * k + (x, y)
 * ========================================================================== */
import { contentBounds, type Rect } from './geometry';
import type { LaidOutDataset } from './layout';

export interface View { k: number; x: number; y: number }

export const MIN_K = 0.35;
export const MAX_K = 2.4;

export const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

export const toScreen = (v: View, px: number, py: number) => ({
  x: px * v.k + v.x,
  y: py * v.k + v.y,
});

export const toContent = (v: View, sx: number, sy: number) => ({
  x: (sx - v.x) / v.k,
  y: (sy - v.y) / v.k,
});

/** ポインタ位置を固定したまま拡縮する */
export function zoomAt(v: View, factor: number, sx: number, sy: number): View {
  const k = clampK(v.k * factor);
  if (k === v.k) return v;
  const p = toContent(v, sx, sy);
  return { k, x: sx - p.x * k, y: sy - p.y * k };
}

/** 浮かぶパネルに覆われない領域。全体表示とフォーカスはここに収める。 */
export function freeRegion(vw: number, vh: number, leftPanels: boolean): Rect {
  const left = leftPanels ? 268 : 28;
  return { x: left, y: 28, w: Math.max(80, vw - left - 28), h: Math.max(80, vh - 56) };
}

function fitRect(target: Rect, region: Rect, maxK = 1.6): View {
  const k = clampK(Math.min(region.w / target.w, region.h / target.h, maxK));
  return {
    k,
    x: region.x + region.w / 2 - (target.x + target.w / 2) * k,
    y: region.y + region.h / 2 - (target.y + target.h / 2) * k,
  };
}

/** 全体表示 */
export function fitAll(
  ds: LaidOutDataset, vw: number, vh: number, leftPanels: boolean,
): View {
  return fitRect(contentBounds(ds), freeRegion(vw, vh, leftPanels), 1.25);
}

/** ある一点へ寄せる。拡大率は変えない（レイアウトの安定性・03b 8.3節） */
export function centerOn(v: View, cx: number, cy: number, vw: number, vh: number, leftPanels: boolean): View {
  const r = freeRegion(vw, vh, leftPanels);
  return { k: v.k, x: r.x + r.w / 2 - cx * v.k, y: r.y + r.h / 2 - cy * v.k };
}
