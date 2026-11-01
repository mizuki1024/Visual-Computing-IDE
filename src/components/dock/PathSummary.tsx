'use client';
/* =============================================================================
 * 経路サマリ。文言と順序を変えないこと（03 3.5節 / 表示規則8）。
 *   主張 → 二値の語 → 件数と最弱環 → ★ブロック → 番号付きリスト
 * 件数は経路から算出する導出値であり、定数ではない（02d 2.3節）。
 * ========================================================================== */
import { summaryLine, word, type PathSummaryModel } from '@/lib/derive';

export default function PathSummary({ s }: { s: PathSummaryModel }) {
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
