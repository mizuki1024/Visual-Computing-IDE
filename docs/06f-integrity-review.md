# Phase 6F 実施報告 — PoC成果の整合性修正と MVP 開発への移行準備

| | |
| --- | --- |
| 対象 | PoC-01 / 02 / 03 / 04 / 05 の成果物と、それらが共有する SQL 解析の共通実装 |
| 実施日 | 2026-11-01 |
| 新しい UI デザイン | **作っていない** |
| IDE の全機能の実装 | **着手していない** |
| 既存の観測記録（`src/data/observation.*.ts`） | **1バイトも書き換えていない** |

### 関連文書

`01b-feasibility-review.md`（Q-04）/ `02a-object-model.md`（3.5節）/
`02d-observability-information-model.md`（1.3節）/
`06a-poc01-report.md` / `06b-poc03-report.md` / `06c-poc05-report.md` /
`06d-poc02-report.md` / `06e-poc04-report.md`

---

## 0. 最初に確認した資料と、確認できなかったこと

### 0.1 読んだもの

| 資料 | この報告で使った内容 |
| --- | --- |
| `01b` Q-04.0〜Q-04.5 | 画面の値 → DBカラムが**原理的に L2** であること。C-1（`SELECT *`）・C-2（別名）・C-6（JOIN・集計・副問い合わせ）・C-7（動的SQL）。代替1（テーブル粒度への縮退） |
| `02a` 3.5.1 | `reads` = `SqlStatement → DbTable`、**`projects` = `SqlStatement → DbColumn`（SELECT句の列挙）**。`derives` と `maps` は構造的に L2 から昇格しない |
| `02a` 3.5.2 / 3.5.3 | 経路種別ごとのホップ構成。分岐・合流・複数候補の表現 |
| `02d` 1.3 / 2章 | `sql-ast-parse` が「L1相当」である根拠。**`projects` の始点は `SqlStatement` であって `DbTable` ではない**（⑥→⑦ の線を描いてはならない） |
| `src/lib/model.ts` | 観測性は `observabilityOf(source)` だけが決める。`SourceId` に `request-initiator` / `server-call-stack` が**未承認のまま**入っている |
| `src/lib/adapter.ts` | `projects` ホップと ⑦ カラムノードの生成箇所（2か所: `fromObservation` / `fromRscObservation`） |
| SQL 解析の共通実装 | `poc/runner/lib/sqlparse.mjs`（`analyzeSql`）と、**PoC-04 が別に持っていた** `poc/runner/lib/lineage.mjs` の `selectList()` |
| 既存テスト | `tests/*.spec.mjs` 11本・**894件**（実行して確認。修正前の時点で全件通過） |

### 0.2 推測していないこと

- 存在しないファイル・存在しない決定事項は本書に書いていない。
- **未承認の関係種別・取得手段を正式仕様へ昇格させていない。** 第4章はすべて「提案」であり、`02a` / `02d` は変更していない。
- 既存の観測記録を作り直していない（DB・題材アプリを再び走らせていない）。第3章は**記録を読んで比べた結果**である。

---

## 1. SQL の射影解析の修正

### 1.1 仕様の確認 — `reads` と `projects` が意味するもの

`02a` 3.5.1節の定義：

| 関係種別 | from → to | 既定レベル | 根拠 |
| --- | --- | --- | --- |
| `reads` | `SqlStatement` → `DbTable` | L1相当 | 実測SQLの決定的な構文解析 |
| `projects` | `SqlStatement` → `DbColumn` | L1相当 / L2 | **SELECT句の列挙** |

つまり **`projects` の定義域は「結果列」である。** WHERE・JOIN ON・ORDER BY・GROUP BY・HAVING
で参照された列は、その SQL が**読んではいる**が、**結果の行には現れない**。
これを `projects` にすると、⑦ カラムのノードが「この行にこの列がある」と嘘をつく。

### 1.2 不具合の原因

`sqlparse.mjs` は node-sql-parser の `columnList` を射影の材料にしていた。
`columnList` は **「文中のどこかで参照された列」の平らな一覧**であり、句の役割を区別しない。

```
SELECT code, region FROM poc.listings ORDER BY id
  → columnList = ["select::null::code", "select::null::region", "select::null::id"]
                                                                 ^^^^^^^^^^^^^^^^^ 結果列ではない
```

### 1.3 見つかった不具合（**報告済みの1件に加えて6件**）

`06e` 5.3節 #1 が報告していたのは D1 だけである。修正にあたって実装を読み直したところ、
**同じ原因から派生する不具合があと6件あった。**

| # | 入力 | 旧実装の出力 | 何が起きるか |
| --- | --- | --- | --- |
| **D1** | `SELECT code, region FROM poc.listings ORDER BY id` | 射影に `id` が入る | **行に存在しない列**がノードとして描かれる（既報） |
| **D2** | `SELECT * FROM poc.listings` | `selectStar: false`、射影に **`(.*)` という名前の列** | `SELECT *` を `SELECT *` と認識できていない。さらに**実在しない列名を作る** |
| **D3** | `SELECT "poc"."listings".* FROM "poc"."listings"` | 「表 `poc` の列 `listings`」という項目を作る | `columnList` に混ざる表エントリを列として読んでいる。**完全な捏造** |
| **D4** | `SELECT l.code, r.name FROM a l JOIN b r ON …` | **射影が0件**になり、SELECT句の実在する列まで全部 `unresolved` | 結合を使う経路では **⑦ カラムが1つも出ない** |
| **D5** | `UPDATE poc.listings SET code=$1 WHERE id=$2` | 射影に `code, id, code`（**重複つき**） | RETURNING の無い UPDATE に結果列は無い。書き込み先と WHERE を結果列にしている |
| **D6** | `SELECT max(id) FROM poc.listings` | 射影に `id` | 結果列は `max` であって `id` ではない。集計の**入力**を結果列にしている |
| **D7** | `SELECT code FROM t WHERE id IN (SELECT id FROM u)` | 副問い合わせの `id` が外側に漏れ、かつ表が2つになるため `code` も失う | 入れ子の文の結果列を外側の結果列と混ぜている |

さらに、表示側にも1件あった。

