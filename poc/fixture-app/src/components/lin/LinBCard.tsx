/* PoC-04 ケース B — 中段のコンポーネント。
 * 受け取った label を **さらに別名（text）で** 子へ渡す。
 * tier はこのファイルで描く。どちらも由来はこのファイルから見えない。 */
import LinBLabel from './LinBLabel';

export default function LinBCard({ label, tier }: { label: string; tier: string }) {
  return (
    <article className="lin-b-card">
      <LinBLabel text={label} />
      <span data-poc-field="b-tier">{tier}</span>
    </article>
  );
}
