# 7C lineage-e2e の復旧 — 由来が「この文書の通信で SQL を観測していません」で切れた原因と最小修正

| | |
| --- | --- |
| 対象 | F-01 修正（`docs/07c-f01-selection-revision-report.md`）の後に残った `lineage-e2e` の 16 件の失敗 |
| 作業基準 | ブランチ `claude/explore-f01-selection-revision`、コミット `09c3dee8c090097837b120aa241bfa228d1c5130`（リモートと一致を確認）。作業ブランチ `claude/lineage-e2e-recovery-m3ab86` は開始時点で同じコミット・作業ツリーはクリーン（未コミット・未追跡なし） |
| 実施日 | 2026-11-02〜03 |
| 環境 | クラウドのコンテナ（Linux）。Node 22.23.4、IDE・題材とも Next 16.4.3（Turbopack）、Chromium 153（`PW_CHANNEL=none`）、使い捨ての PostgreSQL 16（127.0.0.1:55432）。詳細は `docs/07c-lineage-recovery-results/environment.txt` |
| 結論 | **解消**（16 件の原因は1つ。計装が対象のアプリの pg ではなく IDE 側の pg を包んでいた）。ただし調査の途中で、**別の原因による制約**（同じ起動の中でサーバー側のコードが HMR で差し替わった後は呼び出し位置を戻せない）を見つけた。これは安全側（未観測）に倒れており、直すには設計の判断が要るため、今回は直していない（第6節） |
| 変えたもの | `poc/fixture-app/ide-instrumentation/otel.cjs`（`patchCallsiteEntry` の pg の解決の起点）のみ。製品の照合・表示（`src/`）は変えていない |
| 足したテスト | `tests/callsite-entry-unit.spec.mjs`（再現テスト。23 項目）、`tests/lineage-revision-e2e.spec.mjs`（由来を結んだ状態 × F-01 の版の照合。実ブラウザ・実際の HMR・実 DB） |
| 直したテスト | `tests/lineage-e2e.spec.mjs` の2か所（前の項目の失敗で `undefined` を参照して例外になり、後続のケースを評価しないまま止まっていた）。期待値は変えていない |
| やっていないこと | 編集トラック（停止中）、F-02〜F-05、編集 PoC の互換、UI の変更、F-01 の照合の変更、HMR 後の呼び出し位置の制約の修正 |

記号: 【実測】この作業で動かして確かめた／【静的】コードを読んで確かめた／【推定】根拠からの推論で、動かしては確かめていない／【未観測】確かめていない。

---

## 1. 作業開始時の確認

| 項目 | 結果 |
| --- | --- |
| ブランチ・HEAD | `claude/lineage-e2e-recovery-m3ab86` @ `09c3dee`。`origin/claude/explore-f01-selection-revision` も `09c3dee8…`（指定どおり）【実測】 |
| 作業ツリー | クリーン【実測】 |
| F-01 の実装とテスト | 報告書の記載どおり。`select-revision-unit` 50/0、`select-unit` 101/0、`lineage-live-unit` 157/0、typecheck エラーなし（本作業で再実行）【実測】 |
| lineage-e2e の構成 | `tests/lineage-e2e.spec.mjs`。IDE を `next start` で起動し、題材を IDE の画面から起動する。題材は `VCIDE_E2E_PROJECT`、無ければ `poc/fixture-app`（`tests/lineage-e2e.spec.mjs:21`）。DB が無ければ失敗にする【静的】 |
| 過去の記録 | 7C-3 は `scripts/test-all-29.sh` で全 29 本を回し `lineage-e2e` 93/0（`docs/07c3-results/suites-summary.tsv`）。このスクリプトは `VCIDE_E2E_PROJECT` を設定しない＝**題材は `poc/fixture-app` そのもの**【静的】。F-01 の記録 `docs/07c-f01-results/lineage-e2e-{baseline,fixed}.txt` の1行目は `題材: …/poc/out/select-e2e/poc/fixture-app`＝**使い捨てのコピー**【静的】 |

---

