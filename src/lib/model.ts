/* =============================================================================
 * 共通オブジェクトモデル（02a）。**座標を持たない。**
 *
 * 層の分担（05c 5.3節）:
 *   観測結果 / 合成シナリオ  → observation.ts, synthetic.ts
 *   ↓ adapter（純粋な変換。UI を知らない）
 *   オブジェクトモデル        → このファイル
 *   ↓ layout（座標を与える）
 *   描画                     → components/
 *
 * 最重要の規約: 観測性（実測／推定）は **取得手段から導出する**。
 * 手で書くことはできない（observabilityOf だけが決める）。
 * 表示の都合で実測へ格上げすることは、型の上で不可能である。
 * ========================================================================== */

/** キャンバスの設計空間。右の固定ドック 360px を除いた領域。 */
export const CANVAS = { w: 1240, h: 952 } as const;

/* ------------------------------------------------------- 取得手段と観測性 */

/** 02d 1.3節の取得手段。識別子を保持する（較正に後から必要になる — 02d 7章）。 */
export type SourceId =
  | 'dom-read' | 'browser-network' | 'os-process' | 'db-introspection' | 'db-query'
  | 'element-anchor' | 'trace-span' | 'trace-context' | 'orm-instrumentation'
  | 'sql-ast-parse' | 'orm-schema-map' | 'static-analysis' | 'structural-match'
  | 'value-match' | 'time-window' | 'schematic' | 'none'
  /**
   * PoC-05 で追加。ブラウザが要求を送る時点で記録した呼び出しスタックを、
   * ソースマップで元の位置へ戻し、ソースの読み直しで照合したもの。
   * **02d 1.3節の一覧に無い。報告書で追加を提案している取得手段である。**
   * 推測ではなく、ブラウザ自身の記録＋決定的な写像なので `sql-ast-parse` と
   * 同じ扱い（実測）にしている。根拠の文言で区別する。
   */
  | 'request-initiator'
  /**
   * PoC-02 で追加。**サーバー側で、データ取得の呼び出しの入口で取った
   * 呼び出しスタック**を、ソースマップで元の位置へ戻し、ソースの読み直しで
   * 照合したもの。
   *
   * `request-initiator` のサーバー版である。違いは記録の取り手だけで、
   * ブラウザではなく計装自身が取る。
   *   * スパン開始時のスタックでは代用しない（実測で呼び出し元が消えている）
   *   * 時刻の近さ・SQL 文の一致・ページのパスは根拠に使わない
   *   * 囲むコンポーネントは独立した2つの情報源の一致を要求する
   *
   * **02d 1.3節の一覧に無い。報告書で追加を提案している取得手段である。**
   */
  | 'server-call-stack';

/** 02d 1.3節の既定レベル。`L1-equivalent` は sql-ast-parse の「L1相当」。 */
export type Level = 'L0' | 'L1' | 'L1-equivalent' | 'L2' | 'L3' | 'unknown';

export const SOURCE_LEVEL: Record<SourceId, Level> = {
  'dom-read': 'L0',
  'browser-network': 'L0',
  'os-process': 'L1',
  'db-introspection': 'L0',
  'db-query': 'L0',
  'element-anchor': 'L1',
  'trace-span': 'L1',
  'trace-context': 'L1',
  'orm-instrumentation': 'L1',
  'sql-ast-parse': 'L1-equivalent',
  'orm-schema-map': 'L2',
  'static-analysis': 'L2',
  'structural-match': 'L2',
  'value-match': 'L2',
  'time-window': 'L2',
  schematic: 'L3',
  none: 'unknown',
  // ブラウザの記録 + ソースマップの決定的な写像 + ソース読み直しの照合
  'request-initiator': 'L1-equivalent',
  // 計装が呼び出しの入口で取った記録 + 同じ写像 + 同じ照合
  'server-call-stack': 'L1-equivalent',
};

/** UI に出す取得手段の文言。L0〜L3 の記号は出さない（UXR-12 / 02d 3.2節）。 */
export const SOURCE_LABEL: Record<SourceId, string> = {
  'dom-read': 'ブラウザのDOM直接読み取り',
  'browser-network': 'ブラウザのネットワーク計測',
  'os-process': 'OSのプロセス・ソケット情報',
  'db-introspection': 'DBへの直接照会（情報スキーマ）',
  'db-query': 'DBへの明示的な照会',
  'element-anchor': 'ビルド時に注入した要素識別子',
  'trace-span': '計装が生成したスパン',
  'trace-context': 'トレースコンテキストの伝播',
  'orm-instrumentation': 'ORM計装のスパン属性',
  'sql-ast-parse': '実行されたSQL文の構文解析',
  'orm-schema-map': 'ORMのスキーマ定義から読んだ対応表',
  'static-analysis': 'ソースコードの静的解析',
  'structural-match': '結果セットの列構成とJSONキー構成の照合',
  'value-match': '値の一致',
  'time-window': '時間窓による推定',
  schematic: '一般的な構成知識',
  none: '取得できていない',
  'request-initiator': 'ブラウザが記録した通信開始時の呼び出しスタック',
  'server-call-stack': 'サーバー側でデータ取得の呼び出し時に記録したスタック',
};

