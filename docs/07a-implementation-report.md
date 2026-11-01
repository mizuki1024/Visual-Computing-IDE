# Phase 7A 実施報告 — ローカル Next.js プロジェクトの選択・起動・停止

| | |
| --- | --- |
| 対象 | 実在するローカルの Next.js（App Router）プロジェクトを IDE の画面から指定し、開発サーバーを起動・確認・停止する |
| 位置づけ | `06f` 6.2節の MVP 移行計画の **M2**（段階1・2）。M3 以降は未着手 |
| 実施日 | 2026-11-01 |
| 新しい UI デザイン | **作っていない**。Phase 5 の浮かぶパネル（FloatingPanel）に載せただけである |
| Phase 7B（プレビュー・要素選択・観測情報の統合） | **着手していない** |
| 既存の観測記録（`src/data/observation.*.ts`） | **1バイトも書き換えていない** |
| 対象プロジェクトへの書き込み | **IDE は行わない**。ただし `next dev` 自身が書き込む事実がある（第6.3節） |

### 関連文書

`02a-object-model.md` 3.1節（`Project` / `SupportMatrix`）/ `03c-state-transitions.md` 8節 /
`03d-error-and-empty-states.md` 1.1節 / `06a-poc01-report.md`（方式2）/ `06f-integrity-review.md` 6.2節

---

## 0. 最初に確認したもの・確認できなかったもの

### 0.1 検証した環境は2つある

| | 環境 A（前半） | 環境 B（本書の後半の作業） |
| --- | --- | --- |
| OS | macOS | Linux（クラウド上のコンテナ） |
| リポジトリ | `/Users/mizuki/Visiual Computing IDE` | `/home/user/Visual-Computing-IDE` |
| ブラウザ | Chrome（playwright-core / channel: chrome） | Chrome 153（同） |
| 実在の外部プロジェクト | `memo-app` / `blog-app` / `kabu-dashbord` / `portfolio-site-1` がある | **無い**（`/Users/mizuki` が存在しない） |

**環境 B では、利用者の実在プロジェクト（`/Users/mizuki/*`）を1つも実行していない。**
環境 B で 15 系を確かめるために使ったのは、同じ構成（`src/app` / TypeScript / Next 15.5.5）で
**新しく組んだ最小のプロジェクト**であり、`memo-app` ではない（第4節）。

### 0.2 推測していないこと

- Next.js の振る舞いについて書いたことは、**インストールされている Next.js 16.4.3 のソースを読んで確かめた範囲**に限る
  （`next/dist/lib/find-root.js` / `next/dist/lib/verify-typescript-setup.js` /
  `next/dist/lib/typescript/getTypeScriptIntent.js`）。16.2.6 / 15.5.5 のソースは読んでいない。
- `blog-app` が180秒で応答しなかった原因（第6.2節）は、環境 A で記録した出力に基づく。環境 B では再現していない。
  画面とテストでは、**その出力の文言を真似た代役**で経路を確かめた（第5.3節）。

---

## 1. 採用したアーキテクチャと理由

```
ブラウザ（RuntimePanel）
   │  GET  /api/runtime/status   … 実プロセスを確かめてから返す（唯一の同期点）
   │  POST /api/runtime/project  … 検出（読むだけ）
   │  POST /api/runtime/start    … 検出し直してから起動。HTTP 応答を見て running
   │  POST /api/runtime/stop     … プロセスグループごと止め、ポートの解放まで見る
   ▼
Next の Route Handler（IDE 自身のサーバー）
   └─ DevServerManager（globalThis の単一実体）＋ .ide-runtime/dev-server.json（台帳）
        └─ spawn(node, [<対象>/node_modules/next/dist/bin/next, 'dev', -p, -H 127.0.0.1], { shell: false, detached: true })
             NODE_OPTIONS=--require <IDE>/poc/fixture-app/ide-instrumentation/boot.cjs   … PoC-01 方式2
```

