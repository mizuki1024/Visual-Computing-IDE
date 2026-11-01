/* =============================================================================
 * PoC-05 の正解表。**ソースを読んで手で書いた。** 観測側はこの表を参照しない。
 *
 * 期待値は「どの操作で、どの通信が、どのソース位置から始まるか」である。
 * 行番号は poc/fixture-app/src/app/flows/page.tsx と
 * poc/fixture-app/src/components/FetchButton.tsx を読んで書いた。
 * ========================================================================== */

const PAGE = 'src/app/flows/page.tsx';
const CHILD = 'src/components/FetchButton.tsx';

/** 必須ケース（指示 第4節）と、その期待値 */
export const CASES = [
  {
    key: 'single',
    label: '1回の操作で1リクエスト',
    required: '1回の操作で1リクエスト',
    button: '#btn-one',
    expect: [
      { method: 'GET', path: '/api/listings', status: 200,
        initiator: { file: PAGE, line: 30, component: 'Flows' } },
    ],
  },
  {
    key: 'parallel-distinct',
    label: '複数リクエストの同時実行（別URL3件）',
    required: '複数リクエストの同時実行',
    button: '#btn-parallel',
    expect: [
      { method: 'GET', path: '/api/listings', status: 200,
        initiator: { file: PAGE, line: 39, component: 'Flows' } },
      { method: 'GET', path: '/api/stats', status: 200,
        initiator: { file: PAGE, line: 40, component: 'Flows' } },
      { method: 'GET', path: '/api/listings/2', status: 200,
        initiator: { file: PAGE, line: 41, component: 'Flows' } },
    ],
  },
  {
    key: 'parallel-same-url',
    label: '同じURLへの同時実行（3件）',
    required: '複数リクエストの同時実行 ＋ 同じURLへのリクエスト',
    button: '#btn-same-parallel',
    note: '時刻の近さでは1件も区別できない。識別子でしか分けられないケース',
    expect: [
      { method: 'GET', path: '/api/listings', status: 200,
        initiator: { file: PAGE, line: 49, component: 'Flows' } },
      { method: 'GET', path: '/api/listings', status: 200,
        initiator: { file: PAGE, line: 50, component: 'Flows' } },
      { method: 'GET', path: '/api/listings', status: 200,
        initiator: { file: PAGE, line: 51, component: 'Flows' } },
    ],
  },
  {
    key: 'serial-same-url',
    label: '同じURLへの連続リクエスト（3件）',
    required: '同じURLへの連続リクエスト',
    button: '#btn-same-serial',
    expect: [
      { method: 'GET', path: '/api/listings', status: 200,
        initiator: { file: PAGE, line: 58, component: 'Flows' } },
      { method: 'GET', path: '/api/listings', status: 200,
        initiator: { file: PAGE, line: 58, component: 'Flows' } },
      { method: 'GET', path: '/api/listings', status: 200,
        initiator: { file: PAGE, line: 58, component: 'Flows' } },
    ],
  },
  {
    key: 'failed-500',
    label: '失敗したリクエスト（サーバー側の例外 → 500）',
    required: '失敗したリクエスト',
    button: '#btn-fail',
    expect: [
      { method: 'GET', path: '/api/boom', status: 500,
        initiator: { file: PAGE, line: 64, component: 'Flows' } },
    ],
  },
  {
    key: 'failed-404',
    label: '失敗したリクエスト（ハンドラが「無い」と答える → 404）',
    required: '失敗したリクエスト',
    button: '#btn-missing',
    expect: [
      { method: 'GET', path: '/api/listings/999999', status: 404,
        initiator: { file: PAGE, line: 70, component: 'Flows' } },
    ],
  },
  {
    key: 'no-response',
    label: '応答が返らない失敗（中断）',
    required: '失敗したリクエスト（観測不能な状態）',
    button: '#btn-abort',
    note: '応答が無いので識別情報が存在しない。対応付けを作ってはならない',
    expect: [
      { method: 'GET', path: '/api/listings', status: null, identity: false,
        initiator: { file: PAGE, line: 77, component: 'Flows' } },
    ],
  },
  {
    key: 'redirect',
    label: 'リダイレクト（307 → 200）',
    required: 'リダイレクト',
    button: '#btn-redirect',
    note: '1回の通信に応答が2つ返る。段ごとに別のサーバー処理である',
    expect: [
      { method: 'GET', path: '/api/listings', status: 200, hops: 2,
        redirect: [{ path: '/api/redirect', status: 307 }],
        initiator: { file: PAGE, line: 84, component: 'Flows' } },
    ],
  },
  {
    key: 'child-component',
    label: 'ページとは別のコンポーネントからの通信',
    required: 'Client Component からの fetch',
    button: 'button.child-fetch',
    note: 'ページのコンポーネント（Flows）ではなく FetchButton を指さねばならない',
    expect: [
      { method: 'GET', path: '/api/stats', status: 200,
        initiator: { file: CHILD, line: 10, component: 'FetchButton' } },
    ],
  },
];

/**
 * ページの文書取得。**操作ではなく読み込みで起きる通信である。**
 * ブラウザは呼び出しスタックを記録しないので、呼び出し元は特定できない。
 */
export const DOCUMENT_EXPECT = {
  key: 'document',
  label: 'ページの文書取得（Client Component のページ）',
  path: '/flows',
  identity: true,
  initiator: null,
  initiatorReason: 'no-script-stack',
};

/** Server Component が関与する通信 */
export const RSC_EXPECT = {
  key: 'rsc-document',
  label: 'Server Component のページの文書取得',
  path: '/flows-rsc',
  identity: true,
  initiator: null,
  initiatorReason: 'no-script-stack',
  /** サーバーの中で起きる通信。ブラウザには現れない */
  serverInternalFetch: {
    spanName: 'fetch GET',
    note: 'ブラウザからは観測できない。サーバー側のスパンとしてだけ現れる',
  },
};

/** UI のデータセットで主対象にする要素（PoC-03 の正解表と同じ読み方で手で書いた） */
export const UI_TARGETS = [
  { key: 'badge-text', page: '/flows', sel: 'span.badge-text', ord: 0, primary: true,
    group: 'nested', expect: { file: 'src/components/RegionBadge.tsx', line: 8, tag: 'span', component: 'RegionBadge' } },
  { key: 'card-code', page: '/flows', sel: 'article.card span.code', ord: 0,
    group: 'props', expect: { file: 'src/components/ListingCard.tsx', line: 14, tag: 'span', component: 'ListingCard' } },
  { key: 'h1', page: '/flows', sel: 'main.flows > h1', ord: 0,
    group: 'own-client', expect: { file: 'src/app/flows/page.tsx', line: 90, tag: 'h1', component: 'Flows' } },
];
