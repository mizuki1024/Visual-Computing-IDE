/* =============================================================================
 * 要素識別子 → React のソース位置（Phase 7B-2）。PoC-03 方式1 をそのまま使う。
 *
 *   ビルド時: poc/anchor/loader.cjs が JSX の組み込み要素に data-vcide="<id>" を差し込み、
 *             「識別子 → (ファイル, 行, 列, コンポーネント)」の対応表を書く
 *   選択時  : プレビューの中のスクリプトは**識別子だけ**を送る。位置は IDE がここで引く
 *
 * **受け取った値を信用しない。** 位置として出してよいのは、次をすべて満たしたときだけである。
 *   1. この要素自身に識別子が付いていた（祖先の識別子は文脈であって出所ではない — PoC-03 1.4節）
 *   2. 識別子が、いま実行中の開発サーバーの対応表に載っている
 *   3. 対応表のファイルが対象プロジェクトの注入範囲（src/）の中にある（パスの抜け道・シンボリックリンクを含めて）
 *   4. 識別子を (ファイル:行:列) から計算し直すと一致する（変換器と同じ規則。対応表の書き換えを見抜く）
 *   5. DOM のタグと対応表のタグが一致する
 *   6. **ソースを読み直して**（変換器とは別に構文解析して）その位置に同じタグの JSX があり、
 *      囲むコンポーネントが対応表と一致する（PoC-03 の srcverify.mjs と同じ照合）
 * 1 つでも欠ければ「特定できません」と理由を返す。推測で埋めない。
 *
 * 対象プロジェクトには書き込まない。対応表は IDE 側（.ide-runtime/anchors/）に書かせる。
 * ========================================================================== */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ideRoot, runtimeDir } from './ide';
import { ANCHOR_ID_RE, MAX_ANCESTORS, type ElementSelection } from '../lib/previewProtocol';

/** 注入範囲（01b Q-03 C-3）。poc/fixture-app/next.config.mjs の ANCHOR_OPTS.scope と同じ */
export const ANCHOR_SCOPE = 'src';

/** 対象の next.config がこの名前の環境変数でローダを有効にする（PoC-03 の題材の取り決め） */
export const ANCHOR_ENV = 'POC03_ANCHOR';
export const ANCHOR_OUT_ENV = 'POC03_ANCHOR_OUT';

export type AnchorState = 'enabled' | 'unavailable';

export interface AnchorSupport {
  state: AnchorState;
  /** 使えない理由（使えるなら null） */
  reason: string | null;
  scope: string;
}

/** プロジェクトごとの対応表の置き場所。起動をまたいで同じ場所にする（下の注記） */
export function anchorOutDir(projectRoot: string): string {
  const key = createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  return path.join(runtimeDir(), 'anchors', key);
}
/*
 * 同じ場所にする理由: Turbopack は開発時の変換結果を対象の .next にキャッシュする。
 * 起動のたびに置き場所を変えると、キャッシュに当たったファイルではローダが走らず、
 * 新しい置き場所の対応表が空になる（＝すべて「対応表に無い」になる）。識別子は
 * (パス:行:列) から決まるので、ソースが同じなら対応表も同じである。ソースが変われば
 * ローダが走り直してそのファイルの分を書き換える。古い記述が残っても、第4〜6 の照合で
 * 現在のソースと合わないものは出さない。
 */

const CONFIG_NAMES = ['next.config.mjs', 'next.config.js', 'next.config.ts', 'next.config.cjs', 'next.config.mts'];

/**
 * 対象プロジェクトが、IDE の要素識別子ローダを読み込む設定になっているか。
 * **IDE は対象の next.config を書き換えない**（Phase 7A の方針）。設定が無ければ「使えない」と言う。
 */
