# PoC 検証環境（隔離された架空アプリ）— PoC-01 / PoC-02 / PoC-03 / PoC-05

IDE 本体から分離してある。`tsconfig.json` の `exclude` に `poc` を入れてあるので、
本体の `npm run build` / `npm run typecheck` には一切入らない。

```
poc/
  fixture-app/            架空の検証用 Next.js アプリ（実案件のコードではない）
    src/app/              ページ14枚 / APIルート6本
      listings/           PoC-01 の題材（Client Component + API ルート）
      cards/              PoC-03 の題材（props・複数回描画・ネスト・特定不能の4ケース）
      cards-rsc/          PoC-03 の題材（Server Component）
      flows/              PoC-05 の題材（操作ごとに通信を起こす。同時実行・同URL・
                          失敗・中断・リダイレクト・子コンポーネントからの通信）
      flows-rsc/          PoC-05 / PoC-02 の題材（Server Component がサーバー内部で fetch する）
      rsc-db/             PoC-02 Gate B（Server Component が API を経由せず DB を直読み）
      rsc-parallel/       PoC-02 Gate B（3本の並列取得。区間が重なる）
      rsc-dup/            PoC-02 Gate B（同じ SQL を別ファイルの2箇所から実行）
      rsc-fail/           PoC-02 Gate B（SQL の失敗・空きポートへの通信）
      rsc-helper/         PoC-02 Gate B（コンポーネントでない関数の中の SQL。帰属しないのが正解）
      rsc-svc/            PoC-02 Gate A（別プロセスのサービスへ2本。片方の先で SQL）
      rsc-svc-fail/       PoC-02 Gate A（別プロセスのサービスが 500 を返す）
      api/boom|redirect|cors
                          PoC-05 の題材（500 / 307 / クロスオリジン）
    src/components/       PoC-03 の題材コンポーネント（ListingCard / RegionBadge）
    vendor-ui/            外部UIライブラリの代役。**src/ の外**・JSX を持たない配布形式
    src/instrumentation.ts  方式1 の入口（IDE が生成する想定の補助ファイル）
    ide-instrumentation/  計装の本体（CJS）。方式1・方式2 の両方から読む
      otel.cjs            OpenTelemetry の構成。ここだけが計装を知る
      mask.cjs            取得時点のマスキング。許可リスト + SQLのリテラル除去
      sink.cjs            ローカルファイルへの書き出し（外部へ送らない）
      boot.cjs            方式2（NODE_OPTIONS=--require）の入口
      loopback.cjs        伝播してよい宛先の判定。**計装とテストが同じ関数を使う**
  fixture-svc/            **隔離した2つ目の検証用サービス**（PoC-02 Gate A の相手側）
    server.cjs            127.0.0.1:3300 にのみ listen。計装は fixture-app のものを前置する
    db/init.sql           完全な合成データ（架空の地名と連番のみ）
  anchor/                 PoC-03 方式1 — JSX への要素識別子の注入
    transform.cjs         純粋変換。挿入のみで再出力しない（行番号がずれない）
    loader.cjs            webpack / Turbopack 共用のローダ。注入範囲は src/ のみ
    noop-loader.cjs       **計測専用**の素通しローダ（PoC-05 第7節）。何も変換しない
  runner/
    matrix.mjs            PoC-01 手順1〜3・5（方式 × バンドラ、取得率、性能）
    dbproxy.mjs           PoC-01 手順4（方式5 DBプロキシ）
    build-observation.mjs PoC-01 手順6〜8の入力づくり（観測結果 JSON の生成）
    poc03.mjs             PoC-03 方式比較（正答／誤答／特定不能・方式2との比較・ビルド時間）
    build-element-observation.mjs
                          PoC-03 の観測結果 JSON（ブラウザ側とサーバー側を1回の読み込みで）
    poc05.mjs             PoC-05 必須ケース × 2バンドラ（対応付け・呼び出し元・公開範囲）
    build-poc05-observation.mjs
                          PoC-05 の観測結果 JSON（1回の操作から）
    anchorcost.mjs        PoC-03 のコンパイルコストの再計測（PoC-05 第7節）
    poc02.mjs             PoC-02 必須ケース × 2バンドラ × 伝播の有無（docs/06d-poc02-matrix.json）
    build-poc02-observation.mjs
                          PoC-02 の観測結果 JSON（Gate A / Gate B の2経路）
    lib/netobs.mjs        CDP によるブラウザ側の通信観測。**相関用の2ヘッダだけ**を読む
    lib/initiator.mjs     「この通信を開始したコード」の解決（4段の照合）
    lib/correlate.mjs     識別子による対応付けと、時間窓との比較
    lib/probe05.mjs       PoC-05 の**手で書いた正解表**
    lib/probe.mjs         ブラウザ側の観測コードと**手で書いた正解表**
    lib/srcverify.mjs     報告位置のソースを読み直す独立した照合
    lib/srcmap.mjs        方式2 の比較に使う最小のソースマップ消費器
    lib/svc.mjs           2つ目の検証用サービスの起動・停止
    lib/srvmap.mjs        **サーバー側**の生成物の位置をソース位置へ戻す（2バンドラ対応）
    lib/rscattr.mjs       「このSQLを実行した Server Component」の解決（4段の照合）
    lib/propagate.mjs     サーバー間の伝播の判定と、時間窓との比較
    lib/probe02.mjs       PoC-02 の**手で書いた正解表**
  out/                    計測結果（.gitignore 済み）
```

