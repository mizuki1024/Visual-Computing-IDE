'use client';
/* =============================================================================
 * 「根拠」タブ。根拠は種別と件数のみを出す。
 * 確度ラベル（高/中/低）と確度% は A群では表示しない（NFR-17 / 02d 3.2節）。
 * ========================================================================== */
import { SOURCE_LABEL, byIdIn, hopByIdIn, type SelectionRef } from '@/lib/trace';
import { hopArrow, identifierOf, needsCaveat, spanWindowText, word, VALUE_MATCH_CAVEAT } from '@/lib/derive';
import { useExplore } from '@/state/ExploreStore';

export default function EvidencePanel({ selection }: { selection: SelectionRef }) {
  const { data } = useExplore();
  const isNode = selection.type === 'node';
  const n = isNode ? byIdIn(data, selection.id as number) : null;
  const h = isNode ? null : hopByIdIn(data, selection.id as string);
  const o = (n ?? h)!;
  const head = n ? n.title : `${hopArrow(h!)} ${h!.label}`;
  const sub = n ? identifierOf(n) : h!.relation;
  const weakness = h?.weakness;
  // スパンの時間窓は実測データだけが持つ。無いものを埋めない
  const window_ = n ? spanWindowText(n) : null;

  return (
    <section className="ev-sec">
      <div className="k">選択した箇所の根拠</div>
      <article className="ev-card">
        <div className="eh">{head}</div>
        <div className="es">{sub}</div>
        <dl>
          <dt>観測性</dt><dd>{word(o.observability)}</dd>
          <dt>取得手段</dt><dd>{SOURCE_LABEL[o.source]}</dd>
          {window_ && <><dt>時間窓</dt><dd>{window_}</dd></>}
          <dt>根拠 {o.evidence.length} 件</dt>
          <dd>
            <ul>{o.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
            {needsCaveat(o.evidence) && <p className="caveat">{VALUE_MATCH_CAVEAT}</p>}
          </dd>
          {weakness && <><dt>弱点</dt><dd>{weakness}</dd></>}
        </dl>
      </article>
      <p className="ev-note">
        確度（高・中・低）は表示しません。較正されていない確度は、観測性の表示そのものを
        無意味にするためです。根拠の種別と件数だけを出しています。
      </p>
    </section>
  );
}
