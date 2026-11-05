/* =============================================================================
 * 編集 E1 — **書き込みの唯一の入口。** 対象プロジェクトのソースへ書く・消す処理と、IDE 側のジャーナルの書き込みは
 * すべてこのモジュールを通る（src/server/edit/ の中で fs に書くのはこのファイルだけ — tests/edit-disabled が検索で確かめる）。
 *
 * replaceSourceFile（対象のソースの置き換え）の手順（E1.1 で 3・6〜9 を改めた。docs/08b 第3・4節）:
 *   0. 書き込みが有効か（config.editWritesEnabled）。無効なら何もしない
 *   1. 範囲の検査（scope.resolveWritable）。呼び出し側が検査した時点の同一性（dev・inode・親）と同じか
 *   2. **親ディレクトリを開いて固定する**（O_DIRECTORY|O_NOFOLLOW。開いたものの dev・inode が検査したものと同じか）。
 *      Linux では以後の作成・リンク・rename・読み出しを `/proc/self/fd/<そのfd>/<名前>` で行う（openat と同じく、
 *      途中のディレクトリが差し替えられても、検査したディレクトリの実体の中でだけ操作する）。/proc が使えない OS では
 *      パスで操作し、作った一時ファイルの場所を事後に確かめる（固定できたかを結果の `pinned` で返す）
 *   3. 内容のハッシュが基準（expectedHash）と同じか。読むのは O_NOFOLLOW|O_NONBLOCK で開いた fd（リンク・FIFO を読まない）
 *   4. 同じディレクトリに一時ファイルを O_CREAT|O_EXCL|O_NOFOLLOW で作り、書いて fsync
 *   5. 最後の照合: もう一度 1 と 3。読む前と後の lstat が同じか
 *   6. **退避リンク**: 書き込み先の名前の実体へ、2つ目の名前（`<一時ファイル>.orig.tmp`）を link で付ける。
 *      書き込み先の実体（元の内容）は、rename の後もこの名前で残る
 *   7. rename（1ファイル単位で原子的。書き込み先の名前は常にどちらかの内容を指す）・ディレクトリの fsync
 *   8. **置き換えた後の照合**: 退避リンクの実体が、照合した inode で、内容が基準とバイト一致するか。
 *      - 一致 → 置き換えた元の内容は基準そのもの（外部の書き込みを置き換えていない）。退避リンクを外す
 *      - 不一致（照合の後〜rename の前に、外部が同じ実体へ書いた／外部が別の実体へ置き換えた）→ **外部の版を書き戻す**
 *        （自分の実体にも退避リンクを付けてから、外部の版を rename で戻す）。結果は conflict-restored
 *   9. 書いた後の確かめ: 一時ファイルだった inode が書き込み先の名前にあり、親ディレクトリが同じで、読み直した内容が書いた内容
 * 結果: replaced（書いて確かめた）／not-written（書いていない）／conflict-restored（外部の変更を検出し、外部の版へ戻した）／
 *       unknown（書いたが確かめられない・要確認）。
 *
 * **保証しないこと（docs/08b 第3・7節）**:
 *   - 6 の link と 7 の rename の**間**に、外部のプロセスが「別のファイルを書いて rename で置き換える」形の保存をすると、
 *     その版は 7 で置き換えられて失われ、検出できない（POSIX に「名前が指す実体が X のときだけ rename する」操作が無い。
 *     Node には renameat2(RENAME_EXCHANGE) も無い）。連続する2つの系呼び出しの間の窓
 *   - 置き換える前から書き込み先を開いていた外部のプロセスが、8 の照合の後にその fd で書いた内容
 *     （置き換えた元の実体へ書かれ、名前が無くなる。外すまでの間の書き込みは検出して残す）
 *   - 外部のエディタはこの排他（apply.lock）に従わない。ロックは同じジャーナルを使うエンジンどうしの取り決めにすぎない
 *   - /proc が無い OS（macOS 等）では 2 の固定ができず、検査と操作の間のディレクトリの差し替えは事後の検出だけになる
 * ========================================================================== */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editWritesEnabled, TEMP_MARK } from './config';
import { sha256 } from './revision';
import { resolveParentDir, resolveWritable, sameDir, sameFile, type ScopeRefusal, type WritableFile } from './scope';

