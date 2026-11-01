/* =============================================================================
 * PoC-03 方式1 — JSX へ要素識別子（ElementAnchor）を注入する純粋変換。
 *
 * 設計上の約束（これを破ると報告の値が信用できなくなる）:
 *   1. **挿入のみを行い、再出力（pretty-print）しない。**
 *      TypeScript の AST で位置だけを取り、元のテキストに属性を差し込む。
 *      結果として **行番号は一切ずれない**。ソースマップを必要としない。
 *   2. 注入先は **組み込み要素（小文字タグ）だけ**。コンポーネント要素
 *      （大文字タグ）に注入すると未知の props になり DOM に出る保証が無い。
 *   3. `html` / `head` / `body` は注入しない（Next.js が所有する要素）。
 *   4. 識別子は `relPath:line:col` の決定的ハッシュ。再ビルドで変わらない。
 *      元のパスは DOM に出さない（マニフェスト経由で解く）。
 *   5. 変換できなかった理由は捨てずに返す（特定不能を「無反応」にしない — FR-11b）。
 * ========================================================================== */
const crypto = require('node:crypto');
/*
 * 構文解析器の読み込みにかかった時間を記録する（PoC-05 第7節の再計測用）。
 * 計測のための2回の時刻取得だけで、変換の結果は1文字も変わらない。
 */
const __tsLoadStart = Date.now();
const ts = require('typescript');
const TS_LOAD_MS = Date.now() - __tsLoadStart;

/** Next.js が所有する要素。ここへ属性を足さない。 */
const SKIP_TAGS = new Set(['html', 'head', 'body']);

/** 02a 4章の識別子規約に合わせた不透明な ID。`relPath:line:col` から決まる。 */
function anchorId(relPath, line, col) {
  return crypto.createHash('sha1').update(`${relPath}:${line}:${col}`).digest('hex').slice(0, 10);
}

const isPascal = (s) => typeof s === 'string' && /^[A-Z]/.test(s);

/** 宣言から「コンポーネントの名前」を取れるなら取る。取れなければ null。 */
function declName(node) {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    if (node.name && isPascal(node.name.text)) return node.name.text;
    // export default function () {} は名前を持たない
    const def = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (def) return '(default export)';
    return null;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && isPascal(node.name.text)
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.text;
  }
  return null;
}

/**
 * @param {string} code  元のソース（.tsx / .jsx）
 * @param {string} relPath プロジェクトルートからの相対パス（識別子の素）
 * @returns {{code:string, anchors:object[], skipped:object[], usages:object[],
 *            components:object[]}}
 */
function transform(code, relPath) {
  const sf = ts.createSourceFile(
    relPath, code, ts.ScriptTarget.Latest, /* setParentNodes */ false,
    /\.tsx?$/.test(relPath) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX,
  );

  const anchors = [];
  const skipped = [];
  const usages = [];
  /**
   * コンポーネント宣言の行範囲（PoC-05 で追加）。
   * 注入の判断には使わない — 出力する属性は1文字も変わらない。
   * 「ある行がどのコンポーネントの中にあるか」を後から引けるようにするだけである。
   */
  const components = [];
  /** 挿入位置（元テキストのオフセット）と挿入する文字列 */
  const edits = [];
  /** 現在たどっているコンポーネント宣言のスタック */
  const stack = [];

  const posOf = (node) => {
    const start = ts.skipTrivia(code, node.pos);
    const lc = sf.getLineAndCharacterOfPosition(start);
    return { line: lc.line + 1, col: lc.character + 1 };
  };

  const current = () => (stack.length ? stack[stack.length - 1] : null);

  function handleOpening(open, elementNode) {
    const name = open.tagName.getText(sf);
    const where = posOf(elementNode);
    const owner = current();

    if (isPascal(name) || name.includes('.')) {
      // コンポーネント要素。注入しない（DOM 要素にならない）。
      // 「どこで使われたか」は静的な事実として残すが、**実測ではない**。
      usages.push({
        component: name, file: relPath, line: where.line, col: where.col,
        inComponent: owner ? owner.name : null,
      });
      return;
    }
    if (SKIP_TAGS.has(name)) {
      skipped.push({ tag: name, file: relPath, line: where.line, why: 'framework-owned-element' });
      return;
    }
    if (!owner) {
      // コンポーネント宣言の外の JSX。どのコンポーネントが描いたか言えない
      skipped.push({ tag: name, file: relPath, line: where.line, why: 'no-enclosing-component' });
      return;
    }
    // 既に同名の属性があるなら触らない（上書きは誤特定の元になる）
    const dup = open.attributes.properties.some(
      (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'data-vcide',
    );
    if (dup) {
      skipped.push({ tag: name, file: relPath, line: where.line, why: 'attribute-already-present' });
      return;
    }

    const id = anchorId(relPath, where.line, where.col);
    anchors.push({
      id, tag: name, file: relPath, line: where.line, col: where.col,
      component: owner.name, componentLine: owner.line,
    });
    edits.push({ at: open.tagName.end, text: ` data-vcide="${id}"` });
  }

  function walk(node) {
    const name = declName(node);
    if (name) {
      const p = posOf(node);
      const endLine = sf.getLineAndCharacterOfPosition(node.end).line + 1;
      stack.push({ name, line: p.line });
      components.push({ name, file: relPath, line: p.line, endLine });
    }

    if (ts.isJsxElement(node)) handleOpening(node.openingElement, node);
    else if (ts.isJsxSelfClosingElement(node)) handleOpening(node, node);

    ts.forEachChild(node, walk);
    if (name) stack.pop();
  }
  walk(sf);

  // 後ろから差し込む。前のオフセットを壊さない = 行番号も列番号も保たれる
  let out = code;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, e.at) + e.text + out.slice(e.at);
  }
  return { code: out, anchors, skipped, usages, components };
}

module.exports = { transform, anchorId, TS_LOAD_MS };
