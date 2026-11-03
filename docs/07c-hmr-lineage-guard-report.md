# 7C HMR 後のリネージ誤対応の安全対策（案A: A1＋A2＋A3）— 実装報告

| | |
| --- | --- |
| 対象 | `docs/07c-hmr-lineage-safety-investigation.md` で再現した、サーバー側 HMR の後に SQL の呼び出し位置を取り違え、誤った DB カラムを「この値の出所」として表示する不具合 |
| 作業基準 | `claude/hmr-lineage-safety-investigation-enzr9f` @ `6b73e069f1695659bef71631554847f08bd51713`。作業ブランチ `claude/hmr-lineage-safety-guard-0490hg` は開始時点で同じコミット・作業ツリーはクリーン（未コミット・未追跡なし）・リモートと一致 |
| 実施日 | 2026-11-03 |
| 環境 | クラウドのコンテナ（Linux）。Node 22.23.4、IDE・題材とも Next 16.4.3（Turbopack・server fast refresh は既定のまま）、同梱の Chromium、使い捨ての PostgreSQL 16（127.0.0.1:55432）。詳細は `docs/07c-hmr-lineage-guard-results/environment.txt` |
| 実行記録 | `docs/07c-hmr-lineage-guard-results/`（修正前 `before/`・修正後・回帰 `suites/`・画面 `shots/`・診断） |
| **結論** | **部分完了。** 承認された案A（A1〜A3）を実装し、調査で再現した2つの機構（HMR で eval されたコード・要求の処理中の変更）による誤対応は、実ブラウザで止まることを確かめた。**しかし実装中に、A1〜A3 では止まらない第3の機構を見つけ、修正後も実ブラウザで誤ったカラム（`poc.regions.name`）を表示することを確認した**（第10.1節）。指示（前提が崩れたら完成扱いにせず報告して止まる）に従い、ここで止めて選択肢を示す。**ユーザーテストへは進めない**（第11節） |

記号: 【実測】この作業で動かして確かめた／【静的】コードを読んで確かめた／【推定】根拠からの推論で、動かしては確かめていない／【未観測】確かめていない。

---

## 1. 結論

1. **HMR による誤対応（調査の機構1）は防いだ。** 同じ起動のまま `hmr-m/page.tsx` にコメントだけを足して読み込み直すと、修正前は値 a の由来に `poc.regions.name`（誤り）を出したが、修正後は「値の由来 未確認」・理由 `fetch-callsite-unverifiable`（SQL は観測したが呼び出し位置を確かめられない／個々の SQL は `hmr-evaluated-code`）になり、右ドック・パネル・観測画面（キャンバス）のどこにも誤ったカラム・誤った呼び出し位置を出さない。同じモジュールを続けて3回変えても同じ【実測・実ブラウザ。第4・7節】。
2. **要求の処理中の変更（調査の機構2・in-flight）による誤った呼び出し位置も防いだ。** 修正前は観測画面の SQL b を「書き換え後のソースの a の行」に帰属させた。修正後は `changed-during-request` で位置を作らず、キャンバスに呼び出し位置のノードを描かない【実測・実ブラウザ】。
3. **無関係なファイル・共有の `lib/db.ts` の変更では、正しい由来を保った**（T3。修正前後とも `poc.listings.region`）【実測】。
4. **未解決: 第3の機構（同じ生成物に連結された「変更していない」モジュールの行のずれ）。** `page.tsx` だけを変えると、同じ生成物の後ろに入っている子コンポーネント `SA.tsx`（変えていない）の SQL b が SQL a の位置に帰属し、**修正後も**値 a の由来に `poc.regions.name` を出した【実測・実ブラウザ。第10.1節】。A1（フレームは eval ではない）・A2（2回目以降の要求では生成物の更新は要求の前）・A3（`SA.tsx` は変えていないので sourcesContent は一致）のどれにも当たらない。**最優先の受入条件（誤った由来を確認済みの証拠として表示しない）を、この機構では満たしていない。**
5. **A2 を承認どおり（要求の開始より後の生成物の更新も拒む）に実装した結果、各ページの最初のコンパイルの要求は未観測になる。** Turbopack は初回のコンパイルで、要求の開始の後・SQL の前に生成物を書く【実測】。読み込み直せば結ぶ。安全側の振る舞いだが、使い勝手への影響として判断事項に挙げる（第10.2節）。
6. A1〜A3 はそれぞれ単独で破った入力で止まることを単体で確かめた（独立した条件）。回帰の結果は第6節。

---

## 2. 修正前の再現結果

すべて修正前のコード（基準コミット、または製品の `src/`・`poc/` を変える前の `.next`・`.libjs`・計装）で実行した。