/** 観測性の二値。A群では L0〜L3 を出さない（UXR-12）。 */
export type Observability = 'measured' | 'estimated';

/**
 * 観測性は取得手段から決まる。**ここが唯一の決定点である。**
 * L0 / L1 / L1相当 は実測、L2 / L3 / 不明は推定。
 * 後から格上げする経路を作らないため、この関数しか観測性を作らない。
 */
export function observabilityOf(source: SourceId): Observability {
  const lv = SOURCE_LEVEL[source];
  return lv === 'L0' || lv === 'L1' || lv === 'L1-equivalent' ? 'measured' : 'estimated';
}

/* ------------------------------------------------------------- ノードと辺 */

export type NodeKind = 'value' | 'component' | 'http' | 'server' | 'sql' | 'table' | 'column';

/** 物理的実体（不透明・接地影あり）か、概念モジュール（半透明・影を落とさない）か。 */
export type Form = 'physical' | 'module';

/* ------------------------------------------- M1: 関係モデルの契約（02a 3.5） */
/*
 * **ここが Phase 7A が依拠する契約である。**
 *
 * `NodeKind` は**表示の種別**であって、関係の端点の型ではない。
 * 02a 3.5.1節の関係は 02a 3章のオブジェクト種別（`ObjectTypeId`）の間に
 * 張られる。両者を混同すると、次の2つの誤りが起きる。
 *
 *   1. 「コンポーネントからコンポーネントへ」という関係ができてしまう
 *      （実際に結んでいるのは**ソース位置の2点**である — 06f I-3）
 *   2. グラフ上の流入を、データの合流と読んでしまう（06f I-2 / 本節 F）
 *
 * 契約は `RELATION_SPEC` に表として置き、`validateDataset()` が機械的に
 * 検査する。文章の規約は破れるが、表と検査は破れない。
 */

/** 02a 3章のオブジェクト種別のうち、リネージ経路の端点になりうるもの。 */
export type ObjectTypeId =
  | 'DomElement' | 'ComponentDef' | 'PropBindingSite' | 'DataAccessSite'
  | 'HttpExchange' | 'Span' | 'SqlStatement' | 'DbTable' | 'DbColumn'
  | 'ResponseKey';

/**
 * 表示ノードの種別 → そのノードが表しているオブジェクト種別。
 * **1対1である。** `component` の表示ノードは常に `ComponentDef` を表す。
 * `PropBindingSite` / `DataAccessSite` は独立した表示ノードを持たず、
 * それを含む `ComponentDef` のノードに担われる（`ENDPOINT_CARRIER`）。
 */
export const NODE_OBJECT_TYPE: Record<NodeKind, ObjectTypeId> = {
  value: 'DomElement',
  component: 'ComponentDef',
  http: 'HttpExchange',
  server: 'Span',
  sql: 'SqlStatement',
  table: 'DbTable',
  column: 'DbColumn',
};

/**
 * 独立した表示ノードを持たない端点と、それを担うノードの種別。
 *
 * **担われていることは、同一であることを意味しない。** `ComponentDef` の
 * ノードに `PropBindingSite` が担われているとき、関係の端点は
 * あくまで props 束縛位置（ソース位置）である。だからこそ
 * `SITE_IDENTIFIED` の端点はホップ側にソース位置を必須にしている。
 */
export const ENDPOINT_CARRIER: Partial<Record<ObjectTypeId, ObjectTypeId>> = {
  // 応答のキーは独立したノードを持たない。その通信のノードが担う
  ResponseKey: 'HttpExchange',
  // props 束縛位置・データ取得位置は、それを囲むコンポーネントのノードが担う
  PropBindingSite: 'ComponentDef',
  DataAccessSite: 'ComponentDef',
};