## 2. 再現条件と再現結果

同じコミット（`09c3dee`、F-01 修正後）・同じ DB・同じブラウザで、**題材の置き場所だけ**を変えた。

| # | 題材 | 計装 | 結果 | 記録 |
| --- | --- | --- | --- | --- |
| R1 | `poc/fixture-app`（7C-3 と同じ） | 修正前 | **93 / 0** | `lineage-e2e-orig-before-fix.txt` |
| R2 | `poc/out/select-e2e/poc/fixture-app`（F-01 と同じ。node_modules は `cp -al`） | 修正前 | **10 / 16（例外で中断）**。F-01 の記録と項目ごとに同じ | `lineage-e2e-copy-before-fix.txt` |
| R3 | R2 と同じ。試験の例外の箇所だけ直した（第4.2節） | 修正前 | **66 / 27**（93 項目すべて評価） | `lineage-e2e-copy-before-fix-guarded.txt` |
| R4 | コピー | 修正後 | **93 / 0** | `lineage-e2e-copy-after-fix.txt` |
| R5 | `poc/fixture-app` | 修正後 | **93 / 0** | `lineage-e2e-orig-after-fix.txt` |

（記録はすべて `docs/07c-lineage-recovery-results/`。R1〜R5 の DB は稼働中。途中でセッションの作業プロセスが再起動して DB が止まったが、それは R5 の後で、再起動して確かめてから以降を実行した — `environment.txt`）

分かったこと:

- 「修正前でも失敗する」は正しいが、**原因は F-01 でも DB でもなく、題材がコピーかどうか**（R1 と R2 の差）【実測】。
- 「16 件」は、ケース A（/lin-a）の 15 項目の失敗と、その結果を前提にした行で起きた例外 1 件。**残りのケース（並行・pushState・否定例・API・PID・停止と再起動）は一度も評価されていなかった**【実測、R2 と R3 の比較】。
- 例外を止めると（R3）、失敗は「server-call-stack で取得位置を特定することが前提の項目」だけに出る。並行の後の由来・e-either（候補2件）・d-dynamic（候補4件）・同名の変数・同じ SQL の2か所・`count(*)` のテーブル。**「結ばない」が正解の否定例（定数・環境変数・同名の局所変数・pushState・文書の偽装）はすべて通過**していた＝IDE は欠けた証拠を推測で補わず、未観測として表示していた【実測】。

---

## 3. 原因

### 3.1 どこで切れていたか（段ごと）

| 段 | R2（コピー・修正前） | 根拠 |
| --- | --- | --- |
| 1. 要素の選択・識別子（7B-2・F-01 の版） | 成立（`data-sel-at` = ソースの `<li>`） | R2 の記録 2 節 |
| 2. 文書の同定（中継の文書の識別子 → 通信） | 成立（`identified`・通信 #2） | 同上 |
| 3. 静的解析（PropBindingSite・参照の連鎖） | 成立（`{row.region}` の位置が一致） | 同上 |
| 4. SQL のスパンの観測（同じトレース） | 成立（SQL は観測されている） | 収集ファイルの `pg.query` スパン |
| 5. **SQL の呼び出し位置（server-call-stack）** | **不成立**。全 SQL の `callsite` 記録で `entry: null` → `no-entry-callsite`（`poc/runner/lib/rscattr.mjs:82`） | 収集ファイル（第3.2節） |
| 6. 取得位置の照合 → `supplies` | 5 が無いので `fetch-not-measured`「この文書の通信で実行位置を特定した SQL: なし」（`src/lib/liveLineage.ts:148-156`） | R2 の記録 |

### 3.2 なぜ entry が null になるか

