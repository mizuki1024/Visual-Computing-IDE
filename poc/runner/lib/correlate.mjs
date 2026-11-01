/* =============================================================================
 * ブラウザの通信とサーバーのスパンの対応付け（PoC-05 の A 項）。
 *
 * **判断に使うのは識別子の一致だけである。** 時刻は記録するが判断に使わない。
 * 時間窓による対応付けは「比べるため」に別の関数として実装してある
 * （これが成立しないことを実測で示すのが目的である）。
 * ========================================================================== */

/** サーバー側の入口スパン。HTTP 計装が作る server 種別のスパンだけを採る */
export function serverEntrySpans(spans) {
  return spans.filter(
    (s) => s.scope === '@opentelemetry/instrumentation-http' && s.kind === 1,
  );
}

const methodOf = (s) => s.attrs['http.request.method'] ?? s.attrs['http.method'] ?? null;
const targetOf = (s) => s.attrs['url.path'] ?? s.attrs['http.target'] ?? null;
const statusOf = (s) => s.attrs['http.response.status_code'] ?? s.attrs['http.status_code'] ?? null;

/**
 * 識別子による対応付け。
 *
 * 成立の条件（1つでも欠けたら対応付けない）:
 *   1. 応答ヘッダから識別子を読めている
 *   2. その spanId のスパンを収集できている
 *   3. traceId も一致する
 *   4. そのスパンがサーバー側の入口スパンである
 *   5. **補強**: メソッドとパスが食い違わない（食い違えば対応付けを捨てる）
 *
 * @param {{method:string, path:string, server:{traceId,spanId}|null}} rec
 * @param {Map<string, object>} bySpanId  収集した全スパン
 */
export function matchByIdentity(rec, bySpanId) {
  const sc = rec.server ?? null;
  if (!sc) return { span: null, reason: 'no-identity-in-response' };
  const s = bySpanId.get(sc.spanId);
  if (!s) return { span: null, reason: 'span-not-collected' };
  if (s.traceId !== sc.traceId) return { span: null, reason: 'trace-id-mismatch' };
  if (s.kind !== 1) return { span: null, reason: 'not-a-server-entry-span' };
  const m = methodOf(s);
  const t = targetOf(s);
  if (m !== rec.method || t !== rec.path) {
    return { span: null, reason: 'corroboration-failed', detail: `${m} ${t}` };
  }
  return { span: s, reason: null, corroboration: { method: m, path: t, status: statusOf(s) } };
}

/**
 * 時間窓による対応付け（**比較のためだけに実装してある**）。
 * メソッドとパスが同じで、区間が重なるサーバー入口スパンを候補として返す。
 */
export function timeWindowCandidates(rec, entries) {
  const b0 = rec.startMs;
  const b1 = rec.startMs + (rec.durationMs ?? 0);
  if (!(b0 > 0)) return [];
  return entries.filter((s) => {
    if (methodOf(s) !== rec.method || targetOf(s) !== rec.path) return false;
    return s.startMs <= b1 && s.endMs >= b0;
  });
}

/**
 * 誤接続の検査。3通りの規則で「何件に絞れるか」を数えて比べる。
 *
 *   identity       識別子の一致（採用する規則）          → 0 件か 1 件でなければならない
 *   corroboration  メソッドとパスの一致だけ              → 絞れない（比較用）
 *   timeWindow     メソッド・パスの一致 ＋ 区間の重なり   → 絞れないことがある（比較用）
 *
 * **採用規則が常に1件に絞れること**と、
 * **時間窓では絞れない場面が実在すること**の両方を数字で示すための関数である。
 */
export function compareRules(records, bySpanId, entries) {
  const rows = [];
  for (const r of records) {
    const identity = matchByIdentity(r, bySpanId);
    const byMethodPath = entries.filter(
      (s) => methodOf(s) === r.method && targetOf(s) === r.path,
    );
    const byTime = timeWindowCandidates(r, entries);
    rows.push({
      browserRequestId: r.browserRequestId,
      method: r.method,
      path: r.path,
      status: r.status,
      identity: identity.span ? 1 : 0,
      identityReason: identity.reason,
      identitySpanId: identity.span?.spanId ?? null,
      corroborationOnly: byMethodPath.length,
      timeWindow: byTime.length,
      /** 時間窓が1件に絞れたとき、それは識別子の答えと同じだったか */
      timeWindowAgrees: byTime.length === 1 && identity.span
        ? byTime[0].spanId === identity.span.spanId
        : null,
    });
  }
  // 同じサーバースパンを2件のブラウザ通信が主張していないか
  const used = new Map();
  const duplicates = [];
  for (const r of records) {
    const sid = r.server?.spanId;
    if (!sid) continue;
    if (used.has(sid)) duplicates.push({ a: used.get(sid), b: r.browserRequestId, spanId: sid });
    else used.set(sid, r.browserRequestId);
  }
  return { rows, duplicates };
}

export { methodOf, targetOf, statusOf };