/**
 * **ソース位置で同定される端点。** これらを端点に持つ関係は、
 * ホップ側に `endpoints` としてソース位置を必ず持つ（`validateDataset`）。
 *
 * この制約が 06f I-3（`ComponentDef → ComponentDef` という宣言）を構造的に
 * 禁止する。関係が結んでいるのは2つのソース位置であって、
 * 2つのコンポーネント定義ではない。
 */
export const SITE_IDENTIFIED: readonly ObjectTypeId[] = ['PropBindingSite', 'DataAccessSite'];

/**
 * 帰属の粒度（02a 3.5.1）。
 *
 * MVP に `runtime-instance` は無い。**同じ定義が複数回描かれたとき、
 * どの描画インスタンスかを同定する観測手段を持たないためである**
 * （06f I-4 / 06d 11章 #3 / 06e 11.3節 #5）。`validateDataset` が拒否する。
 */
export type AttributionScope =
  /** コンポーネント定義（またはテーブル定義など）への帰属 */
  | 'definition'
  /** ソース位置への帰属。呼び出しスタック・要素識別子・静的解析の端点 */
  | 'source-location'
  /** 実行時の個々のインスタンスへの帰属。**MVP では作れない** */
  | 'runtime-instance';

/** 02a 3.5.1節の関係種別。**文字列ではなく閉じた集合である。** */
export type RelationId =
  | 'renders' | 'binds' | 'derives' | 'requests' | 'handles' | 'invokes'
  | 'executes' | 'reads' | 'projects' | 'maps' | 'queries' | 'supplies';

export interface RelationSpec {
  /** データが流れる向きの始点。**探索の向きではない**（`HopOrientation`） */
  from: ObjectTypeId;
  /** データが流れる向きの終点 */
  to: readonly ObjectTypeId[];
  /** 02a 3.5.1節の既定レベル */
  defaultLevel: Level;
  /** 認める取得手段。**ここに無い手段でこの関係を作れない** */
  sources: readonly SourceId[];
  /** 帰属の粒度 */
  attribution: AttributionScope;
  /**
   * 構造的に超えられない上限（02a 3.5.1 の注記）。
   * `derives` / `maps` はいかなる実装でも実測にならない（01b Q-04.0）。
   */
  ceiling?: Observability;
  /**
   * **単独では根拠にならない取得手段。**
   * 02d 1.3節が `value-match` について定めている原則（値の一致は必要条件で
   * あって十分条件ではない）を、キー構成の照合にも広げたものである
   * （M1 決定 #9 / 06f 4.3節 V2）。キー名が一致することは、
   * **コード上のデータ伝播を確認したことにならない。**
   * 確認できないときは関係を作らず、切断を維持する（OBS-05）。
   */
  insufficientAlone?: readonly SourceId[];
  /** 02a / 02d のどこで決まっているか */
  spec: string;
}

/**
 * **関係種別の表（02a 3.5.1節の実体）。**
 *
 * `from` / `to` は**データが流れる向き**で書く。画面の経路は利用者の
 * 探索の向き（表示値 → カラム）に進むため、ホップの `from` / `to` が
 * この表と逆になることがある。その場合ホップは
 * `orientation: 'against-data'` を宣言する。
 * **向きを黙って反転させることはできない。**
 */