| # | 箇所 | 内容 |
| --- | --- | --- |
| **D8** | `adapter.ts` の `skipped` 生成（2か所） | 理由コードが `select-star-or-empty` 以外のとき、**すべて**「修飾が一意に決まらず、どのテーブルの列か特定できなかった」と書いていた。PoC-04 が記録した `referenced-outside-select-list` にもこの文が当たっていた。**観測できなかった理由を間違えて説明するのは、隠すのと同じ害がある**（OBS-05） |

### 1.4 修正の内容

**`poc/runner/lib/sqlparse.mjs` を AST ベースに書き直した。** `columnList` は使わない。

| 返り値 | 内容 |
| --- | --- |
| `projections` | **SELECT 句（および RETURNING 句）の結果列**のうち、`{schema, table, column}` まで解けたものだけ。`projects` ホップと ⑦ ノードの唯一の材料 |
| `selectItems` | 結果列の構造。**別名（AS）が鍵、由来の列はその下**。集計・式は `column: null` |
| `references` | **結果列でない参照を、役割つきで保持する**。`select` / `select-expr` / `where` / `join` / `order-by` / `group-by` / `having` / `insert-target` / `update-target` / `nested-select` |
| `unresolved` | **結果列なのに解決できなかったもの**だけ。理由コードを7種に細分（下表） |
| `selectStar` | SELECT 句に `*` / `t.*` があるか。**`count(*)` では立たない** |
| `statementType` | `select` / `insert` / `update` / `delete`。**「結果列が無い」と「結果列を解けなかった」を区別するために要る** |
| `setOperation` | UNION 等。1つの結果列が複数の表に由来しうることの記録 |

区別の実装：

| 句 | 読む場所 | 役割 | `projects` になるか |
| --- | --- | --- | --- |
| SELECT の結果列 | `ast.columns[].expr`（`column_ref` のみ） | `select` | **なる** |
| SELECT の式・集計の入力 | 同上（`aggr_func` / `function` / `binary_expr` / `case` / `cast` / `window_func` の中） | `select-expr` | ならない |
| WHERE | `ast.where` | `where` | ならない |
| JOIN 条件 | `ast.from[].on` | `join` | ならない |
| ORDER BY | `ast.orderby[].expr` | `order-by` | ならない |
| GROUP BY | `ast.groupby.columns[]` | `group-by` | ならない |
| HAVING | `ast.having` | `having` | ならない |
| RETURNING | `ast.returning.columns[]` | `select` | **なる** |
| 入れ子の SELECT | `expr.ast` / `from[].expr.ast` / `with[].stmt` | `nested-select` | ならない |

解決できないときの理由コード（**「存在しない結果列を作らない」の内訳**）：

| コード | 条件 |
| --- | --- |
| `select-star` | `SELECT *` / `t.*`。実行された SQL からも結果列を列挙できない |
| `aggregate-or-expression` | 集計・式・関数・スカラ副問い合わせ。1つの列に帰属しない |
| `ambiguous-qualifier` | 修飾が無く、FROM に表が複数ある（**自己結合も含む**） |
| `unknown-qualifier` | 書かれた修飾に対応する表が FROM に無い |
| `derived-table-qualifier` | 派生表・CTE の出力を参照しており、元の表の列まで決まらない |
| `no-table-in-scope` | FROM に表が無い |
| `schema-not-determined` | 表は決まったがスキーマが書かれておらず、定義を一意に指せない |

修正後の挙動（抜粋。全件は `tests/sqlparse.spec.mjs`）：

| 入力 | 射影 | 結果列でない参照 |
| --- | --- | --- |
| `SELECT code, region FROM poc.listings ORDER BY id` | `code, region` | `order-by: id` |
| `SELECT * FROM poc.listings` | **なし**（`selectStar: true`） | — |
| `SELECT l.code AS c, r.name FROM a l JOIN b r ON l.region=r.code WHERE l.plan=$1` | `a.code, b.name` | `join: a.region, b.code` / `where: a.plan` |
| `SELECT count(*) AS n FROM poc.listings` | **なし** | — |
| `SELECT max(id) AS m FROM poc.listings` | **なし** | `select-expr: id` |
| `UPDATE … SET code=$1 WHERE id=$2` | **なし** | `update-target: code` / `where: id` |
| `UPDATE … SET code=$1 WHERE id=$2 RETURNING id, code` | `id, code` | `where: id` |
| `SELECT id FROM (SELECT id, code FROM t) x` | **なし**（`derived-table-qualifier`） | `nested-select: t.id, t.code` |

### 1.5 あわせて直した構造的な原因 — **構文解析器が2つあったこと**

PoC-04 は `sqlparse.mjs` の射影を信用できなかったため、`lineage.mjs` の中に
**2つ目の構文解析器**（`selectList()`）を作って SELECT 句を読み直していた。
`sqlparse.mjs` を直したので、2つ持つ理由は無くなった。

| 変更 | 内容 |
| --- | --- |
| `lineage.mjs` | 独自の `Parser` インスタンスと `selectList()` の実装を削除。`sqlparse.mjs` から再輸出するだけにした。**契約（`{ok, star, error, items}`）は変えていない**（PoC-04 の解析が依存している） |
| `sqlparse.mjs` | `sqlAnalysisRecord()` を追加。**5つの観測生成スクリプトが同じ写しを持っていた**記録の組み立てを1か所にまとめた。同じ写しが5つあったことが、1つの不具合が5つのデータセット全部に入った原因である |
| `build-observation.mjs` / `build-element-observation.mjs` / `build-poc02-observation.mjs` / `build-poc05-observation.mjs` / `build-poc04-observation.mjs` | いずれも `sqlAnalysisRecord()` を呼ぶだけにした。**PoC-04 にあった絞り込みの回避策は削除した**（共通実装が正しくなったので不要） |
| `poc04.mjs` | 行列の `projectionsFromColumnList` を `projectionsFromSelectList` に改名し、`referencedOutsideSelectList` を追加（名前が実態と食い違っていた） |
| `adapter.ts` | D8 を修正。理由コード → 文言の表を作り、**理由ごとに言い分ける**ようにした。未知のコードは「知らない」と書く（推測の説明を当てない） |
| `observation.ts` | `ObsSqlAnalysis` に `statementType` / `references` / `selectItems` / `setOperation` / `tables[].op` を**任意項目として**追加。**既存の記録は変更不要**（すべて省略可） |

