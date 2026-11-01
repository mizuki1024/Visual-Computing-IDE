/* =============================================================================
 * PoC-04 — **表示値の由来の静的解析**（02d の source = static-analysis / L2）。
 *
 * やること: JSX が描く式から、データ取得の呼び出しの結果まで、
 * TypeScript の AST を**前向きに**たどって、参照している列名を求める。
 *
 * **やらないこと（ここが本PoCの要点である）**
 *   * 値の一致を根拠にしない。表示された値も結果の行も読まない
 *   * 実行時刻の近さを根拠にしない
 *   * SQL 文の一致を根拠にしない（同じ文が2本ある題材がある — 06d 3.1節）
 *   * 名前の一致だけを根拠にしない。**スコープを TypeScript に解かせる**ので、
 *     同名の別変数は別物として扱われる
 *   * 追えない演算・追えない関数呼び出しを「たぶん通る」で通さない。
 *     **白表（PURE_CALLS）に無い呼び出しは `unknown` にする。**
 *     関数の本体が引数を捨てる場合があり、通すと誤対応を作る
 *
 * 結論は**つねに L2（推定）である。** この解析が成功しても実測にはならない。
 * 格上げの経路をこのファイルは持たない（観測性は model.ts の observabilityOf
 * だけが決める）。
 *
 * 列名 → DBカラムの確定には **実測された SQL 文の構文解析**（L1相当）を使う。
 * ソース上の SQL リテラルは使わない — 動的に組み立てた SQL では存在しないし、
 * 「書いてある文」と「走った文」は別物である（01b Q-04.2 C-7）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { APP } from './util.mjs';

const ts = createRequire(import.meta.url)('typescript');

/** データ取得の呼び出しと見なすメソッド名（rscattr.mjs の CALL_PATTERN と同じ範囲） */
const QUERY_METHODS = new Map([
  ['query', 'pg'], ['$queryRaw', 'pg'], ['$executeRaw', 'pg'],
  ['findMany', 'orm'], ['findFirst', 'orm'], ['findUnique', 'orm'],
  ['count', 'orm'], ['aggregate', 'orm'], ['groupBy', 'orm'],
]);

/** 反復メソッド。第1引数のコールバックの第1引数が「要素」になる */
const ITER_METHODS = new Set(['map', 'flatMap', 'forEach', 'filter', 'find']);

/**
 * **値の出所を保つと言い切れる演算だけ**の白表。
 * ここに無い呼び出しは `unknown` にする。「たぶん通る」で通さない。
 * 本体が引数を捨てる関数（`outsideLabel()` のような）を通すと誤対応になる。
 */
const PURE_CALLS = new Set([
  'String', 'Number', 'Boolean',
  'toString', 'toUpperCase', 'toLowerCase', 'toLocaleUpperCase', 'toLocaleLowerCase',
  'toLocaleString', 'toFixed', 'trim', 'trimStart', 'trimEnd',
  'padStart', 'padEnd', 'slice', 'substring', 'at', 'charAt', 'repeat', 'normalize',
  'replace', 'replaceAll', 'split', 'join', 'concat',
]);

const isPascal = (s) => /^[A-Z]/.test(s);
const rel = (abs) => path.relative(APP, abs).split(path.sep).join('/');

function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------ 抽象値の領域 */
/*
 * atom の種別
 *   qres      データ取得の結果オブジェクト（pg の `{rows}`）
 *   rows      行の集まり
 *   row       行1つ
 *   field     行の1列（name が列名）          ← これだけが候補になりうる
 *   anyfield  行のどれかの列（動的なキー）    ← 候補は複数になる
 *   tuple     Promise.all の結果（items に要素の値）
 *   props     コンポーネントの props オブジェクト
 *   literal   ソースに書かれた定数
 *   unknown   追えなかった（why に理由）
 *
 * trail は「どうやってそこへ着いたか」の人向けの経路である。根拠の説明に出す。
 */
const atom = (t, extra = {}, trail = []) => ({ t, ...extra, trail });
const val = (atoms, transformed = false) => ({ atoms, transformed });
const UNK = (why, trail = []) => val([atom('unknown', { why }, trail)]);
const LIT = (trail = []) => val([atom('literal', {}, trail)]);
const union = (vs) => val(vs.flatMap((v) => v.atoms), vs.some((v) => v.transformed));
/** 追えるが加工されている。候補は残すが「確定」にはしない */
const transformedOf = (vs) => val(vs.flatMap((v) => v.atoms), true);
const push = (a, step) => ({ ...a, trail: [...a.trail, step] });

