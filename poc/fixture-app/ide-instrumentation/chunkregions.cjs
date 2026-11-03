/* =============================================================================
 * 7C（実行コードの版）: Turbopack のサーバー側の生成物（chunk）を「モジュールの区画」に分け、区画ごとの内容のハッシュを作る。
 *
 * **計装（アプリのプロセス）と IDE の両方がこの1つのファイルを使う**（区画の切り方を2か所に持たない）。
 *   計装  生成物を require で読み込んだときの内容（= 実行するスクリプトそのもの。V8 の CallSite.getScriptHash() と同じ
 *         SHA-256）から区画の表を作り、SQL を実行したフレームが入る区画のハッシュと、区画の先頭からの行を記録する
 *   IDE   ディスクの生成物のいまの内容から同じ規則で区画を作り、ハッシュが同じ区画（＝実行したコードと同じ内容）を探す
 *
 * 区画: 行頭が Turbopack のモジュールの見出し（`"<モジュールの名前>", ((__turbopack_context__) => {` など。HEADER_RE）の行から、次の見出しの行の直前まで
 *（最後の区画はファイルの終わりまで）。最初の見出しより前（`module.exports = [` など）は区画にしない。
 * ハッシュは区画の内容（見出しの行を含む・改行を含む・UTF-8）の SHA-256。正規化はしない。
 * 見出しの形が変わって見つからなければ区画は0個になる（呼び出し側は版を確かめられず、未観測にする＝安全側）。
 * 計装が記録するのはハッシュと区画の先頭からの行の番号だけ（絶対パスもモジュールの名前も記録しない）。
 * ========================================================================== */
const crypto = require('node:crypto');

/**
 * Turbopack のモジュールの見出しの行（実測: Next 16.4 の dev のサーバー側の生成物）。行頭が JSON の文字列（モジュールの名前。
 * `\"` を含みうる）で、その後にモジュールの関数（`((__turbopack_context__) => {`・`((__turbopack_context__, module, exports) => {`・
 * `(function(__turbopack_context__){`）が続く形
 */
const HEADER_RE = /^("(?:[^"\\\n]|\\.)*"), \((?:\(__turbopack_context__(?:, module, exports)?\) => \{|function\s*\(__turbopack_context__\)\s*\{)\s*$/;

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * @param {string} text 生成物の内容
 * @returns {{start: number, end: number, hash: string, module: string}[]} start/end は 1 始まりの行番号（end は区画の最後の行を含む）
 */
function chunkRegions(text) {
  if (typeof text !== 'string' || !text.length) return [];
  const starts = [];   // 各行の先頭の文字位置
  for (let i = 0, p = 0; ; i++) {
    starts.push(p);
    const nl = text.indexOf('\n', p);
    if (nl < 0) break;
    p = nl + 1;
  }
  const heads = [];
  for (let i = 0; i < starts.length; i++) {
    const endOfLine = i + 1 < starts.length ? starts[i + 1] - 1 : text.length;
    if (text.charCodeAt(starts[i]) === 34 /* " */ && HEADER_RE.test(text.slice(starts[i], endOfLine))) heads.push(i);
  }
  const out = [];
  for (let k = 0; k < heads.length; k++) {
    const from = starts[heads[k]];
    const toLine = k + 1 < heads.length ? heads[k + 1] : starts.length;   // 次の見出しの行（含まない）
    const to = k + 1 < heads.length ? starts[heads[k + 1]] : text.length;
    /* module: 見出しの中のモジュールの名前（`[project]/src/… [app-rsc] (ecmascript)`）。IDE がソースマップの区画と並べるためだけに使う
     * （計装はこれを記録しない） */
    const lineEnd = text.indexOf('\n', from);
    const m = HEADER_RE.exec(text.slice(from, lineEnd < 0 ? text.length : lineEnd));
    let module = null;
    try { module = m ? JSON.parse(m[1]) : null; } catch { module = null; }
    out.push({ start: heads[k] + 1, end: toLine, hash: sha256(text.slice(from, to)), module });
  }
  return out;
}

/** 1 始まりの行が入る区画（無ければ null） */
function regionOfLine(regions, line) {
  for (const r of regions) if (r.start <= line && line <= r.end) return r;
  return null;
}

module.exports = { chunkRegions, regionOfLine, sha256, HEADER_RE };