| 決定 | 理由 |
| --- | --- |
| IDE 自身の Next サーバーの中でプロセスを管理する | 別のデーモンを立てない。IDE を起動すれば管理も起動する |
| 起動するのは対象の `node_modules/next/dist/bin/next` だけ。`shell: false` | **任意のコマンドを受け取る口を作らない**。`package.json` の dev スクリプトは読むが実行しない（所見で明示） |
| 計装は PoC-01 方式2（`NODE_OPTIONS=--require`）の再利用 | **対象プロジェクトにファイルを置かない**。方式2 は PoC-01 で成立を確認済み |
| 所有は globalThis の単一実体＋台帳ファイル | dev の HMR でモジュール変数は作り直される。IDE の再起動をまたぐには台帳が要る。**引き継ぐときに殺さない** |
| `running` は HTTP の応答を観測してから | 「起動コマンドを出した」と「応答がある」を混ぜない（指示 2.D）。状態コードは問わない |
| 画面は状態を作らない | 表示する状態はすべて `/api/runtime/status` の観測結果。応答の新旧は `seq` と `instance` で決める（第2.1節） |
| 入口の防御（`guard.ts`） | ループバック以外の Host・別オリジン・独自ヘッダ無しの変更操作を拒否する |

---

## 2. 今回直した残件（R1〜R4）

### 2.1 R2 — 起動中に画面が「未起動」のまま（実装の不具合）

| | |
| --- | --- |
| 症状 | ［起動する］を押してから応答が返るまで（最長180秒）、画面がクリック前の「未起動」を表示し続けた |
| 原因 | `RuntimeStore.tsx` の `poll()` が操作中（`pendingRef`）に早期 return していた。`start` は1回の POST なので、その間ずっと状態を取らなかった |
| 修正 | 操作中も取得を止めない。応答の入れ違いは **`isNewerSnapshot()`（`src/lib/snapshotOrder.ts`）だけで防ぐ** — 同じ `instance` なら `incoming.seq >= current.seq` のときだけ反映する |
| 追加で直したこと | ① `seq` は管理実体ごとに 0 から数え直すため、スナップショットに `instance`（UUID）を足した。IDE の再起動後に古い `seq` と比べて新しい観測を捨て続けることを防ぐ ② クリック直後は状態が `idle` なので取得間隔が 6 秒のままだった。**操作中は 500 ms 間隔で取る** |
| 確認 | `tests/devserver-stub.spec.mjs` 第0節（新旧判定5件・RuntimeStore に早期 return が無いこと）。E2E 第4節で、クリック後 5 秒以内に「起動中」になることを **実ブラウザで観測**（16.4.3 / 15.5.5 の両方） |

### 2.2 R1 — E2E が古い DOM を読んでいた（テストの不具合）

| | |
| --- | --- |
| 原因 | `typePath()` が `.rt-vd` の表示を待っていたが、前の検出結果が既に表示されていた |
| 修正 | `RuntimePanel.tsx` の `.rt-ins` に `data-input` / `data-verdict` / `data-checked-at` を付けた。テストは **入力したパスと一致し、かつ検出時刻が前と違う** 結果が出るまで待つ（同じパスの検出し直しにも効く） |

### 2.3 R3 — プロジェクトより上の lockfile（起動の前に言う）

`inspectProject()` が、プロジェクトより上の階層にある **Next.js がワークスペースのルートの推定に使うファイル** を探す。

| 探すもの | 根拠 |
| --- | --- |
| `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` / `bun.lock` / `bun.lockb` | Next 16.4.3 `find-root.js` の `LOCK_FILES` |
| `pnpm-workspace.yaml` / `lerna.json` / `workspaces` を持つ `package.json` | 同 `WORKSPACE_MARKERS` / `hasWorkspacesField` |
| **`workspaces` を持たない `package.json` は探さない** | 同ファイルでは推定に使われない（テストで確認） |

| 状況 | 所見 | 重大度 |
| --- | --- | --- |
| 上の階層にある / `next.config` に `turbopack.root`・`outputFileTracingRoot` の記述が無い | `ancestor-root-marker` | **limit**（起動は試せる。判定は「部分対応」） |
| 上の階層にある / 記述がある | `ancestor-root-marker-configured` | info（**値は評価していない**と明記） |

**どの候補を Next.js が採るかは決めない。** 16.4.3 はホームディレクトリと git リポジトリの境界より上を採らないが、
`blog-app`（16.2.6）では `/Users/mizuki` を採った出力が記録されている。バージョンで異なるため、
所見は「上の階層にファイルがある」という事実と、「ルートが広く推定されると初回コンパイルが終わらないことがある」
という起こりうることだけを書き、**「起動できなかった」を「プロジェクトが壊れている」と書かない**
（所見の③に「プロジェクトのコードの不具合を意味しません」と書く。テストで検査）。

