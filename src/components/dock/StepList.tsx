'use client';
/* =============================================================================
 * 番号付きリスト。ノードの行と、ノードへ至るホップの関係行からなる。
 * ステップバッジの番号はアニメーションさせない（03b 8.3節）。
 * ========================================================================== */
import { useEffect, useRef } from 'react';
import type { LaidOutDataset } from '@/lib/layout';
import { type SelectionRef, type TraceHop, type TraceNode } from '@/lib/trace';
import { circled, hopArrow, identifierOf, metricsText, word } from '@/lib/derive';
import { useExplore, sameRef } from '@/state/ExploreStore';

/** 各ノードへ至るホップ。同じノードに複数入る場合は、たどった順に先に来るほう。 */
function spine(ds: LaidOutDataset): { node: TraceNode; via: TraceHop | null }[] {
  return ds.nodes.map((node) => {
    const incoming = ds.hops.filter((h) => h.to === node.id).sort((a, b) => a.order - b.order);
    return { node, via: incoming[0] ?? null };
  });
}
/** ノードの並び順での位置。経路を戻るホップの判定に使う。 */
function orderIndex(ds: LaidOutDataset): Map<number, number> {
  return new Map(ds.nodes.map((n, i) => [n.id, i]));
}

/**
 * 背骨に現れないホップのうち、**経路を戻るもの**（`maps` のように、
 * すでに通ったノードへ向かうもの）。★行として末尾に置く。
 */
function returning(ds: LaidOutDataset): TraceHop[] {
  const used = new Set(spine(ds).map((s) => s.via?.id).filter(Boolean));
  const at = orderIndex(ds);
  return ds.hops.filter((h) => !used.has(h.id)
    && (at.get(h.to) ?? 0) < (at.get(h.from) ?? 0));
}

/**
 * 背骨に現れないホップのうち、**戻らないもの**。
 *
 * 1つのノードに2本以上の関係が入る構成で出る（PoC-02: 同じ実行SQLに対して
 * スパンの親子（executes）と呼び出しスタック（queries）の2本が入る）。
 * ★行（「経路を戻ります・いちばん弱いところ」）として出すと**嘘になる**ので、
 * そのノードの行の下に、もう1本の関係として並べる。
 */
function extraIncoming(ds: LaidOutDataset): Map<number, TraceHop[]> {
  const used = new Set(spine(ds).map((s) => s.via?.id).filter(Boolean));
  const at = orderIndex(ds);
  const out = new Map<number, TraceHop[]>();
  for (const h of ds.hops) {
    if (used.has(h.id)) continue;
    if ((at.get(h.to) ?? 0) < (at.get(h.from) ?? 0)) continue;   // 戻るホップは ★ 行へ
    const l = out.get(h.to);
    if (l) l.push(h);
    else out.set(h.to, [h]);
  }
  return out;
}

function Overview({ node }: { node: TraceNode }) {
  const { select } = useExplore();
  return (
    <div className="ovw">
      <dl>
        {node.overview.map((r) => (
          <div key={r.k} style={{ display: 'contents' }}>
            <dt>{r.k}</dt>
            {r.go ? (
              <dd className="step">
                <button type="button" onClick={() => select(r.go!, { focus: true })}>{r.v}</button>
              </dd>
            ) : (
              // 1行で省略される。省略された全文はホバーで読めるようにする（Phase 7B-2）
              <dd title={r.fromMetrics ? undefined : r.v}>{r.fromMetrics ? metricsText(node) : r.v}</dd>
            )}
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function StepList() {
  const { data, selection, hover, select, setHover, focusOn } = useExplore();
  const rows = spine(data);
  const back = returning(data);
  const extra = extraIncoming(data);
  const curRef = useRef<HTMLDivElement>(null);

  // ★[ここを見る] や「次の一歩」で選択が動いたとき、その行まで送る
  useEffect(() => { curRef.current?.scrollIntoView({ block: 'nearest' }); }, [selection]);

  const hopRow = (h: TraceHop) => {
    const r: SelectionRef = { type: 'hop', id: h.id };
    const on = sameRef(selection, r);
    return (
      <div key={`r-${h.id}`} ref={on ? curRef : undefined}>
        <button type="button"
          className={`rel${h.observability === 'estimated' ? ' est' : ''}${on ? ' sel' : ''}`}
          onClick={() => select(r)} onDoubleClick={() => focusOn(r)}
          onPointerEnter={() => setHover(r)} onPointerLeave={() => setHover(null)}>
          <span className="rc" />
          <span className="rt">
            {h.label}{h.observability === 'estimated' && <i>（推定）</i>}
          </span>
        </button>
      </div>
    );
  };

  return (
    <section className="steps">
      <div className="k">経路のステップ（{data.nodes.length}）</div>
      {rows.map(({ node, via }, i) => {
        const r: SelectionRef = { type: 'node', id: node.id };
        const on = sameRef(selection, r);
        return (
          <div key={node.id}>
            {via && hopRow(via)}
            {/* そのノードへ入る2本目以降の関係。★行にはしない（戻っていない） */}
            {(extra.get(node.id) ?? []).map((h) => hopRow(h))}
            <div ref={on ? curRef : undefined}>
              <button type="button"
                className={`st${on ? ' cur' : ''}${sameRef(hover, r) ? ' hov' : ''}`}
                onClick={() => select(r)} onDoubleClick={() => focusOn(r)}
                onPointerEnter={() => setHover(r)} onPointerLeave={() => setHover(null)}>
                {/*
                  * 次のステップへ縦線を引くのは、次のステップが**ホップで
                  * たどり着けている**ときだけである。観測した塊が2つに分かれて
                  * いるとき（PoC-03 / PoC-05）、間に線を引くと、関係が無いのに
                  * 続いているように読める（OBS-05）。
                  */}
                {i < rows.length - 1 && rows[i + 1].via !== null && <span className="conn" />}
                <span className="bd">{node.id}</span>
                <span className="tx">
                  <span className="tt">{node.title}</span>
                  <span className="ts">{identifierOf(node)}</span>
                </span>
                <span className="tag">{word(node.observability)}</span>
              </button>
            </div>
            {on && <Overview node={node} />}
          </div>
        );
      })}

      {back.map((h) => {
        const r: SelectionRef = { type: 'hop', id: h.id };
        const on = sameRef(selection, r);
        return (
          <div key={h.id} ref={on ? curRef : undefined}>
            <button type="button" className={`ret${on ? ' cur' : ''}`}
              onClick={() => select(r)} onDoubleClick={() => focusOn(r)}
              onPointerEnter={() => setHover(r)} onPointerLeave={() => setHover(null)}>
              <b aria-hidden>★</b>
              <span>
                <u>{hopArrow(h)}</u> ここから {circled(h.to)} の応答へ戻ります（いちばん弱いところ）
              </span>
            </button>
          </div>
        );
      })}
    </section>
  );
}
