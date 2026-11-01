# Phase 7B-3B-2 実施報告 — RSC の値の由来の統合（`supplies` / 静的解析 ＋ 実測の照合）

| | |
| --- | --- |
| 対象 | プレビューで選んだ要素の値について、**それを描いた文書の通信**を同定し、PoC-04 の静的解析が見た「値 → データ取得の呼び出し」を、その文書の通信で**実測した呼び出し位置**と**実行された SQL の SELECT 句**に照合してから、`supplies: DataAccessSite → PropBindingSite`（L2・`static-analysis`）を M1 の契約どおり作る |
| 基準 | ブランチ `claude/happy-euler-7404el`、コミット `e018c4f`（Phase 7B-3B-1 完了時点） |
| 実施日 | 2026-11-01 |
| 題材 | `poc/fixture-app` の RSC 直接取得（素の `pg` の `pool.query`）。Next 16.4.3 / Turbopack ＋ 使い捨てのローカル PostgreSQL 16（合成データ `db/init.sql`） |
| 方式 | **新しい解析器は作っていない。** PoC-04 の `poc/runner/lib/lineage.mjs`（R1〜R6・白表・記号解決）に対象の場所を引数で渡せるようにし、7B-3B-1 の `DataAccessSite` と 6F の SQL 解析器の SELECT 句に照合した。文書の同定は、7B-1 から中継が差し込んでいるスクリプトに、応答ごとの識別子を1つ足した |
| 新しい UI デザイン | **作っていない。** 既存のキャンバス・右ドック・プレビューパネルの選択の行。足したのは選択の行の下の1行（文書の同定と由来）と、既存の注記1行の文言の場合分け |
| 新しい関係種別 | **作っていない**（12件のまま）。文書の同定は関係ではなく `supplies` の成立条件として扱った（第3.4節） |
| やっていないこと | client-fetch の G1 / G2・`requests` の新しい生成・Prisma の入口の計装・`maps` / `derives` の生成・新しい UI デザイン・一般の Next.js プロジェクト・`ComponentInstance` |

**7B-3B-2 の完了時点で止めている。**

---

## 0. 最初に確認したもの

| 確認したもの | わかったこと |
| --- | --- |
| `docs/07b3b1` | `queries` は成立。**選択した要素を描いた文書取得は同定していない**（同じパスで並べるだけ）。preview-e2e に変更前からの1件の失敗（`DATABASE_URL` の名前）が残っていた（第9.3節） |
| `docs/06e`（PoC-04） | `supplies` は L2 のまま昇格しない。保守規則 R1〜R6。ケースA〜G の正解表。結合の鍵は呼び出し位置（ファイル・行）であって SQL 文ではない |
| `docs/06g`（M1） | `supplies: DataAccessSite → PropBindingSite` / L2 / `static-analysis` / `orientation: 'against-data'` / 端点は2つのソース位置。成立条件5（描画位置）・6（取得位置）。**新しい関係は表（`02a` 3.5.1 ＝ `RELATION_SPEC`）に先に足す** |
| `docs/02a` / `02d` | `PropBindingSite` / `DataAccessSite` は `ComponentDef` のノードが担う（`ENDPOINT_CARRIER`）。観測性は `observabilityOf` だけが決める |
| `src/server/dataAccess.ts` | 同一プロセスの照合が `rec.pid !== null && pid !== null && rec.pid !== pid` で、**片方が欠けると比べずに通過**していた |
| `src/server/anchors.ts` | 要素識別子の位置は JSX 要素の開始（`skipTrivia(n.pos)`）。`lineage.mjs` の `getStart()` と同じ位置になる |
| `poc/runner/lib/lineage.mjs` | 対象の場所が `APP` 固定。表示箇所は「式の位置」と「注記の要素」だけで、**式を直接の子に持つ要素の位置**と、取得の呼び出しの**メソッド名の列**（V8 のスタックが指す列）を持っていなかった |
| PoC-04 の既存テスト・ケースA〜G | `tests/poc04.spec.mjs` 143 件・`lineage.spec.mjs` 65 件。本段階の後も同数で通過（第8節） |

---

## 1. 最初に解消した回帰・契約上の問題

### 1.1 A. preview-e2e の `DATABASE_URL` 判定

**原因（再確認）**: 7B-1 の検査は「起動先のプロセスが秘密情報の**名前**を1つも持たない」だった。`next dev` は対象プロジェクト自身の `.env*` を読み込み（`@next/env`）、その後に生む Turbopack の作業プロセスは `process.env` を受け継ぐ。**名前だけでは、IDE から漏れた値と、対象プロジェクトが自分で読んだ値を区別できない。** この環境でも作業プロセスが `DATABASE_URL` を持っていた（値は題材の `.env` のもの。IDE のダミーではない）。

**直し方 — 名前ではなく、値と出所で判定する**（`tests/lib/envOrigin.mjs`）

