# Git ブランチの棚卸しと機能単位への整理 — 報告

| | |
| --- | --- |
| 実施日 | 2026-11-03 |
| 対象 | `mizuki1024/Visual-Computing-IDE` のローカル・リモートの全ブランチ（`git fetch origin` の後。タグは 0） |
| 方法 | 読み取りだけのコマンド（`for-each-ref`・`merge-base --is-ancestor`・`rev-list --left-right --count`・`log <b> --not <他の全 ref>`・`cherry`・`diff --name-status`・`rev-parse <ref>:<path>` による blob の比較）。**祖先関係だけでなく、各ブランチが変えたファイルの内容（blob）を、作業基準のブランチと1つずつ比べた** |
| 守ったこと | ブランチの削除なし・main へのマージなし・強制 push なし・既存ブランチの付け替えなし・履歴の書き換えなし。新しい機能別ブランチは既存のコミットを指す**新しい名前**として通常の push で作った |
| 結論 | **全 10 本は1本の直線の履歴（マージコミット 0）に並び、作業基準（いまの作業ブランチ）がすべてのブランチの成果物を同じ内容で含む。失われる成果物は無い。** 機能別の2本（`feature/explore`・`feature/visual-editor`）を作った（第5節）。削除はしていない（候補と根拠は第6節） |

---

## 1. 全ブランチ一覧（調査時点）

ローカルの2本（`claude/hmr-lineage-safety-investigation-enzr9f`・`claude/hmr-safety-branch-consolidation-qux5mr`）は、同名のリモートと同じコミット。

| # | ブランチ（origin/） | HEAD | 最終更新（UTC） | 内容 | 状態 |
| --- | --- | --- | --- | --- | --- |
| 1 | `main` | `b040295` docs: README が未作成の報告書を指していたのを直す | 2026-11-01 04:03 | 安定版（7A 前半まで） | 既定ブランチ。後続より古い |
| 2 | `claude/happy-euler-7404el` | `e5fb310` fix(ui): Phase 7C-3 限定試用前の表示改善… | 2026-11-02 12:50 | 探索: 7A 残件〜7C-3（報告書 07a〜07c3） | 完了 |
| 3 | `claude/edit-track-ia-ux-handoff` | `79bd986` docs(edit): 編集トラックの UI 精緻化（04e）… | 2026-11-02 15:22 | 編集: IA・UX・UI（02e・02f・03e・04e 0.1） | 完了 |
| 4 | `claude/edit-poc-padding-roundtrip` | `946dcb7` poc(edit): 編集トラックの技術PoC（06h）… | 2026-11-02 16:26 | 編集: 技術 PoC 06h（poc/edit・poc/fixture-edit・04e 0.2・13-edit-adopted-ui.png） | 完了（PoC の結論あり） |
| 5 | `claude/edit-poc-review` | `f1260e2` docs(edit): 編集 PoC（06h）の独立レビューと再現テスト | 2026-11-02 17:09 | 編集: 06h のレビュー（未解決 F-01〜F-05 などを指摘） | レビュー完了。**指摘は未解決** |
| 6 | `claude/explore-f01-selection-revision` | `09c3dee` fix(select): F-01 コード変更前の選択… | 2026-11-02 18:10 | 探索: 選択の版の照合（探索の F-01） | 完了 |
| 7 | `claude/lineage-e2e-recovery-m3ab86` | `f61843b` docs(lineage): 完了条件の判定と引き継ぎ… | 2026-11-03 00:48 | 探索: lineage-e2e の失敗の解消 | 完了 |
| 8 | `claude/hmr-lineage-safety-investigation-enzr9f` | `6b73e06` docs(lineage): HMR 後のリネージ照合の安全性調査… | 2026-11-03 01:32 | 探索: HMR 後の誤対応の調査と設計 | 調査完了 |
| 9 | `claude/hmr-lineage-safety-guard-0490hg` | `cdb9e07` docs(lineage): …案A の実装報告を確定（部分完了…） | 2026-11-03 03:41 | 探索: 案A（A1〜A3） | 部分完了（第3の経路が未解決だった） |
| 10 | `claude/hmr-safety-branch-consolidation-qux5mr` | （第5節） | 2026-11-03 | 探索: 最終安全対策（A4・A5）とこの整理 | 今回の作業ブランチ |

## 2. 祖先関係・統合状況

`git merge-base --is-ancestor` で全区間を確かめた。マージコミットは 0。

