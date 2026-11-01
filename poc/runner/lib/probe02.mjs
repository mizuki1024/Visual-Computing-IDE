/* =============================================================================
 * PoC-02 の**手で書いた正解表**。
 *
 * 検証用アプリのソースを読んで人が書いた表である。観測側はこの表を参照しない。
 * 観測結果とこの表を突き合わせて、正答・誤答・特定不能を数える。
 *
 * 行番号は `poc/fixture-app/src/**` の実ファイルの行である。ページを編集したら
 * ここも直す必要がある（ずれたらテストが落ちる＝気づける）。
 * ========================================================================== */

/* ============================================================== Gate A */
/*
 * サーバーから別のサーバーへの HTTP 要求。
 *   propagated: 伝播が成立しているとき、受け側の入口スパンが
 *               送信側の client スパンの子として同じトレースに入るか
 */
export const GATE_A_CASES = [
  {
    key: 'svc-echo',
    label: '別プロセスのサービスへの要求（相手は何もしない）',
    page: '/rsc-svc',
    expect: [
      {
        destPath: '/echo', destService: 'poc02-fixture-svc', status: 200,
        propagated: true, childSql: 0,
        initiator: { file: 'src/app/rsc-svc/page.tsx', line: 15, component: 'RscSvc' },
      },
      {
        destPath: '/rows', destService: 'poc02-fixture-svc', status: 200,
        propagated: true, childSql: 1,
        initiator: { file: 'src/app/rsc-svc/page.tsx', line: 16, component: 'RscSvc' },
      },
    ],
  },
  {
    key: 'svc-fail',
    label: '別プロセスのサービスへの要求が 500 で返る',
    page: '/rsc-svc-fail',
    expect: [
      {
        destPath: '/boom', destService: 'poc02-fixture-svc', status: 500,
        propagated: true, childSql: 0,
        initiator: { file: 'src/app/rsc-svc-fail/page.tsx', line: 12, component: 'RscSvcFail' },
      },
    ],
  },
  {
    key: 'self-api',
    label: '自分の API ルートへの要求（同一プロセス）',
    page: '/flows-rsc',
    expect: [
      {
        destPath: '/api/listings', destService: 'poc01-fixture-app', status: 200,
        // Prisma は本体のクエリの前に接続確認の `SELECT 1` も1本のスパンとして出す。
        // 2本とも実測されたスパンであり、どちらも隠さない
        propagated: true, childSql: 2,
        initiator: { file: 'src/app/flows-rsc/page.tsx', line: 15, component: 'FlowsRsc' },
      },
    ],
  },
  {
    key: 'dead-port',
    label: '応答が返らない（開いていないポート）',
    page: '/rsc-fail',
    expect: [
      {
        destPath: '/echo', destService: null, status: null,
        // 受け側が存在しないので、入口スパンは無い。**対応付けないのが正解**
        propagated: false, propagationFailure: 'no-child-entry-span', childSql: 0,
        initiator: { file: 'src/app/rsc-fail/page.tsx', line: 23, component: 'RscFail' },
      },
    ],
  },
];

/* ============================================================== Gate B */
/*
 * Server Component がサーバー内部で直接 DB を読む経路。
 *   renderRoute   SQL スパンの先祖になるべき Next の描画スパンのルート
 *   sql[]         実行されるべき SQL（構造。パラメータ値は持たない）
 *   component     その SQL を実行した Server Component（null なら帰属しないのが正解）
 */