| 分類 | 判定 | 扱い |
| --- | --- | --- |
| `ide-secret` | 値が IDE に入れたダミーの秘密情報と一致する／目印を含む。**名前は問わない**（名前を変えて渡っても検出する） | 失敗 |
| `project-dotenv` | 秘密情報の名前で、値が対象プロジェクトの `.env` / `.env.development` / `.env.local` / `.env.development.local` に書かれた同じ名前の値と一致する | 正常（Next.js の動作） |
| `unexplained` | 秘密情報の名前で、値がどちらとも一致しない | **失敗**（出所を説明できないものは通さない） |

加えて、**IDE が直接起動したプロセス**（`runtime.pid`）の起動時の環境（`/proc/<pid>/environ`）は IDE が渡したものそのものなので、ここは従来どおり**名前でも**検査する（秘密情報の名前が1つも無いこと）。前提として、IDE のダミーとプロジェクトの `.env` の値が同じなら出所を区別できないので試験を止める（`assertDistinguishable`）。

**期待値を変更した理由**: 「起動先のどのプロセスも秘密情報の名前を持たない」は、対象プロジェクトが `.env` を持つ限り Next.js の正常な動作で破られる。検査の目的（**IDE の秘密情報が子へ渡らないこと**）を値と出所で直接確かめる形にした。**緩めていない** — 検査対象から `DATABASE_URL` を外す直し方は、IDE の `DATABASE_URL` が漏れる場合を見逃すので採らなかった（下の否定テストで実際に見逃すことを確かめた）。

**否定テスト**（新規 `tests/childenv-origin.spec.mjs`。DB 不要。**実物のプロセス**を起こして `/proc/<pid>/environ` を読む）

| 場面 | 結果 |
| --- | --- |
| 正しい起動（IDE は `childEnv()` の環境だけ。親がプロジェクトの `.env` を読み、子が受け継ぐ） | 親は秘密情報の名前なし。子の `DATABASE_URL` は `project-dotenv`。**旧い名前の検査はこの正常な起動を失敗にしていた**ことも確認 |
| IDE の `DATABASE_URL` が漏れる起動（実物の `childEnvReport` に `VCIDE_CHILD_ENV_PASS=DATABASE_URL`） | 子・親とも `DATABASE_URL` を `ide-secret` として検出。`@next/env` は既在の値を上書きしないため IDE の値が残る。**「DATABASE_URL を検査から外す」直し方ではこれを見逃す** |
| IDE の環境をそのまま渡す起動（7A までの不具合の形） | 4つの秘密情報をすべて値で検出 |
| 名前を変えて渡った IDE の値（`APP_DB`）／どちらの出所でもない値 | 前者は `ide-secret`、後者は `unexplained`（失敗側） |

**実物での結果（`tests/preview-e2e.spec.mjs`）**: **0 件失敗**（74〜78 件通過。件数は検査の時点の作業プロセスの数で変わる。7B-3B-1 では 73 / 1 失敗）。作業プロセスに在った名前として `DATABASE_URL` を記録し、その値はプロジェクトの `.env` のものだった。

### 1.2 B. PID の欠損

`src/server/dataAccess.ts` の照合 B を次に改めた。

| 状態 | 7B-3B-1 | 7B-3B-2 |
| --- | --- | --- |
| 両方に PID があり一致 | 成立 | 成立 |
| 両方に PID があり不一致 | `callsite-mismatch` | `callsite-mismatch` |
| 記録に PID が無い／スパンに PID が無い／両方無い | **比べずに通過（成立しうる）** | **`callsite-pid-missing`（新しい理由コード）。`queries` を作らない** |

PID の形が違う（文字列など）記録も「欠損」として扱う（`parseCallsiteRecord` が数でなければ `null` にする）。照合の項目の文言に「PID が記録とスパンの両方にあり一致」を書いた。

| 確認 | 結果 |
| --- | --- |
| 単体（`queries-unit` に7件追加） | 記録に無い・スパンに無い・両方無い・形が違う → `callsite-pid-missing`、位置を出さない。両方あり一致 → 成立。**7B-3B-1 の実装（`e018c4f`）に同じ試験をかけると、欠損の4件はすべて位置を出して成立した**（`e018c4f` の `src/` を取り出してビルドし、実行して確認。120 通過 / 6 失敗） |
| 実物の計装が PID を記録しているか（`lineage-e2e` 第8節） | 収集ファイルの SQL の呼び出し位置の記録 **29 件すべて**と SQL のスパン **12 本すべて**に `proc.pid`（整数）があり、同じスパン ID どうしで一致した（`sink.cjs` が全記録に `proc` を付ける） |
| `supplies` への波及 | PID 欠損で `site` が無い SQL は、由来の評価でも `fetch-site-unverified`（実測との照合の段）で切れる（`lineage-live-unit`） |

---

## 2. 実装した経路

