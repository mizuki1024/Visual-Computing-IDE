# 7C HMR 後のリネージ誤対応 — 最終安全対策（実行コードの版の照合）報告

| | |
| --- | --- |
| 対象 | `docs/07c-hmr-lineage-guard-report.md` 第10.1節の**第3の経路**（同じ生成物に連結された「変えていない」モジュールが古い配置のコードのまま動き、新しいソースマップで別の SQL の位置に誤対応する）と、A2 の過剰な未観測、`lineage-revision-e2e` 4 番の未解明 |
| 作業基準 | `claude/hmr-lineage-safety-guard-0490hg` @ `cdb9e07`（開始時: 作業ツリーはクリーン・リモートと一致）。作業ブランチ `claude/hmr-safety-branch-consolidation-qux5mr`（このセッションに割り当てられたブランチ。`6b73e06` から `cdb9e07` へ早送りしてから作業。履歴の書き換えなし） |
| 実施日 | 2026-11-03 |
| 環境 | クラウドのコンテナ（Linux）。Node 22.23.4、IDE・題材とも Next 16.4.3（Turbopack・server fast refresh は既定のまま）、同梱の Chromium 153（`PW_CHANNEL=none`。playwright-core 1.64 が探す 1248 に、入っている 1243 をリポジトリの外でシンボリックリンク — 前回と同じ）、使い捨ての PostgreSQL 16（127.0.0.1:55432・trust・`poc/fixture-app/db/init.sql`） |
| 実行記録 | `docs/07c-hmr-final-safety-results/`（診断 `identity-probe*`・`map-fit-probe*`、e2e `e2e/`・`lineage-revision/`・画面 `shots/`、回帰 `suites/`） |
| **結論** | **（回帰の結果で確定。第8節）** |

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

（回帰の結果を記入する）

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

（回帰の結果で確定する）
