#!/usr/bin/env bash
# =============================================================================
# 全件の試験を**直列に**回す（scripts/test-all-29.sh と同じ手順。差は次の2つだけ）。
#   1. 回す本の一覧を、tests/*.spec.mjs と**両向きに**照らし合わせる（一覧に無い試験・一覧にだけある名前があれば止める）。
#      7C 以降に足した 7 本（callsite-entry-unit・select-revision-*・lineage-revision-e2e・hmr-*）と、
#      編集 E1 の 6 本（edit-*。docs/08a-visual-editor-e1-report.md）と E1.1 の安全性の監査の 1 本（edit-safety-unit。docs/08b）と
#      E2 の同期の層の 2 本（edit-sync-unit・edit-sync-e2e。docs/08c）と
#      E2.1 のプレビューと編集対象の同期の 2 本（edit-sync21-unit・edit-sync21-e2e。docs/08d）を含む 47 本。
#   2. lineage-e2e を、題材の**使い捨てのコピー**（poc/out/lineage-copy。IDE の中ではない場所）でも回す（行名 lineage-e2e@copy）。
#      題材が IDE の中にあると、IDE 側の依存とたまたま同じことで通ってしまう（docs/07c-lineage-e2e-recovery-report.md 第9節）。
#   bash scripts/test-all.sh <出力ディレクトリ> [<本> ...]     （本を省くと全件。指定しても一覧の照合は行う）
# 前提: npm run build 済み・題材の DB（127.0.0.1:55432）・Chromium（PW_CHANNEL）。
# 出力: <出力>/suites-summary.tsv（本・通過・失敗・終了コード・秒・最大 PSS・止めた理由）と各本のログ。
# =============================================================================
set -u
OUT=${1:?出力ディレクトリ}
shift
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
PORT=3100
BASE=http://localhost:$PORT

# test-all-29.sh の 29 本（同じ順）＋ 7C 以降の 7 本 ＋ 編集 E1 の 6 本 ＋ E1.1 の 1 本 ＋ E2 の 2 本 ＋ E2.1 の 2 本（探索の本の後に回す）
SUITES=(poc01 explore measured poc03 elements poc05 flows poc02 rsc poc04 lineage sqlparse sqlimpact model
  project-inspect devserver devserver-stub runtime-e2e
  childenv-origin preview-gateway select-unit preview-e2e select-e2e observe-unit observe-e2e
  queries-unit lineage-live-unit queries-e2e lineage-e2e
  callsite-entry-unit select-revision-unit select-revision-e2e lineage-revision-e2e
  hmr-guard-unit hmr-lineage-guard-e2e hmr-chunk-layout-e2e
  edit-engine-unit edit-scope-unit edit-journal-unit edit-verify-unit edit-disabled edit-e2e edit-safety-unit
  edit-sync-unit edit-sync-e2e
  edit-sync21-unit edit-sync21-e2e)
LISTED=$(printf '%s\n' "${SUITES[@]}" | sort)
ONDISK=$(ls tests/*.spec.mjs | xargs -n1 basename | sed 's/\.spec\.mjs$//' | sort)
if [ "$LISTED" != "$ONDISK" ]; then
  echo "一覧と tests/*.spec.mjs が一致しません"
  echo "  一覧に無い試験: $(comm -13 <(echo "$LISTED") <(echo "$ONDISK") | tr '\n' ' ')"
  echo "  一覧にだけある名前: $(comm -23 <(echo "$LISTED") <(echo "$ONDISK") | tr '\n' ' ')"
  exit 2
fi
[ "$(printf '%s\n' "${SUITES[@]}" | sort -u | wc -l)" -eq "${#SUITES[@]}" ] || { echo "一覧に重複があります"; exit 2; }
RUN=("$@")
[ "${#RUN[@]}" -gt 0 ] || RUN=("${SUITES[@]}" "lineage-e2e@copy")
for s in "${RUN[@]}"; do
  [ "$s" = "lineage-e2e@copy" ] || printf '%s\n' "${SUITES[@]}" | grep -qx "$s" || { echo "一覧に無い本: $s"; exit 2; }
done

npm run build:lib > "$OUT/build-lib.log" 2>&1 || { echo "build:lib に失敗"; exit 1; }

# BASE を使う本のための IDE
setsid npx next start -p "$PORT" -H 127.0.0.1 > "$OUT/ide.log" 2>&1 &
IDE_PID=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/" > /dev/null 2>&1 && break; sleep 1; done
trap 'pkill -KILL -g "$(ps -o pgid= -p $IDE_PID | tr -d " ")" 2>/dev/null' EXIT

# 題材の使い捨てのコピー（lineage-e2e@copy 用。node_modules はハードリンク。Git 管理外）
make_copy() {
  local work="$REPO/poc/out/lineage-copy"
  rm -rf "$work"; mkdir -p "$work/poc"
  cp -r "$REPO/poc/anchor" "$work/poc/anchor"
  mkdir -p "$work/poc/fixture-app"
  (cd "$REPO/poc/fixture-app" && for e in * .[!.]*; do
    [ -e "$e" ] || continue
    case "$e" in node_modules|.next) ;; *) cp -r "$e" "$work/poc/fixture-app/";; esac
  done)
  cp -al "$REPO/poc/fixture-app/node_modules" "$work/poc/fixture-app/node_modules"
  echo "$work/poc/fixture-app"
}

[ -f "$OUT/suites-summary.tsv" ] || printf 'suite\tpass\tfail\texit\tsec\tpeak_tree_pss_mb\tstopped_by\n' > "$OUT/suites-summary.tsv"
TOTAL_FAIL=0
for s in "${RUN[@]}"; do
  spec=$s; extra=()
  if [ "$s" = "lineage-e2e@copy" ]; then spec=lineage-e2e; extra=(env "VCIDE_E2E_PROJECT=$(make_copy)"); fi
  BASE=$BASE "${extra[@]}" node scripts/run-guarded.mjs --time 1500 --pss-mb 6144 --procs 150 --min-avail-mb 2048 \
    --out "$OUT/$s.guard.json" -- node "tests/$spec.spec.mjs" > "$OUT/$s.log" 2>&1
  rc=$?
  line=$(grep -E '件通過 / [0-9]+ 件失敗' "$OUT/$s.log" | tail -1)
  pass=$(echo "$line" | grep -oE '[0-9]+ 件通過' | grep -oE '[0-9]+'); fail=$(echo "$line" | grep -oE '[0-9]+ 件失敗' | grep -oE '[0-9]+')
  read -r sec pss stop < <(node -e "const g=require(process.argv[1]).summary;console.log(g.seconds,g.maxPssMB,g.stoppedBy?JSON.stringify(g.stoppedBy):'-')" "$OUT/$s.guard.json" 2>/dev/null || echo "- - -")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$s" "${pass:--}" "${fail:--}" "$rc" "$sec" "$pss" "$stop" | tee -a "$OUT/suites-summary.tsv"
  [ "$rc" -eq 0 ] || TOTAL_FAIL=$((TOTAL_FAIL + 1))
done
[ -d "$REPO/poc/out/lineage-copy" ] && rm -rf "$REPO/poc/out/lineage-copy"
echo "失敗した本: $TOTAL_FAIL / ${#RUN[@]}"
exit "$TOTAL_FAIL"
