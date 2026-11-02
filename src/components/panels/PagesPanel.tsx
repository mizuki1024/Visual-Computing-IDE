'use client';
import { useExplore } from '@/state/ExploreStore';
import FloatingPanel from './FloatingPanel';

export default function PagesPanel() {
  const { data, pageFilter, setPageFilter } = useExplore();
  const q = pageFilter.trim().toLowerCase();
  const list = data.pages.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
  );
  return (
    <FloatingPanel id="pages" title="ページ" style={{ left: 16, top: 16, width: 200 }}>
      <div className="srch">
        <span aria-hidden>⌕</span>
        <input value={pageFilter} onChange={(e) => setPageFilter(e.target.value)}
          placeholder="ページを絞り込み…" aria-label="ページを絞り込み" />
      </div>
      <div className="pglist">
        {list.map((p) => (
          <div key={p.path} className={`pg${p.current ? ' on' : ''}`}>
            <u aria-hidden>{p.icon}</u>
            <div><b>{p.name}</b><s>{p.path}</s></div>
          </div>
        ))}
        {list.length === 0 && (
          <p className="pgnone">
            {data.pages.length === 0 ? 'まだページを観測していません' : '一致するページがありません'}
          </p>
        )}
      </div>
      <p className="pgnone" style={{ paddingTop: 0 }}>
        ページの切替は未実装です（観測しているページの経路だけを描いています）
      </p>
    </FloatingPanel>
  );
}
