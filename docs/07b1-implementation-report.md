# Phase 7B-1 実施報告 — 実プレビューの統合

| | |
| --- | --- |
| 対象 | IDE が起動した Next.js の開発サーバーのページを、既存のプレビューパネルに実際に表示する |
| 基準 | ブランチ `claude/happy-euler-7404el`、コミット `f212617`（Phase 7A 完了時点） |
| 実施日 | 2026-11-01 |
| 題材 | `poc/fixture-app`（Next 16.4.3 / Turbopack） |
| 新しい UI デザイン | **作っていない**。既存のプレビューパネル（同じ FloatingPanel・同じ位置と幅・同じ `.pvb` / `.site` / `.pvfoot`）の中身を差し替えた |
| 合成データ・記録データの画面 | **変えていない**。起動を観測するまでは従来の見本を出す（第4節） |
| やっていないこと | 要素クリックと React ソースの特定（7B-2）/ client-fetch の G1・G2 / DB リネージの拡張 / 複数プロジェクトの同時起動 |

---

## 0. 最初に確認したもの

| 確認したもの | わかったこと |
| --- | --- |
| `docs/07a-implementation-report.md` | 起動した開発サーバーの `url`（`http://127.0.0.1:<port>`）は確定している。7B はそれを使える、とある |
| `docs/06g-m1-model-contract.md` | 7B-1 の範囲（表示）では関係モデルに触れない。`binds` の扱いは M3〜M5（要素選択）で決める、とある |
| 既存のプレビューパネル（`PreviewPanel.tsx`） | 合成データの見本サイト／実測データの「値の形」の2通り。どちらも IDE が描いた絵であり、実ページではない |
| `src/server/guard.ts` | API は **Host がループバックであること**と **Origin が Host と一致すること**を要求する |
| `src/server/devServer.ts` | 子の環境は `{ ...process.env }` から **IDE 自身の Next の変数だけを落とす拒否リスト** |
| `src/state/RuntimeStore.tsx` | 画面の状態は `/api/runtime/status` の観測だけで決まる。これをそのまま使う |

### 0.1 この環境で実測した2つの問題

**(1) クラウドではブラウザの localhost とサーバーの localhost が違う。**
Codespaces などの転送では、ブラウザは `https://<名前>-3100.app.github.dev` で IDE に来る。
Host はその名前のまま届く（Next.js が `allowedDevOrigins` を設けた理由と同じ）。
したがって 7A の `guard.ts` は **転送 URL からの要求をすべて 403 にする**。また、iframe に
`http://127.0.0.1:3000` を書いても、ブラウザは**自分の機械の** 3000 番を見に行く。

**(2) 7A の拒否リストでは、クラウドの秘密情報が起動先に届く。**
このコンテナ（Claude Code のリモート環境）の IDE のプロセスには、実際に
`GITHUB_TOKEN` / `GH_TOKEN` / `AWS_SECRET_ACCESS_KEY` / `AWS_ACCESS_KEY_ID` /
`CLOUDSDK_AUTH_ACCESS_TOKEN` / `CLAUDE_CODE_*` のトークン / `ANTHROPIC_BASE_URL` などが入っていた（名前で確認。値は見ていない）。
7A の `childEnv()` はこれらを落とさないので、**対象の `next dev`（＝利用者のプロジェクトのコードと依存パッケージ）に渡っていた。**
7B-1 で許可リスト方式に変えた（第2.2節）。修正後に `/proc/<pid>/environ` で実測し、
この環境の実物の秘密情報の名前が 0 件であることを確認した。

---

## 1. 接続方式の比較と採用

