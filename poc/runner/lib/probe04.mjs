/* =============================================================================
 * PoC-04 の**手で書いた正解表**。
 *
 * 検証用アプリのソースを人が読んで書いた表である。**解析側はこの表を参照しない。**
 * 解析結果とこの表を突き合わせて、正答・候補提示・特定不能・誤答を数える。
 *
 * 正解の書き方（01b Q-04.3 の4分類に対応する）
 *   truth: []            この表示値は **DB 由来ではない**。候補を出したら誤答
 *   truth: [列, …]       この表示値の**本当の由来**。複数なら合成されている
 *   conclusive: true     ソースだけで1列に**決め切れる**（＝確定を期待してよい）
 *   conclusive: false    由来は分かるが、加工・分岐・動的キーのため決め切れない
 *   expectSite: false    JSX に式が無い（直書き）ため、**表示箇所として現れない**
 *
 * 難易度は 01b Q-04.3 の区分に合わせた。
 *   1 単純な直接対応 / 2 別名・多段・同名・動的SQL / 3 加工・分岐・複数候補 /
 *   4 由来が無い（DB由来でない）
 * ========================================================================== */

const L = (c) => ({ schema: 'poc', table: 'listings', column: c });
const R = (c) => ({ schema: 'poc', table: 'regions', column: c });

