# 7C HMR 後のリネージ誤対応 — 最終安全対策（実行コードの版の照合）報告

| | |
| --- | --- |
| 対象 | `docs/07c-hmr-lineage-guard-report.md` 第10.1節の**第3の経路**（同じ生成物に連結された「変えていない」モジュールが古い配置のコードのまま動き、新しいソースマップで別の SQL の位置に誤対応する）と、A2 の過剰な未観測、`lineage-revision-e2e` 4 番の未解明 |
| 作業基準 | `claude/hmr-lineage-safety-guard-0490hg` @ `cdb9e07`（開始時: 作業ツリーはクリーン・リモートと一致）。作業ブランチ `claude/hmr-safety-branch-consolidation-qux5mr`（このセッションに割り当てられたブランチ。`6b73e06` から `cdb9e07` へ早送りしてから作業。履歴の書き換えなし） |
| 実施日 | 2026-11-03 |
| 環境 | クラウドのコンテナ（Linux）。Node 22.23.4、IDE・題材とも Next 16.4.3（Turbopack・server fast refresh は既定のまま）、同梱の Chromium 153（`PW_CHANNEL=none`。playwright-core 1.64 が探す 1248 に、入っている 1243 をリポジトリの外でシンボリックリンク — 前回と同じ）、使い捨ての PostgreSQL 16（127.0.0.1:55432・trust・`poc/fixture-app/db/init.sql`） |
| 実行記録 | `docs/07c-hmr-final-safety-results/`（診断 `identity-probe*`・`map-fit-probe*`、e2e `e2e/`・`lineage-revision/`・画面 `shots/`、回帰 `suites/`） |
| **結論** | **完了（実装範囲の安全対策として）。** 第3の経路を閉じた: 変えていないモジュールの古い世代のコードは、実行したコードと同じ内容の区画がいまの生成物にあれば正しい位置へ戻し、無ければ未観測にする。実ブラウザで誤ったカラム（`poc.regions.name`）も誤った呼び出し位置も出さない（`hmr-chunk-layout-e2e` 7/6 → **25/0**）。A2 の初回のコンパイルの未観測を、安全側を保ったまま解いた。`lineage-revision-e2e` 4 番の原因を特定した（試験の前提の不成立）。**全件 37 本 3,187 件通過・0 件失敗・skip 0・未実行 0**、typecheck エラー 0。未保証の競合条件は第8.2節（理論上の狭い窓が残る）。ユーザーテストへは**条件付きで進めてよい**（第8.3節） |

記号: 【実測】この作業で動かして確かめた／【静的】コードを読んで確かめた／【推定】根拠からの推論／【未観測】確かめていない。

---

## 1. 第3の誤対応経路の原因

【実測（`identity-probe-default.txt`）＋静的（`next/dist/server/dev/hot-reloader-turbopack.js`）】

1. Turbopack は `/hmr-s` の `page.tsx`・子の `SA.tsx`・`lib/db.ts` を1つの生成物（`.next/dev/server/chunks/ssr/[root-of-the-server]__….js`）に連結する。生成物は Turbopack の実行時（`[turbopack]_runtime.js` 930・959 行）が **`require(resolved)` で読み込む**。
2. `page.tsx` だけを変えると、server fast refresh は page のモジュールだけを `eval` し直す（A1 で止まる）。Next の `onApplied` は**意図して `require.cache` を消さない**（「HMR-applied modules … must persist」）。そのため `SA` は**前に require した古い世代のスクリプト**のまま動く。
3. 一方ディスクの生成物とソースマップは書き直され、`SA` の区画は 55 行目 → 62 行目へずれる。古い行（SQL b の 79 行目）を新しいソースマップで戻すと `SA.tsx` の SQL a の行に当たる → 値 a の由来に `poc.regions.name`（誤り）。
4. 実測: 変更の後の要求で、SA のフレームの**実行中のスクリプトのハッシュは `5bf743b2…`（変更前の生成物）、ディスクの生成物は `504ad7c1…`**。再起動の後は両者が一致する。初回のコンパイルの要求でも一致する（Turbopack が要求の中で書いた生成物をそのまま require して実行している）。

