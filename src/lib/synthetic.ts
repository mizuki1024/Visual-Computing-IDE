/* =============================================================================
 * 合成シナリオ（層1の入力の一方）— 05a-implementation-handoff.md 5章の確定値。
 * 実在の顧客名・実DB構造・認証情報は使わない。名称は 5.1節の置換表に従う。
 *
 * **座標を持たない。** 座標は layout.ts の責務である。
 * 観測性も持たない。取得手段から導出される（model.ts の observabilityOf）。
 * ========================================================================== */
import { hop, node, type Dataset } from './model';

export const SYNTHETIC: Dataset = {
  origin: 'synthetic',
  project: 'Sample Property App',
  runtime: { command: 'npm run dev', port: 3000, instrumentation: '有効' },

  /* --------------------------------------------------------------- ノード7 */
  nodes: [
    node({
      id: 1, kind: 'value', form: 'physical',
      title: '表示された値', identifier: '「千葉県」', chipSub: '「千葉県」',
      hover: 'この値が画面に描かれています',
      overview: [
        { k: '取得手段', v: 'ブラウザのDOM読み取り' },
        { k: '要素', v: '<span> / ListingCard 内' },
        { k: '次の一歩', v: '⑦ のカラムの定義を見る', go: { type: 'node', id: 7 } },
      ],
      source: 'dom-read',
      evidence: ['ビルド時に注入した要素識別子'],
    }),
    node({
      id: 2, kind: 'component', form: 'module',
      title: 'コンポーネント', identifier: 'src/components/ListingCard.tsx:42',
      chipSub: 'ListingCard',
      hover: 'この値を描いたコンポーネント',
      overview: [
        { k: '取得手段', v: 'ビルド時に注入した要素識別子' },
        { k: '定義', v: 'src/components/ListingCard.tsx:42' },
        { k: '次の一歩', v: '③ の応答項目との対応を見る', go: { type: 'hop', id: 'derives' } },
      ],
      source: 'element-anchor',
      evidence: ['要素識別子とコンポーネント定義の一致'],
    }),
    node({
      id: 3, kind: 'http', form: 'module',
      /* 合成シナリオでもブラウザに現れる通信として置く（02a 3.2 の観測位置） */
      exchangeScope: 'browser',
      title: '通信', identifier: 'GET /api/listings',
      chipSub: 'GET /api/listings', metrics: { status: 200, durationMs: 124 },
      hover: 'この値を含む応答を返した通信',
      overview: [
        { k: '取得手段', v: 'ブラウザのネットワーク計測' },
        { k: '応答', v: '', fromMetrics: true },
        { k: '次の一歩', v: '④ のサーバー処理を見る', go: { type: 'node', id: 4 } },
      ],
      source: 'browser-network',
      evidence: ['計装が生成したスパンとの突き合わせ'],
    }),
    node({
      id: 4, kind: 'server', form: 'physical',
      title: 'サーバー処理', identifier: 'Next.js API Route',
      chipSub: 'Next.js API Route', metrics: { durationMs: 98 },
      hover: 'この通信を受けたサーバーの処理',
      overview: [
        { k: '取得手段', v: '計装が生成したスパン' },
        { k: '区間', v: '', fromMetrics: true },
        { k: '次の一歩', v: '⑤ の実行SQLを見る', go: { type: 'node', id: 5 } },
      ],
      source: 'trace-span',
      evidence: ['トレースコンテキストの伝播'],
    }),
    node({
      id: 5, kind: 'sql', form: 'module',
      // SQL断片は札に置かない（表示規則3）。A-2 も ⑤ の札は種別名だけである。
      title: '実行SQL', identifier: 'SELECT id, title, region …',
      chipSub: '', metrics: { durationMs: 42, rows: 12 },
      hover: 'その処理が実行したSQL',
      overview: [
        { k: '取得手段', v: 'ORM計装のスパン属性' },
        { k: '結果', v: '', fromMetrics: true },
        { k: '次の一歩', v: '⑦ のカラムを見る', go: { type: 'node', id: 7 } },
      ],
      source: 'orm-instrumentation',
      evidence: ['実行されたSQL文の構文解析'],
    }),
    node({
      id: 6, kind: 'table', form: 'physical',
      title: 'テーブル', identifier: 'public.listings', chipSub: 'listings',
      hover: '⑤ から分岐 — そのSQLが読んだテーブル',
      overview: [
        { k: '取得手段', v: 'DBの情報スキーマへの照会' },
        { k: '定義', v: 'public.listings' },
        { k: '次の一歩', v: '⑦ のカラムを見る', go: { type: 'node', id: 7 } },
      ],
      source: 'db-introspection',
      evidence: ['実行されたSQL文の FROM 句', 'DBの情報スキーマとの一致'],
    }),
    node({
      id: 7, kind: 'column', form: 'module',
      title: 'カラム', identifier: 'region (text)', chipSub: 'region',
      hover: '⑤ から分岐 — そのSQLが取り出した列',
      overview: [
        { k: '取得手段', v: '実行されたSQL文の構文解析' },
        { k: '型', v: 'text' },
        { k: '次の一歩', v: '★ ⑦→③ の対応づけを確かめる', go: { type: 'hop', id: 'maps' } },
      ],
      source: 'sql-ast-parse',
      evidence: ['SQL文の SELECT 句', 'DBの情報スキーマとの一致'],
    }),
  ],

  /* --------------------------------------------------------------- ホップ7 */
  /* ⑥→⑦ の線は存在しない。projects の始点は ⑤（SqlStatement）である（02a 3.5節）。 */
  hops: [
    hop({
      id: 'renders', order: 1, from: 1, to: 2, relation: 'renders',
      label: 'この値を描いたコンポーネント',
      /* データは「コンポーネント → 要素」。経路は逆向きに進む（02a 3.5.1） */
      orientation: 'against-data',
      source: 'element-anchor',
      evidence: ['要素識別子の一致'],
    }),
    hop({
      id: 'derives', order: 2, from: 2, to: 3, relation: 'derives',
      label: '応答のどの項目が、この値になったか',
      tagLabel: '応答のどの項目か',
      /* データは「応答のキー → props 束縛位置」。経路は逆向きに進む */
      orientation: 'against-data',
      /* 端点は props 束縛位置（ソース位置）である。コンポーネント定義ではない */
      endpoints: {
        from: {
          type: 'PropBindingSite',
          file: 'src/components/ListingCard.tsx', line: 42, inComponent: 'ListingCard',
        },
      },
      /* ③ には `maps` も入る。**データの合流ではない**（同じ応答のキーを指している） */
      convergence: 'shared-object',
      source: 'static-analysis',
      evidence: ['結果セットの列構成とJSONキー構成の照合', '値の一致'],
      weakness: '応答のどの項目がこの値になったかは、コードの形から推測しています。加工やマッピングが挟まると成立しません。',
    }),
    hop({
      id: 'handles', order: 3, from: 3, to: 4, relation: 'handles',
      label: 'この通信を受けたサーバーの処理',
      source: 'trace-context',
      evidence: ['トレースIDの一致'],
    }),
    hop({
      id: 'executes', order: 4, from: 4, to: 5, relation: 'executes',
      label: 'その処理が実行したSQL',
      source: 'trace-span',
      evidence: ['スパンの親子関係'],
    }),
    hop({
      id: 'reads', order: 5, from: 5, to: 6, relation: 'reads',
      label: '⑤ から分岐 — そのSQLが読んだテーブル',
      source: 'sql-ast-parse',
      evidence: ['SQL文の FROM 句'],
    }),
    hop({
      id: 'projects', order: 6, from: 5, to: 7, relation: 'projects',
      label: '⑤ から分岐 — そのSQLが取り出した列',
      source: 'sql-ast-parse',
      evidence: ['SQL文の SELECT 句'],
    }),
    hop({
      id: 'maps', order: 7, from: 7, to: 3, relation: 'maps',
      label: 'カラムと応答項目の対応づけ',
      tagLabel: 'カラムと応答項目の対応づけ', star: true,
      /* ③ には `derives` も入る（同じ応答のキーを別の側から指している） */
      convergence: 'shared-object',
      source: 'orm-schema-map',
      evidence: ['実行されたSQLの解析', '値の一致'],
      weakness: 'ORMの内部変換は観測できません。別名や加工があると成立しません。',
    }),
  ],

  /* ------------------------------------------------ 異常状態（1件・E-07） */
  cuts: [{
    from: 4,
    head: '追跡できません',
    sub: '未対応の構成です',
    where: 'src/lib/notify.ts:18 / sdk.send(...)',
    kind: '未対応の構成（E-07）',
  }],

  /* ------------------------------------------------- 経路外（減光して残す） */
  offPath: {
    /*
     * 存在は観測した通信。詳細は持っていない。
     * 'unavailable'（取得できない）ではない — 取得を試みていないだけである。
     */
    detail: 'not-retrieved',
    label: 'GET /api/saved',
    note: '存在は観測しました。この合成データでは出所の詳細を持ちません。',
    nodes: [
      { kind: 'http', label: '/api/saved' },
      { kind: 'sql', label: 'SQL' },
    ],
    caption: {
      text: '選択していない経路（このページの他の通信）',
      textUnselected: 'このページの他の通信',
    },
  },

  pages: [
    { icon: '⌂', name: 'ホーム', path: '/' },
    { icon: '▣', name: '物件一覧', path: '/listings', current: true },
    { icon: '▢', name: '物件詳細', path: '/listings/[id]' },
    { icon: '▢', name: 'お知らせ', path: '/news' },
    { icon: '▢', name: 'お問い合わせ', path: '/contact' },
  ],

  notice: 'Phase 5A 探索画面／シナリオは合成データ（実測ではありません）',
  overviewNote: '表示している数値は合成シナリオから算出したものです。実際の計装結果ではありません。',
};