- 計装の束は **IDE 側**にある。IDE は `NODE_OPTIONS=--require <IDE>/poc/fixture-app/ide-instrumentation/boot.cjs` で前置する（`src/server/ide.ts:60-61`、`src/server/devServer.ts:393`）【静的】。
- 呼び出しの入口でスタックを取る `patchCallsiteEntry()` は、修正前は素の `require('pg-pool')`・`require('pg')` で入口を包んでいた。素の `require` は**その束の位置から**解決するので、包むのは `<IDE>/poc/fixture-app/node_modules/pg` である【静的】。
- 対象のプロジェクトが自分の `node_modules/pg` を持つと、アプリはそちらを読む。実体（実パス・プロトタイプ）が別なので、アプリの `pool.query` は包まれておらず、スタックはコンテキストに載らない（`otel.cjs` の `callsiteProcessor.onStart` は `entry: null` を書く — スパン開始時のスタックで代用しない設計）【静的】。
- SQL のスパン自体は出る。OpenTelemetry の pg 計装は require のフックで、どの位置の pg にも当たるため【静的】。これが「SQL は観測されているのに結び付かない」の正体。
- 7C-3 で通っていたのは、題材が IDE の中の `poc/fixture-app` そのもので、**IDE 側の pg とアプリの pg がたまたま同じ実体**だったから。

実測の証拠:

1. 実体の比較: コピーでは `pg`・`pg-pool` とも、IDE 側から解決したものと題材から解決したものの実パスが違う（同一 false）。
2. Next.js を使わない最小の再現（同じ束・同じ環境変数・同じ `pool.query`）: 元の題材では `entry=pg-pool.Pool.query`、コピーでは `entry=null`。これを再現テストにした（第4.3節。修正前 15/8 で、失敗は欠陥の項目だけ）。
3. R2 の実行の収集ファイル: SQL の `callsite` 記録は全件 `entry: null`（`callsite-entry-patched` の知らせは出ている＝IDE 側の実体は包めていた）。

### 3.3 製品への影響（今回の修正前）

利用者の実在のプロジェクトは必ず自分の `node_modules` を持つ。したがって修正前は、**IDE の中の題材以外のどのプロジェクトでも、SQL の取得位置（server-call-stack）は特定できず、由来は必ず「未観測」で切れていた**【推定。根拠は第3.2節の機構と、IDE のリポジトリの外に置いたプロジェクトでの再現テスト（第4.3節 2）。実物の利用者プロジェクトでは確かめていない】。表示は誤りではなく安全側（未観測）だった。

### 3.4 原因ではなかったもの（確かめたこと）

| 候補 | 判定 |
| --- | --- |
| F-01 の版の照合・通信の版 3 | 無関係。R1（F-01 後のコード・元の題材）で 93/0。段 1〜3 は R2 でも成立 |
| DB の停止 | 無関係。R1〜R5 とも DB 稼働。R2 は SQL のスパンを観測している |
| 依存の版の違い | `npm ci`（lockfile どおり）で再現。7C-3 の版の記録は無いが、R1 が通るので原因ではない |
| Turbopack・ブラウザ・タイミング | R1 と R2 は同じ条件で、差は題材の位置だけ。R2 の失敗は再試行しても同じ（取り直しの待ちの間にも entry は付かない） |

---

## 4. 修正内容

### 4.1 計装: アプリが使う pg を包む（`poc/fixture-app/ide-instrumentation/otel.cjs:177-215`）

- `pg` を**アプリの起点**（`APP_DIR` = `process.cwd()`。IDE は開発サーバーを対象の直下で起動する）から `createRequire(<APP_DIR>/package.json).resolve('pg')` で解決し、`pg-pool` は**その pg の位置から**解決する（pg が内部で読む実体と同じになる。pg-pool が巻き上がらず pg の下に入れ子の配置でも当たる）。
- 解決できなければ包まない（`callsite-pg-missing` を知らせる）。IDE 側の pg を代わりに包んでもアプリの SQL には当たらないため。
- 知らせの文言は例外の1行目だけにした（`Require stack` の絶対パスを収集ファイルに書かないため）。
- 変えていないこと: 包み方（いちばん外側の呼び出しだけを残す）、計装の登録の後に当てる順序、スパン開始時のスタックで代用しない規則、IDE 側の照合（`src/server/dataAccess.ts`・`src/lib/liveLineage.ts`）。**推測で補う経路は足していない**。
- 増えた振る舞い: 前置の時点で、アプリの `pg` を（アプリより先に）読み込む。以前も IDE 側の pg を同じ時点で読み込んでいたので、読み込む回数は変わらない。読むのは対象のプロジェクト自身の依存で、同じプロセスでアプリが読むものと同じ。