A1（eval ではない）・A2（2回目以降の要求では生成物の更新は要求の前）・A3（SA.tsx は変えていないので sourcesContent は一致）のどれにも当たらないのはこのため。**原因は「実行したコードの世代」と「位置を戻すのに使った生成物の世代」が違うこと**で、時刻やファイル名では区別できない（同じパス・同じ時刻の範囲に複数の世代がある）。

## 2. 実行コードの版を取得する方法（調査結果）

| 調べたこと | 結果 |
| --- | --- |
| Node が読み込んだ生成物の内容をいつ取れるか | `Module.prototype._compile(content, filename)` の時点（require のとき）。`content` は実行するスクリプトそのもの【実測】 |
| require キャッシュと HMR の関係 | server fast refresh の適用（`onApplied`）は require キャッシュを消さない。変えたモジュールだけ eval（sourceURL に `?<moduleId>`）。全体の評価し直し（`reEvaluateAllModulesExpensive`）のときだけキャッシュを消す【静的】 |
| V8 の CallSite から実行スクリプトの版を特定できるか | **できる。** `CallSite.getScriptHash()` は実行中のスクリプトのソースの SHA-256 を返し、CommonJS で読んだファイルでは**ファイルの内容（UTF-8）の SHA-256 と一致**（ASCII・日本語・BOM・shebang・Latin-1 範囲の文字で一致を確認）。同じパスを読み直すと新しい値になる【実測（`/tmp` の Node 単体の確認・identity-probe）】 |
| 同じパスで複数世代のコードが動くか | 動く。変更の後も SA は古い世代（`5bf7…`）、page は eval の世代、ディスクは新しい世代（`504a…`）【実測】 |
| 生成物・ソースマップを書き換える順序 | **一定でない。** 1回目の実行は `.map → .js` の組を繰り返し、2回目は `.js → .js → .map → .map`。保存の時点ではなく、要求（またはブラウザの HMR の接続）の時点で書く【実測（fs.watch）】 |
| SQL 実行時のフレームとその世代の対応 | 入口（`Pool.query`）で取った CallSite の `getScriptHash()` がそのフレームのコードの世代そのもの【実測】 |
| 更新前後の生成物を安全に区別する方法 | 内容のハッシュ（スクリプト全体、またはモジュールの区画）。時刻・大きさ・ファイル名は使わない |

区画: Turbopack の生成物は行頭のモジュールの見出し（`"[project]/src/components/SA.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {` など4つの形を実測）で区切られる。**区画の内容が同じなら、その中のコードは同じ**（列も同じ）。変えていない SA の区画は、変更の前後で同じハッシュ（`dcdc4a5e…`）で、位置だけ 55 → 62 行目へ移る【実測】。

## 3. 実装した対策と保証範囲

照合はすべて `src/server/dataAccess.ts` の `resolveDataAccess`（由来・観測画面の両方がこの結果を使う）。A1〜A3・F-01 の安全対策は残した（A2 だけ第4節のとおり範囲を変えた）。

### 3.1 計装（`poc/fixture-app/ide-instrumentation/otel.cjs`・新規 `chunkregions.cjs`）

- 生成物（`.next/` の `.js`）のフレームに `scriptHash`（`CallSite.getScriptHash()`。16 進 64 桁でなければ付けない）を記録する。
- `Module.prototype._compile` を包み、アプリの `.next/` の `.js` を読み込むたびに、その内容から**モジュールの区画の表**（区画ごとの SHA-256・行の範囲）を作って内容のハッシュで覚える（内容は持たない。上限 4000 世代）。フレームには `moduleRegion: { hash, line }`（区画のハッシュと区画の先頭からの行）を記録する。モジュールの名前・絶対パスは記録しない。
- 区画の切り方は `chunkregions.cjs` の1つだけ（計装と IDE が同じファイルを読む）。

### 3.2 IDE の照合

