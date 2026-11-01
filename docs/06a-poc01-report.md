# PoC-01 実施報告 — 計装経路の成立確認と UI データモデルへの変換

| 項目 | 内容 |
| --- | --- |
| フェーズ | Phase 6A（PoC-01 の実施） |
| 実施日 | 2026-10-31 |
| 計画 | `docs/05c-poc-plan.md` |
| 判定 | **成功**（判定基準7項目すべてが「成功」の範囲。根拠は第8章） |
| 成果物 | `poc/`（検証環境）/ `src/lib/{model,observation,adapter,layout,synthetic}.ts`（層の分離）/ `src/data/observation.measured.ts`（観測結果）/ `poc/out/*.json`（計測記録） |

> 本書は実施記録である。**観測できなかったものは第3章に列挙してある。**
> 画面に出ている値のうち、観測していないものは一つも無い。

---

## 1. 採用した計装方式

### 1.1 結論

| 層 | 採用したもの | 02d の取得手段 | 結果 |
| --- | --- | --- | --- |
| 初期化 | **方式2（`NODE_OPTIONS=--require`）を主、方式1（`instrumentation.ts`）を副** | — | **両方とも機能した** |
| HTTP（サーバー側） | Next.js 内蔵トレーサ + `@opentelemetry/instrumentation-http` | `trace-span` | 取れた |
| HTTP（ブラウザ側） | CDP のネットワーク記録 | `browser-network` | 取れた |
| ブラウザ↔サーバー | **応答の `Server-Timing: traceparent` にトレースIDを載せ返す** | `trace-context` | 取れた（第1.3節） |
| SQL（ORM） | `@prisma/instrumentation` | `orm-instrumentation` | 取れた |
| SQL（素のドライバ） | `@opentelemetry/instrumentation-pg` | `orm-instrumentation` | 取れた |
| SQL の対象 | `node-sql-parser` による実測SQLの構文解析 | `sql-ast-parse` | 取れた |
| DBオブジェクトの定義 | `information_schema` / `pg_class` への照会 | `db-introspection` | 取れた |
| 代替（計装なし） | PostgreSQL ワイヤプロトコルのローカルプロキシ | — | 成立した（第6章） |

### 1.2 実装上わかった4つの制約 — いずれも計画に無かった

| # | 事象 | 実測 | 対処 |
| --- | --- | --- | --- |
| **F-1** | **webpack は `instrumentation.ts` をプロジェクトルートでは見つけない** | `src/` ディレクトリがある構成では `src/instrumentation.ts` に置かないと `register()` が呼ばれない。Turbopack はルートでも拾う | IDE が生成する位置は `src/` の有無で決める必要がある |
| **F-2** | **計装モジュールをバンドラに追跡させてはいけない** | webpack は計装の依存を辿り、`node:fs` を `UnhandledSchemeError`、`http` を `Module not found` で落とす。`node:` 接頭辞を外しても `http` は解決できない | `instrumentation.ts` から**実行時の素の `require`** で読む（`eval('require')`）。計装はバンドルの外に置く。これは `UR-02`（バンドル後のコードに ORM 計装がフックできるか）への答えでもある — **フックすべき `require` をバンドルの外に出せば、両バンドラで確実に効く** |
| **F-3** | **`NODE_OPTIONS` は空白で分割される** | パスに空白を含むと `Cannot find module '/Users/mizuki/Visiual'` で起動しない | 二重引用符で囲む。IDE がプロジェクトパスを組み立てる際の必須事項 |
| **F-4** | **Next.js 16 は別オリジンからの開発リクエストを遮断する** | `127.0.0.1` で開くとクライアント側の水和が走らず、`fetch` が一切発生しない（`localhost` なら正常）。計装の問題ではなく、観測対象が動かない | プレビューのオリジンを dev server と一致させる。IDE のプレビュー実装に直接効く |

> F-2 は `01b` C-4（バンドラが `require` を消す）への具体的な回答である。
> **「計装をバンドルさせない」という形にすれば、Turbopack と webpack の差は消える。**

### 1.3 ブラウザとサーバーの関連付け — アプリコードに触れずに成立した

計画では `handles`（③→④）を `trace-context`（L1）としていたが、ブラウザ側に計装を入れずに
どうトレースIDを渡すかは未定義だった。本PoCでは次の形で解決した。