あわせて、**180秒の平坦な待ちをやめた。**

- 起動中は経過秒と、Next.js が出した進み具合の最後の行（`Compiling` / `Ready in` など）を**解釈せずにそのまま**出す（`DevServerSnapshot.progress`）
- 待ちが切れたとき（`start-timeout`）、Next.js の出力にルートの推定を示す行がある、または起動前の検出で上の階層のファイルを見つけていれば、その証拠を理由に書く。
  ③は「時間内に応答を確認できなかったという事実だけがわかっています。プロジェクトのコードが壊れているかどうかは、この結果からはわかりません」

### 2.4 R4 — `next dev` 自身が対象プロジェクトのファイルを書き換える

**事実。** Next.js の開発サーバーは、TypeScript の構成のプロジェクトで起動時に次を行う（Next 16.4.3 のソースで確認）。

| 書き込み | 条件 | 出力 |
| --- | --- | --- |
| `tsconfig.json` の一部の項目を必要な値に書き換える | 書き換えが要るかは Next.js がその時点の内容で決める | `We detected TypeScript in your project and reconfigured your tsconfig.json file for you.` |
| `next-env.d.ts` を作成・書き直す | TypeScript の構成であること | 出さない |
| 不足する `typescript` / `@types/react` / `@types/node` をインストールする（`package.json` / lockfile / `node_modules` が変わる） | 依存が無いこと（CI 環境を除く） | `Installing dependencies` |

**この書き込みは IDE が行ったものではない**が、Phase 7A の方針「対象プロジェクトを無断で変更しない」と衝突する。
IDE は止めない（止める手段は `next dev` の振る舞いを変えることになる）。代わりに、**主体を明示して2回伝える。**

1. **起動前（検出の所見）**
   - `next-dev-writes-tsconfig`（info）— 「Next.js の開発サーバー（next dev）は … 書き換え … next-env.d.ts を作成します」「書き換えるのは next dev であり、IDE は対象プロジェクトに書き込みません」「この検出では事前に判定しません」
   - `next-dev-installs-typescript`（limit）— 依存が欠けているとき。「起動すると、IDE ではなく next dev が package.json・lockfile・node_modules を書き換えます」
2. **起動後（観測した事実）** — 起動直前に `tsconfig.json` / `next-env.d.ts` / `package.json` の内容の指紋（sha1）を取り、
   応答確認時・状態取得時・停止時に比べる。変わっていれば `targetChanges`（limit）として画面に出す。
   基準は **この IDE のセッションでそのプロジェクトを最初に起動する直前** であり、再起動しても取り直さない
   （取り直すと、再起動した時点で前の起動中の変化が画面から消える。E2E で実際に消えたのを見て直した）。
   **誰が書いたかは、Next.js の出力に証拠がある場合だけ名指しする。** 証拠が無ければ「書き込んだプロセスを特定する出力はありません」と書く。

環境 B では**実際に観測した**: 新しく clone した `poc/fixture-app`（16.4.3）と 15.5.5 の題材の両方で、
`next dev` が `next-env.d.ts` を作成した（第2.5節の修正の後、`tsconfig.json` は両方とも変わらなかった）。
画面は「開発サーバーの起動後、対象プロジェクトの next-env.d.ts（作成）が変わりました」と出した
（`docs/07a-screenshots/11-next15-running.png`）。

> **テストの扱い。** `tests/devserver.spec.mjs` 第10節「トップ階層に新しいものを作っていない」は、環境 A では
> `next-env.d.ts` が既に在ったので通っていた。環境 B（新しい clone）では `next dev` が作ったため失敗した。
> 期待値を緩めたのではなく、**主張を分けた** — `.next` と `next-env.d.ts` を「IDE が書いたか」の突き合わせから外し、
> 代わりに「IDE がその作成を観測して画面に出していること」（第4節）と「tsconfig.json の内容が変わっていないこと」（第10節）を検査する。

---

### 2.5 R1〜R4 とは別に見つけた不具合 — IDE 自身の環境変数が対象の `next dev` に漏れていた