| 試験 | 結果 | 記録 |
| --- | --- | --- |
| 調査の再現（`hmr-misattribution-e2e.mjs`） | 起動直後 correct → **HMR の後 WRONG（`poc.regions.name`）** → 再起動の後 correct。前提の確認 10/0 | `before/hmr-misattribution-e2e.txt`・画面3枚 |
| 新規 `hmr-lineage-guard-e2e`（T0〜T4） | 21 件通過／26 件失敗。**T1・T4a・T4b・T4c がすべて WRONG（`poc.regions.name`）**。T2 は観測データで SQL b を `hmr-r/page.tsx:14:24`（書き換え後のソースでは a の行）に帰属＝**誤った呼び出し位置**。その後のキャンバスの表示操作は、HMR の再描画と競合して例外（試験の不備。修正後の試験で直した。T2 の修正前のキャンバスの画面は撮れていない） | `before/hmr-lineage-guard-e2e.{txt,json}`・`before/shots/` |
| 新規 `hmr-chunk-layout-e2e`（第3の機構） | 7 件通過／6 件失敗。**2a・2b とも WRONG（`poc.regions.name`）** | `before/hmr-chunk-layout-e2e.{txt,json}` |
| 新規 `hmr-guard-unit` | **27 件通過／42 件失敗**（通過は維持すべき基準・回帰の項目。失敗は A1〜A3 の新しい条件。parseCallsiteRecord・requestOfSql の節は例外で途中まで） | `before/hmr-guard-unit.txt` |

修正前に新たに分かったこと【実測】: 計装は `new Function` のコードのフレーム（`at eval (eval at <anonymous> (probe.cjs:8:22), <anonymous>:3:1)`）を、正規表現の解析で **`probe.cjs:8:22`＝eval を呼んだ側の位置**として記録していた。HMR の形（`?moduleId`）以外の eval でも、誤った位置を作りうる経路だった（A1 で閉じた）。

---

## 3. 実装した A1〜A3 の仕様

照合はすべて `DataAccessSite` を作る段（`src/server/dataAccess.ts` の `resolveDataAccess`）で行う。由来（`liveLineage.ts`）と観測の表示（`adapter.ts` の「実行した呼び出し位置」・コンポーネントのノード）は同じ結果を使うので、ここで止めれば両方が止まる（調査 第7.1節の設計どおり）。A1〜A3 のどれで止めた場合も `site` も参考の位置（`located`）も返さない。

### 3.1 A1 — HMR で eval されたコードのフレーム

- **計装**（`poc/fixture-app/ide-instrumentation/otel.cjs`）: フレームを `Error.stack` の文字列ではなく **V8 の呼び出し位置の API（CallSite）**から作る。`Error.prepareStackTrace` をその場だけ差し替えて CallSite を取り、すぐ戻す（Next.js の差し替えを壊さない）。
  - `CallSite.isEval()` が真のフレーム → `scope: 'evaluated'`・`file: '<evaluated>'`（**`?moduleId`・パスは記録しない**）。sourceURL に `?`／`#` が付くもの（Turbopack の HMR の形）も、`isEval()` が偽でも evaluated にする（二重の判定）。
  - 位置の無い組み込みの関数（`Array.map`・`new Promise`）→ `native`（ユーザーのコードではない）。位置があるのにファイル名が無いもの・`.next/` の下の `.js` 以外 → `unrecognized`。
  - 記録に作り方 `frameSource: 'v8-callsite'` を書く。CallSite を取れないときだけ文字列から作り `'stack-string'` と書く（IDE はこの記録を根拠にしない）。
  - 実測: `?moduleId` 付き・`?` 無しの sourceURL・`new Function` の3形とも `evaluated` になり、ディスクの生成物から読んだコードは従来どおり `build-output`（`hmr-guard-unit` 第1節）。`?` の無い sourceURL の eval は文字列ではディスクの生成物と区別できない形だが、`isEval()` で区別できた（Turbopack が形を変えた場合の検出漏れへの備え）。
- **記録の読み取り**（`parseCallsiteRecord`）: 根拠にしないと分かっている種別（`node_modules`・`node-builtin`・`outside`・`native`）だけを読み飛ばす。`evaluated` と**未知の種別**は黙って捨てず、印のフレーム（`<evaluated>`・`<unrecognized>`）として順序どおりに残す。従来どおりの形の検査（`..`・絶対パスの生成物を読まない）は変えていない。
- **照合**: `frameSource` が `v8-callsite` でなければ `frame-origin-unverified`。印のフレームより**外側（呼び出し元）を照合器に渡さない**（印を飛ばして外側の生成物のフレームを採らない）。印より内側にソースへ戻せるフレームが無ければ `hmr-evaluated-code`（印が eval）／`unrecognized-frame`（印が未知の形）。印より内側でフレームが決まった場合（呼び出し元だけが eval）は、その位置の座標は変わらないので従来どおり照合する。

### 3.2 A2 — 要求の開始からの鮮度