| 照合 | 内容 | 止めたときの理由 |
| --- | --- | --- |
| **A4 実行コードの版** | A1 の印より内側の生成物のフレームを上から順に確かめる。(1) `scriptHash` ＝ ディスクの生成物の内容の SHA-256 → 位置はそのまま。(2) 違えば、`moduleRegion.hash` と同じ区画がディスクの生成物に**ちょうど1つ**ある → その区画の同じ行へ移す。(3) どちらでもなければそのフレームで切り、**外側のフレームを照合に渡さない**（A1 の印と同じ扱い）。src/ へ戻せる最初のフレーム（照合器が採るもの）まで確かめたら止め、その外側は渡さない | `executed-code-mismatch`（古い世代のコードが動いている）／`executed-code-unverified`（証拠が無い・読めない）。不一致で、その生成物が要求の開始の2秒前より後に書き換わっていれば `changed-during-request`（詳細に版の不一致を書く。時刻は**拒む側の理由の分類**にだけ使う） |
| **A5 読み直した組** | 位置を戻した後に生成物とソースマップを読み直し、(1) 生成物の内容が A4 で確かめたものと同じ、(2) ソースマップの内容が位置を戻すのに使ったもの（索引の中のもの）と同じ、(3) ソースマップがその生成物の内容に合う（`mapFit`: 各区画の開始がそれぞれ別のモジュールの区画の中・順序が同じ・src/ のモジュールの区画の元のソースがそのモジュール・そのセグメントが区画の中の行に収まる）、(4) 読む前後で更新時刻・大きさ・inode が変わらない | `build-map-unbound` |
| A1・A3・D・C・PoC-02 の4段 | 変えていない | 従来どおり |

- 由来（`liveLineage.ts`）は新しい3つの理由も `fetch-callsite-unverifiable`（SQL は観測したが位置を確かめられない）に入れる（`CALLSITE_UNVERIFIABLE_REASONS`）。観測画面は「特定していません — …」と理由の文言を出し、**参考の位置（located）も出さない**。
- 成立したときの照合の一覧は 7 → 10（前回 A1〜A3）→ **12**（A4・A5）。区画を移したときは13番目に「前の世代の同じ内容の区画へ移した（生成物:実行時の行→いまの行）」を書く。

### 3.3 保証範囲

- **第3の経路**: 変えていないモジュールの古い世代のコードは、(a) 同じ内容の区画がいまの生成物にあれば**正しい位置**（再起動の後と同じ）へ移して戻す、(b) 無ければ未観測。古い行を新しいソースマップで戻すことはしない【実測（e2e・単体）】。
- **区画の内容の一致が言えること**: 実行したコード（V8 のハッシュで特定したスクリプトの、その区画のテキスト）とディスクの生成物のその区画のテキストがバイト単位で同じ。A5 でソースマップがその生成物の組であることを確かめ、A3 でソースマップの sourcesContent がいまのソースと同じことを確かめるので、戻した位置は「実行したコードと同じコードの、いまのソースでの位置」になる。

## 4. A2 の改善内容

| ケース | 区別の方法 | 改善後 |
| --- | --- | --- |
| 初回のコンパイルで生成物が作られ、そのコードが実行された | 実行中のスクリプトのハッシュ ＝ ディスクの生成物（A4）。生成物の更新時刻は見ない | **特定する**（従来は `changed-during-request` で未観測） |
| 実行中の古いコードと異なる生成物へディスクが更新された | ハッシュ・区画の不一致（A4） | 止める（`changed-during-request`／`executed-code-mismatch`） |
| 要求の途中でソースが変更された | 戻した先のソースの更新時刻が要求の開始の2秒前より後（A2・従来どおり） | 止める（`changed-during-request`） |
| 同じ生成物の別モジュールだけが HMR された | 変えたモジュールは eval（A1）。変えていないモジュールは区画の一致（A4） | 変えたモジュールは止め、変えていないモジュールは正しい位置へ移す |

