/* =============================================================================
 * 観測結果の入力スキーマ（層1）— PoC-01 のランナーが出力する JSON の形。
 *
 * ここに入るのは「観測したこと」だけである。
 *   * SQL のパラメータ値・接続文字列・Cookie・Authorization・トークン・
 *     パスワード・個人情報・行データ・本文は**入る場所が無い**（05c 3章 / NFR-20）
 *   * 取れなかったものは meta.notObserved に理由付きで書く。省略しない（OBS-05）
 * ========================================================================== */

/** 計装が生成したスパン1本。属性は取得時点で許可リストを通したものだけ。 */
export interface ObsSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** OpenTelemetry の SpanKind（0=internal, 1=server, 2=client …） */
  kind: number;
  /** エポックからのミリ秒 */
  startMs: number;
  endMs: number;
  durationMs: number;
  statusCode: number;
  /** 計装の名前（next.js / prisma / @opentelemetry/instrumentation-pg …） */
  scope: string;
  /**
   * どのサービスのプロセスが出したスパンか（PoC-02）。
   * 1つのトレースが2つのサービスにまたがることがあるため、記録しておく。
   * 無い記録（PoC-01 / 03 / 05）では存在しない。
   */
  service?: string;
  attrs: Record<string, string | number | boolean>;
  /** 値を読まずに捨てた属性キー。何を捨てたかは残す */
  droppedAttributeKeys: string[];
}

/* ---------------------------------------------------------------- PoC-05 */

/**
 * 「この通信を開始したコード」の観測（source = request-initiator）。
 *
 * 根拠はブラウザが要求を送る時点で記録した呼び出しスタックだけである。
 * 時刻の近さ・DOM 上の近さは根拠に使わない。
 * 成立の条件が1つでも欠けたら `component` を null にして理由を返す。
 */
export interface ObsRequestInitiator {
  /** ブラウザが記録した initiator の種別（script / parser / preload / other） */
  type: string | null;
  frameCount: number;
  /** 解決できた最上位のアプリ側フレーム。解決できなければ null */
  frame: { file: string; line: number; col: number; functionName: string | null } | null;
  /** そのソース行を読み直して、通信の呼び出しがあることを確認できたか */
  verified: boolean;
  /** 照合した1行。ソース全文は持たない */
  sourceLine: string | null;
  /**
   * その行を囲むコンポーネント。**ソースの読み直しとビルド時のマニフェストの
   * 両方が同じ名前に決まったときだけ**値が入る。
   */
  component: { name: string; file: string; line: number; endLine: number } | null;
  /** 作れなかった理由（FR-11b）。null を返して無反応にしない */
  failure: { reason: string; detail: string | null } | null;
}

/** リダイレクトの1段。段ごとに別のサーバースパン（別トレース）である。 */
export interface ObsRedirectHop {
  path: string | null;
  status: number;
  server: { traceId: string; spanId: string } | null;
  via: string | null;
}

/** ブラウザのネットワーク記録1件。ヘッダ一覧も本文も持たない。 */
export interface ObsBrowserRequest {
  method: string;
  path: string;
  status: number;
  /** エポックからのミリ秒 */
  startMs: number;
  /** ブラウザから見た所要時間。取れなければ null */
  durationMs: number | null;
  /** 応答ヘッダから読んだサーバー側のトレース。取れなければ null */
  server: { traceId: string; spanId: string } | null;
  isDocument: boolean;

  /* ---- 以下は PoC-05 の観測。PoC-01 / PoC-03 の記録には存在しない ---- */

  /** ブラウザ内の要求識別子（CDP の requestId）。サーバー側の値ではない */
  browserRequestId?: string;
  /** どのヘッダから識別子を読んだか。公開範囲の検証に使う */
  via?: 'dedicated-header' | 'server-timing' | null;
  /** 2つのヘッダから読めた場合、同じ識別子だったか */
  headersAgree?: boolean | null;
  /** 応答ヘッダから取り出したキー。**この2つ以外は読んでいない**ことの記録 */
  readHeaderKeys?: string[];
  /** リダイレクトの前段。1回の通信に応答が複数返った場合に入る */
  redirects?: ObsRedirectHop[];
  /** 失敗の種別。応答が返らなかった場合は識別情報を持てない */
  failure?: { kind: string; detail: string | null } | null;
  /** 通信を開始したコードの観測 */
  initiator?: ObsRequestInitiator | null;
  /** クエリ文字列が付いていたか。**値は持たない** */
  hasQuery?: boolean;
  /** 同一オリジンでなかった場合のオリジン */
  crossOrigin?: string | null;
}

