/* =============================================================================
 * Phase 7C-1 — 画面へ返す観測の形（P1-8: 観測 API の転送量）。
 *
 * 7C-0 までは、保持しているすべての通信のスパン・SQL の解析・照合の結果を 1.5 秒ごとに
 * 返していた（200 件で約 2.6 MB）。画面が使うのは
 *   - 一覧: 通信ごとの「サーバー処理に結べたか・SQL の本数・呼び出し位置を特定した本数」
 *   - キャンバスと右の詳細: **表示している（・選んでいる）通信1〜数件**の証拠
 * だけなので、次の形に変える。
 *   1. 一覧には要約（`summaries`）だけを返す。判定はサーバーが**全件の証拠で**行う
 *      （画面で行っていた `liveExchangeLinks` と同じ関数を、その通信の証拠だけで呼ぶ）
 *   2. 証拠（スパン・解析・照合）は、画面が求めた通信（`detail`）の分だけ返す
 *   3. 中身の指紋（`etag`）が画面の持っているものと同じなら、中身を返さない（変化なし）
 *
 * 証拠はサーバーに残る（ObservationStore）。由来の評価（lineage）もサーバーで全件の証拠を使う。
 * 一覧の通信からは、中継の識別子・文書の識別子を外して返す（画面は使わない）。
 * ========================================================================== */
import { createHash } from 'node:crypto';
import { liveExchangeLinks } from '../lib/adapter';
import {
  RELAY_ID_ATTR, type LiveExchange, type LiveExchangeSummary, type LiveRunObservation,
} from '../lib/liveObservation';
import type { ObsSpan } from '../lib/observation';

/** 画面が一度に求められる詳細の数（表示中・一覧で選んだもの・同定した文書の通信） */
export const MAX_DETAIL = 4;

interface Index {
  byTrace: Map<string, ObsSpan[]>;
  relayTraces: Map<string, Set<string>>;
}

function indexOf(full: LiveRunObservation): Index {
  const byTrace = new Map<string, ObsSpan[]>();
  const relayTraces = new Map<string, Set<string>>();
  for (const s of full.spans) {
    const l = byTrace.get(s.traceId);
    if (l) l.push(s); else byTrace.set(s.traceId, [s]);
    const rid = s.attrs[RELAY_ID_ATTR];
    if (typeof rid === 'string') {
      const t = relayTraces.get(rid);
      if (t) t.add(s.traceId); else relayTraces.set(rid, new Set([s.traceId]));
    }
  }
  return { byTrace, relayTraces };
}

/** この通信の証拠が載るトレース（ObservationStore と同じ規則: 応答のヘッダ＋中継の識別子） */
function tracesOf(e: LiveExchange, ix: Index): Set<string> {
  const t = new Set<string>();
  if (e.trace) t.add(e.trace.traceId);
  if (e.relayId) for (const x of ix.relayTraces.get(e.relayId) ?? []) t.add(x);
  return t;
}

/**
 * 通信を、その通信の証拠だけを持つ観測にする（`liveExchangeLinks` はこの通信のトレースの
 * スパンしか見ないので、全件の観測で呼んだときと同じ結果になる）
 */
function narrow(full: LiveRunObservation, traces: Set<string>, ix: Index): Pick<LiveRunObservation, 'spans' | 'sqlAnalyses' | 'dataAccess'> {
  const spans = [...traces].flatMap((t) => ix.byTrace.get(t) ?? []);
  const ids = new Set(spans.map((s) => s.spanId));
  return {
    spans,
    sqlAnalyses: full.sqlAnalyses.filter((a) => ids.has(a.spanId)),
    ...(full.dataAccess ? { dataAccess: full.dataAccess.filter((d) => ids.has(d.spanId) && traces.has(d.traceId)) } : {}),
  };
}

export function summarize(full: LiveRunObservation, ix = indexOf(full)): LiveExchangeSummary[] {
  return full.exchanges.map((e) => {
    const part = narrow(full, tracesOf(e, ix), ix);
    const links = liveExchangeLinks({ ...full, ...part }, e);
    const sited = part.dataAccess
      ? links.sql.filter((x) => part.dataAccess!.some((d) => d.spanId === x.spanId && d.traceId === x.traceId && d.site)).length
      : null;
    return { seq: e.seq, server: !!links.server, sql: links.sql.length, sited };
  });
}

/**
 * 画面へ返す観測。`detail` の通信だけ証拠（スパン・解析・照合）を入れ、ほかは一覧の項目だけにする。
 * `detail: 'all'` は 7C-0 までと同じ全件（試験と診断のため。画面は使わない）。
 */
export function observationView(full: LiveRunObservation, detail: readonly number[] | 'all'): LiveRunObservation {
  if (detail === 'all') return withEtag({ ...full });
  const ix = indexOf(full);
  const want = new Set(detail.filter((seq) => full.exchanges.some((e) => e.seq === seq)).slice(0, MAX_DETAIL));
  const traces = new Set<string>();
  for (const e of full.exchanges) if (want.has(e.seq)) for (const t of tracesOf(e, ix)) traces.add(t);
  const part = narrow(full, traces, ix);
  const view: LiveRunObservation = {
    ...full,
    exchanges: full.exchanges.map((e) => {
      if (want.has(e.seq)) return e;
      const { relayId: _r, docToken: _d, ...light } = e;
      void _r; void _d;
      return light;
    }),
    detailSeqs: [...want].sort((a, b) => a - b),
    summaries: summarize(full, ix),
    spans: part.spans,
    sqlAnalyses: part.sqlAnalyses,
    ...(full.dataAccess ? { dataAccess: part.dataAccess ?? [] } : {}),
  };
  return withEtag(view);
}

/**
 * 中身の指紋。同じなら画面は持っている観測をそのまま使える。
 * 取得の時刻と、**画面が描かない累計の数**（読んだスパン・持っているスパン・中継を通らない処理・
 * 呼び出し位置の記録の数）は含めない。これらは IDE 自身の生存確認だけでも増えるので、含めると
 * 新しい通信が無くても毎回中身を返すことになる（7C-1 の 3,000 要求の soak で見つけた）。
 * 画面がこれらを描くようになったら、ここから外すこと。
 */
function withEtag(view: LiveRunObservation): LiveRunObservation {
  const { collectedAt: _c, etag: _e, serverOnlyRequests: _s, ...rest } = view;
  void _c; void _e; void _s;
  const stable = {
    ...rest,
    session: { ...rest.session, retention: { ...rest.session.retention, retainedSpans: 0 } },
    instrumentation: { ...rest.instrumentation, spanRecords: 0 },
    ...(rest.callsite ? { callsite: { ...rest.callsite, records: 0 } } : {}),
  };
  const etag = createHash('sha1').update(JSON.stringify(stable)).digest('base64url').slice(0, 22);
  return { ...view, etag };
}

/** 画面が送る取得の条件（詳細を求める通信・保持を頼む通信・持っている指紋）を検める */
export function parseViewRequest(b: Record<string, unknown> | null): {
  detail: number[] | 'all'; pin: number[]; etag: string | null;
} | null {
  if (!b) return null;
  const seqList = (v: unknown): number[] | null => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > MAX_DETAIL) return null;
    return v.every((x) => Number.isSafeInteger(x) && (x as number) >= 1) ? v as number[] : null;
  };
  const detail = b.detail === 'all' ? 'all' : seqList(b.detail);
  const pin = seqList(b.pin);
  const etag = b.etag === undefined || b.etag === null ? null
    : typeof b.etag === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.etag) ? b.etag : undefined;
  if (detail === null || pin === null || etag === undefined) return null;
  return { detail, pin, etag };
}
