/* =============================================================================
 * 編集 E1 — **書き込みの唯一の入口。** 対象プロジェクトのソースへ書く・消す処理と、IDE 側のジャーナルの書き込みは
 * すべてこのモジュールを通る（src/server/edit/ の中で fs に書くのはこのファイルだけ — tests/edit-disabled が検索で確かめる）。
 *
 * replaceSourceFile（対象のソースの置き換え）の手順:
 *   0. 書き込みが有効か（config.editWritesEnabled）。無効なら何もしない
 *   1. 範囲の検査（scope.resolveWritable）。呼び出し側が検査した時点の同一性（dev・inode・親）と同じか
 *   2. 内容のハッシュが基準（expectedHash）と同じか（外部変更を上書きしない — F-03）
 *   3. 同じディレクトリに一時ファイルを O_CREAT|O_EXCL|O_NOFOLLOW で作り、書いて fsync（rename の原子性には同じ FS が要る）
 *      Linux では /proc/self/fd で、一時ファイルの実体が期待した場所にあることを確かめる（途中のディレクトリの差し替えの検出）
 *   4. 最後の照合: もう一度 1 と 2。読む前と後の lstat（inode・大きさ・更新時刻・変更時刻）が同じか
 *   5. rename（1ファイル単位で原子的。途中で止まっても、元の内容か新しい内容のどちらか）・ディレクトリの fsync
 *   6. 書いた後の確かめ: 一時ファイルだった inode が書き込み先の名前にあり、親ディレクトリが同じで、読み直した内容が書いた内容
 * 結果は3つに分ける: replaced（書いて確かめた）／not-written（書いていないことを確かめた）／unknown（書いたが確かめられない）。
 *
 * **保証しないこと（docs/08a 第5節）**: 4 の最後の照合から 5 の rename までの間の外部の書き込みは検出できない
 * （ファイルのロックが無い通常の FS では 0 にできない。窓は数十マイクロ秒）。同じ権限で src/ を書き換え続ける
 * 敵対的なプロセスがディレクトリを何度も差し替える競合も 0 にはできない（Node に openat/renameat が無い）。
 * ========================================================================== */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editWritesEnabled, TEMP_MARK } from './config';
import { sha256 } from './revision';
import { resolveWritable, sameDir, sameFile, type ScopeRefusal, type WritableFile } from './scope';

/** 書き込みの段（試験は段ごとに外部の変更・停止を差し込む。製品の呼び出しは何も渡さない） */
export type WriteStep = 'before-temp' | 'temp-created' | 'temp-written' | 'before-final-check' | 'before-last-stat' | 'before-rename' | 'renamed';
export interface WriteHooks { step?: (name: WriteStep) => void }

export const TEMP_NAME_RE = /^\.[^/\\\0]{1,200}\.vcide-edit-tx-[0-9]{14}-[0-9a-f]{8}(?:-r[0-9]+)?\.tmp$/;

export interface ReplaceRequest {
  projectRoot: string;
  rel: string;
  /** 書き換える前の内容の sha256（下書きを作った時点・確認した差分の基準） */
  expectedHash: string;
  /** 書き込む内容 */
  next: string;
  /** 一時ファイルの名前（ジャーナルに先に記録しておく。復旧で消すため） */
  tempName: string;
  /** 呼び出し側が検査した時点の同一性。違えば書かない */
  identity?: WritableFile;
  hooks?: WriteHooks;
}

export type NotWrittenReason =
  | 'edit-disabled' | 'outside-scope' | 'identity-changed' | 'external-change' | 'temp-failed' | 'temp-outside-scope' | 'rename-failed' | 'bad-request';

export type ReplaceResult =
  | { status: 'replaced'; readBackHash: string; identity: WritableFile }
  | { status: 'not-written'; reason: NotWrittenReason; detail: string; scopeReason?: ScopeRefusal; currentHash?: string | null; tempLeft?: string | null }
  | { status: 'unknown'; reason: 'readback-mismatch' | 'post-rename-scope-changed' | 'post-rename-error' | 'rename-error-unknown'; detail: string;
    renamed: boolean; currentHash: string | null; writtenAt: string | null };