## 前提

ローカルの使い捨て PostgreSQL（Docker）。実案件の DB にも本番にも接続しない。

```sh
docker run -d --name poc01-pg \
  -e POSTGRES_PASSWORD=poc01_local_only -e POSTGRES_USER=poc01 -e POSTGRES_DB=poc01 \
  -p 55432:5432 postgres:16-alpine \
  -c log_statement=all -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 \
  -c log_line_prefix='%m [%p] '
docker exec -i poc01-pg psql -U poc01 -d poc01 < poc/fixture-app/db/init.sql
```

`log_parameter_max_length=0` は、取得率の基準に使う PostgreSQL 側のログへ
**パラメータ値を出させない**ための設定である。

## 実行

```sh
cd poc/fixture-app && npm install && npx prisma generate && cd -
npm run poc:matrix     # PoC-01 方式1/2 × Turbopack/webpack、取得率、性能
npm run poc:proxy      # PoC-01 方式5（DBプロキシ）
npm run poc:observe    # PoC-01 観測結果 JSON と src/data/observation.measured.ts を作る
npm run poc:anchor     # PoC-03 方式比較（poc/out/poc03.json）
npm run poc:elements   # PoC-03 観測結果 JSON と src/data/observation.poc03.ts を作る
npm run poc:flows      # PoC-05 必須ケース × Turbopack/webpack（docs/06c-poc05-matrix.json）
npm run poc:flowdata   # PoC-05 観測結果 JSON と src/data/observation.poc05.ts を作る
npm run poc:anchorcost # PoC-03 のコンパイルコスト再計測（docs/06c-anchorcost.json）
npm run poc:rsc        # PoC-02 必須ケース × 2バンドラ × 伝播の有無（docs/06d-poc02-matrix.json）
npm run poc:rscdata    # PoC-02 観測結果 JSON と src/data/observation.poc02.ts を作る
```

PoC-02 のサーバー内部のトレース伝播は `POC02_UNDICI=1` のときだけ働く。
呼び出しスタックの記録は `POC02_CALLSITE=1` のときだけ動く。
**伝播するのはループバック宛の要求だけ**であり、それ以外の宛先は計装対象から外れるため
スパンも作られず `traceparent` も付かない（`ide-instrumentation/loopback.cjs`）。

要素識別子の注入は `POC03_ANCHOR=1` のときだけ有効になる。既定では無効なので、
PoC-01 の計測は従来と同じ条件で再現できる。

PoC-05 の相関用ヘッダは `POC05_TRACE_HEADER=1` のときだけ専用ヘッダを足す。
どちらのヘッダも**ループバック宛の応答にしか付かない**。
コンパイルコストの記録は `POC03_ANCHOR_COST` が立っているときだけ動く。
いずれも既定では無効なので、PoC-01 / PoC-03 の計測は従来と同じ条件で再現できる。

## 収集しないもの

`ide-instrumentation/mask.cjs` が取得時点で落とす。集めてから消すのではない。

SQLのパラメータ値 / 接続文字列 / Cookie / Authorization / アクセストークン /
パスワード / 個人情報 / DBから返った行データ / リクエスト・レスポンスの本文。

PoC-03 ではさらに次を集めない（`poc/runner/lib/probe.mjs`）。

**画面に表示された値そのもの** / **DOM の全文**。
観測するのは選択された要素1つの属性と、文字数・文字種だけである。
対応付けの鍵は「要素識別子 + 同一識別子内の順番 + テキストノード索引」であり、値を鍵に使わない。

PoC-05 ではさらに次を集めない（`poc/runner/lib/netobs.mjs`）。

**応答ヘッダのうち相関用の2キー以外**（生のヘッダ集合を呼び出し側へ渡さない）/
**リクエスト・レスポンスの本文**（CDP の本文取得を一度も呼ばない）/
**クエリ文字列の値**（付いていたかどうかだけを残す）。

PoC-02 ではさらに次を集めない。

**トレースコンテキストの値**（受け側は「付いていたか」の真偽だけを数える）/
**呼び出しスタックの引数や変数**（ファイル・行・列・関数名だけを記録する）/
**絶対パス**（記録の時点で相対パスか分類名に置き換える）。