1. HTTP 計装の `responseHook` で `ServerResponse` とスパンコンテキストを対応づける
2. `ServerResponse.prototype.writeHead` を包み、応答に
   `Server-Timing: traceparent;desc="00-<traceId>-<spanId>-01"` を付ける
3. ブラウザ側はこのヘッダ**1つだけ**を読む（ヘッダ一覧も本文も読まない）

これは計装モジュールの中だけで完結し、**アプリのコードにも設定にも触れていない**
（`01b` Q-01.0 の解釈 (a) 非改変を満たす）。
結果、ブラウザの通信記録6件すべてでサーバー側のトレースIDを受け取れた（**100%**）。

---

## 2. 実際に取得できた情報

### 2.1 計装マトリクス（`poc/out/measurements.json`）

ページ3枚の読み込み + API3本を10回ずつ、の計測を4通りで行った。

| 計測 | 方式1 × Turbopack | 方式1 × webpack | 方式2 × Turbopack | 方式2 × webpack |
| --- | --- | --- | --- | --- |
| 取得スパン総数 | 821 | 824 | 868 | 871 |
| **SQLスパン** | **56** | **56** | **56** | **56** |
| 内訳（Prisma / pg） | 45 / 11 | 45 / 11 | 45 / 11 | 45 / 11 |
| **SQL取得率**（DBログ基準 56件） | **100%** | **100%** | **100%** | **100%** |
| HTTPサーバースパン | 37 | 37 | 74 | 74 |
| **SQL→HTTP の親子紐付け** | **56 / 56** | **56 / 56** | **56 / 56** | **56 / 56** |
| ブラウザ通信（トレースID取得） | **6 / 6** | **6 / 6** | **6 / 6** | **6 / 6** |
| スパンを出したプロセス数 | 1 | 1 | **4** | **4** |
| 起動（この回） | 1331ms | 3246ms | 1473ms | 3174ms |

- **SQL取得率の分母は PostgreSQL 自身のログ**（方式4）である。計装とは独立した基準で、
  アプリが実際に発行した DML を数えている。コードから数えた期待値は55件で、差の1件は
  Prisma が接続確立時に出す probe（`SELECT 1`）だった。**DBログ基準で 56/56 = 100%**。
- 方式2 では `@opentelemetry/instrumentation-http` が `node:http` を先にフックできるため、
  HTTP サーバースパンが Next.js 内蔵のものと二重に出る（37 → 74）。実害は無く、
  変換側は Next.js のルートハンドラスパンを採っている。

### 2.2 UR-03（dev server のワーカーへ `NODE_OPTIONS` が伝播するか）— 伝播する

方式2 では**4つのプロセス**がスパンを出し、**6つのプロセス**が計装の初期化を記録した。
`npx` → `next` CLI → dev server → ワーカーの連鎖で環境変数が継承されている。
方式1 では1プロセスのみ（`register()` はサーバーインスタンスでしか呼ばれないため）。

→ **UR-03 は解消。方式2 は機能する。**

### 2.3 UR-04（性能影響）— 要件 INS-04 を満たす

各構成10回、Turbopack、中央値。

| 構成 | 起動（中央値） | 対 計装なし | API 遅延（中央値） | 対 計装なし |
| --- | --- | --- | --- | --- |
| 計装なし | 1186 ms | — | 7.66 ms | — |
| **方式1** | 1192.5 ms | **+0.5%** | 8.04 ms | **+0.38 ms** |
| **方式2** | 1416.5 ms | **+19.4%** | 9.93 ms | **+2.27 ms** |

INS-04（起動 +20%以内 / 遅延 +10ms以内）を**両方式とも満たす**。
方式2 の起動増は、計装モジュールが**全ての** Node プロセスで読み込まれるためである。

### 2.4 ひとつの経路から取れた実測（`poc/out/observation.json`）

`/listings` を1回開いたときの記録。計装は方式2（プロジェクトに計装用ファイルを
置かない状態で実行した — 第5章）。

