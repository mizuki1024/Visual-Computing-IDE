'use client';
/* =============================================================================
 * <Hop> ホップ1本。
 *  - 実測＝連続線 ／ 推定＝分節線。一次符号は線の形であり、色は補助（NFR-30）
 *  - 隣接ホップを1本に繋がない。独立した線分として描く（03b 3.3節）
 *  - 破線の間隔はスクリーン空間で一定に保つ。拡縮しても実測と推定の差が潰れない
 * ========================================================================== */
import type { TraceHop } from '@/lib/trace';

/** スクリーン空間で 10px / 7px の分節を保つための、設計空間での値 */
export const dashFor = (k: number) => `${10 / k} ${7 / k}`;
/** 線幅はスクリーン上で緩やかに太る（2.2·√k px）。分節の間隔とは別の話 */
export const widthFor = (k: number, base = 2.2) => base / Math.sqrt(k);

export type HopState = 'normal' | 'related' | 'hover' | 'selected';

export default function Hop({ hop, k, state, onSelect, onHover }: {
  hop: TraceHop;
  k: number;
  state: HopState;
  onSelect: () => void;
  onHover: (on: boolean) => void;
}) {
  const est = hop.observability === 'estimated';
  const col = est ? '#9a8fc4' : '#8aa4cc';
  const glow = est ? '#7f6fd8' : '#5d8fd0';
  const dash = est ? dashFor(k) : undefined;
  const marker = est ? 'url(#arE)' : 'url(#arO)';
  const sel = state === 'selected';
  // 選択したノードに接するホップ。経路外の減光（UI-33）と混同させないため、
  // 弱めることはせず、選択色をうっすら足すだけにする。
  const rel = state === 'related';

  return (
    <g className={`hp${state === 'hover' ? ' hov' : ''}`}
      onPointerDown={(e) => { e.stopPropagation(); onSelect(); }}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      role="button" tabIndex={-1}
      aria-label={`${hop.label}（${est ? '推定' : '実測'}）`}>
      {/* つかみしろ。見えないが押せる */}
      <path d={hop.d} fill="none" stroke="transparent" strokeWidth={18 / k} strokeLinecap="round" />
      {/* 発光 */}
      <path d={hop.d} fill="none" stroke={glow} strokeWidth={widthFor(k, 9)} opacity={sel ? 0.3 : 0.16}
        strokeDasharray={dash} strokeLinecap="round" filter="url(#blurM)" />
      {/* 選択の下敷き（選択色は補助であり、線の形は変えない） */}
      {(sel || rel) && (
        <path d={hop.d} fill="none" stroke="#9d93e0" strokeWidth={widthFor(k, sel ? 5.4 : 4.2)}
          opacity={sel ? 0.38 : 0.16} strokeDasharray={dash} strokeLinecap="round" />
      )}
      <path d={hop.d} fill="none" stroke={col} strokeWidth={widthFor(k)} strokeDasharray={dash}
        strokeLinecap="round" markerEnd={marker} />
    </g>
  );
}

/** <DimmedPath> 経路外。減光して残す（UI-33。削除しない） */
export function DimmedHop({ d, k }: { d: string; k: number }) {
  return (
    <path d={d} fill="none" stroke="#283043" strokeWidth={widthFor(k, 1.4)}
      strokeLinecap="round" markerEnd="url(#arD)" />
  );
}
