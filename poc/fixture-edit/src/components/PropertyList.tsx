import type { Property } from '../data/properties';
import { PropertyCard } from './PropertyCard';

export function PropertyList({ items }: { items: Property[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {items.map((p) => (
        <li key={p.no}>
          <PropertyCard property={p} />
        </li>
      ))}
    </ul>
  );
}
