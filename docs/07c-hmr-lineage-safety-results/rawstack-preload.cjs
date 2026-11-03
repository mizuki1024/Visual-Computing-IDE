/* =============================================================================
 * 7C HMR × 由来の安全性調査 — **診断専用**の前置スクリプト（製品・計装ではない）。
 *
 * IDE の計装（poc/fixture-app/ide-instrumentation/boot.cjs）の**後に** --require で読む。
 * アプリが使う pg-pool の Pool.prototype.query を外側から包み、呼び出しの瞬間の
 *   1. 生のスタック（`Error.stack` の文字列。計装の classifyFile が捨てる `?<moduleId>` を含む）
 *   2. 各フレームについて `module.findSourceMap(<生の URL>)` が返す元の位置（Node が持つソースマップ）
 *   3. プロセスのソースマップ設定（process.sourceMapsEnabled・execArgv・NODE_OPTIONS の該当部分）
 * を RAWSTACK_OUT（JSONL）へ書く。計装の振る舞いは変えない（呼び出しはそのまま内側へ渡す）。
 *
 * 絶対パスは APP_DIR からの相対に置き換えて書く。SQL は先頭 120 文字だけ（題材の SQL はリテラルを含まない）。
 * ========================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, findSourceMap } = require('node:module');
const { fileURLToPath } = require('node:url');

const OUT = process.env.RAWSTACK_OUT;
const APP_DIR = process.cwd();
const rel = (s) => String(s).split(APP_DIR).join('<APP>');

function write(o) {
  if (!OUT) return;
  try { fs.appendFileSync(OUT, `${JSON.stringify(o)}\n`); } catch { /* 診断なので握りつぶす */ }
}

write({
  type: 'proc', pid: process.pid, t: Date.now(),
  sourceMapsEnabled: process.sourceMapsEnabled ?? null,
  execArgv: process.execArgv.filter((a) => /source-map/.test(a)),
  nodeOptionsSourceMaps: /--enable-source-maps/.test(process.env.NODE_OPTIONS || ''),
});

const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

function viaNode(url, line, col) {
  /* findSourceMap は「Node が読み込んだコードの URL / パス」を鍵にする。eval のコードは sourceURL が鍵 */
  try {
    const sm = findSourceMap(url);
    if (!sm) return { found: false };
    const e = sm.findEntry(line - 1, col - 1);
    if (!e || e.originalSource === undefined) return { found: true, entry: null };
    return {
      found: true,
      source: rel(String(e.originalSource).startsWith('file://') ? fileURLToPath(e.originalSource) : e.originalSource),
      line: e.originalLine + 1, col: e.originalColumn + 1,
    };
  } catch (err) { return { found: false, error: String(err && err.message).slice(0, 120) }; }
}

function capture(sql) {
  const raw = new Error().stack || '';
  const frames = [];
  for (const l of raw.split('\n').slice(1)) {
    const m = FRAME_RE.exec(l);
    if (!m) continue;
    const url = m[2];
    if (!/\.next[\\/]/.test(url)) continue;               // 生成物のフレームだけ
    const line = Number(m[3]); const col = Number(m[4]);
    const q = url.indexOf('?');
    frames.push({
      fn: m[1] ?? null,
      url: rel(url),
      hasQuery: q >= 0,
      moduleId: q >= 0 ? decodeURIComponent(url.slice(q + 1)).slice(0, 160) : null,
      line, col,
      node: viaNode(url, line, col),
    });
  }
  write({ type: 'rawstack', pid: process.pid, t: Date.now(), sql: String(sql ?? '').slice(0, 120), frames });
}

try {
  const pgPath = createRequire(path.join(APP_DIR, 'package.json')).resolve('pg');
  const PgPool = require(createRequire(pgPath).resolve('pg-pool'));
  const inner = PgPool.prototype.query;
  PgPool.prototype.query = function rawstackProbe(...args) {
    try { capture(typeof args[0] === 'string' ? args[0] : args[0] && args[0].text); } catch { /* 診断 */ }
    return inner.apply(this, args);
  };
  write({ type: 'note', what: 'rawstack-patched', pid: process.pid });
} catch (e) {
  write({ type: 'note', what: 'rawstack-pg-missing', msg: String(e && e.message).split('\n')[0].slice(0, 120) });
}
