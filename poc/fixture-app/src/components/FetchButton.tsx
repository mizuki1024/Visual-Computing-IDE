/* PoC-05 題材 — **ページとは別のコンポーネント**から通信を起こす。
 * 「通信を起こしたコンポーネント」が、ページのコンポーネントではなく
 * こちらであると特定できるかを試すための題材である。 */
'use client';

export default function FetchButton(
  { path, label, onDone }: { path: string; label: string; onDone: (s: number) => void },
) {
  const run = async () => {
    const res = await fetch(path, { cache: 'no-store' });
    onDone(res.status);
  };
  return (
    <button type="button" className="child-fetch" onClick={run}>{label}</button>
  );
}
