/* =============================================================================
 * 編集 E1 — ジャーナル（06h レビュー F-04）。記録の形・状態の遷移・復旧の判断（純粋な規則）と、読み出し。
 * 書き込みは fsio.writeJsonAtomic を通す（このモジュールは書かない）。
 *
 * 状態（1つの適用・取り消しにつき1つのジャーナル）
 *   prepared  : 照合をすべて通した。対象のファイルにも一時ファイルにも、まだ何もしていない
 *   applying  : これから一時ファイルを作り rename する（この記録を書いてから一時ファイルを作る）。
 *               対象のファイルは「適用前」か「適用後」のどちらか（rename は原子的）
 *   committed : rename の後、読み直した内容が書いた内容と一致した。**終わり。復旧の対象にしない**
 *   failed    : 書いていない／書いたが確かめられない／復旧で戻した。**終わり。復旧の対象にしない**
 * 遷移: prepared → applying | failed、applying → committed | failed。それ以外は例外（記録を壊さない）。
 *
 * 復旧（起動時など）の対象は、**持ち主のプロセスが生きていない** prepared・applying だけ（planRecovery）。
 * 確定していない適用は残さない（適用後の内容なら適用前へ戻す）。外部の変更が混ざっていれば書かない。
 *
 * ジャーナルにはソースの本文を写さない（ハッシュ・範囲・token だけ）。適用前の内容は、
 * 「いまの内容が適用後の内容とバイト一致する」ときに、範囲の token を戻して作り直す（patch.unpatchToken）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { SHA256_RE } from './revision';
import { checkRelShape } from './scope';
import type { ElementFingerprint } from './target';

export type JournalState = 'prepared' | 'applying' | 'committed' | 'failed';
export const JOURNAL_STATES: readonly JournalState[] = ['prepared', 'applying', 'committed', 'failed'];
export const TERMINAL_STATES: readonly JournalState[] = ['committed', 'failed'];
const TRANSITIONS: Record<JournalState, readonly JournalState[]> = {
  prepared: ['applying', 'failed'],
  applying: ['committed', 'failed'],
  committed: [],
  failed: [],
};
export const canTransition = (from: JournalState, to: JournalState): boolean => TRANSITIONS[from]?.includes(to) ?? false;

export const TX_ID_RE = /^tx-[0-9]{14}-[0-9a-f]{8}$/;
export const journalName = (txId: string) => `${txId}.json`;
export const verificationName = (txId: string) => `${txId}.verification.json`;

export type FileState = 'at-before' | 'at-after' | 'other' | 'missing' | 'outside-scope';

export interface JournalRecord {
  v: 1;
  txId: string;
  kind: 'apply' | 'revert';
  /** 取り消しなら、取り消した適用 */
  revertOf: string | null;
  state: JournalState;
  projectRoot: string;
  file: string;
  /** 持ち主。`start` は E2 から（プロセスの開始時刻 `<boot_id>:<tick>`。PID の再利用を見分ける）。E1.1 の記録には無い */
  owner: { pid: number; host: string; start?: string };
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  beforeHash: string;
  afterHash: string;
  beforeRev: string;
  afterRev: string;
  /** 書き換えた token の位置（書く前の内容のオフセット）と前後の token */
  range: { start: number; end: number };
  change: { from: string; to: string };
  tempName: string;
  target: {
    anchorId: string; line: number; col: number; tag: string; component: string | null;
    /** 適用後の要素の指紋（ハッシュだけ。E2 の選択の引き継ぎ — docs/07d 3.3 — で使う） */
    fingerprint: string; afterFingerprint: Pick<ElementFingerprint, 'hash' | 'structureHash'> | null;
  } | null;
  draftId: string | null;
  diffHash: string | null;
  /** サーバー側で決めた、検証で確かめる計算済みスタイル（幅の名前 → プロパティ → 値） */
  expect: Record<string, Record<string, string>> | null;
  failure: { reason: string; detail: string; written: boolean | 'unknown'; fileState: FileState | null } | null;
  recovery: { at: string; action: string; fileState: FileState; tempName?: string; state?: 'restoring' | 'done'; detail?: string } | null;
  needsAttention: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const REV_RE = /^[0-9a-f]{16}$/;