/** 実測された SQL 文の構文解析の結果。推測で埋めない。 */
export interface ObsSqlAnalysis {
  /** この解析の元になったスパン */
  spanId: string;
  /** リテラルを除いた SQL 文 */
  sql: string;
  /** 除いたリテラルの数。構造だけを取ったことの記録 */
  redacted: { strings: number; numbers: number } | null;
  parseOk: boolean;
  parseError: string | null;
  /**
   * 文の種別（`select` / `insert` / `update` / `delete`）。
   * Phase 6F で追加。**結果列が無いこと**と**結果列を解けなかったこと**を
   * 区別するために要る（UPDATE に結果列が無いのは不具合ではない）。
   */
  statementType?: string;
  /** `op` は tableList の動詞（`select` / `insert` / …）。Phase 6F で追加 */
  tables: { schema: string | null; name: string; op?: string }[];
  /**
   * **SELECT / RETURNING 句の結果列**のうち、スキーマ・テーブル・列名が揃った
   * ものだけが入る（02a 3.5.1 の `projects` = SqlStatement → DbColumn）。
   *
   * **WHERE / JOIN ON / ORDER BY / GROUP BY / HAVING での参照は入らない。**
   * それらは列を読んではいるが結果列ではないので、`projects` にすると
   * **行に存在しない列を描くことになる**（Phase 6F で修正）。
   */
  projections: { schema: string; table: string; column: string; inferredQualifier?: boolean }[];
  /** 解決できなかった射影。ノードを作ってはならないが、隠してもならない */
  unresolved: { column: string | null; why: string }[];
  /**
   * 結果列ではない参照。役割つきで保持する（捨てない — OBS-05）。
   * Phase 6F で追加。既存の観測結果は持たない。
   */
  references?: {
    role: string;
    column: string | null;
    qualifier: string | null;
    schema: string | null;
    table: string | null;
    resolved: boolean;
    star?: boolean;
    why?: string;
  }[];
  /** SELECT 句の項目（別名つき）。行オブジェクトの鍵と由来の列を分けて持つ */
  selectItems?: {
    key: string | null;
    column: string | null;
    table: string | null;
    kind: string;
    resolved: { schema: string; table: string; column: string } | null;
    why?: string;
  }[];
  /** `SELECT *` / `t.*` が結果列にある。**結果列を列挙できない**ことを意味する */
  selectStar: boolean;
  /** UNION 等の集合演算。1つの結果列が複数の表の列に由来しうる */
  setOperation?: boolean;
}

/* ---------------------------------------------------------------- PoC-02 */

/** サーバー側のスタックの1フレーム。絶対パスは持たない（相対パスのみ） */
export interface ObsServerFrame {
  file: string;
  line: number;
  col: number;
  functionName: string | null;
}

/**
 * 「このSQL（またはサーバー内部の通信）を実行したコード」の観測
 * （source = server-call-stack）。
 *
 * 根拠は **呼び出しの入口で取った呼び出しスタック** だけである。
 * スパン開始時のスタックでは代用しない（実測で呼び出し元が消えている）。
 * 時刻の近さ・SQL 文の一致・ページのパスは根拠に使わない。
 * 成立の条件が1つでも欠けたら `component` を null にして理由を返す。
 */
