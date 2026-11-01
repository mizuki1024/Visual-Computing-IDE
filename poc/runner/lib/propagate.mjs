/* =============================================================================
 * サーバーからサーバーへのトレース伝播の判定（PoC-02 Gate A）。
 *
 * **判断に使うのはスパンの親子関係とトレースIDの一致だけである。**
 * 時刻の近さ・URL の一致・プロセスの近さは判断に使わない。
 * 時間窓での対応付けは「比べるため」に別の関数として置いてある。
 *
 * 成立の条件（1つでも欠けたら対応付けない）:
 *   1. 送信側に client スパン（kind=2）がある
 *   2. 受信側に入口スパン（kind=1）がある
 *   3. 受信側の parentSpanId が、送信側の client スパンの spanId と一致する
 *   4. traceId も一致する
 *   5. **補強のみ**: 宛先のパスが食い違わない（食い違えば捨てる）
 *
 * 「別トレースになった場合に、誤って同一経路にしない」ことが、この関数の
 * もっとも重要な役目である。別トレースなら 4 で落ちる。
 * ========================================================================== */

/** OpenTelemetry の SpanKind */
export const KIND = { INTERNAL: 0, SERVER: 1, CLIENT: 2 };

export const pathOf = (s) => s.attrs['url.path'] ?? s.attrs['http.target'] ?? null;

/**
 * 宛先のパス。Next.js 自身の fetch スパンは属性を持たず、名前だけが
 * `fetch GET http://127.0.0.1:3300/echo` の形である（実測）。
 * **名前から読むのは属性が無いときだけ**にする。
 */
export function destPathOf(s) {
  const a = pathOf(s);
  if (a) return a;
  const m = /^fetch\s+\S+\s+(\S+)/.exec(s.name ?? '');
  if (!m) return null;
  try { return new URL(m[1]).pathname; } catch { return null; }
}
export const methodOf = (s) => s.attrs['http.request.method'] ?? s.attrs['http.method'] ?? null;
export const statusOf = (s) =>
  s.attrs['http.response.status_code'] ?? s.attrs['http.status_code'] ?? null;

/** サーバー内部から出た通信の client スパン（undici 計装だけが作る） */
export const clientSpans = (spans) =>
  spans.filter((s) => s.kind === KIND.CLIENT && /undici/.test(s.scope ?? ''));

/** 入口スパン（HTTP 計装が作る server 種別） */
export const entrySpans = (spans) =>
  spans.filter((s) => s.kind === KIND.SERVER && /instrumentation-http/.test(s.scope ?? ''));

/**
 * 1本の client スパンに対して、受け側の入口スパンを親子関係で探す。
 *
 * @param {object} client            送信側の client スパン
 * @param {object[]} allEntrySpans   収集した全プロセスの入口スパン
 * @returns {{entry:object|null, reason:string|null, sameService?:boolean}}
 */
export function matchByParentage(client, allEntrySpans) {
  if (!client) return { entry: null, reason: 'no-client-span' };
  const candidates = allEntrySpans.filter((s) => s.parentSpanId === client.spanId);
  if (!candidates.length) {
    return { entry: null, reason: 'no-child-entry-span' };
  }
  if (candidates.length > 1) {
    // 1つの送信に対して受け側が2本あることは、構成上ありえない。
    // 起きたら対応付けない（黙って1本目を採らない）
    return { entry: null, reason: 'multiple-child-entry-spans', count: candidates.length };
  }
  const entry = candidates[0];
  if (entry.traceId !== client.traceId) {
    return { entry: null, reason: 'trace-id-mismatch' };
  }
  const cp = pathOf(client);
  const ep = pathOf(entry);
  if (cp && ep && cp !== ep) {
    return { entry: null, reason: 'corroboration-failed', detail: `${cp} / ${ep}` };
  }
  return {
    entry,
    reason: null,
    corroboration: { path: ep, status: statusOf(entry) },
  };
}

/**
 * 時間窓による対応付け（**比較のためだけに実装してある**）。
 * 宛先のパスが同じで、区間が client スパンに収まる入口スパンを候補として返す。
 */
