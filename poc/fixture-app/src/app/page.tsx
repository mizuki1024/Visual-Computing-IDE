'use client';
/* ページ 1/3。PoC-01 の対象は Client Component + API ルートに限る（RSC は PoC-02）。 */
import { useEffect, useState } from 'react';

export default function Home() {
  const [stats, setStats] = useState<{ byRegion: { region: string; n: number }[] } | null>(null);
  useEffect(() => { fetch('/api/stats').then((r) => r.json()).then(setStats); }, []);
  return (
    <main>
      <h1>PoC-01 Fixture（架空の検証用アプリ）</h1>
      <p><a href="/listings">物件一覧</a></p>
      <ul>{stats?.byRegion.map((r) => <li key={r.region}>{r.region}: {r.n}</li>)}</ul>
    </main>
  );
}
