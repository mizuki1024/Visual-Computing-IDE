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
 * Phase 7B-3B-1: 中継が**要求ごとに自分で作って**開発サーバーへの要求に載せる識別子のヘッダ。
 * 計装はこれを受付スパンの属性（`RELAY_ID_ATTR`）に写す。ブラウザから来た同名のヘッダは
 * 転送しない（中継が必ず上書きする）。値は 16 進 32 桁の乱数で、何の情報も含まない。
 *
 * **なぜ要るか。** 応答の `x-vcide-trace` はアプリのプロセスの中で付くので、同じパスの別の
 * 要求のトレースに付け替えられても、パスの照合（7B-3A）では見分けられない。中継が作った値は
 * 中継が知っているので、「その値を受け取った受付スパン」を探せば付け替えを検出できる。
 */
export const RELAY_ID_HEADER = 'x-vcide-relay';
export const RELAY_ID_ATTR = 'vcide.relay.id';
export const RELAY_ID_RE = /^[0-9a-f]{32}$/;

/**
 * 通信とサーバー処理を結んだ根拠（7B-3B-1）。
 *   relay-id     中継が作った識別子を受け取った受付スパンが1本だけあり、応答のトレース識別子とも食い違わない
 *   trace-header 7B-3A の規則（応答のトレース識別子＋パスの照合）。中継の識別子を持たない記録だけに使う
 */
export type HandlesBasis = 'relay-id' | 'trace-header';

/**
 * サーバー側でデータ取得の呼び出し位置を特定できなかった理由（`server-call-stack`）。
 * 前の4つは収集ファイルの記録の照合、中の4つは PoC-02 の4段（`rscattr.mjs`）、後ろは 7B-3B-1 の追加。
 */
export type DataAccessFailureReason =
  | 'callsite-disabled' | 'no-callsite-record' | 'multiple-callsite-records' | 'callsite-mismatch'
  | 'no-entry-callsite' | 'no-app-frame' | 'source-line-mismatch' | 'component-not-agreed'
  | 'outside-scope' | 'build-changed-after-call' | 'source-changed-after-call' | 'build-freshness-unverified'
  | 'manifest-unavailable' | 'resolver-unavailable';

export const DATA_ACCESS_FAILURE_LABEL: Record<DataAccessFailureReason, string> = {
  'callsite-disabled': 'この起動では、呼び出し位置の記録（計装の POC02_CALLSITE）を有効にしていません',
  'no-callsite-record': 'この SQL のスパンには、呼び出し位置の記録がありません',
  'multiple-callsite-records': 'この SQL のスパンに呼び出し位置の記録が2件以上あり、1つに決まりません',
  'callsite-mismatch': '呼び出し位置の記録が、この SQL のスパンと別のトレース・別のプロセス・別の種類を指しています',
  'no-entry-callsite': '呼び出しの入口でスタックを記録できていません（この計装が入口を包んでいないドライバ — Prisma など）',
  'no-app-frame': 'スタックに、注入範囲（src/）のソースへ戻せるフレームがありません',
  'source-line-mismatch': 'ソースマップで戻した位置のソース行に、データ取得の呼び出しがありません',
  'component-not-agreed': '囲むコンポーネントが、ソースの読み直しとビルド時の対応表で一致しません（コンポーネントではない関数の中など）',
  'outside-scope': '戻した位置が、対象プロジェクトの注入範囲（src/）の外です',
  'build-changed-after-call': 'SQL の実行の後に生成物が書き換わったため、ソースマップの戻しを信用できません',
  'source-changed-after-call': 'SQL の実行の後にソースファイルが書き換わったため、読み直した行が実行したコードとは限りません',
  'build-freshness-unverified': '生成物がバンドラの仮想モジュールで、実行の後に書き換わっていないかを確かめられません',
  'manifest-unavailable': 'ビルド時の対応表（要素識別子の注入）が無いため、囲むコンポーネントを2つの情報源で照合できません',
  'resolver-unavailable': '呼び出し位置の照合器（PoC-02 の rscattr.mjs）を読み込めません',
};

/**
 * SQL のスパン1本について、それを実行したデータ取得の呼び出し位置（`DataAccessSite`）を
 * 特定できたか（取得手段 `server-call-stack`）。
 *
 * `site` が入るのは、PoC-02 の4段（入口のスタック → ソースマップで戻す → ソース行の読み直し →
 * 囲むコンポーネントの2情報源の一致）と、7B-3B-1 の照合（記録が1件・同じトレースと
 * プロセス・注入範囲の中・実行の後に生成物もソースも書き換わっていない）が**すべて**通ったときだけ。
 */
export interface LiveDataAccess {
  spanId: string;
  traceId: string;
  /** 呼び出しの入口（pg-pool.Pool.query など）。記録が無ければ null */
  at: string | null;
  site: {
    file: string; line: number; col: number;
    functionName: string | null;
    /** 読み直したソースの1行（全文は持たない） */
    sourceLine: string;
    /** 囲むコンポーネント定義。**文脈であって端点ではない**（M1 決定 A） */
    component: { name: string; file: string; line: number; endLine: number };
  } | null;
  /**
   * ソースマップで戻せた位置。`site` が null でも、戻すところまで通っていれば入る。
   * **関係を作る根拠にはしない**（理由とともに出すだけ）。
   */
  located: { file: string; line: number; col: number } | null;
  failure: { reason: DataAccessFailureReason; detail: string } | null;
  /** 通った照合（画面の根拠に出す） */
  checks: string[];
}

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
  /**
   * 7B-3B-1: 中継がこの要求のために作って開発サーバーへ載せた識別子（`RELAY_ID_HEADER`）。
   * ブラウザには渡していない。中継を通った記録には必ず入る（入っていない記録は 7B-3A の形）
   */
  relayId?: string;
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
    /** 7B-3B-1: 中継が開発サーバーへの要求に**書き足す**ヘッダ（値は中継が作った乱数だけ） */
    writtenRequestHeaders?: readonly string[];
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
  /**
   * 7B-3B-1: 通信のトレースに属する SQL のスパンごとの、データ取得の呼び出し位置の照合結果。
   * 無い（7B-3A の形の）観測では、どの SQL にも `queries` を作らない
   */
  dataAccess?: LiveDataAccess[];
  /** 7B-3B-1: 呼び出し位置の記録の状態 */
  callsite?: {
    /** この起動で呼び出し位置の記録を有効にしたか */
    enabled: boolean;
    /** 収集ファイルにあった SQL の呼び出し位置の記録の数（いまの起動の全体） */
    records: number;
    resolver: { available: boolean; reason: string | null };
  };
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
