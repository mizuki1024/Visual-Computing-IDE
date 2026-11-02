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
 *   5. **ソースの版が3つとも一致する**（06h レビュー F-01 への対処）:
 *        DOM の版（その要素に付いていた data-vcide-rev = その要素を描いたときに変換したファイルの内容）
 *      = 対応表の版（同じ変換が書いた rev）
 *      = いま IDE がファイルを読み直した内容の版（下の 7 の照合に使うのと同じバイト列）
 *      識別子は位置（ファイル:行:列）だけから決まるので、ソースが変わると同じ識別子が別の要素を指す。
 *      版が違えば、古い DOM・古い対応表・途中で変わったソースのどれかであり、位置を出さない
 *   6. DOM のタグと対応表のタグが一致する
 *   7. **ソースを読み直して**（変換器とは別に構文解析して）その位置に同じタグの JSX があり、
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
import { ANCHOR_ID_RE, MAX_ANCESTORS, SOURCE_REV_RE, type ElementSelection } from '../lib/previewProtocol';

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

/** ソースの版。変換器（poc/anchor/transform.cjs の sourceRevision）と同じ規則: 内容（UTF-8）の sha1 の先頭16桁 */
export const sourceRevision = (code: string): string =>
  createHash('sha1').update(code, 'utf8').digest('hex').slice(0, 16);

/* --------------------------------------------------------------- 対応表 */

export interface ManifestAnchor {
  id: string; tag: string; file: string; line: number; col: number;
  component: string; componentLine: number;
  /** この記述を書いた変換が見たソースの版（対応表のファイル単位）。版を書かない古い対応表なら null */
  rev: string | null;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000;

/** 対応表を読む。形の合わない記述は捨てる（対応表もプロジェクトのビルドが書いたものなので信用しない） */
export function readManifest(dir: string): Map<string, ManifestAnchor> {
  const out = new Map<string, ManifestAnchor>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)); } catch { return out; }
  for (const n of names) {
    let j: { anchors?: unknown[]; rev?: unknown };
    try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { anchors?: unknown[]; rev?: unknown }; } catch { continue; }
    const rev = isStr(j.rev) && SOURCE_REV_RE.test(j.rev) ? j.rev : null;
    for (const a of Array.isArray(j.anchors) ? j.anchors : []) {
      const r = a as Record<string, unknown>;
      if (!r || !isStr(r.id) || !ANCHOR_ID_RE.test(r.id) || !isStr(r.tag) || !isStr(r.file)
        || !isPosInt(r.line) || !isPosInt(r.col) || !isStr(r.component) || !isPosInt(r.componentLine)) continue;
      out.set(r.id, {
        id: r.id, tag: r.tag, file: r.file, line: r.line, col: r.col,
        component: r.component, componentLine: r.componentLine, rev,
      });
    }
  }
  return out;
}

/**
 * 対応表に入っている「コンポーネント定義の行範囲」（ローダが同じ変換で書く。7B-3B-1 で読むようにした）。
 * PoC-02 の帰属の第4段（囲むコンポーネントを**ソースの読み直し**と**ビルド時の対応表**の2つで決める）の
 * 片方である。形の合わない記述・注入範囲の外のファイルは捨てる。
 */
export function readManifestComponents(dir: string): Map<string, { name: string; file: string; line: number; endLine: number }[]> {
  const out = new Map<string, { name: string; file: string; line: number; endLine: number }[]>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)); } catch { return out; }
  for (const n of names) {
    let j: { file?: unknown; components?: unknown[] };
    try { j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as typeof j; } catch { continue; }
    if (!isStr(j.file) || !j.file.startsWith(`${ANCHOR_SCOPE}/`) || j.file.split('/').includes('..')) continue;
    const list: { name: string; file: string; line: number; endLine: number }[] = [];
    for (const c of Array.isArray(j.components) ? j.components : []) {
      const r = c as Record<string, unknown>;
      if (!r || !isStr(r.name) || !/^[A-Z][\w$]{0,99}$|^\(default export\)$/.test(r.name)
        || !isPosInt(r.line) || !isPosInt(r.endLine) || r.endLine < r.line) continue;
      list.push({ name: r.name, file: j.file, line: r.line, endLine: r.endLine });
    }
    if (list.length) out.set(j.file, list);
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
  /** この索引を作った内容の版 */
  rev: string;
}

