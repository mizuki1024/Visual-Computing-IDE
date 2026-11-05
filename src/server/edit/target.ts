/* =============================================================================
 * 編集 E1 — 編集対象の要素の特定と、内容の指紋（06h レビュー F-01）。**読むだけ。**
 *
 * 探索の要素識別子は位置（ファイル:行:列）だけから決まる。探索の照合（anchors.resolveSelection の7段）は
 * DOM の版＝対応表の版＝ファイルの版を確かめるが、編集は**書き込み先の決定でも**位置に依らない同一性を確かめる:
 *   指紋 = タグ・囲むコンポーネント・属性の名前の並び（と className 以外の値の要約）・className のリテラル・
 *          子の構造（要素のタグ・テキストの要約・式の要約）・要素のソース全体のハッシュ
 * 指紋は選択を解決した時点の内容から作り、下書きの作成・適用の直前に、**その時点の内容から作り直して**比べる。
 *
 * 位置の規則は探索の変換器（poc/anchor/transform.cjs）と同じ（要素の先頭 = skipTrivia(node.pos)）。
 * 構文解析は探索とは別にここで行う（探索の索引を流用しない）。
 * ========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import type TSNS from 'typescript';
import { ideRoot } from '../ide';
import { sha256 } from './revision';

type TS = typeof TSNS;
let tsMod: TS | null | undefined;
function typescript(): TS | null {
  if (tsMod !== undefined) return tsMod;
  try { tsMod = createRequire(path.join(ideRoot(), 'package.json'))('typescript') as TS; } catch { tsMod = null; }
  return tsMod;
}

export type ClassRefusal =
  | 'no-classname' | 'duplicate-classname' | 'spread-after-classname' | 'conditional-class' | 'computed-class' | 'literal-has-escape';

export const CLASS_REFUSAL_TEXT: Record<ClassRefusal, string> = {
  'no-classname': 'この要素には className がありません',
  'duplicate-classname': 'className が2つ以上あります',
  'spread-after-classname': 'className の後に props の展開（{...props}）があり、実際に効くクラスを決められません',
  'conditional-class': '条件によって変わるクラスです。どの条件の token を書き換えるかを推測しません',
  'computed-class': '関数・変数・テンプレートで組み立てたクラスです。書き換える token を一意に特定できません',
  'literal-has-escape': 'リテラルにエスケープ・文字参照が含まれ、表示とソースの文字が一致しません',
};

export interface ClassToken { text: string; start: number; end: number }

export type ClassInfo =
  | { kind: 'literal'; litStart: number; litEnd: number; raw: string; tokens: ClassToken[] }
  | { kind: 'refused'; reason: ClassRefusal };

export interface ElementFingerprint {
  /** 下の全部と要素のソース全体から作ったハッシュ（比べるのはこれ） */
  hash: string;
  /** 構造だけ（タグ・コンポーネント・属性の名前・子の形）のハッシュ。className の token の違いを含まない（E2 の引き継ぎ用） */
  structureHash: string;
  tag: string;
  component: string | null;
  attributes: string[];
  classLiteral: string | null;
  children: string[];
}

export interface ElementInfo {
  tag: string;
  component: string | null;
  /** 要素のソース上の範囲（オフセット） */
  start: number;
  end: number;
  className: ClassInfo;
  fingerprint: ElementFingerprint;
}

const h16 = (s: string) => sha256(s).slice(0, 16);

