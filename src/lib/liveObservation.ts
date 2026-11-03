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
  | 'callsite-pid-missing'
  | 'no-entry-callsite' | 'no-app-frame' | 'source-line-mismatch' | 'component-not-agreed'
  | 'outside-scope' | 'build-changed-after-call' | 'source-changed-after-call' | 'build-freshness-unverified'
  | 'manifest-unavailable' | 'resolver-unavailable'
  /* 7C HMR 安全対策（案A）。A1: 実行したコードのフレーム */
  | 'hmr-evaluated-code' | 'unrecognized-frame' | 'frame-origin-unverified'
  /* A2: 要求の開始からの鮮度 */
  | 'request-start-unknown' | 'changed-during-request'
  /* A3: ソースマップの区画の sourcesContent といまのソース */
  | 'map-source-mismatch' | 'map-source-unverified'
  /* 7C HMR 最終安全対策。A4: 実行したコードとディスクの生成物の版。A5: 読み直した生成物とソースマップの組 */
  | 'executed-code-mismatch' | 'executed-code-unverified' | 'build-map-unbound';

/**
 * 7C: 「SQL は観測したが、実行したコードとソース・ソースマップの対応を確かめられない」理由（案A の A1〜A3 と、
 * 7B-3B-1 の実行の後の書き換え）。由来の評価はこれらを「SQL を観測していない」と区別する
 * （`fetch-callsite-unverifiable`）。どれも位置を推測で埋めない
 */
export const CALLSITE_UNVERIFIABLE_REASONS: ReadonlySet<DataAccessFailureReason> = new Set<DataAccessFailureReason>([
  'hmr-evaluated-code', 'unrecognized-frame', 'frame-origin-unverified',
  'request-start-unknown', 'changed-during-request',
  'map-source-mismatch', 'map-source-unverified',
  'executed-code-mismatch', 'executed-code-unverified', 'build-map-unbound',
  'build-changed-after-call', 'source-changed-after-call',
]);

export const DATA_ACCESS_FAILURE_LABEL: Record<DataAccessFailureReason, string> = {
  'callsite-disabled': 'この起動では、呼び出し位置の記録（計装の POC02_CALLSITE）を有効にしていません',
  'no-callsite-record': 'この SQL のスパンには、呼び出し位置の記録がありません',
  'multiple-callsite-records': 'この SQL のスパンに呼び出し位置の記録が2件以上あり、1つに決まりません',
  'callsite-mismatch': '呼び出し位置の記録が、この SQL のスパンと別のトレース・別のプロセス・別の種類を指しています',
  'callsite-pid-missing': '呼び出し位置の記録か SQL のスパンに、書いたプロセスの PID が無く、同じプロセスの記録だと確かめられません',
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
  'hmr-evaluated-code': 'サーバー側のコードが同じ起動の中で更新された（HMR でプロセスの中で差し替えられた）コードが SQL を実行したため、'
    + 'ディスク上の生成物・ソースマップとの対応を確かめられず、SQL の実行位置を確認できません。開発サーバーを再起動すると確認できる場合があります',
  'unrecognized-frame': '呼び出しのスタックに形を認識できないフレームがあり、それより外側のフレームを採ると別の呼び出し位置を指しうるため、SQL の実行位置を確認できません',
  'frame-origin-unverified': '呼び出し位置の記録に、HMR で差し替えられたコードかどうかの判定（V8 の呼び出し位置の API による）が無いため、SQL の実行位置を確認できません',
  'request-start-unknown': 'この SQL が属する要求の開始（受付スパン）を確かめられないため（応答を送り終える前・受付スパンが1つに決まらない）、'
    + '要求の処理中にコードが更新されていないかを確かめられず、SQL の実行位置を確認できません',
  'changed-during-request': 'この SQL が属する要求の処理中（開始の直前を含む）に、ソース・生成物・ソースマップのどれかが更新されたため、'
    + '実行したコードといまのソース・ソースマップが同じとは限らず、SQL の実行位置を確認できません。もう一度読み込むと確認できる場合があります',
  'map-source-mismatch': 'ソースマップに埋め込まれた元のソース（sourcesContent）が、いまのソースと一致しません（ソースマップが古いか別の版から作られた）。'
    + 'SQL の実行位置を確認できません。開発サーバーを再起動すると確認できる場合があります',
  'map-source-unverified': 'ソースマップに元のソースの内容（sourcesContent）が無い・読めないため、ソースマップといまのソースが同じ版かを確かめられず、SQL の実行位置を確認できません',
  'executed-code-mismatch': 'SQL を実行したコードは、サーバー側のコードが同じ起動の中で更新される前の古い版のままで（同じ生成物の中の、変えていないモジュールなど）、'
    + 'いまの生成物・ソースマップには同じ内容のコードが無いため、SQL の実行位置を確認できません。開発サーバーを再起動すると確認できる場合があります',
  'executed-code-unverified': 'SQL を実行したコードの版（実行中のスクリプトの内容のハッシュ）を確かめる証拠が無い・生成物を読めないため、'
    + 'いまの生成物・ソースマップと同じ版かを確かめられず、SQL の実行位置を確認できません',
  'build-map-unbound': '位置を戻した後に読み直した生成物かソースマップが、照合に使ったものと違う、またはソースマップが生成物の内容に合わない（書き込みの途中など）ため、'
    + 'SQL の実行位置を確認できません。もう一度読み込むと確認できる場合があります',
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
  /**
   * 7B-3B-2: 中継がこの応答（HTML）に差し込んだスクリプトに書いた、**文書の識別子**。
   * HTML を差し込んだ応答にだけある。`relayId` とは別の乱数で、開発サーバーには送らない。
   * iframe の文書がこの値を知らせてくることで、表示中の文書がどの通信の応答かを照合する（`bindDocument`）
   */
  docToken?: string;
}

