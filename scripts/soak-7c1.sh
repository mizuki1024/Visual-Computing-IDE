#!/usr/bin/env bash
# =============================================================================
# Phase 7C-1 — 長時間起動の計測の手順（上限つき）。記録用で、試験ではない。
#   bash scripts/soak-7c1.sh <出力ディレクトリ>
# 前提: npm run build 済み・題材の DB（127.0.0.1:55432）が動いている・Chrome（channel: chrome）。
# **run-guarded.mjs の下で回す**（時間・PSS・プロセス数・空きメモリの上限）。手元の Mac では回さない。
#   1. IDE（next start）を起動し、scripts/soak-7c0.mjs（7C-1 で拡張）を回す
#      — 1,500 要求・保持範囲から外れた文書・停止／異常終了／再起動。最後の起動は動かしたまま残す
#   2. IDE を SIGKILL（強制終了）。開発サーバーは残る（7A の設計）。強制終了の前の起動の
#      残骸（書き手の死んだ収集ファイル）を1つ置いてから IDE を起動し直し、
#      引き継いだ起動のファイルは残り・残骸は消えることを確かめる。最後に停止して消えることを確かめる
# =============================================================================
set -u
OUT=${1:?出力ディレクトリ}
mkdir -p "$OUT"
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
PORT=${VCIDE_SOAK_PORT:-3100}
BASE=http://127.0.0.1:$PORT
H=(-H "content-type: application/json" -H "x-vcide-request: 1" -H "origin: $BASE")
log() { echo "[soak-7c1] $*" | tee -a "$OUT/steps.log"; }

start_ide() {
  setsid npx next start -p "$PORT" -H 127.0.0.1 > "$OUT/ide-$1.log" 2>&1 &
  IDE_PID=$!
  for _ in $(seq 1 60); do curl -fs "$BASE/api/runtime/status" > /dev/null 2>&1 && return 0; sleep 1; done
  log "IDE が応答しません"; return 1
}
kill_ide() { pkill -KILL -g "$(ps -o pgid= -p "$IDE_PID" | tr -d ' ')" 2>/dev/null; sleep 1; }

log "1. IDE を起動して soak を回す"
start_ide a || exit 1
VCIDE_SOAK_IDE_PID=$IDE_PID VCIDE_SOAK_LEAVE_RUNNING=1 VCIDE_SOAK_OUT="$OUT/soak.json" BASE=$BASE \
  node scripts/soak-7c0.mjs 2>&1 | tee "$OUT/soak.log"
SOAK_RC=${PIPESTATUS[0]}
log "soak の終了コード: $SOAK_RC"
curl -s "$BASE/api/runtime/status" > "$OUT/status-before-idekill.json"
DEV_PID=$(node -e "const j=require('$OUT/status-before-idekill.json');console.log(j.runtime.pid??'')")
SPAN=$(node -e "const j=require('$OUT/status-before-idekill.json');console.log(j.runtime.instrumentation.spanFile??'')")

log "2. IDE を SIGKILL（開発サーバー PID $DEV_PID は残る）"
kill_ide
kill -0 "$DEV_PID" 2>/dev/null && log "開発サーバーは生きている" || log "開発サーバーが落ちた（想定外）"
# 強制終了の前の起動の残骸（書き手のプロセスは存在しない）
REMNANT=.ide-runtime/spans/fixture-app-1600000000000.jsonl
echo '{"type":"note","kind":"registered","proc":{"pid":999999901,"run":"fixture-app-1600000000000"}}' > "$REMNANT"
# IDE の名前ではないファイル（利用者が置いたもの）
echo keep > .ide-runtime/spans/user-notes.txt
start_ide b || exit 1
curl -s "$BASE/api/runtime/status" > "$OUT/status-after-ide-restart.json"
node -e "
const j=require('$OUT/status-after-ide-restart.json'); const fs=require('fs');
const r={owner:j.runtime.owner,state:j.runtime.state,pid:j.runtime.pid,adoptedFileKept:fs.existsSync('$SPAN'),remnantRemoved:!fs.existsSync('$REMNANT'),userFileKept:fs.existsSync('.ide-runtime/spans/user-notes.txt'),cleanup:j.spanCleanup};
console.log(JSON.stringify(r,null,1)); fs.writeFileSync('$OUT/idekill.json',JSON.stringify(r,null,1));"
log "3. 引き継いだ起動を停止"
curl -s -X POST "${H[@]}" -d '{}' "$BASE/api/runtime/stop" > "$OUT/stop-after-adopt.json"
# 停止の直後はワーカーが終わりきっていないことがある。IDE は 3 秒後・20 秒後に整理をやり直す（最大 25 秒待つ）
for _ in $(seq 1 50); do [ -e "$SPAN" ] || break; sleep 0.5; done
curl -s "$BASE/api/runtime/status" > "$OUT/status-final.json"
node -e "
const fs=require('fs'); const j=require('$OUT/status-final.json');
const r={state:j.runtime.state,adoptedFileRemoved:!fs.existsSync('$SPAN'),devServerGone:(()=>{try{process.kill($DEV_PID,0);return false}catch{return true}})(),userFileKept:fs.existsSync('.ide-runtime/spans/user-notes.txt'),cleanup:j.spanCleanup,spanDir:fs.readdirSync('.ide-runtime/spans')};
console.log(JSON.stringify(r,null,1)); fs.writeFileSync('$OUT/final.json',JSON.stringify(r,null,1));"
rm -f .ide-runtime/spans/user-notes.txt
kill_ide
exit "$SOAK_RC"