/** 1つのファイルの内容の中で、(行:列) に始まる JSX 要素を調べる。無ければ null。構文解析器が無ければ例外 */
export function inspectElementAt(text: string, rel: string, line: number, col: number): ElementInfo | null {
  const ts = typescript();
  if (!ts) throw new Error('verifier-unavailable: typescript を読み込めません');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
  const skipTrivia = (ts as unknown as { skipTrivia: (t: string, p: number) => number }).skipTrivia;
  const isPascal = (s: string) => /^[A-Z]/.test(s);
  const nameOf = (n: TSNS.Node): string | null => {
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) {
      if (n.name && isPascal(n.name.text)) return n.name.text;
      if (n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return '(default export)';
      return null;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isPascal(n.name.text)
      && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.text;
    return null;
  };
  const stack: string[] = [];
  let found: { node: TSNS.JsxElement | TSNS.JsxSelfClosingElement; component: string | null } | null = null;
  const walk = (n: TSNS.Node): void => {
    if (found) return;
    const nm = nameOf(n);
    if (nm) stack.push(nm);
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const start = skipTrivia(text, n.pos);
      const lc = sf.getLineAndCharacterOfPosition(start);
      if (lc.line + 1 === line && lc.character + 1 === col) found = { node: n, component: stack.length ? stack[stack.length - 1] : null };
    }
    if (!found) ts.forEachChild(n, walk);
    if (nm) stack.pop();
  };
  walk(sf);
  if (!found) return null;
  const { node, component } = found as { node: TSNS.JsxElement | TSNS.JsxSelfClosingElement; component: string | null };
  const open = ts.isJsxElement(node) ? node.openingElement : node;
  const tag = open.tagName.getText(sf);
  const start = skipTrivia(text, node.pos);
  const end = node.getEnd();

  /* className */
  const props = open.attributes.properties;
  const attrs: string[] = props.map((p) => {
    if (ts.isJsxSpreadAttribute(p)) return `...${h16(p.expression.getText(sf))}`;
    const name = p.name.getText(sf);
    if (name === 'className') return 'className';
    return `${name}=${p.initializer ? h16(p.initializer.getText(sf)) : 'true'}`;
  });
  const clsIdx = props.map((p, i) => (ts.isJsxAttribute(p) && p.name.getText(sf) === 'className' ? i : -1)).filter((i) => i >= 0);
  let className: ClassInfo;
  if (clsIdx.length === 0) className = { kind: 'refused', reason: 'no-classname' };
  else if (clsIdx.length > 1) className = { kind: 'refused', reason: 'duplicate-classname' };
  else if (props.slice(clsIdx[0] + 1).some((p) => ts.isJsxSpreadAttribute(p))) className = { kind: 'refused', reason: 'spread-after-classname' };
  else {
    const init = (props[clsIdx[0]] as TSNS.JsxAttribute).initializer;
    let lit: TSNS.StringLiteral | TSNS.NoSubstitutionTemplateLiteral | null = null;
    let refused: ClassRefusal | null = null;
    if (init && ts.isStringLiteral(init)) lit = init;
    else if (init && ts.isJsxExpression(init) && init.expression) {
      const e = init.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) lit = e;
      else {
        let conditional = false;
        const scan = (x: TSNS.Node): void => {
          if (ts.isConditionalExpression(x) || (ts.isBinaryExpression(x) && [ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(x.operatorToken.kind))) conditional = true;
          ts.forEachChild(x, scan);
        };
        scan(e);
        refused = conditional ? 'conditional-class' : 'computed-class';
      }
    } else refused = 'computed-class';
    if (refused || !lit) className = { kind: 'refused', reason: refused ?? 'computed-class' };
    else {
      const litStart = lit.getStart(sf) + 1;
      const litEnd = lit.getEnd() - 1;
      const raw = text.slice(litStart, litEnd);
      if (raw !== lit.text || /[\\&{}<>"'`]/.test(raw)) className = { kind: 'refused', reason: 'literal-has-escape' };
      else {
        const tokens: ClassToken[] = [];
        const re = /\S+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw))) tokens.push({ text: m[0], start: litStart + m.index, end: litStart + m.index + m[0].length });
        className = { kind: 'literal', litStart, litEnd, raw, tokens };
      }
    }
  }

  /* 子の構造 */
  const children: string[] = [];
  if (ts.isJsxElement(node)) {
    for (const c of node.children) {
      if (ts.isJsxText(c)) { const t = c.getText(sf).trim(); if (t) children.push(`text:${h16(t)}`); }
      else if (ts.isJsxExpression(c)) children.push(`expr:${h16(c.getText(sf))}`);
      else if (ts.isJsxElement(c)) children.push(`el:${c.openingElement.tagName.getText(sf)}`);
      else if (ts.isJsxSelfClosingElement(c)) children.push(`el:${c.tagName.getText(sf)}`);
      else children.push(`frag:${h16(c.getText(sf))}`);
    }
  }
  const classLiteral = className.kind === 'literal' ? className.raw : null;
  const structure = { tag, component, attributes: attrs, children };
  const structureHash = sha256(JSON.stringify(structure));
  const hash = sha256(JSON.stringify({ ...structure, classLiteral, source: sha256(text.slice(start, end)) }));
  return { tag, component, start, end, className, fingerprint: { hash, structureHash, tag, component, attributes: attrs, classLiteral, children } };
}