| 方式 | クラウドで成立するか | 安全性 | 判断 |
| --- | --- | --- | --- |
| A. iframe に開発サーバーの URL（`http://127.0.0.1:3000`）を直接書く | **成立しない。** ブラウザの 127.0.0.1 はサーバーではない（E2E 第2節で実測: 届かない） | — | 不採用。ループバックの同じ機械でしか動かない |
| B. 開発サーバーのポート（3000〜3030）をそれぞれ転送して直接開く | 転送を毎回足せば届くが、**Next の dev は localhost 以外の Origin からの `/_next/*` と HMR を拒否する**（`block-cross-site-dev.js`）。対象の `next.config` に `allowedDevOrigins` を足す必要がある | 対象プロジェクトの設定を書き換えることになる（7A の方針に反する）。ポートが変わるたびに転送の設定も変わる | 不採用 |
| C. IDE と同じ origin のパス前置き（`/preview/*`）で中継する | 届く | 対象のアプリはルート相対（`/_next/…` `/api/…` `<a href="/listings">`）を使う。IDE 自身も Next なので**パスが衝突する**。HTML・JS・RSC の中の URL を書き換える必要がある。さらに、**プレビューの中のスクリプトが IDE と同じ origin で動き、IDE の起動・停止 API を同一オリジンとして呼べてしまう** | 不採用 |
| **D. IDE 側に、宛先を1つに固定した中継を別ポート（別 origin）で置く** | **成立する。** 転送するのは IDE 側の決まったポート（既定 3150）1つだけ。アプリのパスはそのまま通る | 宛先は IDE が `running` と観測した開発サーバーだけ。プレビューは IDE と別 origin なので、IDE の API は `guard.ts` の Origin 検査で止まる（E2E で実測） | **採用** |

```
ブラウザ（クラウドなら転送 URL）
  ├─ http(s)://<IDE の転送ホスト>          → IDE（Next, :3100）  … 画面と /api/runtime/*
  └─ http(s)://<中継の転送ホスト> を iframe → 中継（IDE のプロセス内, 127.0.0.1:3150）
                                               └─ 127.0.0.1:<IDE が起動した開発サーバーのポート>  ← 宛先はこれ1つ
```

### 1.1 中継（`src/server/previewGateway.ts`）が守っていること

| 守ること | 実装 | 確認 |
| --- | --- | --- |
| 宛先は1つだけ | 宛先は `DevServerManager` の `running` の観測から決める。**要求の URL・Host・ヘッダから決めない**。転送の直前にプロセスの生存も見る | 単体 第4節（`//evil.example/x` もパスとして同じ宛先へ） |
| 任意の宛先への転送を受けない | 絶対形式の要求（`GET http://…`）は 400、`CONNECT` は 405 | 単体 第4節 |
| 外のネットワークから直接届かない | 待ち受けは 127.0.0.1 だけ | 単体 第4節（外向きのアドレスから接続して届かない） |
| DNS リバインディング対策 | Host はループバックか、IDE の起動時に明示した公開ホストだけ。違えば 421 | 単体 第4節 / E2E 第2節（`rebind-preview.cloud.test` で 421） |
| 実行中でなければ転送しない | 起動前・起動中・停止後・異常終了後は、IDE が作った説明のページ（503）を返す。HMR の WebSocket もつながない | 単体 第4節 / E2E 第2・6・7節 |
| 他の origin に埋め込ませない | `Content-Security-Policy: frame-ancestors <IDE の origin>` を足す（転送先の CSP は残し、追加する） | 単体 第4節 |
| 転送元の情報・中継の資格情報を渡さない | `X-Forwarded-*` / `Forwarded` / `X-Real-IP` / `Proxy-Authorization` を落とす | 単体 第4節 |
| Next の dev の CSRF・クロスサイト検査を壊さない／緩めない | Host と、**中継自身の origin から来た** Origin / Referer だけを転送先のものに置き換える。**別の origin から来た Origin は書き換えない** | 単体 第4節 / E2E 第3節（HMR がつながる） |
| リダイレクトでブラウザに 127.0.0.1 を踏ませない | 転送先の絶対 URL の `Location` はパスだけにする | 単体 第4節 |

**中継がページに足すもの。** HTML の `<head>` の直後に `<script src="/__vcide_preview/agent.js">` を1行だけ差し込む
（インラインにしない。アプリの CSP が `'self'` を許すなら動く）。このスクリプトが親（IDE の画面）に送るのは
**パス・タイトル・最初の文書の HTTP 状態・その文書を作ったのが開発サーバーか中継か**だけで、DOM の中身は送らない（単体で検査）。
差し込みのため転送先には `Accept-Encoding: identity` を送る。差し込みはバイト列を壊さない（日本語を途中で切った応答で検査）。

### 1.2 IDE の API の入口（`guard.ts` / `access.ts`）

**Host と Origin の検査は撤廃していない。** 足したのは「ループバック」に、**IDE を起動した人が環境変数で
1つずつ明示したホスト名**を加えることだけである。ワイルドカードは受け付けない。画面や API からは変えられない。