```
ブラウザ（プレビューの iframe）
   │ GET /lin-a
   ▼
プレビュー中継 ── 要求ごと: relayId（開発サーバーへ x-vcide-relay。7B-3B-1）
   │              HTML の応答ごと: docToken（差し込むスクリプトの data-vcide-doc。**7B-3B-2**）
   │              記録: { …, relayId, docToken }（ブラウザに relayId・トレース識別子は渡さない）
   ▼
next dev（計装・POC02_CALLSITE・POC07_RELAY_ID・要素識別子の注入）
   └→ .ide-runtime/spans/<この起動>.jsonl（スパン・呼び出し位置の記録・PID）

iframe の文書のスクリプト ── 選択: { 要素識別子・タグ・何番目か・値の形, doc: docToken, soft: 遷移の有無 }
   │ MessagePort（7B-2）
   ▼
IDE の画面 ── POST /api/runtime/anchor（7B-2: 要素の位置）
          └─ POST /api/runtime/lineage（7B-3B-2）
                ├ 要素の位置を照合し直す（anchors.ts の6段）
                ├ いまの起動の観測を1回取る（liveCollect.ts。観測の API と同じ手順）
                ├ bindDocument: docToken → 通信 #n（第3節）
                ├ analyzeProject: PoC-04 の lineage.mjs（ソースの状態が同じ間は使い回す）
                └ evaluateLineage: 静的解析 × 実測の呼び出し位置 × SELECT 句（第4節）
                → { observation, binding, lineage }（同じ1回の取得から）
   adapter.fromLiveRun(observation, n, { selection, binding, lineage })
     ① 値 ─renders→ ② 描いた位置（PropBindingSite を担う）
                       ⇢ supplies（L2・against-data）⇢ ②'' 取得位置（DataAccessSite を担う）─queries→ ⑤ SQL ─reads→ ⑥ ─projects→ ⑦
```

### 2.1 画面（既存の部品だけ）

- 選択モードで要素をクリックすると、従来どおり ①② を出し、続けて由来を評価する。**結べたときだけ**、その要素を描いた文書の通信の経路を同じキャンバスに並べ、② から ②'' へ「由来は静的解析による推定」の分節線を引く（PoC-04 の記録データの表示と同じ部品・同じ語）。
- 選択の行の下に1行: `文書: 通信 #n の応答と同定。由来（静的解析による推定）: poc.listings.region`／`… 2 候補のいずれか（listings.code / listings.region）。1つに決めていません`／`… 由来は結んでいません — 静的解析: …`。
- 結べないときは選択の表示のまま、② の切断（「ここから先は観測していません」）の下の行に**欠けた段と理由**を出す。
- 右ドックの最弱環・「この値の出所」は既存の算出（`derive.ts`）がそのまま `supplies` を選ぶ（`poc.listings . region / 推定`、「17 か所のうち 1 か所が推定」）。

画面: `docs/07b3b2-screenshots/`（`SHOTS=docs/07b3b2-screenshots node tests/lineage-e2e.spec.mjs` で撮影）

| 画像 | 内容 |
| --- | --- |
| `01-lin-a-supplies.png` / `01b-…-canvas.png` | `/lin-a` の `<li>` → 描いた位置（`page.tsx:18`）⇢ 推定 ⇢ 取得位置（`page.tsx:12:24`）→ SQL → `poc.listings` → `region`。右ドックに出所と最弱環 |
| `02-client-navigation-cut.png` | pushState の後の選択。文書を同定せず、切断に「文書の同定: …クライアント側の遷移…」 |
| `03-lin-g-shadow-cut.png` | `g-shadow`（列名と同じ名前の局所変数）。文書は同定できたが、静的解析の段で切れる |
| `04-lin-e-candidates.png` | `e-either`（条件分岐）。候補2件のまま |

> 浮かぶパネルがキャンバスの一部を覆うのは 7B-2 からの既知の制約（配置は変えていない）。`01b` は撮影の間だけパネルを隠した。

---

## 3. 文書と HTTP の関連付けの成立条件

### 3.1 識別子

| | `relayId`（7B-3B-1） | `docToken`（7B-3B-2） |
| --- | --- | --- |
| 作る単位 | 記録する要求ごと | **HTML を差し込んだ応答ごと** |
| 渡す先 | 開発サーバー（`x-vcide-relay` → 受付スパンの属性） | ブラウザ（差し込むスクリプトの属性 `data-vcide-doc`） |
| ブラウザに見えるか | 見えない（応答に返さない） | 見える（その文書の中だけ） |
| 値 | 16 進 32 桁の乱数 | 16 進 32 桁の**別の**乱数（台帳は relayId と同じ値を受けない） |

**中継の内部の識別子（relayId）・トレース識別子・認証情報はブラウザに出さない**: iframe の文書の HTML に、どの通信の relayId もトレース識別子も現れないことを実物で確認した（`lineage-e2e` 第7節）。

### 3.2 同定の条件（`bindDocument`。すべて満たしたときだけ）

| # | 条件 | 欠けたときの理由 |
| --- | --- | --- |
| 1 | iframe の文書のスクリプトが識別子を知らせた（IDE が開いた接続・いまの起動の文書 — 7B-2 の接続の検査） | `no-document-token` |
| 2 | その文書の中でクライアント側の遷移が無い（スクリプトが `pushState` / `popstate` で `soft` にする。不明も同一視しない） | `client-navigation` |
| 3 | いまの起動の観測セッションに、その識別子の通信が**ちょうど1件** | `token-not-in-session` / `token-duplicated` |
| 4 | その通信のパス = 選択したページのパス | `path-mismatch` |
| 5 | その通信は正常な応答（2xx）を送り終えている | `document-failed` |
| 6 | その文書の後に、同じパスの RSC の再取得（`rsc: 1`）が無い（`router.refresh` / HMR で DOM が描き直された可能性を保守的に断る） | `refetched-after-document` |

