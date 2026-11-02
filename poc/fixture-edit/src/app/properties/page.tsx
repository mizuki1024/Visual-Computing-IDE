import { PROPERTIES } from '../../data/properties';
import { FilterPanel } from '../../components/FilterPanel';
import { PropertyList } from '../../components/PropertyList';
import { SiteNotice } from '../../components/SiteNotice';

export default function PropertiesPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <h1 className="text-xl font-bold">物件一覧</h1>
      <SiteNotice />
      <FilterPanel open />
      <p className="text-sm">全 {PROPERTIES.length} 件</p>
      <PropertyList items={PROPERTIES} />
    </main>
  );
}