/** 書き込みの段（試験は段ごとに外部の変更・停止を差し込む。製品の呼び出しは何も渡さない） */
export type WriteStep =
  | 'before-temp' | 'temp-created' | 'temp-written' | 'before-final-check' | 'before-last-stat'
  /** 最後の照合の後・退避リンクの前 */
  | 'before-rename'
  /** 退避リンクの後・rename の前（**検出できない窓**。docs/08b 第3節） */
  | 'snapshot-linked'
  | 'renamed'
  /** 退避リンクの内容を確かめた後・外す前 */
  | 'snapshot-verified'
  /** 外部の版を書き戻す途中（自分の実体に退避リンクを付けた後・外部の版を rename で戻す前） */
  | 'restore-linked';
export interface WriteHooks {
  step?: (name: WriteStep) => void;
  /** 試験用: /proc が無い OS と同じく、ディレクトリを固定せずにパスで操作する（固定しない経路の試験のため。製品は渡さない） */
  unpinned?: boolean;
}

/** 一時ファイル・退避リンクの名前（`.<名前>.vcide-edit-<txId>[-r<n>][.orig|.ours].tmp`） */
export const TEMP_NAME_RE = /^\.[^/\\\0]{1,200}\.vcide-edit-tx-[0-9]{14}-[0-9a-f]{8}(?:-r[0-9]+)?(?:\.(?:orig|ours))?\.tmp$/;
/** 一時ファイルの名前から、退避リンクの名前を作る（ジャーナルに一時ファイルの名前だけを記録すれば足りるように、決まった規則で作る） */
export const snapshotNameOf = (tempName: string): string => tempName.replace(/\.tmp$/, '.orig.tmp');
export const oursNameOf = (tempName: string): string => tempName.replace(/\.tmp$/, '.ours.tmp');

export interface ReplaceRequest {
  projectRoot: string;
  rel: string;
  /** 書き換える前の内容の sha256（下書きを作った時点・確認した差分の基準） */
  expectedHash: string;
  /** 書き込む内容 */
  next: string;
  /** 一時ファイルの名前（ジャーナルに先に記録しておく。復旧で消すため）。退避リンクの名前はここから決まる */
  tempName: string;
  /** 呼び出し側が検査した時点の同一性。違えば書かない */
  identity?: WritableFile;
  hooks?: WriteHooks;
}

export type NotWrittenReason =
  | 'edit-disabled' | 'outside-scope' | 'identity-changed' | 'external-change' | 'temp-failed' | 'temp-outside-scope'
  | 'rename-failed' | 'bad-request' | 'snapshot-failed';

export type ReplaceResult =
  | { status: 'replaced'; readBackHash: string; identity: WritableFile; pinned: boolean }
  | { status: 'not-written'; reason: NotWrittenReason; detail: string; scopeReason?: ScopeRefusal; currentHash?: string | null; tempLeft?: string | null }
  | { status: 'conflict-restored'; reason: 'external-change-during-replace'; detail: string; currentHash: string | null; kept: string[] }
  | { status: 'unknown'; reason: 'readback-mismatch' | 'post-rename-scope-changed' | 'post-rename-error' | 'rename-error-unknown' | 'restore-failed' | 'late-write';
    detail: string; renamed: boolean; currentHash: string | null; writtenAt: string | null; kept?: string[] };

/* --------------------------------------------------------------- 低い層 */
const C = fs.constants;
const statKey = (s: fs.BigIntStats): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
/** 内容が変わったかの鍵（unlink で変わる ctime・nlink は含めない） */
const dataKey = (s: fs.BigIntStats): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
/** Linux の /proc で、開いているファイルの実体の場所を知る（他の OS では null） */
const fdPath = (fd: number): string | null => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return null; } };
const closeQuiet = (fd: number | null) => { if (fd !== null) try { fs.closeSync(fd); } catch { /* 閉じている */ } };

function fsyncDir(dir: string): void {
  let d: number | null = null;
  try { d = fs.openSync(dir, 'r'); fs.fsyncSync(d); } catch { /* ディレクトリの fsync が使えない FS */ } finally { closeQuiet(d); }
}