使っていないもの: 時刻の近さ・パスだけ・「同じパスの最新の通信」。

### 3.3 確かめた場面

| 場面 | 結果 | 環境 |
| --- | --- | --- |
| 再読み込み | 新しい文書は新しい通信に同定。前の文書の通信には同定しない | **実物** |
| 同じパスの並行要求 | 表示中の文書から同じパスを3本並行に取得した後も、選択は**表示中の文書の通信**に同定（最新の同じパスの通信ではない）。結びついた SQL も表示中の文書のトレースのもの | **実物**（＋単体で中継の識別子が並行の2応答で別） |
| 停止・再起動 | 停止中は 409。再起動後、前の起動の識別子は `token-not-in-session`。新しい起動の文書に同定し直す | **実物** |
| React のクライアント側の遷移 | `pushState` の後の選択は `client-navigation` で同定しない・由来も結ばない | **実物**（遷移は `history.pushState` で起こした。題材に `next/link` が無いため） |
| 同じパスの RSC の再取得 | `refetched-after-document` | 単体（模擬） |
| 偽った・別のパス・知らせなし | `token-not-in-session` / `path-mismatch` / `no-document-token`。形の違う識別子は 400 | **実物**（API を画面と同じ入口で直接） |

### 3.4 新しい関係種別は要るか — **要らない**（M1 の表は変えていない）

文書の同定は「いま iframe に表示している文書は、通信 #n の応答である」という**観測の文脈の同定**であって、データの経路ではない。通信 → DOM の線を経路に描くと、値が応答から流れてきたように読める（`rsc-direct` に応答本文の経路は無い — `06e` 1.2節）。そこで **値のノードの属性**（「文書の同定」「通信との関係」）と **`supplies` の成立条件**として扱い、`02d` 1.3.5 節に条件を書いた。関係・取得手段の表（`02a` 3.5.1 / `02d` 1.3 ＝ `RELATION_SPEC` / `SOURCE_LEVEL`）は変えていないので、M1 の「表に先に足す」手順の対象ではない。`lineage-live-unit` 第1節で「関係種別は12件のまま・文書に関する関係が無い」を検査している。

### 3.5 ブラウザ内のアプリがメッセージを偽れる制約

スクリプトはアプリと同じ JavaScript の世界で動く。スクリプトは読み込み時（アプリのスクリプトより前）に識別子を読み、送信の関数（`MessagePort.prototype.postMessage`）も先に取っておくが、**アプリのコードは文書の識別子や遷移の有無を偽れる**。IDE の照合が保証するのは「いまの起動の、中継が実際に返した HTML の応答の識別子で、そのパスのもの」までである。**偶然の取り違え（再読み込み・同じパスの並行・停止と再起動）を防ぐためのものであり、悪意のあるアプリへの保証ではない。** 画面の説明（`DOC_UNBOUND_LABEL`）とプロトコルの注記に書いた。

> **この関連付けは通信と文書の対応であって、表示された値と SQL 結果の対応の証明ではない。** 値のノードの「通信との関係」に必ずそう書く。

---

## 4. PoC-04 の再利用方法

| ファイル | 変更 |
| --- | --- |
| `poc/runner/lib/lineage.mjs` | `analyzeLineage({ root })`（既定は従来どおり PoC の題材）。表示箇所に**式を直接の子に持つ JSX 要素の位置**（`element`。要素識別子と同じ規則）と、その要素の直下の固定の文字・式の数を足した。取得の呼び出しに**メソッド名の位置**（`nameLine` / `nameCol`）を足した。**R1〜R6・白表・記号解決・`resolveLineage` は変えていない** |
| `src/server/lineage.ts`（新規） | `lineage.mjs` を実行時に読む（画面のバンドルに入れない — 6F の `sqlparse.mjs` と同じ）。ソースの状態（一覧・更新時刻・大きさ）が同じ間は解析を使い回す。解析したソースが文書の取得の後に書き換わったかを返す |
| `src/lib/liveLineage.ts`（新規） | `evaluateLineage`（純粋）。解析結果と `resolveLineage` を引数で受け、文書の同定・実測の呼び出し位置・SELECT 句と照合する |

SELECT 句は 7B-3A と同じく Phase 6F の `sqlparse.mjs` の結果（観測の `sqlAnalyses[].selectItems`）を使う。PoC-04 の `selectList()` と同じ関数である（解析器を2つ持たない）。

PoC-04 の既存の検査（`poc04.spec.mjs` 143 件・`lineage.spec.mjs` 65 件）は**期待値を変えずに通過**した。

---

## 5. `supplies` の生成条件と、実際に成立した経路

### 5.1 生成条件（`evaluateLineage`。1つでも欠ければ作らない）