- **要求の特定**（`requestOfSql`）: その SQL と**同じトレースの受付スパン**（HTTP の受付・親なし・`instrumentation-http`）が**ちょうど1本**あり、SQL より前に始まっていること。まだ書かれていない（応答を送り終える前）・2本以上・時刻の向きが合わなければ特定しない → `request-start-unknown`。時刻の近さ・パスでは探さない。観測の台帳はこの結果を**使い回さず**、受付スパンが書かれた後に照合し直す（`hmr-guard-unit` 第4節）。
- **判定**: 生成物・ソースマップ・戻した先のソースのどれかの更新時刻が `要求の開始 − 2,000 ms` **以上**なら `changed-during-request`（同時刻は「書き換わった」とみなす。2 秒の幅は、ファイルシステムの更新時刻が粗い時計で数 ms 古く付くこと・1〜2 秒単位のファイルシステムを吸収するため。幅は安全側＝未観測が増える側にだけ倒れる）。読めないファイルも書き換わったとみなす（ソースマップが別ファイルとして無い＝インラインの場合を除く）。
- 既存の D（SQL の実行の後の書き換え → `build-changed-after-call`・`source-changed-after-call`）は残し、先に判定する（より具体的な理由を返す）。
- 対象は「位置を戻した生成物とその隣のソースマップ・戻した先のソース」だけ。無関係なファイルの書き換えでは止めない（T3）。
- **時刻の比較は同一性の証明ではない。** A2 は A1・A3 と併せて使う（第10節）。

### 3.3 A3 — ソースマップの区画の sourcesContent といまのソース

- `srvmap.mjs` に `serverFrameProvenance`（`resolveServerFrame` と同じ読み込み・同じ区画の選び方で戻し、**そのとき使った区画**の `sourcesContent` を返す）と `compareMapSource` を足した。`srcmap.mjs` に区画の番号と `sourcesContent` を返す `originalPositionDetail` を足した。**既存の `resolveServerFrame`・`originalPositionFor` の振る舞いは変えていない**（PoC-02 の照合器が共有）。
- 照合: 戻した位置が `resolveServerFrame` の結果（照合器が使った位置）と一致することを確かめてから比べる（一致しなければ `map-source-unverified`）。
- 比較（**正規化しない・バイト単位**）: 一致とみなすのは sourcesContent が (1) いまのソースそのもの、または (2) いまのソースに IDE が持つ要素識別子のローダ（`poc/anchor/transform.cjs`）の変換を同じ規則で当てた結果、のどちらかと等しいときだけ。実測で、Turbopack の `.tsx` の sourcesContent は (2) と、`.ts` は (1) と完全に一致した。
- sourcesContent が無い・null・ソースを読めない・変換器を読めない → `map-source-unverified`（一致とは扱わない）。それ以外の不一致 → `map-source-mismatch`。空白1文字・改行コードだけの差でも不一致（`hmr-guard-unit` で確認）。比較とローダの変換は決定的（同じ入力で同じ結果）【実測】。
- **いまのソースとソースマップが一致しても、実行中のコードと一致するとは限らない**（第3の機構がまさにそれ。第10.1節）。

### 3.4 失敗理由の表示（`src/lib/liveObservation.ts`・`liveLineage.ts`）

| 区別 | 観測画面（SQL の「実行した呼び出し位置」） | 由来（パネル・右ドック） |
| --- | --- | --- |
| SQL そのものを観測できなかった | （SQL のノードが無い） | `fetch-not-measured`（従来どおり） |
| SQL は観測したが呼び出し位置を確かめられない（A1〜A3・実行の後の書き換え） | 「特定していません — サーバー側のコードが…更新された…開発サーバーを再起動すると確認できる場合があります」など理由ごとの文言 | **新設 `fetch-callsite-unverifiable`**「この文書の通信で SQL は観測しましたが、その呼び出し位置を確かめられません…」＋詳細に理由のコード |
| ソースが変更され、証拠の鮮度が失われた | `changed-during-request`・`source-changed-after-call` など | 同上（詳細に理由）。文書の取得の後の変更は従来どおり `source-changed-after-run` |
| ソースマップとソースが一致しない | `map-source-mismatch`／`map-source-unverified` | 同上 |

- 未観測の理由は、照合が実際に止まった条件だけを書く（推定で理由を決めない）。
- 由来は「確かめられない SQL があり、静的解析の取得の位置で特定できた SQL が無い」ときだけ `fetch-callsite-unverifiable` にする。確かめられた SQL が静的解析の位置と一致していれば、同じ文書のほかの SQL が確かめられなくても従来どおり結ぶ（T3・単体）。
- `fetch-callsite-unverifiable` は画面の再取得の対象（`LivePreview.tsx` の `LINEAGE_TRANSIENT`）に足した（`request-start-unknown` は受付スパンが書かれれば解ける）。

---

## 4. 変更したファイルと理由