/** 検査したディレクトリの実体を開いて固定する。開いた実体が検査したものと違えば null */
interface DirHandle { fd: number; pinned: boolean; at: (name: string) => string; dir: string }
function openDir(dir: string, dev: number, ino: number, noPin = false): DirHandle | null {
  let fd: number;
  try { fd = fs.openSync(dir, C.O_RDONLY | (C.O_DIRECTORY ?? 0) | (C.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isDirectory() || st.dev !== dev || st.ino !== ino) { closeQuiet(fd); return null; }
  } catch { closeQuiet(fd); return null; }
  const base = `/proc/self/fd/${fd}`;
  let pinned = false;
  if (!noPin) { try { const ps = fs.statSync(base); pinned = ps.isDirectory() && ps.dev === dev && ps.ino === ino; } catch { pinned = false; } }
  return { fd, pinned, dir, at: (name: string) => (pinned ? `${base}/${name}` : path.join(dir, name)) };
}

/** 通常のファイルとして読む（リンク・FIFO を読まない）。無い・通常のファイルでない → null */
interface ReadBack { hash: string; ino: number; key: string; buf: Buffer }
function readAt(p: string): ReadBack | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, C.O_RDONLY | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(fd);
    return { hash: sha256(buf), ino: Number(st.ino), key: dataKey(st), buf };
  } catch { return null; } finally { closeQuiet(fd); }
}
const lstatIno = (p: string): number | null => { try { const s = fs.lstatSync(p); return s.isFile() ? s.ino : null; } catch { return null; } };
const exists = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };

/**
 * 自分が作った一時ファイルを消す。消すのは「開いている fd の実体」または名前で、通常のファイルで、
 * 名前の形が合うものだけ（固定したディレクトリの中、または固定できないときは src/ の実体の中）。消せたか（もう無いか）を返す。
 */
function removeTemp(h: DirHandle, tempName: string, fd: number | null, srcReal: string): string | null {
  const lexical = h.at(tempName);
  const real = fd !== null && !h.pinned ? fdPath(fd) : null;
  const cands = [lexical, real].filter((x): x is string => !!x && !x.endsWith(' (deleted)'));
  for (const p of [...new Set(cands)]) {
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.isSymbolicLink() || !TEMP_NAME_RE.test(path.basename(p))) continue;
      /* 固定していないとき、src/ の外の名前は自分が作ったもの（fd の実体）だけを消す */
      if (!h.pinned && !p.startsWith(srcReal + path.sep) && p !== real) continue;
      fs.unlinkSync(p);
    } catch { /* 無い */ }
  }
  const left = cands.find((p) => exists(p));
  return left ?? null;
}

/**
 * 退避リンク（など、内容を持つかもしれない2つ目の名前）を、**失うものが無いときだけ**外す。
 *   - いま書き込み先の名前が指す実体と同じ inode（同じ実体へのもう1つの名前。外しても内容は残る）
 *   - または内容が allowed のどれかとバイト一致（基準・自分が書いた内容など、他に残っている内容）
 * それ以外（外部の変更を含む可能性がある）は外さずに残す（kept）。
 */
function releaseIfSafe(h: DirHandle, name: string, leafName: string, allowed: readonly string[]): 'absent' | 'removed' | 'kept' {
  const p = h.at(name);
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return 'absent'; }
  if (!st.isFile() || !TEMP_NAME_RE.test(name)) return 'kept';
  const leafIno = lstatIno(h.at(leafName));
  let safe = leafIno !== null && leafIno === st.ino;
  if (!safe) { const r = readAt(p); safe = !!r && r.ino === st.ino && allowed.includes(r.hash); }
  if (!safe) return 'kept';
  try { fs.unlinkSync(p); return 'removed'; } catch { return exists(p) ? 'kept' : 'absent'; }
}

/* --------------------------------------------------------------- 置き換え */

