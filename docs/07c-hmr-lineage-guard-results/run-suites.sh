#!/usr/bin/env bash
# =============================================================================
# 7C HMR 安全対策の回帰の実行記録用（scripts/test-all-29.sh と同じ手順の複写。差は本数の検査を外し、
# 回す本を引数で選べるようにしたことだけ。tests/*.spec.mjs はこの時点で 36 本あり、元のスクリプトの
# 「29 本であること」の検査で止まるため。元のスクリプトは変えていない）。
#   bash docs/07c-hmr-lineage-guard-results/run-suites.sh <出力ディレクトリ> <本> [<本> ...]
# 前提: npm run build 済み・題材の DB（127.0.0.1:55432）・Chromium（PW_CHANNEL=none）。
# =============================================================================
set -u
OUT=${1:?出力ディレクトリ}
shift
mkdir -p "$OUT"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO"
PORT=3100
BASE=http://localhost:$PORT
npm run build:lib > "$OUT/build-lib.log" 2>&1 || { echo "build:lib に失敗"; exit 1; }
setsid npx next start -p "$PORT" -H 127.0.0.1 > "$OUT/ide.log" 2>&1 &
IDE_PID=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/" > /dev/null 2>&1 && break; sleep 1; done
trap 'pkill -KILL -g "$(ps -o pgid= -p $IDE_PID | tr -d " ")" 2>/dev/null' EXIT
[ -f "$OUT/suites-summary.tsv" ] || printf 'suite\tpass\tfail\texit\tsec\tpeak_tree_pss_mb\tstopped_by\n' > "$OUT/suites-summary.tsv"
TOTAL_FAIL=0
for s in "$@"; do
  BASE=$BASE node scripts/run-guarded.mjs --time 1500 --pss-mb 6144 --procs 150 --min-avail-mb 2048 \
    --out "$OUT/$s.guard.json" -- node "tests/$s.spec.mjs" > "$OUT/$s.log" 2>&1
  rc=$?
  line=$(grep -E '件通過 / [0-9]+ 件失敗' "$OUT/$s.log" | tail -1)
  pass=$(echo "$line" | grep -oE '[0-9]+ 件通過' | grep -oE '[0-9]+'); fail=$(echo "$line" | grep -oE '[0-9]+ 件失敗' | grep -oE '[0-9]+')
  read -r sec pss stop < <(node -e "const g=require('$OUT/$s.guard.json').summary;console.log(g.seconds,g.maxPssMB,g.stoppedBy?JSON.stringify(g.stoppedBy):'-')")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$s" "${pass:--}" "${fail:--}" "$rc" "$sec" "$pss" "$stop" | tee -a "$OUT/suites-summary.tsv"
  [ "$rc" -eq 0 ] || TOTAL_FAIL=$((TOTAL_FAIL + 1))
done
echo "失敗した本: $TOTAL_FAIL / $#"
exit "$TOTAL_FAIL"