/**
 * Phase 7C-1: 観測セッションの保持の状態（P0-1）。
 *
 * 7B-3A〜7C-0 は 200 件に達すると**新しい**通信を捨てていた（以後の選択が文書を同定できない）。
 * 7C-1 からは**古い**通信を外す（スライディングウィンドウ）。通し番号は起動の中で一意・単調増加で、
 * 外した通信の番号を使い回さない。外した通信は「保持対象外」の記録（`EvictedExchange`）として
 * サーバーの中にだけ残し、その文書を選んだときに理由を出す。
 */
export interface LiveRetention {
  /** 直近の何件を必ず持つか（種類を問わない） */
  window: number;
  /** それに加えて、文書の識別子を持つ直近の何件の文書（HTML の応答）を持つか */
  documentReserve: number;
  /** 画面が表示中・同定中の通信として保持を頼める数（期限つき） */
  pinLimit: number;
  /** いま持っている通信の数 */
  retained: number;
  /** 保持範囲から外した通信の数（この起動の累計） */
  evicted: number;
  /** いま持っている通信の最小・最大の番号 */
  oldestSeq: number | null;
  newestSeq: number | null;
  /** 保持を頼まれている（期限内の）通信の番号 */
  pinned: number[];
  /** 「保持対象外」の記録をいくつまで持つか。これを超えた古い記録は番号の範囲だけを残す */
  historyLimit: number;
  /** 「保持対象外」の記録も整理した番号の上限（0 = 整理していない）。これ以下の通信は何も確かめられない */
  historyLostThroughSeq: number;
  /** 持つスパンの上限と、いま持っている数。上限を超えると古い通信から外す（spanBudgetEvicted に数える） */
  spanBudget: number;
  retainedSpans: number;
  spanBudgetEvicted: number;
}

/** Phase 7C-1: 一覧に出す通信ごとの要約（サーバーで判定した結果。スパン本体は返さない） */
export interface LiveExchangeSummary {
  seq: number;
  /** 通信をサーバー処理（受付スパン）に結べたか */
  server: boolean;
  /** 結べた SQL のスパンの数 */
  sql: number;
  /** そのうち実行した呼び出し位置（DataAccessSite）を特定できた数。照合しない観測では null */
  sited: number | null;
}

/**
 * Phase 7C-1: 保持範囲から外した通信の記録（**サーバーの中だけ**。画面へは返さない）。
 * 文書の同定で「保持対象外」と言うためと、外した RSC の再取得を見落とさないために持つ。
 */
export interface EvictedExchange {
  seq: number;
  kind: RelayKind;
  path: string;
  startMs: number;
  docToken?: string;
  /** なぜ外したか: 直近の件数の範囲の外 / スパンの上限 */
  reason: 'window' | 'span-budget';
}

export interface ExchangeHistory {
  evicted: readonly EvictedExchange[];
  lostThroughSeq: number;
  window: number;
}