const hashOf = (abs: string): string | null => { try { return sha256(fs.readFileSync(abs)); } catch { return null; } };
/** Linux の /proc で、開いているファイルの実体の場所を知る（他の OS では null） */
const fdPath = (fd: number): string | null => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return null; } };
const statKey = (s: fs.BigIntStats): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;

function fsyncDir(dir: string): void {
  let d: number | null = null;
  try { d = fs.openSync(dir, 'r'); fs.fsyncSync(d); } catch { /* ディレクトリの fsync が使えない FS */ } finally { if (d !== null) try { fs.closeSync(d); } catch { /* 閉じている */ } }
}

/**
 * 自分が作った一時ファイルを消す。消すのは「開いている fd の実体」または名前で、通常のファイルで、
 * src/ の実体の中にあるものだけ。消せたか（もう無いか）を返す。
 */
function removeTemp(tmpLexical: string, fd: number | null, srcReal: string): string | null {
  const cands = [fd !== null ? fdPath(fd) : null, tmpLexical].filter((x): x is string => !!x && !x.endsWith(' (deleted)'));
  for (const p of [...new Set(cands)]) {
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.isSymbolicLink() || !TEMP_NAME_RE.test(path.basename(p))) continue;
      /* src/ の外の名前は、自分が作ったもの（fd の実体）だけを消す */
      if (!p.startsWith(srcReal + path.sep) && p !== (fd !== null ? fdPath(fd) : null)) continue;
      fs.unlinkSync(p);
    } catch { /* 無い */ }
  }
  const left = cands.find((p) => { try { fs.lstatSync(p); return true; } catch { return false; } });
  return left ?? null;
}

