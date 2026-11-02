#!/usr/bin/env bash
# =============================================================================
# Phase 7C-1 — 全 29 本の試験を**直列に**回す（`npm test` は 19 本しか回さない — 07c0 P2-5）。
#   bash scripts/test-all-29.sh <出力ディレクトリ>
# 前提: npm run build 済み（IDE を next start で起動する）・題材の DB（127.0.0.1:55432）・Chrome。
# 1 本ずつ scripts/run-guarded.mjs の下で回す（1 本 15 分・プロセス木の PSS 6 GB・プロセス 150・
# 空きメモリ 2 GB）。E2E を並列にしない（1 本 1.3〜1.6 GB。手元の Mac がメモリ不足で止まった件）。
# 出力: <出力>/suites-summary.tsv（本・通過・失敗・終了コード・秒・最大 PSS・止めた理由）と各本のログ。
# =============================================================================
set -u
OUT=${1:?出力ディレクトリ}
mkdir -p "$OUT"
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
PORT=3100
BASE=http://localhost:$PORT

# npm test の 19 本（package.json の順）＋ 7B 以降の 10 本
SUITES=(poc01 explore measured poc03 elements poc05 flows poc02 rsc poc04 lineage sqlparse sqlimpact model
  project-inspect devserver devserver-stub runtime-e2e
  childenv-origin preview-gateway select-unit preview-e2e select-e2e observe-unit observe-e2e
  queries-unit lineage-live-unit queries-e2e lineage-e2e)
[ "${#SUITES[@]}" -eq 29 ] || { echo "本数が 29 ではありません: ${#SUITES[@]}"; exit 2; }
[ "$(ls tests/*.spec.mjs | wc -l)" -eq 29 ] || { echo "tests/*.spec.mjs が 29 本ではありません"; exit 2; }

npm run build:lib > "$OUT/build-lib.log" 2>&1 || { echo "build:lib に失敗"; exit 1; }

# BASE を使う 7 本（explore・measured・elements・flows・rsc・lineage・runtime-e2e）のための IDE
setsid npx next start -p "$PORT" -H 127.0.0.1 > "$OUT/ide.log" 2>&1 &
IDE_PID=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/" > /dev/null 2>&1 && break; sleep 1; done
trap 'pkill -KILL -g "$(ps -o pgid= -p $IDE_PID | tr -d " ")" 2>/dev/null' EXIT

printf 'suite\tpass\tfail\texit\tsec\tpeak_tree_pss_mb\tstopped_by\n' > "$OUT/suites-summary.tsv"
TOTAL_FAIL=0
for s in "${SUITES[@]}"; do
  BASE=$BASE node scripts/run-guarded.mjs --time 900 --pss-mb 6144 --procs 150 --min-avail-mb 2048 \
    --out "$OUT/$s.guard.json" -- node "tests/$s.spec.mjs" > "$OUT/$s.log" 2>&1
  rc=$?
  line=$(grep -E '件通過 / [0-9]+ 件失敗' "$OUT/$s.log" | tail -1)
  pass=$(echo "$line" | grep -oE '[0-9]+ 件通過' | grep -oE '[0-9]+'); fail=$(echo "$line" | grep -oE '[0-9]+ 件失敗' | grep -oE '[0-9]+')
  read -r sec pss stop < <(node -e "const g=require('$OUT/$s.guard.json').summary;console.log(g.seconds,g.maxPssMB,g.stoppedBy?JSON.stringify(g.stoppedBy):'-')")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$s" "${pass:--}" "${fail:--}" "$rc" "$sec" "$pss" "$stop" | tee -a "$OUT/suites-summary.tsv"
  [ "$rc" -eq 0 ] || TOTAL_FAIL=$((TOTAL_FAIL + 1))
done
echo "失敗した本: $TOTAL_FAIL / 29"
exit "$TOTAL_FAIL"