| 環境変数（IDE 自身の） | 意味 |
| --- | --- |
| `VCIDE_ALLOWED_HOSTS` | IDE の画面・API に来てよいホスト名（カンマ区切り）。`codespaces` と書くと `CODESPACE_NAME` と `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN` から IDE のポートの転送ホストを1つだけ組み立てる |
| `VCIDE_PREVIEW_ORIGIN` | ブラウザから見た中継の URL（例: `https://<名前>-3150.app.github.dev`）。`codespaces` のときは組み立てる |
| `VCIDE_PREVIEW_PORT` | 中継のポート（既定 3150。使えなければ 3151〜3170 を探す。明示した場合と、公開 URL がポートに依存する場合は探さない） |

- Origin は **Host と完全に一致**しなければならない（従来どおり）。`Sec-Fetch-Site` は `same-origin` / `none` だけ（従来どおり）。
  プレビューの origin（別ポート）からの要求は、ループバックでも転送ホストでも拒否される（単体 第2節・E2E 第2節）
- 設定の誤り（ワイルドカード・解釈できない名前・パスつきの URL・資格情報つきの URL）は**黙って捨てず**、状態 API の `configProblems` に出す
- **これはアクセス制御の代わりではない。** 転送 URL を誰が開けるかは転送する側が決める。Codespaces ではポートの公開範囲を **Private** のままにすること（Public にすると、URL を知る人が起動・停止を操作できる）

起動の例（Codespaces）:

```bash
VCIDE_ALLOWED_HOSTS=codespaces npm run dev
```

ブラウザから見た中継の URL は、**状態 API が要求の Host から決めて返す**（`preview.origin`）。
ループバックで開いた IDE には `http://127.0.0.1:3150`、許可した転送ホストで開いた IDE には `VCIDE_PREVIEW_ORIGIN`。
どちらでもなければ null を返し、理由（「ブラウザの localhost はサーバーの localhost ではない」）と次の操作を画面に出す。**推測しない。**

---

## 2. 安全性

### 2.1 他のローカルサービスへの経路を作っていない

| 経路 | 結果 |
| --- | --- |
| 中継に絶対形式の URL を渡す（`GET http://127.0.0.1:22/`） | 400（単体） |
| 中継に `CONNECT 127.0.0.1:22` | 405（単体） |
| 中継に `//evil.example/x` | 宛先は変わらず、開発サーバーにパスとして届く（単体） |
| 中継に許可していない Host（DNS リバインディング） | 421。転送先に届かない（単体・E2E） |
| 開発サーバーが落ちた直後 | 転送の前に PID の生存を見る。落ちていれば 503（E2E 第6節） |
| プレビューの iframe から IDE の画面を差し替える | `sandbox` で上位の移動を許していない |
| プレビューの中のスクリプトから IDE の停止 API を呼ぶ | 拒否（E2E 第2節。別 origin なので `guard.ts` の Origin 検査で止まる） |

> **残る経路（意図したもの）。** 中継は、IDE が起動した開発サーバーの**すべてのパス**を通す（`/api/*` を含む）。
> これは開発サーバーをブラウザで開くのと同じ範囲であり、プレビューに必要である。
> もう1つ、開発サーバーが落ちて**別のプロセスが同じポートを取った**場合、IDE の状態の確認（最長3秒間隔）までの間に
> そのポートへ転送しうる。PID の生存は転送の都度見ているので、IDE が起動したプロセスが生きている間は起こらない。

### 2.2 起動先の環境変数（`src/server/childEnv.ts`）

**拒否リストを許可リストに変えた。** 渡すのは次だけである。

| 渡すもの | 理由 |
| --- | --- |
| `PATH` `HOME` `USER` `LOGNAME` `SHELL` `LANG` `LANGUAGE` `LC_*` `TZ` `TMPDIR` `TMP` `TEMP` `TERM` `COLORTERM` `NO_COLOR` `FORCE_COLOR` `CI` `XDG_*` | OS・ロケール・端末 |
| `NODE_EXTRA_CA_CERTS` `SSL_CERT_FILE` `SSL_CERT_DIR` | 証明書の**場所**（社内プロキシ・このコンテナのプロキシ） |
| `NODE_OPTIONS` | 利用者の Node の設定。計装はこの後ろに前置する（7A と同じ） |
| `NVM_*` `VOLTA_HOME` `COREPACK_HOME` `PNPM_HOME` `NPM_CONFIG_USERCONFIG` | Node・パッケージマネージャの置き場所 |
| `HTTP(S)_PROXY` `ALL_PROXY` `NO_PROXY`（小文字も） | **資格情報（`user:pass@`）を含まないときだけ** |
| `npm_config_*` | **認証に関わる名前（auth / token / password / secret / key / cert / otp）を除く**。値に資格情報つき URL があれば渡さない |
| `VCIDE_CHILD_ENV_PASS=NAME1,NAME2` で IDE の起動時に明示した名前 | シェルの環境変数に頼るプロジェクトのため。**明示した人の責任で渡す** |