/** 内容の版ごとの索引。F-01: 時刻・大きさではなく**内容**で引く（同じ大きさ・同じ時刻の書き換えを取り違えない） */
const sourceCache = new Map<string, SourceIndex>();

/** ファイルを1回だけ読み、その内容の版を返す。版の照合と構文解析は、必ずこの同じ内容に対して行う */
function readSource(abs: string): { code: string; rev: string } | null {
  try {
    const code = fs.readFileSync(abs, 'utf8');
    return { code, rev: sourceRevision(code) };
  } catch { return null; }
}

/** poc/runner/lib/srcverify.mjs と同じ照合。変換器とは別に、その場でソースを構文解析する */
function indexSource(ts: TS, src: { code: string; rev: string }, abs: string, rel: string): SourceIndex {
  const hit = sourceCache.get(abs);
  if (hit && hit.rev === src.rev) return hit;
  const { code } = src;
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
  const idx = { at, useClient, lines: code.split('\n'), rev: src.rev };
  sourceCache.set(abs, idx);
  return idx;
}

/* ----------------------------------------------------------------- 解決 */

export type UnresolvedReason =
  | 'anchor-missing' | 'injection-unavailable' | 'anchor-not-in-manifest'
  | 'outside-scope' | 'id-mismatch' | 'tag-mismatch' | 'source-mismatch' | 'verifier-unavailable'
  /* F-01: ソースの版 */
  | 'revision-missing' | 'source-changed' | 'manifest-stale';

export interface VerifiedAnchor extends Omit<ManifestAnchor, 'rev'> {
  /** 照合した行のテキスト1行（ソースから読んだもの。DOM からではない） */
  sourceLine: string;
  /** 照合したソースの版（DOM・対応表・読み直した内容で一致したもの） */
  rev: string;
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
  '要素に付いていたソースの版が、対応表の版・いま読み直したファイルの版と一致する（コード変更前の DOM・対応表で解釈しない）',
  'DOM のタグと対応表のタグが一致する',
  'ソースを読み直し（版を確かめたのと同じ内容）、その位置に同じタグの JSX があり、囲むコンポーネントが一致する',
];

/** 再選択を求める文言（画面にも同じ趣旨で出す） */
export const RESELECT_HINT = 'コードが変更されたため、この選択は以前の要素を指している可能性があります。'
  + 'プレビューの再描画を待ってから、もう一度選択してください。';