| ファイル | 変更 | 理由 |
| --- | --- | --- |
| `poc/fixture-app/ide-instrumentation/otel.cjs` | フレームを CallSite から作り `evaluated`／`native`／`unrecognized` の印と `frameSource` を記録。`.next/` の `.js` 以外を `unrecognized` に | A1（証拠を計装段階で捨てない） |
| `src/server/dataAccess.ts` | `parseCallsiteRecord` が印・未知の種別を残す。`resolveDataAccess` に A1・A2・A3。`requestOfSql`・`FRESHNESS_MARGIN_MS` | A1〜A3 の照合 |
| `src/server/observations.ts` | SQL ごとに `requestOfSql` で要求を渡す。`request-start-unknown` を使い回さない | A2 |
| `poc/runner/lib/srvmap.mjs` | `serverFrameProvenance`・`compareMapSource` を追加（既存の関数は不変） | A3 |
| `poc/runner/lib/srcmap.mjs` | `originalPositionDetail` を追加（既存の関数は不変） | A3（使った区画の特定） |
| `src/lib/liveObservation.ts` | 失敗理由7つ・文言、`CALLSITE_UNVERIFIABLE_REASONS`、由来の切断理由 `fetch-callsite-unverifiable` | 第8節の表示 |
| `src/lib/liveLineage.ts` | 「SQL は観測したが位置を確かめられない」を `fetch-not-measured` と区別 | 同上 |
| `src/components/panels/LivePreview.tsx` | `fetch-callsite-unverifiable` を再取得の対象に（1行） | 同上 |

変えていないもの: F-01 の照合（`src/server/anchors.ts`）、静的解析（`lineage.mjs`）、文書の同定（`bindDocument`）、`rscattr.mjs`、開発サーバーの起動引数（案A′ は実施していない）、IDE の中の題材 `poc/fixture-app/src`（新しい題材は使い捨てのコピーにだけ置く）。

---

## 5. 追加・変更したテスト

### 5.1 追加

| ファイル | 種類 | 内容 |
| --- | --- | --- |
| `tests/hmr-guard-unit.spec.mjs` | 単体（DB・ブラウザ・Next.js なし） | 計装の A1 の印（本物の計装を前置した Node で eval／new Function／ディスクの生成物から `pool.query`）・`parseCallsiteRecord`・A1〜A3 の各条件と **T5 の異常系**（sourcesContent が無い・ソースマップが古い・要求の開始を確かめられない・eval のフレーム・未知のフレーム・作り方の無い記録）・使った区画の特定・決定性・正規化で差を消さないこと・`requestOfSql`・観測の台帳・由来の理由の区別 |
| `tests/hmr-lineage-guard-e2e.spec.mjs` | 実ブラウザ（IDE・Next.js・DB・HMR） | T0（初回のコンパイル／基準）・**T3**（無関係・共有の lib）・**T1**（HMR の後の誤ったカラム。観測画面を含む）・**T4**（3回続けて変更＋再起動）・**T2**（要求の処理中の変更。観測画面を含む） |
| `tests/hmr-chunk-layout-e2e.spec.mjs` | 実ブラウザ | **第3の機構**（同じ生成物の後ろの、変えていないモジュール）。**修正後も失敗する**ことを隠さないための試験 |
| `tests/hmr-e2e-harness.mjs` | 共通部分（試験ではない） | 使い捨ての題材・IDE・転送役・ブラウザの起動と操作（調査の `hmr-misattribution-e2e.mjs` から複写） |

題材はすべて使い捨てのコピー（`poc/out/…`）に置く。題材が IDE の中にあることで欠陥が隠れないよう、IDE の中の `poc/fixture-app` には足していない。

### 5.2 変更（期待値・入力）

| ファイル | 変更前 | 変更後 | 根拠 |
| --- | --- | --- | --- |
| `tests/lineage-revision-e2e.spec.mjs:489-490`（**承認済み**） | 同じ起動でコードを変えた後: 由来 `cut`・理由 `fetch-not-measured`・候補なし／呼び出し位置の理由はすべて `no-app-frame` | 由来 `cut`・理由 **`fetch-callsite-unverifiable`**・候補なし／呼び出し位置の理由はすべて **`hmr-evaluated-code`** | 変更前の `no-app-frame` は「ずれた先がたまたまデータ取得の行ではなかった」偶然の未観測だった（調査 第4.3節）。案A では eval の印で止めるので理由が正確になる。**結ばない・候補なし・右ドックに出所を出さないは同じ**（弱めていない・正しい由来へは変えていない・案A′ は実施していない） |
| `tests/queries-unit.spec.mjs`（入力と照合の数） | 合成の記録に `frameSource` が無い・合成のソースマップに `sourcesContent` が無い・要求の開始を渡さない／成立時の照合の数 7 | 入力に `frameSource: 'v8-callsite'`・`sourcesContent`（いまのソース）・要求の開始を足した／照合の数 **10** | A1〜A3 が要求する証拠を入力に足しただけで、各項目の期待（成立・各理由）は変えていない。照合の数は A1・A2・A3 の3つを足した分。**この変更は事前の承認の範囲外なので、ここに明記する** |

