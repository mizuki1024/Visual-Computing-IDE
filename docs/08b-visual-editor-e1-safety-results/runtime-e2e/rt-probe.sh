#!/usr/bin/env bash
# runtime-e2e を cold/warm × 修正前/修正後 で回す（IDE は next start で 1 つ起動）
cd /home/user/Visual-Computing-IDE
R=docs/08b-visual-editor-e1-safety-results/runtime-e2e
IDE=
run() { # name spec cold?
  [ -n "$IDE" ] && pkill -KILL -g "$(ps -o pgid= -p $IDE | tr -d ' ')" 2>/dev/null
  setsid npx next start -p 3100 -H 127.0.0.1 > $R/ide-$1.log 2>&1 &
  IDE=$!
  for _ in $(seq 1 60); do curl -fs http://127.0.0.1:3100/ >/dev/null 2>&1 && break; sleep 1; done
  [ "$3" = cold ] && rm -rf poc/fixture-app/.next
  local t0=$(date +%s)
  BASE=http://localhost:3100 PW_CHANNEL=none node "$2" > "$R/$1.log" 2>&1; local rc=$?
  echo -e "$1\t$(grep -E '件通過' $R/$1.log | tail -1)\t$(grep -oE '起動中は経過秒[^—]*|起動中の画面を読む前[^）]*' $R/$1.log | head -1)\trc=$rc\t$(( $(date +%s)-t0 ))s\tnext_cache=$([ -d poc/fixture-app/.next ] && echo present || echo absent)" | tee -a $R/summary.tsv
}
: > $R/summary.tsv
run before-fix-cold tests/runtime-e2e-prefix.tmp.mjs cold
run before-fix-warm tests/runtime-e2e-prefix.tmp.mjs warm
run after-fix-warm tests/runtime-e2e.spec.mjs warm
run after-fix-cold tests/runtime-e2e.spec.mjs cold
run after-fix-warm2 tests/runtime-e2e.spec.mjs warm
pkill -KILL -g "$(ps -o pgid= -p $IDE | tr -d ' ')" 2>/dev/null