| 段 | 条件 | 欠けたときの理由コード |
| --- | --- | --- |
| **文書** | 第3.2節で同定できる | `document-unidentified` |
| **静的解析** | 選択した要素の位置（7B-2 の6段を通ったもの）を照合し直せる | `selection-unresolved` |
| | 静的解析器を使える | `analyzer-unavailable` |
| | 解析したソースが、その文書の取得の後に書き換わっていない | `source-changed-after-run` |
| | 要素識別子が指す JSX 要素の**直下**に値を描く式がちょうど1つ。静的解析が見た要素の位置と**列まで**一致し、囲むコンポーネントも一致（M1 成立条件5を強めた） | `no-value-site` / `mixed-text-children` / `multiple-value-sites` |
| | 参照の連鎖が**1つの**データ取得の呼び出しの結果に届く（R1〜R4 は lineage.mjs が守る） | `no-reference` / `multiple-fetch-sites` |
| **実測との照合** | 同定した文書の通信をサーバー処理・SQL に結べる（7B-3A / 3B-1） | `no-server-link` |
| | 静的解析が見た呼び出し位置（ファイル・行・**メソッド名の列**）で、**その文書の通信の中で**実行された SQL があり、その位置を `server-call-stack` で特定できている（M1 成立条件6・R5） | `fetch-not-measured` / `fetch-site-unverified` |
| | 同じ位置から SELECT 句の構成が違う SQL が走っていない | `select-list-differs` |
| **SELECT 句** | 参照の鍵が実行された SQL の SELECT 句にある（R6。無ければテーブルも主張しない） | `no-column` |

作るホップ（`adapter.fromLiveRun`）: `relation: 'supplies'`、`source: 'static-analysis'`（観測性は `observabilityOf` で**推定**）、`orientation: 'against-data'`、`endpoints.from = PropBindingSite`（値を描く式のファイル・行・列）、`endpoints.to = DataAccessSite`（**実測した**呼び出し位置のファイル・行・列）。始点は描いた位置のコンポーネントのノード、終点は SQL を実行した位置のノード（そこから `queries` が SQL へ）。候補が1件なら `resolved`、複数なら `multiple-candidates` と `candidates[]`、テーブルまでなら `untraceable` ＋ 切断「由来の列は特定していません」。**評価は同定した文書の通信の描画にだけ使う**（同じパスの別の通信を表示しても線を引かない）。

### 5.2 実際に成立した経路（実物の `next dev`・実物の PostgreSQL・Chrome）

正解は試験が題材のソースを読んで決めた（`data-poc-field` の要素・`{…}` の位置、`pool.query` の行・列）。

| ページ・要素 | 結果 | 描いた位置（PropBindingSite） | 取得位置（DataAccessSite） | 由来 |
| --- | --- | --- | --- | --- |
| **`/lin-a` `<li>`（ケースA。最初の対象）** | **linked / confirmed** | `src/app/lin-a/page.tsx:18:54`（`row.region`） | `src/app/lin-a/page.tsx:12:24`（`LinA`） | **`poc.listings.region`** |
| `/lin-e` `e-either` | linked / candidates | `lin-e/page.tsx` | `lin-e/page.tsx` の `pool.query` | `listings.code` / `listings.region`（**2候補のまま**） |
| `/lin-d` `d-dynamic` | linked / candidates | | 1本目の `pool.query` | その SQL の全列（4候補） |
| `/lin-d` `d-same-name-a` / `-b` | linked / confirmed | | 2本目 / 3本目の `pool.query`（19 行 / 20 行） | `listings.code` / `regions.name`（同名の `row` を取り違えない） |
| `/rsc-dup` 子の `<span>` | linked / table-only | `ListingCount.tsx` | `src/components/ListingCount.tsx:6:24` | テーブル `poc.listings` まで（`count(*) AS n` は列に帰属しない） |
| `/rsc-dup` ページの `<p>` | linked / table-only | `rsc-dup/page.tsx` | `src/app/rsc-dup/page.tsx:13:24` | 同上（**同じ SQL 文の2か所を位置で分けた**） |

`/lin-a` では、実測した SQL（`SELECT id, region FROM poc.listings ORDER BY id LIMIT $0`）が**その文書の通信のトレースの中**で実行され、その SELECT 結果列に `region` があることも確かめた。`validateDataset()` は実データで違反 0。

---

## 6. 否定例と、未特定・複数候補の扱い

