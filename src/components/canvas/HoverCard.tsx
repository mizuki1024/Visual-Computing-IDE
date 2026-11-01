'use client';
/* 段階1（ホバー）: 1行要約 + 観測性の語 + ★。構造化された詳細は出さない。 */
import { useEffect, useState } from 'react';
import { byIdIn, hopByIdIn } from '@/lib/trace';
import { identifierOf } from '@/lib/derive';
import { useExplore } from '@/state/ExploreStore';

export default function HoverCard() {
  const { data, hover, hoverNote } = useExplore();
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const on = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', on);
    return () => window.removeEventListener('pointermove', on);
  }, []);

  const place = {
    left: Math.min((typeof window !== 'undefined' ? window.innerWidth : 0) - 320, pos.x + 16),
    top: Math.min((typeof window !== 'undefined' ? window.innerHeight : 0) - 110, pos.y + 14),
  };

  // 選択できない対象の説明。実測／推定の語は付けない（経路ではないため）
  if (!hover && hoverNote) {
    return (
      <div className="hovcard" role="status" style={place}>
        <b>{hoverNote.head}</b>
        <s>{hoverNote.sub}</s>
        <em className="hn">{hoverNote.note}</em>
      </div>
    );
  }
  if (!hover) return null;

  const isNode = hover.type === 'node';
  const n = isNode ? byIdIn(data, hover.id as number) : null;
  const h = isNode ? null : hopByIdIn(data, hover.id as string);
  const o = (n ?? h)!;
  const est = o.observability === 'estimated';
  // ★ は最弱環の印。どのホップが★かはデータが持つ（ID を決め打ちにしない）
  const star = h?.star === true;
  const head = n ? n.hover : h!.label;
  const sub = n ? identifierOf(n) : h!.relation;

  return (
    <div className="hovcard" role="status" style={place}>
      <b>{star ? '★ ' : ''}{head}</b>
      <s>{sub}</s>
      <i className={est ? 'e' : 'm'}>{est ? '推定' : '実測'}</i>
    </div>
  );
}
