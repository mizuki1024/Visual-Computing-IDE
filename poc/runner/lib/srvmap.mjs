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
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { APP } from './util.mjs';
import { originalPositionDetail, originalPositionFor, parseMappings } from './srcmap.mjs';

/** 7C（実行コードの版）: 生成物の区画の切り方。計装と**同じファイル**を使う（切り方を2か所に持たない） */
const chunkRegionsLib = createRequire(import.meta.url)('../../fixture-app/ide-instrumentation/chunkregions.cjs');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

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
  return diskMapEntry(relFile, root).map;
}

/**
 * 7C: diskMap と同じ読み込み（同じ索引）で、読んだソースマップの**内容のハッシュ**（mapSha）も返す。
 * 別ファイルのソースマップならその内容、インラインならそれを含む生成物の内容のハッシュ（inline: true）。
 * 索引の鍵は更新時刻と大きさなので、照合の側は mapSha をいま読んだ内容のハッシュと比べて、索引が古くないことを確かめる。
 */
function diskMapEntry(relFile, root = APP) {
  const abs = path.join(root, relFile);
  const stamp = (f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } };
  const key = `${stamp(abs)}|${stamp(`${abs}.map`)}`;
  const hit = diskMaps.get(abs);
  if (hit && hit.key === key) return hit;
  let map = null;
  let mapSha = null;
  let inline = false;
  try {
    if (fs.existsSync(`${abs}.map`)) {
      const text = fs.readFileSync(`${abs}.map`);
      mapSha = sha256(text);
      map = JSON.parse(text.toString('utf8'));
    } else if (fs.existsSync(abs)) {
      // インラインのソースマップが付いている場合
      const buf = fs.readFileSync(abs);
      const body = buf.toString('utf8');
      const m = /[#@]\s*sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/.exec(body);
      if (m) { map = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); mapSha = sha256(buf); inline = true; }
    }
  } catch { map = null; mapSha = null; }
  const entry = { key, map, mapSha: map ? mapSha : null, inline };
  diskMaps.set(abs, entry);
  return entry;
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
  const entry = diskMapEntry(frame.file, root);
  const map = entry.map;
  if (!map) return null;
  const pos = originalPositionDetail(map, frame.line, (frame.col ?? 1) - 1);
  const file = normalizeSource(pos?.source);
  /* mapSha: 位置を戻すのに使ったソースマップ（索引の中のもの）の内容のハッシュ（7C 実行コードの版の照合で、いま読んだ内容と比べる） */
  return file ? { file, line: pos.line, col: pos.column, sourceContent: pos.sourceContent, mapSha: entry.mapSha, mapInline: entry.inline } : null;
}

/* ------------------------------------------------------ 7C（実行コードの版） */

const HEX64 = /^[0-9a-f]{64}$/;

/** 生成物の内容を読む（読めなければ null）。ハッシュと区画も作る。**時刻・大きさの索引は使わない**（毎回読む） */
function readChunk(abs) {
  try {
    const buf = fs.readFileSync(abs);
    const text = buf.toString('utf8');
    return { sha: sha256(buf), text, regions: chunkRegionsLib.chunkRegions(text) };
  } catch { return null; }
}

/**
 * 7C（実行コードの版）: SQL を実行したフレームのコードが、いまディスクにある生成物の**どの位置のコードと同じ内容か**を確かめる。
 *   'script'  実行中のスクリプトのハッシュ（計装が V8 の CallSite.getScriptHash() で記録）＝ ディスクの生成物の内容のハッシュ。
 *             位置はそのまま（line は記録のまま）
 *   'region'  スクリプト全体は違う（同じパスの生成物が書き直された）が、フレームが入るモジュールの区画の内容のハッシュと同じ区画が
 *             ディスクの生成物に**ちょうど1つ**ある。位置はその区画の先頭からの同じ行へ移す（区画の内容が同じなので列は同じ）
 *   'mismatch'   実行中のコードと同じ内容のコードがディスクの生成物に無い（古い世代のコードが動いている）
 *   'unverified' 証拠が無い（記録にハッシュが無い・ディスクの生成物を読めない・区画の証拠が無い／形が合わない）
 * 時刻・ファイル名・大きさで同じとは推測しない。
 * @param {{file:string, scope:string, line:number, col:number, scriptHash?:string|null, moduleRegion?:{hash:string,line:number}|null}} frame
 * @param {Map<string, object|null>} [memo] 1回の照合の中で同じ生成物を読み直さないための入れ物（呼び出しの外へ持ち越さない）
 * @returns {{status:'script'|'region'|'mismatch'|'unverified', line:number|null, chunkSha:string|null, detail:string}}
 */