/** 対象のソースを1ファイル置き換える（上の手順）。**この関数の外で対象のソースへ書かない** */
export function replaceSourceFile(req: ReplaceRequest): ReplaceResult {
  const step = (s: WriteStep) => { req.hooks?.step?.(s); };
  const notWritten = (reason: NotWrittenReason, detail: string, extra: Partial<Extract<ReplaceResult, { status: 'not-written' }>> = {}): ReplaceResult =>
    ({ status: 'not-written', reason, detail, ...extra });
  if (!editWritesEnabled()) return notWritten('edit-disabled', '編集の書き込みは無効です（VCIDE_EDIT_E1_WRITE=1 を明示したときだけ有効）。');
  if (!TEMP_NAME_RE.test(req.tempName) || typeof req.next !== 'string' || !/^[0-9a-f]{64}$/.test(req.expectedHash)) {
    return notWritten('bad-request', '書き込みの要求の形が正しくありません。');
  }
  /* 1. 範囲 */
  const s1 = resolveWritable(req.projectRoot, req.rel);
  if (!s1.ok) return notWritten('outside-scope', s1.detail, { scopeReason: s1.reason });
  const w = s1.file;
  if (req.identity && !sameFile(w, req.identity)) {
    return notWritten('identity-changed', '検査した後に、書き込み先のファイルが別のものに置き換わりました。書き込みません。');
  }
  /* 2. 内容 */
  const h1 = hashOf(w.abs);
  if (h1 !== req.expectedHash) {
    return notWritten('external-change', '変更案を作った後に、このファイルが変わりました。上書きしません。', { currentHash: h1 });
  }
  const nextBuf = Buffer.from(req.next, 'utf8');
  const nextHash = sha256(nextBuf);
  const tmp = path.join(w.dir, req.tempName);
  step('before-temp');
  /* 3. 一時ファイル */
  let fd: number | null = null;
  let tmpIno: number | null = null;
  const abort = (reason: NotWrittenReason, detail: string, extra: Partial<Extract<ReplaceResult, { status: 'not-written' }>> = {}): ReplaceResult => {
    const left = removeTemp(tmp, fd, w.srcReal);
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 閉じている */ } fd = null; }
    return notWritten(reason, detail, { ...extra, tempLeft: left });
  };
  try {
    const C = fs.constants;
    fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), w.mode & 0o777);
    step('temp-created');
    const real = fdPath(fd);
    if (real !== null && real !== tmp) {
      return abort('temp-outside-scope', `一時ファイルが期待した場所（${path.relative(w.root, tmp)}）の外に作られました。途中のディレクトリが差し替えられた可能性があります。書き込みません。`);
    }
    let off = 0;
    while (off < nextBuf.length) off += fs.writeSync(fd, nextBuf, off, nextBuf.length - off);
    fs.fsyncSync(fd);
    tmpIno = fs.fstatSync(fd).ino;
  } catch (e) {
    return abort('temp-failed', `一時ファイルを書けませんでした: ${String((e as Error).message).slice(0, 200)}`);
  }
  step('temp-written');
  /* 4. 最後の照合 */
  step('before-final-check');
  const s2 = resolveWritable(req.projectRoot, req.rel);
  if (!s2.ok) return abort('outside-scope', s2.detail, { scopeReason: s2.reason });
  if (!sameFile(s2.file, w)) return abort('identity-changed', '書き込みの途中で、書き込み先のファイルが別のものに置き換わりました。書き込みません。');
  let stA: fs.BigIntStats;
  try { stA = fs.lstatSync(w.abs, { bigint: true }); } catch { return abort('identity-changed', '書き込み先を確かめられません。'); }
  const h2 = hashOf(w.abs);
  if (h2 !== req.expectedHash) return abort('external-change', '書き込みの途中で、このファイルが変わりました。上書きしません。', { currentHash: h2 });
  const real2 = fdPath(fd);
  if (real2 !== null && real2 !== tmp) return abort('temp-outside-scope', '一時ファイルの場所が変わりました（途中のディレクトリの差し替え）。書き込みません。');
  step('before-last-stat');
  let stB: fs.BigIntStats;
  try { stB = fs.lstatSync(w.abs, { bigint: true }); } catch { return abort('identity-changed', '書き込み先を確かめられません。'); }
  if (statKey(stA) !== statKey(stB) || stB.isSymbolicLink()) {
    return abort('external-change', '最後の照合の間に、このファイルが変わりました。上書きしません。', { currentHash: hashOf(w.abs) });
  }
  /* 5. rename */
  step('before-rename');
  try {
    fs.renameSync(tmp, w.abs);
  } catch (e) {
    const now = hashOf(w.abs);
    if (now === req.expectedHash || now === null) {
      return abort('rename-failed', `置き換え（rename）に失敗しました。書き込んでいません: ${String((e as Error).message).slice(0, 200)}`, { currentHash: now });
    }
    const left = removeTemp(tmp, fd, w.srcReal);
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 閉じている */ } fd = null; }
    return { status: 'unknown', reason: 'rename-error-unknown', detail: `置き換えに失敗し、ファイルの内容が基準と違います（一時ファイル: ${left ?? '無し'}）。`, renamed: false, currentHash: now, writtenAt: null };
  }
  fsyncDir(w.dir);
  step('renamed');
  /* 6. 書いた後の確かめ */
  const writtenAt = fd !== null ? fdPath(fd) : null;
  if (fd !== null) { try { fs.closeSync(fd); } catch { /* 閉じている */ } fd = null; }
  const s3 = resolveWritable(req.projectRoot, req.rel);
  if (!s3.ok || !sameDir(s3.file, w) || s3.file.ino !== tmpIno || (writtenAt !== null && writtenAt !== w.abs)) {
    return {
      status: 'unknown', reason: 'post-rename-scope-changed',
      detail: `書き込んだ後に、書き込み先の場所を確かめられません（書いた実体: ${writtenAt ?? '不明'}）。要確認です。`,
      renamed: true, currentHash: hashOf(w.abs), writtenAt,
    };
  }
  const back = hashOf(w.abs);
  if (back !== nextHash) {
    return {
      status: 'unknown', reason: 'readback-mismatch',
      detail: '書き込んだ直後に読み直した内容が、書いた内容と違います（直後に別の書き込みがあった可能性）。成功扱いにしません。',
      renamed: true, currentHash: back, writtenAt,
    };
  }
  return { status: 'replaced', readBackHash: back, identity: s3.file };
}