| | |
| --- | --- |
| 見つけた経緯 | 環境 B で E2E を回した後、`poc/fixture-app/tsconfig.json` の `include` に `".next/dev/dev/types/**/*.ts"`（`dev` が二重）が足されていた。`tests/devserver.spec.mjs`（素の Node から起動）では起きず、**IDE のサーバー経由で起動したときだけ**起きた |
| 原因 | `spawn` に `{ ...process.env }` をそのまま渡していた。IDE は Next の上で動くため、IDE のプロセスには Next が自分のために設定した変数が入っている。起動した子の環境を `/proc/<pid>/environ` で実測すると、`NODE_ENV=production` / `PORT=3101`（IDE のポート）/ `__NEXT_PRIVATE_ORIGIN=http://127.0.0.1:3101`（IDE の URL）/ `NEXT_RUNTIME` / `TURBOPACK=1` / `NEXT_PRIVATE_START_TIME` / `NEXT_DEPLOYMENT_ID` が入っていた |
| 修正 | `childEnv()`（`devServer.ts`）で、これらと IDE の `npm_package_*` / `npm_lifecycle_*` を落とす。利用者の設定（`npm_config_*` のプロキシ・`NODE_OPTIONS`・`PATH` など）は渡す |
| 原因であることの確認 | 修正前のビルドで、`.next` を消した `fixture-app` に E2E を回すと **書き換えが再現した**。修正後のビルドでは、起動・停止を2回通しても `tsconfig.json` は変わらなかった（16.4.3 / 15.5.5 の両方）。`tests/devserver-stub.spec.mjs` 第3節は、汚れた環境で起動した子が受け取った変数を代役に出力させて検査する |

> **環境 A の観測への影響。** 環境 A の IDE（`npm run dev`）でも、子には `NODE_ENV=development` / `PORT=3100` /
> `__NEXT_PRIVATE_ORIGIN` / IDE の `npm_package_*` などが漏れていたはずである。したがって、**`blog-app` で記録した
> `tsconfig.json` の書き換え（R4 のきっかけ）と180秒の無応答（R3）が、漏れの無い環境でも起きるかは確かめていない。**
> R3 の lockfile の警告は Next.js のルート推定（環境変数を見ない処理）から出るものであり、R4 の書き換えも
> Next.js のソースに既定の振る舞いとして在る（第2.4節）ため、所見そのものは取り下げない。ただし `blog-app` で
> 再確認するまで、「blog-app がこの理由で起動できなかった」とは書かない。

## 3. 実装した機能と変更ファイル

### 3.1 機能（Phase 7A 全体）

| 指示 | 内容 |
| --- | --- |
| 2.A 検出 | package.json / next の宣言と実体 / App Router（`app` と `src/app` の曖昧さを含む）/ 依存 / 既存の開発サーバー（Next 16 の `.next/dev/lock`）/ 計装の可用性 / **上の階層の lockfile（R3）/ TypeScript の構成（R4）**。所見はすべて4要素 |
| 2.B 起動 | 空きポートの選択（3000〜3030）または指定。計装つき / なしを選べる。計装が使えなければ「適用不可」（失敗と書かない） |
| 2.C 停止 | SIGTERM → 待つ → SIGKILL をプロセスグループに送り、**ポートの解放を確認してから** `stopped` |
| 2.D 状態 | 7状態（idle / validating / starting / running / stopping / stopped / error）。画面は観測結果だけを書く |
| 2.E 安全 | 任意のコマンドを受けない / `shell: false` / 入口の防御 / ログの秘密情報らしき文字列を落とす |
| 画面 | Phase 5 の FloatingPanel に載せた。N0（GlobalBar）の実行状態・計装状態を実プロセスの観測に差し替え、未指定の間は「記録」と明示 |
| 掃除 | `npm run runtime:reap` |

### 3.2 今回の変更ファイル

