/* PoC-03 題材 — 最小構成の検証対象。
 *   * props で値を受け取る
 *   * 1ページに複数回描かれる
 *   * さらに内側のコンポーネント（RegionBadge）を含む
 */
import RegionBadge from './RegionBadge';

export interface Listing { id: number; code: string; region: string }

export default function ListingCard({ listing }: { listing: Listing }) {
  return (
    <article className="card" data-poc-kind="listing-card">
      <header className="card-head">
        <span className="code">{listing.code}</span>
      </header>
      <div className="card-body">
        <RegionBadge region={listing.region} />
      </div>
    </article>
  );
}
