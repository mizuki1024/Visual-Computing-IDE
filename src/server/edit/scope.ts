/* =============================================================================
 * 編集 E1 — 書き込み範囲の検査（06h レビュー F-02）。**読むだけ**（lstat・realpath・stat）。
 *
 * 書き込み先として認めるのは、次をすべて満たすファイルだけ:
 *   1. パスの形: `src/` で始まる相対パス・`..`/`.`/空の区間・`node_modules`・隠しファイル/ディレクトリ・NUL・`\` を含まない・
 *      拡張子は `.tsx` / `.jsx`（小文字）
 *   2. **根から葉までのどの区間もシンボリックリンクでない**（lstat で1区間ずつ確かめる。リンク先が src/ の中でも拒否）
 *   3. 実体のパス（realpath）が realpath(root/src) の中
 *   4. 通常のファイル・リンク数が 1（ハードリンクで別の場所と内容を共有していない）・大きさの上限以内
 * 返す `WritableFile` は検査した時点の同一性（dev・inode・親ディレクトリの dev・inode）を持つ。
 * 書き込みの入口（fsio.ts）は書く直前にもう一度この検査を行い、同一性が変わっていれば書かない。
 *
 * **保証の範囲**: 検査と書き込みは別の系呼び出しなので、その間の差し替えを 0 にはできない（Node に openat/renameat が無い）。
 * 対処と残る窓は fsio.ts と docs/08a 第5節。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { EDIT_EXTENSIONS, EDIT_SCOPE, MAX_SOURCE_BYTES } from './config';

export type ScopeRefusal =
  | 'bad-path' | 'extension-not-allowed' | 'root-invalid' | 'src-missing' | 'missing'
  | 'symlink-in-path' | 'not-directory' | 'not-regular-file' | 'outside-src' | 'hard-linked' | 'too-large';

export interface WritableFile {
  /** プロジェクトの根の実体のパス */
  root: string;
  /** プロジェクトの根からの相対パス（`src/...`） */
  rel: string;
  /** 書き込み先の絶対パス（根の実体 + rel。途中にリンクが無いので実体のパスと同じ） */
  abs: string;
  /** realpath(abs)。abs と一致することを確かめ済み */
  real: string;
  /** 親ディレクトリの実体のパス */
  dir: string;
  /** realpath(root/src) */
  srcReal: string;
  dev: number; ino: number; dirDev: number; dirIno: number;
  mode: number; size: number; nlink: number;
}

export type ScopeResult = { ok: true; file: WritableFile } | { ok: false; reason: ScopeRefusal; detail: string };

const REASON_TEXT: Record<ScopeRefusal, string> = {
  'bad-path': 'パスの形が書き込み先として認められません（src/ の下の相対パスで、..・隠し区間・node_modules・制御文字を含まないもの）',
  'extension-not-allowed': `拡張子が書き込み先として認められません（${EDIT_EXTENSIONS.join('・')} だけ）`,
  'root-invalid': 'プロジェクトの根を確かめられません',
  'src-missing': 'プロジェクトの src/ がありません',
  missing: '書き込み先のファイルがありません（E1 は既存のファイルの変更だけを扱います）',
  'symlink-in-path': '書き込み先までの途中、または書き込み先そのものがシンボリックリンクです。リンクを通じて書き込みません',
  'not-directory': '書き込み先までの途中がディレクトリではありません',
  'not-regular-file': '書き込み先が通常のファイルではありません',
  'outside-src': '書き込み先の実体が src/ の外です',
  'hard-linked': '書き込み先が別の場所とハードリンクで内容を共有しています（リンク数 > 1）',
  'too-large': `書き込み先が大きすぎます（${MAX_SOURCE_BYTES} バイトまで）`,
};

const fail = (reason: ScopeRefusal, extra = ''): ScopeResult => ({ ok: false, reason, detail: `${REASON_TEXT[reason]}${extra ? `（${extra}）` : ''}` });

/** パスの形だけの検査（ファイルシステムを見ない） */
export function checkRelShape(rel: unknown): ScopeRefusal | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) return 'bad-path';
  if (/[\u0000-\u001f\u007f\\]/.test(rel) || rel.startsWith('/') || !rel.startsWith(`${EDIT_SCOPE}/`)) return 'bad-path';
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s === 'node_modules' || s.startsWith('.'))) return 'bad-path';
  if (!EDIT_EXTENSIONS.some((e) => rel.endsWith(e))) return 'extension-not-allowed';
  return null;
}

/** 書き込み先の検査。通れば検査した時点の同一性を返す */
export function resolveWritable(projectRoot: string, rel: unknown): ScopeResult {
  const shape = checkRelShape(rel);
  if (shape) return fail(shape, typeof rel === 'string' ? rel.slice(0, 200) : typeof rel);
  const r = rel as string;
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(projectRoot));
    if (!fs.statSync(root).isDirectory()) return fail('root-invalid');
  } catch { return fail('root-invalid'); }
  const segs = r.split('/');
  let cur = root;
  let dirStat: fs.Stats | null = null;
  let leaf: fs.Stats | null = null;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch { return fail(i === 0 ? 'src-missing' : 'missing', r); }
    if (st.isSymbolicLink()) return fail('symlink-in-path', path.relative(root, cur));
    if (i < segs.length - 1) {
      if (!st.isDirectory()) return fail('not-directory', path.relative(root, cur));
      dirStat = st;
    } else {
      leaf = st;
    }
  }
  if (!leaf || !dirStat) return fail('missing', r);
  if (!leaf.isFile()) return fail('not-regular-file', r);
  const abs = path.join(root, ...segs);
  let real: string;
  let srcReal: string;
  try {
    real = fs.realpathSync(abs);
    srcReal = fs.realpathSync(path.join(root, EDIT_SCOPE));
  } catch { return fail('missing', r); }
  /* 途中にリンクが無いので実体のパスは abs と一致するはず。一致しなければ（検査の途中で差し替えられた等）拒否 */
  if (real !== abs || !real.startsWith(srcReal + path.sep) || srcReal !== path.join(root, EDIT_SCOPE)) return fail('outside-src', r);
  if (leaf.nlink !== 1) return fail('hard-linked', `リンク数 ${leaf.nlink}`);
  if (leaf.size > MAX_SOURCE_BYTES) return fail('too-large', `${leaf.size} バイト`);
  return {
    ok: true,
    file: {
      root, rel: r, abs, real, dir: path.dirname(abs), srcReal,
      dev: leaf.dev, ino: leaf.ino, dirDev: dirStat.dev, dirIno: dirStat.ino,
      mode: leaf.mode, size: leaf.size, nlink: leaf.nlink,
    },
  };
}

/** 同じファイル（同じ場所・同じ inode・同じ親ディレクトリ）か */
export function sameFile(a: WritableFile, b: WritableFile): boolean {
  return a.real === b.real && a.dev === b.dev && a.ino === b.ino && a.dirDev === b.dirDev && a.dirIno === b.dirIno;
}

/** 同じ親ディレクトリか（rename の後はファイルの inode が変わるので、ディレクトリだけを比べる） */
export function sameDir(a: WritableFile, b: WritableFile): boolean {
  return a.dir === b.dir && a.dirDev === b.dirDev && a.dirIno === b.dirIno && a.real === b.real;
}