また、試験の手順として、新しい e2e では「初回のコンパイルの文書」と「その書き込みから 2 秒以内の文書」が A2 で未観測になるため、基準の読み込みの前に 2.5 秒空けている（T0 では初回のコンパイルの文書も記録し、未観測になることを確かめている）。

---

## 6. テスト別の結果

### 6.1 回帰（`docs/07c-hmr-lineage-guard-results/suites/`）

| 本 | 通過 | 失敗 | 終了 | 備考 |
| --- | --- | --- | --- | --- |
| `poc01` | 56 | 0 | 0 |  |
| `explore` | 69 | 0 | 0 |  |
| `measured` | 48 | 0 | 0 |  |
| `poc03` | 95 | 0 | 0 |  |
| `elements` | 49 | 0 | 0 |  |
| `poc05` | 137 | 0 | 0 |  |
| `flows` | 44 | 0 | 0 |  |
| `poc02` | 129 | 0 | 0 |  |
| `rsc` | 61 | 0 | 0 |  |
| `poc04` | 143 | 0 | 0 |  |
| `lineage` | 76 | 0 | 0 |  |
| `sqlparse` | 77 | 0 | 0 |  |
| `sqlimpact` | 64 | 0 | 0 |  |
| `model` | 85 | 0 | 0 |  |
| `project-inspect` | 126 | 0 | 0 |  |
| `devserver` | 108 | 0 | 0 |  |
| `devserver-stub` | 71 | 0 | 0 |  |
| `runtime-e2e` | 56 | 0 | 0 |  |
| `childenv-origin` | 22 | 0 | 0 |  |
| `preview-gateway` | 132 | 0 | 0 |  |
| `select-unit` | 101 | 0 | 0 |  |
| `preview-e2e` | 78 | 0 | 0 |  |
| `select-e2e` | 86 | 0 | 0 |  |
| `observe-unit` | 153 | 0 | 0 |  |
| `observe-e2e` | 86 | 0 | 0 |  |
| `queries-unit` | 126 | 0 | 0 |  |
| `lineage-live-unit` | 157 | 0 | 0 |  |
| `queries-e2e` | 24 | 16 | 1 | **失敗** — 各ページの最初の文書の SQL が `changed-during-request`（初回のコンパイル。第10.2節）。その後の項目が例外で走っていない |
| `lineage-e2e` | 71 | 22 | 1 | **失敗** — 同上（最初の文書の由来が `fetch-callsite-unverifiable`）。誤ったカラムの表示は無い |
| `callsite-entry-unit` | 23 | 0 | 0 | 計装の入口（CallSite に変えた後も通る） |
| `select-revision-unit` | 50 | 0 | 0 |  |
| `select-revision-e2e` | - | - | 1 | この実行ではログを失った（記録の作業ミス。第6.1節の注）。**単独で再実行して 104／0**（`suites-rerun/`） |
| `lineage-revision-e2e` | 66 | 11 | 1 | **失敗** — 1・2 番の前提が初回のコンパイルで未観測。4 番は HMR の再取得が起きず、正しい位置（`lin-a/page.tsx:12:24`）で結んだ（第6.3節） |
| `hmr-guard-unit` | 78 | 0 | 0 | 新規 |
| `hmr-lineage-guard-e2e` | 52 | 0 | 0 | 新規（T0〜T4・T2） |
| `hmr-chunk-layout-e2e` | 7 | 6 | 1 | **失敗（意図して残した）** — 第3の機構（第10.1節） |
| `lineage-e2e`（題材のコピー `poc/out/lineage-copy`） | 68 | 25 | 1 | **失敗** — 原因は元の題材と同じ（`suites-copy/`） |
| typecheck（`tsc --noEmit`） | — | — | 0 | 型の誤りなし |

- 実行: `docs/07c-hmr-lineage-guard-results/run-suites.sh`（`scripts/test-all-29.sh` と同じ手順。全 29 本＋追加の 7 本を直列）。スキップ・環境上の未実行は無い（DB・ブラウザとも有り）。
- 元の 29 本のうち 27 本は通過、2 本（`queries-e2e`・`lineage-e2e`）は失敗。追加の 7 本では `lineage-revision-e2e` と `hmr-chunk-layout-e2e`（意図して残した）が失敗、`select-revision-e2e` は再実行で通過。`queries-e2e`・`lineage-e2e`・`lineage-revision-e2e` の失敗の原因は、記録を読んだ範囲ではすべて「各ページの最初の文書（初回のコンパイル）の SQL が A2 で止まる」こと（ログの `changed-during-request`）。**誤ったカラム・誤った呼び出し位置の表示ではない。** ただし `queries-e2e` は途中で例外になり、後半の項目は走っていない＝**この3本については、A2 以外の退行が無いことを確かめられていない**。切り分けは第6.3節の実験で行った。
- 注（作業ミスの記録）: 1回目の実行の途中で、記録の絶対パスを置き換える処理を実行中のログにも当ててしまい、`select-revision-e2e` のログと集計の行が失われた（終了コード 1 の原因は記録に残っていない）。同じ製品で単独で再実行し 104／0 だった。


