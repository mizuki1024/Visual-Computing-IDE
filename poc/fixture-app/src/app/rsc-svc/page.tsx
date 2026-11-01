/* =============================================================================
 * PoC-02 Gate A 1/2 — **サーバーから別のサーバーへの HTTP 要求**。
 *
 * 相手は隔離した2つ目の検証用サービス（別プロセス・別の service.name）である。
 * 2本投げる。
 *   /echo  相手は何もしない（HTTP 1段だけ）
 *   /rows  相手の中で SQL が走る（Next → svc → PostgreSQL の2段）
 * ========================================================================== */
export const dynamic = 'force-dynamic';

const SVC = process.env.POC02_SVC_ORIGIN ?? 'http://127.0.0.1:3300';

export default async function RscSvc() {
  const [echo, rows] = await Promise.all([
    fetch(`${SVC}/echo`, { cache: 'no-store' }),
    fetch(`${SVC}/rows`, { cache: 'no-store' }),
  ]);
  const e = await echo.json();
  const r = await rows.json();
  return (
    <main className="rsc-svc">
      <h1>別サービスへの通信</h1>
      <p data-poc-field="echo">{String(e.ok)}</p>
      <p data-poc-field="rows">{String(r.count)}</p>
    </main>
  );
}