export interface ObsServerCallsite {
  /** どこでスタックを取ったか（pg-pool.Pool.query / globalThis.fetch） */
  at: string | null;
  /** ソースマップで戻した元の位置。戻せなければ null */
  frame: ObsServerFrame | null;
  /** そのソース行を読み直して、データ取得の呼び出しがあることを確認できたか */
  verified: boolean;
  /** 照合した1行。ソース全文は持たない */
  sourceLine: string | null;
  /**
   * その行を囲むコンポーネント。**ソースの読み直しとビルド時のマニフェストの
   * 両方が同じ名前に決まったときだけ**値が入る。
   */
  component: { name: string; file: string; line: number; endLine: number } | null;
  /**
   * スパンが始まった時点のスタックに、アプリのコードのフレームがあったか。
   * **比較のための記録である。** 実測ではここが偽になる（スパンは接続プールの
   * コールバックの中で作られるため）。この事実が、入口でスタックを取る理由である。
   */
  appFrameAtSpanStart: boolean;
  failure: { reason: string; detail: string | null } | null;
}

/**
 * サーバー内部から出た通信1件（PoC-02 Gate A）。**ブラウザには現れない。**
 *
 * `entrySpanId` は、受け側の入口スパンが送信側の client スパンの子として
 * 同じトレースに入ったときだけ入る。別トレースなら null である
 * （＝「同じ経路」と主張しない）。
 */
export interface ObsServerExchange {
  clientSpanId: string;
  destPath: string;
  destHost: string | null;
  destPort: number | null;
  status: number | null;
  /** 受け側の入口スパン。伝播が成立していなければ null */
  entrySpanId: string | null;
  /** 成立しなかった理由。null を返して無反応にしない（FR-11b） */
  propagationFailure: string | null;
  /** 受け側が別プロセスだったか */
  crossProcess: boolean | null;
  entryService: string | null;
  /** 受け側の入口スパンの子孫である SQL スパン */
  sqlSpanIds: string[];
  callsite: ObsServerCallsite | null;
}

/**
 * RSC が直接データを取得する経路の観測（PoC-02）。
 *
 * **API ノードは存在しない**（01b Q-02 C-1）。ブラウザから見えるのは
 * 文書の取得1件だけであり、その内部に SQL とサーバー内部通信が入れ子になる。
 */
export interface ObsRsc {
  /** 文書取得に対応した入口スパン（PoC-05 の A 項の方式で対応付けた） */
  documentSpanId: string | null;
  /**
   * Next.js の描画スパン。**ルート単位であって、コンポーネント単位ではない。**
   * このスパンが存在することは、特定のコンポーネントへの帰属を意味しない。
   */
  renderSpanId: string | null;
  renderRoute: string | null;
  renderSpanName: string | null;
  /** 描画スパンの子孫である SQL スパンと、その実行元 */
  sql: { spanId: string; depthFromRender: number; callsite: ObsServerCallsite | null }[];
  /** サーバー内部の通信 */
  exchanges: ObsServerExchange[];
  /**
   * 主経路に描くサーバー内部通信の宛先パス。残りは経路外に置く。
   * PoC-05 の `focus` と同じ考え方である（1画面に描くのは主経路1本）。
   */
  focusExchange?: string;
  /** ブラウザから見えた API 通信の件数。**0 であることが rsc-direct の要件** */
  browserApiRequests: number;
  /** 並行実行（兄弟スパンの区間の重なり）。01b Q-02 C-2 */
  overlaps: { a: string; b: string; overlapMs: number }[];
  /** 伝播の条件。成立条件を画面から辿れるようにする */
  propagation: {
    mode: 'on' | 'off';
    method: string;
    scope: string;
  };
  /** 観測に関わったサービス */
  services: { name: string; role: string; origin: string }[];
}

/* ---------------------------------------------------------------- PoC-04 */

/** 由来の候補1件。**実行された SQL の SELECT 句**で解決した列である。 */
export interface ObsLineageCandidate {
  schema: string;
  table: string;
  column: string;
  /**
   * 参照の形。`field` は固定のキー、`anyfield` は**キーが動的**である
   * （どの列かがソースから決まらないため、その SQL の全列が候補になる）。
   */
  via: 'field' | 'anyfield';
  /** SQL の別名（`SELECT code AS listing_code`）など、候補固有の注記 */
  note: string | null;
  /** どの取得の呼び出しの結果を参照したか（ソース位置） */
  query: { file: string; line: number };
  /** 参照の連鎖。props の別名・分解束縛・反復を人が読める形で並べたもの */
  trail: string[];
}