| 否定例（指示 第5節） | どこで切れるか | 確認 |
| --- | --- | --- |
| 同じ SQL を複数箇所で実行 | 切れない。**位置で**それぞれの取得に結ぶ（文の一致を使わない） | 実物（`/rsc-dup`）＋単体 |
| 同じパスの文書取得が並行 | 文書の同定（表示中の文書の識別子だけ） | 実物＋単体 |
| 値が定数由来（`g-shadow` / `g-env` / `g-computed`） | 静的解析 `no-reference` | 実物（`g-shadow` / `g-env`）＋単体 |
| 式の無い固定の文字（`g-literal`） | 静的解析 `no-value-site` | 単体 |
| 条件分岐（`e-inline`） | 静的解析 `no-reference`（条件の判定に使った列は由来ではない — R2） | 実物＋単体 |
| 条件分岐（`e-either` / `e-orconst`） | 結ぶが**候補のまま** / 固定値の経路ありで確定にしない（R3） | 実物（`e-either`）＋単体 |
| 関数の内部が不明（`x-outside`） | 静的解析 `no-reference`（`call-not-whitelisted` — R4） | 単体 |
| 同名の変数・列（`d-same-name-*`・`g-shadow`） | 取り違えない／名前の一致で結ばない | 実物＋単体 |
| SELECT 句に存在しない列 | SELECT 句 `no-column`（テーブルも主張しない — R6） | 単体（実測の SQL を `SELECT id …` にした模擬） |
| 未実行の SQL | 実測との照合 `fetch-not-measured`（R5）。位置が列でずれたものも同じ | 単体 |
| 異なる起動・異なる文書 | 文書の同定 `token-not-in-session` / `path-mismatch` / `client-navigation` / `no-document-token` | 実物＋単体 |
| 候補が複数（`d-dynamic`） | 結ぶが `multiple-candidates`。1つに確定しない | 実物＋単体 |
| PID 欠損 | 実測との照合 `fetch-site-unverified`（理由に `callsite-pid-missing`） | 単体 |
| 取得が2つ・式が2つ・固定の文字と混在・ソースの書き換え | `multiple-fetch-sites` / `multiple-value-sites` / `mixed-text-children` / `source-changed-after-run` | 単体（試験のために組んだ解析結果） |

**候補の扱い**: 候補が複数のときは `multiple-candidates` と `candidates[]` を持ち、パネルの行は「N 候補のいずれか（…）。1つに決めていません」、右ドックの出所は既存の算出どおり「N 候補のいずれか」。**テーブルまで**のときは列を主張せず、切断「由来の列は特定していません」を残す。

**成立しない経路では線を作らない**: どの理由でも `supplies` を作らず、② の切断の下の行に「<段>: <理由>（詳細）」を出す（キャンバス・パネルの行・右ドックの「SQL との関係」「由来の評価」）。

---

## 7. M1 の契約（端点・向き・観測性）

| 契約 | 守り方 | 検査 |
| --- | --- | --- |
| 関係は12件の閉じた集合 | 追加していない | `lineage-live-unit` 1 |
| `supplies` = `DataAccessSite → PropBindingSite` | `orientation: 'against-data'` で `from` = 描いた位置・`to` = 取得位置。向きを `along-data` にすると `validateDataset` が拒否することを確認 | 単体 6・実物 2 |
| 端点のソース位置（列まで） | `endpoints.from` = 式の位置、`endpoints.to` = 実測した呼び出し位置。落とすと拒否 | 単体 6・実物 2 |
| 観測性は取得手段だけが決める | `static-analysis` → 推定。実測の照合を通っても昇格しない。`server-call-stack` にすると拒否 | 単体 6・実物 2 |
| 帰属は定義（ソース位置）まで | 「同じ定義が複数回描かれている場合、どの行の値かは同定していません」を弱点の説明と provenance に書く | 単体・実物 |
| `validateDataset()` | 実データ・模擬データの全ての描画で違反 0 | 単体・実物 |

---

## 8. テスト

### 8.1 新規・変更した試験

| 試験 | 件数 | DB | 環境 | 内容 |
| --- | --- | --- | --- | --- |
| `childenv-origin`（新規） | **22** | 不要 | 実物のプロセス（`/proc`） | 第1.1節の否定テスト |
| `lineage-live-unit`（新規） | **118** | 不要 | 本物の中継・台帳・静的解析（題材のソース）＋**模擬の観測** | 第3〜7節 |
| `lineage-e2e`（新規） | **83** | **要る** | **実物**（Chrome・IDE `next start`・`next dev`・PostgreSQL 16）。クラウドの転送は模擬 | 第2・3・5・6節、PID、機密情報、停止・再起動 |
| `queries-unit`（追加） | 119 → **126** | 不要 | 模擬 | PID 欠損7件 |
| `preview-e2e`（判定を変更） | 73 / 1 失敗 → **74〜78 / 0** | 不要（DB に触れない） | 実物 | 第1.1節 |
| `select-unit` / `select-e2e` / `queries-e2e`（期待値を変更） | 85 / 81 / 120 | 不要 / 不要 / 要る | — | 下の 8.3 |

**検査が飾りでないことの確認（変異）**: 次の4つを1つずつ外すと、それぞれ `lineage-live-unit` の該当の検査が失敗した（元に戻して全件通過）。① 取得位置の**列**の照合（ファイル・行だけにする）② クライアント側の遷移の検査 ③ 評価を使う通信の番号の検査（別の文書の描画に使う）④ 文書の識別子の照合（「同じパスの最新の通信」に置き換える — 13件失敗）。

### 8.2 回帰（`npm test` の全スイート。新しく起動した IDE（`next start -p 3100`）に対して1本ずつ）