| 取れたもの | 値 | 取得手段 |
| --- | --- | --- |
| ブラウザの通信 | `GET /listings` 200 / 28.52ms、`GET /api/listings` 200 / 10.01ms | `browser-network` |
| サーバー側トレースID | 2件とも取得（`Server-Timing`） | `trace-context` |
| スパン | 同一トレース内に22本 | `trace-span` |
| サーバー処理 | `executing api route (app) /api/listings` / 4ms | `trace-span` |
| 実行SQL | 下記 / 2.6ms | `orm-instrumentation`（Prisma） |
| 参照テーブル | `poc.listings`（行数推定 12） | `sql-ast-parse` + `db-introspection` |
| 射影カラム | `id (integer)` / `code (text)` / `region (text)` | `sql-ast-parse` + `db-introspection` |
| スパンの開始・終了 | ページ読み込みを 0 とした相対ms で全スパン分 | `trace-span` |

### 2.5 時刻について判明したこと — 親子は時刻で判定してはいけない

**Next.js 内蔵トレーサはスパンの開始時刻をミリ秒単位に丸めて出す**（実測で全22本の
Next.js スパンの開始時刻が整数ミリ秒）。Prisma と OTel HTTP 計装はミリ秒未満まで持つ。
結果、**計装をまたぐと「親の区間が子の区間を含む」が成立しないことがある**
（実測：またぐ親子2組とも不成立。同じ計装内では19組中18組が成立）。

→ 親子関係は `parentSpanId` で決める。時間窓は使わない。
これは「時間窓推定なら L2 へ降格」（`02d` / `01b` Q-01.4）という設計判断の、実測による裏づけである。
回帰テストにこの事実を固定してある（`tests/poc01.spec.mjs`）。

---

## 3. 取得できなかった情報

**ここに挙げたものは、画面にも変換結果にも存在しない。** 代わりの値で埋めていない。

| # | 取れなかったもの | 理由 | 画面での扱い |
| --- | --- | --- | --- |
| 1 | 表示された値（`RenderedValue`） | ブラウザDOMの読み取りは PoC-01 の範囲外（PoC-03） | ノードを作らない。③の上流を**切断マーカー**で止める |
| 2 | コンポーネント定義との対応（`ComponentDef` / `renders`） | 要素識別子の注入は PoC-03 の範囲 | 同上 |
| 3 | `derives`（応答の項目 → props） | ①②が無いため始点が存在しない | ホップを作らない |
| 4 | **`maps`（カラム → 応答項目）** | 確認にはレスポンス本文の読み取りが必要で、**収集禁止項目にあたる**ため行わなかった | ホップを作らない。計画の「部分的」は**未達**として報告する |
| 5 | SQL の取得件数（行数） | 使用した計装が行数属性を付けない | 概要に「計装から取得できていません」と書く。数値を入れない |
| 6 | SQL のパラメータ値 | 方針として収集しない（NFR-20） | 「収集しません（数値2件を取得時点で除去）」と書く |
| 7 | RSC / Server Component の直読み経路 | PoC-02 の範囲。本PoCは Client Component + API ルートに限定 | 対象にしていない。**実在しない API ノードは作っていない** |
| 8 | 静的資材の通信16件 | 「通信」として数えない方針 | 件数を俯瞰に明記し、黙って落とさない |

> **4 は計画からの後退である。** `05c` 2章は `maps` を「部分的に取れる」としていたが、
> Prisma のスキーマ定義と応答の対応を確かめるにはレスポンス本文を読む必要があり、
> 第5章の収集禁止と両立しない。本PoCでは**取らない**を選んだ。PoC-04 で扱う。

---

## 4. 計測結果のサンプル（機密値を除く）

### 4.1 取得したスパン（抜粋・実データ）

```
GET                                  @opentelemetry/instrumentation-http  [root]
└ NextServer.getRequestHandler       next.js
  └ NextServer.getServerRequestHandler
    └ GET                            next.js  http.method=GET
      │                                       http.target=/api/listings
      │                                       http.status_code=200
      │                                       http.route=/api/listings
      └ BaseServer.render
        └ BaseServer.pipe
          └ rendering page
            └ BaseServer.renderToResponseWithComponents
              └ executing api route (app) /api/listings   next.route=/api/listings   4ms
                └ prisma:client:operation   method=findMany  model=Listing
                  └ prisma:engine:query
                    └ prisma:engine:db_query   db.system=postgresql             2.6ms
                         db.query.text=SELECT "poc"."listings"."id",
                           "poc"."listings"."code", "poc"."listings"."region"
                           FROM "poc"."listings" WHERE $0=$0
                           ORDER BY "poc"."listings"."id" ASC LIMIT $1 OFFSET $2
```

