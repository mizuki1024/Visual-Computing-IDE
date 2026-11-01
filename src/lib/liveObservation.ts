/* =============================================================================
 * Phase 7B-3A — いまの起動で観測した HTTP・サーバー処理・SQL の形（純粋な層）。
 *
 * サーバー（中継・観測の台帳・API）と画面（変換・表示）とテストが同じ形を使う。
 * ここには **観測したことだけ** が入る。
 *   * 入らないもの: クエリ文字列の値・ヘッダの一覧・Cookie・本文・SQL のパラメータ値・
 *     接続文字列・行データ。**入る場所が無い**（observation.ts と同じ方針）
 *   * 中継が読む要求ヘッダは `sec-fetch-dest` と `rsc` の2つ、応答ヘッダは
 *     `x-vcide-trace` の1つだけ（`RELAY_READ_*`）。これ以外は値を読まない
 * ========================================================================== */
import type { ObsSpan, ObsSqlAnalysis } from './observation';

/** どの起動の観測か。7B-2 の `previewProtocol.parseRunKey` と同じ3つ組 */
export interface LiveRunKey { instance: string; pid: number; startedAt: string }

export const runKeyString = (k: LiveRunKey): string => `${k.instance}:${k.pid}:${k.startedAt}`;

/** 中継が値を読む要求ヘッダ。**この2つだけ** */
export const RELAY_READ_REQUEST_HEADERS = ['sec-fetch-dest', 'rsc'] as const;
/** 中継が値を読む応答ヘッダ。**この1つだけ。** ブラウザへは渡さない（中継で落とす） */
export const RELAY_TRACE_HEADER = 'x-vcide-trace';

/**
 * 通信の種類。ブラウザが要求に付けた `sec-fetch-dest` と Next.js の `rsc` ヘッダの
 * 有無から決める（値はこの分類にしか使わず、保存しない）。
 */
export type RelayKind = 'document' | 'rsc' | 'fetch' | 'other' | 'unknown';

export const RELAY_KIND_LABEL: Record<RelayKind, string> = {
  document: 'ページの取得',
  rsc: 'ページ内の遷移（RSC）',
  fetch: 'スクリプトからの通信',
  other: 'その他の通信',
  /* ブラウザは Sec-Fetch-* を「信頼できる origin」（https・localhost）にしか送らない。
   * http の転送ホストでは送られないので、推測で埋めずに「わからない」と書く */
  unknown: '種類はわかりません（ブラウザが Sec-Fetch-Dest を送っていません）',
};

/** 中継が転送した通信1件（source = preview-relay / L0） */
export interface LiveExchange {
  /** この観測セッションの中での通し番号（1から） */
  seq: number;
  method: string;
  /** パスだけ。**クエリ文字列は持たない**（付いていたかだけを残す） */
  path: string;
  hasQuery: boolean;
  kind: RelayKind;
  /** 開発サーバーの応答の状態。応答が無ければ null */
  status: number | null;
  /** 中継が要求を受けた時刻（エポックのミリ秒） */
  startMs: number;
  /** 中継が応答を送り終えるまで。**ブラウザが測った値ではない** */
  durationMs: number | null;
  /** 応答の専用ヘッダ（`x-vcide-trace`）から読んだサーバー側のトレース。無ければ null */
  trace: { traceId: string; spanId: string } | null;
  /** 応答が返らなかった場合 */
  failure: { kind: 'upstream-error' | 'aborted'; detail: string | null } | null;
}

export interface LiveRunObservation {
  run: LiveRunKey;
  project: string;
  port: number;
  /** 観測セッション。**起動ごとに作り直す**（起動をまたいで混ぜない） */
  session: {
    /** このセッションを作った時刻（＝開発サーバーが running になった時刻） */
    startedAt: string;
    /** 記録した通信の数（上限を超えた分は overflow に数える） */
    recorded: number;
    overflow: number;
    /** 静的資材（/_next/* など）。通信として数えず、件数だけ */
    excludedStatic: number;
    readRequestHeaders: readonly string[];
    readResponseHeaders: readonly string[];
  };
  instrumentation: {
    state: 'enabled' | 'disabled' | 'unavailable';
    reason: string | null;
    /** 起動先に専用ヘッダでトレース識別子を返させたか */
    traceHeader: boolean;
    /** 収集ファイルから読んだスパンの数（いまの起動の全体） */
    spanRecords: number;
    /** 読み取りの上限に当たったか */
    truncated: boolean;
  };
  exchanges: LiveExchange[];
  /** 通信のトレースに属するスパンだけ（取得時点でマスク済みの属性） */
  spans: ObsSpan[];
  /** SQL スパンの構文解析（Phase 6F の `sqlparse.mjs` をそのまま使う） */
  sqlAnalyses: ObsSqlAnalysis[];
  /** 構文解析器を使えたか。使えなければ解析しない（推測で埋めない） */
  parser: { available: boolean; reason: string | null };
  /** 中継を通らずにサーバーが受けた HTTP 処理の数（IDE 自身の生存確認など）。描かない */
  serverOnlyRequests: number;
  collectedAt: string;
}

/* ------------------------------------------------------------- 中継での分類 */

const STATIC_EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|txt|webmanifest)$/i;

/**
 * 中継が受けた要求を分類する。**URL の全体は返さない。**
 * 静的資材は通信として数えない（PoC-01 と同じ扱い。件数だけ残す）。
 */
export function classifyRelayRequest(
  rawUrl: string, dest: string | undefined, rsc: string | undefined,
): { static: true } | { static: false; path: string; hasQuery: boolean; kind: RelayKind } {
  const q = rawUrl.indexOf('?');
  const h = rawUrl.indexOf('#');
  const end = [q, h].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? rawUrl.length;
  let path = rawUrl.slice(0, end) || '/';
  if (path.length > 300) path = `${path.slice(0, 299)}…`;
  if (path.startsWith('/_next/') || path.startsWith('/__nextjs') || path === '/favicon.ico'
    || STATIC_EXT.test(path)) return { static: true };
  const kind: RelayKind = rsc === '1' ? 'rsc'
    : dest === 'document' || dest === 'iframe' ? 'document'
      : dest === 'empty' ? 'fetch' : dest ? 'other' : 'unknown';
  return { static: false, path, hasQuery: q >= 0 && q < rawUrl.length - 1, kind };
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** W3C traceparent の形だけを受け付ける。全ゼロ（無効値）も受けない */
export function parseTraceparent(v: unknown): { traceId: string; spanId: string } | null {
  if (typeof v !== 'string') return null;
  const m = TRACEPARENT.exec(v.trim());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], spanId: m[2] };
}
