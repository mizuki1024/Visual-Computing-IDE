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
import { createRequire } from 'node:module';
import path from 'node:path';
import { APP } from './util.mjs';
import { originalPositionDetail, originalPositionFor } from './srcmap.mjs';

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

/**
 * 生成物の隣のソースマップ。鍵は絶対パス、生成物とマップの更新時刻・大きさが
 * 変われば読み直す（Phase 7B-3B-1。開発中は同じ名前の生成物が書き換わる）。
 */
function diskMap(relFile, root = APP) {
  const abs = path.join(root, relFile);
  const stamp = (f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } };
  const key = `${stamp(abs)}|${stamp(`${abs}.map`)}`;
  const hit = diskMaps.get(abs);
  if (hit && hit.key === key) return hit.map;
  let map = null;
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
  diskMaps.set(abs, { key, map });
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
/** 対象アプリの場所 → 索引（Phase 7B-3B-1 で対象を引数にした） */
const evalIndexes = new Map();

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

function buildEvalIndex(root = APP) {
  const index = new Map();
  const files = [];
  for (const d of NEXT_DIRS) walkJs(path.join(root, d), files);
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
  evalIndexes.clear();
}

function evalIndexOf(root) {
  let idx = evalIndexes.get(root);
  if (!idx) { idx = buildEvalIndex(root); evalIndexes.set(root, idx); }
  return idx;
}

/**
 * 1フレームを元のソース位置へ戻す。
 *
 * @param {{file:string, line:number, col:number, scope:string}} frame
 * @returns {{file:string, line:number, col:number}|null}
 *   `null` は「戻せなかった」である。**推測で埋めない。**
 */
export function resolveServerFrame(frame, root = APP) {
  if (!frame || !frame.line) return null;

  if (frame.scope === 'build-output') {
    const map = diskMap(frame.file, root);
    if (!map) return null;
    const pos = originalPositionFor(map, frame.line, (frame.col ?? 1) - 1);
    const file = normalizeSource(pos?.source);
    return file ? { file, line: pos.line, col: pos.column } : null;
  }

  if (frame.scope === 'bundler-virtual') {
    const map = evalIndexOf(root).get(frame.file);
    if (!map) return null;
    const pos = originalPositionFor(map, frame.line, (frame.col ?? 1) - 1);
    const file = normalizeSource(pos?.source);
    return file ? { file, line: pos.line, col: pos.column } : null;
  }

  return null;
}

/* ------------------------------------------------------------ 7C（A3） */

/**
 * 7C（A3）: Turbopack のディスクの生成物のフレームを、resolveServerFrame と**同じソースマップ（同じ読み込み）・同じ区画の選び方**で
 * 元の位置へ戻し、そのとき使った区画の `sourcesContent`（元のソースの内容）を返す。
 * 呼び出し側は、戻した位置が resolveServerFrame の結果と一致することを確かめてから、内容を比べる。
 * 仮想モジュール（webpack の eval）は対象にしない（呼び出し側が先に拒む）。既存の resolveServerFrame の振る舞いは変えない。
 * @returns {{file:string, line:number, col:number, sourceContent:string|null}|null}
 */
export function serverFrameProvenance(frame, root = APP) {
  if (!frame || !frame.line || frame.scope !== 'build-output') return null;
  const map = diskMap(frame.file, root);
  if (!map) return null;
  const pos = originalPositionDetail(map, frame.line, (frame.col ?? 1) - 1);
  const file = normalizeSource(pos?.source);
  return file ? { file, line: pos.line, col: pos.column, sourceContent: pos.sourceContent } : null;
}

let anchorTransform;
/**
 * 7C（A3）: ソースマップの区画の sourcesContent と、いまのソースの内容を比べる。**正規化はしない**（空白・改行コードの差も不一致）。
 * 一致とみなすのは次のどちらかとバイト単位で等しいときだけ:
 *   1. いまのソースそのもの（ローダを通らないファイル — .ts・要素識別子の注入を無効にした起動）
 *   2. いまのソースに、IDE が持つ要素識別子のローダ（poc/anchor/transform.cjs）の変換を同じ規則で当てた結果
 *      （ローダは挿入だけを行い行を変えない。Turbopack の sourcesContent はローダの出力である — 実測）
 * ローダの変換器を読み込めず 1 でも一致しなければ 'unverified'（比べられない）。それ以外の不一致は 'mismatch'。
 * @returns {'match'|'mismatch'|'unverified'}
 */
export function compareMapSource(sourceContent, current, rel) {
  if (typeof sourceContent !== 'string' || typeof current !== 'string') return 'unverified';
  if (sourceContent === current) return 'match';
  if (anchorTransform === undefined) {
    try { anchorTransform = createRequire(import.meta.url)('../../anchor/transform.cjs').transform; } catch { anchorTransform = null; }
  }
  if (typeof anchorTransform !== 'function') return 'unverified';
  let out;
  /* ローダは変換に失敗すると元のソースをそのまま返す（loader.cjs）。そのソースは 1 で比べ済み */
  try { out = anchorTransform(current, rel).code; } catch { return 'mismatch'; }
  return out === sourceContent ? 'match' : 'mismatch';
}

/** 索引の件数（報告に出す。解決できなかった理由の切り分けに使う） */
export function srvMapStats(root = APP) {
  return { evalModules: evalIndexOf(root).size, diskMaps: diskMaps.size };
}