`$0` は**取得時点で除去したリテラル**の跡である（文字列0件・数値2件）。
`$1` / `$2` は元から placeholders。文は構文解析に掛けられる形を保っている。

### 4.2 構文解析の結果

```json
{
  "parseOk": true,
  "tables": [{ "schema": "poc", "name": "listings" }],
  "projections": [
    { "schema": "poc", "table": "listings", "column": "id" },
    { "schema": "poc", "table": "listings", "column": "code" },
    { "schema": "poc", "table": "listings", "column": "region" }
  ],
  "unresolved": [],
  "selectStar": false
}
```

### 4.3 値を読まずに捨てた属性キー（`droppedAttributeKeys`）

```
http.flavor, http.host, http.scheme, http.status_text, http.url, http.user_agent,
net.host.ip, net.host.name, net.host.port, net.peer.ip, net.peer.port, net.transport,
next.span_category, next.span_name
```

マトリクスの実行全体では、これに加えて `db.connection_string` / `db.user` /
`db.postgresql.idle.timeout.millis` も落としている。
**キー名は記録し、値は一度も読んでいない。**

---

## 5. 収集禁止項目の扱い

> 設計方針: **集めてから消すのではなく、集めない。**（`poc/fixture-app/ide-instrumentation/mask.cjs`）

| 対象 | 仕組み | 検証 |
| --- | --- | --- |
| SQLのパラメータ値 | 文字列リテラルと数値リテラルを `$0` へ置換してからスパンに載せる。`enhancedDatabaseReporting` は既定の false のまま（true にすると `db.statement.parameters` が付く） | `tests/poc01.spec.mjs`「SQL 文に文字列リテラルが残っていない」 |
| 接続文字列 | 属性キーの許可リストに無いので値を読まずに捨てる。さらに値側も `postgres://` 等のパターンで再チェック | 「接続文字列 を含まない」「DBのパスワード を含まない」 |
| Cookie / Authorization / トークン | キー名の正規表現で先に落とす。ブラウザ側はヘッダ一覧を取らず `Server-Timing` 1つだけを読む | 「Cookie / Authorizationヘッダ / アクセストークン を含まない」 |
| リクエスト・レスポンス本文 | 観測結果のスキーマに**入れる場所が無い** | 「リクエスト／レスポンスの本文を持つ場所が無い」 |
| DBから返った行データ | 同上。情報スキーマから読むのは定義と行数推定だけ | 「DBから返った行データを持っていない」 |
| 個人情報 | 検証データが完全な合成（架空の地名と連番のみ）。氏名・住所・連絡先・決済情報を含むカラムが存在しない | `poc/fixture-app/db/init.sql` |
| DB側のログ | `log_parameter_max_length=0` でパラメータ値の出力自体を止めている | `show log_parameter_max_length` = 0 |

さらに、観測結果 JSON を書き出す直前に禁止パターンを走査し、1つでも当たれば**書き出しを中止する**
（`poc/runner/build-observation.mjs`）。

### 非追加(b) の確認

`build-observation.mjs` は方式2 の計測中、`src/instrumentation.ts` を一時退避させる。
**プロジェクトに計装用のファイルが1つも無い状態**で、本報告の観測結果を取得した。

---

## 6. 代替2（方式5 DBプロキシ）の成立確認 — 手順4

アプリにもライブラリにも計装を入れず、`DATABASE_URL` をローカルプロキシへ向けた。

| 計測 | 結果 |
| --- | --- |
| 接続数 | 3 |
| Execute メッセージ | 49 |
| Simple Query メッセージ | 27 |
| **実行回数 ÷ DBログの DML** | **76 / 76 = 100%** |
| 文の**種類**の取得率 | 8 / 24 = 33% |
| パラメータ値 | **読んでいない**（Bind メッセージを解釈しない） |
| **HTTPリクエストとの対応付け** | **不可能** |

- **SQL の実行は漏れなく観測できる。** 一方 Prisma はプリペアドステートメントを使うため、
  同じ文の2回目以降は `Parse` を送らない。文字列としての「種類」の取得率が低いのは
  取りこぼしではなくプロトコルの性質である。
- **どの HTTP リクエストが発行したかは分からない。** 接続プールが複数リクエストで
  使い回されるため、接続IDでも一意にならない。→ `time-window`（L2）へ降格する。
  `01b` C-6 の推定が実測で裏づけられた。
