'use client';
/* =============================================================================
 * <Canvas> 点グリッドの暗い観測キャンバス。パン・ズーム・全体表示を持つ。
 * 背景に画像は貼らない。要素はすべて独立したSVG部品である。
 * ========================================================================== */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useExplore } from '@/state/ExploreStore';
import { zoomAt } from '@/lib/view';
import FlowScene from './FlowScene';

export default function Canvas({ children }: { children?: ReactNode }) {
  const { view, setView, setViewport, clearSelection } = useExplore();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<
    { id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null
  >(null);
  const [grabbing, setGrabbing] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  /* 表示領域の実寸を測る（全体表示とフォーカスの計算に要る） */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setViewport(Math.round(r.width), Math.round(r.height));
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setViewport(Math.round(r.width), Math.round(r.height));
    return () => ro.disconnect();
  }, [setViewport]);

  /* ズーム。ページのスクロールに奪われないよう passive:false で受ける */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0016);
      setView(zoomAt(viewRef.current, factor, e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setView]);

  /*
   * 移動と、空白クリックによる選択解除（03c 5.1「選択_経路あり → 未選択」）。
   *
   * ノード・ホップ・浮かぶパネル・操作バーは pointerdown を止めているので、ここに
   * 届いた時点で「キャンバスの空白を押した」ことが確定している。動かさずに離した
   * ときだけ解除する（移動のつもりの操作で選択が消えないようにする）。
   */
  const CLICK_SLOP = 4;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = {
      id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setGrabbing(true);
  }, [view.x, view.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > CLICK_SLOP) d.moved = true;
    setView({ ...viewRef.current, x: d.vx + dx, y: d.vy + dy });
  }, [setView]);

  const endDrag = useCallback((e: React.PointerEvent, deselect: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setGrabbing(false);
    if (deselect && !d.moved) clearSelection();
  }, [clearSelection]);

  /* 点グリッドも一緒に動かす。これが「キャンバスである」ことの手触りになる */
  const g = 30 * view.k;
  const gridStyle = {
    '--grid': `${g}px`,
    '--gx': `${((view.x + 12 * view.k) % g + g) % g}px`,
    '--gy': `${((view.y + 12 * view.k) % g + g) % g}px`,
  } as React.CSSProperties;

  return (
    <div ref={ref} className={`canvas ${grabbing ? 'grabbing' : 'grab'}`} style={gridStyle}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, true)} onPointerCancel={(e) => endDrag(e, false)}>
      <FlowScene />
      {children}
    </div>
  );
}