### 4.2 試験: 前の項目の失敗で止まらないようにした（`tests/lineage-e2e.spec.mjs:472`・`:613`）

- `drew.id`（supplies の起点のノード）・`rDa.lineage.fetch.line` が `undefined`/`null` のとき例外になり、試験の残りが評価されなかった。
- 起点が無いときは、その項目（「右ドック（描いた位置）…」）を**失敗として数えて**続ける。`fetch` が無いときは `null` を比べて失敗にする。成立するときの検査・期待値・項目数（93）は変えていない。

### 4.3 再現テスト `tests/callsite-entry-unit.spec.mjs`（Next.js も DB も使わない）

OS の一時ディレクトリ（IDE のリポジトリの外）に使い捨てのプロジェクトを作り、pg の依存の閉包を複製して、計装の束を前置する。

| 節 | 内容 | 修正前 | 修正後 |
| --- | --- | --- | --- |
| 1 対照 | 題材が `poc/fixture-app`（IDE 側の pg = アプリの pg） | 通過 | 通過 |
| 2 自分の pg を持つ | `pool.query` の記録に入口のスタック、そのスタックにアプリの呼び出しの行、スパンとの対応、`Client.query` 直呼び、絶対パスを書かない | **失敗**（entry null） | 通過 |
| 3 入れ子の pg-pool | pg の下の pg-pool を包む | **失敗** | 通過 |
| 4 pg が無い | 落ちない・「見つからない」と知らせる・IDE 側の pg を包んだとは言わない・fetch は従来どおり | **失敗**（IDE 側を包んでいた） | 通過 |
| 計 | | **15 / 8**（`callsite-entry-unit-before-fix.txt`） | **23 / 0**（`…-after-fix.txt`） |

---

## 5. 由来を結んだ状態 × F-01 の照合（実ブラウザ）`tests/lineage-revision-e2e.spec.mjs`

F-01 の時点では由来を結べなかったため確かめていなかった組み合わせ（F-01 報告書 第6.2節・第8節 1）。使い捨てのコピー（`poc/out/lin-rev-e2e`、自分の node_modules を持つ＝実在のプロジェクトと同じ条件）を IDE で起動し、`select-revision-e2e` と同じ転送役（応答・要求の保留、HMR の保留）で操作する。正解は試験がソースを読んで決める。

結果: **77 / 0**（`docs/07c-lineage-recovery-results/lineage-revision-e2e.txt`、項目ごとの記録と由来の評価の応答 `lineage-revision-e2e.json`）【実測】。

