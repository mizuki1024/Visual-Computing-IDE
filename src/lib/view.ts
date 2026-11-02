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

/**
 * 浮かぶパネルに覆われない領域（**固定値の見積り**）。
 * 画面の実寸を測れないとき（最初の描画の前）だけ使う。測れるときは freeRegionAmong を使う。
 */
export function freeRegion(vw: number, vh: number, leftPanels: boolean): Rect {
  const left = leftPanels ? 268 : 28;
  return { x: left, y: 28, w: Math.max(80, vw - left - 28), h: Math.max(80, vh - 56) };
}

/** キャンバスの縁からの余白（従来の freeRegion と同じ 28px） */
export const EDGE = 28;
/** パネルの縁からの余白。左の列（右端 252px）＋16 = 268px で、従来の freeRegion と一致する */
export const GAP = 16;

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Phase 7C-2: **いま表示されているパネルの実寸**から、覆われない領域を求める。
 *
 * obstacles はキャンバス座標（キャンバスの左上が 0,0）の矩形（浮かぶパネル・操作バー・注記）。
 * 候補の辺は「キャンバスの縁から EDGE」と「各パネルの縁から GAP」だけなので、全組合せを調べても
 * パネル数 n に対して (n+1)^4 通り（n ≦ 8 で約 6,600）で済む。
 * どのパネルとも重ならない矩形のうち、**内容（target）を最も大きく収められるもの**を返す
 * （同じ倍率なら面積の大きいほう）。内容の縦横比を見るので、横長の経路図には横長の領域を選ぶ。
 * 見つからなければ null（呼ぶ側は従来の見積りに戻る）。
 */
export function freeRegionAmong(
  vw: number, vh: number, obstacles: Rect[], target: { w: number; h: number },
): Rect | null {
  const obs = obstacles
    .filter((o) => o.w > 0 && o.h > 0 && o.x < vw && o.y < vh && o.x + o.w > 0 && o.y + o.h > 0)
    .map((o) => ({ x: o.x - GAP, y: o.y - GAP, w: o.w + GAP * 2, h: o.h + GAP * 2 }));
  const xs0 = [EDGE, ...obs.map((o) => o.x + o.w)].filter((x) => x >= EDGE && x < vw - EDGE);
  const xs1 = [vw - EDGE, ...obs.map((o) => o.x)].filter((x) => x > EDGE && x <= vw - EDGE);
  const ys0 = [EDGE, ...obs.map((o) => o.y + o.h)].filter((y) => y >= EDGE && y < vh - EDGE);
  const ys1 = [vh - EDGE, ...obs.map((o) => o.y)].filter((y) => y > EDGE && y <= vh - EDGE);
  const tw = Math.max(1, target.w);
  const th = Math.max(1, target.h);
  let best: Rect | null = null;
  let bestK = 0;
  let bestA = 0;
  for (const x0 of xs0) for (const x1 of xs1) {
    if (x1 - x0 < 80) continue;
    for (const y0 of ys0) for (const y1 of ys1) {
      if (y1 - y0 < 80) continue;
      const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (obs.some((o) => overlaps(r, o))) continue;
      const k = Math.min(r.w / tw, r.h / th);
      const a = r.w * r.h;
      if (k > bestK + 1e-9 || (Math.abs(k - bestK) <= 1e-9 && a > bestA)) { best = r; bestK = k; bestA = a; }
    }
  }
  return best;
}

function fitRect(target: Rect, region: Rect, maxK = 1.6): View {
  const k = clampK(Math.min(region.w / target.w, region.h / target.h, maxK));
  return {
    k,
    x: region.x + region.w / 2 - (target.x + target.w / 2) * k,
    y: region.y + region.h / 2 - (target.y + target.h / 2) * k,
  };
}

/** 全体表示。region を渡せば（実寸から求めた領域）そこへ、無ければ従来の見積りへ収める */
export function fitAll(
  ds: LaidOutDataset, vw: number, vh: number, leftPanels: boolean, region?: Rect | null,
): View {
  return fitRect(contentBounds(ds), region ?? freeRegion(vw, vh, leftPanels), 1.25);
}

/** 7C-2: 任意の範囲（経路だけ等）を、領域へ収める */
export function fitBounds(b: Rect, region: Rect, maxK = 1.25): View {
  return fitRect(b, region, maxK);
}

/**
 * 7C-2: 寄せた結果、範囲（経路）が領域からはみ出すなら、はみ出さない位置まで戻す。
 * 範囲が領域より大きい軸は動かさない（寄せた位置のまま）。拡大率は変えない
 */
export function keepInside(v: View, b: Rect, region: Rect): View {
  let { x, y } = v;
  const clampAxis = (pos: number, b0: number, bw: number, r0: number, rw: number) => {
    if (bw * v.k > rw) return pos;
    const s0 = b0 * v.k + pos;
    const s1 = (b0 + bw) * v.k + pos;
    if (s0 < r0) return pos + (r0 - s0);
    if (s1 > r0 + rw) return pos - (s1 - (r0 + rw));
    return pos;
  };
  x = clampAxis(x, b.x, b.w, region.x, region.w);
  y = clampAxis(y, b.y, b.h, region.y, region.h);
  return { k: v.k, x, y };
}

/** ある一点へ寄せる。拡大率は変えない（レイアウトの安定性・03b 8.3節） */
export function centerOn(
  v: View, cx: number, cy: number, vw: number, vh: number, leftPanels: boolean, region?: Rect | null,
): View {
  const r = region ?? freeRegion(vw, vh, leftPanels);
  return { k: v.k, x: r.x + r.w / 2 - cx * v.k, y: r.y + r.h / 2 - cy * v.k };
}