- 実装上の注意: SSLRequest は起動パケットと同じ形で届く。これを読み違えるとメッセージ境界が
  ずれ、**Prisma の通信をまるごと取り落とす**（実装中に実際に起きた）。

→ **代替2 は成立する。ただし `handles` / `executes` が L2 に落ちる。**
本PoCでは計装が成功したので、代替2 を採用する必要は無い。

---

## 7. 共通モデルへの変換方法

### 7.1 層の分離（`05c` 5.3節）

変換前は `src/lib/trace.ts` に合成データと図の座標が同居していた。4層に分けた。

```
層1 入力    src/lib/synthetic.ts            合成シナリオ（座標も観測性も持たない）
            src/data/observation.measured.ts 観測結果（自動生成・型検査付き）
              ↓
層2 変換    src/lib/adapter.ts              純粋な変換。UI を知らない。座標を作らない
            src/lib/model.ts                共通オブジェクトモデル（02a）
              ↓
層3 座標    src/lib/layout.ts               ここだけが幾何を知る
              ↓
層4 描画    src/components/                 合成と実測で**同じ部品**
```

`src/lib/trace.ts` は3つを繋ぐだけになった。描画部品はモジュール定数を読まず、
データセットを文脈から受け取る。**同じ `<FlowScene>` / `<StepList>` / `<EvidencePanel>` が
合成でも実測でも動く**ことを `tests/measured.spec.mjs` で確認している。

### 7.2 対応表（実装したもの）

| 観測した記録 | 変換先 | 取得手段 | 観測性 |
| --- | --- | --- | --- |
| ブラウザのネットワーク記録 | `TraceNode{kind:'http'}` | `browser-network` | 実測 |
| ルートハンドラのスパン | `TraceNode{kind:'server'}` | `trace-span` | 実測 |
| SQL文を持つスパン | `TraceNode{kind:'sql'}` | `orm-instrumentation` | 実測 |
| SQL の FROM 句 + 情報スキーマ | `TraceNode{kind:'table'}` | `db-introspection` | 実測 |
| SQL の SELECT 句 + 情報スキーマ | `TraceNode{kind:'column'}` | `sql-ast-parse` | 実測 |
| 応答のトレースID の一致 | `TraceHop{relation:'handles'}` | `trace-context` | 実測 |
| スパンの親子（祖先の連鎖を含む） | `TraceHop{relation:'executes'}` | `trace-span` | 実測 |
| 構文解析 | `reads` / `projects` | `sql-ast-parse` | 実測 |

### 7.3 観測性を「導出」にした — 表示の都合で格上げできない形にした

`observability` はデータに**書けない**。`model.ts` の `observabilityOf(source)` だけが決める。

```ts
export function observabilityOf(source: SourceId): Observability {
  const lv = SOURCE_LEVEL[source];
  return lv === 'L0' || lv === 'L1' || lv === 'L1-equivalent' ? 'measured' : 'estimated';
}
export const node = (n: ModelNodeInput): ModelNode =>
  ({ ...n, observability: observabilityOf(n.source) });
```

`ModelNodeInput` に `observability` が無く、`node()` / `hop()` 以外にノードの作り方が無い。
`static-analysis` と `orm-schema-map`（= `derives` と `maps`。`02a` 3.5.1 により
構造的に L2 から上がれない）は、**いかなる経路でも実測にならない**。
取得手段の識別子はモデルに保持する（較正 PoC-04 に後から必要で、後付けできないため — `02d` 7章）。

### 7.4 変換で守った規約（`05c` 5.2節）

| # | 規約 | 実装 |
| --- | --- | --- |
| 1 | `projects` の始点は `SqlStatement`。テーブル→カラムの辺を作らない | テストで固定 |
| 2 | 観測できなかった区間を省略しない | ③の上流に切断マーカーを生成 |
| 3 | ステップバッジを持たせない | モデルにフィールドが無い。表示順から再計算 |
| 4 | 件数・経路の観測性・最弱環を持たせない | `derive.ts` が経路から算出 |
| 5 | スパンの開始時刻を保持する | `span: {startMs, endMs}`（ページ読み込みを0とした相対ms） |
| 6 | 座標は変換の対象外 | `adapter.ts` に座標の概念が無い |

