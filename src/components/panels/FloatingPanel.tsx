'use client';
/* 浮かぶパネルの枠。ドックパネルとは視覚的に区別する（角丸・影・backdrop-filter）。 */
import type { CSSProperties, ReactNode } from 'react';
import { useExplore, type PanelId } from '@/state/ExploreStore';

export default function FloatingPanel({ id, title, note, right, style, children }: {
  id: PanelId; title: string; note?: string; right?: ReactNode;
  style: CSSProperties; children: ReactNode;
}) {
  const { panels, togglePanel } = useExplore();
  if (!panels[id]) return null;
  return (
    <section className="fpnl" style={style} aria-label={title}
      onPointerDown={(e) => e.stopPropagation()}>
      <header className="fh">
        {title}{note && <i>{note}</i>}
        <span className="r">
          {right}
          <button type="button" aria-label={`${title}を閉じる`} title={`${title}を閉じる`}
            onClick={() => togglePanel(id)}>✕</button>
        </span>
      </header>
      {children}
    </section>
  );
}