> **`unresolved` に `referenced-outside-select-list` を混ぜていない。**
> ORDER BY の列は「解決できなかった射影」ではなく「結果列ではない参照」である。
> 両者を混ぜることが、この不具合の出発点だった。観測生成スクリプトは
> `references` から導いて記録に残すので、**情報は失われない**（OBS-05）。

---

## 2. 既存 PoC への影響の検証

### 2.1 検証の方法

`poc/runner/sqlimpact.mjs`（`npm run poc:sqlimpact`）を作った。

1. PoC-01 / 03 / 05 / 02 / 02(Gate A) / 04 A / 04 C / 04 G の **記録済みの観測結果を読む**
2. そこに入っている実測 SQL を、**旧実装の凍結コピー**と**新実装**の両方に通す
3. `sqlAnalyses` だけを差し替えて、**同じ `adapter` / `layout` / `derive`** を通す
4. ノード数・ホップ数・表示カラム・実測/推定の分類・切断マーカー・右詳細パネルの説明を比べる

結果は `docs/06f-sqlimpact.json`。**記録そのものは読むだけで、書き換えていない。**

> 比較では情報スキーマの列定義を全データセットの和でそろえている。記録済みの
> `dbObjects.columns` は「そのとき射影だった列」に絞られているため、射影だけを
> 差し替えると「定義が無いから作らなかった」が混ざり、**修正そのものの影響が
> 見えなくなる**（PoC-04 G で実際にそうなった）。

### 2.2 実測された SQL は6通りしかない

| # | SQL | 出所 |
| --- | --- | --- |
| 1 | `SELECT "poc"."listings"."id","code","region" FROM "poc"."listings" WHERE $0=$0 ORDER BY "poc"."listings"."id" ASC LIMIT $1 OFFSET $2` | PoC-01 / 03 / 05 |
| 2 | `SELECT id, code, plan FROM poc.listings ORDER BY id LIMIT $0` | PoC-02 |
| 3 | `SELECT code, name FROM poc.regions ORDER BY code LIMIT $0` | PoC-02 (Gate A) |
| 4 | `SELECT id, region FROM poc.listings ORDER BY id LIMIT $0` | PoC-04 A |
| 5 | `SELECT id, code, region FROM poc.listings ORDER BY id LIMIT $0` | PoC-04 C |
| 6 | `SELECT code, region FROM poc.listings ORDER BY id LIMIT $0` | **PoC-04 G** |

**1〜5 では ORDER BY の列が SELECT 句にも入っている。** そのため旧実装でも結果は同じになっていた。
**6 だけが、ORDER BY にしか無い列（`id`）を持つ。**

### 2.3 変更前 / 変更後の比較

| データセット | ノード数 | ホップ数 | 表示カラム | 実測/推定 | 切断 | 右詳細パネル |
| --- | --- | --- | --- | --- | --- | --- |
| PoC-01 `measured` | 7 → **7** | 6 → **6** | `code, id, region` → **同じ** | 13/0 → **同じ** | 1 → **1** | 変化なし |
| PoC-03 `elements` | 9 → **9** | 7 → **7** | `code, id, region` → **同じ** | 16/0 → **同じ** | 2 → **2** | 変化なし |
| PoC-05 `flows` | 10 → **10** | 8 → **8** | `code, id, region` → **同じ** | 18/0 → **同じ** | 1 → **1** | 変化なし |
| PoC-02 `rsc` | 10 → **10** | 8 → **8** | `code, id, plan` → **同じ** | 18/0 → **同じ** | 1 → **1** | 変化なし |
| PoC-02 `rsc-svc` | 9 → **9** | 8 → **8** | `code, name` → **同じ** | 17/0 → **同じ** | 1 → **1** | 変化なし |
| PoC-04 A `lin-a` | 9 → **9** | 8 → **8** | `id, region` → **同じ** | 16/1 → **同じ** | 0 → **0** | 変化なし |
| PoC-04 C `lin-c` | 10 → **10** | 9 → **9** | `code, id, region` → **同じ** | 18/1 → **同じ** | 0 → **0** | 変化なし |
| **PoC-04 G `lin-g`** | **10 → 9** | **8 → 7** | **`code, id, region` → `code, region`** | **18/0 → 16/0** | 1 → **1** | **1行増える** |

PoC-04 G の内訳：

| 項目 | 変更前（旧実装） | 変更後 |
| --- | --- | --- |
| ⑦ カラムのノード | **3件**（`code` `id` `region`） | **2件**（`code` `region`） |
| `projects` ホップ | 3本 | **2本** |
| 経路サマリ | 「18 か所のうち 0 か所が推定です」 | 「**16 か所**のうち 0 か所が推定です」 |
| 右詳細パネル「変換で作らなかったもの」 | （なし） | 「**射影 id — SELECT句の外（ORDER BY 等）で参照された列であり、結果の行には無いため列として出さなかった**」 |
| 最弱環・経路全体の観測性・主張・切断マーカー | — | **変化なし** |

### 2.4 **記録済みの PoC-04 G は、既に修正後の挙動と一致している**

これが今回いちばん重要な確認である。

PoC-04 は共通実装を変えない代わりに、観測生成の側で SELECT 句の列だけに絞っていた（`06e` 5.3節 #1）。
したがって **`src/data/observation.poc04.ts` に記録されている射影は既に2件**であり、
`id` は `referenced-outside-select-list` として `unresolved` に入っている。

| | 記録（いま画面に出ているもの） | 旧実装で再計算 | 新実装で再計算 |
| --- | --- | --- | --- |
| 射影 | **2件**（`code` `region`） | 3件（`id` を含む） | **2件**（`code` `region`） |
| ⑦ ノード | 2件 | 3件 | **2件** |

> **したがって、既存の記録を作り直す必要は無い。** 修正は「共通実装を、PoC-04 が
> 局所的に正していた挙動に合わせた」ものであり、**どの記録も誤りにならない**。
> `06e` 11.3節 #1 の申し送り「PoC-01 / 02 / 03 / 05 のデータセットも作り直す必要がある」は、
> **今回の検証により不要と判明した**（1〜5 の SQL では旧実装と新実装の射影が一致するため）。

### 2.5 既存データに現れていない不具合（D2〜D7）の扱い

D2〜D7 は、**題材の SQL がたまたま該当しなかったため既存のデータセットには現れていない。**
これは「問題が無かった」ではなく「**題材が狭かった**」である。

