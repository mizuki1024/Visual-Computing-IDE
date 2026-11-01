/* =============================================================================
 * 独立した照合（PoC-03 の「正答／誤答」の判定に使う）。
 *
 * マニフェストを信用しない。**報告された (ファイル, 行, 列) を、その場で
 * ソースを読み直して検証する。** 変換側と判定側で同じ情報源を使わない。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { APP } from './util.mjs';

const ts = createRequire(import.meta.url)('typescript');

const cache = new Map();

/** そのファイルの JSX 開始要素を (行, 列) → {tag, component} で引ける表にする */
function indexFile(relPath) {
  if (cache.has(relPath)) return cache.get(relPath);
  const abs = path.join(APP, relPath);
  if (!fs.existsSync(abs)) { cache.set(relPath, null); return null; }
  const code = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const map = new Map();
  const stack = [];
  const isPascal = (s) => /^[A-Z]/.test(s);
  const posOf = (n) => {
    const lc = sf.getLineAndCharacterOfPosition(ts.skipTrivia(code, n.pos));
    return { line: lc.line + 1, col: lc.character + 1 };
  };
  const nameOf = (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name && isPascal(n.name.text)) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isPascal(n.name.text)
        && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.text;
    return null;
  };
  const walk = (n) => {
    const nm = nameOf(n);
    if (nm) stack.push(nm);
    const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (open) {
      const p = posOf(n);
      map.set(`${p.line}:${p.col}`, {
        tag: open.tagName.getText(sf),
        component: stack.length ? stack[stack.length - 1] : null,
      });
    }
    ts.forEachChild(n, walk);
    if (nm) stack.pop();
  };
  walk(sf);
  const out = { map, lineCount: code.split('\n').length };
  cache.set(relPath, out);
  return out;
}

/**
 * 報告された位置に、報告されたタグの JSX 要素が本当にあるかを確かめる。
 * @returns {{ok:boolean, why?:string, actual?:object}}
 */
export function verifyLocation({ file, line, col, tag, component }) {
  const idx = indexFile(file);
  if (!idx) return { ok: false, why: 'file-not-found' };
  const hit = idx.map.get(`${line}:${col}`);
  if (!hit) return { ok: false, why: 'no-jsx-element-at-position' };
  if (hit.tag !== tag) return { ok: false, why: 'tag-mismatch', actual: hit };
  if (component && hit.component !== component) {
    return { ok: false, why: 'component-mismatch', actual: hit };
  }
  return { ok: true, actual: hit };
}

/** その行のソーステキスト（報告書に出す1行。全文は持ち出さない） */
export function lineText(file, line) {
  const abs = path.join(APP, file);
  if (!fs.existsSync(abs)) return null;
  const l = fs.readFileSync(abs, 'utf8').split('\n')[line - 1];
  return l === undefined ? null : l.trim();
}

/* ---------------------------------------------------------------- PoC-05 */

const compCache = new Map();

/**
 * そのファイルのコンポーネント宣言の行範囲を、**ソースを読み直して**作る。
 * ビルド時のマニフェストとは独立した情報源である（両者の一致を根拠に使う）。
 */
function componentRanges(relPath) {
  if (compCache.has(relPath)) return compCache.get(relPath);
  const abs = path.join(APP, relPath);
  if (!fs.existsSync(abs)) { compCache.set(relPath, null); return null; }
  const code = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const isPascal = (s) => /^[A-Z]/.test(s);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const out = [];
  const nameOf = (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name && isPascal(n.name.text)) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isPascal(n.name.text)
        && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.text;
    return null;
  };
  const walk = (n) => {
    const nm = nameOf(n);
    if (nm) {
      out.push({ name: nm, file: relPath, line: lineOf(ts.skipTrivia(code, n.pos)), endLine: lineOf(n.end) });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  compCache.set(relPath, out);
  return out;
}

/**
 * その行を囲むいちばん内側のコンポーネント宣言。無ければ null。
 * **ソースの読み直しによる独立した判定である。**
 */
export function enclosingComponent(file, line) {
  const ranges = componentRanges(file);
  if (!ranges) return null;
  const hit = ranges
    .filter((r) => r.line <= line && line <= r.endLine)
    .sort((a, b) => (b.endLine - b.line) - (a.endLine - a.line));
  return hit.length ? hit[hit.length - 1] : null;
}
