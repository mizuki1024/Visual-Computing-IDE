'use client';
/* =============================================================================
 * 経路サマリ。文言と順序を変えないこと（03 3.5節 / 表示規則8）。
 *   主張 → 二値の語 → 件数と最弱環 → ★ブロック → 番号付きリスト
 * 件数は経路から算出する導出値であり、定数ではない（02d 2.3節）。
 *
 * Phase 7C-3（P1-10）: 選んだ値の経路が DB（テーブル・カラム）に届いていないときは、
 * 「この値の出所 <描画位置> 実測」と言わない。描画位置（実測で分かったこと）と、
 * 値の由来（未確認）を別の行に分け、切れた段と理由をここ（右ドック）にも出す。
 * 届いている経路（/lin-a の推定など）の表示は従来どおり。
 * ========================================================================== */
import { summaryLine, word, type PathSummaryModel, type ValueOriginModel } from '@/lib/derive';

export default function PathSummary({ s, vo }: { s: PathSummaryModel; vo: ValueOriginModel | null }) {
  if (vo) return <ValueOriginSummary s={s} vo={vo} />;
  return (
    <section className="sum">
      <div className="k">この値の出所</div>
      <div className="claim">
        <span className="src">{s.claim}</span>
        <span className="chip-est">{word(s.observability)}</span>
      </div>
      <p>{summaryLine(s)}</p>
      {/* 終点まで到達していないことを隠さない。主張を言い切らない（OBS-05） */}
      {s.truncated && (
        <p className="hint">
          ここから先はたどれていません。つながりを観測できていない箇所は、
          キャンバスに「追跡できません」として残しています。
        </p>
      )}
      <p className="hint">実測＝実際に起きたことを観測できた箇所。推定＝コードの形から推測した箇所。</p>
    </section>
  );
}

/** 7C-3: 値の由来が未確認のときのサマリ。見出しで「出所が分かった」と読ませない */
function ValueOriginSummary({ s, vo }: { s: PathSummaryModel; vo: ValueOriginModel }) {
  const r = vo.render;
  return (
    <section className="sum vo" aria-label="選んだ値の描画位置と由来" data-value-origin="unconfirmed">
      <div className="k">選んだ値 — 描画位置と値の由来</div>
      <dl className="vo-rows">
        <dt>描画位置</dt>
        <dd data-vo="render">
          {r.status === 'identified' ? (
            <>
              <span className="vo-st ok">特定済み</span>
              <span className="chip-est">{word(r.observability)}</span>
              <code className="vo-at">{r.at}</code>
              <span className="vo-sub">{r.component}</span>
            </>
          ) : (
            <span className="vo-st no">特定できません</span>
          )}
        </dd>
        <dt>値の由来</dt>
        <dd data-vo="lineage">
          <span className="vo-st no">未確認</span>
          <span className="vo-sub">DB のどのテーブル・カラムから来たかは、まだ分かっていません</span>
        </dd>
        <dt>切れた段階</dt>
        <dd data-vo="stage">{vo.stage ?? '記録されていません'}</dd>
        <dt>理由</dt>
        <dd data-vo="reason" className="vo-reason">{vo.reason}</dd>
      </dl>
      <p>
        {s.total} か所のうち {s.estimated} か所が推定です。
        {r.status === 'identified'
          ? '「実測」は描画位置までの話で、値の出所（DB）が実測で分かったという意味ではありません。'
          : '描画位置が分からないため、その先はたどっていません。'}
      </p>
      <p className="hint">
        描画位置＝この値を画面に描いたコードの場所。値の由来＝その値が DB のどのカラムから来たか。
        未確認＝調べたが、根拠をもって結べなかった（推測では埋めません）。
      </p>
    </section>
  );
}