| # | 現れる条件 | 既存の題材に在るか | MVP で現れるか |
| --- | --- | --- | --- |
| D2 | `SELECT *` | 無い（`x-star` ケースの SQL は走っていない） | **ほぼ確実に在る**（ORM の既定は全列取得） |
| D3 | `SELECT "s"."t".*` | 無い | 在りうる |
| D4 | **JOIN** | 無い（全SQLが単一表） | **ほぼ確実に在る** |
| D5 | `INSERT` / `UPDATE` | 無い（全SQLが `SELECT`） | **在る**（Server Action で書き込みが走る） |
| D6 | 別名なしの集計 | 無い | 在りうる |
| D7 | 副問い合わせ | 無い | 在りうる |

**D4 は特に重い。** 結合を使う実アプリでは、旧実装は ⑦ カラムを1つも出せず、
右詳細パネルに「修飾が一意に決まらず…」が列の数だけ並ぶことになっていた。
`06e` が報告した D1 よりも、実用上の影響は大きい。

---

## 3. 関係種別の整理

### 3.1 棚卸し — いま実装に存在する関係と取得手段

| 種別 | 値 | from → to | 既定レベル | 取得手段 | `02a`/`02d` に在るか |
| --- | --- | --- | --- | --- | --- |
| 関係 | `renders` | `ComponentDef` → `DomElement` | L1 | `element-anchor` | ○ |
| 関係 | `requests` | `ComponentDef` → `HttpExchange` | L0 | **実装は `request-initiator` / `server-call-stack`** | △（根拠欄が食い違う） |
| 関係 | `handles` | `HttpExchange` → `Span` | L1 | `trace-context` | ○ |
| 関係 | `invokes` | `Span` → `Span` | L1 | `trace-span` | ○ |
| 関係 | `executes` | `Span` → `SqlStatement` | L1 | `trace-span` | ○ |
| 関係 | `reads` | `SqlStatement` → `DbTable` | L1相当 | `sql-ast-parse` | ○ |
| 関係 | `projects` | `SqlStatement` → `DbColumn` | L1相当 | `sql-ast-parse` | ○ |
| 関係 | **`queries`** | `ComponentDef` → `SqlStatement` | L1相当 | `server-call-stack` | **✕ 未承認**（PoC-02 提案） |
| 関係 | **`supplies`** | `ComponentDef` → `ComponentDef` | L2 | `static-analysis` | **✕ 未承認**（PoC-04 提案） |
| 関係 | `binds` / `derives` / `maps` | — | L2 | — | ○（**どの PoC でも作っていない**） |
| **取得手段** | **`request-initiator`** | — | L1相当 | — | **✕ 未承認**（PoC-05 提案） |
| **取得手段** | **`server-call-stack`** | — | L1相当 | — | **✕ 未承認**（PoC-02 提案） |

### 3.2 指摘 I-1 — **`supplies` / `queries` と `request-initiator` / `server-call-stack` は別の軸である**

指示の例はこの4つを並べていたが、モデル上は**種類が違う**。

| | 関係種別（`ModelHop.relation`） | 取得手段（`SourceId`） |
| --- | --- | --- |
| 決めるもの | **from / to の型**（何と何を結ぶか） | **観測性**（実測か推定か） |
| 決定点 | `02a` 3.5.1節の表 | `model.ts` の `SOURCE_LEVEL` → `observabilityOf` |
| 対応関係 | 1つの関係が複数の取得手段を持ちうる | **1つの取得手段が複数の関係を支えうる** |

実例: `server-call-stack` は **`queries`（→SqlStatement）と `requests`（→HttpExchange）の両方**を支えている
（`06d` 6.1節）。したがって「`server-call-stack` という関係を追加する」という整理は誤りであり、
追加提案は **関係2件（`queries` / `supplies`）と取得手段2件（`request-initiator` / `server-call-stack`）** として
別々に扱う必要がある。

### 3.3 指摘 I-2 — `queries` は既存の関係で表現できない（重複なし）

| 比較対象 | 違い |
| --- | --- |
| `executes`（`Span` → `SqlStatement`） | **始点の型が違う。** スパンの親子は「この処理の下で走った」ことしか言わない。描画スパンはルート単位なので、1ページに2本の SQL があるとどちらがどのコードかを語らない（`06d` 2.2 実測） |
| `requests`（`ComponentDef` → `HttpExchange`） | **終点の型が違う。** 通信と SQL は別物である |

**結論: 重複しない。追加提案を維持してよい。**

ただし1点、**同じ ⑤ ノードに `executes` と `queries` の2本が入る**（`lin-a` / `rsc` で実測）。
これはモデル上正しい（根拠が別々なので別のホップである）が、
「背骨に乗らないホップ＝経路を戻るホップ」という UI 側の仮定を一度壊している（`06d` で修正済み）。
**`02a` 3.5.3節の「分岐」の定義は「1つの `Span` が複数の子を持つ」であり、
「1つのノードに複数の根拠の異なるホップが入る」場合を扱っていない。** 定義の追記を提案する。

### 3.4 指摘 I-3 — **`supplies` の宣言された型が、実装が持っている情報と食い違う**

PoC-04 は `supplies` を **`ComponentDef` → `ComponentDef`** と定義している。
しかし実測したデータセットを見ると：

```
lin-a:  node 2 = src/app/lin-a/page.tsx:18  chipSub=LinA   source=element-anchor
        node 5 = src/app/lin-a/page.tsx:12  chipSub=LinA   source=server-call-stack
        hop supplies: 2 → 5   (static-analysis, 推定)

rsc:    node 2 = src/app/rsc-db/page.tsx:19 chipSub=RscDb
        node 5 = src/app/rsc-db/page.tsx:12 chipSub=RscDb
```

**始点と終点は同じ `ComponentDef`（`LinA` / `RscDb`）である。**
型のとおりに読むと、このホップは「`LinA` が `LinA` に供給する」としか言っていない。
実際に情報を持っているのは**ソース位置**（18行目 ← 12行目）と `candidates[]` のほうである。

これは PoC-04 自身の論証と噛み合わない。`06e` 1.2節 (1) は
**「同じコンポーネント名であることは証明にならない」（ケースG が反例）** と結論している。
にもかかわらず、`supplies` の宣言された型は **`ComponentDef → ComponentDef`**、
すなわち「コンポーネントからコンポーネントへ」である。
**実装は誤謬を避けているが、型が誤謬を誘っている。**