export function verifyExecutedFrame(frame, root = APP, memo = new Map()) {
  if (!frame || frame.scope !== 'build-output' || typeof frame.file !== 'string') return { status: 'unverified', line: null, chunkSha: null, detail: '生成物のフレームではありません' };
  if (typeof frame.scriptHash !== 'string' || !HEX64.test(frame.scriptHash)) {
    return { status: 'unverified', line: null, chunkSha: null, detail: '記録に、実行したスクリプトの内容のハッシュ（V8 の CallSite.getScriptHash()）がありません' };
  }
  const abs = path.join(root, frame.file);
  if (!memo.has(abs)) memo.set(abs, readChunk(abs));
  const disk = memo.get(abs);
  if (!disk) return { status: 'unverified', line: null, chunkSha: null, detail: `${frame.file} を読めません` };
  if (disk.sha === frame.scriptHash) return { status: 'script', line: frame.line, chunkSha: disk.sha, detail: '実行したスクリプトとディスクの生成物の内容のハッシュが一致' };
  const mr = frame.moduleRegion;
  if (!mr || typeof mr !== 'object' || typeof mr.hash !== 'string' || !HEX64.test(mr.hash) || !Number.isInteger(mr.line) || mr.line < 0) {
    return { status: 'mismatch', line: null, chunkSha: disk.sha, detail: '実行したスクリプトはディスクの生成物と別の内容で、フレームのモジュールの区画の証拠がありません' };
  }
  const same = disk.regions.filter((r) => r.hash === mr.hash);
  if (same.length !== 1) {
    return { status: 'mismatch', line: null, chunkSha: disk.sha, detail: same.length ? `同じ内容の区画が ${same.length} 個あり1つに決まりません` : '実行したコードのモジュールの区画と同じ内容の区画が、ディスクの生成物にありません（古い世代のコードが動いています）' };
  }
  const line = same[0].start + mr.line;
  if (line > same[0].end) return { status: 'mismatch', line: null, chunkSha: disk.sha, detail: '区画の中の行が区画の外を指しています' };
  return { status: 'region', line, chunkSha: disk.sha, detail: `実行したコードのモジュールの区画と同じ内容の区画がディスクの生成物にあり、実行時の ${frame.line} 行目はディスクの ${line} 行目` };
}

