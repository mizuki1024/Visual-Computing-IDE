'use client';
/* =============================================================================
 * ★ブロック。独立した塊にする — 最弱環が無い経路では丸ごと消せること
 * （03 10.4 申し送り1）。確度ラベル・確度% は出さない（NFR-17 / UXR-12）。
 * ========================================================================== */
import { hopArrow, needsCaveat, VALUE_MATCH_CAVEAT } from '@/lib/derive';
import type { TraceHop } from '@/lib/trace';
import { useExplore } from '@/state/ExploreStore';

export default function WeakestLink({ hop }: { hop: TraceHop }) {
  const { select } = useExplore();
  return (
    <section className="weak">
      <div className="wt"><span aria-hidden>★</span> いちばん弱いところ</div>
      <div className="wh"><u>{hopArrow(hop)}</u>{hop.label}</div>
      <p>{hop.weakness}</p>
      <div className="ev">
        根拠 {hop.evidence.length} 件：{hop.evidence.map((e, i) => (
          <span key={e}>{i > 0 && ' ／ '}<b>{e}</b></span>
        ))}
        {needsCaveat(hop.evidence) && <><br />{VALUE_MATCH_CAVEAT}</>}
      </div>
      <button type="button" className="btn"
        onClick={() => select({ type: 'hop', id: hop.id }, { focus: true })}>
        ここを見る
      </button>
    </section>
  );
}
