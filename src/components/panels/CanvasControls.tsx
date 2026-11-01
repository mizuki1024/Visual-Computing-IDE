'use client';
/* =============================================================================
 * キャンバス操作。全体表示・拡縮と、浮かぶパネルの開閉。
 *
 * 参考画像にあった「検索」と「表示 立体」は置いていない。
 *  - 検索 … 02b の N0 構成に無く、IA 上は未定義（申し送り 3章）
 *  - 表示の切替 … Physical View が画面か表示方式かが未確定（申し送り 10章 #4）
 * どちらも押せるのに何も起きない席になるため、IX-23 / IX-24 により置かない。
 * ========================================================================== */
import { useExplore, type PanelId } from '@/state/ExploreStore';

const TOGGLES: [PanelId, string][] = [
  ['pages', 'ページ'], ['preview', 'プレビュー'], ['legend', '表示設定'], ['minimap', '全体'],
  ['runtime', '実行'],
];

export default function CanvasControls() {
  const { panels, togglePanel, zoomBy, fit, view } = useExplore();
  return (
    <div className="ctl" style={{ right: 16, top: 16 }} role="toolbar" aria-label="キャンバス操作"
      onPointerDown={(e) => e.stopPropagation()}>
      {TOGGLES.map(([id, label]) => (
        <button key={id} type="button" className={`b tgl${panels[id] ? ' on' : ''}`}
          aria-pressed={panels[id]} onClick={() => togglePanel(id)}>
          {label}
        </button>
      ))}
      <div className="sep" />
      <button type="button" className="b" onClick={fit} title="全体表示（0）">全体表示</button>
      <div className="sep" />
      <button type="button" className="b ic" onClick={() => zoomBy(1 / 1.2)}
        aria-label="縮小（−）" title="縮小（−）">−</button>
      <span className="b val" aria-live="polite">{Math.round(view.k * 100)}%</span>
      <button type="button" className="b ic" onClick={() => zoomBy(1.2)}
        aria-label="拡大（＋）" title="拡大（＋）">＋</button>
    </div>
  );
}