```
main  b040295
 └─ happy-euler-7404el  e5fb310            +15 探索 7A 残件〜7C-3
     └─ edit-track-ia-ux-handoff  79bd986   +2  編集 IA/UX/UI
         └─ edit-poc-padding-roundtrip  946dcb7   +1  編集 PoC 06h
             └─ edit-poc-review  f1260e2           +1  06h のレビュー   ← feature/visual-editor
                 └─ explore-f01-selection-revision  09c3dee   +1  探索 F-01
                     └─ lineage-e2e-recovery-m3ab86  f61843b   +7
                         └─ hmr-lineage-safety-investigation-enzr9f  6b73e06   +1
                             └─ hmr-lineage-safety-guard-0490hg  cdb9e07   +14
                                 └─ hmr-safety-branch-consolidation-qux5mr   +今回   ← feature/explore
```

- 各ブランチの分岐元は図の1つ上のブランチ（その HEAD がちょうど merge-base）。main との merge-base はすべて `b040295`。
- **固有のコミット**（他のどの ref にも含まれないコミット）を持つのは今回の作業ブランチだけ。ほかの 9 本は、後のブランチに対して ahead 0。
- 編集トラックの3本は探索トラックの途中に直列に挟まっている（別の系統に分かれていない）。そのため編集トラックの成果物は、その後の探索のブランチにもすべて入っている。

## 3. 各ブランチ固有の成果物と、作業基準での有無（内容の照合）

各区間（親..ブランチ）で変えたファイルについて、そのブランチでの blob と作業基準での blob を比べた。**どの区間でもファイルの削除は 0、作業基準に無いファイルは 0。** blob が違うものは、すべて後のコミットで更新されたもの（直線の履歴なので作業基準のほうが新しい）。

| ブランチ | 区間で変えたファイル | 作業基準と同じ blob | 違うもの（理由） |
| --- | --- | --- | --- |
| main | — | — | main のツリーにあって作業基準に無いファイル 0。違う 59 は main の後に更新 |
| happy-euler-7404el | 283 | 264 | 19（src・tests・README 等。後続の F-01・lineage 復旧・案A で更新） |
| edit-track-ia-ux-handoff | 4（02e・02f・03e・04e） | 3 | `04e`（0.1 → 次の `946dcb7` で 0.2。0.1 の提案は 0.2 の中に「不採用」として記録が残る。0.1 は履歴 `79bd986` から常に取り出せる） |
| edit-poc-padding-roundtrip | 52 | 52 | 0 |
| edit-poc-review | 8 | 8 | 0 |
| explore-f01-selection-revision | 31 | 29 | 2（LivePreview.tsx・liveLineage.ts。案A で更新） |
| lineage-e2e-recovery-m3ab86 | 39 | 37 | 2（otel.cjs・lineage-revision-e2e。案A・今回で更新） |
| hmr-lineage-safety-investigation-enzr9f | 21 | 21 | 0 |
| hmr-lineage-safety-guard-0490hg | 168 | 160 | 8（今回の作業で更新した実装4・試験4: otel.cjs・srvmap.mjs・liveObservation.ts・dataAccess.ts・hmr-chunk-layout-e2e・hmr-guard-unit・lineage-revision-e2e・queries-unit） |

### 3.1 編集トラックの成果物（指定のもの）

| パス | edit-poc-review（f1260e2） | 作業基準（いま） |
| --- | --- | --- |
| docs/02e-edit-information-architecture.md | 5c88e62 | 5c88e62 |
| docs/02f-edit-ia-change-proposals.md | 2f61b60 | 2f61b60 |
| docs/03e-edit-ux-design.md | 0cb03e9 | 0cb03e9 |
| docs/04e-edit-ui-refinement.md | a2ebf80（0.2） | a2ebf80 |
| docs/design-references/13-edit-adopted-ui.png | 4eab4fc | 4eab4fc |
| docs/06h-edit-poc-report.md | fb2b042 | fb2b042 |
| docs/06h-edit-poc-review.md | e5cb654 | e5cb654 |
| poc/edit/・poc/fixture-edit/・docs/06h-results/・docs/06h-review-results/・docs/06h-screenshots/（61 ファイル） | — | 61/61 同じ（`git diff f1260e2 <作業基準> -- <これらのパス>` が空） |

編集トラックは停止中のまま。新しい編集機能は実装していない。**06h のレビューの未解決の指摘（F-01 位置だけの識別子・F-02 書き込み範囲・F-03 複数ファイルの適用中の外部変更・F-04 確定済みジャーナルへの復旧・F-05 サーバー側の検証の契約）は未解決のまま**で、この整理で完了扱いにしていない（`docs/06h-edit-poc-review.md` 第3節）。

## 4. 分類

