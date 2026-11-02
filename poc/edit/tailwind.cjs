/* =============================================================================
 * 編集 PoC — 題材の Tailwind の**実設定**を読む（EP-14）と、適用前プレビュー（方式 A・予測）の CSS を作る。
 *
 * どちらも題材自身の node_modules の Tailwind（@tailwindcss/node）で、題材の globals.css を
 * そのままコンパイルする。値を IDE 側に書き写さない（既定値が実案件と同じとは仮定しない）。
 * ========================================================================== */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function load(root, name) {
  return require(require.resolve(name, { paths: [root] }));
}

async function compiler(root, cssRel = 'src/app/globals.css') {
  const tw = load(root, '@tailwindcss/node');
  const from = path.join(root, cssRel);
  const base = path.dirname(from);
  return tw.compile(fs.readFileSync(from, 'utf8'), { base, from, onDependency() {} });
}

/** CSS の長さ（rem / px）を px へ。rem は根の文字の大きさ（ブラウザで測った値）を掛ける */
function toPx(v, rootPx) {
  const m = /^(-?[\d.]+)(rem|px)$/.exec(v.trim());
  if (!m) return null;
  return m[2] === 'rem' ? Number(m[1]) * rootPx : Number(m[1]);
}

/**
 * ブレークポイントと spacing を、題材の設定をコンパイルした結果から読む。
 * 返す値は「設定から読めた文字列」と、rootPx で換算した px の両方。
 */
async function readTheme(root, rootPx = 16) {
  const c = await compiler(root);
  const variants = ['sm', 'md', 'lg', 'xl', '2xl'];
  const css = c.build(['p-1', ...variants.map((v) => `${v}:p-1`)]);
  const bp = {};
  for (const v of variants) {
    const esc = v.replace(/^(\d)/, '\\3$1 ');
    const re = new RegExp(`@media \\(width >= ([^)]+)\\)\\s*\\{\\s*\\.${esc.replace(/[\\]/g, '\\\\')}\\\\:p-1`);
    const m = re.exec(css);
    bp[v] = m ? { css: m[1], px: toPx(m[1], rootPx) } : null;
  }
  const sp = /--spacing:\s*([^;]+);/.exec(css);
  return {
    source: 'tailwind-compile',
    breakpoints: bp,
    spacing: sp ? { css: sp[1].trim(), px: toPx(sp[1], rootPx) } : null,
    rootPx,
  };
}

/**
 * 方式 A（予測の重ね合わせ）の CSS。変更後の className の token をすべてコンパイルし、
 * utilities の規則だけを取り出して、選択子を「予測の印が付いた要素」に限る。
 *   - 元のページの CSS は Tailwind の @layer の中にある。ここで作る規則は layer の外に置くので、元の規則に勝つ
 *   - 変更後の token を**すべて**同じ順序で出すので、variant（md: など）の上書きの順序は Tailwind のまま保たれる
 * これは**予測**であり、React のコードを実行した結果ではない（報告書 3節）。
 */
async function predictCss(root, tokens, marker) {
  const c = await compiler(root);
  const css = c.build(tokens);
  const postcss = load(path.dirname(require.resolve('@tailwindcss/postcss', { paths: [root] })), 'postcss');
  const ast = postcss.parse(css);
  let utilities = null;
  let theme = null;
  ast.walkAtRules('layer', (at) => {
    if (at.params === 'utilities' && at.nodes) utilities = at;
    if (at.params === 'theme' && at.nodes) theme = at;
  });
  if (!utilities) return { css: '', rules: 0 };
  const out = postcss.root();
  let n = 0;
  for (const node of utilities.nodes) out.append(node.clone());
  /* token が参照するテーマの変数（ページで未使用なら元の CSS に無い）。値は同じ設定から出たもの */
  const vars = theme ? theme.nodes.map((x) => x.clone()) : [];
  out.walkRules((r) => {
    if (r.parent && r.parent.type === 'atrule' && /keyframes/.test(r.parent.name)) return;
    r.selectors = r.selectors.map((s) => `[${marker}]${s}`);
    n += 1;
  });
  /* テーマの変数は :where() で詳細度を 0 にし、元のページの値を上書きしない（無いときだけ効く…ではなく、
   * 同じ設定から出た同じ値なので、どちらが勝っても値は同じ） */
  for (const v of vars) {
    if (v.type === 'rule') { v.selectors = v.selectors.map((s) => `:where(${s})`); out.prepend(v); }
  }
  return { css: out.toString(), rules: n };
}

module.exports = { readTheme, predictCss, toPx };