| | 設計修正案 |
| --- | --- |
| 現在 | `supplies` : `ComponentDef` → `ComponentDef` |
| **案** | `supplies` : **`PropBindingSite`（値を描いた位置・`SourceLocation` で同定）→ `DataFetchSite`（取得を呼んだ位置・`SourceLocation` で同定）** |
| 理由 | 実装が実際に結んでいるのはこの2つである。`02a` 3.5.1 には既に `binds` の始点として `PropBindingSite` が、`locatedAt` として `SourceLocation` が在る。**新しいオブジェクトを増やさずに型を正せる** |
| 影響 | UI は変わらない（既にソース位置を識別子にしている）。`candidates[]` の扱いも変わらない |

### 3.5 指摘 I-4 — コンポーネント**定義**と**インスタンス**の混同

| 関係 | 宣言された型 | 実際の多重度 | 問題 |
| --- | --- | --- | --- |
| `renders` | `ComponentDef` → `DomElement` | **1対多**（同じ定義が N 個の要素を描く） | 定義は要素を描かない。描くのはインスタンスである |
| `supplies` | `ComponentDef` → `ComponentDef` | 同上 | 同じ定義が複数回描かれ、それぞれ別の行を表示する場合を区別できない |

これは `06d` 11章 #3 と `06e` 11.3節 #5 が**どちらも未解決として記録している宿題**と同じものである。
PoC-03 は材料の一部（`anchorOrdinal` / `anchorInstanceCount`）を観測できている。

| | 設計修正案 |
| --- | --- |
| **案A** | `ComponentInstance`（`ComponentDef` + 出現順序）を置き、`renders` の始点をこれにする |
| **案B** | オブジェクトは増やさず、`renders` に**多重度と「どのインスタンスかは特定していない」**を明示する属性を足す |
| 判断 | **本 Phase では決めない。** インスタンスの同定は未検証であり、決めるには観測が要る（第4章の検証計画でも扱わない）。**案A を先に仕様化すると、観測できない区別を仕様が要求することになる** |

### 3.6 指摘 I-5 — `requests` の根拠欄が実装と食い違う

`02a` 3.5.1節は `requests` を「既定レベル **L0** / 根拠: **ブラウザ側の計測**」としている。
しかし **ブラウザのネットワーク計測だけでは `ComponentDef → HttpExchange` の線は引けない。**
計測が与えるのは `HttpExchange` ノード（メソッド・パス・状態・所要時間）であって、
「どのコンポーネントが始めたか」ではない。

実装（PoC-05 / PoC-02）は `request-initiator` / `server-call-stack` を使っている。

| | 設計修正案 |
| --- | --- |
| 現在 | `requests` / `ComponentDef → HttpExchange` / **L0** / 根拠「ブラウザ側の計測」 |
| **案** | `requests` / `ComponentDef → HttpExchange` / **L1相当** / 根拠「**通信開始時の呼び出しスタック**（ブラウザ側は `request-initiator`、サーバー内部は `server-call-stack`）」/ 降格条件「スタックにアプリのフレームが無い → 関係を作らない」 |
| 注 | `HttpExchange` **ノード**は従来どおり L0（`browser-network`）である。**ノードの観測性と関係の観測性を分けて書く**必要がある |

### 3.7 指摘 I-6 — `requests` の終点が2種類の通信を区別していない

PoC-05 の `requests` の終点は**ブラウザに現れる通信**、PoC-02 Gate A の `requests` の終点は
**サーバーの中から出た通信（ブラウザには現れない）**である。同じ関係・同じノード種別で表している。
実装は `overview` の文言で区別しているが、**モデルには区別が無い**。

| | 設計修正案 |
| --- | --- |
| **案** | `HttpExchange` に「観測した位置」（`browser` / `server-internal`）を属性として持たせる。関係は分けない（始点・終点の型は同じであるため） |

### 3.8 実測と静的推定を混同していないか

**混同していない。** 型の上で混同できないようになっている。

| 確認 | 結果 |
| --- | --- |
| 観測性の決定点 | `observabilityOf(source)` だけ。`ModelNode` / `ModelHop` の `observability` は `readonly` で、`node()` / `hop()` 以外の作り方が無い |
| `supplies` | `static-analysis` → L2 → **推定**。全データセットで確認（`tests/sqlimpact.spec.mjs` 第6節） |
| `queries` | `server-call-stack` → L1相当 → **実測** |
| `sql-ast-parse` 由来の要素 | 8データセットすべてで**全件が実測**であることをテストで固定した |
| 推定の要素が在るのは | `supplies` を持つデータセット（PoC-04 A / C）だけであることをテストで固定した |

ただし1点記録しておく。**`supplies` の `candidates[]` の根拠文には
「実行された SQL の SELECT 句にこの列がある」という L1相当 の事実が入っている。**
ホップ自体は L2 のままなので格上げは起きていないが、
UI 上で「実測の根拠が付いた推定」と読まれうる。**`02d` 4.2節の表示配分の観点で、
根拠の列挙に観測性の別を併記するかどうかは未決**である（本 Phase では変えない）。

### 3.9 同一コンポーネントであることを、値の因果関係として扱っていないか

**扱っていない。** ケースG がその否定例として機能しており、実装も線を引いていない。

| 確認 | 根拠 |
| --- | --- |
| `lin-g` に `supplies` が無い | 第2.3節の表（ホップ7本に `supplies` が含まれない）/ `tests/lineage.spec.mjs` |
| `rsc` で ② と ②'' の間に線が無い | `06d` 5.1節 / `tests/rsc.spec.mjs`「既存の RSC データセットでは ② と ②'' の間に線が無いまま」 |
| 帰属の根拠に SQL 文の一致・時刻の近さ・ページのパスを使っていない | `06d` 2.3節 / `06e` 2.4節 |

ただし **I-3 のとおり、宣言された型がこの誤謬を誘う形になっている。** 型の修正案を第3.4節に挙げた。

### 3.10 設計修正案のまとめ（**提示のみ。`02a` / `02d` は変更していない**）