| スイート | 結果 |
| --- | --- |
| `poc01` | 56 通過 / 0 失敗 |
| `explore` | 69 通過 / 0 失敗 |
| `measured` | 48 通過 / 0 失敗 |
| `poc03` | 95 通過 / 0 失敗 |
| `elements` | 47 通過 / 0 失敗 |
| `poc05` | 137 通過 / 0 失敗 |
| `flows` | 44 通過 / 0 失敗 |
| `poc02` | 129 通過 / 0 失敗 |
| `rsc` | 61 通過 / 0 失敗 |
| `poc04` | 143 通過 / 0 失敗 |
| `lineage` | 65 通過 / 0 失敗 |
| `sqlparse` | 77 通過 / 0 失敗 |
| `sqlimpact` | 64 通過 / 0 失敗 |
| `model` | 85 通過 / 0 失敗 |
| `project-inspect` | 126 通過 / 0 失敗 |
| `devserver` | 107 通過 / 0 失敗 |
| `devserver-stub` | 71 通過 / 0 失敗 |
| `childenv-origin`（新規） | 22 通過 / 0 失敗 |
| `preview-gateway` | 132 通過 / 0 失敗 |
| `select-unit` | 85 通過 / 0 失敗 |
| `runtime-e2e` | 55 通過 / 0 失敗 |
| `preview-e2e` | 74 通過 / 0 失敗 |
| `select-e2e` | 81 通過 / 0 失敗 |
| `observe-unit` | 88 通過 / 0 失敗 |
| `observe-e2e` | 84 通過 / 0 失敗 |
| `queries-unit` | 126 通過 / 0 失敗 |
| `lineage-live-unit`（新規） | 118 通過 / 0 失敗 |
| `queries-e2e` | 120 通過 / 0 失敗 |
| `lineage-e2e`（新規） | 83 通過 / 0 失敗 |
| **合計（29 本）** | **2492 件通過 / 0 件失敗** |

- 最終のビルド（`npm run build`）に対して、`npm test` に並ぶ 29 本を1本ずつ回した（`&&` の途中で止まらないように）。DB は使い捨ての PostgreSQL 16（`/var/tmp` に `initdb`、ポート 55432、`db/init.sql`）。
- `preview-e2e` の件数は、検査の時点で居る開発サーバーのプロセス数で変わる（PID ごとに4件）。この環境では 74〜78 件（2〜3 プロセス）で、どちらも 0 失敗。7B-3B-1 の報告の「73 / 1 失敗」は、判定を直した後は 0 失敗になった。
- 一覧の既定の修正（下）の後に画面を描く7本（`explore`・`lineage`・`runtime-e2e`・`preview-e2e`・`select-e2e`・`observe-e2e`・`queries-e2e`）と `lineage-e2e` を最終のビルドで回し直し、上の表と同じ件数で通過した。画面を描かない22本はその修正の影響を受けない（`.libjs` の変換・サーバーの層は変えていない）。
- 途中で1度、`:3100` に古いビルドの IDE が残っていたため `BASE` を使う7本（`explore` ほか）が失敗した。IDE を起動し直して同じビルドで回し直した結果が上の表である（試験・実装の変更ではない）。
- 画面の撮影で見つけて直した不具合（7B-3B-2 の変更が原因）: 新しい選択の後も、観測の一覧の既定が**前に表示した別のページの通信**のままだった。選択のたびに利用者の選び直しを捨て、既定を「この選択の文書の通信」に戻すようにした（`lineage-e2e` に1件追加。これで 83 件）。
- 回帰の途中で見つけて直した不具合（7B-3B-2 の変更が原因）: 選択の行の下に足した1行が既存の `pvsel` クラスを使っていたため、`select-e2e` の `.pvsel` の取得が2要素に当たった。**実装側のクラス名を `pvlin` に分けた**（試験は変えていない）。

`npm run typecheck` 通過。`npm run build` 成功（Turbopack の追跡範囲の警告は従来どおり 3 件）。

### 8.3 期待値を変更した既存の試験

| 試験 | 変更 | 理由 |
| --- | --- | --- |
| `preview-e2e` 第5節 | 名前の検査 → 値と出所の検査（＋直接の子は名前でも） | 第1.1節 |
| `select-e2e`「知らせのキーは決めたものだけ」 | 許すキーに `doc` を足した | select の知らせに文書の識別子を足した（16 進 32 桁の乱数。ページの内容を含まない）。他のキー・本文や値を送らない検査は変えていない |
| `select-unit`「`'*'` 宛ては hello だけ」「以後は MessagePort で送る」 | スクリプトの文字列の数え方（`postMessage(` の数 2 → 1、`port.postMessage(m)` → `pm.call(port, m)`） | 送信の関数を読み込み時に取っておく形にした（第3.5節）。**意図（window への送信は hello だけ・以後は port だけ）は同じ**で、それを新しい形で検査している |
| `queries-e2e` 第7節（2件） | 「『両者は結んでいません』の注記」→「要素を描いた文書の通信と並べ、由来は静的解析による推定で結んでいる」／右ドック（描いた位置）「同じ定義の中にあることは根拠にしていない」→「supplies・L2」 | 7B-3B-1 の時点では由来を評価していなかった。7B-3B-2 では `/rsc-db` の `<li>`（`{row.code}`）は文書の同定・静的解析・実測の呼び出し位置・SELECT 句の条件をすべて満たすので、**画面は推定で結ぶのが正しい**。「評価を持たない並べ方では結ばない」こと（同じ節の Node 側の変換の検査 — `supplies` を作らない・触れる関係は `renders` / `queries` だけ）は**期待値を変えずに残した** |

### 8.4 DB が不要な試験 / 実 DB が要る試験

