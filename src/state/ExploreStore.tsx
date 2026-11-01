'use client';
/* =============================================================================
 * 探索画面（S-04）の状態。
 *
 * 段階0（未選択の俯瞰）と段階2（選択）を行き来する。
 *   03a 5節  : ページを開いた直後は「意図的に何も選択しない」（SelectionTarget なし）
 *   UXR-04   : 0操作で俯瞰が出ている
 *   03c 5.1  : 選択_経路あり --Esc / 空白クリック--> 未選択
 *   03c 5.1  : ホップ選択 --Esc--> 選択_経路あり
 *   03c 5.2  : ScopeContext は 未選択 = page / 選択 = path
 * ========================================================================== */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import {
  CANVAS, byIdIn, hopByIdIn, type LaidOutDataset, type SelectionRef,
} from '@/lib/trace';
import { nodeIdForBadge } from '@/lib/derive';
import { centerOn, fitAll, zoomAt, clampK, type View } from '@/lib/view';

export type PanelId = 'pages' | 'preview' | 'legend' | 'minimap' | 'runtime';
export type DockTab = 'overview' | 'evidence';
/** 03c 5.2節 ScopeContext。未選択はページ全体、選択すると経路。 */
export type Scope = 'page' | 'path';

/** 経路の起点。Esc でホップ選択から戻る先であり、既定の選択でもある。 */
const PATH_ORIGIN = 1;

/** 選択できない対象の、ホバー時の説明 */
export interface HoverNote { head: string; sub: string; note: string }

const sameRef = (a: SelectionRef | null, b: SelectionRef | null) =>
  !!a && !!b && a.type === b.type && String(a.id) === String(b.id);