export interface LiveRunObservation {
  run: LiveRunKey;
  project: string;
  port: number;
  /** 観測セッション。**起動ごとに作り直す**（起動をまたいで混ぜない） */
  session: {
    /** このセッションを作った時刻（＝開発サーバーが running になった時刻） */
    startedAt: string;
    /** この起動で記録した通信の数（保持範囲から外したものも含む累計。＝最新の通し番号） */
    recorded: number;
    /** 7C-1: 保持の状態（7C-0 までの `overflow` の代わり。通信を捨てずに古いものを外す） */
    retention: LiveRetention;
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
  /**
   * いま保持している通信（番号の昇順）。7C-1: `detailSeqs` がある観測では、その外の通信は
   * 一覧に要る項目だけを持つ（中継の識別子・文書の識別子は**サーバーに残して返さない**）
   */
  exchanges: LiveExchange[];
  /**
   * 7C-1: スパン・SQL の解析・呼び出し位置の照合を、どの通信の分だけ入れたか。
   * 無ければ（7C-0 までの形）保持しているすべての通信の分が入っている。
   * **ここに無い通信を変換（fromLiveRun）・照合（liveExchangeLinks）に使ってはいけない**
   * （証拠を持たないので「未接続」と誤って描く）。`hasDetail` で確かめる
   */
  detailSeqs?: number[];
  /** 7C-1: 一覧のための通信ごとの要約（サーバーが全件の証拠で判定したもの） */
  summaries?: LiveExchangeSummary[];
  /** 7C-1: この観測の中身の指紋。画面が同じ値を送れば、サーバーは中身を返さない（変化なし） */
  etag?: string;
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

/* ============================================================================
 * Phase 7B-3B-2 — 選択した要素を描いた文書と、中継が観測した通信の同定
 * ========================================================================== */

/** 選んだ要素の文書について、プレビューのスクリプトが知らせたもの（previewProtocol の SelectionDocument と同じ形） */
export interface SelectionDocumentInput { token: string | null; soft: boolean | null }

export type DocUnboundReason =
  | 'no-document-token' | 'client-navigation' | 'token-not-in-session' | 'token-duplicated'
  | 'path-mismatch' | 'document-failed' | 'refetched-after-document'
  /* 7C-1: 保持範囲（スライディングウィンドウ） */
  | 'exchange-evicted' | 'history-evicted';

export const DOC_UNBOUND_LABEL: Record<DocUnboundReason, string> = {
  'no-document-token': 'この文書から、中継が応答に付けた識別子の知らせがありません（中継が返した説明のページ・識別子を付ける前の起動・HTML 以外の応答など）',
  'client-navigation': 'この文書の中でクライアント側の遷移（React のページ内の遷移）がありました。表示中の DOM は文書の取得が描いたものとは限りません',
  'token-not-in-session': 'この文書の識別子は、いまの起動の観測セッションの通信にありません（別の起動・停止の前の文書、またはまだ応答を送り終えていない）',
  'token-duplicated': 'この文書の識別子を持つ通信が2件以上あり、1つに決まりません',
  'path-mismatch': '識別子が指す通信のパスが、選択したページのパスと違います',
  'document-failed': '識別子が指す通信は、正常な応答（2xx）を送り終えていません',
  'refetched-after-document': 'この文書の取得の後に、同じパスのページの再取得（RSC）がありました。表示中の DOM はその再取得で描き直された可能性があります',
  'exchange-evicted': 'この文書の通信は、観測の保持範囲から外れています（保持対象外）。古い通信の証拠（トレース・SQL）はもう持っていません。プレビューを読み込み直してから選んでください',
  'history-evicted': 'この文書の通信より後の通信の記録を整理済みのため、同じパスの再取得（RSC）が無かったことを確かめられません（保持対象外）。プレビューを読み込み直してから選んでください',
};

/** 7C-1: 一覧・変換に使ってよい（証拠を持っている）通信か */
export const hasDetail = (obs: LiveRunObservation, seq: number): boolean =>
  obs.exchanges.some((e) => e.seq === seq) && (!obs.detailSeqs || obs.detailSeqs.includes(seq));

/**
 * 選択した要素を描いた文書の同定の結果。
 *
 * `identified` が言うのは「**いま iframe に表示している文書は、中継が記録した通信 #seq の応答である**」までである。
 * 表示された値がその通信のどの SQL の結果から来たかは、これだけでは言えない（別に `supplies` の条件で調べる）。
 */
export type DocBinding =
  | { status: 'identified'; seq: number; checks: string[] }
  | { status: 'unidentified'; reason: DocUnboundReason; detail: string };

const DOC_CHECKS = [
  'iframe の文書のスクリプトが、中継がその応答に付けた識別子を知らせてきた（IDE が開いている接続・いまの起動の文書）',
  'その識別子を持つ通信が、いまの起動の観測セッションにちょうど1件ある',
  'その通信のパスが、選択したページのパスと同じ',
  'その通信は正常な応答（2xx）を送り終えている',
  'その文書の中でクライアント側の遷移が無く、同じパスの再取得（RSC）も無い',
];

/**
 * 選択した要素を描いた文書を、中継の記録の1件に同定する。**照合だけで決める**（時刻の近さ・パスだけでは結ばない）。
 * 1つでも欠ければ同定しない（理由を返す）。
 */
export function bindDocument(
  obs: LiveRunObservation, doc: SelectionDocumentInput | null | undefined, selPath: string,
  /** 7C-1: 保持範囲から外した通信の記録（サーバーの中だけ）。無ければ外した通信は無いものとして扱う */
  history?: ExchangeHistory,
): DocBinding {
  const no = (reason: DocUnboundReason, detail = ''): DocBinding => ({ status: 'unidentified', reason, detail });
  if (!doc || !doc.token) return no('no-document-token');
  if (doc.soft !== false) {
    return no('client-navigation', doc.soft === null ? 'スクリプトが遷移の有無を知らせていません' : '');
  }
  if (obs.detailSeqs) throw new Error('bindDocument には要約ではない（サーバーの中の）観測を渡す');
  const evicted = history?.evicted ?? [];
  const hits = obs.exchanges.filter((e) => e.docToken === doc.token);
  const gone = evicted.filter((e) => e.docToken === doc.token);
  if (hits.length + gone.length > 1) return no('token-duplicated', `${hits.length + gone.length} 件`);
  if (gone.length) {
    const g = gone[0];
    return no('exchange-evicted', `通信 #${g.seq}（${g.path}）は${g.reason === 'window'
      ? `、直近 ${history?.window ?? '—'} 件の保持範囲より古くなったため外しました`
      : '、スパンの上限に達したため外しました'}`);
  }
  if (!hits.length) {
    return no('token-not-in-session', history && history.lostThroughSeq > 0
      ? `この起動の通信 #1〜#${history.lostThroughSeq} は保持範囲の外の記録も整理済みで、それより古い文書かどうかは確かめられません`
      : '');
  }
  const ex = hits[0];
  if (ex.path !== selPath) return no('path-mismatch', `通信 #${ex.seq} は ${ex.path}、選択は ${selPath}`);
  if (ex.failure || ex.status === null || ex.status < 200 || ex.status > 299) {
    return no('document-failed', `通信 #${ex.seq} の応答: ${ex.status ?? 'なし'}`);
  }
  /* 文書の後に、同じパスのページを RSC で取り直した通信があれば、DOM が描き直された可能性がある（保守的に断る） */
  const re = [...obs.exchanges, ...evicted]
    .find((e) => e.seq !== ex.seq && e.kind === 'rsc' && e.path === ex.path && e.startMs >= ex.startMs);
  if (re) return no('refetched-after-document', `通信 #${re.seq}`);
  /* 7C-1: この文書より後の通信の記録を整理済みなら、再取得が無かったとは言えない（保守的に断る） */
  if (history && history.lostThroughSeq > ex.seq) {
    return no('history-evicted', `通信 #${ex.seq + 1}〜#${history.lostThroughSeq} の記録を整理済み`);
  }
  return { status: 'identified', seq: ex.seq, checks: DOC_CHECKS };
}

/* ============================================================================
 * Phase 7B-3B-2 — 表示値の由来（`supplies`）の評価結果
 * ========================================================================== */

/**
 * 由来を結ばなかった理由。**どの段の条件が欠けたか**を分ける（document / static / measured / select-list）。
 */
export type LineageCutReason =
  /* 文書の同定 */
  | 'document-unidentified'
  /* 静的解析 */
  | 'selection-unresolved' | 'analyzer-unavailable' | 'source-changed-after-run'
  | 'no-value-site' | 'mixed-text-children' | 'multiple-value-sites'
  | 'no-reference' | 'multiple-fetch-sites'
  /* 実測との照合 */
  | 'no-server-link' | 'fetch-not-measured' | 'fetch-site-unverified' | 'fetch-callsite-unverifiable' | 'select-list-differs'
  /* SELECT 句 */
  | 'no-column';

export type LineageStage = 'document' | 'static' | 'measured' | 'select-list';

export const LINEAGE_STAGE_LABEL: Record<LineageStage, string> = {
  document: '文書の同定',
  static: '静的解析',
  measured: '実測との照合',
  'select-list': '実行SQLの SELECT 句',
};

export const LINEAGE_CUT_LABEL: Record<LineageCutReason, { stage: LineageStage; text: string }> = {
  'document-unidentified': { stage: 'document', text: '選択した要素を描いた文書を、観測した通信に同定できません' },
  'selection-unresolved': { stage: 'static', text: '選択した要素の描画位置（JSX）を特定できていません' },
  'analyzer-unavailable': { stage: 'static', text: '静的解析器（PoC-04 の lineage.mjs）を使えません' },
  'source-changed-after-run': { stage: 'static', text: 'その文書を取得した後にソースが書き換わったため、静的解析が実行したコードを見ているとは限りません' },
  'no-value-site': { stage: 'static', text: '選択した要素の直下に、値を描く式（JSX の {…}）がありません' },
  'mixed-text-children': { stage: 'static', text: '選択した要素の直下に固定の文字と式が混在し、選んだテキストがどれかを決めません' },
  'multiple-value-sites': { stage: 'static', text: '選択した要素の直下に値を描く式が2つ以上あり、選んだテキストがどれかを決めません' },
  'no-reference': { stage: 'static', text: '静的解析で、この値からデータ取得の結果への参照の連鎖を解けません（定数・追えない関数・条件の判定など）' },
  'multiple-fetch-sites': { stage: 'static', text: 'この値は2つ以上のデータ取得の結果を参照しうるため、取得位置を1つに決めません' },
  'no-server-link': { stage: 'measured', text: '同定した文書の通信を、サーバー処理・SQL に結べていません' },
  'fetch-not-measured': { stage: 'measured', text: '静的解析が見たデータ取得の呼び出しで実行された SQL を、この文書の通信で観測していません（走っていない SQL の列は由来にしない）' },
  'fetch-site-unverified': { stage: 'measured', text: '静的解析が見た呼び出し位置で SQL が実行されたことを、実測の呼び出し位置（server-call-stack）で確かめられません' },
  'fetch-callsite-unverifiable': { stage: 'measured', text: 'この文書の通信で SQL は観測しましたが、その呼び出し位置を確かめられません（サーバー側のコードの更新・要求の処理中の変更・ソースマップとソースの食い違いなど）。'
    + '静的解析が見た取得の呼び出しで実行された SQL かどうかを決めないため、列を由来にしません。開発サーバーを再起動すると確かめられる場合があります' },
  'select-list-differs': { stage: 'measured', text: '同じ呼び出し位置から SELECT 句の構成が違う SQL が複数走っており、どれの列かを決めません' },
  'no-column': { stage: 'select-list', text: '参照している項目が、実行された SQL の SELECT 句にありません（テーブルも主張しない）' },
};

export interface LiveLineageCandidate {
  schema: string; table: string; column: string;
  via: 'field' | 'anyfield';
  note: string | null;
  /** どの取得の呼び出しの結果を参照したか（静的解析が見た位置。列はメソッド名の位置） */
  query: { file: string; line: number; col: number };
  trail: string[];
}

/**
 * 選んだ要素の値の由来（`supplies: DataAccessSite → PropBindingSite`、L2・static-analysis）の評価。
 *
 * `status: 'linked'` は、文書の同定・静的解析・実測の呼び出し位置・実行SQL の SELECT 句の
 * **すべての条件が通った**ときだけ。結論はつねに推定（L2）であり、実測の照合を通っても昇格しない。
 */
export interface LiveLineage {
  method: string;
  scope: string;
  status: 'linked' | 'cut';
  cut: { reason: LineageCutReason; stage: LineageStage; detail: string } | null;
  binding: DocBinding;
  /** 値を描く式（PropBindingSite）。要素の位置と、式そのものの位置 */
  site: {
    file: string; line: number; col: number; component: string | null; expr: string;
    element: { file: string; line: number; col: number; tag: string };
  } | null;
  /** 実測した呼び出し位置（DataAccessSite）。静的解析の位置と列まで一致したもの */
  fetch: { file: string; line: number; col: number; component: string } | null;
  /** 候補になった取得の呼び出し（静的解析）。2つ以上なら取得位置を決めない */
  staticFetches: { file: string; line: number; col: number; measured: boolean }[];
  exchangeSeq: number | null;
  /** 結びついた実測 SQL のスパン */
  sqlSpanIds: string[];
  outcome: 'confirmed' | 'candidates' | 'table-only' | 'none';
  candidates: LiveLineageCandidate[];
  tableCandidates: { schema: string; name: string; why: string }[];
  transformed: boolean;
  literalPaths: number;
  untracked: { why: string; detail: string | null }[];
  unresolved: { why: string; text: string }[];
  reasons: string[];
  /** 通った条件（画面の根拠に出す） */
  checks: string[];
}