| # | 対象 | 修正案 | 根拠 | 承認要否 |
| --- | --- | --- | --- | --- |
| 1 | `02a` 3.5.1 | `queries` 行を追加（`ComponentDef → SqlStatement` / L1相当 / `server-call-stack`） | I-3 | **要承認** |
| 2 | `02a` 3.5.1 | `supplies` 行を追加。ただし型は **`PropBindingSite → DataFetchSite`** とする | I-3（PoC-04 案の修正） | **要承認** |
| 3 | `02a` 3.5.1 | `requests` の根拠を「通信開始時の呼び出しスタック」に、既定レベルを L1相当 に改める | I-5 | **要承認** |
| 4 | `02a` 3.5.3 | 「分岐」の定義に「1つのノードに、根拠の異なる複数のホップが入る場合」を追記 | I-2 | **要承認** |
| 5 | `02a` 3.3 | `HttpExchange` に観測位置（`browser` / `server-internal`）の属性を追加 | I-6 | **要承認** |
| 6 | `02a` 3.1 / 3.5.1 | コンポーネント定義とインスタンスの区別。**本 Phase では案を2つ出すにとどめ、決めない** | I-4 | **保留** |
| 7 | `02d` 1.3 | `request-initiator` / `server-call-stack` を取得手段の表に追加（ともに L1相当） | PoC-05 / PoC-02 の既出提案 | **要承認** |
| 8 | `02a` 3.5.2 | `rsc-direct` の「確度は相対的に高い」の削除 | `06e` 1.4節の既出提案（本 Phase で新たに加えるものは無い） | **要承認** |

> **いずれも未承認のままである。** 実装側は従来どおりコメント付きで持っているだけで、
> `02a` / `02d` には1行も書き加えていない。

---

## 4. `client-fetch` の制約の整理

### 4.1 PoC-04 で成立しなかった理由

対象は `poc/fixture-app/src/app/listings/page.tsx`（唯一の `client-fetch` の題材）。

```tsx
const [rows, setRows] = useState<Row[]>([]);
useEffect(() => { fetch('/api/listings').then((r) => r.json()).then((d) => setRows(d.listings)); }, []);
…
<td data-poc-field="region">{r.region}</td>
```

結果は **候補なし**、理由コード `call-not-whitelisted:useState`（`06e` 4.4節）。

切れている箇所は**1つではなく、2つある**。両方を分けて書く。

| # | 切断 | 内容 |
| --- | --- | --- |
| **G1** | **表示値 ← 取得の応答**（クライアント側） | `rows` の初期化子は `useState([])` であって取得結果ではない。取得結果が `rows` に入る唯一の経路は `setRows(d.listings)` という**閉包の中の非同期な呼び出し**であり、`rows` から `d` への**構文上の参照の連鎖が存在しない**。`lineage.mjs` は参照の連鎖だけを根拠にするので、ここで終わる |
| **G2** | **応答の項目 ← DBカラム**（サーバー側） | `rsc-direct` と違い、`client-fetch` には**応答 JSON という中間成果物が実在する**。`02a` の `derives`（応答のキー → `PropBindingSite`）と `maps`（`DbColumn` → 応答のキー）がこれにあたる。**どちらも、どの PoC でも1本も作っていない** |

> **G1 を解いても `client-fetch` は通らない。** G2 が残るためである。
> `06e` は G1（`useState`）だけを障害として記録しているが、**端から端まで繋ぐには G2 も要る。**
> これは本 Phase で整理して初めて分離できた点である。

### 4.2 MVP で検証可能な範囲

| # | 構成 | いまの成否 | 検証可能か | 根拠 |
| --- | --- | --- | --- | --- |
| **1** | **取得結果を直接描画する** | — | **限定的に可能** | Client Component では、状態か Promise を経ずに取得結果を描く経路が実質的に無い。該当するのは React 19 の `use(promise)` であり、これは**構文上の参照の連鎖が繋がる**（`use` を白表に足すだけで届く可能性がある）。`async` な Server Component での直接描画は `rsc-direct` であり **PoC-04 で検証済み**（ケースA / f-own、確定8件） |
| **2** | **`useState` を経由する** | **不成立** | **可能**。ただし新しい規則が1つ要る | `const [s, setS] = useState(init)` に対し、**`s` の値の集合 = {`init`} ∪ {`setS` の実引数}** という**構文的で有界な**規則を足せばよい。一般のデータフロー解析ではない。`setS` の呼び出し箇所はコンポーネント本体の中に閉じているため列挙できる。**誤答が増えないことの確認が必須**（否定例が要る） |
| **3** | **カスタムフックを経由する** | 不成立 | **条件付きで可能** | `function useRows() { …; return rows }` を跨ぐには**関数の返り値を追う**必要がある。現在の保守規則 R4（白表に無い呼び出しは `unknown`）がこれを禁じている。拡張するなら「**解析範囲内で定義され、すべての `return` が追える関数に限って**通す」という条件が要る。条件を緩めると `x-outside`（引数を捨てる関数）で誤対応が出る |
| **4** | **props を複数回渡す** | **成立済み** | **検証済み** | PoC-04 ケースB（`page → LinBCard → LinBLabel`、2段の改名）で**確定3/3**。この仕組みは経路種別に依存しない（JSX の参照の連鎖だけを見る）ので、G1 を越えれば `client-fetch` でもそのまま効く |
| **5** | **同じコンポーネントを複数回描画する** | 不成立 | **今回の範囲では検証しない** | 「どのインスタンスがどの行か」は `06d` 11章 #3 / `06e` 11.3節 #5 の未解決の宿題である。PoC-03 は `anchorOrdinal` / `anchorInstanceCount` を観測できているが、**出現順序と配列の添字を結ぶ証拠は観測していない**。I-4（定義とインスタンスの混同）と同じ問題であり、**モデルの決定が先**である |

### 4.3 最小の追加検証計画（**今回は実装しない**）

新しい値追跡方式を全面実装せず、**4つの小さな検証**に切る。
`01b` Q-04.3 の 50 要素規模は求めない。**誤答を1件も出さないことだけを合否にする。**