- A2 は**戻した先のソース**についてだけ要求の開始から見る。生成物・ソースマップの更新時刻による判定は、A4（実行したコードの内容の一致）と A5（読み直した組の一致）で**置き換えた**（緩めたのではない）。
- 単体（`hmr-guard-unit`）で、**同じ時刻の条件の対**を置いた: 「要求の処理中に生成物が書かれ、実行したコード＝その生成物 → 特定」と「同じ時刻で、実行したコード ≠ その生成物 → 止める」。ソースマップだけが要求の処理中に書かれた場合も「組が合えば特定／別の世代の並びなら `build-map-unbound`」の対。e2e では T2（要求の処理中の変更）が引き続き `changed-during-request` で止まる（第6節）。

## 5. 未解明だったテストの調査結果（`lineage-revision-e2e` 4 番）

診断として、プレビューの iframe の要求・ページが受けた HMR の通知（WebSocket）・IDE が観測した通信を記録した（期待値には使わない。`lineage-revision/run2-diag.txt`）。

| 項目 | 観測した事実 | 原因 |
| --- | --- | --- |
| A. 同じ起動でコード変更後（`fetch-callsite-unverifiable`／`hmr-evaluated-code` の期待が失敗。基準でも失敗） | 変更の後に読み込み直した文書の SQL は、**A4 を通って**正しい位置 `lin-a/page.tsx:12:24` で結ぶ。A4 が通る＝実行中のスクリプトがディスクの生成物とバイト単位で同じ＝**eval は起きていない**【実測】 | 試験の手順（末尾にコメントだけ足す → 無効化を待つ → **すぐ元に戻す**）では生成されるコードが変わらず、サーバー側の HMR が起きない。**試験の前提が成り立っていなかった**（製品の失敗ではない） |
| B. `refetched-after-document`（基準では通過・前回の修正後は2回失敗） | 変更の後にページが受けた HMR の通知は `building`・`built`・`isrManifest` だけで **`serverComponentChanges` が無く**、プレビューは **要求を1つも送っていない**。IDE が観測した通信も無い → 文書の同定は `identified`【実測】 | 再取得が起きていないので、DOM は文書のまま＝ `identified` が正しい。基準で通ったのは、コメントの変更の通知が戻す前に出た回だったため【推定（タイミングに依存。基準の記録では再取得があった）】。前回の推定（由来の再取得の時間差）は当たらない |

対処（期待値は変えていない）: 4 番の変更を「生成されるコードが変わる文を末尾に足す（要素・取得の位置・値の式は変えない）」にし、4 番の終わりまで戻さない。そのうえで**前提として「変更の後に /lin-a の RSC の再取得を送った」ことを確かめる**。待ち時間は延ばしていない。結果: `serverComponentChanges`（+616 ms）→ RSC の再取得（観測した通信 #4 `rsc /lin-a`）→ `refetched-after-document`、読み込み直した文書の SQL は `hmr-evaluated-code`・由来は `fetch-callsite-unverifiable`。**78／0**（`lineage-revision/run3-fixed.txt`）。

## 6. 全テスト結果

`bash scripts/test-all.sh docs/07c-hmr-final-safety-results/suites`（新設。`tests/*.spec.mjs` の 36 本を一覧と両向きに照合して直列に回し、題材のコピーでの `lineage-e2e@copy` を足した 37 本）。DB・ブラウザとも有り。**失敗 0・skip 0・未実行 0**（ログに skip の印なし。`lineage-live-unit` の「未実行の SQL」は試験項目の名前）。typecheck（`tsc --noEmit`）エラー 0（`suites/typecheck.log`）。