export const RELATION_SPEC: Record<RelationId, RelationSpec> = {
  renders: {
    from: 'ComponentDef', to: ['DomElement'],
    defaultLevel: 'L1', sources: ['element-anchor'],
    // 定義への帰属である。**どの描画インスタンスかは同定しない**（02a 3.1 注記）
    attribution: 'definition',
    spec: '02a 3.5.1',
  },
  binds: {
    from: 'PropBindingSite', to: ['DomElement'],
    defaultLevel: 'L2', sources: ['static-analysis'],
    attribution: 'source-location', ceiling: 'estimated',
    spec: '02a 3.5.1',
  },
  derives: {
    from: 'ResponseKey', to: ['PropBindingSite'],
    defaultLevel: 'L2', sources: ['static-analysis', 'structural-match'],
    attribution: 'source-location', ceiling: 'estimated',
    insufficientAlone: ['structural-match', 'value-match'],
    spec: '02a 3.5.1',
  },
  requests: {
    /*
     * **始点は `ComponentDef` ではない**（06f I-5）。
     * ブラウザのネットワーク計測が与えるのは `HttpExchange` ノードであって
     * 「どのコンポーネントが始めたか」ではない。開始元の帰属は
     * 通信開始時の呼び出しスタック（L1相当）だけが与える。
     * 取得できなければ**この関係を作らない**。
     */
    from: 'DataAccessSite', to: ['HttpExchange'],
    defaultLevel: 'L1-equivalent',
    sources: ['request-initiator', 'server-call-stack'],
    attribution: 'source-location',
    spec: '02a 3.5.1（M1 で改訂）',
  },
  handles: {
    from: 'HttpExchange', to: ['Span'],
    defaultLevel: 'L1', sources: ['trace-context', 'time-window'],
    attribution: 'definition',
    spec: '02a 3.5.1',
  },
  invokes: {
    /*
     * スパンの親子。子スパンが通信のとき、その子スパンは
     * `HttpExchange` として表示される（02a 2章: `http:<span>`）。
     * 終点に `HttpExchange` を認めるのはこのためである。
     */
    from: 'Span', to: ['Span', 'HttpExchange'],
    defaultLevel: 'L1', sources: ['trace-span'],
    attribution: 'definition',
    spec: '02a 3.5.1',
  },
  executes: {
    from: 'Span', to: ['SqlStatement'],
    defaultLevel: 'L1', sources: ['trace-span', 'orm-instrumentation'],
    attribution: 'definition',
    spec: '02a 3.5.1',
  },
  reads: {
    from: 'SqlStatement', to: ['DbTable'],
    defaultLevel: 'L1-equivalent', sources: ['sql-ast-parse'],
    attribution: 'definition',
    spec: '02a 3.5.1',
  },
  projects: {
    from: 'SqlStatement', to: ['DbColumn'],
    defaultLevel: 'L1-equivalent', sources: ['sql-ast-parse'],
    attribution: 'definition',
    spec: '02a 3.5.1',
  },
  maps: {
    /*
     * **キー名の一致だけを根拠にしてはならない**（M1 決定 #9）。
     * 列構成とキー構成の照合（`structural-match`）は候補の絞り込みであって、
     * コード上のデータ伝播の確認ではない。確認できないときは関係を作らず、
     * 切断を維持する（OBS-05）。
     */
    from: 'DbColumn', to: ['ResponseKey'],
    defaultLevel: 'L2', sources: ['orm-schema-map', 'structural-match'],
    attribution: 'definition', ceiling: 'estimated',
    insufficientAlone: ['structural-match', 'value-match'],
    spec: '02a 3.5.1',
  },
  queries: {
    /*
     * PoC-02 で追加。`executes`（Span → SqlStatement）とは**始点の型が違う**。
     * スパンの親子は「この処理の下で走った」ことしか言わず、描画スパンは
     * ルート単位なので、どのコードが実行したかを語らない（06d 2.2 実測）。
     *
     * 帰属先は**データ取得の呼び出し位置**である。囲むコンポーネント定義は
     * 文脈として表示するだけで、個々の描画インスタンスには帰属しない。
     */
    from: 'DataAccessSite', to: ['SqlStatement'],
    defaultLevel: 'L1-equivalent', sources: ['server-call-stack'],
    attribution: 'source-location',
    spec: '02a 3.5.1（M1 で追加）',
  },
  supplies: {
    /*
     * PoC-04 で追加。**`ComponentDef → ComponentDef` ではない**（06f I-3）。
     * 実装が結んでいるのは「値を描いた位置（props 束縛位置）」と
     * 「取得を呼んだ位置」の2つのソース位置である。
     *
     * 向きはデータの供給方向（取得位置 → 描画位置）で定義する。
     * 画面の経路は利用者の逆向き探索（描画位置 → 取得位置）に進むため、
     * ホップは `orientation: 'against-data'` を宣言する。
     */
    from: 'DataAccessSite', to: ['PropBindingSite'],
    defaultLevel: 'L2', sources: ['static-analysis'],
    attribution: 'source-location', ceiling: 'estimated',
    spec: '02a 3.5.1（M1 で追加）',
  },
};

/** ホップの `from → to` が、データの流れる向きと一致しているか。 */
export type HopOrientation =
  /** `from → to` はデータの流れる向きと同じ */
  | 'along-data'
  /** `from → to` は利用者の探索の向きであり、データは `to → from` に流れる */
  | 'against-data';

/**
 * 関係の端点そのもののソース位置（`SITE_IDENTIFIED` の端点に必須）。
 * **表示ノードの識別子とは別に持つ。** ノードは行までしか出さないが、
 * 端点は列まで決まっていることがある（例: 要素の位置と式の位置は同じ行の別の列）。
 */
export interface SiteRef {
  type: ObjectTypeId;
  file: string;
  line: number;
  col?: number;
  /** その位置を囲むコンポーネント定義の名前。**文脈であって端点ではない** */
  inComponent?: string;
}