### 6.2 修正前／修正後

| 試験 | 修正前 | 修正後 |
| --- | --- | --- |
| `hmr-guard-unit` | 27／42（失敗） | **78／0** |
| `hmr-lineage-guard-e2e`（T0〜T4・T2） | 21／26（失敗。T1・T4 で WRONG ×4、T2 で誤った呼び出し位置） | **52／0**（`hmr-lineage-guard-e2e.txt`。回帰の実行での結果は第6.1節） |
| `hmr-chunk-layout-e2e`（第3の機構） | 7／6（失敗。WRONG ×2） | **7／6（失敗。WRONG ×2）— 未解決** |
| `lineage-revision-e2e` 4 番 | `fetch-not-measured`／`no-app-frame` | `fetch-callsite-unverifiable`／`hmr-evaluated-code`（第5.2節） |

---

## 7. 実ブラウザでの証拠

画面は `docs/07c-hmr-lineage-guard-results/shots/`（修正後）と `before/shots/`（修正前）。

| 画面 | 内容 |
| --- | --- |
| `before/shots/guard-T1-after-hmr.png` | 修正前・T1: 右ドック「この値の出所 poc.regions . name」 |
| `before/shots/guard-T1-observation-canvas.png` | 修正前・T1 の観測画面: SQL b のコンポーネントのノードが `hmr-m/page.tsx:7`（SQL a の位置）に描かれる |
| `shots/guard-T0-baseline.png` | 修正後・基準: 「この値の出所 poc.listings . region」 |
| `shots/guard-T1-after-hmr.png` | 修正後・T1: 右ドック「値の由来 未確認」・切れた段階「実測との照合」・理由「…呼び出し位置を確かめられません…開発サーバーを再起動すると確かめられる場合があります（… hmr-evaluated-code）」 |
| `shots/guard-T1-observation-canvas.png` | 修正後・T1 の観測画面: SQL の呼び出し位置のコンポーネントのノードが無い |
| `shots/guard-T2-inflight-observation-canvas.png` | 修正後・T2 の観測画面: `hmr-r` の呼び出し位置のノードが無い（SQL・テーブル・カラムは実測として描く） |
| `before/shots/chunk-layout-2b.png`・`shots/chunk-layout-2b.png` | **修正前も修正後も**、右ドック「この値の出所 poc.regions . name」・根拠「実測した呼び出し位置（src/components/SA.tsx:5:24）が列まで一致」（第3の機構・未解決） |

注: 選択の無い観測画面の右ドックの見出し「この値の出所 poc.listings . 4 列 実測」（`guard-T2-…png`）は、表示中の通信の SQL が読んだ列の要約で、由来の主張ではない（従来からの表示。今回は変えていない）。

---

## 8. F-01 への影響

- F-01 の照合（DOM の版・対応表の版・いま読んだファイルの版の三者一致、`src/server/anchors.ts`）は**変えていない**。
- 実ブラウザの T1・T4 で、HMR の後に読み込み直して選んだ要素は F-01 を通っていまのソースの `<p>` に特定され（前提の確認）、その上で呼び出し位置の照合（A1）が止めた。F-01 の保証（選択した DOM がいまのソースに対応）と、呼び出し位置の保証は別の層のまま。
- 回帰: `select-revision-unit`・`select-revision-e2e`・`select-e2e`・`preview-e2e`・`select-unit` の結果は第6.1節。

---

## 9. 誤対応を防止できた範囲

| 機構 | 修正後 | 根拠 |
| --- | --- | --- |
| 1. サーバー側 HMR で eval されたモジュールの SQL（調査の機構1） | **防いだ**（A1）。変更したモジュールの SQL は再起動まで未観測 | T1・T4（実ブラウザ）・単体 |
| 2. 要求の処理中のソースの変更（in-flight。調査の機構2） | **防いだ**（A2。ソースがその要求の開始の後に書き換わった SQL を拒む） | T2（実ブラウザ・観測画面を含む）・単体 |
| ソースマップと現在のソースの食い違い（生成物が書き直されていない間にソースを変えた後の新しい要求） | **防いだ**（A3） | 単体（区画の特定・不一致・sourcesContent の欠落） |
| 無関係なファイル・共有の lib の変更 | 正しい由来を**保った** | T3（実ブラウザ） |
| 3. 同じ生成物の中の、変えていないモジュールの行のずれ | **防げていない** | 第10.1節 |

---

## 10. 未保証の競合条件・残るリスク

### 10.1 第3の機構（重大・未解決）: 同じ生成物に連結された「変えていない」モジュール