| 節 | 操作 | 確かめたこと（すべて通過） |
| --- | --- | --- |
| 前提 | DB に届く・コピーの pg は IDE 側と別の実体・計装と注入が有効・HMR を中継 | — |
| 1 由来を結ぶ | /lin-a の `<li>{row.region}</li>` を選び、選択モードを抜けて経路を見る | `linked`・候補 `poc.listings.region`。応答の取得位置 = ソースの `pool.query`（`src/app/lin-a/page.tsx:12:24`、試験がソースから求めた位置と一致）、結びついた SQL のスパン 1 本（通信 #3 のトレース）、照合した要素 = 選んだ要素。右ドック「この値の出所 poc.listings . region（推定）」、キャンバスに「由来は静的解析による推定」とカラムのノード。画面 `lin-rev-1-linked.png` |
| 2 遅れて届く「結べた」応答 | 由来の評価の応答（サーバーは変更前に評価＝`linked`）を転送役で止め、その間に選んだファイルを変える | 版の確かめで選択を無効化。止めていた `linked` の応答が後から届いても、選択も由来も復活しない。右ドック・キャンバスに由来が無い |
| 3 無関係なファイル | 由来を表示したまま `src/app/listings/page.tsx` を変える | 5 秒待っても選択を解除しない。パネル・右ドック・キャンバスの由来を保つ |
| 4 選んだファイル | 由来を表示したまま `src/app/lin-a/page.tsx` の末尾にコメントだけ足す | `cleared`（`source-changed`）・理由の文言・右ドックに前の位置なし・`data-lineage` が linked でない・「この値の出所」なし・キャンバスの推定の語とカラムのノードなし。画面 `lin-rev-4-invalidated.png`。その後: HMR の後の DOM は前の文書に同定しない（`refetched-after-document`）。**同じ起動のまま読み込み直すと、文書は同定するが `fetch-not-measured`（呼び出し位置は `no-app-frame`）で切れる**＝第6節の制約。推測で結ばない |
| 5 古い DOM × 値の式の変更 | 起動し直して結んだ後、HMR を止めて `{row.region}` → `{row.id}` に変える（同じ行・列・タグ・コンポーネント） | 既存の選択を無効化。古い DOM（region の文字列）から選ぶと特定しない（`source-changed`）・**`poc.listings.id` を古い値の由来として出さない**。画面 `lin-rev-5-stale-dom.png`。HMR を戻した DOM は要素を新しい位置に特定するが前の文書の SQL は結ばない。起動し直すと新しいソースどおり `poc.listings.id` に結び、右ドックの「この値の出所」も id（region を言わない）。画面 `lin-rev-5-relinked-id.png` |
| 6 要求の途中の変更 | 由来の評価の要求をサーバーへ届く前に止め、その間に選んだファイルを変える | サーバーが要素を照合し直し `unresolved`・`source-changed`。前の選択に由来を付けない |
| 7 未観測 | /lin-g の `g-shadow`（列と同名の局所変数） | `cut` のまま・候補なし・右ドック「未確認」で「この値の出所」を出さない |
| 後片付け | — | 画面にエラーなし。使い捨ての題材のプロセスが残っていない |

補足:

- 1 回目の実行（`lineage-revision-e2e-run1-assertion-error.txt`、76/1）の失敗は**試験の誤り**だった。`SELECT id, region` は2列を返すので、キャンバスには実測した SQL の列として region のノードも正しく出る。「前の由来が残っていない」を右ドックの「この値の出所」で確かめる形に直した（製品は変えていない）。
- 最終の実行の転送役の記録で、上流に届かなかった要求が 2 件（`/api/runtime/observations`・`/api/runtime/status` の ECONNRESET）。開発サーバーの停止・起動の操作の間の画面の取得で、IDE の画面のエラーは 0 件。由来の判定には使っていない。
- 4・5 で「起動し直す」のは、第6節の制約を避けて「新しいソースで正しく結ぶ」ことを確かめるため。これ自体は F-01 の照合とは関係しない。

---

## 6. 別の原因による既知の制約（今回は直していない）

### 6.1 内容

**同じ開発サーバーの起動の中で、サーバー側のコードが HMR で差し替わった後は、SQL の呼び出し位置を src/ へ戻せない。** 読み込み直した新しい文書でも、由来は `fetch-not-measured`（呼び出し位置の特定は `no-app-frame`）で切れる。開発サーバーを起動し直すと結べる【実測、第5節 4・5】。

### 6.2 原因

診断スクリプト `docs/07c-lineage-recovery-results/hmr-frame-probe.mjs`（結果 `hmr-frame-probe.txt`）で、IDE と同じ計装の環境変数で `next dev` を起動し、/lin-a を要求 → ソースの末尾にコメント → 再要求 → 戻す → 再要求した【実測】。

| 回 | 実行時のスタックが指す位置（LinA の `pool.query`） | IDE の照合器で戻した結果 | ディスクの生成物のその位置 |
| --- | --- | --- | --- |
| 変更の前 | `.next/dev/server/chunks/ssr/[root-of-the-server]__1zojl8nvlw_s_._.js:33:142` | `src/app/lin-a/page.tsx:12:24` | `…["pool"].query('SELECT id, region FROM poc.listing…` |
| 末尾にコメントを足した後 | 同じファイル名の `:26:142` | `null` | `mascript$29$__`（`pool.query` ではない）。生成物とソースマップは書き直し済み（時刻が新しい） |
| 元に戻した後 | 同じファイル名の `:26:142` | `null` | 同上 |