/**
 * 1つのノードに複数のホップが入るときの、その流入の意味（02a 3.5.3）。
 *
 * **グラフ構造上の流入と、データの合流は別物である。**
 * 定義を分けないと、「2本の線が入っている」ことが「2つの入力が1つの値に
 * なった」と読まれる。
 */
export type Convergence =
  /**
   * 別々の関係（または別々の根拠）が**同じ対象を指している**だけである。
   * 例: ⑤ に `executes`（どのスパンの下で走ったか）と `queries`（どのコードが
   * 実行したか）が入る。2本の線は2つの入力ではなく、同じ SQL への2つの観測である。
   */
  | 'shared-object'
  /**
   * 実際に複数の入力が1つの出力になった（JOIN・連結・集計）。
   * **MVP では作れない。** 観測手段が無く、`validateDataset` が拒否する。
   */
  | 'data-merge';

/** 通信をどこで観測したか（02a 3.2 / 06f I-6）。 */
export type ExchangeScope =
  /** ブラウザのネットワーク記録に現れた通信 */
  | 'browser'
  /** サーバーの中から出た通信。**ブラウザには現れない** */
  | 'server-internal';

/**
 * **帰属の範囲を表示に出す定型文（決定 G / 06f I-4）。**
 *
 * MVP に描画インスタンスの同定機能は無い。同じコンポーネント定義が複数回
 * 描かれるとき、どの描画が対象かを決める観測手段を持たない。
 * したがって**同定したと読める表示をしてはならない**。禁止だけを書くと
 * 実装のどこかで抜けるので、「同定していない」と書く文言を1か所に置き、
 * 帰属のノードが必ずこれを添える（テストで固定する）。
 */
export const ATTRIBUTION_SCOPE_NOTE = {
  /** コンポーネント定義／ソース位置までの帰属であることを言う */
  definitionOnly: 'この位置のコードであることまでです。'
    + '同じコンポーネントが複数回描かれる場合、どの描画が対象かは同定していません',
  /** 1つの JSX が複数の DOM 要素を生んだ場合 */
  instanceUnknown: 'どの使用箇所が何番目を描いたかは観測していません',
} as const;

export const EXCHANGE_SCOPE_LABEL: Record<ExchangeScope, string> = {
  browser: 'ブラウザが記録した通信',
  'server-internal': 'サーバーの中から出た通信（ブラウザには現れません）',
};

/** 計測した値。表示文字列ではなく数値で持つ。文言はここから組み立てる。 */
export interface Metrics {
  status?: number;
  durationMs?: number;
  rows?: number;
}

/**
 * スパンの時間窓（05c 7章）。ページ読み込み開始を 0 とした相対ミリ秒。
 * スパンに対応する要素（通信・サーバー処理・実行SQL）だけが持つ。
 * テーブル・カラム・コンポーネントは定義であってスパンではないので持たない。
 */
export interface SpanWindow {
  startMs: number;
  endMs: number;
}

export type SelectionRef =
  | { type: 'node'; id: number }
  | { type: 'hop'; id: string };

export interface OverviewRow {
  k: string;
  v: string;
  /** true なら v は使わず、そのノードの metrics から組み立てる */
  fromMetrics?: boolean;
  /** 「次の一歩」。押すと該当ステップを選択する（導線が実際に動くこと：IX-23） */
  go?: SelectionRef;
}

/** 観測性を持たない入力。`node()` を通すと観測性が付く。 */
export interface ModelNodeInput {
  id: number;
  kind: NodeKind;
  form: Form;
  /** ノードの種別名。例「コンポーネント」 */
  title: string;
  /** 識別子。等幅で出す（これはコードか値だ、という符号） */
  identifier: string;
  /** ラベル札に出す短い識別子。属性値は置かない（UI-15 / 表示規則3） */
  chipSub: string;
  metrics?: Metrics;
  span?: SpanWindow;
  /** 段階1（ホバー）の1行要約 */
  hover: string;
  /** 段階2（クリック）の概要。属性値はここが担当（UI-15） */
  overview: OverviewRow[];
  /** 取得手段（02d 1.3節）。観測性はここから決まる */
  source: SourceId;
  /** 根拠の種別 */
  evidence: string[];
  /**
   * 物理的実体の足元に出す層のラベル（PoC-02）。
   * 1つの経路に2つのサービスが現れる構成では、既定の「開発サーバー」では
   * 嘘になる。**観測したサービスの名前をそのまま出すために置く。**
   * 省略したときは従来どおりレイアウト側の既定が使われる。
   */
  locus?: { text: string; sub?: string };
  /**
   * 通信の観測位置（`kind: 'http'` のノードに必須 — 02a 3.2 / 06f I-6）。
   * ブラウザに現れた通信と、サーバーの中から出た通信を**モデルで区別する**。
   * 文言だけで区別していると、両者を同じものとして数える実装が書ける。
   */
  exchangeScope?: ExchangeScope;
}