/**
 * 「この表示値の由来はどの列か」の**静的解析による推定**
 * （source = static-analysis / **L2**）。
 *
 * 2つの情報源を使う。役割が違い、互いを補強しない。
 *   L1相当  実行された SQL の SELECT 句   → その取得が返す項目と、由来の列の対応
 *   L2      TypeScript の AST + 記号解決  → 表示値がその項目を参照していること
 *
 * **実測の SQL を使っても L2 から昇格しない。** 参照の連鎖そのものが推定である。
 *
 * 使わないもの: 表示された値 / 行データ / 応答本文 / 値の一致 / 実行時刻の近さ /
 * SQL 文の一致 / ソース上の SQL リテラル。
 */
export interface ObsLineage {
  /** 解析方式 */
  method: string;
  /** 解析範囲。ここより外のモジュールが作る値は追わない */
  scope: string;
  /** 対象にした表示箇所。**表示された値そのものは持たない** */
  site: {
    file: string;
    line: number;
    col: number;
    component: string | null;
    /** 検証用アプリ側の注記。製品では要素識別子がこの役を果たす */
    field: string | null;
    /** 描いている式のソーステキスト1つ。ソース全文は持たない */
    expr: string;
  };
  /**
   * confirmed    1列に決まり、加工も分岐も動的キーも無い
   * candidates   候補はあるが1つに絞れない（複数／加工／固定値経路／動的キー）
   * table-only   列は決まらないが、参照している取得のテーブルは決まる（Q-04.5 代替1）
   * none         候補を出さない
   */
  outcome: 'confirmed' | 'candidates' | 'table-only' | 'none';
  candidates: ObsLineageCandidate[];
  /** 列まで決まらなかったときのテーブル候補 */
  tableCandidates: { schema: string; name: string; why: string }[];
  /** 表示までに加工（連結・型変換・プロパティ参照）を通ったか */
  transformed: boolean;
  /** 固定値になる経路の数。条件分岐で定数になる枝がいくつあるか */
  literalPaths: number;
  /** 追えなかった経路。**空にしない** — 空は「全部追えた」を意味する */
  untracked: { why: string; detail: string | null }[];
  /** 解決できなかった参照（SELECT * / 別名の無い集計 / 未観測の SQL など） */
  unresolved: { why: string; text: string }[];
  /** 確定にできる／できない理由。画面の説明文の素材である */
  reasons: string[];
  /** 結びついた実測 SQL のスパン。空なら候補は出さない */
  sqlSpanIds: string[];
}

/* ---------------------------------------------------------------- PoC-03 */

/**
 * ブラウザで選択された1要素の観測（source = dom-read / L0）。
 *
 * **表示された値そのものを持たない。** 対応付けの鍵は
 *   要素識別子 + 同一識別子内の順番 + テキストノード索引
 * であり、値を鍵に使わない（値照合に頼らない — 02d 3.3節）。
 * 値について持つのは文字数と文字種だけである。
 */
export interface ObsSelectedElement {
  /** ランナーが指定した選択対象。表示内容から作ってはいない */
  key: string;
  selector: string;
  ordinal: number;
  group: string;
  primary: boolean;
  tag: string | null;
  /**
   * **この要素自身に付いていた識別子だけ**が出所になる。
   * 祖先の識別子を出所として使うと、ライブラリ由来の要素を
   * 自作ファイルへ誤って割り当てる。
   */
  anchorOnSelf: string | null;
  /** 同一識別子の DOM 要素のうち何番目か（1つの JSX が複数の DOM を生む場合） */
  anchorOrdinal: number | null;
  anchorInstanceCount: number;
  /** 祖先の識別子。包含関係の文脈であって、この要素の出所ではない */
  ancestorAnchors: string[];
  textNodeIndex: number | null;
  /** 値の形だけ。chars = 文字数、cls = 文字種 */
  valueShape: { chars: number; cls: string } | null;
  /**
   * 特定できなかった場合の理由（FR-11b）。`null` を返して無反応にしない。
   * reason は 02a 3.3節 `SelectionFailure` の種別に対応する。
   */
  failure: { reason: string; detail: string | null } | null;
}

