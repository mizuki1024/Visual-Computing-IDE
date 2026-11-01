/* =============================================================================
 * PoC-02 Gate A 2/2 — **別サービスへの通信が失敗する**（500）。
 *
 * 応答は返ってくる。伝播が成立していれば、相手側の入口スパンは
 * こちらの client スパンの子として同じトレースに入る。
 * ========================================================================== */
export const dynamic = 'force-dynamic';

const SVC = process.env.POC02_SVC_ORIGIN ?? 'http://127.0.0.1:3300';

export default async function RscSvcFail() {
  const res = await fetch(`${SVC}/boom`, { cache: 'no-store' });
  return (
    <main className="rsc-svc-fail">
      <h1>別サービスへの通信（失敗）</h1>
      <p data-poc-field="status">{String(res.status)}</p>
    </main>
  );
}
