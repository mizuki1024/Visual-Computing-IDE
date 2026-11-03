# 探索 M2 の最終確認 — 実行記録

`docs/07c-m2-readiness-review.md` 第10節の証拠。作業基準 `6a6bd13`（製品コードは無変更）。

| 置き場所 | 内容 |
| --- | --- |
| `typecheck.log` | `npm run typecheck`（エラー 0） |
| `suites/` | `PW_CHANNEL=none bash scripts/test-all.sh docs/07c-m2-readiness-results/suites` の2回目（全 37 本）。`suites-summary.tsv` が一覧 |
| `suites/suites-summary.run1.tsv`・`suites/run1-env-error/` | 1回目。ブラウザを使う 11 本が、Playwright の headless shell（1248）の位置が無いため起動前に終了（環境の不備。リポジトリの外にシンボリックリンクを足して2回目を回した） |
| `suites-rerun/` | 2回目で 2 件失敗した `lineage-e2e` だけを単独で回し直したもの（93/0） |
| `acceptance/acceptance-7c3-*.log`・`7c3-*/` | `scripts/acceptance-7c3.mjs`（1600×1000・1440×900。新しく起動した IDE） |
| `acceptance/acceptance-7c2-1600x1000.log`・`7c2-1600x1000/` | `scripts/acceptance-7c2.mjs`（P0-2 の重なり） |
| `acceptance/*.run1-reused-ide*` | 1440×900 の1回目。前の IDE を止め損ねたまま回したため無効（第10.2節）。画面は削除し記録だけ残した |

環境: Node 22.23.4・Next 16.4.3（Turbopack）・同梱の Chromium（1243 を 1248 の位置へリンク）・PostgreSQL 16（`initdb`・127.0.0.1:55432・trust）。
