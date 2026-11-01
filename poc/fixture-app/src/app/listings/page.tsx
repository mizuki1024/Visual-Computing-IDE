'use client';
/* ページ 2/3。計装の中心的な題材。1回の fetch に1本の SQL が対応する。 */
import { useEffect, useState } from 'react';

interface Row { id: number; code: string; region: string }

export default function Listings() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { fetch('/api/listings').then((r) => r.json()).then((d) => setRows(d.listings)); }, []);
  return (
    <main>
      <h1>物件一覧</h1>
      <table><tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.code}</td>
            <td data-poc-field="region">{r.region}</td>
            <td><a href={`/listings/${r.id}`}>詳細</a></td>
          </tr>
        ))}
      </tbody></table>
    </main>
  );
}