export function anchorSupport(projectRoot: string): AnchorSupport {
  const cfg = CONFIG_NAMES.map((n) => path.join(/* turbopackIgnore: true */ projectRoot, n)).find((p) => fs.existsSync(p));
  if (!cfg) {
    return {
      state: 'unavailable', scope: ANCHOR_SCOPE,
      reason: 'next.config が無いため、要素識別子の注入（ビルド時のローダ）は設定されていません。',
    };
  }
  let text = '';
  try { text = fs.readFileSync(cfg, 'utf8'); } catch { /* 読めなければ下で「無い」 */ }
  if (!text.includes(ANCHOR_ENV)) {
    return {
      state: 'unavailable', scope: ANCHOR_SCOPE,
      reason: `${path.basename(cfg)} は要素識別子の注入（PoC-03 のローダ。${ANCHOR_ENV} で有効にする）を読み込んでいません。`
        + 'IDE は対象プロジェクトの設定を書き換えないため、このプロジェクトでは要素からソースを特定できません。',
    };
  }
  return { state: 'enabled', reason: null, scope: ANCHOR_SCOPE };
}

/** 起動先に足す環境変数。使えない場合は何も足さない */
export function anchorEnv(projectRoot: string, support: AnchorSupport): Record<string, string> {
  if (support.state !== 'enabled') return {};
  const out = anchorOutDir(projectRoot);
  fs.mkdirSync(out, { recursive: true });
  return { [ANCHOR_ENV]: '1', [ANCHOR_OUT_ENV]: out };
}

/** 変換器（poc/anchor/transform.cjs）と同じ規則 */
export const anchorIdOf = (rel: string, line: number, col: number): string =>
  createHash('sha1').update(`${rel}:${line}:${col}`).digest('hex').slice(0, 10);

/* --------------------------------------------------------------- 対応表 */

export interface ManifestAnchor {
  id: string; tag: string; file: string; line: number; col: number;
  component: string; componentLine: number;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000;

/** 対応表を読む。形の合わない記述は捨てる（対応表もプロジェクトのビルドが書いたものなので信用しない） */
export function readManifest(dir: string): Map<string, ManifestAnchor> {
  const out = new Map<string, ManifestAnchor>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)); } catch { return out; }
  for (const n of names) {
    let j: { anchors?: unknown[] };
    try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { anchors?: unknown[] }; } catch { continue; }
    for (const a of Array.isArray(j.anchors) ? j.anchors : []) {
      const r = a as Record<string, unknown>;
      if (!r || !isStr(r.id) || !ANCHOR_ID_RE.test(r.id) || !isStr(r.tag) || !isStr(r.file)
        || !isPosInt(r.line) || !isPosInt(r.col) || !isStr(r.component) || !isPosInt(r.componentLine)) continue;
      out.set(r.id, {
        id: r.id, tag: r.tag, file: r.file, line: r.line, col: r.col,
        component: r.component, componentLine: r.componentLine,
      });
    }
  }
  return out;
}

/* ---------------------------------------------------- ソースの読み直し */

type TS = typeof import('typescript');
let tsMod: TS | null | undefined;
/** 構文解析器。IDE 本体の依存から実行時に読む（画面のバンドルに入れない） */
function typescript(): TS | null {
  if (tsMod !== undefined) return tsMod;
  try {
    tsMod = createRequire(path.join(ideRoot(), 'package.json'))('typescript') as TS;
  } catch { tsMod = null; }
  return tsMod;
}

/** 注入範囲の中のファイルか。`..`・絶対パス・シンボリックリンクで外へ出るものを拒む */
export function safeSourcePath(projectRoot: string, rel: string): string | null {
  if (!/^[^\0\\]+\.(tsx|jsx)$/.test(rel) || rel.startsWith('/') || !rel.startsWith(`${ANCHOR_SCOPE}/`)) return null;
  if (rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '' || seg === 'node_modules')) return null;
  const root = path.resolve(projectRoot);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(root);
    if (!real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch { return null; }
}

interface SourceIndex {
  /** "行:列" → その位置で始まる JSX 要素 */
  at: Map<string, { tag: string; component: string | null }>;
  /** 'use client' がファイルの先頭にあるか */
  useClient: boolean;
  lines: string[];
}

const sourceCache = new Map<string, { mtimeMs: number; size: number; idx: SourceIndex }>();

