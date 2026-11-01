/* =============================================================================
 * Phase 7B-3A — いまの起動の観測セッション（中継の記録）と、計装の収集ファイルの読み取り。
 *
 * 守っていること
 *   1. **観測セッションは起動ごとに1つ。** 開発サーバーが running になった時点で新しく作り、
 *      停止・異常終了で閉じる。中継の記録は「どの起動の転送か」の鍵を持ち、鍵が違えば捨てる
 *      （起動をまたいで混ぜない）
 *   2. **過去の記録を使わない。** 収集ファイルは起動ごとに別のファイル（7A の runId）で、
 *      読むのはいまの起動のファイルだけ。PoC の固定データ（src/data/*）は読まない
 *   3. 描くのは **中継が転送した通信のトレースに属するスパンだけ。** 同じトレース識別子という
 *      確実な証拠が無い処理は通信に結ばない（時刻の近さ・パスの一致は使わない）
 *   4. 対象プロジェクトに書き込まない。収集ファイルは IDE の `.ide-runtime/spans/` にある
 *   5. SQL の構文解析は Phase 6F の `poc/runner/lib/sqlparse.mjs` を**そのまま呼ぶ**
 *      （解析器を2つ持たない。持つと 6F の不具合が再発する）
 *
 * Phase 7B-3B-1 で足したこと
 *   6. 収集ファイルの **呼び出し位置の記録**（PoC-02 の `type: 'callsite'`）を同じ差分読み取りで読む。
 *      同じファイル＝同じ起動の記録だけを使う。記録を書いたプロセス（proc.pid）も持つ
 *   7. 中継が要求ごとに作った識別子（`vcide.relay.id`）を持つ受付スパンを索引する。
 *      通信のトレースは、応答のヘッダが指すものに加えて、**中継の識別子が指すもの**も返す
 *      （両者が食い違うときに、変換が「結ばない」と判定できるように）
 *   8. 通信のトレースに属する SQL のスパンごとに、データ取得の呼び出し位置を照合する
 *      （`dataAccess.ts`。PoC-02 の照合器をそのまま呼ぶ）
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { ideRoot } from './ide';
import type { RelayObserver, RelayRecord } from './previewGateway';
import {
  RELAY_ID_ATTR, RELAY_ID_HEADER, RELAY_ID_RE, RELAY_READ_REQUEST_HEADERS, RELAY_TRACE_HEADER,
  type LiveDataAccess, type LiveExchange, type LiveRunKey, type LiveRunObservation,
} from '../lib/liveObservation';
import type { ObsSpan, ObsSqlAnalysis } from '../lib/observation';
import { DOC_TOKEN_RE } from '../lib/previewProtocol';
import {
  parseCallsiteRecord, resetDataAccess, resolveDataAccess, resolverStatus, type CallsiteRecord,
} from './dataAccess';

/** 1セッションで持つ通信の上限。超えた分は数だけ残す */
const MAX_EXCHANGES = 200;
/** 収集ファイルから持つスパンの上限（起動の全体） */
const MAX_SPANS = 60_000;
/** 1回に読む収集ファイルの最大バイト数 */
const MAX_READ_BYTES = 8 * 1024 * 1024;

interface Session {
  run: string;
  startedAt: string;
  exchanges: LiveExchange[];
  overflow: number;
  excludedStatic: number;
}

/* ------------------------------------------------------- 収集ファイルの読み取り */

interface SpanFileState {
  file: string;
  offset: number;
  rest: string;
  spans: ObsSpan[];
  byTrace: Map<string, ObsSpan[]>;
  truncated: boolean;
  /** 7B-3B-1: spanId → そのスパンを書いたプロセス */
  pidOf: Map<string, number>;
  /** 7B-3B-1: spanId → 呼び出し位置の記録（SQL のものだけ。1件のはずだが、2件以上も隠さず持つ） */
  callsites: Map<string, CallsiteRecord[]>;
  callsiteRecords: number;
  /** 7B-3B-1: 中継の識別子 → その値を受け取った受付スパン */
  byRelayId: Map<string, ObsSpan[]>;
}