同じ結果を2回得た（調査中の1回と、記録用に取り直した1回 `hmr-frame-probe.txt`）。

- 変更の前は `chunks/ssr/[root-of-the-server]__1zojl8nvlw_s_._.js:33:142` で、IDE の照合器（`poc/runner/lib/srvmap.mjs`）がソースマップで `src/app/lin-a/page.tsx:12:24`（`pool.query`）へ戻せる。
- 変更の後は、**同じファイル名**の `:26:142` を指す。ディスク上の同名の生成物は書き直されている（時刻が新しい）が、その位置には `pool.query` が無い。Turbopack はサーバー側の更新を、ディスクの生成物とは別の配置のコードとして同じファイル名で実行していると考えられる【推定。Turbopack の内部は読んでいない】。
- 照合器はディスクの生成物とそのソースマップで戻すので、戻せず `null` になる（`no-app-frame`）。推測で埋めない設計どおり、**誤った位置は出さず未観測**になっている。

### 6.3 残るリスク（未観測）

7B-3B-1 の鮮度の照合は「SQL の実行の後に生成物・ソースマップが書き換わっていない」を確かめるが、今回の観測は「実行の前に書き換わったディスクの生成物が、実行中のコードと一致しない」場合があることを示す。今回の実測では戻した位置が src/ に入らず `null` になったが、**偶然 src/ の別の行に戻ってしまう配置**がありえないとは言えない。その場合もソース行の読み直し（データ取得の呼び出しがあるか）とコンポーネントの2情報源の一致が残っているが、同じコンポーネントの別の `pool.query` の行に当たると取り違えうる。実際には観測していない【推定】。

### 6.4 直さなかった理由

直すには「HMR で差し替わったモジュールを、どの生成物・ソースマップで戻すか」または「HMR の後の記録をどう信用しないか」を決める必要があり、照合の設計の変更になる（指示 3: 大幅な設計変更は推測で実装しない）。いまの振る舞いは安全側（未観測）なので、F-01 の安全性・今回の 16 件の解消とは独立している。次の作業の候補として第9節に置いた。

---

## 7. テスト結果

実行条件: 第2節と同じ（DB 稼働、`PW_CHANNEL=none`、直列）。スキップ（⊘）は全試験で 0 件。記録は `docs/07c-lineage-recovery-results/<名前>.txt`。

| 試験 | 題材 | 成功 | 失敗 | スキップ | 備考 |
| --- | --- | --- | --- | --- | --- |
| `lineage-e2e`（元の題材） | `poc/fixture-app` | 93 | 0 | 0 | 修正前も 93/0（R1）。修正後 R5 |
| `lineage-e2e`（コピー） | `poc/out/select-e2e/…` | 93 | 0 | 0 | 修正前 10/16（F-01 と同じ 16 件）→ 修正後 R4。**失敗していた 16 件はすべて通過** |
| `lineage-revision-e2e`（新規） | `poc/out/lin-rev-e2e/…` | 77 | 0 | 0 | 第5節。1 回目 76/1 は試験の誤り（第5節 補足） |
| `callsite-entry-unit`（新規） | 一時ディレクトリ | 23 | 0 | 0 | 修正前 15/8 |
| `select-revision-e2e`（F-01） | `poc/out/f01-e2e/…`（試験が作る。DB なし） | 104 | 0 | 0 | F-01 の記録と同じ項目数 |
| `select-revision-unit`（F-01） | — | 50 | 0 | 0 | |
| `select-e2e` | コピー（DB あり） | 86 | 0 | 0 | F-01 の記録と同じ |
| `preview-e2e` | コピー（DB あり） | 78 | 0 | 0 | F-01 の記録と同じ |
| `select-unit` | — | 101 | 0 | 0 | |
| `lineage-live-unit` | — | 157 | 0 | 0 | |
| `observe-unit`・`queries-unit`・`preview-gateway` | — | 153・126・132 | 0 | 0 | |
| `poc02`（rscattr・srvmap の照合器）・`poc03` | — | 129・95 | 0 | 0 | |
| `npm run typecheck` | — | エラーなし | | | |
| `observe-e2e` | `poc/fixture-app` | 86 | 0 | 0 | 7C-3 と同じ |
| `queries-e2e` | `poc/fixture-app` | 121 | 0 | 0 | **2回目**。1回目は 120/1（`queries-e2e-run1.txt`）: 「IDE の画面にエラーが出ていない」が、試験の転送役の 502（上流への接続の失敗。`tests/queries-e2e.spec.mjs:122`）1件で不成立。直前は第9節の停止・再起動。どの要求かは記録が無く、原因は特定していない。2回目（`queries-e2e-run2.txt`）では出なかった。計装の変更は開発サーバー側だけで、IDE の API・中継の応答には関係しないと考えるが【推定】、断定はしない |
| `runtime-e2e` | `poc/fixture-app` | 56 | 0 | 0 | `localhost:3100` で IDE を起動して実行（`test-all-29.sh` と同じ前提。最初は IDE を起動せずに回して失敗＝試験の前提の不足で、記録は置き換えた） |