渡さないもの: 上に無いすべて（`GITHUB_TOKEN` / `AWS_*` / `ANTHROPIC_*` / `CLAUDE_CODE_*` / `DATABASE_URL` など）と、IDE 自身の設定（`VCIDE_*`）と、7A で落としていた IDE の Next の変数（`NODE_ENV` / `PORT` / `__NEXT_*` …）。
対象プロジェクトの秘密情報（`DATABASE_URL` など）は、Next.js 自身がプロジェクトの `.env*` から読むので、IDE が渡す必要は無い。

画面には「N 個を渡しました（他の M 個は渡していません）」を出す（RuntimePanel の既存の一覧の1行）。**名前の一覧はツールチップに出し、値はどこにも持たない。**

**ダミーの秘密情報による否定テスト（3段）**

| 段 | 方法 | 結果 |
| --- | --- | --- |
| 関数 | `childEnvReport()` に 17 個のダミー（`GITHUB_TOKEN` / `AWS_SECRET_ACCESS_KEY` / `ANTHROPIC_API_KEY` / 資格情報つきプロキシ / `npm_config__authToken` …）を入れる | どの名前も、どの値の断片も出力に無い（`preview-gateway` 第3節） |
| 代役の next | IDE のプロセス（試験のプロセス）にダミーを入れて `DevServerManager` で起動し、子が受け取った環境を代役に出力させる | 印のついた値 0 件・秘密の名前 0 件。`VCIDE_CHILD_ENV_PASS` で明示した名前だけ届く（`devserver-stub` 第3節） |
| 実物の next dev | ダミーを環境変数に入れて IDE（`next start`）を起動し、画面から fixture-app を起動。開発サーバーのプロセスグループ全員の `/proc/<pid>/environ` を読む | 2 プロセスとも、印のついた値 0 件・秘密の名前 0 件・`VCIDE_*` 0 件。前提として IDE のプロセスには印がある（E2E 第5節） |

> **振る舞いの変更。** 7A の `devserver-stub` 第3節は「利用者の環境変数（`VCIDE_USER_VAR`）は届く」を検査していた。
> 方針を変えたので、この主張は「名前を許可していない変数は渡さない」「`VCIDE_CHILD_ENV_PASS` で明示した変数は渡す」に置き換えた。
> **シェルで `export` した変数に頼って動くプロジェクトは、明示しない限り 7A と違う動きになる**（未検証事項 4）。

---

## 3. プレビューの体験

| 指示の体験 | 実装 | E2E |
| --- | --- | --- |
| 1. 実際の Next.js プロジェクトを指定 | 7A のまま（RuntimePanel） | 第3節 |
| 2. 開発サーバーを起動 | 7A のまま。起動中はプレビューも「起動中」。**HTTP の応答を確認する前に iframe を置かない** | 第3節（状態の移り変わりを DOM の変化で記録し、iframe があるときは常に「実行中」） |
| 3. HTTP 応答を確認 | 7A のサーバー側の確認に加え、**ブラウザから中継に届くか**を確かめてから iframe を置く（`/__vcide_preview/ping`。IDE の origin にだけ CORS で答える） | 第3・6節 |
| 4. 既存のプレビューパネルに実ページ | 同じパネルの `.site` の中に iframe（高さ 300px） | 第3節（fixture-app の見出し・HTTP 200・パネルの位置と幅が変わらない） |
| 5. ページ移動・再読み込み | パネル内の1行（↻ / パス / 移動）。プレビューの中のリンクでも移動でき、移動先のパスと HTTP 状態が出る。**パスだけを受け付け、別の origin の URL は開かない** | 第4節 |
| 6. 停止するとプレビューも停止 | 停止処理中・停止後は iframe を外し、「開発サーバーは停止しています」。中継も 503 | 第7節 |
| 存在しないページ | 開発サーバーの 404 をそのまま見せ、フッターに「HTTP 404 — ページが見つかりません（開発サーバーの応答）」 | 第4節 |
| 通信の失敗 | ① 転送が途切れた: 「このブラウザからプレビューの中継に届きませんでした」（開発サーバーは実行中のまま、と分けて書く）。［もう一度確かめる］で戻る ② 開発サーバーが落ちた: 中継の説明（502/503）→ 状態の確認で「起動できていません」に倒れ、iframe を外す ③ 中継を用意できない／URL がわからない: 理由と次の操作 | 第6節（①②）/ 単体 第5節（③） |
| HMR | 中継が WebSocket（`/_next/webpack-hmr`）も同じ1つの宛先へつなぐ | 第3節（つながり、メッセージを受け取り、エラーが無い） |