| ファイル | 変更 |
| --- | --- |
| `src/state/RuntimeStore.tsx` | R2。操作中も取得を続け、`isNewerSnapshot` で新旧を決める。操作中は 500 ms 間隔。画面を開き直したとき、戻した検出結果のパスを入力欄にも戻す |
| `src/lib/snapshotOrder.ts` | **新規**。応答の新旧判定（純粋関数。テストできる層に置いた） |
| `src/components/panels/RuntimePanel.tsx` | R1 の `data-*` 属性。起動中の経過秒と Next.js の出力。`targetChanges` の所見カード。**表示中の検出結果と入力欄のパスが違うときは起動させない** |
| `src/app/globals.css` | 起動中の出力行の2行（既存の `.rt-note` の書式を使う） |
| `src/server/devServer.ts` | `instance` / `progress` / `targetChanges`（このセッションで最初に起動した時点からの変化。再起動で消さない）。待ちが切れたときのルート推定の説明。**`childEnv()`（第2.5節）**。テスト専用の `VCIDE_START_TIMEOUT_MS` |
| `src/server/projectInspect.ts` | R3（`findAncestorRootMarkers` / `ancestor-root-marker` / `-configured`）。R4（`next-dev-writes-tsconfig` / `next-dev-installs-typescript`）。`ProjectInspection` に `ancestorRootMarkers` / `rootConfigured` / `typescript` |
| `tests/project-inspect.spec.mjs` | R3 / R4 の検査。骨を OS の一時ディレクトリへ移した（第5.4節）。`~` の検査の環境依存を直した（第5.4節） |
| `tests/devserver.spec.mjs` | R4 に合わせて主張を分けた（第2.4節） |
| `tests/devserver-stub.spec.mjs` | **新規**。代役の next で R2 / R3 / R4 と環境変数の漏れ（第2.5節）を確かめる |
| `tests/runtime-e2e.spec.mjs` | R1。R2 を厳しく（「起動中」になること）。R3 / R4 の画面表示。対象の `tsconfig.json` が変わったなら画面がそれを出していること。Pages Router の題材が無い環境では骨を使う。前回の記録が残る IDE では「開いた直後」の3項目を skip。`PW_CHANNEL` |
| `package.json` | `npm test` に `devserver-stub` と `runtime-e2e` を追加 |

**R1〜R4 と第2.5節の他に、もう1件見つけて直した**: 画面を開き直すと、サーバーが持つ直近の検出結果は戻るが
入力欄は空のままで、［起動する］が押せ、押すと空のパスを送っていた。E2E を同じ IDE のプロセスで2回続けて回して見つかった。

---

## 4. 実際に起動したプロジェクト

| プロジェクト | Next.js | 構成 | 環境 | 結果 |
| --- | --- | --- | --- | --- |
| `poc/fixture-app` | 16.4.3（Turbopack） | `src/app` / TS / `turbopack.root` 設定あり | A・B | **起動・応答確認・停止・再起動まで通過**（E2E 55 件 / devserver 108 件、環境 B） |
| 新規に組んだ最小の題材（`src/app` / TS） | **15.5.5**（webpack。`next dev` の既定） | `memo-app` と同じ構成要素。環境 B の一時領域に作成。リポジトリには含めない | B | **起動・応答確認（200）・停止・再起動まで通過**（E2E 55 件・失敗0・skip 0）。`next-env.d.ts` の作成を観測。`tsconfig.json` は不変 |
| `/Users/mizuki/blog-app` | 16.2.6 | `app` / 上の階層に `/Users/mizuki/package-lock.json` | A | **起動失敗（start-timeout）**。`○ Compiling / ...` のまま180秒。出力に `Detected additional lockfiles`。tsconfig.json の書き換えも記録（R4）。**今回の R3 / R4 の実装の後には再実行していない** |
| `/Users/mizuki/memo-app` | 15.5.5 | `src/app` | — | **未実行**（環境 B に無い） |
| `/Users/mizuki/kabu-dashbord` | 16.2.6 | `app` | — | 未実行 |
| `/Users/mizuki/portfolio-site-1` | — | Pages Router のみ | A | 検出のみ（「未対応」）。環境 B では同じ構成の骨で画面を確認 |

`VERIFIED_NEXT_MAJORS = [15, 16]` の主張に対して、**実測で起動まで確認したのは 16.4.3 と 15.5.5 である。**
15.5.5 は利用者の実在プロジェクトではなく、新しく組んだ最小の題材での確認である。

---

## 5. 検証の結果

### 5.1 プロセス管理と安全性（実際のプロセスで確認）