/** 区画の見出しのモジュール名（`[project]/src/a.tsx [app-rsc] (ecmascript)`）から、プロジェクトの中のパス（`src/a.tsx`） */
function modulePathOf(module) {
  const m = /^\[project\]\/([^\s[\]]+)(?:\s|$)/.exec(String(module ?? ''));
  return m ? m[1] : null;
}
const fileOfSource = (s) => {
  let f = String(s ?? '').replace(/\\/g, '/');
  if (f.startsWith('file://')) f = f.slice('file://'.length);
  return f.replace(/^turbopack:\/\/\//, '/');
};

/**
 * 7C: ソースマップがその生成物の**内容に合う**か（同じ世代の組か）を、内容だけで確かめる（時刻は使わない）。
 *   1. インデックスマップ（sections）で、各区画の開始行がそれぞれ別のモジュールの区画（見出しから次の見出しまで）の中にあり、並びの順が同じ
 *   2. 対象プロジェクトのソース（`[project]/src/…`）のモジュールの区画は、元のソースの1つがそのモジュールと同じファイル
 *   3. 対象のソースのモジュールの区画の各セグメントの生成側の位置が、そのモジュールの区画の中の行で、行の長さを超えない
 * 生成物とソースマップは別々に書かれ、順序は一定でない（実測）。片方だけ新しい組は、モジュールの並びがずれていれば 1〜3 のどこかで合わない。
 * **これは同一性の証明ではない**（並びが同じで区画の中だけが違う組は区別できない。呼び出し側の A3・D と併せて使う）。
 * @returns {{fit:boolean, reason:string|null, detail?:string, sections:number, regions:number}}
 */
export function mapFit(jsText, map) {
  const regions = chunkRegionsLib.chunkRegions(jsText);
  const res = (fit, reason, detail) => ({ fit, reason, ...(detail ? { detail } : {}), sections: Array.isArray(map?.sections) ? map.sections.length : 0, regions: regions.length });
  if (!map || !Array.isArray(map.sections) || !map.sections.length) return res(false, 'not-index-map', 'ソースマップがモジュールの区画（sections）の形ではありません');
  if (!regions.length) return res(false, 'no-module-regions', '生成物にモジュールの見出しが見つかりません');
  const lines = jsText.split('\n');
  const lenOf = (i) => { const l = lines[i] ?? ''; return Math.max(l.length, Buffer.byteLength(l, 'utf8')); };
  let prev = -1;
  for (let i = 0; i < map.sections.length; i++) {
    const s = map.sections[i];
    const off = s?.offset;
    if (!off || !Number.isInteger(off.line) || !Number.isInteger(off.column) || off.line < 0 || off.column < 0) return res(false, 'section-offset-invalid', `区画 ${i}`);
    const ri = regions.findIndex((r) => r.start <= off.line + 1 && off.line + 1 <= r.end);
    if (ri < 0) return res(false, 'section-outside-module', `区画 ${i} の開始（${off.line + 1} 行目）がどのモジュールの区画にも入りません`);
    if (ri <= prev) return res(false, 'section-order', `区画 ${i} が前の区画と同じか前のモジュールにあります`);
    prev = ri;
    /* 2 は対象プロジェクトのソース（`[project]/src/…`）のモジュールだけに当てる。node_modules のモジュールの区画は、パッケージに
     * 同梱のソースマップを辿った先（例: next/src/….ts）を指すので名前が一致しない（実測）。位置を戻す先は src/ だけ（照合器の注入範囲） */
    const mod = modulePathOf(regions[ri].module);
    const srcs = Array.isArray(s.map?.sources) ? s.map.sources : [];
    if (mod && mod.startsWith('src/') && !srcs.some((x) => fileOfSource(x).endsWith(`/${mod}`))) return res(false, 'section-module-mismatch', `区画 ${i}（${off.line + 1} 行目）の元のソースが、その位置のモジュール（${mod}）と違います`);
    if (!mod && srcs.some((x) => /\/src\//.test(fileOfSource(x)) && !fileOfSource(x).includes('/node_modules/'))) return res(false, 'section-module-mismatch', `区画 ${i}（${off.line + 1} 行目）は対象のソースを指しますが、その位置のモジュールの名前が分かりません`);
    if (typeof s.map?.mappings !== 'string') return res(false, 'section-mappings-missing', `区画 ${i}`);
    /* 3 も対象のソースのモジュールだけ。node_modules のモジュールの区画は、同梱のソースマップを合成した結果、生成側の列が行の長さを
     * 超えるセグメントを同じ世代の組でも持つ（実測: map-fit-probe.txt） */
    if (!(mod && mod.startsWith('src/'))) continue;
    const segLines = s.map.__parsed ?? (s.map.__parsed = parseMappings(s.map.mappings));
    for (let g = 0; g < segLines.length; g++) {
      const segs = segLines[g];
      if (!segs || !segs.length) continue;
      const abs = off.line + g;   // 0 始まり
      if (abs + 1 > regions[ri].end) return res(false, 'section-overruns-module', `区画 ${i} のセグメントが、モジュールの区画の外（${abs + 1} 行目）にあります`);
      const maxCol = segs[segs.length - 1].genCol + (g === 0 ? off.column : 0);
      if (maxCol > lenOf(abs)) return res(false, 'segment-outside-line', `区画 ${i} のセグメント（${abs + 1} 行目 ${maxCol} 列）が行の長さ（${lenOf(abs)}）を超えます`);
    }
  }
  return res(true, null);
}

/**
 * 7C: 位置を戻した後に、生成物とソースマップを**いま**読み直して、照合に使ったものと同じかを確かめる。
 *   - 生成物の内容のハッシュが、版の照合（verifyExecutedFrame）で読んだもの（expectChunkSha）と同じ
 *   - ソースマップの内容のハッシュが、位置を戻すのに使ったもの（usedMapSha。serverFrameProvenance の mapSha）と同じ
 *   - ソースマップがその生成物の内容に合う（mapFit）
 *   - 読む前と後で、生成物・ソースマップの更新時刻・大きさ・inode が変わっていない（読んでいる間の書き込みを拒む。拒む向きにだけ使う）
 * @returns {{ok:boolean, reason:string|null, detail:string}}
 */
export function bindChunkAndMap(relFile, root, expectChunkSha, usedMapSha) {
  const abs = path.join(root, relFile);
  const st = (f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return null; } };
  const before = `${st(abs)}|${st(`${abs}.map`)}`;
  let js; let mapBuf = null;
  try { js = fs.readFileSync(abs); } catch { return { ok: false, reason: 'chunk-unreadable', detail: `${relFile} を読めません` }; }
  const inline = !fs.existsSync(`${abs}.map`);
  if (!inline) { try { mapBuf = fs.readFileSync(`${abs}.map`); } catch { return { ok: false, reason: 'map-unreadable', detail: 'ソースマップを読めません' }; } }
  const after = `${st(abs)}|${st(`${abs}.map`)}`;
  if (before !== after) return { ok: false, reason: 'changed-while-reading', detail: '読んでいる間に生成物かソースマップが書き換わりました' };
  const chunkSha = sha256(js);
  if (chunkSha !== expectChunkSha) return { ok: false, reason: 'chunk-changed', detail: '版を確かめた後に生成物の内容が変わりました' };
  const mapSha = inline ? chunkSha : sha256(mapBuf);
  if (!usedMapSha || mapSha !== usedMapSha) return { ok: false, reason: 'map-changed', detail: '位置を戻すのに使ったソースマップが、いまディスクにあるものと違います' };
  let map;
  try {
    if (inline) {
      const m = /[#@]\s*sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/.exec(js.toString('utf8'));
      map = m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null;
    } else map = JSON.parse(mapBuf.toString('utf8'));
  } catch { map = null; }
  if (!map) return { ok: false, reason: 'map-unreadable', detail: 'ソースマップを解釈できません' };
  const fit = mapFit(js.toString('utf8'), map);
  if (!fit.fit) return { ok: false, reason: 'map-chunk-mismatch', detail: `ソースマップが生成物の内容に合いません（${fit.reason}${fit.detail ? `: ${fit.detail}` : ''}）` };
  return { ok: true, reason: null, detail: '生成物・ソースマップとも照合に使ったものと同じ内容で、ソースマップは生成物の内容に合う' };
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