HTTP の状態が**わからない**場合は、わからないと書く:
ページ内の遷移（`pushState`）では「ページ内の遷移（HTTP の状態は観測していません）」、知らせが来ないページ（JSON など HTML 以外の応答、ブラウザのエラーページ）では「このページから IDE への知らせがありません … HTTP の状態はわかりません」。
中継が作った説明のページは「IDE の中継が返した説明」と書き、開発サーバーの応答と混ぜない。

---

## 4. UI

- **新しい画面・新しいパネル・新しいデザインは作っていない。** プレビューパネル（`FloatingPanel id="preview"`、left 232 / top 16 / width 392）をそのまま使い、
  ヘッダの注記を「現物」→「開発サーバー」に変えた（中身が実ページであることを示すため）。
  部品は既存の `.pvb` / `.site` / `.pvfoot` / `.rt-in` / `.rt-b` / `.rt-card` / `.pgnone`。CSS の追加は寸法の調整 12 行だけ
- **合成データ・記録データの画面は壊していない。** パネルが実プレビューになるのは、開発サーバーが起動中・実行中・停止処理中のとき、
  または**この画面で起動を観測した後の**停止・失敗のときだけである。それ以外（プロジェクト未指定、開き直した画面）は、
  従来の見本（合成の見本サイト／実測データの「値の形」）をそのまま出す
  - 開き直した画面で「停止しています」を出し続けると、見本の画面（`.trk` の値の選択など）が使えなくなるため、この規則にした
- RuntimePanel の既存の一覧に「環境変数」の1行を足した。転送 URL で開いているときは、サーバー側の `http://127.0.0.1:<port>` を**押せるリンクにしない**（このブラウザからは届かないため）

---

## 5. 検証の結果

### 5.1 実ブラウザの E2E（`tests/preview-e2e.spec.mjs`）— **70 件通過 / 0 件失敗**

Chrome 153（playwright-core / channel: chrome）。**クラウドの転送を模した**構成で行った:

- ブラウザの通信をすべて試験の転送役（HTTP プロキシ）に通し、**ループバックも例外にしない**（`--proxy-bypass-list=<-loopback>`）
- 転送役が通すのは `ide.cloud.test` → IDE と `preview.cloud.test` → 中継だけ（Host をそのまま渡す。Codespaces と同じ）
- したがってブラウザの `127.0.0.1` はサーバーに届かない（第2節で確認）。iframe が開発サーバーの URL を直接使っていたら、この試験は通らない
- IDE は試験が `next start` で起動する。環境変数に **ダミーの秘密情報 9 個**と `VCIDE_ALLOWED_HOSTS=ide.cloud.test` / `VCIDE_PREVIEW_ORIGIN=http://preview.cloud.test` を入れる

| 節 | 主な確認 |
| --- | --- |
| 1 | 転送 URL で IDE が開き、API が使える。起動前は従来の見本のプレビュー |
| 2 | ブラウザの 127.0.0.1 は届かない / 許可していない名前は API 403・中継 421 / 起動前の中継は 503 / **プレビューの origin から IDE の停止 API を呼べない** |
| 3 | 起動中は iframe を置かない → 実行中に iframe（中継の転送 URL）→ fixture-app の見出し・HTTP 200。ブラウザは開発サーバーのポートに一度も直接行っていない。HMR の WebSocket がつながる |
| 4 | プレビューの中のリンクで `/listings` へ移動（パスと 200 が出る）/ パス入力で `/no-such-page-7b1` → **404 を表示** / 別の origin の URL は開かない / トップへ戻る / 再読み込み |
| 5 | 開発サーバーのプロセスグループ全員の `/proc/<pid>/environ` に、ダミーの値・名前・`VCIDE_*` が無い |
| 6 | 転送を止める → 「中継に届きません」（開発サーバーは実行中のまま）→ 戻す → 表示に戻る / 開発サーバーを `SIGKILL` → 「起動できていません」・iframe を外す・中継 503 |
| 7 | 起動し直す → 実プレビューに戻る / 停止 → プレビューも停止状態・中継 503・停止の途中で iframe を残さない |
| 8 | 同じ機械のブラウザ（ループバック）で開いた IDE には `http://127.0.0.1:<中継のポート>` を返す |
| 他 | IDE の画面に例外が無い（拾えることを試験の最初に自分で確かめている）/ 対象の `tsconfig.json` は変わっていない |