| 本 | 通過／失敗 | 前回（`cdb9e07`） | 本 | 通過／失敗 | 前回 |
| --- | --- | --- | --- | --- | --- |
| poc01 | 56/0 | 56/0 | observe-unit | 153/0 | 153/0 |
| explore | 69/0 | 69/0 | observe-e2e | 86/0 | 86/0 |
| measured | 48/0 | 48/0 | queries-unit | 126/0 | 126/0 |
| poc03 | 95/0 | 95/0 | lineage-live-unit | 157/0 | 157/0 |
| elements | 49/0 | 49/0 | **queries-e2e** | **122/0** | 24/16（途中で例外） |
| poc05 | 137/0 | 137/0 | **lineage-e2e** | **93/0** | 71/22 |
| flows | 44/0 | 44/0 | callsite-entry-unit | 23/0 | 23/0 |
| poc02 | 129/0 | 129/0 | select-revision-unit | 50/0 | 50/0 |
| rsc | 61/0 | 61/0 | select-revision-e2e | 104/0 | ログ消失・再実行 104/0 |
| poc04 | 143/0 | 143/0 | **lineage-revision-e2e** | **78/0** | 66/11 |
| lineage | 76/0 | 76/0 | hmr-guard-unit | 112/0 | 78/0（項目を足した） |
| sqlparse | 77/0 | 77/0 | hmr-lineage-guard-e2e | 52/0 | 52/0 |
| sqlimpact | 64/0 | 64/0 | **hmr-chunk-layout-e2e** | **25/0** | 7/6 |
| model | 85/0 | 85/0 | **lineage-e2e@copy**（題材のコピー） | **93/0** | 68/25 |
| project-inspect | 126/0 | 126/0 | | | |
| devserver | 108/0 | 108/0 | | | |
| devserver-stub | 71/0 | 71/0 | | | |
| runtime-e2e | 56/0 | 56/0 | | | |
| childenv-origin | 22/0 | 22/0 | | | |
| preview-gateway | 132/0 | 132/0 | | | |
| select-unit | 101/0 | 101/0 | | | |
| preview-e2e | 78/0 | 78/0 | | | |
| select-e2e | 86/0 | 86/0 | | | |

要求された確認項目の対応:

| 項目 | 結果（実ブラウザ） |
| --- | --- |
| 第3の経路（`hmr-chunk-layout-e2e`） | 変えていない SA の SQL a・b は正しい位置（`SA.tsx:5:24`・`:12:24`。再起動の後と同じ）、照合の記録に「前の世代の同じ内容の区画へ移した」。page の SQL は `hmr-evaluated-code`（HMR が起きた前提の確認）。`poc.regions.name` をパネル・右ドック・応答の候補に出さない。観測画面の描いた SQL の「実行した呼び出し位置」は正しい行か「特定していません」だけ（キャンバスは通信あたり 2 本まで描く — `LIVE_MAX_SQL`） |
| 複数回の HMR（T4a〜c） | どの SQL も呼び出し位置を作らない（`fetch-callsite-unverifiable`） |
| 要求の途中でのソース変更（T2） | SQL a・b とも `changed-during-request`、観測画面に呼び出し位置のノードを描かない |
| 無関係なファイル・共有の lib の変更（T3a・T3b） | 正しい由来を保つ（T3b の `lib/db.ts` は同じ生成物に入るが、page の区画が同じ内容なので A4 を通る） |
| 変更後の再要求（T1・2b） | T1 は未観測（eval）。2b は区画の一致で正しい位置 |
| 開発サーバー再起動後（T4・3） | 正しい由来に戻る |
| 初回のコンパイル（T0） | **正しく結ぶ**（前回は未観測） |
| F-01（select-revision-unit/e2e・select-unit/e2e・preview-e2e） | すべて通過。F-01 の照合（`src/server/anchors.ts`）は変えていない |

## 7. 試験の期待値・入力の変更

