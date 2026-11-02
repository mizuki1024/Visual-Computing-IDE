/* 条件付きのクラス（EP-03）。推測で書き換えず、理由付きで拒否されるべき対象。 */
export function FilterPanel({ open }: { open: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${open ? 'md:p-6' : 'md:p-2'}`}>
      <span className="text-sm">エリア・電力会社</span>
    </div>
  );
}
