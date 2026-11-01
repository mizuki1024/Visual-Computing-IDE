/* =============================================================================
 * ページ 7/7（PoC-05 の検証対象）。**Server Component**。
 *
 * サーバー側から自分の API ルートへ fetch する。ブラウザから見える通信は
 * **文書の取得1件だけ**であり、サーバー内部の通信はブラウザに現れない。
 * 「Server Component が関与する通信」をどこまで接続できるかを測る題材である。
 * ========================================================================== */
import ListingCard, { type Listing } from '../../components/ListingCard';

export const dynamic = 'force-dynamic';

const ORIGIN = process.env.POC05_SELF_ORIGIN ?? 'http://127.0.0.1:3200';

export default async function FlowsRsc() {
  const res = await fetch(`${ORIGIN}/api/listings`, { cache: 'no-store' });
  const data: { listings: Listing[] } = await res.json();
  return (
    <main className="flows-rsc">
      <h1>通信の経路（サーバー描画）</h1>
      <p className="static">この通信はサーバーの中で起きている。</p>
      <div className="grid">
        {data.listings.slice(0, 2).map((r) => <ListingCard key={r.id} listing={r} />)}
      </div>
    </main>
  );
}