| 分類 | ブランチ |
| --- | --- |
| **維持** | `main`（既定ブランチ・安定版）・`feature/explore`（新設）・`feature/visual-editor`（新設）・`claude/hmr-safety-branch-consolidation-qux5mr`（今回の作業ブランチ。セッションの間は push 先として要る） |
| **統合済み・削除候補** | `claude/happy-euler-7404el`・`claude/edit-track-ia-ux-handoff`・`claude/edit-poc-padding-roundtrip`・`claude/edit-poc-review`・`claude/explore-f01-selection-revision`・`claude/lineage-e2e-recovery-m3ab86`・`claude/hmr-lineage-safety-investigation-enzr9f`（ローカル・リモートとも）・`claude/hmr-lineage-safety-guard-0490hg` |
| **要確認** | なし（固有の成果物・未統合の変更を持つ claude/ ブランチは無い）。ただし GitHub 上のプルリクエストの有無・状態は確かめていない（下記） |

未確認: GitHub のプルリクエストの状態（このセッションでは確認していない。削除の前に、各ブランチを head にした開いているプルリクエストが無いことを確かめること）。

## 5. 機能別ブランチ（作成した）

| ブランチ | 指すコミット | 内容 | 位置づけ |
| --- | --- | --- | --- |
| `feature/explore` | （第5.1節） | 探索・リネージ・観測・F-01・HMR の安全対策（A1〜A5）の最新の作業基準 | 探索トラックの開発を続ける線。**安定版ではない**（安定版は main。main へのマージはしていない） |
| `feature/visual-editor` | `f1260e2`（edit-poc-review の HEAD） | 編集トラックの IA・UX・UI・技術 PoC・レビューの最終の状態。それより後の探索の変更を含まない | 停止中の編集トラックの保管先。再開の判断の基点 |

- どちらも既存のコミットを指す新しい名前で、履歴は変えていない（通常の push。強制 push なし）。
- `feature/visual-editor` を編集トラックの最後のコミットに置いた理由: 編集の成果物は作業基準と同じ内容で、そこより後のコミットは探索トラックのもの（F-01・lineage 復旧・HMR の安全対策）だけ。再開の時点で探索の最新を取り込むか（`feature/explore` からの早送り・マージ）は、再開の判断と一緒に決める。

### 5.1 作成の記録

（push の結果を記入する）

## 6. 削除候補と、削除しても成果物を失わない根拠

**今回は削除していない。** 削除する前に、各ブランチを head とする開いているプルリクエストが無いことを確かめること。

| 候補 | 根拠 |
| --- | --- |
| `claude/happy-euler-7404el`・`claude/edit-track-ia-ux-handoff`・`claude/edit-poc-padding-roundtrip`・`claude/edit-poc-review`・`claude/explore-f01-selection-revision`・`claude/lineage-e2e-recovery-m3ab86`・`claude/hmr-lineage-safety-investigation-enzr9f`（ローカルも）・`claude/hmr-lineage-safety-guard-0490hg` | (1) HEAD が `feature/explore` の祖先（コミットはすべて残る）。(2) 区間で変えたファイルは削除 0・作業基準に無いファイル 0。(3) 違う blob は後のコミットでの更新だけ（古い版は履歴から取り出せる）。(4) 編集の3本の HEAD（の編集の成果物）は `feature/visual-editor`（＝`edit-poc-review` と同じコミット）と `feature/explore` の両方に同じ内容で残る |
| `claude/hmr-safety-branch-consolidation-qux5mr` | このセッションが終わり、`feature/explore` と同じコミットであることを確かめた後 |

## 7. 今後のブランチ運用ルール

1. **ブランチは機能（トラック）単位。** 探索は `feature/explore`、視覚編集は `feature/visual-editor`。安定版は `main`。セッションごとの新しいブランチを増やさない。
2. **同じ機能の開発を続けるときは、そのトラックのブランチの先端から続ける。** Claude Code のセッションがセッション用のブランチ（`claude/…`）を割り当てる場合は、(a) トラックのブランチの先端から作り、(b) 作業の区切りでトラックのブランチを**早送りだけ**で進め（`git push origin <コミット>:feature/<トラック>`。早送りにならなければ止めて報告）、(c) 進めた後、そのセッション用のブランチは削除候補として記録する。
3. **main へは、完了条件を満たした区切り（全件の試験・報告書・ユーザーの承認）だけを入れる。** 部分完了・未解決の安全対策を含む状態を main に入れない。
4. 強制 push・履歴の書き換え・既存ブランチの付け替えはしない。削除は、祖先関係と成果物の内容（blob）の両方で取り込み済みを確かめ、開いているプルリクエストが無いことを確かめてから、ユーザーの承認の後に行う。
5. 2つのトラックが同じファイルを変える必要が出たら、どちらで変えるかを先に決める（今は編集トラックが停止中なので衝突は無い）。
6. 新しいセッションの最初に、`git fetch origin` とトラックのブランチの先端・作業ツリーの状態を確かめ、引き継ぎの報告書に書かれたコミットと一致することを記録する。
