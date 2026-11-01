'use client';
/* ミニマップ。いま見ている範囲を実際の視点から描く。 */
import { contentBounds } from '@/lib/geometry';
import { summarizePage } from '@/lib/derive';
import { useExplore } from '@/state/ExploreStore';
import FloatingPanel from './FloatingPanel';

const W = 234;
const H = 92;
const PAD = 8;

export default function MinimapPanel() {
  const { data, view, viewport } = useExplore();
  const page = summarizePage(data);
  const c = contentBounds(data);
  // 視野の枠が常に見えるよう、内容の範囲を少し広げた世界を描く
  const m = 0.14;
  const b = { x: c.x - c.w * m, y: c.y - c.h * m, w: c.w * (1 + m * 2), h: c.h * (1 + m * 2) };
  const s = Math.min((W - PAD * 2) / b.w, (H - PAD * 2) / b.h);
  const ox = (W - b.w * s) / 2 - b.x * s;
  const oy = (H - b.h * s) / 2 - b.y * s;
  const at = (x: number, y: number) => ({ x: x * s + ox, y: y * s + oy });

  // いま見えている範囲（設計空間）を、ミニマップの座標へ写す
  const vx0 = (0 - view.x) / view.k;
  const vy0 = (0 - view.y) / view.k;
  const vw = viewport.w / view.k;
  const vh = viewport.h / view.k;
  const a = at(vx0, vy0);

  return (
    <FloatingPanel id="minimap" title="全体"
      right={<i>{page.pathShown} / {page.pathTotal} 経路</i>}
      style={{ left: 16, top: 792, width: 236 }}>
      <div className="mmwrap">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="全体図">
          <defs><clipPath id="mmclip"><rect x="0" y="0" width={W} height={H} /></clipPath></defs>
          <rect x="0" y="0" width={W} height={H} fill="#070a11" />
          {/* 経路外 */}
          {data.offPath.nodes.map((o, i) => {
            const p = at(o.x, o.y);
            return <circle key={i} cx={p.x} cy={p.y} r="3" fill="#12161f" stroke="#2a3142" />;
          })}
          {/* ホップ。線の形の区別はミニマップでも保つ */}
          {data.hops.map((h) => (
            <path key={h.id} d={h.d} fill="none"
              stroke={h.observability === 'estimated' ? '#5d55a0' : '#46527a'}
              strokeWidth={1.2 / s}
              strokeDasharray={h.observability === 'estimated' ? `${4 / s} ${3 / s}` : undefined}
              transform={`translate(${ox},${oy}) scale(${s})`} />
          ))}
          {data.nodes.map((n, i) => {
            const p = at(n.x, n.y);
            return <circle key={n.id} cx={p.x} cy={p.y} r={i === 0 ? 4.5 : 4}
              fill="#1d2536" stroke="#6f66a8" />;
          })}
          <rect x={a.x} y={a.y} width={vw * s} height={vh * s} rx="4" fill="none"
            stroke="#7e76bd" strokeWidth="1.2" opacity=".8" clipPath="url(#mmclip)" />
        </svg>
      </div>
    </FloatingPanel>
  );
}