const newSpanFileState = (file: string): SpanFileState => ({
  file, offset: 0, rest: '', spans: [], byTrace: new Map(), truncated: false,
  pidOf: new Map(), callsites: new Map(), callsiteRecords: 0, byRelayId: new Map(),
});

type RawSpan = ObsSpan & { type?: string; sqlRedacted?: { strings: number; numbers: number } | null };

/** 収集ファイルの差分だけを読む。壊れた行は読まずに飛ばす（書きかけの最終行は次回に回す） */
function readSpanFile(st: SpanFileState): void {
  let fd: number;
  try { fd = fs.openSync(/* turbopackIgnore: true */ st.file, 'r'); } catch { return; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < st.offset) {
      st.offset = 0; st.rest = ''; st.spans = []; st.byTrace.clear();
      st.pidOf.clear(); st.callsites.clear(); st.callsiteRecords = 0; st.byRelayId.clear();
    }
    const len = Math.min(size - st.offset, MAX_READ_BYTES);
    if (len <= 0) return;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.offset);
    st.offset += len;
    const text = st.rest + buf.toString('utf8');
    const lines = text.split('\n');
    st.rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let o: RawSpan;
      try { o = JSON.parse(line) as RawSpan; } catch { continue; }
      if (o.type === 'callsite') {
        /* 7B-3B-1: 呼び出し位置の記録。SQL のものだけ持つ（サーバー内部の fetch は今回の範囲外） */
        const c = parseCallsiteRecord(o as unknown as Record<string, unknown>);
        if (!c || c.target !== 'sql') continue;
        if (st.callsiteRecords >= MAX_SPANS) { st.truncated = true; continue; }
        st.callsiteRecords += 1;
        const list = st.callsites.get(c.spanId);
        if (list) list.push(c); else st.callsites.set(c.spanId, [c]);
        continue;
      }
      if (o.type !== 'span' || typeof o.traceId !== 'string' || typeof o.spanId !== 'string') continue;
      if (st.spans.length >= MAX_SPANS) { st.truncated = true; continue; }
      const s: ObsSpan & { sqlRedacted?: RawSpan['sqlRedacted'] } = {
        traceId: o.traceId, spanId: o.spanId, parentSpanId: o.parentSpanId ?? null,
        name: String(o.name ?? '').slice(0, 200), kind: Number(o.kind ?? 0),
        startMs: Number(o.startMs), endMs: Number(o.endMs), durationMs: Number(o.durationMs),
        statusCode: Number(o.statusCode ?? 0), scope: String(o.scope ?? ''),
        attrs: o.attrs ?? {}, droppedAttributeKeys: o.droppedAttributeKeys ?? [],
        sqlRedacted: o.sqlRedacted ?? null,
      };
      st.spans.push(s);
      const list = st.byTrace.get(s.traceId);
      if (list) list.push(s); else st.byTrace.set(s.traceId, [s]);
      const pid = (o as unknown as { proc?: { pid?: unknown } }).proc?.pid;
      if (typeof pid === 'number') st.pidOf.set(s.spanId, pid);
      const rid = s.attrs[RELAY_ID_ATTR];
      if (typeof rid === 'string' && RELAY_ID_RE.test(rid)) {
        const l = st.byRelayId.get(rid);
        if (l) l.push(s); else st.byRelayId.set(rid, [s]);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------- SQL の構文解析 */

type SqlParse = { sqlAnalysisRecord: (a: { spanId: string; sql: string; redacted?: unknown }) => ObsSqlAnalysis };
let parserMod: Promise<SqlParse | null> | null = null;
let parserError: string | null = null;

/** Phase 6F の解析器を実行時に読む（IDE の画面のバンドルに入れない） */
function sqlParser(): Promise<SqlParse | null> {
  parserMod ??= (async () => {
    try {
      const file = path.join(ideRoot(), 'poc', 'runner', 'lib', 'sqlparse.mjs');
      /* 絶対パスで読む（POSIX）。テスト用の CommonJS 出力（.libjs）では require に変わるため、
       * file:// の URL ではなくパスを渡す。Windows は未対応（7A と同じ） */
      return await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ file) as SqlParse;
    } catch (e) {
      parserError = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e);
      return null;
    }
  })();
  return parserMod;
}

