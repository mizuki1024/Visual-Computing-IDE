'use client';
/* =============================================================================
 * <CutMarker> / <EstimateTag> / <StepChip> / <Halo>
 * キャンバスに語を残すのは「観測できていないこと」だけ（表示規則10）。
 * ========================================================================== */
import { type Cut, type TraceNode } from '@/lib/trace';
import { chipWidth } from '@/lib/geometry';

/* SVG の属性では CSS 変数を使わず、スタックをそのまま書く */
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

/** 暗い地の上で文字を読ませるための縁取り */
const halo = {
  stroke: '#05070d', strokeWidth: 3.4, paintOrder: 'stroke', strokeLinejoin: 'round',
} as const;

/** 切断マーカー：追跡しようとしたができなかった（E-07）。線を消さない。 */
export function CutMarker({ cut, k }: { cut: Cut; k: number }) {
  const CUT = cut;
  return (
    <g data-mark="cut">
      <path d={CUT.d} fill="none" stroke="#6d5f44" strokeWidth={1.6 / Math.sqrt(k)}
        strokeDasharray={`${5 / k} ${5 / k}`} />
      <g transform={`translate(${CUT.mark.x},${CUT.mark.y}) rotate(${CUT.mark.angle})`}>
        <path d="M0,-11 L0,11" stroke="#c2a06e" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M8,-7 L19,4 M19,-7 L8,4" stroke="#c2a06e" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      <text x={CUT.text.x} y={CUT.text.y} fontSize="11" fill="#bfa073" {...halo}>{CUT.head}</text>
      <text x={CUT.text.x} y={CUT.text.y + 15} fontSize="10" fill="#7d6a4c" {...halo}>{CUT.sub}</text>
    </g>
  );
}

/** 「推定」チップ。★付きは最弱環。 */
export function EstimateTag({ x, y, label, star, below }: {
  x: number; y: number; label: string; star?: boolean; below?: boolean;
}) {
  const w = star ? 58 : 40;
  return (
    <g style={{ pointerEvents: 'none' }} data-mark={star ? 'estimate-weakest' : 'estimate'}>
      {label && (below
        ? <text x={x - w / 2} y={y + 25} textAnchor="start" fontSize="10.5" fill="#9a90cb" {...halo}>{label}</text>
        : <text x={x} y={y - 18} textAnchor="middle" fontSize="10.5" fill="#9a90cb" {...halo}>{label}</text>)}
      <rect x={x - w / 2} y={y - 10} width={w} height="20" rx="6" fill="#0d1019"
        stroke="#6f66a8" strokeDasharray="4 3" />
      {star ? (<>
        <text x={x - w / 2 + 10} y={y + 4.5} fontSize="11" fill="#cfc6f5">★</text>
        <text x={x + 7} y={y + 4} textAnchor="middle" fontSize="10" fill="#bcb2ec">推定</text>
      </>) : (
        <text x={x} y={y + 4} textAnchor="middle" fontSize="10" fill="#bcb2ec">推定</text>
      )}
    </g>
  );
}

/** 層のラベル。物理的実体の足元に置く。 */
export function PlinthLabel({ x, y, text, sub }: { x: number; y: number; text: string; sub?: string }) {
  return (
    <g style={{ pointerEvents: 'none' }}>
      <text x={x} y={y} textAnchor="middle" fontSize="10.5" fill="#79839a" {...halo}>{text}</text>
      {sub && (
        <text x={x} y={y + 14} textAnchor="middle" fontSize="9.5" fill="#545d72"
          fontFamily={MONO} {...halo}>{sub}</text>
      )}
    </g>
  );
}

/**
 * ラベル札：丸バッジ + 種別名 + 識別子。
 * 属性値（所要時間・行数・SQL断片）は置かない。詳細パネルの担当（UI-15）。
 */
/**
 * ラベル札。badge は「現在のスコープ内の表示順序」であって識別子ではない（02 5.3節）。
 * ページスコープ（段階0）では null が渡り、番号を出さない。
 */
export function StepChip({ node, selected, badge }: {
  node: TraceNode; selected: boolean; badge: number | null;
}) {
  const sub = node.chipSub;
  const w = chipWidth({ title: node.title, identifier: sub }, badge !== null);
  const h = sub ? 44 : 32;
  const x = node.chip.x - w / 2;
  const y = node.chip.y - h / 2;
  const cy = node.chip.y;
  const tx = badge !== null ? x + 38 : x + 13;
  return (
    <g style={{ pointerEvents: 'none' }} data-mark="chip" data-node={node.id}>
      <rect x={x} y={y} width={w} height={h} rx="9" fill="rgba(11,14,21,.90)"
        stroke={selected ? '#6f66a8' : '#39356a'} strokeWidth={selected ? 1.4 : 1} />
      {badge !== null && (
        <g className="chipbadge">
          <circle cx={x + 21} cy={cy} r="11" fill={selected ? '#8178c4' : '#6f6aa8'}
            stroke="#0f1218" strokeWidth="1.6" />
          <text x={x + 21} y={cy + 4} textAnchor="middle" fontSize="11.5" fontWeight="700"
            fill="#f0ecff">{badge}</text>
        </g>
      )}
      {sub ? (<>
        <text x={tx} y={cy - 3} fontSize="12" fill="#e4e8f0">{node.title}</text>
        <text x={tx} y={cy + 12} fontSize="9.5" fill="#8d97ab" fontFamily={MONO}>{sub}</text>
      </>) : (
        <text x={tx} y={cy + 4} fontSize="12" fill="#e4e8f0">{node.title}</text>
      )}
    </g>
  );
}

/** 経路外のノードに添える小さな識別子 */
export function DimLabel({ x, y, text, anchor = 'middle', mono }: {
  x: number; y: number; text: string; anchor?: 'start' | 'middle'; mono?: boolean;
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize="9.5" fill="#434b5d"
      fontFamily={mono ? MONO : undefined} {...halo}>{text}</text>
  );
}