| 検査 | 結果 | どこで |
| --- | --- | --- |
| 応答を確認するまで `running` にしない（`starting` を必ず通る） | 通過 | devserver 第4節 / E2E 第4節 |
| 起動中の画面は「起動中」（「未起動」のままにしない） | **通過（今回の修正で）** | E2E 第4節（16.4.3 / 15.5.5） |
| 二重起動の拒否（IDE の台帳 / Next 側の `.next/dev/lock`） | 通過 | devserver 第6節 / E2E 第5節 |
| ポート競合・特権ポートの拒否 | 通過 | devserver 第3節 |
| 停止で子プロセスが残らない（プロセスグループが空）・ポートが解放される | 通過 | devserver 第8節 / E2E 第6・7節 |
| IDE の再起動をまたいだ所有の引き継ぎ（殺さない） | 通過 | devserver 第7節 |
| 停止後・失敗後の再起動 | 通過 | devserver 第9節 / E2E 第7節 |
| 対象プロジェクトに IDE が書き込まない | 通過（`next dev` の書き込みは分けて観測・表示） | devserver 第10節 / devserver-stub 第2節 / E2E 末尾 |
| IDE 自身の実行時の環境変数を子に渡さない | **通過（今回の修正で）** | devserver-stub 第3節 / E2E 末尾（`tsconfig.json` が不変） |
| 別オリジン・独自ヘッダ無し・ループバック以外の Host を拒否 | 通過 | devserver 第1節 |
| 待ちが切れたときに理由を先に出し、「壊れている」と書かない | 通過 | devserver-stub 第1節 |

### 5.2 自動テスト

`BASE=http://127.0.0.1:3101 npm test`（環境 B。IDE は `next build` → `next start -p 3101`）:

| | 件数 |
| --- | --- |
| 既存の13本（PoC・探索画面・モデル） | 1,120（変更前と同じ。全件通過） |
| `project-inspect.spec.mjs` | 126（前回 91） |
| `devserver.spec.mjs` | 108（前回 105） |
| `devserver-stub.spec.mjs`（新規） | 55 |
| `runtime-e2e.spec.mjs`（新規に `npm test` へ） | 55 |
| **合計** | **1,464 件通過 / 0 件失敗 / 0 件 skip**（前回 1,316） |

`npm run typecheck` 通過。`npm run build` 成功（Turbopack の追跡範囲の警告は従来どおり 3 件。今回の変更で増えた2件は
`turbopackIgnore` の注釈で消した）。

### 5.3 代役の next を使った検査について

`tests/devserver-stub.spec.mjs` は、`node_modules/next/dist/bin/next` の位置に小さなスクリプトを置き、
**IDE 側は本物の `DevServerManager` をそのまま使う。** 代役が真似るのは、環境 A で記録した Next.js の出力の文言だけである
（`Detected additional lockfiles` / `○ Compiling / ...` / `reconfigured your tsconfig.json`）。
これは「その出力が来たら IDE が正しく伝えるか」の検査であり、**Next.js がその出力を出すかどうかの検査ではない。**
起動の待ち時間はテスト専用の環境変数 `VCIDE_START_TIMEOUT_MS` で 4 秒に縮めている（IDE 自身の環境変数であり、画面や API からは変えられない）。

### 5.4 期待値を書き換えたもの（理由つき）

| テスト | 変更 | 理由 |
| --- | --- | --- |
| `project-inspect` の骨の置き場所 | `.ide-runtime/test-fixtures` → OS の一時ディレクトリ | リポジトリ直下の `package-lock.json` が、すべての骨に R3 の所見を付けてしまうため。**一時ディレクトリの上に lockfile がある環境では、正常系の判定の検査を skip する**（成功扱いにしない） |
| `project-inspect` の good-stub | `tsconfig.json` / `next-env.d.ts` / TypeScript の依存の骨を追加 | R4 の所見を正常系に混ぜないため。R4 は専用の骨（`ts-missing` / `ts-ok` / `js-only`）で検査する |
| `project-inspect` の `~` の展開 | `inspectProject('~').root` → `normalizeInput('~').root` | 以前の検査は、**ホームに package.json がある環境（環境 A）でしか通らなかった**。環境 B（`/root` に package.json が無い）では R1〜R4 と無関係に失敗していた。展開そのものを見る形に直した |
| `devserver` 第10節 | 第2.4節のとおり主張を分けた | `next dev` の書き込みを IDE の書き込みと区別するため |
| E2E「起動中は『未起動』であって『実行中』ではない」 | 「クリック後5秒以内に『構成を検証中』か『起動中』になる」 | **厳しくした。** 旧い主張は「未起動」でも通っていた（それが R2 を見逃した理由である） |

### 5.5 手動で見たもの