> 題材の fixture-app は DB（Postgres）が無いと `/api/stats` などが失敗し、**プレビューの中で**アプリ自身の例外が出る。
> これは IDE の不具合ではないので、IDE の画面（最上位の文書）の例外とは分けて数えている。

### 5.2 自動テスト（`BASE=http://127.0.0.1:3101 npm test`、新しく起動した IDE に対して）

<!-- 件数は下で埋める -->

`npm run typecheck` 通過。`npm run build` 成功（Turbopack の追跡範囲の警告は従来どおり 3 件）。

### 5.3 Phase 7A から残っている問題（今回の変更とは無関係。直していない）

**同じ IDE のプロセスで一度でも起動・停止すると、`tests/explore.spec.mjs` が失敗する。** 停止後もサーバーが直近の検出結果を返すため、
RuntimePanel（右上）が検出の所見で縦に長くなり、探索の試験がクリックする位置を覆う
（`… <div class="rt-ins"> … intercepts pointer events`）。**基準のコミット `f212617` を別の作業ツリーでビルドして同じ操作をし、同じ失敗を再現した。**
7A の報告の「1,464 件通過」も新しく起動した IDE での結果である。`npm test` は `runtime-e2e` を最後のほうで回すため、
**同じ IDE で `npm test` を2回続けると2回目は失敗する。** 直すにはパネルの配置か試験の前提を変える必要があり、7B-1 の範囲（UI を変えない）を超えるため、残した。
なお、7B-1 の E2E（`preview-e2e`）は自分で起動した IDE を使うので、`BASE` の IDE の状態を変えない。

---

## 6. 変更ファイル

| ファイル | 変更 |
| --- | --- |
| `src/server/previewGateway.ts` | **新規**。プレビューの中継（宛先1つ・Host 検査・絶対形式/CONNECT の拒否・WebSocket・説明のページ・場所を知らせるスクリプトの差し込み・frame-ancestors） |
| `src/server/preview.ts` | **新規**。中継と `DevServerManager` をつなぐ（宛先は `running` の開発サーバーだけ）。ブラウザから見た中継の URL を要求の Host から決める |
| `src/server/access.ts` | **新規**。許可するホスト（`VCIDE_ALLOWED_HOSTS` / `codespaces`）・中継の公開 URL とポート・frame-ancestors |
| `src/server/childEnv.ts` | **新規**。起動先の環境変数を許可リストで組む（7A の拒否リストを置き換え） |
| `src/server/guard.ts` | ループバックに「明示したホスト」を足せるようにした。Origin＝Host の一致、`Sec-Fetch-Site`、変更操作の条件は変えていない |
| `src/server/devServer.ts` | `childEnv` を `childEnv.ts` へ移した（同じ名前で再輸出）。スナップショットに `env`（渡した名前と数） |
| `src/app/api/runtime/status/route.ts` | 応答に `preview`（中継の状態・このブラウザから見た URL・理由） |
| `src/state/RuntimeStore.tsx` | `preview` と `liveSeen`（この画面で起動を観測したか） |
| `src/components/panels/LivePreview.tsx` | **新規**。既存のプレビューパネルの中身としての実プレビュー |
| `src/components/panels/PreviewPanel.tsx` | 開発サーバーを扱っている間だけ `LivePreview` を返す。既存の2通りの表示は変えていない |
| `src/components/panels/RuntimePanel.tsx` | 「環境変数」の行。転送 URL で開いているときはサーバー側の URL を押せるリンクにしない |
| `src/app/globals.css` | 実プレビューの寸法（12 行）。既存の規則は変えていない |
| `tests/preview-gateway.spec.mjs` | **新規**。接続の許可・入口の防御・環境変数（ダミー）・中継（代役の転送先）・ブラウザから見た URL |
| `tests/preview-e2e.spec.mjs` | **新規**。クラウドを模した実ブラウザの E2E |
| `tests/devserver-stub.spec.mjs` | 第3節: ダミーの秘密情報が実際に起動した子へ渡らないこと。方針の変更に合わせて「利用者の変数は届く」を置き換えた（第2.2節） |
| `package.json` | `npm test` に `preview-gateway` と `preview-e2e` を追加 |
| `README.md` | 状態表と、クラウドでの起動方法 |
| `docs/07b1-implementation-report.md` / `docs/07b1-screenshots/` | 本書と画面 |

