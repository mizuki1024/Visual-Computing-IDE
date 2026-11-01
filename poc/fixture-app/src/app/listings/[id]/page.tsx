'use client';
/* ページ 3/3。1回の fetch に2本の SQL が対応する（親子関係の確認用）。 */
import { use, useEffect, useState } from 'react';

export default function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{ listing?: Record<string, unknown>; views?: number } | null>(null);
  useEffect(() => { fetch(`/api/listings/${id}`).then((r) => r.json()).then(setData); }, [id]);
  return (
    <main>
      <h1>物件詳細 #{id}</h1>
      <pre>{data ? JSON.stringify(data, null, 2) : '…'}</pre>
    </main>
  );
}