| ファイル | 変更 | 根拠 |
| --- | --- | --- |
| `tests/queries-unit.spec.mjs` | 前回の変更（`frameSource: 'v8-callsite'`・`sourcesContent`・要求の開始）を確認し承認の条件を満たすと判断。今回: 合成の生成物を Turbopack の形（モジュールの見出し＋sections のソースマップ）にし、フレームに `scriptHash` を足した。照合の数 10 → **12** | 入力の契約: `frameSource`・`scriptHash` は `otel.cjs` が書く形、`request` は `requestOfSql` が渡す形（ファイルを書いた後・SQL の前の要求の開始）、`sourcesContent` はいまのソースそのもの（`compareMapSource` が受ける2つの形の1つ。要素識別子の注入をした `.tsx` の実物はローダの出力の形になる — `hmr-guard-unit` で両方を試す）。各項目の期待（成立・各理由）は変えていない。数の増分は A1・A2・A3（前回）と A4・A5（今回）の5つ |
| `tests/queries-e2e.spec.mjs` | 「照合が7つ」→ **12**。あわせて、足した5つ（A1〜A5）の中身を文言で確かめる項目を足した | 上と同じ。数だけで済ませない |
| `tests/hmr-guard-unit.spec.mjs` | 合成の入力を実際の契約（`scriptHash`・Turbopack の区画）に合わせた。A2 の2項目（要求の処理中の生成物・ソースマップの書き換え → `changed-during-request`）を、第4節の**同じ時刻の条件の対**に置き換えた。A4・A5・区画の切り方・計装の `scriptHash`/`moduleRegion` の節（3b）を足した | A2 の生成物の判定を A4・A5 に置き換えたため。置き換えた後も、実行したコードが違えば止まることを同じ条件で確かめる |
| `tests/hmr-chunk-layout-e2e.spec.mjs` | 期待（誤ったカラムを出さない）は同じ。前提（HMR が起きた: page の SQL が `hmr-evaluated-code`）・正しい位置・A4 の区画の移し替えの記録・観測画面（描いた SQL の「実行した呼び出し位置」）の確認を足した | 「未観測にした」ではなく「正しく戻した」ことと、観測画面に誤った位置を出さないことを確かめるため |
| `tests/lineage-revision-e2e.spec.mjs` | 4 番の手順（第5節）と前提の確認・診断の記録 | 期待値は変えていない |
| `lineage-revision-e2e` の `no-app-frame` → `hmr-evaluated-code`（承認済み） | 今回は変えていない。実際に HMR が起きた条件で `hmr-evaluated-code` になることを確かめた | 第5節 |

## 8. 結論・未保証の競合条件・ユーザーテストへの移行判断

### 8.1 完了条件

| # | 条件 | 判定 |
| --- | --- | --- |
| 1 | 第3の経路で誤ったカラム・誤った呼び出し位置を出さない（由来・観測画面） | 満たす（`hmr-chunk-layout-e2e` 25/0） |
| 2 | 実行したコードの版を確かめ、照合に使った生成物・ソースマップの版と比べ、一致を示せたときだけ位置を確定 | 満たす（A4・A5。不一致・証拠不足は未観測） |
| 3 | 時刻・ファイル名だけで同一と推測しない | 満たす（同一性はハッシュだけ。時刻は拒む側の判定と理由の分類にだけ使う） |
| 4 | A1・A2（ソース）・A3・F-01 を維持 | 満たす |
| 5 | 初回のコンパイルの正常な取得を維持しつつ、実行コードと生成物が異なるケースを拒む | 満たす（第4節の対の単体・T0・T2・第3の経路） |
| 6 | 未解明の試験の原因 | 特定（第5節） |
| 7 | 全件の回帰 | 37 本・失敗 0 |

### 8.2 未保証の競合条件・前提