---

## 7. 未検証事項

1. **実物の GitHub Codespaces では動かしていない。** この環境（Claude Code のリモート環境）には利用者のブラウザへのポート転送が無いため、
   転送は試験の中で模した。模したのは「転送ホストごとに1つのポート」「Host をそのまま渡す」「ブラウザのループバックはサーバーに届かない」の3点である。次は確かめていない:
   - Codespaces が Host を転送ホストのまま渡すこと（Vite の `allowedHosts` 問題などから、そうだと判断した）
   - **Private のポートを別ポートの iframe で開いたとき、Codespaces の認証の Cookie が送られること。** `app.github.dev` は Public Suffix List に載っていない（2026-11-01 に確認。載っているのは旧ドメインの `githubpreview.dev`）ので、IDE と中継は同じサイトになり、SameSite=Lax の Cookie は送られるはずだが、実物では見ていない
   - `VCIDE_ALLOWED_HOSTS=codespaces` が組み立てる名前（`<CODESPACE_NAME>-<ポート>.<ドメイン>`）が実物と一致すること
2. **Mac 上の実案件のプロジェクト**では確認していない（今回の完了条件外）。16.4.3（fixture-app）だけで確認した。15.5.5（webpack の HMR）ではプレビューを確かめていない
3. **HMR でページが実際に更新されること**は確かめていない。WebSocket がつながり、メッセージが届き、エラーが無いことまでを見た
4. **シェルの環境変数に頼るプロジェクト**は、`VCIDE_CHILD_ENV_PASS` で明示しないと起動後の動きが 7A と変わる。実在のプロジェクトでの影響は未確認
5. **ページ内の遷移（クライアント側のルーター）の HTTP 状態**は観測しない。存在しないパスへのページ内の遷移は「状態は観測していません」と出る
6. 対象のアプリが `X-Frame-Options` や自前の `frame-ancestors` を返す場合、プレビューは表示されない（中継は書き換えない）。その場合の画面の説明は作っていない（「知らせがありません」と出る）
7. 対象のアプリが `basePath` / `assetPrefix` を絶対 URL で持つ場合、中継を経ない URL を参照しうる。確かめていない
8. iframe の高さは 300px 固定、幅はパネルの幅（約 360px）。広い画面向けのページは狭い幅で表示される（UI を変えない方針のため）
9. 中継が埋め込みを許す相手は「ループバックの任意のポート」と明示したホストである。同じ機械の別のローカルのページはプレビューを埋め込めうる（受け取れるのはパスとタイトルと HTTP 状態だけ）
10. Windows は未確認（7A と同じ）

---

## 8. Phase 7B-2 へ進むか

**進んでよい。** 7B-2（要素クリックと React ソースの特定）が前提にするものは揃った。

| 7B-2 が前提にするもの | 状態 |
| --- | --- |
| 実ページがプレビューの中で動く（クラウドでも） | 確認済み（模した転送で） |
| プレビューの中に IDE のスクリプトを置ける | 中継が `<head>` に1行差し込む仕組みがある。7B-2 はこのスクリプトを要素の選択に広げられる（いまは場所しか送らない） |
| プレビューと IDE の間の通信路 | `postMessage`（送り主の origin と iframe を確かめている）。別 origin なので、7B-2 でも DOM を直接触らず、この通信路を使う前提になる |
| 起動・停止とプレビューの状態の一致 | 確認済み |

ただし、7B-2 の最初に **第7節の1（実物の Codespaces）** を一度確かめることを勧める。
別 origin の iframe と Cookie の扱いは、要素選択の通信路の前提でもあるため。
