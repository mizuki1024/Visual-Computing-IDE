'use client';
/* =============================================================================
 * 段階0（未選択）の詳細パネル。
 *
 * 03c 5.1 / 02b 2.2 は「選択が無いとき詳細パネルを格納」と定めているが、Phase 4B で
 * 右の詳細パネルは**固定・開閉しない**と決まった。格納できないため、空パネルを出す
 * 代わりに「このページの概要」を置く。ST-16（未選択を空パネルにしない）の目的は
 * こちらのほうが直接に満たせる。
 *
 * 出してよいもの（03b 4.2節 / 03a 5節）:
 *   通信 N 件 ／ SQL N 件 ／ 総 Nms ／ 推定を含む旨 ／ 追跡できない箇所
 * 出さないもの:
 *   属性値、所要時間の個別値、L0〜L3、SQL断片、生データ、最弱環の名指し（段階2の担当）
 *
 * 数値はすべて summarizePage() の導出値である。定数を持たない。
 * ========================================================================== */
import { useMemo } from 'react';
import { summarizePage } from '@/lib/derive';
import { PATH_DETAIL_LABEL } from '@/lib/trace';
import { useExplore } from '@/state/ExploreStore';

export default function PageOverview() {
  const { data } = useExplore();
  const s = useMemo(() => summarizePage(data), [data]);

  return (
    <section className="sum ov" aria-label="このページの概要">
      <div className="k">このページの読み込み</div>
      <div className="claim">
        <span className="src">{s.page.path}</span>
        <span className="ov-page">{s.page.name}</span>
      </div>

      <dl className="ov-stats">
        <dt>通信</dt><dd>{s.httpCount} 件</dd>
        <dt>SQL</dt><dd>{s.sqlCount} 件</dd>
        <dt>計測できた時間</dt>
        <dd>
          {s.measuredMs} ms
          {s.timedHttpCount < s.httpCount && (
            <i>（通信 {s.timedHttpCount} / {s.httpCount} 件ぶん）</i>
          )}
        </dd>
        <dt>表示中の経路</dt>
        <dd>
          {s.pathShown} / {s.pathTotal}
          {/* 2経路あるのに1つしか開けない、を不具合に見せない。詳細の持ちぐあいで区別する */}
          {s.pathsByDetail['not-retrieved'] > 0 && (
            <i>（他 {s.pathsByDetail['not-retrieved']} 件は{PATH_DETAIL_LABEL['not-retrieved']}）</i>
          )}
          {s.pathsByDetail.unavailable > 0 && (
            <i>（他 {s.pathsByDetail.unavailable} 件は{PATH_DETAIL_LABEL.unavailable}）</i>
          )}
        </dd>
      </dl>

      {/* 俯瞰における OBS-02 の実体。値も確度も出さず、この1行で伝える（03a 5節） */}
      {s.estimatedCount > 0 && (
        <p className="ov-flag est">
          <span className="chip-est">推定</span>
          推定を含みます（{s.estimatedCount} か所）
        </p>
      )}
      {s.untraceableCount > 0 && (
        <p className="ov-flag cut">
          <span aria-hidden>✕</span>
          追跡できない箇所が {s.untraceableCount} 件あります
        </p>
      )}

      <p className="hint">
        プレビューかフロー図で値を選ぶと、その出所をたどれます。
      </p>
      {/* 数値の出所を必ず書く。合成か実測かはデータセットが知っている */}
      <p className="ov-synth">{data.overviewNote}</p>
    </section>
  );
}