| # | 検証 | 題材に足すもの | 合否 | 失敗時の受け皿 |
| --- | --- | --- | --- | --- |
| **V1** | `useState` の状態束縛規則（初期化子 ∪ setter 実引数）だけを足す | 既存の `/listings` に加えて、**否定例**を2件（setter が取得結果以外を入れる／同名の別の状態） | `/listings` の `region` が候補に出て、**否定例で候補を出さない**。**誤答 0 件** | 規則を入れない。`client-fetch` は経路の提示までにとどめる（`01b` Q-04.5 代替4） |
| **V2** | **`maps`（DBカラム ↔ 応答のキー）を、キー構成の照合だけで解けるか** | API ルート3本（素通し／別名／加工あり） | 応答の**キー名だけ**を読み、SELECT 句の別名・列名の集合と照合して1対1が立つか。**値は読まない**（NFR-20 と両立）。加工ありの1本で**候補を出さない**こと | `maps` を作らない。切断のまま残す（現状と同じ） |
| **V3** | カスタムフック**1段だけ**を跨ぐ | `useRows()` を1本 | 返り値が追え、かつ**引数を捨てる関数では候補を出さない** | R4 を緩めない |
| **V4** | `use(promise)` 経由 | Client Component 1本 | 参照の連鎖が繋がるか | 白表に足さない |

> **V1 と V2 は独立している。** V1 だけ成功しても `client-fetch` は端まで繋がらない（第4.1節 G2）。
> **両方成功して初めて、`client-fetch` の由来を「証拠のある範囲で」出せる。**
> どちらも結論は **L2（推定）**である。実測にはならない（`01b` Q-04.0）。

### 4.4 明文化する制約

MVP の `SupportMatrix`（`02a` 6章の席）に、次をそのまま載せる。

| 構成 | 由来の表示 | 理由 |
| --- | --- | --- |
| Server Component が直接取得して描く（`rsc-direct`） | **候補を出す（推定）** | PoC-04 で検証済み。誤答 0/20。保守規則6つを守ること |
| Client Component が `useState` 経由で描く（`client-fetch`） | **出さない。切断として明示する** | 参照の連鎖が状態境界で切れる（G1）。応答とカラムの対応づけも無い（G2） |
| カスタムフック経由 | **出さない** | 未検証 |
| 同じコンポーネントの複数インスタンス | **「どのインスタンスか」を主張しない** | 証拠が無い |
| Server Action / ストリーミング / Context / 状態管理ライブラリ | **出さない** | 題材に無い・未検証 |
| 本番ビルド | **要素の特定を含め、対応しない** | 要素識別子の注入とソースマップに依存（`01b` Q-03 C-5） |

---

## 5. テスト

### 5.1 回帰

| 対象 | 件数 | 結果 |
| --- | --- | --- |
| 既存 11本（`poc01` `explore` `measured` `poc03` `elements` `poc05` `flows` `poc02` `rsc` `poc04` `lineage`） | **894** | **全件通過。0件失敗** |
| 新規 `tests/sqlparse.spec.mjs` | **77** | 全件通過 |
| 新規 `tests/sqlimpact.spec.mjs` | **64** | 全件通過 |
| **合計** | **1035** | **全件通過 / 0件失敗** |

**既存テストの期待値は1件も書き換えていない。** 失敗したものが無かったためである。
修正が既存の表示を変えないこと（第2.3節）が、そのままテストの結果に出ている。

### 5.2 新規テストの内訳

**`tests/sqlparse.spec.mjs`（77件）**

| 節 | 内容 | 件数 |
| --- | --- | --- |
| 1 | **正例** — SELECT 句の結果列が射影になる（単純・修飾つき・別名・JOIN・RETURNING・重複の畳み込み・UNION・FROM句の表） | 10 |
| 2 | **否定例** — 結果列でない参照を射影にしない（ORDER BY / WHERE / JOIN ON / GROUP BY / HAVING の5句すべて）。あわせて**捨てていない**ことも確認 | 11 |
| 3 | **否定例** — 存在しない結果列を作らない（`SELECT *` 3形・集計・式・型変換・CASE・INSERT/UPDATE・副問い合わせ・派生表・CTE・自己結合・未知の修飾・スキーマ不明） | 40 |
| 4 | 構文解析できなかったものを「できなかった」と返す | 5 |
| 5 | `selectList()` の契約（PoC-04 が依存） | 10 |
| 6 | **不変条件**（射影は必ず3要素が揃う／`*` が混ざらない／重複が無い／`select` 役割の参照としても現れる／部分的に作らない） | 6 |

**`tests/sqlimpact.spec.mjs`（64件）** — 第2章の結論をテストで固定したもの。

| 節 | 内容 |
| --- | --- |
| 1 | **いま画面に出ているカラムが、修正後も1つも消えない／勝手に増えない**（8データセット） |
| 2 | 記録されている6通りの SQL それぞれの射影と「結果列でない参照」（期待値はソースを読んで手で書いた） |
| 3 | 旧実装との差が**1通りだけ**であり、**消える方向にしか変わらない**こと |
| 4 | PoC-04 G の記録が既に修正後の挙動と一致していること（作り直し不要の根拠） |
| 5 | 右詳細パネルの説明が理由ごとに違うこと／理由コードが生のまま出ないこと |
| 6 | `sql-ast-parse` 由来が全件実測であること／推定は `supplies` のときだけ在ること |

### 5.3 期待値を書き換えていないことの確認

既存894件は**1件も失敗しなかった**ため、「期待値が間違っていたのか実装が壊れたのか」を
判断する場面そのものが発生しなかった。

新規テストの期待値は、**SQL を人が読んで手で書いた**ものであり、
`analyzeSql` の出力を写したものではない（第2章の `EXPECTED` 表も同じ）。

### 5.4 typecheck / build / ブラウザ表示

| 項目 | コマンド | 結果 |
| --- | --- | --- |
| 型検査 | `npm run typecheck` | **通過**（エラー 0） |
| 本番ビルド | `npm run build` | **成功**（Next.js 16.4.3 / Turbopack） |
| ブラウザ表示 | 本番ビルドを起動し、`explore` / `measured` / `elements` / `flows` / `rsc` / `lineage` の6本を実行 | **全件通過。JS エラー 0 件** |

スクリーンショット: `docs/06f-screenshots/`。
`lin-g-selected.png` で、**⑦ カラムが `code` と `region` の2つだけ**であり、
`id` が描かれていないことを目視で確認した。

---

## 6. MVP への移行計画

### 6.1 最小体験の8段階と、PoC で確立した範囲