export const LINEAGE_CASES = [
  /* ------------------------------------------------- ケースA 単純な直接対応 */
  {
    case: 'A', page: '/lin-a', label: '単純な直接対応',
    note: 'SQL の region を同じコンポーネントの JSX がそのまま描く',
    sites: [
      {
        field: 'a-region', difficulty: 1, conclusive: true, truth: [L('region')],
        component: 'LinA', file: 'src/app/lin-a/page.tsx',
        why: 'r.rows.map((row) => …) の row.region。加工も受け渡しも無い',
      },
    ],
  },

  /* ---------------------------------------------- ケースB props の受け渡し */
  {
    case: 'B', page: '/lin-b', label: 'props の受け渡し（別名・多段）と SQL の別名',
    note: 'page → LinBCard → LinBLabel。code が label、さらに text に改名される。'
      + '別に SELECT code AS listing_code の別名も置いた',
    sites: [
      {
        field: 'b-sqlalias', difficulty: 2, conclusive: true, truth: [L('code')],
        component: 'LinB', file: 'src/app/lin-b/page.tsx',
        why: 'SQL の別名。行の鍵は listing_code だが、由来の列は code である'
          + '（01b Q-04.2 C-2）',
      },
      {
        field: 'b-label', difficulty: 2, conclusive: true, truth: [L('code')],
        component: 'LinBLabel', file: 'src/components/lin/LinBLabel.tsx',
        why: 'text ← LinBCard の label ← page の row.code。**2段の別名**',
      },
      {
        field: 'b-tier', difficulty: 2, conclusive: true, truth: [L('plan')],
        component: 'LinBCard', file: 'src/components/lin/LinBCard.tsx',
        why: 'tier ← page の row.plan。1段の別名',
      },
    ],
  },

  /* -------------------------------------------------------- ケースC 値の加工 */
  {
    case: 'C', page: '/lin-c', label: '値の加工',
    note: '連結・関数・プロパティ参照。由来は言えても確定にはできない',
    sites: [
      {
        field: 'c-title', difficulty: 3, conclusive: false, truth: [L('region'), L('code')],
        component: 'LinC', file: 'src/app/lin-c/page.tsx',
        why: 'テンプレートで2列を連結している。**1列に絞ってはいけない**',
      },
      {
        field: 'c-upper', difficulty: 3, conclusive: false, truth: [L('code')],
        component: 'LinC', file: 'src/app/lin-c/page.tsx',
        why: 'String() と toUpperCase() を通している。由来は code だが値は別物',
      },
      {
        field: 'c-len', difficulty: 3, conclusive: false, truth: [L('code')],
        component: 'LinC', file: 'src/app/lin-c/page.tsx',
        why: 'code の文字数。由来は code だが、表示値は code ではない',
      },
    ],
  },

  /* -------------------------------------------------------- ケースD 複数候補 */
  {
    case: 'D', page: '/lin-d', label: '複数候補・同名変数',
    note: '動的キーで引く1箇所と、別スコープの同名 row が2箇所',
    sites: [
      {
        field: 'd-dynamic', difficulty: 3, conclusive: false,
        truth: [L('region'), L('plan'), L('scale')],
        component: 'LinD', file: 'src/app/lin-d/page.tsx',
        why: 'FIELDS の各要素をキーに bag[f] を引く。**どの列かはソースから決まらない**',
      },
      {
        field: 'd-same-name-a', difficulty: 2, conclusive: true, truth: [L('code')],
        component: 'LinD', file: 'src/app/lin-d/page.tsx',
        why: '`row` という同名の変数が別の map にもある。こちらは poc.listings の SQL',
      },
      {
        field: 'd-same-name-b', difficulty: 2, conclusive: true, truth: [R('name')],
        component: 'LinD', file: 'src/app/lin-d/page.tsx',
        why: '同名の `row` だが、こちらは poc.regions の SQL。**取り違えたら誤答**',
      },
    ],
  },

  /* -------------------------------------------------------- ケースE 条件分岐 */
  {
    case: 'E', page: '/lin-e', label: '条件分岐',
    note: '別の列になる分岐／固定値になる分岐／固定値しか描かない分岐',
    sites: [
      {
        field: 'e-either', difficulty: 3, conclusive: false,
        truth: [L('region'), L('code')],
        component: 'LinE', file: 'src/app/lin-e/page.tsx',
        why: '条件で region か code のどちらかになる。**実行時にしか決まらない**',
      },
      {
        field: 'e-orconst', difficulty: 3, conclusive: false, truth: [L('region')],
        component: 'LinE', file: 'src/app/lin-e/page.tsx',
        why: 'region か固定値 "未設定"。固定値になる経路があるので確定にできない',
      },
      {
        field: 'e-inline', difficulty: 4, conclusive: false, truth: [],
        component: 'LinE', file: 'src/app/lin-e/page.tsx',
        why: '**条件の判定に plan を使うが、描くのは固定値だけである。**'
          + ' plan を由来にしたら誤答である',
      },
    ],
  },

  /* ---------------------------------------------------- ケースF RSC 直接取得 */
  {
    case: 'F', page: '/lin-f', label: 'RSC 直接取得（同一／子コンポーネント）',
    note: '1ページに2本の SQL。親は poc.listings、子は poc.regions',
    sites: [
      {
        field: 'f-own', difficulty: 1, conclusive: true, truth: [L('code')],
        component: 'LinF', file: 'src/app/lin-f/page.tsx',
        why: '同じ Server Component が取得して描く',
      },
      {
        field: 'f-child', difficulty: 1, conclusive: true, truth: [R('name')],
        component: 'LinFChild', file: 'src/components/lin/LinFChild.tsx',
        why: '子の Server Component が自分で取得して、加工せずに描く。'
          + '**親の SQL（poc.listings）と混同したら誤答**',
      },
      {
        field: 'f-child-cast', difficulty: 3, conclusive: false, truth: [R('name')],
        component: 'LinFChild', file: 'src/components/lin/LinFChild.tsx',
        why: '同じ列を String() で型変換して描く。由来は1列に決まるが、'
          + '**型変換も加工として扱うので確定にしない**（安全側の取りこぼし）',
      },
    ],
  },

  /* ---------------------------------------------------------- ケースG 否定例 */
  {
    case: 'G', page: '/lin-g', label: '否定例（同一コンポーネント内の無関係なSQL）',
    note: 'SQL は実行するが、結果はどの表示値にも使っていない',
    sites: [
      {
        field: 'g-env', difficulty: 4, conclusive: false, truth: [],
        component: 'LinG', file: 'src/app/lin-g/page.tsx',
        why: '環境変数由来。同じコンポーネントに SQL があるが無関係である',
      },
      {
        field: 'g-literal', difficulty: 4, conclusive: false, truth: [], expectSite: false,
        component: 'LinG', file: 'src/app/lin-g/page.tsx',
        why: 'JSX に直書きされた文字列。式が無いので表示箇所として現れない'
          + '（02a PathKind = static-literal）',
      },
      {
        field: 'g-computed', difficulty: 4, conclusive: false, truth: [],
        component: 'LinG', file: 'src/app/lin-g/page.tsx',
        why: '定数の計算。DB を一切通らない',
      },
      {
        field: 'g-shadow', difficulty: 4, conclusive: false, truth: [],
        component: 'LinG', file: 'src/app/lin-g/page.tsx',
        why: '**局所変数の名前が SQL の列名 region と同じ。**'
          + ' 名前の一致で対応づけたら誤答になる罠である',
      },
    ],
  },

  /* ----------------------------------------- 補助ケースX 不完全なソース解析 */
  {
    case: 'X', page: '/lin-x', label: '補助: 不完全なソース解析', supplementary: true,
    note: 'ソースだけでは列構成が決まらない3つ',
    sites: [
      {
        field: 'x-dynamic', difficulty: 2, conclusive: true, truth: [L('code')],
        component: 'LinX', file: 'src/app/lin-x/page.tsx',
        why: 'SQL をソース上で組み立てている（リテラルが無い）。'
          + '**実測された SQL 文があれば列は決まる**（01b Q-04.2 C-7）',
      },
      {
        field: 'x-star', difficulty: 3, conclusive: false, truth: [R('name')],
        expectTableOnly: true,
        component: 'LinX', file: 'src/app/lin-x/page.tsx',
        why: 'SELECT * のため列を特定できない。**テーブルまでなら決まる**'
          + '（01b Q-04.5 代替1）',
      },
      {
        field: 'x-outside', difficulty: 4, conclusive: false, truth: [],
        component: 'LinX', file: 'src/app/lin-x/page.tsx',
        why: '解析範囲（src/）の外の関数が返す値。候補を出さないのが正解',
      },
    ],
  },
];

