'use client';
/* 浮かぶパネルの枠。ドックパネルとは視覚的に区別する（角丸・影・backdrop-filter）。 */
import type { CSSProperties, ReactNode } from 'react';
import { useExplore, type PanelId } from '@/state/ExploreStore';

/**
 * 7C-2: 畳む／広げるの操作（閉じるとは別）。畳んでもパネルと中身の状態は残る。
 * ボタンは文字で何が起きるかを書き（記号だけにしない）、aria-expanded で状態を伝える。
 * キーボードでは Tab で届き、Enter / Space で押せる（素の button）
 */
export interface PanelFold {
  /** いま広げているか */
  expanded: boolean;
  onToggle: () => void;
  /** 畳んでいるときのボタンの文字（例:「ページを表示」） */
  showLabel: string;
  /** 広げているときのボタンの文字（例:「畳む」） */
  hideLabel: string;
  /** ボタンの説明（title / aria-label の補足） */
  hint?: string;
}

export default function FloatingPanel({ id, title, note, right, style, children, fold }: {
  id: PanelId; title: string; note?: string; right?: ReactNode;
  style: CSSProperties; children: ReactNode; fold?: PanelFold;
}) {
  const { panels, togglePanel } = useExplore();
  if (!panels[id]) return null;
  return (
    <section className={`fpnl${fold && !fold.expanded ? ' folded' : ''}`} style={style} aria-label={title}
      data-folded={fold ? (fold.expanded ? 'off' : 'on') : undefined}
      onPointerDown={(e) => e.stopPropagation()}>
      <header className="fh">
        {title}{note && <i>{note}</i>}
        <span className="r">
          {right}
          {fold && (
            <button type="button" className="fold" aria-expanded={fold.expanded}
              data-fold={id}
              title={fold.hint ?? (fold.expanded ? `${title}を畳む` : `${title}を広げる`)}
              onClick={fold.onToggle}>
              {fold.expanded ? `${fold.hideLabel} ▴` : `${fold.showLabel} ▾`}
            </button>
          )}
          <button type="button" aria-label={`${title}を閉じる`} title={`${title}を閉じる`}
            onClick={() => togglePanel(id)}>✕</button>
        </span>
      </header>
      {children}
    </section>
  );
}