/** 対象のソースを1ファイル置き換える（上の手順）。**この関数の外で対象のソースへ書かない** */
export function replaceSourceFile(req: ReplaceRequest): ReplaceResult {
  const step = (s: WriteStep) => { req.hooks?.step?.(s); };
  const notWritten = (reason: NotWrittenReason, detail: string, extra: Partial<Extract<ReplaceResult, { status: 'not-written' }>> = {}): ReplaceResult =>
    ({ status: 'not-written', reason, detail, ...extra });
  if (!editWritesEnabled()) return notWritten('edit-disabled', '編集の書き込みは無効です（VCIDE_EDIT_E1_WRITE=1 を明示したときだけ有効）。');
  if (typeof req.tempName !== 'string' || !TEMP_NAME_RE.test(req.tempName) || /\.(?:orig|ours)\.tmp$/.test(req.tempName)
    || typeof req.next !== 'string' || typeof req.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(req.expectedHash)) {
    return notWritten('bad-request', '書き込みの要求の形が正しくありません。');
  }
  /* 1. 範囲 */
  const s1 = resolveWritable(req.projectRoot, req.rel);
  if (!s1.ok) return notWritten('outside-scope', s1.detail, { scopeReason: s1.reason });
  const w = s1.file;
  if (req.identity && !sameFile(w, req.identity)) {
    return notWritten('identity-changed', '検査した後に、書き込み先のファイルが別のものに置き換わりました。書き込みません。');
  }
  /* 2. 親ディレクトリの固定 */
  const h = openDir(w.dir, w.dirDev, w.dirIno, req.hooks?.unpinned === true);
  if (!h) return notWritten('identity-changed', '書き込み先のディレクトリを、検査したものとして開けません（差し替えられた可能性）。書き込みません。');
  try {
    return replaceIn(h, w, req, step, notWritten);
  } finally { closeQuiet(h.fd); }
}