`docs/07a-screenshots/` の 01〜11（**すべて環境 B で撮り直した**。01〜05 は環境 A の撮影を置き換えている。01〜10 の題材は `poc/fixture-app` と一時ディレクトリの骨、11 は 15.5.5 の題材）。05（起動中の経過秒と出力）/ 10（R3・R4 の所見）/ 11（15.5.5 で `next-env.d.ts` の作成を観測）は今回の追加分である。
05 と 11 には、マウスを重ねたボタンの説明（Why）が状態の行に重なって写っている。テストがボタンに触れた直後に撮っているためで、表示の不具合ではない。

---

## 6. 対応できる Next.js プロジェクトの条件

| 条件 | 扱い |
| --- | --- |
| `package.json` に `next` があり、`node_modules/next/dist/bin/next` が在る | 必須（無ければ blocker） |
| App Router（`app/` または `src/app/` に layout / page） | 必須。両方にあれば blocker（どちらか決めない） |
| Next.js 13 以上 | 必須。**実測で起動を確認したのは 16.4.3 と 15.5.5**。13・14 は「未検証」の limit |
| Pages Router の同居 | limit（Pages 側は観測しない） |
| Pages Router だけ | 未対応 |
| 上の階層の lockfile / ワークスペースの宣言 | limit。`turbopack.root` の記述があれば info |
| TypeScript の依存が欠けている | limit（`next dev` が自分でインストールする） |
| TypeScript の構成 | info（`next dev` が `tsconfig.json` / `next-env.d.ts` を書き換えうる） |
| dev スクリプトに独自の処理がある | info（**実行しない**。環境変数の設定や前処理は再現されない） |
| 既に外部で開発サーバーが動いている | limit（IDE は外部プロセスに計装できない） |
| macOS / Linux | 確認済み（環境 A / B）。Windows は未確認（プロセスグループの停止が POSIX 前提） |

---

## 7. 未対応事項

1. **利用者の実在プロジェクトでの再確認が残っている。**
   - `memo-app`（15.5.5）: 未実行。環境 A で `BASE=http://127.0.0.1:3101 VCIDE_E2E_PROJECT=/Users/mizuki/memo-app SHOTS=docs/07a-screenshots node tests/runtime-e2e.spec.mjs`
   - `blog-app`（16.2.6）: R3 の所見が起動前に出ることを、実物の画面で未確認。**第2.5節の修正の後でも180秒で応答しないか**、`turbopack.root` を設定すれば起動できるかも未確認
   - `kabu-dashbord`（16.2.6）: 未実行
2. **15.5.5 で計装の中身（スパン）が書かれることは確かめていない。** E2E は計装が「有効」で起動したことまでを見る。スパンの中身を見るのは devserver 第5節で、題材は 16.4.3 だけである
3. `next dev` の書き込み（R4）を**止める手段は持たない**。伝えるだけである
4. 起動の待ち時間は 180 秒固定（利用者が変えられない）。初回コンパイルが本当に長いプロジェクトでは足りないことがありうる
5. `VCIDE_START_TIMEOUT_MS` はテスト専用だが、IDE のプロセスの環境変数として設定すれば実際の待ち時間も変わる（画面や API からは変えられない）
6. E2E の「開いた直後」の3項目は、**新しく起動した IDE でしか確かめられない**。同じ IDE で続けて回すと skip になる（成功扱いにしない）
7. Windows は未確認

---

## 8. Phase 7B への移行可否

**移行してよい。ただし第7節の1（実在プロジェクトでの再確認）を、7B の最初の作業の前に環境 A で行うこと。**

| 7B が前提にするもの | 状態 |
| --- | --- |
| 任意のローカル Next.js（App Router）を計装つきで起動できる | 16.4.3（fixture-app）と 15.5.5（新規の題材）で確認。利用者の実在プロジェクトでは未確認 |
| 起動したプロセスの URL・ポート・PID・所有が確定している | 確認済み。プレビュー（7B）はこの `url` を使える |
| 画面の状態が実プロセスと矛盾しない | **R2 を直して確認済み**（起動中・実行中・停止の各状態を実ブラウザで観測） |
| 起動できない構成で理由が先に出る | R3 を実装。代役と骨では確認済み。`blog-app` の実物では未確認 |
| 対象プロジェクトへの書き込みが無い / あれば主体つきで伝わる | IDE は書き込まない。`next dev` の書き込みは観測して表示する（R4） |
