import { PROPERTIES } from '../../data/properties';
import { PropertyCard } from '../../components/PropertyCard';

/* PropertyCard の2つ目の利用箇所（map ではなく1回）。PoC では開かない（未確認の利用箇所として扱う）。 */
export default function FavoritesPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <h1 className="text-xl font-bold">お気に入り</h1>
      <PropertyCard property={PROPERTIES[1]} />
    </main>
  );
}