- **仕組み**【実測＋静的】: Turbopack は1つの生成物に複数のモジュールを連結する（`/hmr-s` では `page.tsx` が 3 行目から、子の `SA.tsx` が 55 行目から、`db.ts` が 86 行目から。`first-compile-timing-probe.mjs`）。`page.tsx` だけを変えると、server fast refresh は page のモジュールだけを eval し直し（その SQL は A1 で止まる）、`SA` は**前に `require` した生成物のコード（古い配置の行）のまま**実行される。ディスクの生成物は書き直され、`SA` の区画は後ろへずれる（55 → 62 行目）。古い行（SQL b の 79 行目）を新しいソースマップで戻すと `SA.tsx` の SQL a の行に当たる。
- **A1〜A3 が止めない理由**: A1 — `SA` のフレームは eval ではない（ディスクから読んだコード）。A2 — 変更の後の2回目以降の要求では、生成物の更新は要求の開始より前（ブラウザが HMR でつながっていると、生成物は保存の時点で書かれるので、1回目の要求でも前）。A3 — `SA.tsx` は変えていないので、`SA` の区画の sourcesContent はいまのソースと一致する。F-01 も `SA.tsx` の版は変わっていないので通る。
- **結果**: 実ブラウザで、修正後も値 a の由来に `poc.regions.name` を出し、根拠に「実測した呼び出し位置（SA.tsx:5:24）が列まで一致」と書く（`hmr-chunk-layout-e2e.txt`・`shots/chunk-layout-2b.png`）。製品の関数の段の診断（`chunk-layout-probe-default.txt`）でも、変更の後の2回目の要求で SQL b → `SA.tsx:4:24`（誤り）。
- **`--no-server-fast-refresh`（案A′）では起きなかった**【実測・診断のみ】: 変更の後は生成物が読み直され、`SA` のフレームが新しい配置（79/86 行目）になり、3本とも正しい位置（`chunk-layout-probe-nsfr.txt`）。ただし案A′ は今回の採用範囲外で、実施していない。
- 起きる条件: 同じ生成物の中で、変えたモジュールより後ろにある、変えていないモジュールが SQL を実行し、ずれた先がいまのソースでデータ取得の行で、囲むコンポーネントと静的解析の取得位置が列まで一致し、その SQL の SELECT 句に参照の鍵があること。題材のように意図して置かなくても、子コンポーネントに取得が複数ある実在のコードでは起こりうる【推定】。頻度は未観測。
- 修正後の既存の題材（`lineage-e2e` 等）でこの機構が誤対応を起こすかは確かめていない（既存の試験は同じ起動の中でページを変えて別の子を選び直す手順を持たない）【未観測】。

### 10.2 A2 の初回のコンパイル（使い勝手。安全側）

- Turbopack は、まだコンパイルしていないページへの最初の要求の中で生成物を書く（要求の開始 +245 ms、SQL +373 ms。`first-compile-timing-probe.mjs`）。承認どおり「要求の開始より後の生成物の更新」を拒むので、**各ページの最初の要求と、生成物の書き込みから 2 秒以内に始まった要求の SQL は未観測**（`changed-during-request`）になる。読み込み直せば結ぶ（T0）。
- 時刻だけでは「初回のコンパイル（実行するコードは新しい生成物から読まれる＝正しい）」と「保存から適用までの間（古いコードが動く）」を区別できない。区別するには実行コードの同一性の証拠が要る（第12節の選択肢 (a)）。

### 10.3 そのほかの未保証

| 項目 | 状態 |
| --- | --- |
| 保存から HMR の適用までの間に始まった要求（ディスクは新しく、実行中のコードは古い） | 生成物の書き込みが要求の開始の 2 秒前より後なら A2 で止まる。それより前に書かれ、まだ適用されていない場合は止まらない【推定】。第3の機構と同じ種類（実行中のコードの世代と生成物の不一致） |
| A1 の判定の依存 | V8 の `CallSite.isEval()`（Node の公開された API の一部）。`vm.runInThisContext` に filename を付けて実行したコードは eval と判定されず、ディスクの生成物と区別できない【実測（Node の挙動）】。Turbopack のサーバー側の生成物は `require` で読む【静的】 |
| A2 の時刻 | スパンの時刻（Date.now() 基準）とファイルの更新時刻（同じ機械のカーネルの時計）の比較。2 秒の幅を超える時計の跳び・ネットワークのファイルシステムの時刻のずれは扱っていない |
| A3 の比較 | IDE の要素識別子のローダと、題材が読み込むローダが同じ規則であることを前提にする（違えば不一致＝安全側）。BOM・改行コードの変換をバンドラが行う場合は不一致として未観測になる（過剰側）【未観測】 |
| webpack（`next dev --webpack`）・Next 15 | 実測していない。webpack の仮想モジュールは従来どおり照合 D の前段で拒む（`build-freshness-unverified`）【静的】 |
| Prisma など入口を包まないドライバ | 従来どおり `no-entry-callsite`【静的】 |
| サーバー内部の fetch（`server-fetch`） | 今回の範囲外（SQL だけ。従来どおり） |
| 複数の受付スパンを持つトレース | 特定しない（未観測）。実測では1本だった |

---

## 11. ユーザーテストへ進めるかの判定