function replaceIn(h: DirHandle, w: WritableFile, req: ReplaceRequest, step: (s: WriteStep) => void,
  notWritten: (reason: NotWrittenReason, detail: string, extra?: Partial<Extract<ReplaceResult, { status: 'not-written' }>>) => ReplaceResult): ReplaceResult {
  const leaf = path.basename(w.abs);
  const target = h.at(leaf);
  /* 3. 内容（検査した実体を、リンク・FIFO を辿らずに読む） */
  const r1 = readAt(target);
  if (!r1 || r1.ino !== w.ino) return notWritten('identity-changed', '検査した後に、書き込み先のファイルが別のものに置き換わりました。書き込みません。');
  if (r1.hash !== req.expectedHash) {
    return notWritten('external-change', '変更案を作った後に、このファイルが変わりました。上書きしません。', { currentHash: r1.hash });
  }
  const nextBuf = Buffer.from(req.next, 'utf8');
  const nextHash = sha256(nextBuf);
  const tmpName = req.tempName;
  const snapName = snapshotNameOf(tmpName);
  const oursName = oursNameOf(tmpName);
  const tmp = h.at(tmpName);
  step('before-temp');
  /* 4. 一時ファイル */
  let fd: number | null = null;
  let tmpIno: number | null = null;
  const abort = (reason: NotWrittenReason, detail: string, extra: Partial<Extract<ReplaceResult, { status: 'not-written' }>> = {}): ReplaceResult => {
    const left = removeTemp(h, tmpName, fd, w.srcReal);
    closeQuiet(fd); fd = null;
    return notWritten(reason, detail, { ...extra, tempLeft: left });
  };
  try {
    fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), w.mode & 0o777);
    step('temp-created');
    if (!h.pinned) {
      const real = fdPath(fd);
      if (real !== null && real !== tmp) {
        return abort('temp-outside-scope', `一時ファイルが期待した場所（${path.relative(w.root, tmp)}）の外に作られました。途中のディレクトリが差し替えられた可能性があります。書き込みません。`);
      }
    }
    let off = 0;
    while (off < nextBuf.length) off += fs.writeSync(fd, nextBuf, off, nextBuf.length - off);
    fs.fsyncSync(fd);
    tmpIno = fs.fstatSync(fd).ino;
  } catch (e) {
    return abort('temp-failed', `一時ファイルを書けませんでした: ${msg(e)}`);
  }
  step('temp-written');
  /* 5. 最後の照合（パスでの範囲・同一性と、固定したディレクトリでの内容） */
  step('before-final-check');
  const s2 = resolveWritable(req.projectRoot, req.rel);
  if (!s2.ok) return abort('outside-scope', s2.detail, { scopeReason: s2.reason });
  if (!sameFile(s2.file, w)) return abort('identity-changed', '書き込みの途中で、書き込み先のファイルが別のものに置き換わりました。書き込みません。');
  let stA: fs.BigIntStats;
  try { stA = fs.lstatSync(target, { bigint: true }); } catch { return abort('identity-changed', '書き込み先を確かめられません。'); }
  const r2 = readAt(target);
  if (!r2 || r2.ino !== w.ino) return abort('identity-changed', '書き込みの途中で、書き込み先のファイルが別のものに置き換わりました。書き込みません。');
  if (r2.hash !== req.expectedHash) return abort('external-change', '書き込みの途中で、このファイルが変わりました。上書きしません。', { currentHash: r2.hash });
  if (!h.pinned) {
    const real2 = fdPath(fd as number);
    if (real2 !== null && real2 !== tmp) return abort('temp-outside-scope', '一時ファイルの場所が変わりました（途中のディレクトリの差し替え）。書き込みません。');
  }
  step('before-last-stat');
  let stB: fs.BigIntStats;
  try { stB = fs.lstatSync(target, { bigint: true }); } catch { return abort('identity-changed', '書き込み先を確かめられません。'); }
  if (statKey(stA) !== statKey(stB) || stB.isSymbolicLink()) {
    return abort('external-change', '最後の照合の間に、このファイルが変わりました。上書きしません。', { currentHash: readAt(target)?.hash ?? null });
  }
  step('before-rename');
  /* パスで見ても、まだ検査したディレクトリ・ファイルか（ここで差し替えを見つければ、何も置き換えずに止める） */
  const s2b = resolveWritable(req.projectRoot, req.rel);
  if (!s2b.ok) return abort('outside-scope', s2b.detail, { scopeReason: s2b.reason });
  if (!sameFile(s2b.file, w)) return abort('identity-changed', '書き込みの直前に、書き込み先のファイルが別のものに置き換わりました。書き込みません。');
  /* 6. 退避リンク（書き込み先の実体へ2つ目の名前を付ける。rename の後も元の実体を確かめられるように） */
  try {
    fs.linkSync(target, h.at(snapName));
  } catch (e) {
    return abort('snapshot-failed', `書き込み先の退避リンクを作れません（ハードリンクを使えないファイルシステムでは書き込みません）: ${msg(e)}`);
  }
  step('snapshot-linked');
  /* 7. rename */
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    const now = readAt(target);
    const rel = releaseIfSafe(h, snapName, leaf, [req.expectedHash]);
    if (now && now.hash === req.expectedHash) {
      return abort('rename-failed', `置き換え（rename）に失敗しました。書き込んでいません: ${msg(e)}`, { currentHash: now.hash });
    }
    const left = removeTemp(h, tmpName, fd, w.srcReal);
    closeQuiet(fd); fd = null;
    return { status: 'unknown', reason: 'rename-error-unknown', renamed: false, currentHash: now?.hash ?? null, writtenAt: null,
      kept: rel === 'kept' ? [snapName] : [],
      detail: `置き換えに失敗し、ファイルの内容が基準と違います（一時ファイル: ${left ?? '無し'}）。` };
  }
  fsyncDir(w.dir);
  step('renamed');
  const writtenAt = fd !== null && !h.pinned ? fdPath(fd) : null;
  closeQuiet(fd); fd = null;
  /* 8. 置き換えた後の照合: 置き換えた元の実体（退避リンク）が、照合した実体・内容のままか */
  const sv = verifySnapshot(h, snapName, w.ino, req.expectedHash, step);
  if (sv.state !== 'clean') {
    return restoreExternal(h, w, req, leaf, snapName, oursName, tmpIno as number, nextHash, sv.state === 'late' ? 'late' : 'changed');
  }
  /* 9. 書いた後の確かめ */
  const s3 = resolveWritable(req.projectRoot, req.rel);
  if (!s3.ok || !sameDir(s3.file, w) || s3.file.ino !== tmpIno || (writtenAt !== null && writtenAt !== w.abs)) {
    return {
      status: 'unknown', reason: 'post-rename-scope-changed',
      detail: `書き込んだ後に、書き込み先の場所を確かめられません（書いた実体: ${writtenAt ?? (h.pinned ? '検査したディレクトリの中' : '不明')}）。要確認です。`,
      renamed: true, currentHash: readAt(target)?.hash ?? null, writtenAt,
    };
  }
  const back = readAt(target);
  if (!back || back.hash !== nextHash || back.ino !== tmpIno) {
    return {
      status: 'unknown', reason: 'readback-mismatch',
      detail: '書き込んだ直後に読み直した内容が、書いた内容と違います（直後に別の書き込みがあった可能性）。成功扱いにしません。',
      renamed: true, currentHash: back?.hash ?? null, writtenAt,
    };
  }
  return { status: 'replaced', readBackHash: back.hash, identity: s3.file, pinned: h.pinned };
}

