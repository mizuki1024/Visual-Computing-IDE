'use client';
/* =============================================================================
 * <FlowScene> ノードとホップ。SVG。
 * 重ね順は gen_physical.py と同じ:
 *   経路外 → ホップ（後ろ） → 切断 → 物理的実体 → 概念モジュール
 *   → ホップ（手前） → 推定の印 → ラベル札
 * ========================================================================== */
import type { SelectionRef, TraceNode } from '@/lib/trace';
import { useExplore, sameRef } from '@/state/ExploreStore';
import { identifierOf, stepBadge } from '@/lib/derive';
import SvgDefs from './SvgDefs';
import { DbStack, GlassTile, Laptop, Rack } from './Objects';
import Hop, { DimmedHop, widthFor } from './Hop';
import { CutMarker, DimLabel, EstimateTag, PlinthLabel, StepChip } from './Marks';

/** ①→② はノートPCの手前を通す。それ以外はオブジェクトの後ろに敷く。 */
const FRONT_HOPS = new Set(['renders']);

export default function FlowScene() {
  const { data, view, scope, selection, hover, select, setHover, setHoverNote, showLabels, focusOn } =
    useExplore();
  const k = view.k;
  // 合成でも実測でも、ここから先は同じ構造を描く
  const { nodes, hops, cuts, offPath, branchPoint } = data;

  const refOf = (n: TraceNode): SelectionRef => ({ type: 'node', id: n.id });
  const stateOf = (r: SelectionRef) =>
    sameRef(selection, r) ? 'selected' : sameRef(hover, r) ? 'hover' : 'normal';

  /** 選択したノードに接するホップ。番号付きリストの関係行と対応する。 */
  const incident = (id: string) => {
    if (selection?.type !== 'node') return false;
    const h = hops.find((x) => x.id === id)!;
    return h.from === selection.id || h.to === selection.id;
  };

  const nodeProps = (n: TraceNode) => {
    const r = refOf(n);
    const st = stateOf(r);
    return {
      className: `nd${st === 'hover' ? ' hov' : ''}${st === 'selected' ? ' sel' : ''}`,
      role: 'button' as const,
      tabIndex: -1,
      'aria-label': `${n.title} ${identifierOf(n)}`,
      onPointerDown: (e: React.PointerEvent) => { e.stopPropagation(); select(r); },
      onPointerEnter: () => setHover(r),
      onPointerLeave: () => setHover(null),
    };
  };

  const hopEls = (layer: 'back' | 'front') =>
    hops.filter((h) => (layer === 'front') === FRONT_HOPS.has(h.id)).map((h) => {
      const r: SelectionRef = { type: 'hop', id: h.id };
      const st = stateOf(r);
      return (
        <Hop key={h.id} hop={h} k={k}
          state={st === 'normal' && incident(h.id) ? 'related' : st}
          onSelect={() => select(r)} onHover={(on) => setHover(on ? r : null)} />
      );
    });

  return (
    <svg className="scene" width="100%" height="100%">
      <SvgDefs />
      <g transform={`translate(${view.x},${view.y}) scale(${k})`}>

        {/*
          経路外 — 減光して残す（UI-33。削除しない）。
          押せる見た目は与えない（詳細が無いので IX-23）。ただしホバーで理由は読める。
        */}
        <g opacity="0.95"
          onPointerEnter={() => setHoverNote({
            head: 'このページの他の通信',
            sub: offPath.label,
            note: offPath.note,
          })}
          onPointerLeave={() => setHoverNote(null)}>
          {offPath.hop && <DimmedHop d={offPath.hop} k={k} />}
          {offPath.nodes.map((o, i) => (
            <GlassTile key={i} cx={o.x} cy={o.y} w={o.size} kind={o.kind} dim />
          ))}
          {showLabels && (<>
            {offPath.nodes.map((o, i) => (
              <DimLabel key={i} x={o.lx} y={o.ly} text={o.label}
                anchor={i === 0 ? 'middle' : 'start'} mono={i === 0} />
            ))}
            {/*
              段階0 では「選択していない経路」と呼べない（選択そのものが無い）。
              減光は残す — これは「まだ出所をたどっていない」という可用性の事実（軸1）で
              あって、選択の有無（軸3）ではないため、状態で変えない（03c ST-01 / ST-02）。
            */}
            <DimLabel x={offPath.caption.x} y={offPath.caption.y}
              text={selection ? offPath.caption.text : offPath.caption.textUnselected}
              anchor="start" />
          </>)}
        </g>

        {/* ホップ（オブジェクトの後ろ） */}
        {hopEls('back')}

        {/* ⑤ の分岐点。⑥ と ⑦ は ⑤ から分かれる（⑥→⑦ の線は存在しない） */}
        <circle cx={branchPoint.x} cy={branchPoint.y} r={4 / Math.sqrt(k)}
          fill="#0b0e14" stroke="#8aa4cc" strokeWidth={widthFor(k, 1.6)} />

        {/* 追跡できなかった箇所。線を消さずに止める */}
        {cuts.map((c, i) => <CutMarker key={i} cut={c} k={k} />)}

        {/* 物理的実体 */}
        {nodes.filter((n) => n.form === 'physical').map((n) => (
          <g key={n.id} {...nodeProps(n)} onDoubleClick={() => focusOn(refOf(n))}>
            {n.kind === 'value' && <Laptop cx={n.x} cy={n.y} w={n.size} />}
            {n.kind === 'server' && <Rack cx={n.x} cy={n.y} w={n.size} />}
            {n.kind === 'table' && <DbStack cx={n.x} cy={n.y} w={n.size} />}
          </g>
        ))}
        {showLabels && nodes.filter((n) => n.plinth).map((n) => (
          <PlinthLabel key={n.id} {...n.plinth!} />
        ))}

        {/* 概念モジュール */}
        {nodes.filter((n) => n.form === 'module').map((n) => (
          <g key={n.id} {...nodeProps(n)} onDoubleClick={() => focusOn(refOf(n))}>
            <GlassTile cx={n.x} cy={n.y} w={n.size} kind={n.kind}
              component={n.kind === 'component'} />
            {n.kind === 'column' && (
              <rect x={n.x - 7} y={n.y - 20} width="13" height="34" rx="2" fill="rgba(157,147,224,.26)" />
            )}
          </g>
        ))}

        {/* ホップ（手前） */}
        {hopEls('front')}

        {/* 推定の印。語を置くのは推定の2本だけ（表示規則10） */}
        {hops.filter((h) => h.tag).map((h) => (
          <EstimateTag key={h.id} x={h.tag!.x} y={h.tag!.y}
            label={showLabels ? h.tag!.label : ''} star={h.star === true} below={h.tag!.below} />
        ))}

        {/* ラベル札 */}
        {showLabels && nodes.map((n) => (
          <g key={n.id}>
            {n.leader && <path d={n.leader} stroke="#4a5370" strokeWidth="1" strokeDasharray="3 3" />}
            {/* バッジはスコープ内の表示順序。段階0（ページスコープ）では出さない */}
            <StepChip node={n} selected={sameRef(selection, refOf(n))}
              badge={stepBadge(data, n.id, scope)} />
          </g>
        ))}
      </g>
    </svg>
  );
}
