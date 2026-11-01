# Visual Computing IDE（GRiDDATA）

画面に表示されている値が、**どのコードを通り、どのDBカラムから来たのか**を
「証拠のある範囲だけ」で辿るためのローカル開発ツール。

設計の中心にあるのは1つの原則である — **観測できたことと推定したことを混ぜない。**
辿れなかった箇所は、辿れなかったものとして画面に出す（切断マーカー）。

---

## いまどこまで出来ているか

| 段階 | 内容 | 状態 |
| --- | --- | --- |
| Phase 1–4 | 要件・情報設計・UX・UI の確定 | 完了（`docs/01`〜`04`） |
| Phase 5 | 探索画面（S-04）の実装。合成データで動く | 完了（`docs/05`） |
| Phase 6 | PoC-01〜05。計装・要素特定・通信・SQL・由来推定の実測検証 | 完了（`docs/06a`〜`06e`） |
| Phase 6F | PoC 成果の整合性修正（SQL 射影解析の作り直し） | 完了（`docs/06f`） |
| M1 | 関係モデルの最小仕様の確定と機械的検査 | 完了（`docs/06g`） |
| **Phase 7A** | **ローカル Next.js プロジェクトの選択・起動・停止** | **実装済み。実ブラウザでの通し検証が途中** |
| Phase 7B | プレビュー・要素選択・観測情報の統合 | 未着手 |

Phase 7A は自動テスト（`tests/project-inspect.spec.mjs` 91 件 /
`tests/devserver.spec.mjs` 105 件）で起動・停止・二重起動の防止・ポート競合・
所有の引き継ぎまで検証済み。**実ブラウザでの通し検証（`tests/runtime-e2e.spec.mjs`）
は途中であり、既知の残件が3件ある** — `docs/07a-implementation-report.md`（未作成）に
まとめる予定。残件は `tests/runtime-e2e.spec.mjs` の冒頭コメントと
リポジトリの最新コミットメッセージを参照。

---

## 動かす

```bash
npm install
npm run dev          # http://127.0.0.1:3100
```

探索画面は、記録済みの観測データを9通り切り替えて描ける（同じ描画部品を通る）。

```
/              合成シナリオ（UI の基準）
/?data=measured  PoC-01 の実測
/?data=elements  PoC-03（表示された値・コンポーネント）
/?data=flows     PoC-05（通信を開始したコンポーネント）
/?data=rsc       PoC-02（Server Component の直読み）
/?data=rsc-svc   PoC-02（サーバー内部の通信が1段入る）
/?data=lin-a     PoC-04 由来を1列に絞れた場合（推定の関係が1本入る）
/?data=lin-c     PoC-04 候補が複数のまま（1つに断定しない）
/?data=lin-g     PoC-04 由来を作らない（切断のまま）
```

画面右上の「プロジェクトと実行」パネルから、**実在するローカルの Next.js
プロジェクト**を指定して開発サーバーを起動・停止できる（Phase 7A）。

### 検証

```bash
npm run typecheck
npm run build
npm test             # 1,316 件（ブラウザを使う節は dev サーバーが :3100 に必要）
npm run runtime:reap # 孤立した開発サーバーの掃除
```

`npm test` のうちブラウザを使う節は `BASE`（既定 `http://localhost:3100`）に
対して実行する。`poc/` の PoC ランナーは Docker の Postgres を使うため、
既定のテストには含まれない（記録済みの観測結果を読む）。

---

## 構成

```
src/app/          画面（App Router）と プロセス管理 API（/api/runtime/*）
src/components/   描画部品。合成でも実測でも同じ型を受け取る
src/lib/          model（関係モデルの契約）/ adapter / layout / derive
src/data/         記録済みの観測結果（PoC-01〜05 の実測。書き換えない）
src/server/       Node 側。プロジェクト検出・開発サーバーの起動停止・入口の防御
src/state/        画面の状態（探索 / 実行）
tests/            1,316 件。純粋な層は素の Node、画面は実ブラウザで見る
poc/              PoC-01〜05 の検証用アプリとランナー（IDE 本体には含めない）
docs/             要件から実施報告まで。**実装の根拠はすべてここにある**
```

### 読む順番（初見の場合）

1. `docs/01-product-requirements.md` — 何を作るのか
2. `docs/02a-object-model.md` — オブジェクトと関係の定義（**実装の契約**）
3. `docs/02d-observability-information-model.md` — 観測性（L0〜L3）の決め方
4. `docs/06g-m1-model-contract.md` — 関係モデルの確定仕様と機械的検査
5. `docs/06f-integrity-review.md` — PoC の成果と、まだ出来ていないこと

---

## 守っている約束

| | |
| --- | --- |
| 観測性は1か所で決まる | `observabilityOf(source)` だけ。ホップやノードが自分で決めない |
| 推測で埋めない | 辿れなければ「辿れなかった」と書く。確度ラベルは較正していないので出さない |
| 対象プロジェクトを書き換えない | 計装は `NODE_OPTIONS` の前置だけ。ファイルを置かない |
| 任意のコマンドを実行しない | 起動するのは対象の `node_modules` の next だけ |
| 記録を書き換えない | `src/data/observation.*.ts` は実測の記録である |
