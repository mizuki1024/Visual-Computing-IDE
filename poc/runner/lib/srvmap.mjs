/* =============================================================================
 * サーバー側の生成物の位置を、元のソース位置へ戻す（PoC-02 Gate B）。
 *
 * ブラウザ側（PoC-05）は CDP で生成物とソースマップを引けた。
 * **サーバー側には CDP が無い。** 代わりにディスク上の生成物から引く。
 * バンドラで形が違うので、2つの経路を用意してある。
 *
 *   Turbopack  フレームの url が `.next/dev/server/chunks` 以下の実ファイル。
 *              隣に `<同名>.js.map` があるので、それを読んで戻す
 *   webpack    フレームの url が `webpack-internal:///(rsc)/./src/...` という
 *              仮想URL。モジュールは `.next/dev/server` 以下の js の中で
 *              `eval("…")` に包まれており、その文字列の末尾に
 *              インラインのソースマップが付いている。eval のブロックを
 *              取り出して索引を作る
 *
 * ソースマップは「生成物 → 元の位置」の決定的な写像である。推測ではない。
 * ただし開発ビルドの生成物に依存する（01b Q-03 C-5 と同じ制約）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { APP } from './util.mjs';
import { originalPositionFor } from './srcmap.mjs';

const NEXT_DIRS = ['.next/dev/server', '.next/server'];

/** 元ソース名の正規化。バンドラごとに接頭辞が違うので src/ 以下だけを取る */
export function normalizeSource(source) {
  if (!source) return null;
  const s = String(source).replace(/\\/g, '/');
  if (s.includes('node_modules')) return null;
  const m = /(?:^|\/)(src\/[^?]*\.(?:tsx|ts|jsx|js))(?:$|\?)/.exec(s);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------- Turbopack */

const diskMaps = new Map();

function diskMap(relFile) {
  if (diskMaps.has(relFile)) return diskMaps.get(relFile);
  let map = null;
  const abs = path.join(APP, relFile);
  try {
    if (fs.existsSync(`${abs}.map`)) {
      map = JSON.parse(fs.readFileSync(`${abs}.map`, 'utf8'));
    } else if (fs.existsSync(abs)) {
      // インラインのソースマップが付いている場合
      const body = fs.readFileSync(abs, 'utf8');
      const m = /[#@]\s*sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/.exec(body);
      if (m) map = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    }
  } catch { map = null; }
  diskMaps.set(relFile, map);
  return map;
}

/* ---------------------------------------------------------------- webpack */

/**
 * `.next` 以下の生成物を走査し、`eval("…")` ブロックごとに
 * 「仮想URL → インラインのソースマップ」の索引を作る。
 *
 * webpack の dev ビルドは1モジュール = 1つの eval であり、その文字列の末尾に
 *   //# sourceURL=webpack-internal:///(rsc)/./src/app/…
 *   //# sourceMappingURL=data:application/json;charset=utf-8;base64,…
 * の両方が入っている（実測）。
 */
let evalIndex = null;

function walkJs(dir, out, depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'cache' || e.name === 'static') continue;
      walkJs(p, out, depth + 1);
    } else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function buildEvalIndex() {
  const index = new Map();
  const files = [];
  for (const d of NEXT_DIRS) walkJs(path.join(APP, d), files);
  const re = /eval\("((?:[^"\\]|\\.)*)"\)/g;
  for (const f of files) {
    let body;
    try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!body.includes('sourceURL=webpack-internal')) continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(body))) {
      let code;
      try { code = JSON.parse(`"${m[1]}"`); } catch { continue; }
      const u = /[#@]\s*sourceURL=(webpack-internal:[^\s\n]+)/.exec(code);
      if (!u) continue;
      const sm = /[#@]\s*sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/.exec(code);
      if (!sm) continue;
      let map;
      try { map = JSON.parse(Buffer.from(sm[1], 'base64').toString('utf8')); } catch { continue; }
      // 同じモジュールが rsc 層と ssr 層に2つ出る。先に見つけたものを使い、
      // 鍵（仮想URL）には層の別が入っているので取り違えない
      if (!index.has(u[1])) index.set(u[1], map);
    }
  }
  return index;
}

/* -------------------------------------------------------------------------- */

/** 索引を作り直す。dev server を再起動したら呼ぶ */
export function resetSrvMaps() {
  diskMaps.clear();
  evalIndex = null;
}

/**
 * 1フレームを元のソース位置へ戻す。
 *
 * @param {{file:string, line:number, col:number, scope:string}} frame
 * @returns {{file:string, line:number, col:number}|null}
 *   `null` は「戻せなかった」である。**推測で埋めない。**
 */
export function resolveServerFrame(frame) {
  if (!frame || !frame.line) return null;

  if (frame.scope === 'build-output') {
    const map = diskMap(frame.file);
    if (!map) return null;
    const pos = originalPositionFor(map, frame.line, (frame.col ?? 1) - 1);
    const file = normalizeSource(pos?.source);
    return file ? { file, line: pos.line, col: pos.column } : null;
  }

  if (frame.scope === 'bundler-virtual') {
    if (!evalIndex) evalIndex = buildEvalIndex();
    const map = evalIndex.get(frame.file);
    if (!map) return null;
    const pos = originalPositionFor(map, frame.line, (frame.col ?? 1) - 1);
    const file = normalizeSource(pos?.source);
    return file ? { file, line: pos.line, col: pos.column } : null;
  }

  return null;
}

/** 索引の件数（報告に出す。解決できなかった理由の切り分けに使う） */
export function srvMapStats() {
  if (!evalIndex) evalIndex = buildEvalIndex();
  return { evalModules: evalIndex.size, diskMaps: diskMaps.size };
}
