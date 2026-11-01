/* =============================================================================
 * 立体感は SVG + CSS で作る（Three.js は使わない）。
 *  - 物理的実体（ブラウザ・開発サーバー・PostgreSQL）… 不透明・接地影あり
 *  - 概念モジュール（コンポーネント・通信・SQL・カラム）… 半透明・影を落とさない
 * gen_physical.py の laptop() / rack() / dbstack() / glass_tile() を写したもの。
 * ========================================================================== */
import type { NodeKind } from '@/lib/trace';
import { Glyph, ReactGlyph } from './Glyphs';

export function GlassTile({ cx, cy, w, kind, dim, component }: {
  cx: number; cy: number; w: number; kind: NodeKind; dim?: boolean; component?: boolean;
}) {
  const h = w * 0.86;
  const th = 9;
  const st = dim ? '#2a3142' : '#6f66a8';
  const fill = dim ? 'url(#gGlassDim)' : 'url(#gGlass)';
  return (
    <>
      {/* 厚み（側面）。接地影は落とさない */}
      <path
        d={`M${cx - w / 2},${cy - h / 2 + th} L${cx - w / 2},${cy + h / 2} L${cx + w / 2},${cy + h / 2} L${cx + w / 2},${cy - h / 2 + th} Z`}
        fill="#090d15" stroke={st} strokeOpacity=".4" strokeWidth="1" />
      <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={w * 0.16}
        fill={fill} stroke={st} strokeWidth="1.2" />
      <rect x={cx - w / 2 + 3} y={cy - h / 2 + 3} width={w - 6} height={h - 6} rx={w * 0.13}
        fill="none" stroke="#b3abe8" strokeOpacity={dim ? 0.07 : 0.17} />
      {component
        ? <ReactGlyph cx={cx} cy={cy} w={w} />
        : <Glyph kind={kind} cx={cx} cy={cy} w={w} dim={dim} />}
    </>
  );
}

/** ① ブラウザ — 選択中の値のハイライトを画面の中に持つ */
export function Laptop({ cx, cy, w }: { cx: number; cy: number; w: number }) {
  const sw = w * 0.80;
  const sh = w * 0.52;
  const screen = `M${cx - sw / 2},${cy - sh - 10} L${cx + sw / 2},${cy - sh - 18} L${cx + sw / 2},${cy + 2} L${cx - sw / 2},${cy + 8} Z`;
  const clipId = `lcScreen-${Math.round(cx)}-${Math.round(cy)}`;
  const hx = cx - sw * 0.16;
  const hy = cy - sh * 0.22;
  return (
    <>
      <ellipse cx={cx} cy={cy + w * 0.30} rx={w * 0.56} ry={w * 0.13}
        fill="#000" opacity=".5" filter="url(#blurM)" />
      <path d={screen} fill="#1a2030" />
      <path d={screen} fill="url(#gScreen)" stroke="#49527a" strokeWidth="1.4" />
      <clipPath id={clipId}>
        <path d={`M${cx - sw / 2 + 5},${cy - sh - 6} L${cx + sw / 2 - 5},${cy - sh - 13} L${cx + sw / 2 - 5},${cy - 2} L${cx - sw / 2 + 5},${cy + 3} Z`} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect x={cx - sw / 2} y={cy - sh - 18} width={sw} height={sh + 26} fill="#eef2f6" />
        <rect x={cx - sw / 2} y={cy - sh - 14} width={sw} height={sh * 0.42} fill="#7ea8c0" />
        <rect x={cx - sw / 2 + 8} y={cy - sh * 0.36} width={sw * 0.40} height={sh * 0.40} rx="3" fill="#fff" />
        <rect x={cx - sw / 2 + 12} y={cy - sh * 0.30} width={sw * 0.14} height={sh * 0.26} rx="2" fill="#8fae87" />
        <rect x={cx + 2} y={cy - sh * 0.38} width={sw * 0.40} height={sh * 0.40} rx="3" fill="#fff" />
        <rect x={cx + 6} y={cy - sh * 0.32} width={sw * 0.14} height={sh * 0.26} rx="2" fill="#a8b6bf" />
      </g>
      {/* 選択中の値（① の実体） */}
      <rect x={hx} y={hy} width={sw * 0.19} height={sh * 0.13} rx="2.5"
        fill="rgba(157,147,224,.30)" stroke="#cfc6f5" strokeWidth="1.4" />
      <path
        d={`M${cx - sw / 2 - 8},${cy + 8} L${cx + sw / 2 + 8},${cy + 2} L${cx + sw / 2 + 16},${cy + 15} L${cx - sw / 2 - 16},${cy + 22} Z`}
        fill="#262c3d" stroke="#454d6b" strokeWidth="1.2" />
    </>
  );
}