加えて **「情報スキーマに実在しない列のノードは作らない」**。解析が修飾を一意に決められなかった
射影は `skipped` に落とし、ノードにしない。

### 7.5 導出の訂正を1件行った

`summarizePage()` の「表示中の経路」は、以前は**詳細を持っている経路の数**を数えていた。
実測では描いていない経路も詳細を持つため、この数え方では「2 / 2 と出ているのに1本しか描かれない」
になる。**「全体を描いている経路の数（＝つねに1）」**へ改めた。合成データでの表示は
`1 / 2（他 1 件は詳細が未取得）` のまま変わらない。

同じ理由で、経路外の通信も**区間を観測できていれば**計測時間に算入するようにした。
観測しているのに「計測できていない」と数えると画面が嘘をつくためである。

---

## 8. キャンバス表示と、最小シナリオの通し確認

`docs/06a-screenshots/` に保存した。

| 画像 | 内容 |
| --- | --- |
| `measured-stage0.png` | 実測データの俯瞰（段階0）。通信2件 / SQL1件 / 48ms / 追跡できない箇所1件 |
| `measured-sql-selected.png` | 実行SQLを選択（段階2）。番号付きリストと概要 |
| `measured-evidence.png` | 根拠タブ。観測性・取得手段・時間窓・根拠2件 |
| `stage0.png` / `stage2.png` | 合成データ（従来どおり壊れていない） |

計画 8章の流れが実際に通った。

1. 検証用 Next.js アプリを起動（方式2・Turbopack・計装用ファイル無し）
2. ブラウザで `/listings` を開く
3. サーバー側で Prisma が SQL を実行
4. 計装がスパンを出し、マスキングしてローカルに書き出す
5. `adapter.ts` が共通オブジェクトモデルへ変換（7ノード / 6ホップ）
6. `http://localhost:3100/?data=measured` でキャンバスに表示
7. ノードを選択
8. 右詳細パネルで実測の証拠を確認（取得手段 `ORM計装のスパン属性`、
   根拠「計装 prisma のスパン属性」「ハンドラスパンからの親子の連鎖（3段）」、
   時間窓「読み込み開始から 183ms — 2.6ms 間」）

画面に出ている上流の切断は **「ここより上流は観測していません / 表示された値とコンポーネント」**。
合成データで埋めていない。

---

## 9. テスト結果

```
npm test
  ✓ tests/poc01.spec.mjs     56 件通過 / 0 件失敗   観測結果と変換の検証
  ✓ tests/explore.spec.mjs   69 件通過 / 0 件失敗   既存（合成データ）— 維持
  ✓ tests/measured.spec.mjs  48 件通過 / 0 件失敗   実測データのキャンバス表示

npm run typecheck   通過
npm run build       通過（Route: / , /_not-found , /icon.svg）
```

**既存の69件は1件も変えずに維持している。**

| 指示された検証項目 | 対応するテスト |
| --- | --- |
| 計測情報を取得できる | poc01「1. 実際の計装から情報を取得できている」10件 |
| 時刻と親子関係が正しく扱われる | poc01「2. 時刻と親子関係」13件 |
| 実測と推定が区別される | poc01「3. 実測と推定の区別」7件 |
| 未取得情報を捏造しない | poc01「4. 未取得の情報を捏造しない」12件 |
| 機密値が収集されない | poc01「5. 収集禁止項目」14件 |
| 合成データ表示が壊れていない | explore 69件 + measured「5. 合成データ側は壊れていない」 |
| 実測データをキャンバスに表示できる | measured「1.」「2.」22件 |
| ノード選択で正しい詳細が表示される | measured「3.」「4.」20件 |

---

## 10. 判定

`05c` 8章の基準に照らす。

