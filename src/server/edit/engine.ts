/* =============================================================================
 * 編集 E1 — 安全なコード変更の基盤（エンジン）。今後の編集機能（E2〜E10）が共通に使う、唯一の変更の入口。
 *
 * 流れ（1ファイル・1トークン）
 *   resolveTarget(DOM の選択)            第1段の照合: 探索の7段（anchors.resolveSelection。DOM の版＝対応表の版＝ファイルの版）
 *                                        ＋ 書き込み範囲（scope）＋ 自分で読み直した内容の版 ＋ 内容の指紋（target）
 *   createDraft(対象, DOM の選択, 変更)   第2段の照合: 同じ照合をいまの内容でやり直す。変更の検証（validation）・差分（patch）
 *                                        ファイルには触れない
 *   apply({ changes: [下書き1件] })       第3段の照合: 同じ照合をもう一度。確認した差分のハッシュ。ジャーナル（journal）を
 *                                        prepared → applying と書いてから、書き込みの唯一の入口（fsio.replaceSourceFile）で置き換え、
 *                                        読み直して committed（または failed）
 *   submitVerification(報告)             適用結果の検証の契約（verification）。success = committed かつ verified
 *   revert(txId)                         いまの内容が適用直後の内容とバイト一致するときだけ戻す（それ自体も1つの適用として記録）
 *   recover()                            持ち主のいない prepared・applying だけを、仕様（journal.planRecovery）どおりに片付ける
 *
 * 既定で無効: 書き込み（apply・revert・recover の書き込み）は VCIDE_EDIT_E1_WRITE=1 のときだけ。
 * 画面・API の入口は無い（E4 まで作らない — docs/07d 第5節）。探索のモジュールは読むだけで、変えない。
 * ========================================================================== */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anchorSupport, resolveSelection, sourceRevisionsOf } from '../anchors';
import { runtimeDir } from '../ide';
import { parseSelection } from '../../lib/previewProtocol';
import {
  CLOCK_SKEW_MS, EDIT_WRITE_ENV, editWritesEnabled, JOURNAL_RETENTION_MS, MAX_VERIFICATION_AGE_MS, REQUIRED_VIEWPORTS, TEMP_MARK,
  type RequiredViewport,
} from './config';
import {
  acquireLock, cleanupRecordedArtifacts, pidAlive, recordedArtifactsPresent, removeRecord, replaceSourceFile,
  snapshotNameOf, writeJsonAtomic, type WriteStep,
} from './fsio';
import {
  journalName, listJournals, planRecovery, readJournalFile, TERMINAL_STATES, transition, TX_ID_RE, verificationName,
  type FileState, type JournalRecord,
} from './journal';
import { diffHashOf, patchToken, unifiedDiff, unpatchToken } from './patch';
import { identify, identifyText, type ContentIdentity } from './revision';
import { resolveWritable, type WritableFile } from './scope';
import { CLASS_REFUSAL_TEXT, inspectElementAt, type ElementFingerprint, type ElementInfo } from './target';
import { locateToken, parseChange, type ChangeRefusal, type ClassTokenChange } from './validation';
import { evaluateVerification, parseVerificationReport, type VerificationResult } from './verification';

export { EDIT_WRITE_ENV, editWritesEnabled };

export type Stage = 'resolve' | 'draft' | 'apply';
export type RefusalReason =
  | 'bad-request' | 'target-unresolved' | 'target-unknown' | 'target-moved' | 'source-changed' | 'element-mismatch'
  | 'outside-scope' | 'unsupported-encoding' | 'verifier-unavailable' | 'draft-unknown' | 'diff-not-reviewed' | 'patch-invariant'
  | ChangeRefusal;

export interface Refusal {
  ok: false; stage: Stage; reason: RefusalReason; detail: string;
  /** 利用者に要素の選び直しを求めるべきか */
  reselect: boolean;
  written: false;
  anchorReason?: string; scopeReason?: string; classReason?: string;
}

export interface TargetView {
  id: string; file: string; anchorId: string; line: number; col: number; tag: string; component: string | null;
  /** 照合した版（DOM の data-vcide-rev ＝ 対応表の rev ＝ 読み直したファイルの版） */
  sourceRev: string; domRev: string; manifestRev: string;
  /** 照合した内容の sha256 */
  contentHash: string;
  /** 内容の指紋（位置に依らない同一性） */
  fingerprint: string; structureHash: string;
  classTokens: string[] | null;
  /** className を書き換えられない理由（書き換えられるなら null） */
  classReason: string | null;
  resolvedAt: string;
}

export interface DraftView {
  id: string; targetId: string; file: string; change: ClassTokenChange;
  /** 書き換える token の位置（1始まりの行・列） */
  tokenLine: number; tokenCol: number;
  beforeRev: string; afterRev: string; baseContentHash: string; afterContentHash: string;
  diff: string; diffHash: string; createdAt: string;
}

/**
 * committed の結果が**保証すること・しないこと**（E1.1。docs/08b 第3.5節）。committed は「競合が無かった」ことの保証ではない。
 */
export interface CommitAssurance {
  /** 置き換えた元の実体（退避リンク）が、照合した inode で、内容が確認した差分の基準とバイト一致した（rename の**後**に確かめた） */
  displacedOriginalVerified: true;
  /** 書いた後に読み直した内容が、書いた内容とバイト一致した */
  readBackVerified: true;
  /** 検査したディレクトリの実体を固定して操作した（Linux の /proc/self/fd）。false はパスで操作し、事後に確かめた */
  directoryPinned: boolean;
  /** この結果では検出できない競合の種類（**これらが起きていないことは保証しない**） */
  undetectable: readonly UndetectableRace[];
}
export type UndetectableRace =
  /** 退避リンクと rename の間（連続する2つの系呼び出しの間）に、外部が別のファイルを rename で置き換える形で保存した */
  | 'replace-save-between-link-and-rename'
  /** 置き換えの前から書き込み先を開いていた外部のプロセスが、照合の後にその fd で書いた */
  | 'write-through-descriptor-opened-before-replace'
  /** 確定の後に外部が書いた（committed は確定の時点の事実。いまの内容は outcome・検証で確かめる） */
  | 'external-write-after-commit';