/** ジャーナルを読んだものの形を確かめる。合わなければ null（**合わない記録に従って書かない**） */
export function parseJournal(v: unknown): JournalRecord | null {
  if (!isObj(v) || v.v !== 1) return null;
  if (!isStr(v.txId) || !TX_ID_RE.test(v.txId)) return null;
  if (v.kind !== 'apply' && v.kind !== 'revert') return null;
  if (v.revertOf !== null && !(isStr(v.revertOf) && TX_ID_RE.test(v.revertOf))) return null;
  if (!JOURNAL_STATES.includes(v.state as JournalState)) return null;
  if (!isStr(v.projectRoot) || !path.isAbsolute(v.projectRoot)) return null;
  if (!isStr(v.file) || checkRelShape(v.file) !== null) return null;
  if (!isObj(v.owner) || !isInt(v.owner.pid) || !isStr(v.owner.host)) return null;
  if (v.owner.start !== undefined && !(isStr(v.owner.start) && /^[0-9a-f-]{36}:[0-9]{1,20}$/.test(v.owner.start))) return null;
  for (const k of ['beforeHash', 'afterHash'] as const) if (!isStr(v[k]) || !SHA256_RE.test(v[k] as string)) return null;
  for (const k of ['beforeRev', 'afterRev'] as const) if (!isStr(v[k]) || !REV_RE.test(v[k] as string)) return null;
  if (!isObj(v.range) || !isInt(v.range.start) || !isInt(v.range.end) || (v.range.end as number) < (v.range.start as number)) return null;
  if (!isObj(v.change) || !isStr(v.change.from) || !isStr(v.change.to)) return null;
  if (!isStr(v.tempName)) return null;
  if (!isStr(v.createdAt) || !isStr(v.updatedAt)) return null;
  if (v.target !== null && !(isObj(v.target) && isStr(v.target.anchorId) && /^[0-9a-f]{10}$/.test(v.target.anchorId)
    && isInt(v.target.line) && isInt(v.target.col) && isStr(v.target.tag) && isStr(v.target.fingerprint))) return null;
  if (v.expect !== null && !(isObj(v.expect) && Object.values(v.expect).every((x) => isObj(x) && Object.values(x).every(isStr)))) return null;
  /* E1.1: 一時ファイルの名前は、このジャーナルの txId と書き込み先の名前から決まるものだけ（書き換えた記録で、別の適用の
   * 一時ファイル・退避リンクを消させない）。復旧の一時ファイルも同じ規則（-r<n>） */
  const tempOf = (suffix: string) => `.${path.posix.basename(v.file as string)}.vcide-edit-${v.txId as string}${suffix}.tmp`;
  if (!isStr(v.tempName) || v.tempName !== tempOf('')) return null;
  if (v.recovery !== null && v.recovery !== undefined) {
    if (!isObj(v.recovery)) return null;
    const rt = v.recovery.tempName;
    if (rt !== undefined && !(isStr(rt) && /-r[0-9]{1,6}\.tmp$/.test(rt) && rt === tempOf(rt.slice(rt.lastIndexOf('-r'), -4)))) return null;
  }
  return v as unknown as JournalRecord;
}

/** 状態を進めた新しい記録（元の記録は変えない）。許されない遷移は例外 */
export function transition(j: JournalRecord, to: JournalState, now: string, patch: Partial<JournalRecord> = {}): JournalRecord {
  if (!canTransition(j.state, to)) throw new Error(`illegal journal transition: ${j.state} → ${to}`);
  return { ...j, ...patch, state: to, updatedAt: now };
}

export type RecoveryPlan =
  | { kind: 'none'; why: 'terminal' | 'owner-alive' }
  | { kind: 'mark-failed'; why: string }
  | { kind: 'restore-before'; why: string }
  | { kind: 'refuse'; why: string };

/**
 * 復旧の判断（**純粋な規則**。docs/08a 第3.4節の表）。
 * @param fileState いまの対象のファイルの内容が、ジャーナルの適用前・適用後のどちらか
 * @param ownerAlive 持ち主のプロセスが生きている（またはこのプロセスで進行中）
 */
export function planRecovery(j: Pick<JournalRecord, 'state'>, fileState: FileState, ownerAlive: boolean): RecoveryPlan {
  if (TERMINAL_STATES.includes(j.state)) return { kind: 'none', why: 'terminal' };
  if (ownerAlive) return { kind: 'none', why: 'owner-alive' };
  if (j.state === 'prepared') return { kind: 'mark-failed', why: '照合の後・書き込みの前に止まった（何も書いていない）' };
  /* applying */
  if (fileState === 'at-before') return { kind: 'mark-failed', why: 'rename の前に止まった（対象は適用前のまま）' };
  if (fileState === 'at-after') return { kind: 'restore-before', why: '書いた後・確定の記録の前に止まった（確定していない適用は残さない）' };
  return { kind: 'refuse', why: '止まった後に外部の変更が入ったか、ファイルが無い・範囲の外。書かずに要確認' };
}

/** このプロジェクトのジャーナルの一覧（読むだけ）。形の合わないものは unreadable として返す */
export function listJournals(dir: string): { records: JournalRecord[]; unreadable: string[] } {
  const records: JournalRecord[] = [];
  const unreadable: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => /^tx-[0-9]{14}-[0-9a-f]{8}\.json$/.test(n)); } catch { return { records, unreadable }; }
  for (const n of names.sort()) {
    const j = readJournalFile(path.join(dir, n));
    if (j && journalName(j.txId) === n) records.push(j); else unreadable.push(n);
  }
  return { records, unreadable };
}

export function readJournalFile(file: string): JournalRecord | null {
  try { return parseJournal(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}
