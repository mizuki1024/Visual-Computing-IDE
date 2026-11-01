/* =============================================================================
 * ページ 5/5（PoC-03）。**Server Component**。'use client' を付けない。
 *
 * 目的は1つだけ: ビルド時に注入した要素識別子が、サーバーで描かれた HTML にも
 * 残るかを見る。**データの経路（RSC が DB を直読みする線）は観測していない**
 * （PoC-02 の範囲）。そのためこのページでは合成データを直書きしている。
 * ========================================================================== */
import RegionBadge from '../../components/RegionBadge';

const SAMPLE = [
  { id: 1, code: 'No.900001', region: 'アオバ台' },
  { id: 2, code: 'No.900002', region: 'シラカワ野' },
];

export default function CardsRsc() {
  return (
    <main className="cards-rsc">
      <h1>物件カード（サーバー描画）</h1>
      <ul>
        {SAMPLE.map((s) => (
          <li key={s.id}>
            <span className="code">{s.code}</span>
            <RegionBadge region={s.region} />
          </li>
        ))}
      </ul>
    </main>
  );
}