export function timeWindowCandidates(client, allEntrySpans) {
  if (!client) return [];
  return allEntrySpans.filter((s) => {
    if (pathOf(s) !== destPathOf(client)) return false;
    return s.startMs >= client.startMs - 50 && s.endMs <= client.endMs + 50;
  });
}

/**
 * 伝播の検査。3通りの規則で「何件に絞れるか」を数えて比べる。
 *
 *   parentage      親子関係 + トレースID（採用する規則）→ 0 件か 1 件
 *   pathOnly       宛先のパスの一致だけ                 → 絞れない（比較用）
 *   timeWindow     パスの一致 + 区間の内包              → 絞れないことがある（比較用）
 */
export function comparePropagationRules(clients, allEntrySpans) {
  const rows = [];
  for (const c of clients) {
    const m = matchByParentage(c, allEntrySpans);
    const byPath = allEntrySpans.filter((s) => pathOf(s) === destPathOf(c));
    const byTime = timeWindowCandidates(c, allEntrySpans);
    rows.push({
      clientSpanId: c.spanId,
      traceId: c.traceId,
      path: destPathOf(c),
      status: statusOf(c),
      parentage: m.entry ? 1 : 0,
      parentageReason: m.reason,
      entrySpanId: m.entry?.spanId ?? null,
      /** 受け側が別トレースだったか（＝伝播が成立していない） */
      entryIsOtherTrace: m.entry ? false : byTime.some((s) => s.traceId !== c.traceId),
      pathOnly: byPath.length,
      timeWindow: byTime.length,
      timeWindowAgrees: byTime.length === 1 && m.entry
        ? byTime[0].spanId === m.entry.spanId
        : null,
    });
  }
  // 1本の入口スパンを2本の client スパンが主張していないか
  const used = new Map();
  const duplicates = [];
  for (const r of rows) {
    if (!r.entrySpanId) continue;
    if (used.has(r.entrySpanId)) {
      duplicates.push({ a: used.get(r.entrySpanId), b: r.clientSpanId, entry: r.entrySpanId });
    } else used.set(r.entrySpanId, r.clientSpanId);
  }
  return { rows, duplicates };
}

/**
 * 1つのトレースに含まれるスパンの木構造を復元する。
 * **親が収集できていないスパンは根として扱い、繋がっているふりをしない。**
 */
export function treeOf(spans, traceId) {
  const inTrace = spans.filter((s) => s.traceId === traceId);
  const byId = new Map(inTrace.map((s) => [s.spanId, s]));
  const roots = inTrace.filter((s) => !s.parentSpanId || !byId.has(s.parentSpanId));
  const childrenOf = (id) =>
    inTrace.filter((s) => s.parentSpanId === id).sort((a, b) => a.startMs - b.startMs);
  const depthOf = (s) => {
    let d = 0;
    let cur = s;
    while (cur.parentSpanId && byId.has(cur.parentSpanId)) { cur = byId.get(cur.parentSpanId); d++; }
    return d;
  };
  return { inTrace, byId, roots, childrenOf, depthOf };
}

/**
 * ある子孫から、ある先祖までの親子の連鎖をたどる。
 * たどれなければ null（＝「子孫である」と主張しない）。
 */
export function ancestryTo(byId, from, ancestorSpanId) {
  let cur = from;
  let depth = 0;
  while (cur?.parentSpanId) {
    const parent = byId.get(cur.parentSpanId);
    depth++;
    if (!parent) return null;
    if (parent.spanId === ancestorSpanId) return { depth };
    cur = parent;
  }
  return null;
}

/** 並行実行の検出。兄弟スパンの区間が重なっているか（01b Q-02 C-2） */
export function overlaps(spans) {
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (a.startMs < b.endMs && b.startMs < a.endMs) {
        out.push({
          a: a.spanId, b: b.spanId,
          overlapMs: +(Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)).toFixed(2),
        });
      }
    }
  }
  return out;
}
