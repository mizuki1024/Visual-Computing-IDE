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
 *
 * Phase 7C-1 で変えたこと（P0-1・P1-8）
 *   9. 上限に達したら新しい通信を捨てる方式をやめ、古い通信を外す（下の「保持の方式」）。
 *      スパン・照合・解析もトレースの単位で整理し、起動が長くても持つ量が一定を超えない
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { ideRoot } from './ide';
import type { RelayObserver, RelayRecord } from './previewGateway';
import {
  RELAY_ID_ATTR, RELAY_ID_HEADER, RELAY_ID_RE, RELAY_READ_REQUEST_HEADERS, RELAY_TRACE_HEADER,
  type EvictedExchange, type ExchangeHistory, type LiveDataAccess, type LiveExchange, type LiveRunKey,
  type LiveRunObservation,
} from '../lib/liveObservation';
import type { ObsSpan, ObsSqlAnalysis } from '../lib/observation';
import { DOC_TOKEN_RE } from '../lib/previewProtocol';
import {
  parseCallsiteRecord, resetDataAccess, resolveDataAccess, resolverStatus, type CallsiteRecord,
} from './dataAccess';

/* -----------------------------------------------------------------------------
 * Phase 7C-1 — 保持の方式（P0-1・P1-8）
 *
 *   7C-0 まで: 200 件に達すると**新しい**通信を捨てた。以後に読み込んだ文書は同定できず、
 *              スパンも起動の全体で 60,000 本に達すると新しいものを捨てた。
 *   7C-1 から: **古い**通信を外す（スライディングウィンドウ）。持つのは次の和集合だけ
 *     1. 直近 WINDOW 件の通信（種類を問わない）
 *     2. 文書の識別子を持つ直近 DOC_RESERVE 件の文書（API・RSC の連打で表示中の文書を押し出さない）
 *     3. 画面が「表示中・同定済み」として頼んだ通信（期限つき PIN_LEASE_MS・最大 PIN_LIMIT 件）
 *   スパン・呼び出し位置の記録・SQL の解析・照合の結果は、**持っている通信のトレースの分だけ**残す。
 *   どの通信にも属さないトレース（中継を通らない処理）は ORPHAN_GRACE_MS の後に整理する
 *   （応答を送り終える前に書かれるスパンがあるので、すぐには消さない）。
 *
 *   通し番号は起動の中で一意・単調増加で、外した通信の番号を使い回さない。外した通信は
 *   `EvictedExchange`（番号・種類・パス・時刻・文書の識別子）として HISTORY_LIMIT 件まで残し、
 *   その文書を選んだときに「保持対象外」と理由を出す。記録の照合（トレース識別子・中継の識別子）は
 *   従来どおり完全一致だけなので、外した通信の証拠が残りの通信に付け替わることは無い。
 * --------------------------------------------------------------------------- */
/** 必ず持つ直近の通信の数 */
export const WINDOW = 200;
/** それに加えて持つ、直近の文書（文書の識別子つき）の数 */
export const DOC_RESERVE = 50;
/** 画面が保持を頼める通信の数と期限（画面は 1.5 秒ごとに頼み直す） */
export const PIN_LIMIT = 8;
export const PIN_LEASE_MS = 30_000;
/** 「保持対象外」の記録の上限 */
export const HISTORY_LIMIT = 4_000;
/** 持つスパンの上限（通信の数とは別の安全弁。超えたら古い通信から外す） */
export const SPAN_BUDGET = 60_000;
/** どの通信にも属さないトレースを整理するまでの猶予 */
export const ORPHAN_GRACE_MS = 120_000;
/** 1回に読む収集ファイルの最大バイト数（1回の取得で、整理を挟みながら最大 MAX_READ_CHUNKS 回読む） */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_READ_CHUNKS = 8;