export const GATE_B_CASES = [
  {
    key: 'rsc-db',
    label: 'Server Component からの直接 DB アクセス（1本）',
    page: '/rsc-db',
    renderRoute: '/rsc-db',
    apiRequestsFromBrowser: 0,
    sql: [
      {
        table: 'listings', columns: ['id', 'code', 'plan'],
        file: 'src/app/rsc-db/page.tsx', line: 12, component: 'RscDb', ok: true,
      },
    ],
  },
  {
    key: 'rsc-parallel',
    label: '複数の並列データ取得（3本・別々の行）',
    page: '/rsc-parallel',
    renderRoute: '/rsc-parallel',
    apiRequestsFromBrowser: 0,
    expectOverlap: true,
    sql: [
      { table: 'listings', file: 'src/app/rsc-parallel/page.tsx', line: 13, component: 'RscParallel', ok: true },
      { table: 'regions', file: 'src/app/rsc-parallel/page.tsx', line: 14, component: 'RscParallel', ok: true },
      { table: 'listing_views', file: 'src/app/rsc-parallel/page.tsx', line: 15, component: 'RscParallel', ok: true },
    ],
  },
  {
    key: 'rsc-dup',
    label: '同じ SQL を複数箇所から実行（別ファイル・別コンポーネント）',
    page: '/rsc-dup',
    renderRoute: '/rsc-dup',
    apiRequestsFromBrowser: 0,
    sql: [
      { table: 'listings', file: 'src/app/rsc-dup/page.tsx', line: 13, component: 'RscDup', ok: true },
      { table: 'listings', file: 'src/components/ListingCount.tsx', line: 6, component: 'ListingCount', ok: true },
    ],
  },
  {
    key: 'rsc-fail',
    label: 'SQL の失敗と、サーバー内部通信の失敗',
    page: '/rsc-fail',
    renderRoute: '/rsc-fail',
    apiRequestsFromBrowser: 0,
    sql: [
      {
        table: 'table_that_does_not_exist', failed: true,
        file: 'src/app/rsc-fail/page.tsx', line: 17, component: 'RscFail', ok: true,
        // 存在しないテーブルなので、情報スキーマに無い＝テーブルノードを作らない
        tableInSchema: false,
      },
    ],
  },
  {
    key: 'rsc-helper',
    label: 'コンポーネントではない関数の中の SQL（帰属できないのが正解）',
    page: '/rsc-helper',
    renderRoute: '/rsc-helper',
    apiRequestsFromBrowser: 0,
    sql: [
      {
        table: 'listings',
        file: 'src/app/rsc-helper/page.tsx', line: 13, component: null, ok: false,
        failureReason: 'component-not-agreed',
      },
    ],
  },
];

/** 文書取得の期待値。ナビゲーションなので呼び出し元は存在しない（PoC-05 と同じ） */
export const DOCUMENT_EXPECT = {
  initiatorReason: 'no-script-stack',
};

/** 収集してはいけないものの検査に使うパターン */
export const FORBIDDEN = [
  /postgres(ql)?:\/\//i, /poc01_local_only/, /\bcookie\b/i, /\bauthorization\b/i,
  /\bbearer\b/i, /\bpassword\b/i, /\baccess_token\b/i, /\bsecret\b/i,
  /アオバ台|シラカワ野|ミナト浜|ヒガシ丘/,
  /\btraceparent\s*[:=]\s*00-/i,
];

/* =============================================================================
 * IDE の画面へ流し込む観測で選択する要素（PoC-03 の機構をそのまま使う）。
 * 期待値は手で書いた正解表である。
 * ========================================================================== */
export const UI_TARGETS_02 = [
  {
    key: 'rsc-code', page: '/rsc-db', sel: 'main.rsc-db li[data-poc-field="code"]', ord: 0,
    primary: true, group: 'rsc-direct',
    expect: { file: 'src/app/rsc-db/page.tsx', line: 19, tag: 'li', component: 'RscDb' },
  },
  {
    key: 'rsc-h1', page: '/rsc-db', sel: 'main.rsc-db > h1', ord: 0, group: 'rsc-own',
    expect: { file: 'src/app/rsc-db/page.tsx', line: 15, tag: 'h1', component: 'RscDb' },
  },
];

/** 画面の左パネルに出すページ一覧。観測したページに current を付ける */
export const UI_PAGES = [
  { icon: '⌂', name: 'ホーム', path: '/' },
  { icon: '▣', name: '物件一覧', path: '/listings' },
  { icon: '◈', name: '通信の経路', path: '/flows' },
  { icon: '◆', name: '直読み（1本）', path: '/rsc-db' },
  { icon: '◇', name: '並列（3本）', path: '/rsc-parallel' },
  { icon: '◎', name: '別サービスへの通信', path: '/rsc-svc' },
];