/* ========================================================================== */

/**
 * @param {{scope?:string, roots?:string[]}} opt
 * @returns {{queries:object[], sites:object[], files:string[], notes:object[]}}
 */
export function analyzeLineage(opt = {}) {
  const scope = opt.scope ?? 'src/';
  const roots = [
    ...collectFiles(path.join(APP, 'src')),
    ...collectFiles(path.join(APP, 'vendor-ui')),
  ];
  const program = ts.createProgram({
    rootNames: roots,
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
      checkJs: false,
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      baseUrl: APP,
      paths: { '@/*': ['src/*'] },
    },
  });
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile
    && !sf.fileName.includes('node_modules'));

  const notes = [];
  const posOf = (n) => {
    const sf = n.getSourceFile();
    const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return { file: rel(sf.fileName), line: lc.line + 1, col: lc.character + 1 };
  };
  const textOf = (n, max = 90) => {
    const s = n.getText(n.getSourceFile()).replace(/\s+/g, ' ').trim();
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
  };

  /* ------------------------------------------------- 索引1: 再代入された宣言
   * 一度でも代入し直される変数は追わない。初期化子だけを見ると嘘になる。 */
  const reassigned = new Set();
  /* ------------------------------------- 索引2: コンポーネント宣言 → JSX 使用 */
  const jsxUsages = new Map();
  /* --------------------------------------------- 索引3: データ取得の呼び出し */
  const queryByNode = new Map();
  const queries = [];

  const declsOfName = (nameNode) => {
    let sym = checker.getSymbolAtLocation(nameNode);
    if (!sym) return [];
    if (sym.flags & ts.SymbolFlags.Alias) {
      try { sym = checker.getAliasedSymbol(sym); } catch { /* 解けないことがある */ }
    }
    return sym.declarations ?? [];
  };

  /** その関数がコンポーネントか（srcverify.mjs と同じ規則: PascalCase の宣言） */
  const componentNameOf = (fn) => {
    if (!fn) return null;
    if ((ts.isFunctionDeclaration(fn) || ts.isClassDeclaration(fn)) && fn.name
      && isPascal(fn.name.text)) return fn.name.text;
    const p = fn.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && isPascal(p.name.text)
      && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return p.name.text;
    return null;
  };

  /** データ取得の呼び出しなら登録して識別子を返す */
  const registerQuery = (call) => {
    if (queryByNode.has(call)) return queryByNode.get(call);
    const p = posOf(call);
    const shape = QUERY_METHODS.get(call.expression.name.text);
    const arg0 = call.arguments[0];
    const literal = arg0 && (ts.isStringLiteral(arg0) || ts.isNoSubstitutionTemplateLiteral(arg0))
      ? arg0.text : null;
    const q = {
      id: `q${queries.length + 1}`,
      file: p.file, line: p.line, col: p.col,
      method: call.expression.name.text,
      /** pg は `{rows}` を返す。ORM は行の配列そのものを返す */
      shape,
      /** ソースに書いてある SQL 文。**判定には使わない**。無いこともある */
      sqlInSource: literal,
      sqlIsDynamic: !!arg0 && literal === null,
      receiver: textOf(call.expression.expression, 40),
    };
    queries.push(q);
    queryByNode.set(call, q);
    return q;
  };

  for (const sf of sources) {
    const walk = (n) => {
      /* 再代入 */
      if (ts.isBinaryExpression(n) && ts.isIdentifier(n.left)
        && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        for (const d of declsOfName(n.left)) reassigned.add(d);
      }
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
        && ts.isIdentifier(n.operand)
        && (n.operator === ts.SyntaxKind.PlusPlusToken
          || n.operator === ts.SyntaxKind.MinusMinusToken)) {
        for (const d of declsOfName(n.operand)) reassigned.add(d);
      }
      /* JSX 使用（コンポーネントの呼び出し） */
      const open = ts.isJsxElement(n) ? n.openingElement
        : ts.isJsxSelfClosingElement(n) ? n : null;
      if (open && ts.isIdentifier(open.tagName) && isPascal(open.tagName.text)) {
        for (const d of declsOfName(open.tagName)) {
          if (!jsxUsages.has(d)) jsxUsages.set(d, []);
          jsxUsages.get(d).push(open);
        }
      }
      /* データ取得の呼び出し */
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && QUERY_METHODS.has(n.expression.name.text)) {
        registerQuery(n);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }

  /* ======================================================== 抽象値の評価 */
  const memo = new Map();
  const busy = new Set();

  const elementOf = (v, step) => val(v.atoms.map((a) => {
    if (a.t === 'rows') return push(atom('row', { q: a.q }, a.trail), step);
    if (a.t === 'tuple') return push(atom('unknown', { why: 'element-of-tuple' }, a.trail), step);
    if (a.t === 'qres') return push(atom('unknown', { why: 'element-of-result-object' }, a.trail), step);
    if (a.t === 'row' || a.t === 'field' || a.t === 'anyfield') {
      return push(atom('unknown', { why: 'element-of-scalar' }, a.trail), step);
    }
    return push(a, step);
  }), v.transformed);

  /** メンバ参照 `X.name` */
  const member = (v, name, step) => {
    let transformed = v.transformed;
    const atoms = v.atoms.map((a) => {
      if (a.t === 'qres') {
        if (a.q.shape === 'pg' && name === 'rows') {
          return push(atom('rows', { q: a.q }, a.trail), step);
        }
        return push(atom('unknown', { why: `member-on-result:${name}` }, a.trail), step);
      }
      if (a.t === 'row') return push(atom('field', { q: a.q, name }, a.trail), step);
      if (a.t === 'field') { transformed = true; return push(a, `${step}（列の値のさらに内側）`); }
      if (a.t === 'anyfield') { transformed = true; return push(a, step); }
      if (a.t === 'rows') {
        return push(atom('unknown', { why: `member-on-rowset:${name}` }, a.trail), step);
      }
      if (a.t === 'props') {
        return componentProp(a.fn, name, a.trail);
      }
      return push(a, step);
    });
    /* props は値を1つ返さないので、配列を平らにする */
    const flat = [];
    for (const a of atoms) {
      if (a && a.atoms) { flat.push(...a.atoms); transformed = transformed || a.transformed; }
      else flat.push(a);
    }
    return val(flat, transformed);
  };

  /** 添字参照 `X[e]` */
  const index = (v, argNode, step) => {
    const lit = argNode && (ts.isStringLiteral(argNode) ? argNode.text
      : ts.isNumericLiteral(argNode) ? Number(argNode.text) : undefined);
    let transformed = v.transformed;
    const atoms = v.atoms.map((a) => {
      /* 行の集まりへの添字は、どの行でも**列の構成は同じ**である。
       * したがって行番号が定数でなくても、列の同一性は失われない */
      if (a.t === 'rows') return push(atom('row', { q: a.q }, a.trail), step);
      if (a.t === 'row') {
        if (typeof lit === 'string') {
          return push(atom('field', { q: a.q, name: lit }, a.trail), step);
        }
        /* 動的なキー。**どの列かは決まらない。** 1つに絞ってはいけない */
        return push(atom('anyfield', { q: a.q }, a.trail), `${step}（キーが動的）`);
      }
      if (a.t === 'tuple') {
        if (typeof lit === 'number' && a.items[lit]) {
          transformed = transformed || a.items[lit].transformed;
          return a.items[lit].atoms.map((x) => push(x, step));
        }
        return push(atom('unknown', { why: 'tuple-index-not-literal' }, a.trail), step);
      }
      if (a.t === 'field' || a.t === 'anyfield') {
        transformed = true;
        return push(a, `${step}（列の値のさらに内側）`);
      }
      return push(a, step);
    });
    return val(atoms.flat(), transformed);
  };

  /** コンポーネントの props 1つ。**すべての JSX 使用の和**をとる（1つに絞らない） */
  function componentProp(fn, propName, trail) {
    const usages = jsxUsages.get(fn) ?? [];
    const name = componentNameOf(fn) ?? '（無名）';
    if (!usages.length) {
      return UNK('component-not-rendered', [...trail, `${name} の props ${propName}（描画箇所が見つからない）`]);
    }
    const parts = [];
    for (const open of usages) {
      const where = posOf(open);
      const step = `${name} の props ${propName} ← ${where.file}:${where.line}`;
      const props = open.attributes.properties;
      if (props.some((a) => ts.isJsxSpreadAttribute(a))) {
        parts.push(UNK('jsx-spread-attribute', [...trail, `${step}（スプレッド属性があり追えない）`]));
        continue;
      }
      const attr = props.find((a) => ts.isJsxAttribute(a)
        && (ts.isIdentifier(a.name) ? a.name.text : a.name.getText()) === propName);
      if (!attr) {
        parts.push(UNK('prop-not-passed', [...trail, `${step}（この箇所では渡していない）`]));
        continue;
      }
      if (!attr.initializer) { parts.push(LIT([...trail, `${step}（真偽の省略形）`])); continue; }
      if (ts.isStringLiteral(attr.initializer)) {
        parts.push(LIT([...trail, `${step}（文字列リテラル）`]));
        continue;
      }
      if (!ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) {
        parts.push(UNK('jsx-attribute-shape', [...trail, step]));
        continue;
      }
      const inner = evalExpr(attr.initializer.expression);
      parts.push(val(inner.atoms.map((a) => ({ ...a, trail: [...trail, step, ...a.trail] })),
        inner.transformed));
    }
    return union(parts);
  }

  /** 反復のコールバックの第1引数なら、その反復元の要素を返す */
  function mapCallbackElement(p) {
    const fn = p.parent;
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
    if (fn.parameters.indexOf(p) !== 0) return null;
    const call = fn.parent;
    if (!call || !ts.isCallExpression(call) || call.arguments[0] !== fn) return null;
    if (!ts.isPropertyAccessExpression(call.expression)) return null;
    if (!ITER_METHODS.has(call.expression.name.text)) return null;
    const recv = evalExpr(call.expression.expression);
    const w = posOf(call);
    return elementOf(recv, `${textOf(call.expression, 40)} の要素（${w.file}:${w.line}）`);
  }

  function evalParameter(p) {
    const viaMap = mapCallbackElement(p);
    if (viaMap) return viaMap;
    const fn = p.parent;
    const cname = componentNameOf(fn);
    if (cname && fn.parameters.indexOf(p) === 0 && ts.isIdentifier(p.name)) {
      /* `function C(props)` の props 本体。`props.x` で解ける */
      return val([atom('props', { fn }, [`${cname} の props`])]);
    }
    return UNK('parameter-not-traceable', [`引数 ${ts.isIdentifier(p.name) ? p.name.text : '（分解）'}`]);
  }

  /** 分解束縛（destructuring）。別名も多段も、ここで経路として扱う */
  function evalBindingElement(be) {
    const steps = [];
    let cur = be;
    while (ts.isBindingElement(cur)) {
      if (cur.dotDotDotToken) return UNK('rest-binding');
      const pat = cur.parent;
      if (ts.isObjectBindingPattern(pat)) {
        const key = cur.propertyName ?? cur.name;
        if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return UNK('computed-binding-key');
        const alias = ts.isIdentifier(cur.name) && cur.name.text !== key.text
          ? `（別名 ${key.text} → ${cur.name.text}）` : '';
        steps.unshift({ kind: 'prop', name: key.text, label: `分解束縛 .${key.text}${alias}` });
      } else {
        const i = pat.elements.indexOf(cur);
        steps.unshift({ kind: 'index', i, label: `分解束縛 [${i}]` });
      }
      cur = pat.parent;
    }

    let base;
    if (ts.isVariableDeclaration(cur)) {
      if (reassigned.has(cur)) return UNK('reassigned');
      if (!cur.initializer) return UNK('no-initializer');
      base = evalExpr(cur.initializer);
    } else if (ts.isParameter(cur)) {
      const cname = componentNameOf(cur.parent);
      if (cname && cur.parent.parameters.indexOf(cur) === 0 && steps[0]?.kind === 'prop') {
        /* `function C({ label })` — props の分解。親の JSX から解く */
        base = componentProp(cur.parent, steps[0].name, []);
        steps.shift();
      } else {
        base = evalParameter(cur);
      }
    } else {
      return UNK('unknown-binding-root');
    }

    let v = base;
    for (const s of steps) {
      v = s.kind === 'prop' ? member(v, s.name, s.label)
        : index(v, ts.factory.createNumericLiteral(String(s.i)), s.label);
    }
    return v;
  }

  function evalDeclaration(d, idText) {
    if (ts.isVariableDeclaration(d)) {
      if (reassigned.has(d)) return UNK('reassigned', [`${idText} は代入し直されている`]);
      if (!d.initializer) return UNK('no-initializer', [`${idText} に初期化子が無い`]);
      return evalExpr(d.initializer);
    }
    if (ts.isBindingElement(d)) return evalBindingElement(d);
    if (ts.isParameter(d)) return evalParameter(d);
    if (ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d)
      || ts.isMethodDeclaration(d) || ts.isMethodSignature(d)) {
      return UNK('function-value', [`${idText} は関数・クラスである`]);
    }
    if (ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)
      || ts.isImportEqualsDeclaration(d)) {
      return UNK('import-not-resolved', [`${idText} の輸入元を解けない`]);
    }
    if (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)
      || ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d)) {
      return UNK('property-declaration', [`${idText} は型・オブジェクトの属性である`]);
    }
    return UNK(`declaration:${ts.SyntaxKind[d.kind]}`, [`${idText} の宣言を追えない`]);
  }

  function evalCall(n) {
    const callee = n.expression;

    /* データ取得の呼び出し */
    if (ts.isPropertyAccessExpression(callee) && QUERY_METHODS.has(callee.name.text)) {
      const q = queryByNode.get(n);
      if (q) {
        const step = `${q.receiver}.${q.method}(…) の結果（${q.file}:${q.line}）`;
        return q.shape === 'pg'
          ? val([atom('qres', { q }, [step])])
          : val([atom('rows', { q }, [step])]);
      }
    }

    /* Promise.all([...]) — 要素の順番を保つ */
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'all'
      && ts.isIdentifier(callee.expression) && callee.expression.text === 'Promise'
      && n.arguments[0] && ts.isArrayLiteralExpression(n.arguments[0])) {
      const items = n.arguments[0].elements.map((e) => evalExpr(e));
      return val([atom('tuple', { items }, ['Promise.all の結果'])]);
    }

    /* 反復メソッド。配列そのものの値は使わない（JSX の中身は別に歩く） */
    if (ts.isPropertyAccessExpression(callee) && ITER_METHODS.has(callee.name.text)) {
      return UNK(`iteration-result:${callee.name.text}`);
    }

    /* 値の出所を保つと言い切れる呼び出しだけ通す。それ以外は追わない */
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
      : ts.isIdentifier(callee) ? callee.text : null;
    if (name && PURE_CALLS.has(name)) {
      const parts = ts.isPropertyAccessExpression(callee)
        ? [evalExpr(callee.expression), ...n.arguments.map((a) => evalExpr(a))]
        : n.arguments.map((a) => evalExpr(a));
      return transformedOf(parts.map((v) => val(
        v.atoms.map((a) => push(a, `${name}() を通している`)), v.transformed,
      )));
    }
    return UNK(`call-not-whitelisted:${name ?? '(式)'}`,
      [`${name ?? '関数'}() の本体を追っていない（引数を捨てる関数がありうるため）`]);
  }

  function evalExpr_(n) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)
      || ts.isTypeAssertionExpression?.(n) || ts.isSatisfiesExpression?.(n)) {
      return evalExpr(n.expression);
    }
    if (ts.isAwaitExpression(n)) return evalExpr(n.expression);
    if (ts.isJsxExpression(n)) {
      return n.expression ? evalExpr(n.expression) : LIT();
    }
    if (ts.isIdentifier(n)) {
      if (n.text === 'undefined') return LIT();
      const decls = declsOfName(n);
      if (!decls.length) return UNK(`unresolved-identifier:${n.text}`, [`${n.text} の宣言が見つからない`]);
      return union(decls.map((d) => evalDeclaration(d, n.text)));
    }
    if (ts.isPropertyAccessExpression(n)) {
      return member(evalExpr(n.expression), n.name.text, `.${n.name.text} を参照`);
    }
    if (ts.isElementAccessExpression(n)) {
      return index(evalExpr(n.expression), n.argumentExpression,
        `[${textOf(n.argumentExpression, 20)}] を参照`);
    }
    if (ts.isCallExpression(n)) return evalCall(n);
    if (ts.isTaggedTemplateExpression(n)) return UNK('tagged-template');
    if (ts.isTemplateExpression(n)) {
      return transformedOf(n.templateSpans.map((s) => evalExpr(s.expression)));
    }
    if (ts.isConditionalExpression(n)) {
      /* **条件式は見ない。** 分岐の判定に使った列は、表示値の由来ではない。
       * ここを union に入れると ケースE の e-inline で誤対応になる */
      return union([evalExpr(n.whenTrue), evalExpr(n.whenFalse)]);
    }
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k === ts.SyntaxKind.QuestionQuestionToken
        || k === ts.SyntaxKind.BarBarToken
        || k === ts.SyntaxKind.AmpersandAmpersandToken) {
        /* 短絡。結果はどちらか一方の値そのものである */
        return union([evalExpr(n.left), evalExpr(n.right)]);
      }
      return transformedOf([evalExpr(n.left), evalExpr(n.right)]);
    }
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
      return transformedOf([evalExpr(n.operand)]);
    }
    if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isBigIntLiteral(n)
      || ts.isNoSubstitutionTemplateLiteral(n)
      || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword
      || n.kind === ts.SyntaxKind.NullKeyword) {
      return LIT();
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return UNK('function-value');
    if (ts.isObjectLiteralExpression(n)) return UNK('object-literal');
    if (ts.isArrayLiteralExpression(n)) return UNK('array-literal');
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      return UNK('jsx-value');
    }
    return UNK(`expression:${ts.SyntaxKind[n.kind]}`);
  }

  function evalExpr(n) {
    if (!n) return UNK('no-node');
    if (memo.has(n)) return memo.get(n);
    if (busy.has(n)) return UNK('recursive-reference');
    busy.add(n);
    let v;
    try { v = evalExpr_(n); } finally { busy.delete(n); }
    memo.set(n, v);
    return v;
  }

  /* =============================================== 表示箇所（JSX の子の式） */
  const sites = [];
  for (const sf of sources) {
    const file = rel(sf.fileName);
    if (!file.startsWith(scope)) continue;

    const walk = (n) => {
      if (ts.isJsxExpression(n) && n.parent
        && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
        && n.expression) {
        /* JSX を返す式（`arr.map(...)` や入れ子の要素）は表示値ではない。
         * 中身は別の表示箇所として歩かれる */
        const v = evalExpr(n.expression);
        const isContainer = v.atoms.length === 1
          && v.atoms[0].t === 'unknown'
          && /^(iteration-result|jsx-value)/.test(v.atoms[0].why);
        if (!isContainer) {
          const p = posOf(n);
          /* いちばん内側の、注記（data-poc-field）を持つ祖先要素 */
          let field = null;
          let tag = null;
          for (let a = n.parent; a; a = a.parent) {
            const open = ts.isJsxElement(a) ? a.openingElement
              : ts.isJsxSelfClosingElement(a) ? a : null;
            if (!open) continue;
            if (!tag) tag = open.tagName.getText(sf);
            const at = open.attributes.properties.find((x) => ts.isJsxAttribute(x)
              && (ts.isIdentifier(x.name) ? x.name.text : x.name.getText()) === 'data-poc-field');
            if (at && at.initializer && ts.isStringLiteral(at.initializer)) {
              field = at.initializer.text;
              break;
            }
          }
          /* 囲むコンポーネント */
          let comp = null;
          for (let a = n.parent; a && !comp; a = a.parent) comp = componentNameOf(a);

          /* atom をまとめる。同じ (query, 列) は1つにする */
          const refs = new Map();
          const literals = [];
          const unknowns = [];
          for (const a of v.atoms) {
            if (a.t === 'field' || a.t === 'anyfield') {
              const key = `${a.q.id}:${a.t}:${a.name ?? '*'}`;
              if (!refs.has(key)) {
                refs.set(key, {
                  queryId: a.q.id, kind: a.t, name: a.name ?? null, trail: a.trail,
                });
              }
            } else if (a.t === 'literal') literals.push(a.trail);
            else if (a.t === 'row' || a.t === 'rows' || a.t === 'qres' || a.t === 'tuple') {
              unknowns.push({ why: `whole-${a.t}-not-a-column`, trail: a.trail });
            } else unknowns.push({ why: a.why, trail: a.trail });
          }
          sites.push({
            file: p.file, line: p.line, col: p.col,
            component: comp, field, tag,
            expr: textOf(n.expression),
            transformed: v.transformed,
            refs: [...refs.values()],
            literalCount: literals.length,
            unknowns,
          });
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }

  const diag = program.getSemanticDiagnostics().length;
  if (diag) notes.push({ kind: 'type-diagnostics', detail: `${diag} 件（解析は構文と記号解決に依存し、型検査の成否には依存しない）` });

  return {
    queries,
    sites,
    files: sources.map((sf) => rel(sf.fileName)).filter((f) => f.startsWith(scope)),
    notes,
    scope,
  };
}

/* ========================================================================== */
/* 列名 → DBカラム。**実測された SQL** の構文解析の結果だけを使う             */
/* ========================================================================== */

/** 候補を出せなかった理由の文言 */
export const LINEAGE_REASON = {
  'query-not-measured': 'この取得の呼び出しに対応する、実行された SQL を観測していない',
  'select-star': 'SELECT * のため、実行された SQL からも列を特定できない',
  'field-not-in-select-list': '参照している項目名が、実行された SQL の SELECT 句に無い',
  'no-projection': '実行された SQL から列を解決できていない',
  'aggregate-or-expression': 'SELECT 句のその項目は集計・式であり、1つの列に帰属しない',
  'select-list-parse-failed': '実行された SQL の SELECT 句を構文解析できなかった',
};

/* -------------------------------------------------------------------------- */
/* SELECT 句だけを読む。                                                       */
/*                                                                            */
/* **Phase 6F で共通実装へ寄せた。** かつてこのファイルは独自に構文解析器を     */
/* 持っていた。`sqlparse.mjs` の射影が `columnList`（文中で参照された列）に      */
/* 由来していて `ORDER BY` の列まで拾ってしまうため、PoC-04 ではそれを避けて     */
/* AST の `columns` を読み直していたからである（06e 5.3節 #1）。                 */
/*                                                                            */
/* `sqlparse.mjs` を直したので、**構文解析器を2つ持つ理由は無くなった。**        */
/* 解析器が2つあること自体がこの種の食い違いの原因なので、入口を1つにする。      */
/*                                                                            */
/* 別名（AS）の扱いは変わらない。行オブジェクトの鍵は別名のほうであり、          */
/* 由来の列は別名の下にある（01b Q-04.2 C-2）。                                 */
/* -------------------------------------------------------------------------- */
export { selectList } from './sqlparse.mjs';

/**
 * 1つの表示箇所について、由来の候補を決める。
 *
 * 列まで決まらないときは **テーブルまでに粒度を落とす**（01b Q-04.5 代替1）。
 * ただし落とせるのは「その取得の結果を参照している」ことが解けている場合だけで
 * ある。参照そのものが無い（固定値・範囲外）なら、テーブルも出さない。
 *
 * @param {object} site      analyzeLineage の sites の1件
 * @param {Map<string,object>} sqlByQuery  queryId →
 *   {selectOk, selectStar, items:[{key, resolved:{schema,table,column}|null}], tables, spanId}
 * @returns {{outcome:'confirmed'|'candidates'|'table-only'|'none', candidates:object[],
 *            tableCandidates:object[], unresolved:object[], transformed:boolean,
 *            reasons:string[]}}
 */
export function resolveLineage(site, sqlByQuery) {
  const candidates = [];
  const unresolved = [];
  const seen = new Set();
  const tableCandidates = [];
  const seenTable = new Set();

  /** 列が決まらなかった参照について、テーブルまでを候補に残す */
  const addTable = (ref, why) => {
    const m = sqlByQuery.get(ref.queryId);
    for (const t of m?.tables ?? []) {
      if (!t.schema || !t.name) continue;
      const key = `${t.schema}.${t.name}`;
      if (seenTable.has(key)) continue;
      seenTable.add(key);
      tableCandidates.push({
        schema: t.schema, name: t.name, queryId: ref.queryId, why, trail: ref.trail,
      });
    }
  };

  const add = (p, ref, note) => {
    const key = `${p.schema}.${p.table}.${p.column}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      schema: p.schema, table: p.table, column: p.column,
      queryId: ref.queryId,
      /** 参照の形。anyfield は「キーが動的」である */
      via: ref.kind,
      trail: ref.trail,
      ...(note ? { note } : {}),
    });
  };

  for (const ref of site.refs) {
    const m = sqlByQuery.get(ref.queryId);
    /* 実行された SQL を観測していない呼び出しは、**候補を出さない。**
     * ソースに書いてある文だけで列を決めると「走っていない問い合わせ」の列を
     * 由来にしてしまう */
    if (!m) { unresolved.push({ why: 'query-not-measured', ref }); continue; }
    if (!m.selectOk) {
      unresolved.push({ why: 'select-list-parse-failed', ref });
      continue;
    }
    if (m.selectStar) {
      unresolved.push({ why: 'select-star', ref });
      addTable(ref, 'select-star');
      continue;
    }
    if (!m.items.length) {
      unresolved.push({ why: 'no-projection', ref });
      addTable(ref, 'no-projection');
      continue;
    }
    if (ref.kind === 'anyfield') {
      /* 動的なキー。**その SQL が取った列すべてが候補である。** 1つに絞らない */
      let sawExpr = false;
      for (const it of m.items) {
        if (it.resolved) add(it.resolved, ref, 'キーが動的なため、この SQL の全列が候補');
        else sawExpr = true;
      }
      if (sawExpr) {
        unresolved.push({ why: 'aggregate-or-expression', ref });
        addTable(ref, 'aggregate-or-expression');
      }
      continue;
    }
    /* 行オブジェクトの鍵で引く。**別名があれば別名が鍵である** */
    const hit = m.items.filter((it) => it.key === ref.name);
    if (!hit.length) {
      /* SELECT 句に無い鍵。行にその項目は無いので、テーブルも主張しない */
      unresolved.push({ why: 'field-not-in-select-list', ref });
      continue;
    }
    for (const it of hit) {
      if (it.resolved) add(it.resolved, ref, it.key === it.resolved.column ? undefined : `SQL の別名 ${it.key} → 列 ${it.resolved.column}`);
      else {
        unresolved.push({ why: 'aggregate-or-expression', ref });
        addTable(ref, 'aggregate-or-expression');
      }
    }
  }

  /*
   * 「確定」の条件。1つでも欠けたら候補扱いである。
   *   1. 候補が1件だけ
   *   2. 加工を通っていない
   *   3. 定数が混ざっていない（条件分岐で固定値になる経路が無い）
   *   4. 追えなかった経路が無い
   *   5. 動的なキーでない
   */
  const dynamicKey = candidates.some((c) => c.via === 'anyfield');
  const confirmed = candidates.length === 1 && !site.transformed
    && site.literalCount === 0 && site.unknowns.length === 0 && unresolved.length === 0
    && !dynamicKey;

  const reasons = [];
  if (!candidates.length && !tableCandidates.length) reasons.push('候補なし');
  else if (!candidates.length) {
    reasons.push('列は決まらないが、参照している取得のテーブルは決まる');
    for (const u of unresolved) reasons.push(LINEAGE_REASON[u.why] ?? u.why);
  } else if (confirmed) reasons.push('参照の連鎖が1列に決まり、加工も分岐も無い');
  else {
    if (candidates.length > 1) reasons.push(`候補が ${candidates.length} 件ある`);
    if (site.transformed) reasons.push('加工（連結・変換）を通っている');
    if (site.literalCount) reasons.push('固定値になる経路がある');
    if (dynamicKey) reasons.push('参照のキーが動的で、どの列かが決まらない');
    if (site.unknowns.length) reasons.push('追えない経路がある');
    if (unresolved.length) reasons.push('解決できない参照がある');
  }

  return {
    outcome: candidates.length ? (confirmed ? 'confirmed' : 'candidates')
      : tableCandidates.length ? 'table-only' : 'none',
    candidates,
    tableCandidates,
    unresolved,
    transformed: site.transformed,
    reasons,
  };
}