| # | 段階 | 確立した PoC | 判定 | 実装で足りないもの |
| --- | --- | --- | --- | --- |
| 1 | ローカルの Next.js プロジェクトを選択 | — | **未着手** | プロジェクトの検出（`next` 依存・App Router・`src/` 構成の判定）。**PoC の題材は固定パスだった** |
| 2 | IDE から開発サーバーを起動 | PoC-01 | **成功** | 方式1（`instrumentation.ts` 生成）と方式2（`NODE_OPTIONS=--require`）の両方が成立。**方式2 はプロジェクトにファイルを足さない**。残るのは起動の管理（ポート・停止・再起動・ログ） |
| 3 | ブラウザプレビューを表示 | PoC-01 / 03 / 05 | **成功** | Playwright で駆動し、通信・DOM を観測できている。**IDE に埋め込むプレビューの実装**は未着手 |
| 4 | 画面の要素を選択 | PoC-03 | **条件付き成功** | ビルド時の要素識別子の注入で成立。コストは実測済み（1ファイルあたり中央値 0.04〜0.51ms、解析器の読み込み 121ms）。**選択できない場合の `SelectionFailure` 4種の表示**は設計済み・未実装 |
| 5 | React ソース位置を特定 | PoC-03（描画側）/ PoC-05（通信の開始）/ PoC-02（取得の実行） | **成功** | 3種類の位置がそれぞれ別の手段で取れている。**同じコンポーネントの複数インスタンスの区別は不可**（I-4） |
| 6 | HTTP・SQL の実測情報を表示 | PoC-01 / 02 / 05 | **成功** | `browser-network` / `trace-span` / `trace-context` / `orm-instrumentation` / `sql-ast-parse` / `db-introspection`。**本 Phase で `sql-ast-parse` の正確性を上げた** |
| 7 | 値の由来を、証拠がある範囲で表示 | PoC-04 | **条件付き成功（`rsc-direct` のみ）** | `client-fetch` は**1箇所も到達できていない**（第4章）。**MVP の主経路がこれである** |
| 8 | 未観測・未対応の関係を明示 | PoC-01〜05 すべて | **成功** | `cuts` / `skipped` / `notObserved` / `offPath` が機能している。**本 Phase で `skipped` の説明文の誤りを直した**（D8） |

### 6.2 実装の順序

| 段階 | 内容 | 前提 | 出口 |
| --- | --- | --- | --- |
| **M0** | **本 Phase の修正の取り込み**（完了） | — | SQL 解析の共通不具合が無い状態 |
| **M1** | **関係種別の承認**（第3.10節の #1〜#5, #7） | 人の判断 | `02a` / `02d` が実装に追いつく。**これより先に実装を進めると、未承認の仕様の上に機能を積むことになる** |
| **M2** | **プロジェクトの選択と開発サーバーの起動**（段階1・2） | M1 | 任意のローカル Next.js プロジェクトで、方式2 の計装つきで起動できる |
| **M3** | **プレビューと要素選択**（段階3・4・5） | M2 | 要素を選ぶとソース位置が出る。**選べない場合に `SelectionFailure` を出す**（FR-11b） |
| **M4** | **実測情報の表示**（段階6・8） | M3 | 既存の adapter / layout / 描画部品をそのまま使う。**新しい UI は作らない** |
| **M5** | **`rsc-direct` の由来の表示**（段階7の一部） | M4 + 第3.4節の型修正 | `06e` 2.3節の保守規則6つをそのまま持ち込む |
| **M6** | **V1〜V4 の追加検証**（第4.3節） | M5 | `client-fetch` の由来をどこまで出せるかが決まる |
| **M7** | `client-fetch` の由来の表示 | **V1 と V2 の両方が成功した場合のみ** | 失敗した場合は `01b` Q-04.5 代替4（経路の提示にとどめる） |

### 6.3 MVP で**実装可能と断定しない**もの

| # | 項目 | 理由 |
| --- | --- | --- |
| 1 | **`client-fetch` 経路の値の由来** | 1箇所も到達できていない。V1・V2 の両方が通る保証が無い（第4.1節） |
| 2 | 確度ラベル（高/中/低） | 較正していない。NFR-17 を満たせない（`06e` 11.2節 #2） |
| 3 | 同じコンポーネントの複数インスタンスの区別 | 証拠が無い。モデルの決定も未了（I-4） |
| 4 | 本番ビルドでの要素特定・由来推定 | 要素識別子の注入とソースマップに依存（`01b` Q-03 C-5） |
| 5 | Server Action / ストリーミング / Edge Runtime / Context / 状態管理ライブラリ | 題材に無い・未検証 |
| 6 | `maps` / `derives` | 1本も作っていない。V2 待ち |
| 7 | 「表示値がその列の値そのままである」という主張 | **原理的にできない。** 値を読まない方針と両立しない |
| 8 | Next.js 以外のフレームワーク / Prisma・pg 以外の ORM | 題材に無い |
| 9 | 1本の SQL が多くの列を取るときのレイアウト | カラムの帯が設計空間（高さ952）の下端を超える（`06e` 5.3節 #3）。**M4 で折り返しが要る** |

---

## 7. 完了条件に対する結果

| 完了条件 | 結果 | 所在 |
| --- | --- | --- |
| SQL 解析の共通不具合を修正 | **完了。** 既報の1件に加えて**6件の派生不具合**と**表示側1件**を修正 | 第1章 / `poc/runner/lib/sqlparse.mjs` |
| 既存データセットへの影響を確認 | **完了。** 8データセットのうち**変化は PoC-04 G の1件のみ**。記録の作り直しは**不要**と判明 | 第2章 / `docs/06f-sqlimpact.json` |
| テストで回帰を検証 | **完了。** 既存 894 件全通過（期待値の書き換え 0）＋ 新規 141 件 = **1035 件 / 0 失敗** | 第5章 |
| 関係種別の整合性を整理 | **完了。** 指摘6件・設計修正案8件。**いずれも未承認のまま提示にとどめた** | 第3章 |
| `client-fetch` の制約を明文化 | **完了。** 切断が**2つ**（G1 / G2）であることを分離。5構成の可否と最小検証計画 V1〜V4 | 第4章 |
| 次の MVP 開発計画を作成 | **完了。** 8段階の到達状況と M0〜M7 の順序。断定しないもの9件 | 第6章 |

### 7.1 やっていないこと

- IDE の全機能の実装・新しい UI デザインの生成（**指示どおり着手していない**）
- 既存の観測記録の書き換え（`src/data/observation.*.ts` は無変更）
- `02a` / `02d` の更新（**未承認の関係種別を正式仕様へ昇格させていない**）
- 新しい値追跡方式の実装（第4.3節は**計画のみ**）

---

*本書は Phase 6F の実施報告である。*