interface Session {
  run: string;
  startedAt: string;
  /** 持っている通信（番号の昇順） */
  exchanges: LiveExchange[];
  /** 最後に振った番号（外した通信の番号も使い回さない） */
  lastSeq: number;
  excludedStatic: number;
  /** 外した通信の記録（古い順・HISTORY_LIMIT 件まで） */
  evicted: EvictedExchange[];
  evictedCount: number;
  budgetEvicted: number;
  /** 記録も整理した番号の上限 */
  lostThroughSeq: number;
  /** 保持を頼まれた通信 → 期限（エポックのミリ秒） */
  pins: Map<number, number>;
  /**
   * 外した通信が指していたトレース識別子・中継の識別子（`evicted` と同じ順・同じ件数）。
   * 外した**後に**書かれた（読んだ）スパンを、猶予を待たずに整理し「中継を通らない処理」と数えないため
   */
  evictedRefs: string[][];
  evictedKeys: Set<string>;
}

/* ------------------------------------------------------- 収集ファイルの読み取り */

/** 1つのトレースに属する記録。整理はトレースの単位で行う */
interface TraceBucket {
  spans: ObsSpan[];
  /** このトレースの記録を最初に読んだ時刻 */
  readAt: number;
  /** このトレースの ID を名乗る呼び出し位置の記録のスパン ID */
  callsiteSpanIds: Set<string>;
  relayIds: Set<string>;
}

interface SpanFileState {
  file: string;
  offset: number;
  rest: string;
  traces: Map<string, TraceBucket>;
  /** いまの起動の全体で読んだ数（整理しても減らない） */
  spansRead: number;
  callsitesRead: number;
  /** いま持っているスパンの数 */
  retainedSpans: number;
  /** 整理した、中継を通らない HTTP 処理（受付スパン）の数 */
  serverOnlyPruned: number;
  /** スパンの上限のために、猶予の内のトレースまで整理したか */
  truncated: boolean;
  /** 7B-3B-1: spanId → そのスパンを書いたプロセス */
  pidOf: Map<string, number>;
  /** 7B-3B-1: spanId → 呼び出し位置の記録（SQL のものだけ。1件のはずだが、2件以上も隠さず持つ） */
  callsites: Map<string, CallsiteRecord[]>;
  /** 7B-3B-1: 中継の識別子 → その値を受け取った受付スパン */
  byRelayId: Map<string, ObsSpan[]>;
}

const newSpanFileState = (file: string): SpanFileState => ({
  file, offset: 0, rest: '', traces: new Map(), spansRead: 0, callsitesRead: 0, retainedSpans: 0,
  serverOnlyPruned: 0, truncated: false, pidOf: new Map(), callsites: new Map(), byRelayId: new Map(),
});

const bucketOf = (st: SpanFileState, traceId: string, now: number): TraceBucket => {
  let b = st.traces.get(traceId);
  if (!b) { b = { spans: [], readAt: now, callsiteSpanIds: new Set(), relayIds: new Set() }; st.traces.set(traceId, b); }
  return b;
};

const isServerRoot = (x: ObsSpan) => x.kind === 1 && x.parentSpanId === null && x.scope.includes('instrumentation-http');

type RawSpan = ObsSpan & { type?: string; sqlRedacted?: { strings: number; numbers: number } | null };

/**
 * 収集ファイルの差分だけを読む。壊れた行は読まずに飛ばす（書きかけの最終行は次回に回す）。
 * 1回に MAX_READ_BYTES ずつ読み、そのたびに `afterChunk`（整理）を呼ぶ。
 * ファイルが縮んだ（作り直された）ときは `onReset` を呼んで最初から読む。
 */