**進めない。** 第3の機構により、サーバー側のコードを1か所変えて読み込み直すという IDE の主な使い方で、**誤ったカラムを「実測した呼び出し位置と列まで一致」という根拠付きで表示しうる**ことを、修正後の実ブラウザで確認した。最優先の受入条件を満たしていない。

暫定の運用（推奨しない・保証ではない）: 「サーバー側のコードを変えたら、由来を見る前に必ず開発サーバーを再起動する」。再起動の後は正しい由来に戻る（T4・第3の機構の手順3）。

完了条件の判定:

| # | 完了条件 | 判定 |
| --- | --- | --- |
| 1 | HMR 後の誤った DB カラム表示を防止できた | **一部**（機構1は防いだ。第3の機構は防げていない） |
| 2 | 実行中の変更による誤った呼び出し位置表示を防止できた | 満たす（T2） |
| 3 | A1〜A3 がそれぞれテストされている | 満たす |
| 4 | 証拠が欠落した場合、安全側に停止する | 満たす（T5） |
| 5 | 無関係な変更では正しい由来を維持できる | 満たす（T3） |
| 6 | 既存の F-01 安全対策が維持されている | 第6.1節 |
| 7 | 既存のリネージ機能が退行していない | 第6.1節（各ページの最初のコンパイルの要求は未観測になる＝第10.2節） |
| 8 | 新規テストと回帰テストが成功している | **満たさない**（`hmr-chunk-layout-e2e` が失敗。意図して残した） |
| 9 | 未保証のケース・対応できない環境が明記されている | 満たす（第10節） |
| 10 | 観測・静的解析・推定・未観測を混同していない | 満たす（第3.4節） |

---

## 12. 次の推奨作業（判断事項）

第3の機構を閉じる選択肢（いずれも今回の承認範囲の外なので、実施していない）:

| 案 | 内容 | 第3の機構 | 費用・影響 |
| --- | --- | --- | --- |
| **(a) 実行コードの同一性の照合（推奨）** | 計装が、生成物を `require` で読み込んだときの内容のハッシュ（または V8 の CallSite のスクリプトのハッシュ）を記録し、IDE が照合に使うディスクの生成物の内容のハッシュと一致することを確かめる | 閉じる（古い配置のコードは別のハッシュ）【推定】 | 計装と照合の追加。保存〜適用の間も閉じ、A2 の初回のコンパイルの未観測も解ける（読み込んだ内容がディスクと同じなら正しい）【推定】。調査の案B の「世代の識別」の一部に当たるため、承認が要る |
| (b) 案A′（`--no-server-fast-refresh`） | 開発サーバーを server fast refresh なしで起動 | この配置では起きなかった【実測・診断】 | 開発サーバーの振る舞いを変える。安全の保証ではない（in-flight は A2 が別に要る）。A1〜A3 と併用 |
| (c) 生成物単位の無効化 | 同じ起動の中で書き直された生成物を指す、eval でないフレームはすべて拒む | 閉じる【推定】 | 時刻・状態による推論。`--no-server-fast-refresh` では過剰に拒む。案D より狭いが同じ系統 |
| (d) 案C（ビルド時の識別子） | 呼び出し位置の識別子を実行コードに埋め込む | 構造的に閉じる | 最も大きい |

推奨: **(a) を次の段階で実装し、第3の機構の試験（`hmr-chunk-layout-e2e`）が通るまでユーザーテストへ進まない。** (b) は (a) の前の暫定策として判断事項にする。

新しいセッションへの引き継ぎ:

- ブランチ `claude/hmr-lineage-safety-guard-0490hg`（コミットは第13節）。基準は `6b73e06`。
- 再現に要るもの: `npm ci`（ルート・`poc/fixture-app`）、`npm run build`・`npm run build:lib`、`poc/fixture-app/.env`（`.env.example` の複写）、127.0.0.1:55432 の使い捨て PostgreSQL、Chromium（`PW_CHANNEL=none`）。
- 試験: `node tests/hmr-guard-unit.spec.mjs`／`PW_CHANNEL=none node tests/hmr-lineage-guard-e2e.spec.mjs`／`PW_CHANNEL=none node tests/hmr-chunk-layout-e2e.spec.mjs`（**失敗するのが現状**）。全件は `bash docs/07c-hmr-lineage-guard-results/run-suites.sh <出力> <本…>`（`scripts/test-all-29.sh` は本数の検査が 29 本のままで、36 本の現状では止まる。元のスクリプトは変えていない）。
- 診断: `docs/07c-hmr-lineage-guard-results/chunk-layout-probe.mjs [--nsfr]`・`first-compile-timing-probe.mjs`。
- 判断してほしいこと: (1) 第3の機構の対策（(a)〜(d)）、(2) 案A′ を暫定で使うか、(3) A2 の初回のコンパイルの未観測を (a) で解くまで許容するか、(4) `tests/queries-unit.spec.mjs` の入力と照合の数の変更（第5.2節）の承認。

## 13. Git

COMMIT_SECTION