/** 1つの識別子を照合する。通れば位置を、通らなければ理由を返す */
function verifyOne(
  projectRoot: string, manifest: Map<string, ManifestAnchor>, id: string, domTag: string | null, domRev: string | null,
): { ok: true; anchor: VerifiedAnchor; useClient: boolean } | { ok: false; reason: UnresolvedReason; detail: string } {
  const m = manifest.get(id);
  if (!m) {
    return {
      ok: false, reason: 'anchor-not-in-manifest',
      detail: `識別子 ${id} は、いま実行中の開発サーバーの対応表にありません。`
        + 'まだコンパイルされていないか、別の起動・別のビルドのページ、またはコードが変更される前の表示から来た識別子です。'
        + 'プレビューの再描画を待ってから、もう一度選択してください。',
    };
  }
  const abs = safeSourcePath(projectRoot, m.file);
  if (!abs) {
    return { ok: false, reason: 'outside-scope', detail: `対応表のファイル（${m.file}）が注入範囲（${ANCHOR_SCOPE}/）の中にありません。` };
  }
  if (anchorIdOf(m.file, m.line, m.col) !== id) {
    return { ok: false, reason: 'id-mismatch', detail: `対応表の位置（${m.file}:${m.line}:${m.col}）から計算した識別子が ${id} と一致しません。` };
  }
  /* F-01: ソースの版。位置だけでは、変更前後の要素が同じだと判断しない */
  if (domRev === null) {
    return {
      ok: false, reason: 'revision-missing',
      detail: `この要素には、描いたときのソースの版（data-vcide-rev）が付いていません（${m.file}）。`
        + '版を付けない以前の変換結果（IDE の更新前のビルドのキャッシュなど）から描かれた可能性があります。'
        + '版を照合できないため、この要素を特定しません。ファイルを保存し直すと、そのファイルの要素には版が付きます。',
    };
  }
  if (m.rev === null) {
    return {
      ok: false, reason: 'revision-missing',
      detail: `対応表の ${m.file} の記述に、ソースの版がありません（版を書かない以前のローダが書いた対応表）。版を照合できないため、この要素を特定しません。`,
    };
  }
  const src = readSource(abs);
  if (!src) {
    return { ok: false, reason: 'source-mismatch', detail: `${m.file} を読み直せません（ソースが変わった可能性があります）。` };
  }
  if (domRev !== src.rev) {
    return {
      ok: false, reason: 'source-changed',
      detail: `この要素は ${m.file} の版 ${domRev} から描かれましたが、いまのファイルは版 ${src.rev} です。${RESELECT_HINT}`,
    };
  }
  if (m.rev !== src.rev) {
    return {
      ok: false, reason: 'manifest-stale',
      detail: `対応表の ${m.file} は版 ${m.rev} についてのもので、いまのファイル（版 ${src.rev}）と一致しません（再コンパイル待ち）。`
        + '少し待ってから、もう一度選択してください。',
    };
  }
  if (domTag !== null && m.tag !== domTag) {
    return { ok: false, reason: 'tag-mismatch', detail: `DOM の要素は <${domTag}> ですが、対応表の位置の JSX は <${m.tag}> です。` };
  }
  const ts = typescript();
  if (!ts) {
    return { ok: false, reason: 'verifier-unavailable', detail: 'ソースを読み直す構文解析器（typescript）を読み込めないため、照合できません。照合していない位置は出しません。' };
  }
  /* 版を確かめたのと同じ内容（src）を構文解析する。読み直しの間にファイルが変わっても取り違えない */
  const idx = indexSource(ts, src, abs, m.file);
  const hit = idx.at.get(`${m.line}:${m.col}`);
  if (!hit) {
    return { ok: false, reason: 'source-mismatch', detail: `${m.file}:${m.line}:${m.col} に JSX の要素がありません（ソースが変わった可能性があります）。` };
  }
  if (hit.tag !== m.tag || hit.component !== m.component) {
    return {
      ok: false, reason: 'source-mismatch',
      detail: `${m.file}:${m.line}:${m.col} の JSX は <${hit.tag}>（${hit.component ?? 'コンポーネントの外'}）で、対応表の <${m.tag}>（${m.component}）と一致しません。`,
    };
  }
  const line = (idx.lines[m.line - 1] ?? '').trim();
  return {
    ok: true,
    anchor: { ...m, rev: src.rev, sourceLine: line.length > 200 ? `${line.slice(0, 199)}…` : line },
    useClient: idx.useClient,
  };
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
  const ancRevs = Array.isArray(sel.ancestorRevs) ? sel.ancestorRevs : [];
  sel.ancestorAnchors.slice(0, MAX_ANCESTORS).forEach((id, i) => {
    const r = verifyOne(projectRoot, manifest, id, null, ancRevs[i] ?? null);
    if (r.ok) ancestors.push(r.anchor);
  });
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
  const r = verifyOne(projectRoot, manifest, sel.anchorOnSelf, sel.tag, sel.anchorRev ?? null);
  if (!r.ok) return { status: 'unresolved', reason: r.reason, detail: r.detail, context: nearest };

  const chain = [r.anchor.component];
  for (const a of ancestors) if (a.component !== chain[chain.length - 1]) chain.push(a.component);
  return {
    status: 'resolved', anchor: r.anchor, ancestors, chain,
    directive: r.useClient ? 'use-client' : 'none',
    checks: CHECKS,
  };
}

/* ------------------------------------------------- 選択の後の版の確かめ（F-01） */

/** 一度に確かめるファイルの数の上限（選んだ要素 1 ＋ 祖先 MAX_ANCESTORS） */
export const MAX_REVISION_FILES = MAX_ANCESTORS + 1;

/**
 * 解決済みの選択が依存するファイルの、**いまの**版を返す。画面は、解決したときの版と比べて、
 * 違えば選択を無効にする（コード変更前の選択を、変更後の別の要素の情報として残さない）。
 * 注入範囲（src/ の .tsx / .jsx）の外・読めないファイルは null（＝確かめられない → 画面は無効にする）。
 * 返すのは内容のハッシュだけで、内容そのものは返さない。
 */
export function sourceRevisionsOf(projectRoot: string, files: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of files.slice(0, MAX_REVISION_FILES)) {
    const abs = safeSourcePath(projectRoot, f);
    out[f] = abs ? (readSource(abs)?.rev ?? null) : null;
  }
  return out;
}
