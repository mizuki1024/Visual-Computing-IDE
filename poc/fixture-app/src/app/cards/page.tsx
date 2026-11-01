'use client';
/* =============================================================================
 * ページ 4/4（PoC-03 の検証対象）。Client Component + API ルート。
 *
 * 1回の読み込みで、PoC-03 の必須ケースが全部そろうように置いてある。
 *   * 単純な表示値                 → <h1> / <p className="static">
 *   * props で受け取る値           → ListingCard
 *   * 同じコンポーネントを複数回   → ListingCard を行数ぶん描く
 *   * ネスト                       → ListingCard > RegionBadge
 *   * ライブラリ由来（注入不能）   → VendorPanel（src/ の外・JSX 無し）
 *   * ソース位置が取れない場合     → useEffect で DOM に直接足した要素
 * ========================================================================== */
import { captureOwnerStack, useEffect, useRef, useState } from 'react';
import ListingCard, { type Listing } from '../../components/ListingCard';
import { VendorPanel } from '../../../vendor-ui/index.js';

export default function Cards() {
  const [rows, setRows] = useState<Listing[]>([]);
  const slot = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch('/api/listings').then((r) => r.json()).then((d) => setRows(d.listings.slice(0, 3)));
  }, []);

  useEffect(() => {
    // JSX を経由せず DOM へ直接足した要素。注入する元の JSX が存在しない
    if (!slot.current || slot.current.childElementCount) return;
    const el = document.createElement('span');
    el.className = 'injected';
    el.textContent = '直接生成';
    slot.current.appendChild(el);
  }, []);

  /* 方式3 の実測点: React の **公開API** だけでどこまで分かるかを見る。
   * captureOwnerStack は「いま描いている／いま処理しているコンポーネント」の
   * 由来を返す。クリックされた DOM 要素の由来を問う口は公開APIに無い。 */
  const probe = () => {
    (window as unknown as Record<string, unknown>).__vcideOwnerStack = captureOwnerStack() ?? null;
  };

  return (
    <main className="cards" onClick={probe}>
      <h1>物件カード</h1>
      <p className="static">合成データのみ。実在の地名も個人情報も含まない。</p>
      <div className="grid">
        {rows.map((r) => <ListingCard key={r.id} listing={r} />)}
      </div>
      <VendorPanel title="ライブラリ由来の枠">
        <span className="in-slot">枠の中身はこのファイルの JSX である</span>
      </VendorPanel>
      <div className="slot" ref={slot} />
    </main>
  );
}