| 区分 | 試験 |
| --- | --- |
| DB 不要・ブラウザ不要 | `poc01`〜`poc05`・`explore`・`measured`・`elements`・`flows`・`poc04`・`sqlparse`・`sqlimpact`・`model`・`project-inspect`・`devserver`・`devserver-stub`・**`childenv-origin`**・`preview-gateway`・`select-unit`・`observe-unit`・`queries-unit`・**`lineage-live-unit`**（記録済みの観測・模擬・手で書いた小さなプロジェクト） |
| DB 不要・ブラウザあり（IDE を起動） | `rsc`・`lineage`（`BASE` の IDE）・`runtime-e2e`・`preview-e2e`・`select-e2e`（題材は起動するが DB の結果を検査しない） |
| **実 DB が要る**（無ければ失敗にする） | `observe-e2e`・`queries-e2e`・**`lineage-e2e`** |

---

## 9. 実物 / 模擬の検証範囲

| 項目 | 環境 | 実物か |
| --- | --- | --- |
| ブラウザ・IDE・`next dev`（Turbopack）・計装・PostgreSQL 16・RSC の SQL・呼び出し位置・静的解析・文書の識別子・再読み込み・並行・停止と再起動・pushState・PID の記録 | この環境（使い捨ての PostgreSQL。合成データ） | **実物** |
| クラウドのポート転送 | 試験の中の転送役 | 模擬 |
| 同じパスの RSC の再取得（`refetched-after-document`）・SELECT 句に無い列・未実行の SQL・PID 欠損・取得が2つ／式が2つ／混在・ソースの書き換え | 模擬の観測（単体）。静的解析は本物 | **模擬** |
| 起動先の環境変数の出所 | 実物のプロセス（`childenv-origin`）と実物の `next dev`（`preview-e2e`） | 実物 |
| `next/link` によるクライアント側の遷移・webpack・Prisma・Codespaces・Windows・本番ビルド | — | **未検証** |

---

## 10. 未対応事項

1. **題材は `poc/fixture-app` の RSC 直接取得（素の `pg`）だけ。** Prisma など入口を包んでいないドライバの SQL は `queries` が無いので `supplies` も作らない（`fetch-site-unverified` / `fetch-not-measured`）
2. **ケースB の props の受け渡し（`LinBCard` / `LinBLabel`）は実物で確かめていない。** 静的解析は props を和で解くが、子のファイルで描かれた値の取得位置は親のページにあり、条件は同じ。単体・E2E の対象に入れていない
3. `next/link` による本物のクライアント側の遷移は題材に無い。`history.pushState` を直接呼んで確かめた（スクリプトが包むのは同じ関数）
4. 同じパスの RSC の再取得（`router.refresh` / HMR）の検出は「文書の後の、同じパスの `rsc: 1` の要求」で**保守的に断る**だけ。どのタブの再取得かは区別しない（別のタブの再取得でも断る）
5. ブラウザの戻る・進むで HTTP キャッシュから復元された文書は、前の応答の識別子を持つ（その応答が描いた文書なので主張は変わらないが、復元後のクライアント側の状態は見ていない）
6. 要素の直下に固定の文字と式が混在する要素（`<p>件数: {n}</p>`）は、選んだテキストがどれかを決めず結ばない。テキストノードの索引と JSX の子の対応づけは作っていない
7. 解析したソースが文書の取得の後に**どこか1つでも**書き換わると結ばない（保守的。対象を経路のファイルに絞っていない）
8. 静的解析は対象プロジェクトの `src/` 全体を初回に読む（題材で約 2〜3 秒）。大きなプロジェクトでの時間は測っていない
9. 文書の識別子はアプリのコードが偽れる（第3.5節）
10. キャンバスの配置: コンポーネントは2つまで・SQL は2本まで（7B-3B-1 のまま）。由来を結んだ SQL を先頭に置いて必ず描くようにしたが、それ以外の SQL・位置は詳細に回る
11. 右ドックの行で `**…**` が記号のまま出る（7B-3B-1 以前からの表示。変えていない）

---

## 11. Phase 7C へ向けて残る課題

| # | 課題 |
| --- | --- |
| 1 | **client-fetch の G1 / G2**（MVP の主経路）。今回の `supplies` は rsc-direct だけ |
| 2 | 受入テストの題材を**利用者の実在プロジェクト**にする（今回も題材は PoC の fixture）。Prisma の入口の計装をするか、断定しないまま受け入れるかの判断 |
| 3 | PoC-04 の母数（20 箇所）の拡大と、確度ラベルを導入しないままの表示で利用者が誤読しないかの確認 |
| 4 | 文書の同定の偽装耐性（必要なら、スクリプトではなく中継側で DOM を読まない形の別の照合を検討） |
| 5 | テキストノードと JSX の子の対応（混在要素）、`ComponentInstance`（どの行の値か） |
| 6 | 大きなプロジェクトでの静的解析の時間と、ソースの書き換え判定の粒度 |
| 7 | 実物の Codespaces・webpack での確認（7B-1 から継続） |

---

*本書は Phase 7B-3B-2 の実施報告である。7B-3B-2 の完了時点で止めている。*