/** ビルド時に注入した識別子1件と、それが指すソース位置（source = element-anchor / L1）。 */
export interface ObsElementAnchor {
  id: string;
  tag: string;
  /** プロジェクトルートからの相対パス。絶対パスは持たない */
  file: string;
  line: number;
  col: number;
  component: string;
  componentLine: number;
  /** 報告位置をソースの読み直しで確認できたか（変換側とは独立した照合） */
  verified: boolean;
  /** 照合した行のテキスト1行。ソース全文は持たない */
  sourceLine: string | null;
}

export interface ObsElements {
  method: string;
  bundler: string;
  /** 注入範囲。ここに含まれない要素は「特定不能」になる（01b Q-03 C-3） */
  injectedScope: string;
  transform: string;
  page: string;
  anchoredElements: number;
  totalElements: number;
  /** 主経路の起点にする要素 */
  primaryKey: string;
  selections: ObsSelectedElement[];
  anchors: ObsElementAnchor[];
  /** 変換したファイルの内訳。注入しなかった要素とその理由も持つ */
  files: {
    file: string; anchors: number; usages: number;
    skipped: { tag?: string; file: string; line?: number; why: string; detail?: string }[];
  }[];
}

export interface ObsTable { schema: string; name: string; rowEstimate: number | null }
export interface ObsColumn {
  schema: string; table: string; column: string;
  dataType: string; nullable: boolean; position: number;
}

export interface ObservationBundle {
  meta: {
    poc: 'PoC-01' | 'PoC-02' | 'PoC-03' | 'PoC-04' | 'PoC-05';
    collectedAt: string;
    app: {
      name: string;
      port: number;
      framework: string;
      orm: string[];
      pages: { icon: string; name: string; path: string; current?: boolean }[];
    };
    instrumentation: { method: string; detail: string; bundler: string };
    /** 値を読まずに捨てた属性キーの一覧（run 全体） */
    droppedAttributeKeys: string[];
    /** 観測しなかった／できなかったもの。必ず1件以上ある */
    notObserved: { what: string; why: string }[];
    /** 「通信」として数えなかったもの。黙って落とさない */
    excluded: { staticAssetRequests: number; note: string };
  };
  /** 描画の対象にしたページ */
  page: { path: string; name: string; startMs: number };
  /** 主経路にする通信の指定 */
  focus: { method: string; path: string };
  browserRequests: ObsBrowserRequest[];
  spans: ObsSpan[];
  sqlAnalyses: ObsSqlAnalysis[];
  dbObjects: { tables: ObsTable[]; columns: ObsColumn[] };
  /** PoC-03 の観測。無い記録（PoC-01）では存在しない */
  elements?: ObsElements;
  /** PoC-02 の観測（RSC の直読みとサーバー内部の伝播）。無い記録では存在しない */
  rsc?: ObsRsc;
  /**
   * PoC-04 の観測。**表示値の由来の静的解析による推定（L2）。**
   * 無い記録（PoC-01 / 02 / 03 / 05）では存在しない。
   * 推定が成り立たなかった場合も、`outcome: 'none'` として理由つきで入る
   * （省略しない — 省略は「関係が無い」ではなく「調べていない」に読める）。
   */
  lineage?: ObsLineage;
  /**
   * PoC-05 の観測。識別子の公開範囲の実測。無い記録では存在しない。
   * 値そのものは持たない（どこから読めたかの真偽だけ）。
   */
  exposure?: {
    /** 同一オリジンのリソースについて、ページ上のスクリプトが読めた件数 */
    serverTimingVisibleToPageScript: number;
    resourceEntries: number;
    /** 専用ヘッダが Resource Timing API に出るか */
    dedicatedHeaderVisibleToPageScript: boolean;
    /** クロスオリジンの応答から、ページ上のスクリプトがヘッダを読めたか */
    crossOrigin: { origin: string; serverTimingReadable: boolean; dedicatedReadable: boolean };
    /** IDE（CDP）からは読めたか */
    readableViaCdp: boolean;
  };
}