/** ケースA〜G（判定の母数）と補助ケース（参考）を分ける */
export const MAIN_CASES = LINEAGE_CASES.filter((c) => !c.supplementary);
export const SUPP_CASES = LINEAGE_CASES.filter((c) => c.supplementary);
export const ALL_PAGES = LINEAGE_CASES.map((c) => c.page);

/**
 * 既存の `client-fetch` 経路（PoC-03 の題材）。
 * **ケースA〜G には含めない。** 静的解析がどこで切れるかを記録するためにある。
 */
export const CLIENT_FETCH_SITES = [
  {
    field: 'region', page: '/listings', component: 'Listings',
    file: 'src/app/listings/page.tsx', truth: [L('region')], difficulty: 3,
    why: 'useState / fetch の応答を経由する。**静的解析では応答の中身に型しか無い**',
  },
];

/** 収集禁止の痕跡（PoC-01/02/03/05 と同じ表を使う） */
export { FORBIDDEN } from './probe02.mjs';

/** キャンバスへ流し込む場面。成功・複数候補・切断の3つを並べる */
export const UI_SCENES_04 = [
  {
    key: 'linA', page: '/lin-a', name: 'ケースA 由来を1列に絞れた', renderRoute: '/lin-a',
    field: 'a-region', selector: '[data-poc-field="a-region"]',
  },
  {
    /*
     * 複数候補の見せ方を測る場面。ケースD（動的キー・候補4件）ではなく
     * **ケースC の連結**を使う。理由は表示の都合である — ケースD のページは
     * SQL が3本あり、カラムのノードが7つになって既存のレイアウトの帯から
     * はみ出す。候補が複数のままになる表現はケースC でも同じである
     * （採点はケースA〜G すべてで別に行っている）。
     */
    key: 'linC', page: '/lin-c', name: 'ケースC 候補が複数のまま', renderRoute: '/lin-c',
    field: 'c-title', selector: '[data-poc-field="c-title"]',
  },
  {
    key: 'linG', page: '/lin-g', name: 'ケースG 由来を作らない', renderRoute: '/lin-g',
    field: 'g-shadow', selector: '[data-poc-field="g-shadow"]',
  },
];