実行していないもの: `scripts/test-all-29.sh` の残り（`poc01`・`explore`・`measured`・`elements`・`poc05`・`flows`・`rsc`・`poc04`・`lineage`・`sqlparse`・`sqlimpact`・`model`・`project-inspect`・`devserver`・`devserver-stub`・`childenv-origin`）。今回の変更（計装の pg の解決）にかかわる実ブラウザの試験（`observe-e2e`・`queries-e2e`・`runtime-e2e`・`lineage-e2e`）は回した。残りは成功扱いにしない（時間の制約）。

---

## 8. F-01 への影響

- **F-01 の照合は撤回・弱体化していない。** `src/` は変えていない（`git diff 09c3dee -- src` は空）。
- 由来を結んだ状態でも、選んだ要素のファイルの変更で選択・由来・右ドック・キャンバスの由来が消える。古い DOM から選んでも、新しいソースの列（`poc.listings.id`）を古い値の由来として出さない。遅れて届いた「結べた」応答は捨てる。要求の途中で変われば、サーバーの照合し直しが `source-changed` で止める（第5節）【実測】。
- 無関係なファイルの変更では、結んだ由来を保つ【実測】。
- F-01 の既存の回帰（`select-revision-e2e`・`select-revision-unit`・`select-e2e`・`preview-e2e`・`select-unit`）は第7節のとおり。

---

## 9. 未検証事項・残るリスク・次の作業

| 区分 | 内容 |
| --- | --- |
| 既知の制約 | 第6節（同じ起動の中の HMR の後は呼び出し位置を戻せない。未観測として出る）。ユーザーテストで「コードを直した後に由来が出なくなった」と言われたときの原因の候補。試用の手引きに「コードを変えた後に由来を見るときは開発サーバーを起動し直す」を足すかを判断する |
| 残るリスク | 第6.3節（HMR の後に別の行へ戻る配置での取り違え）。未観測 |
| 由来が依存するファイル | 取得の呼び出しが、選んだ要素の祖先の DOM を持たないコンポーネント（フラグメントだけを返す等）のファイルにある場合、そのファイルの変更では選択を無効にしない（F-01 報告書 第6.2節のまま）。今回の題材（/lin-a は要素と取得が同じファイル）では確かめていない【未観測】 |
| 実物の環境 | 利用者の実在プロジェクト・実物の Codespaces では確かめていない。再現テストは IDE のリポジトリの外のプロジェクトで計装の振る舞いを確かめたが、Next.js の実物のプロジェクトでの由来の表示は未確認【未観測】 |
| webpack | 今回は Turbopack だけ。webpack（`bundler-virtual` の経路）では回していない【未観測】 |
| pg 以外 | Prisma は従来どおり入口を包まない（`no-entry-callsite`）。今回の修正は pg だけ |
| 全 29 本 | `test-all-29.sh` の全件は回していない。回したものは第7節（29 本のうち 13 本、F-01 の 2 本、新規 2 本） |