| 項目 | 内容 | 扱い |
| --- | --- | --- |
| 書き込みの途中の窓（同じ並びの組） | Turbopack は生成物とソースマップを別々に、順不同で書く。A5 の `mapFit` は「モジュールの並びがずれた組」を拒むが、**並びが同じで区画の中だけが違う組**（例: 1文字の変更）は区別できない（`map-fit-probe.txt` の js2+map3）。誤対応に至るには、ソースマップだけが新しく書かれた後、SQL がその前の世代のコードで実行され、IDE がその照合を**生成物が書かれる前に**終える必要がある。ソースマップが SQL の後に書かれれば D（`build-changed-after-call`）、変えたモジュールのソースが要求の 2 秒前より後に変われば A2、ソースマップが古ければ A3 で止まる | 【未観測】再現していない。2つの書き込みの間（実測で数 ms）に要求の処理と IDE の照合が収まる必要があり、起きにくいが、**証明はしていない** |
| V8 の `CallSite.getScriptHash()` | Node 22（V8）で利用可能・ファイルの UTF-8 の内容の SHA-256 と一致（実測）。無い・形が違う → `executed-code-unverified`（安全側） | 別の Node・別の読み込み方（`vm` など）では未観測になりうる（過剰側） |
| 区画の見出しの形 | Next 16.4.3 の Turbopack の4形を実測。形が変われば区画が取れず、生成物が書き直された後は `executed-code-mismatch`（安全側・過剰側） | Next の更新で見直す |
| 区画の表の上限 | 計装は 4000 世代まで覚える。超えた古い世代は区画を記録しない → 未観測（安全側） | |
| node_modules の区画 | A5 の 2・3 は src/ のモジュールの区画だけに当てる（同じ世代の組でも node_modules の区画は合わない — 実測）。位置を戻す先は src/ だけ | |
| webpack・Next 15・Prisma・サーバー内部の fetch | 前回と同じ（webpack は `build-freshness-unverified`、Prisma は `no-entry-callsite`、fetch は対象外） | 【静的】 |
| A2 の時刻の幅 | ソースについて 2 秒（前回と同じ） | |

### 8.3 ユーザーテストへの移行判断

**条件付きで進めてよい。** 第3の経路を含む既知の3つの誤対応の経路は、実ブラウザで止まる（または正しく戻る）ことを確かめ、全件の回帰も通った。主な使い方（サーバー側のコードを変えて読み込み直す・開発サーバーを再起動する）で、誤ったカラムを確かめた根拠として出す経路は、今回の試験の範囲では見つかっていない。

条件:
1. 第8.2節の「書き込みの途中の窓」は証明していない残余のリスクとして試用の手引きに書く（「コードを保存した直後に由来が出たら、もう一度読み込んで同じ結果になることを確かめる」）。
2. 試用は Next 16.4（Turbopack）・Node 22 の環境に限る（それ以外は未観測が増える・未検証）。
3. 試用で「由来が未確認」が多すぎるという声が出たら、理由（`executed-code-mismatch` など）の内訳を集める（過剰な未観測の量は実プロジェクトで未測定）。

## 9. 変更したファイル

| ファイル | 変更 |
| --- | --- |
| `poc/fixture-app/ide-instrumentation/otel.cjs` | フレームに `scriptHash`・`moduleRegion`。`Module.prototype._compile` で区画の表 |
| `poc/fixture-app/ide-instrumentation/chunkregions.cjs`（新規） | 区画の切り方（計装と IDE で共有） |
| `poc/runner/lib/srvmap.mjs` | `verifyExecutedFrame`・`mapFit`・`bindChunkAndMap`・`diskMapEntry`（使ったソースマップの内容のハッシュ）。既存の `resolveServerFrame` の振る舞いは変えていない |
| `src/server/dataAccess.ts` | A4・A5、A2 をソースだけに |
| `src/lib/liveObservation.ts` | 理由 `executed-code-mismatch`・`executed-code-unverified`・`build-map-unbound` と文言 |
| `scripts/test-all.sh`（新規） | 全件の実行（一覧の照合・題材のコピー）。`scripts/test-all-29.sh` は変えていない |
| 試験 | 第7節 |
| 診断 | `docs/07c-hmr-final-safety-results/identity-probe.mjs`・`map-fit-probe.mjs` と記録 |

## 10. 次の推奨作業

1. 探索機能の残条件の確認（試用の手引きに第8.3節の注意を足す）。
2. 実在のプロジェクト（子コンポーネントに取得が複数ある構成）で、未観測の量と理由の内訳を測る。
3. 視覚編集の再開の判断（`docs/git-branch-consolidation-report.md`。編集 PoC の F-01〜F-05 は未解決のまま）。