export interface ModelNode extends ModelNodeInput {
  readonly observability: Observability;
}

/**
 * ホップの解決状態（02a 4.2節）。
 *
 * **これまでモデルに無かった。** 実測だけを扱っていた PoC-01 / 03 / 05 / 02 では
 * 関係は「作る」か「作らない」の2択で足りていた。PoC-04 で**候補が複数のままに
 * なる関係**が初めて出たため、02a 4.2節の定義をモデルへ入れる。
 *
 * 省略可能にしてある。既存のデータセットは誰も持たない（＝従来どおり `resolved`
 * として扱われる）。
 */
export type LinkStatus =
  | 'resolved' | 'multiple-candidates' | 'static-literal'
  | 'untraceable' | 'unsupported' | 'blocked-by-node';

/**
 * 複数候補のときの候補1件（02a 3.5.3節 `candidates[]`）。
 *
 * **1つに断定しない。** 候補を根拠つきで列挙する。
 * 実トレースがあれば実際に通った候補を強調する、という要請（FR-22 代替A2）は
 * 本モデルの上位で扱う。
 */
export interface HopCandidate {
  /** 候補の識別子。例「poc.listings.region」 */
  identifier: string;
  /** 平易な言い換え */
  label: string;
  /** その候補を支える根拠 */
  evidence: string[];
  /** その候補に固有の注記（SQL の別名、キーが動的、など） */
  note?: string;
}

export interface ModelHopInput {
  id: string;
  /** 経路をたどる順序。最弱環の「より下流」の判定に使う導出の材料 */
  order: number;
  from: number;
  to: number;
  /** 関係の種別（02a 3.5.1節）。**`RELATION_SPEC` に在るものだけ** */
  relation: RelationId;
  /** 平易な言い換え。番号付きリストの関係行に出す */
  label: string;
  source: SourceId;
  evidence: string[];
  /**
   * `from → to` がデータの流れる向きと一致しているか。省略時は `along-data`。
   * 画面の経路は利用者の探索の向き（表示値 → カラム）に進むため、
   * `renders` / `supplies` / `derives` はデータと逆向きに描かれる。
   * **向きの反転をここに書かせることで、黙って反転させられなくする。**
   */
  orientation?: HopOrientation;
  /**
   * 関係の端点のソース位置。`SITE_IDENTIFIED` の端点を持つ関係には必須
   * （`validateDataset`）。表示ノードは `ComponentDef` を担うだけなので、
   * **端点そのものの証拠はここにしか無い。**
   */
  endpoints?: { from?: SiteRef; to?: SiteRef };
  /**
   * 同じ `to` に複数のホップが入るときの、その流入の意味（02a 3.5.3）。
   * 流入が2本以上あるノードに入るホップには必須（`validateDataset`）。
   */
  convergence?: Convergence;
  /** なぜ確実でないか。推定のホップにのみ意味がある */
  weakness?: string;
  /** キャンバスに残す語。観測できていないことだけに付ける（表示規則10） */
  tagLabel?: string;
  /** 最弱環として★を付ける対象か（経路を戻るホップ） */
  star?: boolean;
  /**
   * 解決状態（02a 4.2節）。省略したら `resolved` と同じに扱う。
   * **`multiple-candidates` のときは `candidates` を必ず持つ。**
   */
  linkStatus?: LinkStatus;
  /** 候補集合。`linkStatus` が `multiple-candidates` のとき必須（02a 3.5節） */
  candidates?: HopCandidate[];
}

export interface ModelHop extends ModelHopInput {
  readonly observability: Observability;
}

/** 観測性を取得手段から付ける。これ以外の作り方を提供しない。 */
export const node = (n: ModelNodeInput): ModelNode =>
  ({ ...n, observability: observabilityOf(n.source) });
export const hop = (h: ModelHopInput): ModelHop =>
  ({ ...h, observability: observabilityOf(h.source) });

/* ----------------------------------------- 契約の検査（M1。Phase 7A の前提） */