/**
 * 退避リンクの実体を確かめ、基準のままなら外す。
 *   clean  : 照合した inode・基準の内容のまま。外した（外す直前・直後も内容が変わっていない）
 *   changed: 照合した inode でない（rename で置き換えられていた）か、内容が基準と違う（同じ実体へ書かれた）。外していない
 *   late   : 確かめた後・外す前後に、開いていた fd から書かれた。内容を同じ名前で残した
 */
function verifySnapshot(h: DirHandle, snapName: string, ino: number, expected: string, step: (s: WriteStep) => void): { state: 'clean' | 'changed' | 'late' } {
  const p = h.at(snapName);
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, C.O_RDONLY | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0));
    const s0 = fs.fstatSync(fd, { bigint: true });
    if (!s0.isFile() || Number(s0.ino) !== ino) return { state: 'changed' };
    const buf = fs.readFileSync(fd);
    if (sha256(buf) !== expected) return { state: 'changed' };
    step('snapshot-verified');
    const s1 = fs.fstatSync(fd, { bigint: true });
    if (dataKey(s1) !== dataKey(s0)) return { state: 'changed' };
    fs.unlinkSync(p);
    const s2 = fs.fstatSync(fd, { bigint: true });
    if (dataKey(s2) !== dataKey(s0)) {
      /* 外した直前・直後に書かれた: 名前はもう無いので、読める内容を同じ名前で作り直して残す */
      const late = Buffer.alloc(Number(s2.size));
      let off = 0;
      while (off < late.length) { const n = fs.readSync(fd, late, off, late.length - off, off); if (n <= 0) break; off += n; }
      try {
        const wfd = fs.openSync(p, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), 0o600);
        try { fs.writeSync(wfd, late, 0, off); fs.fsyncSync(wfd); } finally { closeQuiet(wfd); }
      } catch { /* 残せなかった（結果に late を返し、要確認とする） */ }
      return { state: 'late' };
    }
    return { state: 'clean' };
  } catch { return { state: 'changed' }; } finally { closeQuiet(fd); }
}

/**
 * 置き換えた後に、外部の変更（退避リンク側）を見つけた。**外部の版を書き込み先へ戻す。**
 * 自分の実体にも2つ目の名前（.ours.tmp）を付けてから、退避リンクを rename で書き込み先へ戻す（戻す途中で
 * 自分の版に外部が書いても、その内容は .ours.tmp に残る）。戻せないときは何も消さずに要確認。
 */
function restoreExternal(h: DirHandle, w: WritableFile, req: ReplaceRequest, leaf: string, snapName: string, oursName: string,
  tmpIno: number, nextHash: string, why: 'changed' | 'late'): ReplaceResult {
  const step = (s: WriteStep) => { req.hooks?.step?.(s); };
  const target = h.at(leaf);
  const snap = h.at(snapName);
  const ours = h.at(oursName);
  const unknown = (reason: 'restore-failed' | 'late-write', detail: string): ReplaceResult => {
    const kept = [snapName, oursName].filter((n) => exists(h.at(n)));
    return { status: 'unknown', reason, detail: `${detail}（残したファイル: ${kept.join('・') || '無し'}）`, renamed: true,
      currentHash: readAt(target)?.hash ?? null, writtenAt: null, kept };
  };
  if (why === 'late') {
    return unknown('late-write', '置き換えた元のファイルへ、照合の後に開いていた fd から書き込まれました。その内容を残しました。要確認です');
  }
  if (!exists(snap)) return unknown('restore-failed', '置き換えた元のファイル（退避リンク）が見つかりません');
  try { fs.linkSync(target, ours); } catch (e) { return unknown('restore-failed', `外部の版を戻す準備（自分の版への退避リンク）ができません: ${msg(e)}`); }
  if (lstatIno(ours) !== tmpIno) {
    /* 書き込み先はもう自分の実体ではない（さらに別の書き込み）。自分の名前を付けた実体は書き込み先と同じなので外してよい */
    releaseIfSafe(h, oursName, leaf, [nextHash]);
    return unknown('restore-failed', '外部の変更を検出しましたが、書き込み先がさらに別の内容に置き換わっています。書き戻しません');
  }
  step('restore-linked');
  try { fs.renameSync(snap, target); } catch (e) {
    releaseIfSafe(h, oursName, leaf, [nextHash]);
    return unknown('restore-failed', `外部の版を書き込み先へ戻せません: ${msg(e)}`);
  }
  fsyncDir(w.dir);
  /* 自分の版（.ours.tmp）は、書いた内容のままなら外す（戻す途中に外部が書いていれば残す） */
  const ro = releaseIfSafe(h, oursName, leaf, [nextHash]);
  const cur = readAt(target);
  const kept = ro === 'kept' ? [oursName] : [];
  return {
    status: 'conflict-restored', reason: 'external-change-during-replace', currentHash: cur?.hash ?? null, kept,
    detail: '書き込みの最中に、外部（エディタ・整形・AI など）がこのファイルを変更しました。外部の版を残し、この変更は適用していません'
      + `（置き換えの直後のごく短い間だけ、この変更の内容が書き込み先にありました）。${kept.length ? `要確認: ${kept.join('・')} を残しました。` : ''}`,
  };
}

