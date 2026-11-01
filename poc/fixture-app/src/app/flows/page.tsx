'use client';
/* =============================================================================
 * ページ 6/7（PoC-05 の検証対象）。Client Component + API ルート。
 *
 * **1回の読み込みでは通信を起こさない。** 操作ごとに通信を起こす。
 * 「1回の操作で何件の通信が起きたか」を観測の単位にするためである。
 *
 * 必須ケース（指示 第4節）を、それぞれ別のボタンに割り当てている。
 *   1回の操作で1リクエスト         btn-one
 *   複数リクエストの同時実行       btn-parallel（別URL3件）
 *   同じURLへの同時実行           btn-same-parallel（同一URL3件・時間窓では分けられない）
 *   同じURLへの連続リクエスト      btn-same-serial（同一URL3件・直列）
 *   失敗したリクエスト             btn-fail（500）/ btn-missing（404）/ btn-abort（応答なし）
 *   リダイレクト                   btn-redirect（307 → 200）
 *   別コンポーネントからの通信      FetchButton
 * ========================================================================== */
import { useState } from 'react';
import ListingCard, { type Listing } from '../../components/ListingCard';
import FetchButton from '../../components/FetchButton';

const NO_STORE: RequestInit = { cache: 'no-store' };

export default function Flows() {
  const [rows, setRows] = useState<Listing[]>([]);
  const [done, setDone] = useState<string[]>([]);
  const mark = (s: string) => setDone((d) => (d.includes(s) ? d : [...d, s]));

  /* ケース: 1回の操作で1リクエスト */
  const one = async () => {
    const res = await fetch('/api/listings', NO_STORE);
    const data = await res.json();
    setRows(data.listings.slice(0, 2));
    mark('one');
  };

  /* ケース: 複数リクエストの同時実行（別URL） */
  const parallel = async () => {
    const rs = await Promise.all([
      fetch('/api/listings', NO_STORE),
      fetch('/api/stats', NO_STORE),
      fetch('/api/listings/2', NO_STORE),
    ]);
    if (rs.every((r) => r.ok)) mark('parallel');
  };

  /* ケース: 同じURLへの同時実行。時刻の近さでは1件も区別できない */
  const sameParallel = async () => {
    const rs = await Promise.all([
      fetch('/api/listings', NO_STORE),
      fetch('/api/listings', NO_STORE),
      fetch('/api/listings', NO_STORE),
    ]);
    if (rs.every((r) => r.ok)) mark('same-parallel');
  };

  /* ケース: 同じURLへの連続リクエスト */
  const sameSerial = async () => {
    for (let i = 0; i < 3; i++) await fetch('/api/listings', NO_STORE);
    mark('same-serial');
  };

  /* ケース: 失敗（500。サーバー側で例外） */
  const fail = async () => {
    const res = await fetch('/api/boom', NO_STORE);
    mark(`fail-${res.status}`);
  };

  /* ケース: 失敗（404。ハンドラは正常に動いて「無い」と答える） */
  const missing = async () => {
    const res = await fetch('/api/listings/999999', NO_STORE);
    mark(`missing-${res.status}`);
  };

  /* ケース: 応答が返らない失敗。識別情報が存在しない状態を作る */
  const abort = async () => {
    const ac = new AbortController();
    const p = fetch('/api/listings', { ...NO_STORE, signal: ac.signal });
    ac.abort();
    await p.catch(() => mark('abort'));
  };

  /* ケース: リダイレクト。1回の fetch に応答が2つ返る */
  const redirect = async () => {
    const res = await fetch('/api/redirect', NO_STORE);
    mark(`redirect-${res.status}`);
  };

  return (
    <main className="flows">
      <h1>通信の経路（PoC-05）</h1>
      <p className="static">操作するまで通信を起こさない。架空の検証用アプリである。</p>
      <div className="ops">
        <button type="button" id="btn-one" onClick={one}>1件</button>
        <button type="button" id="btn-parallel" onClick={parallel}>同時・別URL</button>
        <button type="button" id="btn-same-parallel" onClick={sameParallel}>同時・同URL</button>
        <button type="button" id="btn-same-serial" onClick={sameSerial}>連続・同URL</button>
        <button type="button" id="btn-fail" onClick={fail}>失敗500</button>
        <button type="button" id="btn-missing" onClick={missing}>失敗404</button>
        <button type="button" id="btn-abort" onClick={abort}>中断</button>
        <button type="button" id="btn-redirect" onClick={redirect}>リダイレクト</button>
        <FetchButton path="/api/stats" label="子から1件" onDone={(s) => mark(`child-${s}`)} />
      </div>
      <div className="grid">
        {rows.map((r) => <ListingCard key={r.id} listing={r} />)}
      </div>
      <p className="done">{done.join(' ')}</p>
    </main>
  );
}