/** 選択対象の中心（キャンバス設計空間）。フォーカスの寄せ先。 */
function centerOfRef(ds: LaidOutDataset, ref: SelectionRef): { x: number; y: number } {
  if (ref.type === 'node') {
    const n = byIdIn(ds, ref.id);
    return { x: n.x, y: n.y };
  }
  const h = hopByIdIn(ds, ref.id);
  const a = byIdIn(ds, h.from);
  const b = byIdIn(ds, h.to);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

interface Ctx {
  /**
   * 描いているデータセット。合成でも実測でも同じ形である。
   * 描画部品はここからだけ読む — モジュール定数を読まない。
   */
  data: LaidOutDataset;
  /**
   * Phase 7B-2: 開発サーバーの実ページで選択した要素のデータセットを描いているか。
   * 描いている間だけ `data` が差し替わる。解除すると、ページを開いたときのデータセットに戻る
   * （合成・記録データの探索はそのまま残る）
   */
  live: { key: string } | null;
  showLive: (ds: LaidOutDataset, key: string, focusNode: number) => void;
  clearLive: () => void;
  /** null = 段階0（未選択の俯瞰）。空パネルではなくページの概要を出す（ST-16） */
  selection: SelectionRef | null;
  scope: Scope;
  hover: SelectionRef | null;
  /** 選択できないものの説明（経路外の通信など）。選択とは別の軸なので別に持つ */
  hoverNote: HoverNote | null;
  tab: DockTab;
  panels: Record<PanelId, boolean>;
  showLabels: boolean;
  pageFilter: string;
  view: View;
  viewport: { w: number; h: number };

  select: (ref: SelectionRef, opts?: { focus?: boolean }) => void;
  clearSelection: () => void;
  setHover: (ref: SelectionRef | null) => void;
  setHoverNote: (n: HoverNote | null) => void;
  setTab: (t: DockTab) => void;
  togglePanel: (p: PanelId) => void;
  setShowLabels: (v: boolean) => void;
  setPageFilter: (v: string) => void;
  setView: (v: View) => void;
  setViewport: (w: number, h: number) => void;
  zoomBy: (factor: number, sx?: number, sy?: number) => void;
  fit: () => void;
  focusOn: (ref: SelectionRef) => void;
}

const ExploreCtx = createContext<Ctx | null>(null);

export function ExploreProvider(
  { children, data: baseData }: { children: ReactNode; data: LaidOutDataset },
) {
  const [liveData, setLiveData] = useState<{ ds: LaidOutDataset; key: string } | null>(null);
  const data = liveData?.ds ?? baseData;
  // 既定は未選択。ページを開いた時点で俯瞰が出ている（UXR-04 / 03a 5節）
  const [selection, setSelection] = useState<SelectionRef | null>(null);
  // ホップ選択から Esc で戻る先（03c 5.1「ホップ選択 → 選択_経路あり」）。
  // 経路の起点は、ホップをたどって最初に現れるノードである
  const pathOrigin = data.hops.length
    ? [...data.hops].sort((a, b) => a.order - b.order)[0].from
    : (data.nodes[0]?.id ?? PATH_ORIGIN);
  const [lastNode, setLastNode] = useState<number>(pathOrigin);
  const [hover, setHover] = useState<SelectionRef | null>(null);
  const [hoverNote, setHoverNote] = useState<HoverNote | null>(null);
  const [tab, setTab] = useState<DockTab>('overview');
  const [panels, setPanels] = useState<Record<PanelId, boolean>>({
    pages: true, preview: true, legend: true, minimap: true, runtime: true,
  });
  const [showLabels, setShowLabels] = useState(true);
  const [pageFilter, setPageFilter] = useState('');
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [viewport, setViewportState] = useState({ w: 1240, h: 952 });

  const raf = useRef<number | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const didInitialFit = useRef(false);

  const leftPanels = panels.pages || panels.legend || panels.minimap;

  const stopTween = () => {
    if (raf.current !== null) { cancelAnimationFrame(raf.current); raf.current = null; }
  };

  /** 選択時の寄せは短く。レイアウトは動かさない（03b 8.3節） */
  const animateTo = useCallback((target: View) => {
    stopTween();
    const from = viewRef.current;
    const t0 = performance.now();
    const dur = 260;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setView({
        k: from.k + (target.k - from.k) * e,
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
      });
      if (p < 1) raf.current = requestAnimationFrame(step);
      else raf.current = null;
    };
    const reduce = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setView(target); return; }
    raf.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => stopTween, []);

  const setViewport = useCallback((w: number, h: number) => {
    setViewportState((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  /*
   * 初期表示は設計寸法（1240 x 952）の等倍。基準画像と同じ構図になる。
   * 窓がそれより小さいときだけ全体表示に合わせる。以後は視点を勝手に動かさない。
   */
  useEffect(() => {
    if (didInitialFit.current || viewport.w <= 80) return;
    didInitialFit.current = true;
    const fitsAtActualSize = viewport.w >= CANVAS.w - 8 && viewport.h >= CANVAS.h - 8;
    setView(fitsAtActualSize
      ? { k: 1, x: 0, y: 0 }
      : fitAll(data, viewport.w, viewport.h, leftPanels));
  }, [data, viewport.w, viewport.h, leftPanels]);

  const fit = useCallback(() => {
    animateTo(fitAll(data, viewport.w, viewport.h, leftPanels));
  }, [animateTo, data, viewport.w, viewport.h, leftPanels]);

  const focusOn = useCallback((ref: SelectionRef) => {
    const c = centerOfRef(data, ref);
    animateTo(centerOn(viewRef.current, c.x, c.y, viewport.w, viewport.h, leftPanels));
  }, [animateTo, data, viewport.w, viewport.h, leftPanels]);

  const select = useCallback((ref: SelectionRef, opts?: { focus?: boolean }) => {
    setSelection(ref);
    if (ref.type === 'node') setLastNode(ref.id);
    setTab('overview');                   // IX-17：初期表示は常に「概要」
    if (opts?.focus) focusOn(ref);
  }, [focusOn]);

  /**
   * 段階0へ戻る。視点（パン・ズーム）は動かさない — 選択の有無は操作の軸であって、
   * 表示している範囲とは別の軸である（03c 2章 ST-01）。
   */
  const clearSelection = useCallback(() => {
    setSelection(null);
    setTab('overview');
  }, []);

  /* Phase 7B-2: 実ページの選択を、同じキャンバスと右ドックに出す */
  const showLive = useCallback((ds: LaidOutDataset, key: string, focusNode: number) => {
    setLiveData({ ds, key });
    setSelection({ type: 'node', id: focusNode });
    setLastNode(focusNode);
    setTab('overview');
  }, []);
  const liveRef = useRef(liveData);
  liveRef.current = liveData;
  const clearLive = useCallback(() => {
    if (!liveRef.current) return;
    setLiveData(null);
    // 選択していた番号は元のデータセットでは別のものを指す。持ち越さない
    setSelection(null);
    setTab('overview');
  }, []);

  const zoomBy = useCallback((factor: number, sx?: number, sy?: number) => {
    stopTween();
    setView((v) => {
      if (sx === undefined || sy === undefined) {
        const k = clampK(v.k * factor);
        const cx = viewport.w / 2;
        const cy = viewport.h / 2;
        return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
      }
      return zoomAt(v, factor, sx, sy);
    });
  }, [viewport.w, viewport.h]);

  const togglePanel = useCallback((p: PanelId) => {
    setPanels((s) => ({ ...s, [p]: !s[p] }));
  }, []);


  /* --------------------------------------------------------- キーボード */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      /*
       * Esc の階段（IX-12：1段階ずつ戻る / 03c 5.1 の状態機械）
       *   根拠タブ      → 概要タブ        （詳細展開 → 選択_経路あり）
       *   ホップ選択    → 直前のノード選択（ホップ選択 → 選択_経路あり）
       *   ノード選択    → 未選択          （選択_経路あり → 未選択）
       *   未選択        → 何も起きない
       * IX-13：Esc でモードは変わらない。パネルの開閉も Esc の対象にしない。
       */
      if (e.key === 'Escape') {
        if (tab !== 'overview') { setTab('overview'); return; }
        if (selection?.type === 'hop') { select({ type: 'node', id: lastNode }); return; }
        if (selection) { clearSelection(); return; }
        return;                                   // 未選択では何も起こさない
      }
      // 数字はステップバッジに対する操作である（03b 7章）。識別子ではなく表示順で引く。
      if (e.key >= '1' && e.key <= '9') {
        const id = nodeIdForBadge(data, Number(e.key));
        if (id !== null) select({ type: 'node', id });
        return;
      }
      if (e.key === '+' || e.key === '=') { zoomBy(1.2); return; }
      if (e.key === '-' || e.key === '_') { zoomBy(1 / 1.2); return; }
      if (e.key === '0') { fit(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, tab, selection, lastNode, select, clearSelection, zoomBy, fit]);

  const scope: Scope = selection ? 'path' : 'page';

  const live = useMemo(() => (liveData ? { key: liveData.key } : null), [liveData]);

  const value = useMemo<Ctx>(() => ({
    data, live, showLive, clearLive,
    selection, scope, hover, hoverNote, tab, panels, showLabels, pageFilter, view, viewport,
    select, clearSelection, setHover, setHoverNote, setTab, togglePanel, setShowLabels,
    setPageFilter, setView, setViewport, zoomBy, fit, focusOn,
  }), [
    data, live, showLive, clearLive,
    selection, scope, hover, hoverNote, tab, panels, showLabels, pageFilter, view, viewport,
    select, clearSelection, togglePanel, setViewport, zoomBy, fit, focusOn,
  ]);

  return <ExploreCtx.Provider value={value}>{children}</ExploreCtx.Provider>;
}

export function useExplore() {
  const c = useContext(ExploreCtx);
  if (!c) throw new Error('useExplore must be used inside <ExploreProvider>');
  return c;
}

export { sameRef };