/** ④ 開発サーバー */
export function Rack({ cx, cy, w }: { cx: number; cy: number; w: number }) {
  const h = w * 0.98;
  const dx = w * 0.26;
  const dy = w * 0.17;
  const units = [0, 1, 2].map((i) => {
    const uy = cy - h / 2 + 9 + (i * (h - 18)) / 3;
    const uh = (h - 22) / 3;
    const col = i !== 1 ? '#78b79a' : '#8aa4cc';
    return (
      <g key={i}>
        <rect x={cx - w / 2 + 7} y={uy} width={w - 14} height={uh} rx="3"
          fill="#141a27" stroke="#39415c" strokeWidth="1" />
        {[0, 1, 2, 3, 4].map((k) => (
          <rect key={k} x={cx - w / 2 + 13 + k * 4.6} y={uy + uh * 0.55} width="2.6"
            height={uh * 0.22} rx="1.2" fill="#2f3850" />
        ))}
        <circle cx={cx + w / 2 - 13} cy={uy + uh * 0.5} r="2.6" fill={col} />
        <circle cx={cx + w / 2 - 13} cy={uy + uh * 0.5} r="6" fill={col} opacity=".22" filter="url(#blurS)" />
      </g>
    );
  });
  return (
    <>
      <ellipse cx={cx} cy={cy + h / 2 + 8} rx={w * 0.62} ry={w * 0.15}
        fill="#000" opacity=".5" filter="url(#blurM)" />
      <path d={`M${cx - w / 2},${cy - h / 2} L${cx - w / 2 + dx},${cy - h / 2 - dy} L${cx + w / 2 + dx},${cy - h / 2 - dy} L${cx + w / 2},${cy - h / 2} Z`}
        fill="#2b3245" stroke="#4e5878" strokeWidth="1.1" />
      <path d={`M${cx + w / 2},${cy - h / 2} L${cx + w / 2 + dx},${cy - h / 2 - dy} L${cx + w / 2 + dx},${cy + h / 2 - dy} L${cx + w / 2},${cy + h / 2} Z`}
        fill="#1b2130" stroke="#434c68" strokeWidth="1.1" />
      <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx="5"
        fill="url(#gRack)" stroke="#525c7e" strokeWidth="1.3" />
      {units}
    </>
  );
}

/** ⑥ PostgreSQL — 選択中のテーブル層だけを明るくする */
export function DbStack({ cx, cy, w }: { cx: number; cy: number; w: number }) {
  const rx = w * 0.5;
  const ry = w * 0.17;
  const lay = w * 0.26;
  const layers = [2, 1, 0].map((i) => {
    const yy = cy + (i - 1) * lay;
    return (
      <g key={i}>
        <path d={`M${cx - rx},${yy} L${cx - rx},${yy + lay} A${rx},${ry} 0 0 0 ${cx + rx},${yy + lay} L${cx + rx},${yy} Z`}
          fill="url(#gDb)" stroke="#4e5878" strokeWidth="1.1" />
        <ellipse cx={cx} cy={yy} rx={rx} ry={ry} fill="#242c45" stroke="#5f6a90" strokeWidth="1.1" />
      </g>
    );
  });
  const sel = cy - lay;
  return (
    <>
      <ellipse cx={cx} cy={cy + lay * 1.5 + 10} rx={w * 0.56} ry={w * 0.14}
        fill="#000" opacity=".5" filter="url(#blurM)" />
      {layers}
      <path d={`M${cx - rx},${sel} L${cx - rx},${sel + lay} A${rx},${ry} 0 0 0 ${cx + rx},${sel + lay} L${cx + rx},${sel} Z`}
        fill="rgba(157,147,224,.14)" stroke="#8178c4" strokeWidth="1.3" />
      <ellipse cx={cx} cy={sel} rx={rx} ry={ry} fill="#2b3150" stroke="#9d93e0" strokeWidth="1.3" />
    </>
  );
}