export const COMMIT_UNDETECTABLE: readonly UndetectableRace[] = [
  'replace-save-between-link-and-rename', 'write-through-descriptor-opened-before-replace', 'external-write-after-commit',
];

/**
 * 適用・取り消しの結果（E1.1 で uncertain を分けた。docs/08b 第3.5節）。
 *   committed : 書いて確かめた（CommitAssurance の範囲で）。**検証（verified）はまだ**。成功とは呼ばない
 *   refused   : 書いていない（形・範囲・無効・下書き）
 *   conflict  : 書いていない。外部の変更を見つけた。transient: true は「置き換えた直後に外部の変更を見つけ、外部の版へ戻した」
 *               （ごく短い間だけ自分の内容が書き込み先にあった）。kept は要確認で残したファイル
 *   busy      : 書いていない。別の適用・取り消し・復旧が鍵を持っている
 *   failed    : 書いていない（ジャーナルを書けない・一時ファイルを作れない 等）
 *   uncertain : 書いた、または書いたかどうか確かめられない。**成功扱いにしない・取り消しの対象にしない・要確認**
 */
export type ApplyResult =
  | { status: 'committed'; written: true; txId: string; kind: 'apply' | 'revert'; file: string;
    beforeRev: string; afterRev: string; beforeHash: string; afterHash: string; verification: 'pending'; assurance: CommitAssurance }
  | { status: 'refused' | 'conflict' | 'busy'; written: false; reason: string; detail: string; stage?: Stage; reselect?: boolean;
    anchorReason?: string; txId?: string; transient?: true; kept?: string[]; needsAttention?: boolean }
  | { status: 'failed'; written: false; reason: string; detail: string; txId?: string; fileState?: FileState | null;
    needsAttention: boolean }
  | { status: 'uncertain'; written: true | 'unknown'; reason: string; detail: string; txId?: string; fileState?: FileState | null;
    needsAttention: true; kept?: string[] };

export interface RecoveryEntry {
  txId: string | null; file?: string; state?: string; action: string; why: string; wrote: boolean; fileState?: FileState; removedTemps?: number;
}
export interface RecoveryReport { status: 'done' | 'dry-run' | 'busy'; entries: RecoveryEntry[]; pruned: string[] }

export interface Outcome {
  txId: string; write: string; kind: string | null;
  verification: 'pending' | 'verified' | 'not-verified';
  /** 成功 = 書き込みが committed かつ 検証が verified */
  success: boolean;
  /** 検証の後にファイルが変わったか（verified のときだけ意味を持つ） */
  staleSinceVerification: boolean;
}

export interface EditEngineOptions {
  projectRoot: string;
  /** ジャーナルの置き場所。既定は IDE の .ide-runtime/edit-journal/<プロジェクトの鍵>。**対象プロジェクトの中は不可** */
  journalDir?: string;
  requiredViewports?: readonly RequiredViewport[];
  maxVerificationAgeMs?: number;
  journalRetentionMs?: number;
  clock?: () => number;
  /** 試験用: 段ごとに呼ぶ（製品の呼び出しは渡さない） */
  hooks?: { step?: (name: string, info: { txId?: string }) => void };
}

interface TargetRecord {
  id: string; anchorId: string; file: string; line: number; col: number; tag: string; component: string | null;
  sourceRev: string; domRev: string; manifestRev: string; contentHash: string; fingerprint: ElementFingerprint;
  classTokens: string[] | null; classReason: string | null; resolvedAt: string;
}
interface DraftRecord extends DraftView { next: string; range: { start: number; end: number }; afterFingerprint: ElementFingerprint }

/** このプロセスで進行中の適用（同じプロセスの別のエンジンの復旧が、進行中の適用を巻き戻さないため） */
const IN_FLIGHT = new Set<string>();
const MAX_HELD = 200;

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const REFUSAL_TEXT: Partial<Record<RefusalReason, string>> = {
  'target-moved': '選んだ要素の位置が、照合した対象と違います（コードが変わって行・列がずれた可能性があります）。推測で付け替えません。要素を選び直してください。',
  'source-changed': '選んだ時点の後に、このファイルが変わりました。選んだ時点の版でない内容には書き込みません。プレビューの再描画を待ってから、要素を選び直してください。',
  'element-mismatch': '同じ位置にある要素が、選んだ要素と内容が違います（別の要素が来た可能性があります）。書き込みません。要素を選び直してください。',
  'unsupported-encoding': 'このファイルは UTF-8 として往復できない内容を含むため、扱いません。',
  'target-unknown': 'この対象は、このエンジンで照合していません。要素を選び直してください。',
  'draft-unknown': 'この下書きは無いか、すでに適用しました。',
  'diff-not-reviewed': '確認した差分と、いまの下書きの差分が一致しません。差分を確認し直してください。',
  'patch-invariant': '変更の結果を確かめられません（token の外が変わる・要素の構造が変わる）。書き込みません。',
};

export class EditEngine {
  readonly root: string;
  readonly journalDir: string;
  readonly #viewports: readonly RequiredViewport[];
  readonly #maxAge: number;
  readonly #retention: number;
  readonly #clock: () => number;
  readonly #hooks: EditEngineOptions['hooks'];
  readonly #targets = new Map<string, TargetRecord>();
  readonly #drafts = new Map<string, DraftRecord>();