const SQL_TEXT = (a: ObsSpan['attrs']): string | null => {
  const v = a['db.statement'] ?? a['db.query.text'];
  return typeof v === 'string' ? v : null;
};

/* -------------------------------------------------------------------- 台帳 */

export class ObservationStore implements RelayObserver {
  #session: Session | null = null;
  #files = new Map<string, SpanFileState>();
  /** 7B-3B-1: SQL のスパンごとの照合結果（このセッションの中だけ。起動が変われば捨てる） */
  #dataAccess = new Map<string, LiveDataAccess>();

  /** running になった起動のために、新しいセッションを作る（前のセッションは捨てる） */
  begin(run: string): void {
    if (this.#session?.run === run) return;
    this.#session = { run, startedAt: new Date().toISOString(), exchanges: [], overflow: 0, excludedStatic: 0 };
    this.#dataAccess.clear();
    void resetDataAccess();
  }

  /** 停止・異常終了。セッションを閉じ、収集ファイルの読み取り状態も捨てる */
  end(): void {
    this.#session = null;
    this.#files.clear();
    this.#dataAccess.clear();
    void resetDataAccess();
  }

  current(): { run: string; startedAt: string } | null {
    return this.#session ? { run: this.#session.run, startedAt: this.#session.startedAt } : null;
  }

  /** **いまのセッションの起動からの記録だけ**を受ける。違う起動の記録は捨てる */
  record(run: string, rec: RelayRecord, meta?: { relayId?: string; docToken?: string }): void {
    const s = this.#session;
    if (!s || s.run !== run) return;
    if (s.exchanges.length >= MAX_EXCHANGES) { s.overflow += 1; return; }
    const relayId = meta?.relayId && RELAY_ID_RE.test(meta.relayId) ? meta.relayId : null;
    /* 7B-3B-2: 文書の識別子。中継の識別子と同じ値は持たない（別の乱数であることを形の上でも確かめる） */
    const docToken = meta?.docToken && DOC_TOKEN_RE.test(meta.docToken) && meta.docToken !== relayId ? meta.docToken : null;
    s.exchanges.push({
      ...rec, seq: s.exchanges.length + s.overflow + 1,
      ...(relayId ? { relayId } : {}), ...(docToken ? { docToken } : {}),
    });
  }

  excludeStatic(run: string): void {
    const s = this.#session;
    if (s && s.run === run) s.excludedStatic += 1;
  }

  /**
   * いまの起動の観測をまとめる。`run` がいまのセッションと違えば null（呼び出し側が 409 にする）。
   */
  async collect(input: {
    run: LiveRunKey; runString: string; project: string; port: number;
    instrumentation: { state: 'enabled' | 'disabled' | 'unavailable'; reason: string | null; spanFile: string | null };
    traceHeader: boolean;
    /**
     * 7B-3B-1: 呼び出し位置の照合に要るもの。省略すると照合しない（7B-3A の形の観測を返す）。
     * `projectRoot` は IDE のサーバーの中だけで使い、返す形には入れない
     */
    dataAccess?: { projectRoot: string; enabled: boolean; manifest: Map<string, unknown[]> | null };
  }): Promise<LiveRunObservation | null> {
    const s = this.#session;
    if (!s || s.run !== input.runString) return null;

    /* ---- 収集ファイル（いまの起動のものだけ） */
    let st: SpanFileState | null = null;
    if (input.instrumentation.state === 'enabled' && input.instrumentation.spanFile) {
      const f = input.instrumentation.spanFile;
      st = this.#files.get(f) ?? newSpanFileState(f);
      this.#files.set(f, st);
      readSpanFile(st);
    }

    /* ---- 通信のトレースに属するスパンだけを取り出す。
     * 応答のヘッダが指すトレースに加え、中継の識別子を受け取った受付スパンのトレースも入れる
     * （食い違えば変換が結ばない。どちらか片方だけを信じて取り違えないために両方を渡す） */
    const exchanges = s.exchanges.map((e) => ({ ...e }));
    const traceIds = new Set(exchanges.map((e) => e.trace?.traceId).filter((t): t is string => !!t));
    for (const e of exchanges) {
      if (!e.relayId) continue;
      for (const r of st?.byRelayId.get(e.relayId) ?? []) traceIds.add(r.traceId);
    }
    const spans: (ObsSpan & { sqlRedacted?: unknown })[] = [];
    for (const t of traceIds) spans.push(...(st?.byTrace.get(t) ?? []));

    /* 中継を通らずにサーバーが受けた HTTP 処理（IDE 自身の生存確認など）。数だけ */
    const serverOnlyRequests = st
      ? st.spans.filter((x) => x.kind === 1 && x.parentSpanId === null && !traceIds.has(x.traceId)
        && x.scope.includes('instrumentation-http')).length
      : 0;

    /* ---- SQL の構文解析（Phase 6F の解析器） */
    const sqlSpans = spans.filter((x) => SQL_TEXT(x.attrs) !== null);
    const parser = sqlSpans.length ? await sqlParser() : null;
    const sqlAnalyses: ObsSqlAnalysis[] = [];
    if (parser) {
      for (const x of sqlSpans) {
        sqlAnalyses.push(parser.sqlAnalysisRecord({ spanId: x.spanId, sql: SQL_TEXT(x.attrs)!, redacted: x.sqlRedacted ?? null }));
      }
    }

    /* ---- 7B-3B-1: SQL のスパンごとに、データ取得の呼び出し位置を照合する（結果はこのセッションの中で使い回す） */
    let dataAccess: LiveDataAccess[] | undefined;
    if (input.dataAccess && st) {
      const pending = sqlSpans.filter((x) => !this.#dataAccess.has(x.spanId));
      const fresh = await resolveDataAccess({
        projectRoot: input.dataAccess.projectRoot,
        sql: pending.map((x) => ({ span: x, pid: st!.pidOf.get(x.spanId) ?? null })),
        callsites: st.callsites,
        manifest: input.dataAccess.manifest,
        enabled: input.dataAccess.enabled,
      });
      if (this.#session !== s) return null;                 // 照合の間に停止・再起動した
      for (const d of fresh) {
        // 照合器を読めなかった結果は使い回さない（次の取得でもう一度試す）
        if (d.failure?.reason !== 'resolver-unavailable') this.#dataAccess.set(d.spanId, d);
      }
      const now = new Map(fresh.map((d) => [d.spanId, d]));
      dataAccess = sqlSpans.map((x) => this.#dataAccess.get(x.spanId) ?? now.get(x.spanId)).filter((d): d is LiveDataAccess => !!d);
    }

    return {
      run: input.run,
      project: input.project,
      port: input.port,
      session: {
        startedAt: s.startedAt,
        recorded: s.exchanges.length,
        overflow: s.overflow,
        excludedStatic: s.excludedStatic,
        readRequestHeaders: RELAY_READ_REQUEST_HEADERS,
        readResponseHeaders: [RELAY_TRACE_HEADER],
        ...(input.dataAccess ? { writtenRequestHeaders: [RELAY_ID_HEADER] } : {}),
      },
      instrumentation: {
        state: input.instrumentation.state,
        reason: input.instrumentation.reason,
        traceHeader: input.traceHeader,
        spanRecords: st?.spans.length ?? 0,
        truncated: st?.truncated ?? false,
      },
      exchanges,
      spans: spans.map(({ sqlRedacted: _r, ...rest }) => { void _r; return rest; }),
      sqlAnalyses,
      parser: sqlSpans.length === 0
        ? { available: true, reason: null }
        : parser ? { available: true, reason: null }
          : { available: false, reason: `SQL の構文解析器を読み込めませんでした（${parserError ?? '理由不明'}）。解析しないまま出しません。` },
      serverOnlyRequests,
      collectedAt: new Date().toISOString(),
      ...(input.dataAccess ? {
        dataAccess: dataAccess ?? [],
        callsite: {
          enabled: input.dataAccess.enabled,
          records: st?.callsiteRecords ?? 0,
          resolver: resolverStatus(),
        },
      } : {}),
    };
  }
}

/** 単一実体（devServer・中継と同じく globalThis に置く。dev の再評価で二重にしないため） */
export function observations(): ObservationStore {
  const g = globalThis as unknown as { __vcideObservations__?: ObservationStore };
  g.__vcideObservations__ ??= new ObservationStore();
  return g.__vcideObservations__;
}