/** poc/runner/lib/srcverify.mjs と同じ照合。変換器とは別に、その場でソースを構文解析する */
function indexSource(ts: TS, abs: string, rel: string): SourceIndex | null {
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return null; }
  const hit = sourceCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.idx;
  const code = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, false,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
  const at: SourceIndex['at'] = new Map();
  const stack: string[] = [];
  const isPascal = (s: string) => /^[A-Z]/.test(s);
  // skipTrivia は公開の型に無いが、変換器（transform.cjs）と同じ位置を得るために同じものを使う
  const skipTrivia = (ts as unknown as { skipTrivia: (t: string, p: number) => number }).skipTrivia;
  const posOf = (n: import('typescript').Node) => {
    const lc = sf.getLineAndCharacterOfPosition(skipTrivia(code, n.pos));
    return { line: lc.line + 1, col: lc.character + 1 };
  };
  const nameOf = (n: import('typescript').Node): string | null => {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n))) {
      if (n.name && isPascal(n.name.text)) return n.name.text;
      if (n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return '(default export)';
      return null;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isPascal(n.name.text)
      && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.text;
    return null;
  };
  const walk = (n: import('typescript').Node) => {
    const nm = nameOf(n);
    if (nm) stack.push(nm);
    const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (open) {
      const p = posOf(n);
      at.set(`${p.line}:${p.col}`, { tag: open.tagName.getText(sf), component: stack.length ? stack[stack.length - 1] : null });
    }
    ts.forEachChild(n, walk);
    if (nm) stack.pop();
  };
  walk(sf);
  const first = sf.statements[0];
  const useClient = !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression)
    && first.expression.text === 'use client';
  const idx = { at, useClient, lines: code.split('\n') };
  sourceCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, idx });
  return idx;
}

/* ----------------------------------------------------------------- 解決 */

export type UnresolvedReason =
  | 'anchor-missing' | 'injection-unavailable' | 'anchor-not-in-manifest'
  | 'outside-scope' | 'id-mismatch' | 'tag-mismatch' | 'source-mismatch' | 'verifier-unavailable';

export interface VerifiedAnchor extends ManifestAnchor {
  /** 照合した行のテキスト1行（ソースから読んだもの。DOM からではない） */
  sourceLine: string;
}

export type AnchorResolution =
  | {
    status: 'resolved';
    anchor: VerifiedAnchor;
    /** 祖先の識別子のうち、照合に通ったもの（近い順。包含関係の文脈であって出所ではない） */
    ancestors: VerifiedAnchor[];
    /** 祖先の識別子から作った包含関係（文脈）。最初が選択した要素のコンポーネント */
    chain: string[];
    /** このファイルの先頭の指定。描かれた場所（サーバー／ブラウザ）は、これだけでは決まらない */
    directive: 'use-client' | 'none';
    /** 通った照合 */
    checks: string[];
  }
  | {
    status: 'unresolved';
    reason: UnresolvedReason;
    detail: string;
    /** いちばん近い祖先で照合できたもの（文脈。**この要素の出所ではない**） */
    context: { tag: string; component: string; file: string; line: number } | null;
  };

const CHECKS = [
  'この要素自身に付いていた要素識別子（祖先の識別子は使っていない）',
  'いま実行中の開発サーバーのビルドが書いた対応表に、その識別子がある',
  '対応表のファイルが注入範囲（src/）の中にある',
  '識別子を「ファイル:行:列」から計算し直すと一致する',
  'DOM のタグと対応表のタグが一致する',
  'ソースを読み直し、その位置に同じタグの JSX があり、囲むコンポーネントが一致する',
];

