import type { Property } from '../data/properties';

/* 共有部品。外枠の className が編集 PoC の変更対象（p-4 → p-5）。
 * md:p-6 は 768px 以上で優先されるため、Desktop の見た目は変わらないはず。 */
export function PropertyCard({ property }: { property: Property }) {
  return (
    <div className="rounded-lg border bg-white p-4 md:p-6 shadow-sm">
      <div className="flex gap-3">
        <div className="h-16 w-20 shrink-0 rounded bg-emerald-200" aria-hidden="true" />
        <dl className="text-sm">
          <dt className="font-semibold">No.{property.no}</dt>
          <dd>{property.pref}</dd>
          <dd>{property.utility}</dd>
          <dd>竣工 {property.done}</dd>
        </dl>
      </div>
    </div>
  );
}
