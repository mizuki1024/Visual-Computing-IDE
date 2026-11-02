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
import {
  centerOn, fitAll, fitBounds, freeRegionAmong, keepInside, zoomAt, clampK, type View,
} from '@/lib/view';
import { contentBounds, pathBounds, type Rect } from '@/lib/geometry';

export type PanelId = 'pages' | 'preview' | 'legend' | 'minimap' | 'runtime';
/**
 * Phase 7C-2: 畳める浮かぶパネル。畳んでも閉じない（中身・状態・iframe の文書は残る）。
 *   preview … 経路を見るときは、ページの表示を畳んで1行の文脈（パス・選択した要素）だけ残す
 *   runtime … 開発サーバーの実行中は、状態・PID・停止の1段だけにする（所見・設定は［詳細］で開く）
 */
export type CompactId = 'preview' | 'runtime';
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
  /** 7C-2: 畳んでいるか（panels の開閉とは別の軸） */
  compact: Record<CompactId, boolean>;
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
  setCompact: (p: CompactId, v: boolean) => void;
  /** 7C-2: キャンバスが、浮かぶパネルの実寸（キャンバス座標）を測る関数を登録する */
  registerObstacles: (fn: (() => Rect[]) | null) => void;
  /** 利用者のパン・ホイールでの拡縮（自動の全体表示をやめる） */
  setViewByUser: (v: View) => void;
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
  const [compact, setCompactState] = useState<Record<CompactId, boolean>>({ preview: false, runtime: true });
  const [showLabels, setShowLabels] = useState(true);
  const [pageFilter, setPageFilter] = useState('');
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [viewport, setViewportState] = useState({ w: 1240, h: 952 });

  const raf = useRef<number | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const didInitialFit = useRef(false);

  const leftPanels = panels.pages || panels.legend || panels.minimap;

  /*
   * 7C-2: 覆われない領域は、**いま表示されているパネルの実寸**から求める（freeRegionAmong）。
   * 測れないとき（最初の描画の前）だけ、従来の固定の見積り（freeRegion）に戻る。
   */
  const obstaclesRef = useRef<(() => Rect[]) | null>(null);
  const registerObstacles = useCallback((fn: (() => Rect[]) | null) => { obstaclesRef.current = fn; }, []);
  const regionNow = useCallback((target: Rect) => {
    const obs = obstaclesRef.current?.();
    if (!obs) return null;
    return freeRegionAmong(viewport.w, viewport.h, obs, target);
  }, [viewport.w, viewport.h]);
  /**
   * いまの視点が「全体表示（自動を含む）の結果」のままか。利用者がパン・拡縮・寄せをしたら false。
   * true の間は、パネルの開閉・畳み・窓の大きさが変わるたびに収め直す（覆われない領域が変わるため）
   */
  const autoFitRef = useRef(false);

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

  /*
   * 7C-2: 実寸を一度でも測ったか。初期値（設計寸法 1240×952）のまま最初の視点を決めると、
   * 窓が小さくても「等倍で収まる」と判定してしまっていた（1440×900 で全体表示に合わせていなかった）
   */
  const [viewportMeasured, setViewportMeasured] = useState(false);
  const setViewport = useCallback((w: number, h: number) => {
    setViewportState((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    setViewportMeasured(true);
  }, []);

  /*
   * 初期表示は設計寸法（1240 x 952）の等倍。基準画像と同じ構図になる。
   * 窓がそれより小さいときだけ全体表示に合わせる。以後は視点を勝手に動かさない。
   */
  useEffect(() => {
    if (didInitialFit.current || !viewportMeasured || viewport.w <= 80) return;
    didInitialFit.current = true;
    const fitsAtActualSize = viewport.w >= CANVAS.w - 8 && viewport.h >= CANVAS.h - 8;
    setView(fitsAtActualSize
      ? { k: 1, x: 0, y: 0 }
      : fitAll(data, viewport.w, viewport.h, leftPanels, regionNow(contentBounds(data))));
  }, [data, viewport.w, viewport.h, leftPanels, regionNow, viewportMeasured]);

  /*
   * 7C-2: 収める処理は「パネルの表示が DOM に反映された後」に測ってから行う。
   * 畳む → 再描画 → 実寸を測る → 収める、の順にするため、要求の番号だけを state に持つ。
   * 収める範囲は2種類。'all' = 全体表示（経路外の通信も含む）、'path' = 実ページの経路を描いた直後
   * （経路だけ。07c0 第7節 案3「経路の範囲がその領域に入るように視点を合わせる」）。
   * パネルの開閉で収め直すときは、直前と同じ種類で収める
   */
  const [fitReq, setFitReq] = useState<{ n: number; mode: 'all' | 'path' }>({ n: 0, mode: 'all' });
  const fitModeRef = useRef<'all' | 'path'>('all');
  const requestFit = useCallback((mode?: 'all' | 'path') => {
    if (mode) fitModeRef.current = mode;
    setFitReq((r) => ({ n: r.n + 1, mode: fitModeRef.current }));
  }, []);
  useEffect(() => {
    if (fitReq.n === 0) return;
    autoFitRef.current = true;
    if (fitReq.mode === 'path') {
      const b = pathBounds(data);
      const region = regionNow(b);
      animateTo(region ? fitBounds(b, region) : fitAll(data, viewport.w, viewport.h, leftPanels));
      return;
    }
    animateTo(fitAll(data, viewport.w, viewport.h, leftPanels, regionNow(contentBounds(data))));
  // data は最新を読む。要求の番号だけで動かす
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitReq]);

  /**
   * 全体表示（0）。表示領域が足りないときは、ズームだけで解決しない（7C-2）:
   * 畳めるパネル（プレビュー・実行中の「プロジェクトと実行」）を畳んでから、残った領域へ収める。
   * 畳んだパネルは閉じない。ヘッダの［ページを表示］［詳細］で、ワンクリックで戻せる
   */
  const fit = useCallback(() => {
    setCompactState((c) => (c.preview && c.runtime ? c : { preview: true, runtime: true }));
    requestFit('all');
  }, [requestFit]);

  const focusOn = useCallback((ref: SelectionRef) => {
    const c = centerOfRef(data, ref);
    autoFitRef.current = false;
    // 7C-2: 寄せても、経路が覆われない領域に収まる大きさなら、経路がはみ出さない位置に留める
    const b = pathBounds(data);
    const region = regionNow(b);
    const v = centerOn(viewRef.current, c.x, c.y, viewport.w, viewport.h, leftPanels, region);
    animateTo(region ? keepInside(v, b, region) : v);
  }, [animateTo, data, viewport.w, viewport.h, leftPanels, regionNow]);

  /*
   * 7C-2: 実ページの選択・観測の経路を描いたら、経路の範囲を覆われない領域へ収める。
   * 経路が変わらない描き直し（由来の取り直しで同じ図になった等）では動かさない
   */
  const liveSig = liveData
    ? (() => { const b = pathBounds(liveData.ds); return `${liveData.ds.nodes.length}/${liveData.ds.hops.length}/${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}`; })()
    : null;
  const lastLiveSig = useRef<string | null>(null);
  useEffect(() => {
    if (liveSig === lastLiveSig.current) return;
    lastLiveSig.current = liveSig;
    if (liveSig) requestFit('path');
    else fitModeRef.current = 'all';
  }, [liveSig, requestFit]);

  /* 全体表示のままなら、覆われない領域が変わったときに収め直す */
  const layoutSig = `${Object.values(panels).map(Number).join('')}${Number(compact.preview)}${Number(compact.runtime)}:${viewport.w}x${viewport.h}`;
  const lastLayoutSig = useRef(layoutSig);
  useEffect(() => {
    if (layoutSig === lastLayoutSig.current) return;
    lastLayoutSig.current = layoutSig;
    if (autoFitRef.current) requestFit();
  }, [layoutSig, requestFit]);

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
    // 前のデータセットのノード・ホップへのホバーを持ち越さない（同じ番号が別のものを指す）
    setHover(null);
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
    setHover(null);
    setTab('overview');
  }, []);

  const zoomBy = useCallback((factor: number, sx?: number, sy?: number) => {
    stopTween();
    autoFitRef.current = false;
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

  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const togglePanel = useCallback((p: PanelId) => {
    // 開き直したプレビューは畳まずに出す（閉じる前に畳んでいたかは持ち越さない）
    if (!panelsRef.current[p] && p === 'preview') setCompactState((c) => (c.preview ? { ...c, preview: false } : c));
    setPanels((s) => ({ ...s, [p]: !s[p] }));
  }, []);

  const setCompact = useCallback((p: CompactId, v: boolean) => {
    setCompactState((c) => (c[p] === v ? c : { ...c, [p]: v }));
  }, []);

  const setViewByUser = useCallback((v: View) => {
    stopTween();
    autoFitRef.current = false;
    setView(v);
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
    selection, scope, hover, hoverNote, tab, panels, compact, showLabels, pageFilter, view, viewport,
    select, clearSelection, setHover, setHoverNote, setTab, togglePanel, setCompact, registerObstacles,
    setViewByUser, setShowLabels, setPageFilter, setView, setViewport, zoomBy, fit, focusOn,
  }), [
    data, live, showLive, clearLive,
    selection, scope, hover, hoverNote, tab, panels, compact, showLabels, pageFilter, view, viewport,
    select, clearSelection, togglePanel, setCompact, registerObstacles, setViewByUser, setViewport, zoomBy, fit, focusOn,
  ]);

  return <ExploreCtx.Provider value={value}>{children}</ExploreCtx.Provider>;
}

export function useExplore() {
  const c = useContext(ExploreCtx);
  if (!c) throw new Error('useExplore must be used inside <ExploreProvider>');
  return c;
}

export { sameRef };