/** 1つの識別子を照合する。通れば位置を、通らなければ理由を返す */
function verifyOne(
  projectRoot: string, manifest: Map<string, ManifestAnchor>, id: string, domTag: string | null,
): { ok: true; anchor: VerifiedAnchor; useClient: boolean } | { ok: false; reason: UnresolvedReason; detail: string } {
  const m = manifest.get(id);
  if (!m) {
    return {
      ok: false, reason: 'anchor-not-in-manifest',
      detail: `識別子 ${id} は、いま実行中の開発サーバーの対応表にありません。`
        + 'まだコンパイルされていないか、別の起動・別のビルドのページから来た識別子です。',
    };
  }
  const abs = safeSourcePath(projectRoot, m.file);
  if (!abs) {
    return { ok: false, reason: 'outside-scope', detail: `対応表のファイル（${m.file}）が注入範囲（${ANCHOR_SCOPE}/）の中にありません。` };
  }
  if (anchorIdOf(m.file, m.line, m.col) !== id) {
    return { ok: false, reason: 'id-mismatch', detail: `対応表の位置（${m.file}:${m.line}:${m.col}）から計算した識別子が ${id} と一致しません。` };
  }
  if (domTag !== null && m.tag !== domTag) {
    return { ok: false, reason: 'tag-mismatch', detail: `DOM の要素は <${domTag}> ですが、対応表の位置の JSX は <${m.tag}> です。` };
  }
  const ts = typescript();
  if (!ts) {
    return { ok: false, reason: 'verifier-unavailable', detail: 'ソースを読み直す構文解析器（typescript）を読み込めないため、照合できません。照合していない位置は出しません。' };
  }
  const idx = indexSource(ts, abs, m.file);
  const hit = idx?.at.get(`${m.line}:${m.col}`);
  if (!idx || !hit) {
    return { ok: false, reason: 'source-mismatch', detail: `${m.file}:${m.line}:${m.col} に JSX の要素がありません（ソースが変わった可能性があります）。` };
  }
  if (hit.tag !== m.tag || hit.component !== m.component) {
    return {
      ok: false, reason: 'source-mismatch',
      detail: `${m.file}:${m.line}:${m.col} の JSX は <${hit.tag}>（${hit.component ?? 'コンポーネントの外'}）で、対応表の <${m.tag}>（${m.component}）と一致しません。`,
    };
  }
  const line = (idx.lines[m.line - 1] ?? '').trim();
  return { ok: true, anchor: { ...m, sourceLine: line.length > 200 ? `${line.slice(0, 199)}…` : line }, useClient: idx.useClient };
}

export function resolveSelection(
  projectRoot: string, support: AnchorSupport, sel: ElementSelection,
): AnchorResolution {
  if (support.state !== 'enabled') {
    return { status: 'unresolved', reason: 'injection-unavailable', detail: support.reason ?? '', context: null };
  }
  const manifest = readManifest(anchorOutDir(projectRoot));
  /* 祖先は文脈。照合できたものだけを使う */
  const ancestors: VerifiedAnchor[] = [];
  for (const id of sel.ancestorAnchors.slice(0, MAX_ANCESTORS)) {
    const r = verifyOne(projectRoot, manifest, id, null);
    if (r.ok) ancestors.push(r.anchor);
  }
  const nearest = ancestors[0]
    ? { tag: ancestors[0].tag, component: ancestors[0].component, file: ancestors[0].file, line: ancestors[0].line }
    : null;

  if (!sel.anchorOnSelf) {
    return {
      status: 'unresolved', reason: 'anchor-missing',
      detail: `この <${sel.tag}> 自身には要素識別子がありません。`
        + 'ライブラリ由来の要素・JSX を経由せずに作られた要素・注入範囲（src/）の外の要素・'
        + 'フレームワークが所有する要素（html / body）のいずれかですが、DOM からはどれかを区別できません。'
        + (nearest ? `祖先の <${nearest.tag}>（${nearest.component}）には識別子がありますが、祖先は文脈であって出所ではないため、そこへは対応付けていません。` : ''),
      context: nearest,
    };
  }
  const r = verifyOne(projectRoot, manifest, sel.anchorOnSelf, sel.tag);
  if (!r.ok) return { status: 'unresolved', reason: r.reason, detail: r.detail, context: nearest };

  const chain = [r.anchor.component];
  for (const a of ancestors) if (a.component !== chain[chain.length - 1]) chain.push(a.component);
  return {
    status: 'resolved', anchor: r.anchor, ancestors, chain,
    directive: r.useClient ? 'use-client' : 'none',
    checks: CHECKS,
  };
}
