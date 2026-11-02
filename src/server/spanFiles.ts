/* =============================================================================
 * Phase 7C-1 — 計装の収集ファイル（`.ide-runtime/spans/<runId>.jsonl`）の整理（P1-8）。
 *
 * 7C-0 まで: 起動ごとのファイルが消えずに残り続けた（1 要求あたり約 47 KB。SQL 文も残る）。
 *
 * 消すもの（**すべて**を満たすものだけ）
 *   1. IDE の作業ディレクトリ `<IDE>/.ide-runtime/spans/` の**直下**にある。作業ディレクトリと
 *      spans ディレクトリが実在のディレクトリ（シンボリックリンクではない）で、実パスが期待どおり
 *   2. 名前が IDE の起動の名前（`<プロジェクト名>-<13桁の時刻>.jsonl`。devServer.ts の runId）
 *   3. 通常のファイル（lstat。シンボリックリンク・ディレクトリは辿らずに残す）
 *   4. 中の記録（先頭と末尾の 64 KB）が名乗る起動（proc.run）がファイル名と一致する。
 *      記録が無い（空の）ファイルは、作られてから EMPTY_GRACE_MS を過ぎたものだけ
 *   5. 記録を書いたプロセス（proc.pid）が1つも生きていない（**実行中のファイルは消さない**。
 *      PID の再利用で生きていると誤認したときは、消さない側に倒れる）
 *   6. 呼び出し側が守ると言ったファイル（いまの起動・引き継いだ起動のファイル）ではない
 *
 * 消さないもの: 上のどれかを満たさないものすべて（利用者が置いたファイル・別の名前・リンクの先・
 * 対象プロジェクトのソースや DB — そもそもこのディレクトリの外は見ない）。
 *
 * いつ: IDE の起動時（強制終了の残骸）・開発サーバーの起動の直前・停止／異常終了の後。
 * 失敗したとき: そのファイルは残し、理由を結果に残して続ける（起動・停止は止めない）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { pidAlive } from './net';

/** devServer.ts の runId（`${path.basename(root)}-${Date.now()}`）の形 */
export const RUN_FILE_RE = /^[^/\\\0]{1,200}-\d{13}\.jsonl$/;
const PROBE_BYTES = 64 * 1024;
export const EMPTY_GRACE_MS = 10 * 60_000;

export type KeepReason =
  | 'protected' | 'not-run-file' | 'not-regular-file' | 'writer-alive' | 'owner-mismatch' | 'no-owner-record' | 'recent-empty';

export interface SpanCleanupResult {
  at: string;
  trigger: string;
  dir: string;
  /** ディレクトリごと見送った理由（リンク・実パスの不一致など）。null なら見た */
  skipped: string | null;
  removed: { name: string; bytes: number }[];
  kept: { name: string; why: KeepReason }[];
  failed: { name: string; error: string }[];
}

/** 先頭と末尾の記録から、書いた起動とプロセスを読む */
function owners(file: string, size: number): { runs: Set<string>; pids: Set<number> } {
  const runs = new Set<string>();
  const pids = new Set<number>();
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const parts: string[] = [];
    const head = Buffer.alloc(Math.min(size, PROBE_BYTES));
    fs.readSync(fd, head, 0, head.length, 0);
    parts.push(head.toString('utf8'));
    if (size > PROBE_BYTES) {
      const tail = Buffer.alloc(PROBE_BYTES);
      fs.readSync(fd, tail, 0, PROBE_BYTES, size - PROBE_BYTES);
      parts.push(tail.toString('utf8'));
    }
    for (const text of parts) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const proc = (JSON.parse(line) as { proc?: { run?: unknown; pid?: unknown } }).proc;
          if (typeof proc?.run === 'string') runs.add(proc.run);
          if (typeof proc?.pid === 'number') pids.add(proc.pid);
        } catch { /* 書きかけ・切れた行 */ }
      }
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return { runs, pids };
}

const realOrNull = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };

/**
 * 収集ファイルを整理する。`ideRoot` の `.ide-runtime/spans` だけを見る。
 * `protect` はいまの起動・引き継いだ起動のファイル（絶対パス）。
 */
export function cleanupSpanFiles(input: {
  ideRoot: string; protect: readonly (string | null | undefined)[]; trigger: string;
  /** 試験だけが差し替える（PID が生きているか） */
  alive?: (pid: number) => boolean; now?: number;
}): SpanCleanupResult {
  const runtime = path.join(input.ideRoot, '.ide-runtime');
  const dir = path.join(runtime, 'spans');
  const res: SpanCleanupResult = {
    at: new Date().toISOString(), trigger: input.trigger, dir, skipped: null, removed: [], kept: [], failed: [],
  };
  const alive = input.alive ?? pidAlive;
  const now = input.now ?? Date.now();
  try {
    for (const d of [runtime, dir]) {
      const st = fs.lstatSync(d);
      if (st.isSymbolicLink() || !st.isDirectory()) { res.skipped = `${path.basename(d)} が実在のディレクトリではありません（リンクの先は整理しません）`; return res; }
    }
  } catch (e) {
    res.skipped = (e as NodeJS.ErrnoException).code === 'ENOENT' ? '収集ファイルのディレクトリがありません' : String(e);
    return res;
  }
  const rootReal = realOrNull(input.ideRoot);
  if (!rootReal || realOrNull(dir) !== path.join(rootReal, '.ide-runtime', 'spans')) {
    res.skipped = '収集ファイルのディレクトリの実パスが、IDE の作業ディレクトリの中ではありません';
    return res;
  }
  const protect = new Set(input.protect.filter((p): p is string => !!p).map((p) => path.resolve(p)));
  let names: string[];
  try { names = fs.readdirSync(dir); } catch (e) { res.skipped = String(e); return res; }
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    if (!RUN_FILE_RE.test(name)) { res.kept.push({ name, why: 'not-run-file' }); continue; }
    if (protect.has(path.resolve(file))) { res.kept.push({ name, why: 'protected' }); continue; }
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile()) { res.kept.push({ name, why: 'not-regular-file' }); continue; }
      const runId = name.slice(0, -'.jsonl'.length);
      if (st.size === 0) {
        if (now - st.mtimeMs < EMPTY_GRACE_MS) { res.kept.push({ name, why: 'recent-empty' }); continue; }
      } else {
        const o = owners(file, st.size);
        if (!o.runs.size) { res.kept.push({ name, why: 'no-owner-record' }); continue; }
        if ([...o.runs].some((r) => r !== runId)) { res.kept.push({ name, why: 'owner-mismatch' }); continue; }
        if ([...o.pids].some((p) => alive(p))) { res.kept.push({ name, why: 'writer-alive' }); continue; }
      }
      /* 調べた後に差し替えられていないこと（同じ i-node の通常のファイル）を確かめてから消す */
      const again = fs.lstatSync(file);
      if (!again.isFile() || again.ino !== st.ino || again.dev !== st.dev) { res.kept.push({ name, why: 'not-regular-file' }); continue; }
      fs.unlinkSync(file);
      res.removed.push({ name, bytes: again.size });
    } catch (e) {
      res.failed.push({ name, error: e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e) });
    }
  }
  return res;
}