/** データが流れる向きを `orientation` から解いた、ホップの端点の型。 */
export function hopEndpointTypes(h: Pick<ModelHopInput, 'relation' | 'orientation'>): {
  fromType: ObjectTypeId; toTypes: readonly ObjectTypeId[];
} {
  const s = RELATION_SPEC[h.relation];
  return (h.orientation ?? 'along-data') === 'along-data'
    ? { fromType: s.from, toTypes: s.to }
    // 探索の向きに描かれている。ホップの from はデータの終点、to は始点である
    : { fromType: s.to[0], toTypes: [s.from] };
}

/** 端点の型 `want` を、表示ノードの種別 `kind` が担えるか。 */
const canCarry = (want: ObjectTypeId, kind: NodeKind): boolean => {
  const actual = NODE_OBJECT_TYPE[kind];
  return actual === want || ENDPOINT_CARRIER[want] === actual;
};

/**
 * **データセットが 02a 3.5 の契約を守っているかを機械的に検査する。**
 * 違反の一覧を返す（空なら適合）。例外を投げないのは、違反を1件で
 * 打ち切らずに全部見せるためである。
 *
 * 検査するのは次の9つ。いずれも「観測できないものを作っていないか」である。
 */
export function validateDataset(ds: {
  origin?: DataOrigin; nodes: ModelNode[]; hops: ModelHop[];
}): string[] {
  const v: string[] = [];
  const byId = new Map(ds.nodes.map((n) => [n.id, n]));

  /* R1: 通信のノードは観測位置を必ず持つ（02a 3.2 / 06f I-6） */
  for (const n of ds.nodes) {
    if (n.kind === 'http' && n.exchangeScope === undefined) {
      v.push(`node #${n.id}: 通信のノードに exchangeScope が無い（02a 3.2）`);
    }
  }

  /* 流入の本数を数える（R8 で使う） */
  const fanIn = new Map<number, number>();
  for (const h of ds.hops) fanIn.set(h.to, (fanIn.get(h.to) ?? 0) + 1);

  for (const h of ds.hops) {
    const s = RELATION_SPEC[h.relation as RelationId] as RelationSpec | undefined;
    /* R2: 関係種別は表に在るものだけ */
    if (!s) { v.push(`hop ${h.id}: 未知の関係種別 ${h.relation}`); continue; }

    /* R3: 取得手段は、その関係に認められたものだけ */
    if (!s.sources.includes(h.source)) {
      v.push(`hop ${h.id} (${h.relation}): 取得手段 ${h.source} はこの関係に認められていない`
        + `（認めるのは ${s.sources.join(' / ')} — ${s.spec}）`);
    }

    /* R4: 構造的に昇格しない関係を実測にしていない（01b Q-04.0） */
    if (s.ceiling === 'estimated' && h.observability === 'measured') {
      v.push(`hop ${h.id} (${h.relation}): 構造的に推定の関係を実測として作っている`);
    }

    /* R5: 端点の型が表と合っている（向きを解いたうえで） */
    const { fromType, toTypes } = hopEndpointTypes({ relation: h.relation, orientation: h.orientation });
    const nf = byId.get(h.from);
    const nt = byId.get(h.to);
    if (!nf || !nt) { v.push(`hop ${h.id}: 端点のノードが無い`); continue; }
    if (!canCarry(fromType, nf.kind)) {
      v.push(`hop ${h.id} (${h.relation}): from は ${fromType} のはずだが`
        + ` #${h.from} は ${NODE_OBJECT_TYPE[nf.kind]} である`);
    }
    if (!toTypes.some((t) => canCarry(t, nt.kind))) {
      v.push(`hop ${h.id} (${h.relation}): to は ${toTypes.join('|')} のはずだが`
        + ` #${h.to} は ${NODE_OBJECT_TYPE[nt.kind]} である`);
    }

    /* R6: ソース位置で同定される端点は、その位置をホップが持つ */
    const need: { side: 'from' | 'to'; type: ObjectTypeId }[] = [];
    if (SITE_IDENTIFIED.includes(fromType)) need.push({ side: 'from', type: fromType });
    for (const t of toTypes) if (SITE_IDENTIFIED.includes(t) && toTypes.length === 1) need.push({ side: 'to', type: t });
    for (const { side, type } of need) {
      const e = h.endpoints?.[side];
      if (!e) {
        v.push(`hop ${h.id} (${h.relation}): ${side} は ${type}（ソース位置で同定される端点）`
          + 'なのに endpoints が無い。コンポーネント定義どうしを結んだことになる');
      } else if (e.type !== type) {
        v.push(`hop ${h.id} (${h.relation}): endpoints.${side} の型が ${e.type} で、表の ${type} と違う`);
      } else if (!e.file || !e.line) {
        v.push(`hop ${h.id} (${h.relation}): endpoints.${side} にソース位置が無い`);
      }
    }

    /* R7: インスタンスへの帰属は作れない（06f I-4 / 本 Phase の決定 G） */
    if (s.attribution === 'runtime-instance') {
      v.push(`hop ${h.id} (${h.relation}): 実行時インスタンスへの帰属は観測手段が無い`);
    }

    /* R8: 流入が2本以上あるノードへのホップは、流入の意味を宣言する */
    if ((fanIn.get(h.to) ?? 0) > 1) {
      if (!h.convergence) {
        v.push(`hop ${h.id} (${h.relation}): 流入が2本以上あるノード #${h.to} に入るのに`
          + ' convergence が無い（グラフ上の流入とデータの合流を区別する — 02a 3.5.3）');
      } else if (h.convergence === 'data-merge') {
        v.push(`hop ${h.id} (${h.relation}): data-merge は観測手段が無いため作れない`);
      }
    }

    /* R9: 単独では根拠にならない手段を、唯一の根拠にしていない（決定 #9） */
    if (s.insufficientAlone?.includes(h.source)) {
      v.push(`hop ${h.id} (${h.relation}): ${h.source} は単独では根拠にならない`
        + '（キー構成・値の一致は候補の絞り込みであって、データ伝播の確認ではない）');
    }

    /* R10: 複数候補なら候補を持つ（02a 4.2） */
    if (h.linkStatus === 'multiple-candidates' && !(h.candidates?.length)) {
      v.push(`hop ${h.id}: multiple-candidates なのに candidates が無い`);
    }
  }
  return v;
}