次に行うべき作業（推奨順）:

1. 第6節の制約の扱いを決める（設計: HMR 後の記録を信用しない印を付けるか、更新後の生成物から戻す経路を作るか）。決まるまでは試用の手引きに注意書きを足す。
2. `scripts/test-all-29.sh` を、題材のコピー（`VCIDE_E2E_PROJECT`）でも回す選択肢を足す。**題材が IDE の中にあると、今回の欠陥のように「IDE 側の依存とたまたま同じ」ことで通ってしまう**。
3. 利用者の実在プロジェクトで、由来が結べること（今回の修正の効果）を一度確かめる。
4. 新しい2本（`callsite-entry-unit`・`lineage-revision-e2e`）を全件の一覧（`package.json` の `test`、`test-all-29.sh`）に入れるか判断する（今回は一覧を変えていない）。

---

## 10. 変更の一覧

| ファイル | 変更 |
| --- | --- |
| `poc/fixture-app/ide-instrumentation/otel.cjs` | `patchCallsiteEntry` が包む pg・pg-pool を、アプリの起点から解決する（第4.1節） |
| `tests/lineage-e2e.spec.mjs` | 前の項目の失敗で例外にならないようにした2か所（第4.2節）。期待値は不変 |
| `tests/callsite-entry-unit.spec.mjs` | 新規。再現テスト（第4.3節） |
| `tests/lineage-revision-e2e.spec.mjs` | 新規。由来を結んだ状態 × F-01（第5節） |
| `docs/07c-lineage-e2e-recovery-report.md` | 本書 |
| `docs/07c-lineage-recovery-results/` | 実行記録・環境・診断スクリプト・画面 |

---

## 11. 完了条件の判定と引き継ぎ

| 完了条件 | 判定 | 根拠 |
| --- | --- | --- |
| 1. 16 件の失敗原因を証拠で説明できる | 満たす | 第2・3節（R1/R2 の比較、収集ファイルの `entry: null`、最小の再現、再現テストの修正前 15/8） |
| 2. 必要な修正と再現テスト | 満たす | 第4節（`otel.cjs`、`callsite-entry-unit`） |
| 3. lineage-e2e が全件成功 | 満たす | 元の題材・コピーとも 93/0（第7節） |
| 4. F-01 の既存の回帰が成功 | 満たす | `select-revision-e2e` 104/0、`select-revision-unit` 50/0、`select-e2e` 86/0、`preview-e2e` 78/0、`select-unit` 101/0、typecheck |
| 5. 由来の表示 × 版の無効化を実ブラウザで確認 | 満たす | `lineage-revision-e2e` 77/0、画面 4 枚（第5節） |
| 6. 実測・静的・推定・未観測の区別 | 満たす | 本文の【】の印。製品も、呼び出し位置を戻せないときは推測で補わず未観測として出す |
| 7. 未検証事項と既知の制約 | 明記 | 第6・9節 |

判定: **解消**。ただし第6節の制約（同じ起動の中の HMR の後は呼び出し位置を戻せない）は別の原因として残り、未対処。

引き継ぎ:

- ブランチ `claude/lineage-e2e-recovery-m3ab86`（基準 `09c3dee` の上に、本作業のコミットだけを積んだ。main へのマージ・強制 push はしていない）。
- 再現に要るもの: `npm ci`（ルート・`poc/fixture-app`）、`npm run build`・`npm run build:lib`、`poc/fixture-app/.env`（`.env.example` の複写。Git 管理外）、127.0.0.1:55432 の使い捨て PostgreSQL（`poc/README.md`）、Chromium（`environment.txt`）。
- `poc/out/`（使い捨てのコピー）と `.ide-runtime/` は Git 管理外。試験が作り直す。
