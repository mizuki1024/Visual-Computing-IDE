/* =============================================================================
 * 収集物の出力先。ローカルのファイルに追記するだけ。外部へ送信しない（05c 3章）。
 * プロセスごとの事情（pid / 起動方式 / バンドラ）を一緒に残す。UR-03 の判定に要る。
 * ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');

const file = process.env.POC01_SPAN_FILE;

let stream = null;
function out() {
  if (!file) return null;
  if (!stream) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
  }
  return stream;
}

const PROC = {
  pid: process.pid,
  ppid: process.ppid,
  mode: process.env.POC01_MODE ?? 'unknown',      // 方式1 / 方式2
  bundler: process.env.POC01_BUNDLER ?? 'unknown',
  run: process.env.POC01_RUN ?? 'unknown',
  // 何のプロセスか（dev server 本体かワーカーか）を後から見分けるための手掛かり。
  // argv そのものは環境の情報を含みうるので、ファイル名だけに切り詰める
  argv1: process.argv[1] ? path.basename(process.argv[1]) : null,
};

function write(record) {
  const s = out();
  if (!s) return;
  s.write(JSON.stringify({ ...record, proc: PROC }) + '\n');
}

function note(kind, detail) {
  write({ type: 'note', kind, detail });
}

module.exports = { write, note, PROC };