function readSpanFile(st: SpanFileState, clock: () => number, afterChunk: () => void, onReset: () => void): void {
  let fd: number;
  try { fd = fs.openSync(/* turbopackIgnore: true */ st.file, 'r'); } catch { return; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size < st.offset) {
      Object.assign(st, newSpanFileState(st.file));
      onReset();
    }
    for (let chunk = 0; chunk < MAX_READ_CHUNKS; chunk++) {
      const len = Math.min(size - st.offset, MAX_READ_BYTES);
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.offset);
      st.offset += len;
      const text = st.rest + buf.toString('utf8');
      const lines = text.split('\n');
      st.rest = lines.pop() ?? '';
      const now = clock();
      for (const line of lines) {
        if (!line.trim()) continue;
        let o: RawSpan;
        try { o = JSON.parse(line) as RawSpan; } catch { continue; }
        if (o.type === 'callsite') {
          /* 7B-3B-1: 呼び出し位置の記録。SQL のものだけ持つ（サーバー内部の fetch は今回の範囲外） */
          const c = parseCallsiteRecord(o as unknown as Record<string, unknown>);
          if (!c || c.target !== 'sql') continue;
          st.callsitesRead += 1;
          const list = st.callsites.get(c.spanId);
          if (list) list.push(c); else st.callsites.set(c.spanId, [c]);
          bucketOf(st, c.traceId, now).callsiteSpanIds.add(c.spanId);
          continue;
        }
        if (o.type !== 'span' || typeof o.traceId !== 'string' || typeof o.spanId !== 'string') continue;
        const s: ObsSpan & { sqlRedacted?: RawSpan['sqlRedacted'] } = {
          traceId: o.traceId, spanId: o.spanId, parentSpanId: o.parentSpanId ?? null,
          name: String(o.name ?? '').slice(0, 200), kind: Number(o.kind ?? 0),
          startMs: Number(o.startMs), endMs: Number(o.endMs), durationMs: Number(o.durationMs),
          statusCode: Number(o.statusCode ?? 0), scope: String(o.scope ?? ''),
          attrs: o.attrs ?? {}, droppedAttributeKeys: o.droppedAttributeKeys ?? [],
          sqlRedacted: o.sqlRedacted ?? null,
        };
        st.spansRead += 1;
        st.retainedSpans += 1;
        const b = bucketOf(st, s.traceId, now);
        b.spans.push(s);
        const pid = (o as unknown as { proc?: { pid?: unknown } }).proc?.pid;
        if (typeof pid === 'number') st.pidOf.set(s.spanId, pid);
        const rid = s.attrs[RELAY_ID_ATTR];
        if (typeof rid === 'string' && RELAY_ID_RE.test(rid)) {
          b.relayIds.add(rid);
          const l = st.byRelayId.get(rid);
          if (l) l.push(s); else st.byRelayId.set(rid, [s]);
        }
      }
      afterChunk();
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
  /** 7B-3B-1: SQL のスパンごとの照合結果（このセッションの中だけ。起動が変われば捨てる。トレースの整理で消す） */
  #dataAccess = new Map<string, LiveDataAccess>();
  /** 7C-1: SQL のスパンごとの構文解析の結果（毎回解析し直さない。トレースの整理で消す） */
  #analyses = new Map<string, ObsSqlAnalysis>();
  /** 試験だけが差し替える時計 */
  now: () => number = () => Date.now();

  /** running になった起動のために、新しいセッションを作る（前のセッションは捨てる） */
  begin(run: string): void {
    if (this.#session?.run === run) return;
    this.#session = {
      run, startedAt: new Date().toISOString(), exchanges: [], lastSeq: 0, excludedStatic: 0,
      evicted: [], evictedCount: 0, budgetEvicted: 0, lostThroughSeq: 0, pins: new Map(),
      evictedRefs: [], evictedKeys: new Set(),
    };
    /* 7C-1: 収集ファイルの読み取り状態も捨てる（起動ごとに別のファイルだが、引き継ぎ・再評価で残さない） */
    this.#files.clear();
    this.#dataAccess.clear();
    this.#analyses.clear();
    void resetDataAccess();
  }

  /** 停止・異常終了。セッションを閉じ、収集ファイルの読み取り状態も捨てる */
  end(): void {
    this.#session = null;
    this.#files.clear();
    this.#dataAccess.clear();
    this.#analyses.clear();
    void resetDataAccess();
  }

  current(): { run: string; startedAt: string } | null {
    return this.#session ? { run: this.#session.run, startedAt: this.#session.startedAt } : null;
  }

  /** **いまのセッションの起動からの記録だけ**を受ける。違う起動の記録は捨てる */
  record(run: string, rec: RelayRecord, meta?: { relayId?: string; docToken?: string }): void {
    const s = this.#session;
    if (!s || s.run !== run) return;
    const relayId = meta?.relayId && RELAY_ID_RE.test(meta.relayId) ? meta.relayId : null;
    /* 7B-3B-2: 文書の識別子。中継の識別子と同じ値は持たない（別の乱数であることを形の上でも確かめる） */
    const docToken = meta?.docToken && DOC_TOKEN_RE.test(meta.docToken) && meta.docToken !== relayId ? meta.docToken : null;
    s.lastSeq += 1;
    s.exchanges.push({
      ...rec, seq: s.lastSeq,
      ...(relayId ? { relayId } : {}), ...(docToken ? { docToken } : {}),
    });
    this.#enforceWindow(s);
  }

  excludeStatic(run: string): void {
    const s = this.#session;
    if (s && s.run === run) s.excludedStatic += 1;
  }

  /**
   * 7C-1: 画面が表示中・同定済みの通信の保持を頼む（期限つき）。いま持っていない通信は頼めない
   * （外した通信を生き返らせない）。上限を超えたら期限の近いものから外す
   */
  pin(run: string, seqs: readonly number[]): void {
    const s = this.#session;
    if (!s || s.run !== run) return;
    const until = this.now() + PIN_LEASE_MS;
    for (const seq of seqs) {
      if (s.exchanges.some((e) => e.seq === seq)) s.pins.set(seq, until);
    }
    if (s.pins.size > PIN_LIMIT) {
      const drop = [...s.pins.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, s.pins.size - PIN_LIMIT);
      for (const [seq] of drop) s.pins.delete(seq);
    }
  }

  /** 7C-1: 外した通信の記録（**サーバーの中だけ**で使う。文書の同定が「保持対象外」と言うため） */
  history(run: string): ExchangeHistory | null {
    const s = this.#session;
    if (!s || s.run !== run) return null;
    return { evicted: s.evicted, lostThroughSeq: s.lostThroughSeq, window: WINDOW };
  }

  /* ------------------------------------------------------------ 7C-1 保持 */

  #livePins(s: Session): Set<number> {
    const now = this.now();
    for (const [seq, until] of s.pins) if (until <= now) s.pins.delete(seq);
    return new Set(s.pins.keys());
  }

  /** この通信の証拠が載るトレース（応答のヘッダが指すもの＋中継の識別子を受け取った受付スパンのもの） */
  #tracesOf(e: LiveExchange, st: SpanFileState | null): string[] {
    const t: string[] = [];
    if (e.trace) t.push(e.trace.traceId);
    if (e.relayId && st) for (const r of st.byRelayId.get(e.relayId) ?? []) t.push(r.traceId);
    return t;
  }

  #file(): SpanFileState | null {
    /* 1つのセッションが読むのは、いまの起動の収集ファイル1つだけ */
    for (const st of this.#files.values()) return st;
    return null;
  }

  /** 直近 WINDOW 件・直近 DOC_RESERVE 件の文書・保持を頼まれた通信の外を外す */
  #enforceWindow(s: Session): void {
    const n = s.exchanges.length;
    if (n <= WINDOW) return;
    const keep = new Set<number>(this.#livePins(s));
    for (let i = n - WINDOW; i < n; i++) keep.add(s.exchanges[i].seq);
    let docs = 0;
    for (let i = n - 1; i >= 0 && docs < DOC_RESERVE; i--) {
      if (s.exchanges[i].docToken) { keep.add(s.exchanges[i].seq); docs += 1; }
    }
    const drop = s.exchanges.filter((e) => !keep.has(e.seq));
    if (drop.length) this.#evict(s, drop, 'window');
  }

  /** 通信を外す。外した通信のトレースは、残す通信が参照していなければ一緒に整理する */
  #evict(s: Session, drop: LiveExchange[], reason: EvictedExchange['reason']): void {
    const st = this.#file();
    const dropSet = new Set(drop);
    s.exchanges = s.exchanges.filter((e) => !dropSet.has(e));
    for (const e of drop) {
      s.evicted.push({
        seq: e.seq, kind: e.kind, path: e.path, startMs: e.startMs,
        ...(e.docToken ? { docToken: e.docToken } : {}), reason,
      });
      const refs = [...(e.trace ? [`t:${e.trace.traceId}`] : []), ...(e.relayId ? [`r:${e.relayId}`] : [])];
      s.evictedRefs.push(refs);
      for (const k of refs) s.evictedKeys.add(k);
      s.evictedCount += 1;
      if (reason === 'span-budget') s.budgetEvicted += 1;
      s.pins.delete(e.seq);
    }
    if (s.evicted.length > HISTORY_LIMIT) {
      const n = s.evicted.length - HISTORY_LIMIT;
      const lost = s.evicted.splice(0, n);
      for (const refs of s.evictedRefs.splice(0, n)) for (const k of refs) s.evictedKeys.delete(k);
      s.lostThroughSeq = Math.max(s.lostThroughSeq, ...lost.map((e) => e.seq));
    }
    if (!st) return;
    const held = new Set(s.exchanges.flatMap((e) => this.#tracesOf(e, st)));
    for (const e of drop) {
      for (const t of this.#tracesOf(e, st)) if (!held.has(t)) this.#dropTrace(st, t, false);
    }
  }

  /** トレース1つ分の記録（スパン・呼び出し位置・照合・解析）を消す */
  #dropTrace(st: SpanFileState, traceId: string, orphan: boolean): void {
    const b = st.traces.get(traceId);
    if (!b) return;
    st.traces.delete(traceId);
    st.retainedSpans -= b.spans.length;
    for (const x of b.spans) {
      if (orphan && isServerRoot(x)) st.serverOnlyPruned += 1;
      st.pidOf.delete(x.spanId);
      st.callsites.delete(x.spanId);
      this.#dataAccess.delete(x.spanId);
      this.#analyses.delete(x.spanId);
    }
    for (const id of b.callsiteSpanIds) st.callsites.delete(id);
    for (const rid of b.relayIds) {
      const l = st.byRelayId.get(rid)?.filter((x) => x.traceId !== traceId);
      if (l?.length) st.byRelayId.set(rid, l); else st.byRelayId.delete(rid);
    }
  }

  /**
   * 収集ファイルを読んだ後の整理。
   *   1. どの通信にも属さず、猶予を過ぎたトレースを消す
   *   2. それでもスパンが上限を超えていれば、古い通信から外す（保持を頼まれた通信と最新の1件は外さない）
   *   3. それでも超えていれば、猶予の内のトレースも古い順に消す（truncated）
   */
  #prune(s: Session, st: SpanFileState): void {
    const held = new Set(s.exchanges.flatMap((e) => this.#tracesOf(e, st)));
    const limit = this.now() - ORPHAN_GRACE_MS;
    for (const [t, b] of st.traces) {
      if (held.has(t)) continue;
      /* 外した通信のトレース（外した後に読んだスパン）は、猶予を待たずに整理する */
      if (s.evictedKeys.has(`t:${t}`) || [...b.relayIds].some((r) => s.evictedKeys.has(`r:${r}`))) this.#dropTrace(st, t, false);
      else if (b.readAt <= limit) this.#dropTrace(st, t, true);
    }
    if (st.retainedSpans <= SPAN_BUDGET) return;
    const pins = this.#livePins(s);
    const newest = s.exchanges.at(-1)?.seq;
    const sizeOf = (e: LiveExchange) => this.#tracesOf(e, st).reduce((n, t) => n + (st.traces.get(t)?.spans.length ?? 0), 0);
    let over = st.retainedSpans - SPAN_BUDGET;
    const drop: LiveExchange[] = [];
    for (const e of s.exchanges) {
      if (over <= 0) break;
      if (pins.has(e.seq) || e.seq === newest) continue;
      drop.push(e);
      over -= sizeOf(e);
    }
    if (drop.length) this.#evict(s, drop, 'span-budget');
    if (st.retainedSpans <= SPAN_BUDGET) return;
    const held2 = new Set(s.exchanges.flatMap((e) => this.#tracesOf(e, st)));
    const orphans = [...st.traces.entries()].filter(([t]) => !held2.has(t)).sort((a, b) => a[1].readAt - b[1].readAt);
    for (const [t] of orphans) {
      if (st.retainedSpans <= SPAN_BUDGET) break;
      this.#dropTrace(st, t, true);
      st.truncated = true;
    }
  }

  /**
   * いまの起動の観測をまとめる。`run` がいまのセッションと違えば null（呼び出し側が 409 にする）。
   * 返すのは**保持している通信すべて**の証拠（サーバーの中で使う形）。画面へ返すときは
   * `observationView`（要約＋選んだ通信の詳細）に変える。
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
      st = this.#files.get(f) ?? null;
      if (!st) { this.#files.clear(); st = newSpanFileState(f); this.#files.set(f, st); }
      const cur = st;
      readSpanFile(cur, this.now, () => this.#prune(s, cur), () => { this.#dataAccess.clear(); this.#analyses.clear(); });
      /* 新しい書き込みが無くても、猶予を過ぎたトレース・依頼の期限切れを整理する */
      this.#prune(s, cur);
    }

    /* ---- 通信のトレースに属するスパンだけを取り出す。
     * 応答のヘッダが指すトレースに加え、中継の識別子を受け取った受付スパンのトレースも入れる
     * （食い違えば変換が結ばない。どちらか片方だけを信じて取り違えないために両方を渡す） */
    const exchanges = s.exchanges.map((e) => ({ ...e }));
    const traceIds = new Set(exchanges.flatMap((e) => this.#tracesOf(e, st)));
    const spans: (ObsSpan & { sqlRedacted?: unknown })[] = [];
    for (const t of traceIds) spans.push(...(st?.traces.get(t)?.spans ?? []));

    /* 中継を通らずにサーバーが受けた HTTP 処理（IDE 自身の生存確認など）。数だけ。
     * 7C-1: 整理した分（serverOnlyPruned）＋いま持っている、どの通信にも属さないトレースの分 */
    let serverOnlyRequests = st?.serverOnlyPruned ?? 0;
    if (st) {
      for (const [t, b] of st.traces) if (!traceIds.has(t)) serverOnlyRequests += b.spans.filter(isServerRoot).length;
    }

    /* ---- SQL の構文解析（Phase 6F の解析器）。7C-1: スパンごとに1回だけ解析して使い回す */
    const sqlSpans = spans.filter((x) => SQL_TEXT(x.attrs) !== null);
    const parser = sqlSpans.length ? await sqlParser() : null;
    const sqlAnalyses: ObsSqlAnalysis[] = [];
    if (parser) {
      for (const x of sqlSpans) {
        let a = this.#analyses.get(x.spanId);
        if (!a) {
          a = parser.sqlAnalysisRecord({ spanId: x.spanId, sql: SQL_TEXT(x.attrs)!, redacted: x.sqlRedacted ?? null });
          this.#analyses.set(x.spanId, a);
        }
        sqlAnalyses.push(a);
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
        // 照合器を読めなかった結果は使い回さない（次の取得でもう一度試す）。照合の間に整理したスパンの分も持たない
        if (d.failure?.reason !== 'resolver-unavailable'
          && st.traces.get(d.traceId)?.spans.some((x) => x.spanId === d.spanId)) this.#dataAccess.set(d.spanId, d);
      }
      const now = new Map(fresh.map((d) => [d.spanId, d]));
      dataAccess = sqlSpans.map((x) => this.#dataAccess.get(x.spanId) ?? now.get(x.spanId)).filter((d): d is LiveDataAccess => !!d);
    }

    const pins = [...this.#livePins(s)].sort((a, b) => a - b);
    return {
      run: input.run,
      project: input.project,
      port: input.port,
      session: {
        startedAt: s.startedAt,
        recorded: s.lastSeq,
        retention: {
          window: WINDOW, documentReserve: DOC_RESERVE, pinLimit: PIN_LIMIT,
          retained: s.exchanges.length, evicted: s.evictedCount,
          oldestSeq: s.exchanges[0]?.seq ?? null, newestSeq: s.exchanges.at(-1)?.seq ?? null,
          pinned: pins,
          historyLimit: HISTORY_LIMIT, historyLostThroughSeq: s.lostThroughSeq,
          spanBudget: SPAN_BUDGET, retainedSpans: st?.retainedSpans ?? 0, spanBudgetEvicted: s.budgetEvicted,
        },
        excludedStatic: s.excludedStatic,
        readRequestHeaders: RELAY_READ_REQUEST_HEADERS,
        readResponseHeaders: [RELAY_TRACE_HEADER],
        ...(input.dataAccess ? { writtenRequestHeaders: [RELAY_ID_HEADER] } : {}),
      },
      instrumentation: {
        state: input.instrumentation.state,
        reason: input.instrumentation.reason,
        traceHeader: input.traceHeader,
        spanRecords: st?.spansRead ?? 0,
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
          records: st?.callsitesRead ?? 0,
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
