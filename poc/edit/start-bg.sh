#!/bin/sh
# 検証用ハーネスを背景で起動し、準備ができるまで待つ（手で確かめるとき用。e2e は自分で起動する）
cd "$(dirname "$0")/../.." || exit 1
LOG=poc/out/edit-server.log
mkdir -p poc/out
POC_EDIT_FAULTS=${POC_EDIT_FAULTS:-0} node poc/edit/server.mjs > "$LOG" 2>&1 &
i=0; while [ $i -lt 90 ]; do grep -q POC_EDIT_READY "$LOG" && { tail -1 "$LOG"; exit 0; }; sleep 1; i=$((i+1)); done
echo "起動しませんでした: $LOG"; exit 1