| 基準 | 成功の条件 | 実測 | 判定 |
| --- | --- | --- | --- |
| SQL取得率 | 95%以上 | **100%**（56/56・DBログ基準・4構成すべて） | **成功** |
| HTTP取得率 | 99%以上 | **100%**（6/6 でトレースIDまで取得） | **成功** |
| 親子関係 | SQLスパンが HTTPスパンの子として紐付く | **56/56**（L1 成立。時間窓推定を一切使っていない） | **成功** |
| 非追加(b) | 方式2が機能する | **機能した**（4プロセスへ伝播。計装用ファイル無しで観測を取得） | **成功** |
| バンドラ | Turbopack / webpack 双方 | **双方で同一の結果**（F-1・F-2 の対処が前提） | **成功** |
| 性能 | 起動 +20%以内 / 遅延 +10ms以内 | 方式1 +0.5% / +0.38ms、方式2 +19.4% / +2.27ms | **成功** |
| 変換 | ③〜⑦ と h3〜h6 が機械的に構成でき、合成と同じ構造で描ける | **構成できた**。手で補った箇所は無い | **成功** |
| 分離 | 全要素に `source` が付き、推定が実測に混ざらない | **全13要素（7ノード + 6ホップ）に付いた**。観測性は導出のみ | **成功** |

### **判定: 成功**

8項目すべてが成功の範囲にある。縮退（`01b` Q-01.5 の代替1〜4）は**不要**である。

ただし、成功の範囲を正確に書いておく。

- **検証したのは Next.js 16 + Prisma 6 + 素の `pg` + PostgreSQL 16 の1構成だけ**である。
  他のフレームワーク・ORM・バージョンは未検証であり、この結果は外挿できない。
- **`maps`（⑦→③）は取れていない**（第3章 #4）。`05c` 2章の「部分的」は未達である。
- **上流（①②・`renders`・`derives`）は範囲外**であり、本PoCは経路14要素のうち
  **7要素（③④⑤⑥⑦ と h3〜h6）**を埋めたにとどまる。
- 性能は**開発サーバー**の測定である。本番ビルドでの影響は測っていない。

### UR の更新

| ID | 内容 | 状態 |
| --- | --- | --- |
| **UR-01** | Turbopack 環境での自動計装の挙動 | **解消**。F-1・F-2 の対処があれば webpack と同一の結果 |
| **UR-02** | バンドル後のコードに ORM 計装がフックできるか | **解消**。計装をバンドルの外へ出せば両バンドラで確実にフックできる |
| **UR-03** | dev server のワーカーへ `NODE_OPTIONS` が伝播するか | **解消**。伝播する（4プロセス） |
| **UR-04** | 性能影響 | **解消**。INS-04 を満たす（開発サーバーに限る） |

---

## 11. 次のPoCへ進むための課題

| # | 課題 | 次に効くPoC |
| --- | --- | --- |
| 1 | **`maps` を収集禁止と両立する方法が無い。** 応答本文を読まずにカラムと応答項目を対応づけるには、ORMのスキーマ定義と結果セットの**列構成**（値ではなく形）を突き合わせる設計が要る | PoC-04 |
| 2 | **①②（表示された値・コンポーネント）が空いたまま**で、経路の上端が切断で止まっている。要素識別子の注入が成立しないと、製品の価値提案の中心が埋まらない | **PoC-03（次の優先）** |
| 3 | **RSC では API ノードが存在しない。** 本PoCは Client Component + API ルートに限定した。`rsc-direct` の経路種別（`02a` 3.5.2）は未検証 | PoC-02 |
| 4 | **ページスコープの採番規約が未確定。** 開始時刻は取れるようになった（`span.startMs`）が、採番対象が「スパンだけ」か「俯瞰の全ノード」かは `05c` 7章のまま未決。実測ではテーブル・カラムが時刻を持たないため、この判断なしに番号を出せない | UI側の決定 |
| 5 | **複数経路の同時表示が未設計。** 実測では1ページに複数の通信があり、いずれも詳細を持つ。現在の「1経路を描き、残りは減光」では「詳細を持つのに描かれない経路」を表現しきれない | UI側の設計 |
| 6 | **計装の二重登録の扱い。** 方式2 では6プロセスが初期化を試みる。いまはプロセス内の多重登録だけを防いでいる。スパンの重複排除（HTTP サーバースパンが37→74）は変換側で吸収しているが、仕様として明文化していない | 実装時 |
| 7 | **プレビューのオリジン**（F-4）。IDE のプレビューが dev server と違うオリジンで開くと、対象アプリが水和せず**何も観測できない**。プレビュー実装の前提条件になる | 実装時 |
| 8 | **行数（`rows`）の取得手段**が無い。計装に `responseHook` を足せば取れる可能性があるが、行データに触れずに件数だけを取る設計の確認が要る | 実装時 |

---

*本書は Phase 6A（PoC-01）の実施報告である。PoC-02 以降は未着手。*