/** 復旧で、ジャーナルに記録した一時ファイルを消す（同じ範囲の検査を通したディレクトリの中の、名前の形が合う通常のファイルだけ） */
export function removeRecordedTemp(projectRoot: string, rel: string, tempName: string): { removed: boolean; left: boolean } {
  if (!editWritesEnabled() || !TEMP_NAME_RE.test(tempName)) return { removed: false, left: false };
  const s = resolveWritable(projectRoot, rel);
  if (!s.ok) return { removed: false, left: false };
  const p = path.join(s.file.dir, tempName);
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return { removed: false, left: true };
    fs.unlinkSync(p);
    return { removed: true, left: false };
  } catch { return { removed: false, left: false }; }
}

/* --------------------------------------------------------------- IDE 側の記録 */

/** IDE 側の記録（ジャーナル・検証の記録）を原子的に書く。対象プロジェクトの中には書かない（呼び出し側が確かめる） */
export function writeJsonAtomic(dir: string, name: string, value: unknown): void {
  if (!/^[\w.-]{1,120}$/.test(name)) throw new Error(`bad journal name: ${name}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    const buf = Buffer.from(`${JSON.stringify(value, null, 1)}\n`, 'utf8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 無い */ } throw e; }
  fsyncDir(dir);
}

/** IDE 側の記録を消す（保存期間を過ぎた終わりのジャーナルだけ。呼び出し側が状態を確かめる） */
export function removeRecord(dir: string, name: string): void {
  if (!/^[\w.-]{1,120}$/.test(name)) return;
  try { fs.unlinkSync(path.join(dir, name)); } catch { /* 無い */ }
}

/* --------------------------------------------------------------- 排他 */

export interface LockOwner { pid: number; host: string; at: string }

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * プロジェクトごとの排他（同じジャーナルを使う複数の IDE のプロセスが、同時に適用・取り消し・復旧をしない）。
 * 持ち主のプロセスが死んでいる鍵だけを取り除く。取れなければ null。
 */
/** このプロセスがいま持っている鍵（同じ pid の別の（前の）プロセスが残した鍵と区別する） */
const HELD = new Set<string>();

export function acquireLock(dir: string): (() => void) | null {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'apply.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      const me: LockOwner = { pid: process.pid, host: os.hostname(), at: new Date().toISOString() };
      fs.writeSync(fd, JSON.stringify(me));
      fs.closeSync(fd);
      HELD.add(file);
      return () => {
        HELD.delete(file);
        try {
          const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as LockOwner;
          if (cur.pid === process.pid) fs.unlinkSync(file);
        } catch { /* 無い */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      let owner: LockOwner | null = null;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')) as LockOwner; } catch { owner = null; }
      /* 書きかけ（中身が読めない）の鍵は、作った直後かもしれないので取り除かない */
      /* 自分の pid の鍵は、このプロセスが持っているときだけ有効（持っていなければ、同じ pid だった前のプロセスの残り） */
      const mine = owner?.pid === process.pid;
      if (!owner || owner.host !== os.hostname() || (mine && HELD.has(file)) || (!mine && pidAlive(owner.pid))) return null;
      try { fs.unlinkSync(file); } catch { /* 別のプロセスが先に消した */ }
    }
  }
  return null;
}