/* --------------------------------------------------------------- 復旧で、記録した一時ファイル・退避リンクを片付ける */

export type ArtifactOutcome = 'absent' | 'removed' | 'kept';

/**
 * 復旧で、ジャーナルに記録した一時ファイル（名前から決まる退避リンクを含む）を片付ける。
 *   tempName           : 自分が作った新しい内容の一時ファイル。名前の形が合う通常のファイルなら消す（外部の内容を持たない）
 *   退避リンク（.orig） : 書き込み先と同じ実体か、内容が origAllowed のどれかのときだけ外す。それ以外は**残す**（外部の変更を含みうる）
 *   自分の版（.ours）  : 書き込み先と同じ実体か、内容が oursAllowed のどれかのときだけ外す
 * 書き込み先のファイルが無い・リンク数が 2 でも、親ディレクトリが範囲の中なら片付けられる。
 */
export function cleanupRecordedArtifacts(projectRoot: string, rel: string, tempName: string,
  origAllowed: readonly string[], oursAllowed: readonly string[]): { temp: ArtifactOutcome; orig: ArtifactOutcome; ours: ArtifactOutcome } | null {
  if (!editWritesEnabled() || typeof tempName !== 'string' || !TEMP_NAME_RE.test(tempName) || /\.(?:orig|ours)\.tmp$/.test(tempName)) return null;
  const d = resolveParentDir(projectRoot, rel);
  if (!d.ok) return null;
  const h = openDir(d.dir, d.dirDev, d.dirIno);
  if (!h) return null;
  try {
    const leaf = path.basename(rel);
    let temp: ArtifactOutcome = 'absent';
    try {
      const st = fs.lstatSync(h.at(tempName));
      if (st.isFile()) { fs.unlinkSync(h.at(tempName)); temp = 'removed'; } else temp = 'kept';
    } catch { temp = exists(h.at(tempName)) ? 'kept' : 'absent'; }
    const orig = releaseIfSafe(h, snapshotNameOf(tempName), leaf, origAllowed);
    const ours = releaseIfSafe(h, oursNameOf(tempName), leaf, oursAllowed);
    if (temp === 'removed' || orig === 'removed' || ours === 'removed') fsyncDir(d.dir);
    return { temp, orig, ours };
  } finally { closeQuiet(h.fd); }
}

/** 記録した一時ファイル・退避リンクのうち、いまある名前（読むだけ。dry-run と判断に使う） */
export function recordedArtifactsPresent(projectRoot: string, rel: string, tempName: string): { temp: boolean; orig: boolean; ours: boolean } {
  const none = { temp: false, orig: false, ours: false };
  if (typeof tempName !== 'string' || !TEMP_NAME_RE.test(tempName)) return none;
  const d = resolveParentDir(projectRoot, rel);
  if (!d.ok) return none;
  const p = (n: string) => path.join(d.dir, n);
  return { temp: exists(p(tempName)), orig: exists(p(snapshotNameOf(tempName))), ours: exists(p(oursNameOf(tempName))) };
}