  constructor(opts: EditEngineOptions) {
    this.root = fs.realpathSync(path.resolve(opts.projectRoot));
    const key = createHash('sha1').update(this.root).digest('hex').slice(0, 12);
    this.journalDir = path.resolve(opts.journalDir ?? path.join(runtimeDir(), 'edit-journal', key));
    let realJ = this.journalDir;
    try { realJ = fs.realpathSync(this.journalDir); } catch { /* まだ無い */ }
    const inside = (p: string) => { const r = path.relative(this.root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
    if (inside(this.journalDir) || inside(realJ)) {
      throw new Error(`編集のジャーナルを対象プロジェクトの中に置けません: ${this.journalDir}`);
    }
    this.#viewports = opts.requiredViewports ?? REQUIRED_VIEWPORTS;
    this.#maxAge = opts.maxVerificationAgeMs ?? MAX_VERIFICATION_AGE_MS;
    this.#retention = opts.journalRetentionMs ?? JOURNAL_RETENTION_MS;
    this.#clock = opts.clock ?? Date.now;
    this.#hooks = opts.hooks;
  }

  /* ------------------------------------------------------------ 共通 */
  #now(): string { return new Date(this.#clock()).toISOString(); }
  #step(name: string, txId?: string): void { this.#hooks?.step?.(name, { txId }); }
  #refuse(stage: Stage, reason: RefusalReason, detail: string | null, reselect: boolean, extra: Partial<Refusal> = {}): Refusal {
    return { ok: false, stage, reason, detail: detail ?? REFUSAL_TEXT[reason] ?? reason, reselect, written: false, ...extra };
  }
  #hold<T>(m: Map<string, T>, id: string, v: T): void {
    m.set(id, v);
    while (m.size > MAX_HELD) m.delete(m.keys().next().value as string);
  }
  #read(w: WritableFile): ContentIdentity | null {
    try { return identify(fs.readFileSync(w.abs)); } catch { return null; }
  }
  #inspect(text: string, file: string, line: number, col: number): ElementInfo | null | 'unavailable' {
    try { return inspectElementAt(text, file, line, col); } catch { return 'unavailable'; }
  }

  /**
   * 照合（第1〜3段で同じもの）。対象を選んだ時点の版・内容・指紋と、いまの DOM の選択・対応表・ファイルの内容が
   * すべて一致するときだけ通す。版が変わっていれば、その位置の要素が同じ要素か（構造と className）で理由を分ける。
   */
  #check(t: TargetRecord, selection: unknown, stage: Stage):
    { ok: true; writable: WritableFile; identity: ContentIdentity; element: ElementInfo } | Refusal {
    const sel = parseSelection(selection);
    if (!sel) return this.#refuse(stage, 'bad-request', '選択の形が正しくありません（製品のプレビューの選択の形。版を含む）。', false);
    const res = resolveSelection(this.root, anchorSupport(this.root), sel);
    if (res.status !== 'resolved') return this.#refuse(stage, 'target-unresolved', res.detail, true, { anchorReason: res.reason });
    const a = res.anchor;
    if (a.id !== t.anchorId || a.file !== t.file || a.line !== t.line || a.col !== t.col || a.tag !== t.tag || a.component !== t.component) {
      return this.#refuse(stage, 'target-moved', null, true);
    }
    const w = resolveWritable(this.root, a.file);
    if (!w.ok) return this.#refuse(stage, 'outside-scope', w.detail, false, { scopeReason: w.reason });
    const id = this.#read(w.file);
    if (!id) return this.#refuse(stage, 'unsupported-encoding', null, false);
    const el = this.#inspect(id.text, a.file, a.line, a.col);
    if (el === 'unavailable') return this.#refuse(stage, 'verifier-unavailable', '構文解析器（typescript）を読み込めないため照合できません。', false);
    if (a.rev !== t.sourceRev || id.rev !== t.sourceRev || id.contentHash !== t.contentHash) {
      const same = el && el.tag === t.tag && el.component === t.component
        && el.fingerprint.structureHash === t.fingerprint.structureHash && el.fingerprint.classLiteral === t.fingerprint.classLiteral;
      return this.#refuse(stage, same ? 'source-changed' : 'element-mismatch', null, true);
    }
    if (!el || el.fingerprint.hash !== t.fingerprint.hash) return this.#refuse(stage, 'element-mismatch', null, true);
    return { ok: true, writable: w.file, identity: id, element: el };
  }

  #targetView(t: TargetRecord): TargetView {
    const { fingerprint, ...rest } = t;
    return { ...rest, fingerprint: fingerprint.hash, structureHash: fingerprint.structureHash };
  }

  /* ------------------------------------------------------------ 第1段 */
  /** DOM の選択から編集対象を解決する（読むだけ） */
  resolveTarget(selection: unknown): { ok: true; target: TargetView } | Refusal {
    const sel = parseSelection(selection);
    if (!sel) return this.#refuse('resolve', 'bad-request', '選択の形が正しくありません（製品のプレビューの選択の形。版を含む）。', false);
    const res = resolveSelection(this.root, anchorSupport(this.root), sel);
    if (res.status !== 'resolved') return this.#refuse('resolve', 'target-unresolved', res.detail, true, { anchorReason: res.reason });
    const a = res.anchor;
    const w = resolveWritable(this.root, a.file);
    if (!w.ok) return this.#refuse('resolve', 'outside-scope', w.detail, false, { scopeReason: w.reason });
    const id = this.#read(w.file);
    if (!id) return this.#refuse('resolve', 'unsupported-encoding', null, false);
    if (id.rev !== a.rev || sel.anchorRev !== a.rev) return this.#refuse('resolve', 'source-changed', null, true);
    const el = this.#inspect(id.text, a.file, a.line, a.col);
    if (el === 'unavailable') return this.#refuse('resolve', 'verifier-unavailable', '構文解析器（typescript）を読み込めないため照合できません。', false);
    if (!el || el.tag !== a.tag || el.component !== a.component) return this.#refuse('resolve', 'element-mismatch', null, true);
    const t: TargetRecord = {
      id: `t-${randomBytes(6).toString('hex')}`, anchorId: a.id, file: a.file, line: a.line, col: a.col, tag: a.tag, component: a.component,
      sourceRev: a.rev, domRev: sel.anchorRev as string, manifestRev: a.rev, contentHash: id.contentHash, fingerprint: el.fingerprint,
      classTokens: el.className.kind === 'literal' ? el.className.tokens.map((x) => x.text) : null,
      classReason: el.className.kind === 'literal' ? null : CLASS_REFUSAL_TEXT[el.className.reason],
      resolvedAt: this.#now(),
    };
    this.#hold(this.#targets, t.id, t);
    return { ok: true, target: this.#targetView(t) };
  }

  /** 解決済みの対象を、新しい DOM の選択で確かめ直す（E1 は版の引き継ぎをしない。違えば再選択を求める — 07d 3.3 は E2） */
  reresolveTarget(targetId: string, selection: unknown): { ok: true; target: TargetView } | Refusal {
    const t = this.#targets.get(targetId);
    if (!t) return this.#refuse('resolve', 'target-unknown', null, true);
    const c = this.#check(t, selection, 'resolve');
    return c.ok ? { ok: true, target: this.#targetView(t) } : c;
  }

  /* ------------------------------------------------------------ 第2段 */
  /** 下書き（ファイルに触れない）。照合をやり直し、変更を検証し、差分を作る */
  createDraft(targetId: string, selection: unknown, change: unknown): { ok: true; draft: DraftView } | Refusal {
    const t = this.#targets.get(targetId);
    if (!t) return this.#refuse('draft', 'target-unknown', null, true);
    const c = this.#check(t, selection, 'draft');
    if (!c.ok) return c;
    const pc = parseChange(change);
    if (!pc.ok) return this.#refuse('draft', pc.reason, pc.detail, false);
    const loc = locateToken(c.element.className, pc.change);
    if (!loc.ok) {
      return this.#refuse('draft', loc.reason, loc.classReason ? `${loc.detail}: ${CLASS_REFUSAL_TEXT[loc.classReason]}` : loc.detail, false,
        loc.classReason ? { classReason: loc.classReason } : {});
    }
    const { text, contentHash, rev } = c.identity;
    let next: string;
    try { next = patchToken(text, { start: loc.start, end: loc.end }, pc.change.from, pc.change.to); } catch {
      return this.#refuse('draft', 'patch-invariant', null, false);
    }
    /* 変更の後も、同じ位置に同じ要素があり、変わったのは token 1つだけであることを確かめる */
    const after = this.#inspect(next, t.file, t.line, t.col);
    const want = loc.tokens.map((x) => (x === pc.change.from ? pc.change.to : x));
    if (!after || after === 'unavailable' || after.tag !== t.tag || after.component !== t.component
      || after.fingerprint.structureHash !== t.fingerprint.structureHash || after.className.kind !== 'literal'
      || JSON.stringify(after.className.tokens.map((x) => x.text)) !== JSON.stringify(want)) {
      return this.#refuse('draft', 'patch-invariant', null, false);
    }
    const ai = identifyText(next);
    const diff = unifiedDiff(t.file, text, next);
    const lines = text.slice(0, loc.start).split('\n');
    const d: DraftRecord = {
      id: `d-${randomBytes(6).toString('hex')}`, targetId: t.id, file: t.file, change: pc.change,
      tokenLine: lines.length, tokenCol: lines[lines.length - 1].length + 1,
      beforeRev: rev, afterRev: ai.rev, baseContentHash: contentHash, afterContentHash: ai.contentHash,
      diff, diffHash: diffHashOf(diff, contentHash, ai.contentHash), createdAt: this.#now(),
      next, range: { start: loc.start, end: loc.end }, afterFingerprint: after.fingerprint,
    };
    this.#hold(this.#drafts, d.id, d);
    const { next: _n, range: _r, afterFingerprint: _f, ...view } = d;
    return { ok: true, draft: view };
  }

  /* ------------------------------------------------------------ 第3段 */
  /** 適用。E1 は1ファイル・1トークンの変更1件だけ（複数は拒否 — F-03） */
  apply(req: unknown): ApplyResult {
    const refused = (reason: string, detail: string, extra: Record<string, unknown> = {}): ApplyResult =>
      ({ status: 'refused', written: false, reason, detail, ...extra });
    if (!editWritesEnabled()) return refused('edit-disabled', `編集の書き込みは無効です（${EDIT_WRITE_ENV}=1 を明示したときだけ有効）。ファイルは変更していません。`);
    if (!isObj(req) || !Object.keys(req).every((k) => ['changes', 'expect'].includes(k)) || !Array.isArray(req.changes)
      || !req.changes.every((c) => isObj(c) && Object.keys(c).every((k) => ['draftId', 'reviewedDiffHash', 'selection'].includes(k)))) {
      return refused('bad-request', '適用の要求の形が正しくありません。');
    }
    const changes = req.changes as { draftId?: unknown; reviewedDiffHash?: unknown; selection?: unknown }[];
    if (changes.length === 0) return refused('bad-request', '適用する変更がありません。');
    if (changes.length > 1) {
      const files = new Set(changes.map((c) => (typeof c.draftId === 'string' ? this.#drafts.get(c.draftId)?.file ?? `?${c.draftId}` : '?')));
      return files.size > 1
        ? refused('multi-file-unsupported', `E1 は1ファイルの変更だけを扱います（要求は ${files.size} ファイル）。複数ファイルの変更は書き込みません。`)
        : refused('multi-change-unsupported', `E1 は1トークンの変更1件だけを扱います（要求は ${changes.length} 件）。書き込みません。`);
    }
    const expect = this.#parseExpect(req.expect);
    if (expect === false) return refused('bad-request', '検証で期待する値（expect）の形が正しくありません。');
    const c = changes[0];
    const d = typeof c.draftId === 'string' ? this.#drafts.get(c.draftId) : undefined;
    if (!d) return refused('draft-unknown', REFUSAL_TEXT['draft-unknown'] as string);
    if (c.reviewedDiffHash !== d.diffHash) return refused('diff-not-reviewed', REFUSAL_TEXT['diff-not-reviewed'] as string);
    const t = this.#targets.get(d.targetId);
    if (!t) return refused('target-unknown', REFUSAL_TEXT['target-unknown'] as string, { reselect: true });
    /* E1.1: 第3段の照合は鍵を持ってから行う（別の適用が置き換えの途中なら、照合の結果ではなく busy を返す） */
    const unlock = acquireLock(this.journalDir);
    if (!unlock) return { status: 'busy', written: false, reason: 'busy', detail: '別の適用・取り消し・復旧が進行中です。' };
    try {
      const chk = this.#check(t, c.selection, 'apply');
      if (!chk.ok) {
        const conflict = chk.reason === 'source-changed' || chk.reason === 'element-mismatch';
        return { status: conflict ? 'conflict' : 'refused', written: false, reason: chk.reason, detail: chk.detail, stage: 'apply', reselect: chk.reselect, ...(chk.anchorReason ? { anchorReason: chk.anchorReason } : {}) };
      }
      if (chk.identity.contentHash !== d.baseContentHash) {
        return { status: 'conflict', written: false, reason: 'external-change', detail: '下書きを作った後に、このファイルが変わりました。上書きしません。', stage: 'apply', reselect: true };
      }
      const r = this.#write({
        kind: 'apply', revertOf: null, file: d.file, w: chk.writable, beforeHash: d.baseContentHash, afterHash: d.afterContentHash,
        beforeRev: d.beforeRev, afterRev: d.afterRev, range: d.range, change: d.change, next: d.next,
        target: { anchorId: t.anchorId, line: t.line, col: t.col, tag: t.tag, component: t.component, fingerprint: t.fingerprint.hash,
          afterFingerprint: { hash: d.afterFingerprint.hash, structureHash: d.afterFingerprint.structureHash } },
        draftId: d.id, diffHash: d.diffHash, expect,
      });
      if (r.status === 'committed') this.#drafts.delete(d.id);
      return r;
    } finally { unlock(); }
  }

  #parseExpect(v: unknown): Record<string, Record<string, string>> | null | false {
    if (v === undefined || v === null) return null;
    if (!isObj(v)) return false;
    const names = this.#viewports.map((x) => x.name);
    for (const [k, x] of Object.entries(v)) {
      if (!names.includes(k) || !isObj(x) || !Object.entries(x).every(([p, s]) => /^[a-z-]{1,60}$/.test(p) && typeof s === 'string' && s.length <= 200)) return false;
    }
    return v as Record<string, Record<string, string>>;
  }

  #newTxId(): string {
    const d = new Date(this.#clock());
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    return `tx-${ts}-${randomBytes(4).toString('hex')}`;
  }

  #writeJournal(j: JournalRecord): void { writeJsonAtomic(this.journalDir, journalName(j.txId), j); }

  /** ジャーナルを書きながら、1ファイルを書き換える（適用・取り消しで共通） */
  #write(p: {
    kind: 'apply' | 'revert'; revertOf: string | null; file: string; w: WritableFile;
    beforeHash: string; afterHash: string; beforeRev: string; afterRev: string;
    range: { start: number; end: number }; change: { from: string; to: string }; next: string;
    target: JournalRecord['target']; draftId: string | null; diffHash: string | null; expect: JournalRecord['expect'];
  }): ApplyResult {
    const txId = this.#newTxId();
    const now = this.#now();
    let j: JournalRecord = {
      v: 1, txId, kind: p.kind, revertOf: p.revertOf, state: 'prepared', projectRoot: this.root, file: p.file,
      owner: { pid: process.pid, host: os.hostname() }, createdAt: now, updatedAt: now, committedAt: null,
      beforeHash: p.beforeHash, afterHash: p.afterHash, beforeRev: p.beforeRev, afterRev: p.afterRev,
      range: p.range, change: { from: p.change.from, to: p.change.to }, tempName: `.${path.basename(p.file)}${TEMP_MARK}${txId}.tmp`,
      target: p.target, draftId: p.draftId, diffHash: p.diffHash, expect: p.expect,
      failure: null, recovery: null, needsAttention: false,
    };
    IN_FLIGHT.add(txId);
    try {
      try { this.#writeJournal(j); } catch (e) {
        return { status: 'failed', written: false, reason: 'journal-failed', detail: `ジャーナルを書けないため、書き込みません: ${String((e as Error).message).slice(0, 200)}`, needsAttention: false };
      }
      this.#step('prepared', txId);
      j = transition(j, 'applying', this.#now());
      try { this.#writeJournal(j); } catch (e) {
        return { status: 'failed', written: false, reason: 'journal-failed', detail: `ジャーナルを書けないため、書き込みません: ${String((e as Error).message).slice(0, 200)}`, txId, needsAttention: false };
      }
      this.#step('applying', txId);
      const r = replaceSourceFile({
        projectRoot: this.root, rel: p.file, expectedHash: p.beforeHash, next: p.next, tempName: j.tempName, identity: p.w,
        hooks: { step: (s: WriteStep) => this.#step(s, txId) },
      });
      if (r.status === 'replaced') {
        const at = this.#now();
        try {
          j = transition(j, 'committed', at, { committedAt: at });
          this.#writeJournal(j);
        } catch (e) {
          return { status: 'uncertain', written: true, reason: 'journal-commit-failed', txId, needsAttention: true, fileState: 'at-after',
            detail: `書き込みましたが、確定の記録を書けません（次の復旧で適用前へ戻します）: ${String((e as Error).message).slice(0, 200)}` };
        }
        this.#step('committed', txId);
        return { status: 'committed', written: true, txId, kind: p.kind, file: p.file, beforeRev: p.beforeRev, afterRev: p.afterRev,
          beforeHash: p.beforeHash, afterHash: p.afterHash, verification: 'pending',
          assurance: { displacedOriginalVerified: true, readBackVerified: true, directoryPinned: r.pinned, undetectable: COMMIT_UNDETECTABLE } };
      }
      const fileState = this.#fileState(j);
      if (r.status === 'not-written') {
        j = transition(j, 'failed', this.#now(), {
          failure: { reason: r.reason, detail: r.detail, written: false, fileState },
          needsAttention: fileState !== 'at-before' || !!r.tempLeft,
        });
        try { this.#writeJournal(j); } catch { /* 次の復旧で applying・適用前として片付く */ }
        const status = r.reason === 'external-change' || r.reason === 'identity-changed' ? 'conflict' : r.reason === 'outside-scope' ? 'refused' : 'failed';
        return status === 'failed'
          ? { status, written: false, reason: r.reason, detail: r.detail, txId, fileState, needsAttention: j.needsAttention }
          : { status, written: false, reason: r.reason, detail: r.detail, txId };
      }
      if (r.status === 'conflict-restored') {
        /* 置き換えた直後に外部の変更を見つけ、外部の版へ戻した: 自分の変更は残っていない（書き込み先は外部の版） */
        const attention = r.kept.length > 0;
        j = transition(j, 'failed', this.#now(), {
          failure: { reason: r.reason, detail: r.detail, written: false, fileState }, needsAttention: attention,
        });
        try { this.#writeJournal(j); } catch { /* 次の復旧で applying として判断する（外部の版は at-before でも at-after でもないので書かない） */ }
        return { status: 'conflict', written: false, transient: true, reason: r.reason, detail: r.detail, txId, reselect: true,
          kept: r.kept, needsAttention: attention };
      }
      j = transition(j, 'failed', this.#now(), {
        failure: { reason: r.reason, detail: r.detail, written: r.renamed ? true : 'unknown', fileState }, needsAttention: true,
      });
      try { this.#writeJournal(j); } catch { /* 記録できなくても、結果は成功扱いにしない */ }
      return { status: 'uncertain', written: r.renamed ? true : 'unknown', reason: r.reason, detail: r.detail, txId, fileState, needsAttention: true,
        ...(r.kept && r.kept.length ? { kept: r.kept } : {}) };
    } finally { IN_FLIGHT.delete(txId); }
  }

  #fileState(j: JournalRecord): FileState {
    const w = resolveWritable(this.root, j.file);
    if (!w.ok) return w.reason === 'missing' ? 'missing' : 'outside-scope';
    const id = this.#read(w.file);
    if (!id) return 'other';
    return id.contentHash === j.beforeHash ? 'at-before' : id.contentHash === j.afterHash ? 'at-after' : 'other';
  }

  /* ------------------------------------------------------------ 取り消し */
  /** 確定した適用の取り消し。いまの内容が適用直後の内容とバイト一致するときだけ（外部変更の後は拒否 — T11） */
  revert(txId: unknown): ApplyResult {
    const refused = (reason: string, detail: string): ApplyResult => ({ status: 'refused', written: false, reason, detail });
    if (!editWritesEnabled()) return refused('edit-disabled', `編集の書き込みは無効です（${EDIT_WRITE_ENV}=1 を明示したときだけ有効）。ファイルは変更していません。`);
    if (typeof txId !== 'string' || !TX_ID_RE.test(txId)) return refused('bad-request', '適用の識別子の形が正しくありません。');
    const j = this.journal(txId);
    if (!j) return refused('tx-unknown', 'この適用の記録がありません（または記録の形が正しくありません）。');
    if (j.projectRoot !== this.root) return refused('tx-unknown', 'この適用は別のプロジェクトのものです。');
    if (j.state !== 'committed') return refused('tx-not-committed', `この適用は確定していません（${j.state}）。成否が確定しない書き込みは取り消しの対象にしません。`);
    if (j.kind !== 'apply') return refused('revert-unsupported', '取り消しの取り消し（やり直し）は E1 では扱いません。');
    /* E1.1: 取り消しの照合も鍵を持ってから行う */
    const unlock = acquireLock(this.journalDir);
    if (!unlock) return { status: 'busy', written: false, reason: 'busy', detail: '別の適用・取り消し・復旧が進行中です。' };
    try {
      if (listJournals(this.journalDir).records.some((x) => x.revertOf === txId && x.state === 'committed')) {
        return refused('already-reverted', 'この適用はすでに取り消しました。');
      }
      const w = resolveWritable(this.root, j.file);
      if (!w.ok) return refused('outside-scope', w.detail);
      const id = this.#read(w.file);
      if (!id) return refused('unsupported-encoding', REFUSAL_TEXT['unsupported-encoding'] as string);
      if (id.contentHash === j.beforeHash) return refused('already-at-before', 'ファイルはすでに適用前の内容です。書き込みません。');
      if (id.contentHash !== j.afterHash) {
        return { status: 'conflict', written: false, reason: 'changed-after-apply',
          detail: '適用の後にこのファイルが変わっています。適用前の内容に戻すと、その変更が失われるため取り消しません。' };
      }
      let before: string;
      try { before = unpatchToken(id.text, j.range.start, j.change.from, j.change.to); } catch { return refused('patch-invariant', REFUSAL_TEXT['patch-invariant'] as string); }
      const bi = identifyText(before);
      if (bi.contentHash !== j.beforeHash) return refused('patch-invariant', '適用前の内容を作り直せません（記録と一致しません）。書き込みません。');
      return this.#write({
        kind: 'revert', revertOf: txId, file: j.file, w: w.file, beforeHash: j.afterHash, afterHash: j.beforeHash,
        beforeRev: j.afterRev, afterRev: j.beforeRev, range: { start: j.range.start, end: j.range.start + j.change.to.length },
        change: { from: j.change.to, to: j.change.from }, next: before,
        target: j.target ? { ...j.target, fingerprint: j.target.afterFingerprint?.hash ?? j.target.fingerprint, afterFingerprint: null } : null,
        draftId: null, diffHash: null, expect: null,
      });
    } finally { unlock(); }
  }

  /* ------------------------------------------------------------ 復旧 */
  #ownerAlive(j: JournalRecord): boolean {
    if (j.owner.host !== os.hostname()) return true;   // 別の機械の記録は確かめられない（安全側: 何もしない）
    if (j.owner.pid === process.pid) return IN_FLIGHT.has(j.txId);
    return pidAlive(j.owner.pid);
  }

  /**
   * 復旧。対象は持ち主のいない prepared・applying だけ（committed・failed は何もしない — F-04）。
   * 書き込みが無効なら、判断を見せるだけ（dry-run）で何も書かない。
   */
  recover(): RecoveryReport {
    const { records, unreadable } = listJournals(this.journalDir);
    const bad: RecoveryEntry[] = unreadable.map((n) => ({ txId: null, file: n, action: 'none', why: 'unreadable', wrote: false }));
    if (!editWritesEnabled()) {
      const entries = records.map((j): RecoveryEntry => {
        const fileState = this.#fileState(j);
        const plan = planRecovery(j, fileState, this.#ownerAlive(j));
        const left = this.#artifactSets(j).flatMap((a) => {
          const x = recordedArtifactsPresent(this.root, j.file, a.tempName);
          return [x.temp ? a.tempName : null, x.orig ? snapshotNameOf(a.tempName) : null, x.ours ? a.tempName.replace(/\.tmp$/, '.ours.tmp') : null];
        }).filter((x): x is string => !!x);
        return { txId: j.txId, file: j.file, state: j.state, action: plan.kind, wrote: false, fileState,
          why: `（書き込みが無効のため実行していません）${plan.why}${left.length ? `（残っているファイル: ${left.join('・')}）` : ''}` };
      });
      return { status: 'dry-run', entries: [...entries, ...bad], pruned: [] };
    }
    const unlock = acquireLock(this.journalDir);
    if (!unlock) return { status: 'busy', entries: [], pruned: [] };
    try {
      const entries: RecoveryEntry[] = [];
      for (const j of records) entries.push(this.#recoverOne(j));
      const pruned = this.#prune();
      return { status: 'done', entries: [...entries, ...bad], pruned };
    } finally { unlock(); }
  }

  /**
   * ジャーナルが記録した一時ファイル（と、名前から決まる退避リンク）の組。
   *   適用の一時ファイル  : 退避リンクは「適用前」の内容、自分の版は「適用後」の内容なら外してよい
   *   復旧の一時ファイル  : 復旧は「適用後 → 適用前」へ書くので逆になる
   */
  #artifactSets(j: JournalRecord): { tempName: string; origAllowed: string[]; oursAllowed: string[] }[] {
    const out = [{ tempName: j.tempName, origAllowed: [j.beforeHash], oursAllowed: [j.afterHash] }];
    if (j.recovery?.tempName) out.push({ tempName: j.recovery.tempName, origAllowed: [j.afterHash], oursAllowed: [j.beforeHash] });
    return out;
  }

  #recoverOne(j0: JournalRecord): RecoveryEntry {
    if (j0.projectRoot !== this.root) return { txId: j0.txId, file: j0.file, state: j0.state, action: 'none', why: 'other-project', wrote: false };
    let j = j0;
    const alive = this.#ownerAlive(j);
    if (TERMINAL_STATES.includes(j.state) || alive) {
      const fileState = this.#fileState(j);
      const plan = planRecovery(j, fileState, alive);
      return { txId: j.txId, file: j.file, state: j.state, fileState, action: 'none', why: plan.kind === 'none' ? plan.why : 'none', wrote: false };
    }
    /* 0. 失うものが無い一時ファイル・退避リンクを先に片付ける（書き込み先と同じ実体・基準/書いた内容とバイト一致するものだけ）。
     *    止まった時点で書き込み先にもう1つの名前が付いている（リンク数 2）と、範囲の検査が通らないため */
    let removedTemps = 0;
    const kept: string[] = [];
    for (const a of this.#artifactSets(j)) {
      const c = cleanupRecordedArtifacts(this.root, j.file, a.tempName, a.origAllowed, a.oursAllowed);
      if (!c) continue;
      removedTemps += [c.temp, c.orig, c.ours].filter((x) => x === 'removed').length;
      if (c.temp === 'kept') kept.push(a.tempName);
      if (c.orig === 'kept') kept.push(snapshotNameOf(a.tempName));
      if (c.ours === 'kept') kept.push(a.tempName.replace(/\.tmp$/, '.ours.tmp'));
    }
    const fileState = this.#fileState(j);
    let plan = planRecovery(j, fileState, false);
    /* 退避リンクに外部の変更が残っている（置き換えの最中の外部の書き込み）: 適用前へ戻すと、どちらの版でもない内容になる。書かない */
    if (plan.kind === 'restore-before' && kept.length) {
      plan = { kind: 'refuse', why: `置き換えの最中の外部の変更を含むファイルが残っています（${kept.join('・')}）。書かずに要確認` };
    }
    const base = { txId: j.txId, file: j.file, state: j.state, fileState };
    const at = this.#now();
    if (plan.kind === 'none') return { ...base, action: 'none', why: plan.why, wrote: false, removedTemps };
    if (plan.kind === 'mark-failed' || plan.kind === 'refuse') {
      j = transition(j, 'failed', at, {
        failure: j.failure ?? { reason: 'interrupted', detail: plan.why, written: false, fileState },
        recovery: { at, action: plan.kind, fileState, state: 'done', detail: kept.length ? `${plan.why}（残したファイル: ${kept.join('・')}）` : plan.why,
          ...(j.recovery?.tempName ? { tempName: j.recovery.tempName } : {}) },
        needsAttention: plan.kind === 'refuse' || fileState !== 'at-before' || kept.length > 0,
      });
      this.#writeJournal(j);
      return { ...base, action: plan.kind, why: plan.why, wrote: false, removedTemps };
    }
    /* restore-before: いまの内容（＝適用後の内容とバイト一致）から適用前の内容を作り直して戻す */
    const w = resolveWritable(this.root, j.file);
    const id = w.ok ? this.#read(w.file) : null;
    let before: string | null = null;
    try { before = id ? unpatchToken(id.text, j.range.start, j.change.from, j.change.to) : null; } catch { before = null; }
    if (!w.ok || !id || !before || identifyText(before).contentHash !== j.beforeHash) {
      j = transition(j, 'failed', at, { recovery: { at, action: 'refuse', fileState, state: 'done', detail: '適用前の内容を作り直せません' }, needsAttention: true });
      this.#writeJournal(j);
      return { ...base, action: 'refuse', why: '適用前の内容を作り直せない', wrote: false, removedTemps };
    }
    const n = Number(/-r(\d+)\.tmp$/.exec(j.recovery?.tempName ?? '')?.[1] ?? 0) + 1;
    const rtemp = `.${path.basename(j.file)}${TEMP_MARK}${j.txId}-r${n}.tmp`;
    /* 戻す前に、戻すことと一時ファイルの名前を記録する（復旧の途中で止まっても、次の復旧で片付く） */
    j = { ...j, updatedAt: at, recovery: { at, action: 'restore-before', fileState, tempName: rtemp, state: 'restoring' } };
    this.#writeJournal(j);
    const r = replaceSourceFile({
      projectRoot: this.root, rel: j.file, expectedHash: j.afterHash, next: before, tempName: rtemp, identity: w.file,
      hooks: { step: (s: WriteStep) => this.#step(s, j.txId) },
    });
    const fin = this.#now();
    if (r.status === 'replaced') {
      j = transition(j, 'failed', fin, {
        failure: { reason: 'interrupted-after-write', detail: plan.why, written: true, fileState: 'at-before' },
        recovery: { at: fin, action: 'restored-before', fileState: 'at-before', tempName: rtemp, state: 'done' }, needsAttention: false,
      });
      this.#writeJournal(j);
      return { ...base, action: 'restore-before', why: plan.why, wrote: true, removedTemps };
    }
    j = transition(j, 'failed', fin, {
      recovery: { at: fin, action: 'restore-failed', fileState: this.#fileState(j), tempName: rtemp, state: 'done', detail: r.detail }, needsAttention: true,
    });
    this.#writeJournal(j);
    return { ...base, action: 'restore-before', why: `戻せませんでした: ${r.detail}`, wrote: r.status === 'unknown' && r.renamed, removedTemps };
  }

  /** 保存期間を過ぎた**終わりの**ジャーナル（と検証の記録）だけを消す */
  #prune(): string[] {
    const limit = this.#clock() - this.#retention;
    const out: string[] = [];
    for (const j of listJournals(this.journalDir).records) {
      if ((j.state === 'committed' || j.state === 'failed') && Date.parse(j.updatedAt) < limit) {
        removeRecord(this.journalDir, verificationName(j.txId));
        removeRecord(this.journalDir, journalName(j.txId));
        out.push(j.txId);
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ 検証 */
  /** 適用結果の検証の報告を受け取り、サーバー側の契約で確かめて記録する（F-05） */
  submitVerification(report: unknown): VerificationResult {
    const nowMs = this.#clock();
    const reject = (code: 'bad-report' | 'tx-unknown' | 'tx-not-committed', detail: string, txId: string | null): VerificationResult =>
      ({ status: 'not-verified', txId, problems: [{ code, detail }], verifiedRevisions: null, measuredAt: null, receivedAt: new Date(nowMs).toISOString() });
    const rep = parseVerificationReport(report);
    if (!rep) return reject('bad-report', '検証の報告の形が正しくありません（知らないキー・型・値の範囲・実測/予測の別・予測の印の数・文書の識別子）。', null);
    if (!TX_ID_RE.test(rep.txId)) return reject('tx-unknown', '適用の識別子の形が正しくありません。', null);
    const j = this.journal(rep.txId);
    if (!j || j.projectRoot !== this.root) return reject('tx-unknown', 'この適用の記録がありません。', rep.txId);
    if (j.state !== 'committed' || !j.committedAt || !j.target) {
      return this.#recordVerification(rep.txId, reject('tx-not-committed', `この適用は確定していません（${j.state}）。`, rep.txId));
    }
    const files = new Set<string>([j.file]);
    for (const b of rep.artboards) for (const f of Object.keys(b.document.sourceRevs)) files.add(f);
    const currentRevs: Record<string, string | null> = {};
    for (const f of [...files].slice(0, 200)) {
      if (f === j.file) {
        const w = resolveWritable(this.root, f);
        currentRevs[f] = w.ok ? this.#read(w.file)?.rev ?? null : null;
      } else {
        currentRevs[f] = sourceRevisionsOf(this.root, [f])[f] ?? null;
      }
    }
    const res = evaluateVerification({
      txId: j.txId, anchorId: j.target.anchorId, file: j.file, afterRev: j.afterRev, present: j.change.to, absent: j.change.from,
      committedAtMs: Date.parse(j.committedAt), viewports: this.#viewports, maxAgeMs: this.#maxAge, skewMs: CLOCK_SKEW_MS, expect: j.expect,
    }, rep, nowMs, currentRevs);
    return this.#recordVerification(j.txId, res);
  }

  #recordVerification(txId: string, res: VerificationResult): VerificationResult {
    const prev = this.#verifications(txId);
    try { writeJsonAtomic(this.journalDir, verificationName(txId), { txId, results: [...prev, res].slice(-50) }); } catch { /* 記録できなくても結果は返す（成功の判断は記録から読む） */ }
    return res;
  }

  #verifications(txId: string): VerificationResult[] {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.journalDir, verificationName(txId)), 'utf8')) as { results?: VerificationResult[] };
      return Array.isArray(v.results) ? v.results : [];
    } catch { return []; }
  }

  /* ------------------------------------------------------------ 読み出し */
  journal(txId: string): JournalRecord | null {
    if (typeof txId !== 'string' || !TX_ID_RE.test(txId)) return null;
    return readJournalFile(path.join(this.journalDir, journalName(txId)));
  }

  /** 適用の結果。success は「committed かつ verified（記録から読む）」のときだけ */
  outcome(txId: string): Outcome {
    const j = this.journal(txId);
    if (!j) return { txId, write: 'unknown', kind: null, verification: 'pending', success: false, staleSinceVerification: false };
    const results = this.#verifications(txId);
    const ok = [...results].reverse().find((r) => r.status === 'verified' && r.verifiedRevisions);
    const verification = ok ? 'verified' : results.length ? 'not-verified' : 'pending';
    let stale = false;
    if (ok) {
      /* E1.1: 対象のファイルだけでなく、検証した文書が描いた全ファイルの版を見る（どれかが変われば、検証はいまの内容の証拠ではない） */
      const vr = ok.verifiedRevisions as Record<string, string>;
      const w = resolveWritable(this.root, j.file);
      const cur = w.ok ? this.#read(w.file)?.rev ?? null : null;
      const others = Object.keys(vr).filter((f) => f !== j.file).slice(0, 200);
      const otherRevs = others.length ? sourceRevisionsOf(this.root, others) : {};
      stale = cur !== vr[j.file] || others.some((f) => (otherRevs[f] ?? null) !== vr[f]);
    }
    return { txId, write: j.state, kind: j.kind, verification, success: j.state === 'committed' && verification === 'verified' && !!ok, staleSinceVerification: stale };
  }
}