/* ------------------------------------------------------------- 切断・経路外 */

/**
 * 追跡できなかった箇所（OBS-05）。線を消さずに止める。
 * `from` のノードから上流（または先）へ抜ける向きに描く。
 */
export interface Cut {
  /** この切断が生える元のノード */
  from: number;
  head: string;
  sub: string;
  where: string;
  kind: string;
}

/**
 * このページで観測した経路を、詳細をどこまで持っているかで区別する。
 * 区別しないと「2経路あるのに1つしか開けない」が不具合に見える。
 */
export type PathDetail =
  /** 詳細を表示できる。LineagePath を構成できている */
  | 'full'
  /** 存在は観測した。詳細はまだ取得していない（取得できるかは未知） */
  | 'not-retrieved'
  /** 存在は分かるが、詳細を取得できない（未対応の構成・権限など） */
  | 'unavailable';

export const PATH_DETAIL_LABEL: Record<PathDetail, string> = {
  full: '詳細を表示できる',
  'not-retrieved': '詳細が未取得',
  unavailable: '詳細を取得できない',
};

/** 経路外（減光して残す。削除しない — UI-33） */
export interface OffPath {
  detail: PathDetail;
  label: string;
  note: string;
  /**
   * 経路外のノード。実測では所要時間まで観測できていることがある。
   * 観測しているのに「計測できていない」と数えると、画面が嘘をつく。
   */
  nodes: { kind: NodeKind; label: string; durationMs?: number }[];
  caption: { text: string; textUnselected: string };
}

export interface PageRef {
  icon: string;
  name: string;
  path: string;
  current?: boolean;
}

/* ------------------------------------------------------------------ 全体 */

export type DataOrigin = 'synthetic' | 'measured';

/** 実測データの出所。捏造していないことを画面から辿れるようにする。 */
export interface Provenance {
  /** 計装方式（例「方式1 instrumentation.ts + OpenTelemetry」） */
  instrumentation: string;
  bundler: string;
  traceId: string;
  collectedAt: string;
  /** 観測できなかったもの。空にしない — 空は「全部取れた」を意味する */
  notObserved: { what: string; why: string }[];
}

export interface Dataset {
  origin: DataOrigin;
  project: string;
  runtime: { command: string; port: number; instrumentation: string };
  nodes: ModelNode[];
  hops: ModelHop[];
  cuts: Cut[];
  offPath: OffPath;
  pages: PageRef[];
  /** キャンバスに常時出す注記（表示規則11）。合成か実測かをここで言う */
  notice: string;
  /** 段階0 の末尾に出す1行。数値の出所を明示する */
  overviewNote: string;
  provenance?: Provenance;
}

export const nodeById = (ds: { nodes: ModelNode[] }, id: number) =>
  ds.nodes.find((n) => n.id === id)!;
export const hopById = (ds: { hops: ModelHop[] }, id: string) =>
  ds.hops.find((h) => h.id === id)!;