/** 記録した退避リンクの内容のハッシュと、書き込み先と同じ実体か（読むだけ） */
export function inspectRecordedSnapshot(projectRoot: string, rel: string, name: string): { present: boolean; hash: string | null; sameAsTarget: boolean } {
  const out = { present: false, hash: null as string | null, sameAsTarget: false };
  if (typeof name !== 'string' || !TEMP_NAME_RE.test(name)) return out;
  const d = resolveParentDir(projectRoot, rel);
  if (!d.ok) return out;
  const p = path.join(d.dir, name);
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch { return out; }
  out.present = true;
  if (!st.isFile()) return out;
  const r = readAt(p);
  out.hash = r?.hash ?? null;
  out.sameAsTarget = lstatIno(path.join(d.dir, path.basename(rel))) === st.ino;
  return out;
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

export interface LockOwner { pid: number; host: string; at: string; nonce?: string }

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** このプロセスがいま持っている鍵（同じ pid の別の（前の）プロセスが残した鍵と区別する） */
const HELD = new Set<string>();

function readLock(file: string): { owner: LockOwner | null; ino: number | null; raw: string | null } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, C.O_RDONLY | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0));
    const ino = fs.fstatSync(fd).ino;
    const raw = fs.readFileSync(fd, 'utf8');
    try { return { owner: JSON.parse(raw) as LockOwner, ino, raw }; } catch { return { owner: null, ino, raw }; }
  } catch { return { owner: null, ino: null, raw: null }; } finally { closeQuiet(fd); }
}

/**
 * プロジェクトごとの排他（同じジャーナルを使う複数のエンジン・IDE のプロセスが、同時に適用・取り消し・復旧をしない）。
 * **取り決めにすぎない**（外部のエディタはこの鍵を見ない）。同じプロセスの中でも、持っている間は2つ目を取れない（再入しない）。
 * 持ち主のプロセスが死んでいる鍵だけを取り除く。取り除くときは、鍵を別名へ rename してから、それが「死んでいると判断した鍵と
 * 同じ inode・同じ中身」であることを確かめる（E1.1: 2つのプロセスが同時に古い鍵を取り除くと、片方が他方の新しい鍵を消して
 * 両方が鍵を持つ競合があった）。違えば（他のプロセスの新しい鍵を動かした）link で戻し、取らない。取れなければ null。
 */
/** 試験用の同期点（製品の呼び出しは渡さない）: 古い鍵と判断した直後・取り除く前に呼ぶ */
export interface LockHooks { afterStaleRead?: () => void }

export function acquireLock(dir: string, hooks?: LockHooks): (() => void) | null {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'apply.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW ?? 0), 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const { owner, ino, raw } = readLock(file);
      /* 書きかけ（中身が読めない）の鍵は、作った直後かもしれないので取り除かない */
      /* 自分の pid の鍵は、このプロセスが持っているときだけ有効（持っていなければ、同じ pid だった前のプロセスの残り） */
      const mine = owner?.pid === process.pid;
      if (!owner || ino === null || owner.host !== os.hostname() || (mine && HELD.has(file)) || (!mine && pidAlive(owner.pid))) return null;
      hooks?.afterStaleRead?.();
      const aside = path.join(dir, `.apply.lock.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
      try { fs.renameSync(file, aside); } catch { continue; }   // 別のプロセスが先に取り除いた
      /* inode の番号は消した直後に再利用されうるので、中身（持ち主・時刻）も同じかを比べる */
      const moved = readLock(aside);
      if (moved.ino === ino && moved.raw === raw) { try { fs.unlinkSync(aside); } catch { /* 無い */ } continue; }
      /* 死んだ鍵ではなく、その後に別のプロセスが作った鍵を動かした: 元へ戻して（上書きはしない）、取らない */
      try { fs.linkSync(aside, file); } catch { /* さらに別の鍵ができていた（docs/08b 第7節の残余） */ }
      try { fs.unlinkSync(aside); } catch { /* 無い */ }
      return null;
    }
    const nonce = crypto.randomBytes(8).toString('hex');
    try {
      const me: LockOwner = { pid: process.pid, host: os.hostname(), at: new Date().toISOString(), nonce };
      fs.writeSync(fd, JSON.stringify(me));
      fs.fsyncSync(fd);
    } finally { closeQuiet(fd); }
    HELD.add(file);
    return () => {
      HELD.delete(file);
      const cur = readLock(file).owner;
      if (cur && cur.pid === process.pid && cur.nonce === nonce) { try { fs.unlinkSync(file); } catch { /* 無い */ } }
    };
  }
  return null;
}
