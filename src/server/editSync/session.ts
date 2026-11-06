/* =============================================================================
 * 視覚編集 E2.1 — プレビューと編集対象の同期（サーバー側。docs/08d 第5〜10節）。**読むだけ**（書き込みの道は無い）。
 *
 * アートボード（Desktop 1440×900・Mobile 375×812）ごとに、次を独立に持つ:
 *   接続   画面が作った接続の識別子（conn）・その接続の文書の識別子・どの起動か。新しい接続は前の接続と選択を置き換える
 *   選択   編集対象（readonlyEdit.resolveTarget の結果の識別子）と、それを選んだ文書。失効したら戻さない（再選択が要る）
 * 要求ごとに確かめること（1つでも外れれば、その結果を返して先へ進まない）:
 *   1. IDE の起動（ideBoot）が同じ             … 違えば disconnected（ide-restarted）
 *   2. 開発サーバーの起動（instance・pid・開始時刻）がいまのもの … 違えば disconnected（stale-run）
 *   3. その接続が、そのアートボードのいまの接続 … 違えば disconnected（stale-connection。古い MessagePort・古い文書）
 *   4. 文書の識別子が、その接続で登録した文書 … 違えば disconnected（document-not-registered）
 *   5. ビューポートがアートボードの幅・高さ     … 違えば disconnected（viewport-mismatch）
 *   6. 文書の照合（editSyncBinding.bindEditDocument。段ごと。描画は確かめていない）
 *   7. 選択 → 編集対象: 探索の7段の照合 ＋ 範囲 ＋ 内容の版 ＋ 指紋（readonlyEdit）。再照合で版・指紋が違えば stale（引き継がない）
 * 位置（ファイル・行・列）は**ブラウザから受け取らない**。矩形・計算済みスタイルも受け取らない（表示用で、照合の根拠にしない）。
 * ========================================================================== */
import { randomBytes } from 'node:crypto';
import { parseRunKey, type RunKey } from '../../lib/previewProtocol';
import { ARTBOARDS, isArtboardId, parseObservationBody, type ArtboardId, type ObservationBody } from '../../lib/editPreviewProtocol';
import { bindEditDocument, type EditDocBinding, type LedgerView } from '../../lib/editSyncBinding';
import { parseReport, readonlyEditView, writeGate, type ReadonlyEditView, type RecoveryInspectionView } from './readonlyEdit';

/** 開発用の同期を有効にする環境変数（"1" のときだけ。既定は無効） */
export const EDIT_SYNC_DEV_ENV = 'VCIDE_EDIT_SYNC_DEV';
export const editSyncEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[EDIT_SYNC_DEV_ENV] === '1';

export interface CurrentRun { run: RunKey; runString: string; projectRoot: string; projectName: string }
export interface SessionDeps {
  /** いま実行中の開発サーバーの起動（実行中でなければ null） */
  current(): CurrentRun | null;
  /** 選んだプロジェクト（停止中でも、最後に選んだもの）。復旧の点検に使う */
  project(): { root: string; name: string } | null;
  ledger: { view(run: string): LedgerView | null };
  viewFor?: (root: string) => ReadonlyEditView;
  now?: () => number;
  ideBoot?: string;
}

export type SyncStatus = 'selected' | 'stale' | 'unresolved' | 'disconnected';
export type ConnectionReason =
  | 'ide-restarted' | 'stale-run' | 'not-connected' | 'stale-connection' | 'document-not-registered'
  | 'viewport-mismatch' | 'token-of-other-artboard';
export type SyncReason =
  | ConnectionReason | 'not-selected' | 'dom-detached' | 'selection-unknown' | 'document-replaced'
  | 'source-changed' | 'element-mismatch' | 'target-moved' | 'target-unresolved' | 'outside-scope'
  | 'unsupported-encoding' | 'verifier-unavailable' | 'target-unknown' | 'bad-request';

export const SYNC_REASON_TEXT: Record<SyncReason, string> = {
  'ide-restarted': 'IDE が起動し直されました。前の画面の接続・選択は使えません',
  'stale-run': 'この要求は、いま実行中の開発サーバーとは別の起動のページから来ました',
  'not-connected': 'このアートボードは、いま接続していません',
  'stale-connection': 'この接続は、このアートボードのいまの接続ではありません（読み込み直す前の文書・古い MessagePort）',
  'document-not-registered': '知らせの文書が、この接続で登録した文書と違います',
  'viewport-mismatch': 'プレビューの大きさが、このアートボードの幅・高さと違います',
  'token-of-other-artboard': 'この文書は、別のアートボードの文書として登録されています',
  'not-selected': 'このアートボードでは要素を選んでいません',
  'dom-detached': '選んだ DOM の要素が文書から外れました（再描画で置き換わった）。前の要素を引き継ぎません',
  'selection-unknown': 'この選択は、いまのアートボードの選択ではありません',
  'document-replaced': '文書が読み込み直されました。前の文書で選んだ要素は引き継ぎません',
  'source-changed': '選んだ後にソースが変わりました（版が違います）。前の版の要素を引き継ぎません',
  'element-mismatch': '同じ位置の要素が、選んだ要素と内容が違います（別の要素が来た可能性）',
  'target-moved': '選んだ DOM の要素は、いま別の位置・別の要素を指しています',
  'target-unresolved': '選んだ要素の描画位置を特定できません（理由は探索の照合の詳細）',
  'outside-scope': '書き込み範囲（src/ の .tsx・.jsx）の外のファイルです',
  'unsupported-encoding': 'このファイルは UTF-8 として往復できない内容を含みます',
  'verifier-unavailable': '構文解析器を読み込めないため照合できません',
  'target-unknown': 'この編集対象は、いまの照合の記録にありません（IDE・開発サーバーの起動し直しなど）',
  'bad-request': '要求の形が正しくありません',
};

/** 再選択を求める（前の要素を引き継がない）照合の理由 */
const STALE_REFUSALS = new Set(['source-changed', 'element-mismatch', 'target-moved', 'target-unknown']);
const STALE_ANCHOR_REASONS = new Set(['source-changed', 'manifest-stale', 'anchor-not-in-manifest']);

export interface ConnectionStage {
  status: 'identified' | 'unidentified';
  reason: ConnectionReason | null;
  detail: string;
  conn: string | null;
  registeredAt: string | null;
}

export interface SyncView {
  status: SyncStatus;
  reason: SyncReason | null;
  detail: string;
  reselect: boolean;
  artboard: ArtboardId;
  connection: ConnectionStage;
  /** DOM の中の1つのインスタンス（どのアートボード・どの文書・同じ JSX の何番目か） */
  instance: { docToken: string | null; anchorId: string | null; ordinal: number | null; count: number; tag: string; path: string } | null;
  /** ソースの定義（サーバーが対応表とソースの読み直しで決めたもの。ブラウザの申告ではない） */
  source: {
    targetId: string; file: string; line: number; col: number; component: string | null; anchorId: string; tag: string;
    sourceRev: string; domRev: string; manifestRev: string; contentHash: string; fingerprint: string; structureHash: string;
    classReason: string | null; resolvedAt: string;
  } | null;
  document: EditDocBinding | null;
  /** 照合の詳細（探索の照合の理由など） */
  anchorReason: string | null;
  checkedAt: string;
}

interface Selection {
  targetId: string; token: string | null; path: string;
  invalid: { reason: SyncReason; detail: string } | null;
}
interface Reg {
  conn: string; token: string | null; runString: string; at: number;
  last: { rsc: ObservationBody['rsc']; soft: boolean | null };
  selection: Selection | null;
}

const BOOT_RE = /^[0-9a-f]{32}$/;
const CONN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TARGET_RE = /^t-[0-9a-f]{12}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export type SessionResult<T> = { ok: true; body: T } | { ok: false; status: 400; error: { code: 'bad-request'; message: string } };
const bad = <T>(message: string): SessionResult<T> => ({ ok: false, status: 400, error: { code: 'bad-request', message } });

export class EditSyncSession {
  readonly ideBoot: string;
  readonly #deps: SessionDeps;
  readonly #regs = new Map<ArtboardId, Reg>();
  #view: { key: string; view: ReadonlyEditView } | null = null;
  readonly #now: () => number;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.ideBoot = deps.ideBoot ?? randomBytes(16).toString('hex');
    this.#now = deps.now ?? Date.now;
  }

  #iso(): string { return new Date(this.#now()).toISOString(); }

  /** 起動ごとの照合の窓口（起動が変われば作り直す: 前の起動の編集対象の識別子は使えない） */
  #viewFor(cur: CurrentRun): ReadonlyEditView {
    const key = `${cur.runString}|${cur.projectRoot}`;
    if (!this.#view || this.#view.key !== key) {
      this.#view = { key, view: (this.#deps.viewFor ?? ((r: string) => readonlyEditView(r)))(cur.projectRoot) };
    }
    return this.#view.view;
  }

  /* ------------------------------------------------------------ 状態（読むだけ） */
  state(): Record<string, unknown> {
    const cur = this.#deps.current();
    const proj = this.#deps.project();
    let recovery: Record<string, unknown>;
    if (!proj) recovery = { status: 'no-project' };
    else {
      try {
        const insp: RecoveryInspectionView = cur && cur.projectRoot === proj.root ? this.#viewFor(cur).inspectRecovery()
          : (this.#deps.viewFor ?? ((r: string) => readonlyEditView(r)))(proj.root).inspectRecovery();
        recovery = { ...insp, project: proj.name, needsAttention: insp.entries.filter((e) => e.needsAttention || e.plannedAction !== 'none').length };
      } catch (e) { recovery = { status: 'error', message: e instanceof Error ? e.message : String(e) }; }
    }
    const regs: Record<string, unknown> = {};
    for (const [a, r] of this.#regs) {
      regs[a] = { conn: r.conn, token: r.token, run: r.runString, registeredAt: new Date(r.at).toISOString(), selected: !!r.selection && !r.selection.invalid };
    }
    return {
      enabled: true, ideBoot: this.ideBoot, artboards: ARTBOARDS, write: writeGate(),
      project: proj?.name ?? null, run: cur?.run ?? null, recovery, connections: regs,
    };
  }

  /* ------------------------------------------------------------ 共通の検査 */
  #gate(b: Record<string, unknown>, needReg: boolean):
    { ok: false; view: SyncView } | { ok: true; cur: CurrentRun; artboard: ArtboardId; obs: ObservationBody; reg: Reg | null } | { ok: false; bad: string } {
    const artboard = b.artboard;
    if (!isArtboardId(artboard)) return { ok: false, bad: 'artboard' };
    const run = parseRunKey(b.run);
    const obs = parseObservationBody(b.observation);
    if (typeof b.ideBoot !== 'string' || !BOOT_RE.test(b.ideBoot) || !run || typeof b.conn !== 'string' || !CONN_RE.test(b.conn) || !obs) {
      return { ok: false, bad: 'shape' };
    }
    const disc = (reason: ConnectionReason, detail = SYNC_REASON_TEXT[reason]): { ok: false; view: SyncView } =>
      ({ ok: false, view: this.#view0(artboard, 'disconnected', reason, detail, { status: 'unidentified', reason, detail, conn: b.conn as string, registeredAt: null }) });
    if (b.ideBoot !== this.ideBoot) return disc('ide-restarted');
    const cur = this.#deps.current();
    if (!cur || cur.run.instance !== run.instance || cur.run.pid !== run.pid || cur.run.startedAt !== run.startedAt) return disc('stale-run');
    const spec = ARTBOARDS[artboard];
    if (obs.viewport.width !== spec.width || obs.viewport.height !== spec.height) {
      return disc('viewport-mismatch', `${SYNC_REASON_TEXT['viewport-mismatch']}（${obs.viewport.width}×${obs.viewport.height}、期待 ${spec.width}×${spec.height}）`);
    }
    const reg = this.#regs.get(artboard) ?? null;
    if (needReg) {
      if (!reg) return disc('not-connected');
      if (reg.conn !== b.conn || reg.runString !== cur.runString) return disc('stale-connection');
      if (reg.token !== obs.document.token) return disc('document-not-registered');
    }
    return { ok: true, cur, artboard, obs, reg };
  }

  #view0(artboard: ArtboardId, status: SyncStatus, reason: SyncReason | null, detail: string, connection: ConnectionStage): SyncView {
    return { status, reason, detail, reselect: status !== 'selected', artboard, connection, instance: null, source: null, document: null, anchorReason: null, checkedAt: this.#iso() };
  }

  #connStage(reg: Reg): ConnectionStage {
    return { status: 'identified', reason: null, detail: '', conn: reg.conn, registeredAt: new Date(reg.at).toISOString() };
  }

  #bind(artboard: ArtboardId, cur: CurrentRun, obs: ObservationBody, path: string): EditDocBinding {
    const others = [...this.#regs].filter(([a]) => a !== artboard).map(([, r]) => r.token).filter((t): t is string => !!t);
    return bindEditDocument({
      ledger: this.#deps.ledger.view(cur.runString), token: obs.document.token, soft: obs.document.soft, path, artboard,
      otherArtboardTokens: others, rsc: obs.rsc,
    });
  }

  /* ------------------------------------------------------------ 接続 */
  /** アートボードの新しい接続（新しい文書）を登録する。前の接続とその選択は置き換わる（選択は失効し、戻さない） */
  connect(v: unknown): SessionResult<SyncView> {
    if (!isObj(v)) return bad('接続の形が正しくありません。');
    const g = this.#gate(v, false);
    if (!g.ok) return 'bad' in g ? bad(`接続の形が正しくありません（${g.bad}）。`) : { ok: true, body: g.view };
    const { cur, artboard, obs } = g;
    const tok = obs.document.token;
    if (tok && [...this.#regs].some(([a, r]) => a !== artboard && r.token === tok)) {
      const reason = 'token-of-other-artboard' as const;
      return { ok: true, body: this.#view0(artboard, 'disconnected', reason, SYNC_REASON_TEXT[reason], { status: 'unidentified', reason, detail: SYNC_REASON_TEXT[reason], conn: v.conn as string, registeredAt: null }) };
    }
    const reg: Reg = { conn: v.conn as string, token: tok, runString: cur.runString, at: this.#now(), last: { rsc: obs.rsc, soft: obs.document.soft }, selection: null };
    this.#regs.set(artboard, reg);
    const view = this.#view0(artboard, 'stale', 'not-selected', SYNC_REASON_TEXT['not-selected'], this.#connStage(reg));
    view.document = this.#bind(artboard, cur, obs, typeof v.path === 'string' ? v.path : '/');
    return { ok: true, body: view };
  }

  /** アートボードの接続を外す（iframe を閉じた・文書が無くなった）。その選択も失効する */
  disconnect(v: unknown): SessionResult<{ removed: boolean }> {
    if (!isObj(v) || !isArtboardId(v.artboard) || typeof v.conn !== 'string' || typeof v.ideBoot !== 'string') return bad('形が正しくありません。');
    const r = this.#regs.get(v.artboard);
    if (v.ideBoot !== this.ideBoot || !r || r.conn !== v.conn) return { ok: true, body: { removed: false } };
    this.#regs.delete(v.artboard);
    return { ok: true, body: { removed: true } };
  }

  /* ------------------------------------------------------------ 選択 */
  #fromTarget(artboard: ArtboardId, reg: Reg, cur: CurrentRun, obs: ObservationBody, res: ReturnType<ReadonlyEditView['resolveTarget']>): SyncView {
    const sel = obs.selection!;
    const view = this.#view0(artboard, 'selected', null, '', this.#connStage(reg));
    view.instance = { docToken: obs.document.token, anchorId: sel.anchorOnSelf, ordinal: sel.anchorOrdinal, count: sel.anchorInstanceCount, tag: sel.tag, path: sel.path };
    view.document = this.#bind(artboard, cur, obs, sel.path);
    if (res.ok) {
      const t = res.target;
      view.source = {
        targetId: t.id, file: t.file, line: t.line, col: t.col, component: t.component, anchorId: t.anchorId, tag: t.tag,
        sourceRev: t.sourceRev, domRev: t.domRev, manifestRev: t.manifestRev, contentHash: t.contentHash,
        fingerprint: t.fingerprint, structureHash: t.structureHash, classReason: t.classReason, resolvedAt: t.resolvedAt,
      };
      return view;
    }
    const reason = (res.reason in SYNC_REASON_TEXT ? res.reason : 'target-unresolved') as SyncReason;
    const stale = STALE_REFUSALS.has(res.reason) || (res.reason === 'target-unresolved' && !!res.anchorReason && STALE_ANCHOR_REASONS.has(res.anchorReason));
    view.status = stale ? 'stale' : 'unresolved';
    view.reason = reason;
    view.detail = res.detail;
    view.reselect = true;
    view.anchorReason = res.anchorReason ?? null;
    return view;
  }

  /** プレビューで選んだ要素を、編集対象に結び付ける（読むだけ） */
  select(v: unknown): SessionResult<SyncView> {
    if (!isObj(v)) return bad('選択の形が正しくありません。');
    const g = this.#gate(v, true);
    if (!g.ok) return 'bad' in g ? bad(`選択の形が正しくありません（${g.bad}）。`) : { ok: true, body: g.view };
    const { cur, artboard, obs } = g;
    const reg = g.reg!;
    reg.last = { rsc: obs.rsc, soft: obs.document.soft };
    if (obs.state !== 'ok' || !obs.selection) {
      reg.selection = null;
      return { ok: true, body: this.#view0(artboard, 'stale', obs.state === 'detached' ? 'dom-detached' : 'not-selected', SYNC_REASON_TEXT[obs.state === 'detached' ? 'dom-detached' : 'not-selected'], this.#connStage(reg)) };
    }
    const res = this.#viewFor(cur).resolveTarget(obs.selection);
    const view = this.#fromTarget(artboard, reg, cur, obs, res);
    reg.selection = view.source
      ? { targetId: view.source.targetId, token: obs.document.token, path: obs.selection.path, invalid: null }
      : null;
    return { ok: true, body: view };
  }

  /**
   * 選択の再照合（HMR・再描画の後）。同じ DOM の要素をスクリプトが描き直したもの（新しい版）で、解決済みの対象を確かめ直す。
   * **版・内容・指紋が1つでも違えば stale で、戻さない**（新しい版の要素として引き継がない。carrySelection は自分の適用の後だけで、
   * E2.1 の画面からは呼ばない）。選び直せば新しい対象として解決する。
   */
  recheck(v: unknown): SessionResult<SyncView> {
    if (!isObj(v)) return bad('再照合の形が正しくありません。');
    const g = this.#gate(v, true);
    if (!g.ok) return 'bad' in g ? bad(`再照合の形が正しくありません（${g.bad}）。`) : { ok: true, body: g.view };
    if (typeof v.targetId !== 'string' || !TARGET_RE.test(v.targetId)) return bad('再照合の形が正しくありません（targetId）。');
    const { cur, artboard, obs } = g;
    const reg = g.reg!;
    reg.last = { rsc: obs.rsc, soft: obs.document.soft };
    const s = reg.selection;
    const stale = (reason: SyncReason, detail = SYNC_REASON_TEXT[reason]): SessionResult<SyncView> => {
      if (s && !s.invalid) s.invalid = { reason, detail };
      const view = this.#view0(artboard, 'stale', reason, detail, this.#connStage(reg));
      view.document = this.#bind(artboard, cur, obs, s?.path ?? obs.selection?.path ?? '/');
      return { ok: true, body: view };
    };
    if (!s || s.targetId !== v.targetId) return stale('selection-unknown');
    if (s.invalid) return stale(s.invalid.reason, s.invalid.detail);
    if (s.token !== obs.document.token) return stale('document-replaced');
    if (obs.state !== 'ok' || !obs.selection) return stale(obs.state === 'detached' ? 'dom-detached' : 'not-selected');
    const res = this.#viewFor(cur).reresolveTarget(s.targetId, obs.selection);
    const view = this.#fromTarget(artboard, reg, cur, obs, res);
    if (view.status !== 'selected') {
      if (view.status === 'unresolved') { view.status = 'stale'; }
      s.invalid = { reason: view.reason ?? 'target-unresolved', detail: view.detail };
    }
    return { ok: true, body: view };
  }

  /* ------------------------------------------------------------ 検証の報告の出所（読むだけ） */
  /**
   * 検証の報告（E1 の形）の各幅の文書を、いまのアートボードの接続・中継の台帳に結び付ける。**検証の契約の評価はしない**
   * （エンジンの submitVerification を呼ばない・記録を書かない）。描画は報告の申告のまま（render: declared-by-report）。
   * bound になるのは、必須の2幅がちょうど1回ずつあり、各幅の文書がそのアートボードのいまの接続の文書で、中継の台帳と照らして
   * 文書の段・取り直しの段を通り、計測の時刻がその文書の接続・最後の取り直しの後で、古すぎない・未来でないときだけ。
   */
  bindReport(v: unknown): SessionResult<Record<string, unknown>> {
    if (!isObj(v) || typeof v.ideBoot !== 'string') return bad('形が正しくありません。');
    const rep = parseReport(v.report);
    const problems: string[] = [];
    const out = (artboards: unknown[]) => ({
      ok: true as const,
      body: { binding: problems.length ? 'unbound' : 'bound', render: 'declared-by-report', verification: 'not-evaluated', problems, artboards },
    });
    if (v.ideBoot !== this.ideBoot) { problems.push('ide-restarted'); return out([]); }
    if (!rep) { problems.push('malformed-report'); return out([]); }
    const cur = this.#deps.current();
    if (!cur) { problems.push('stale-run'); return out([]); }
    const now = this.#now();
    const rows: unknown[] = [];
    const seen = new Map<ArtboardId, number>();
    for (const b of rep.artboards) {
      const artboard = (Object.keys(ARTBOARDS) as ArtboardId[]).find((a) => ARTBOARDS[a].width === b.viewport.width) ?? null;
      const p: string[] = [];
      let document: EditDocBinding | null = null;
      let connection: 'current' | 'other-artboard' | 'not-registered' | 'unknown-viewport' = 'unknown-viewport';
      let measuredAfter: boolean | null = null;
      if (artboard) {
        seen.set(artboard, (seen.get(artboard) ?? 0) + 1);
        const reg = this.#regs.get(artboard);
        const other = [...this.#regs].find(([a, r]) => a !== artboard && r.token === b.document.token);
        connection = reg && reg.token === b.document.token && reg.runString === cur.runString ? 'current' : other ? 'other-artboard' : 'not-registered';
        if (connection !== 'current') p.push(`connection-${connection}`);
        if (reg && connection === 'current') {
          document = this.#bind(artboard, cur, { state: 'none', selection: null, document: { token: b.document.token, soft: reg.last.soft }, rsc: reg.last.rsc, viewport: { width: ARTBOARDS[artboard].width, height: ARTBOARDS[artboard].height } }, b.document.path);
          if (document.level !== 'document-identified') p.push(...document.reasons.map((r) => `document-${r}`));
          const t = Date.parse(b.measuredAt);
          const after = Math.max(reg.at, document.refetch.status === 'self' ? document.refetch.lastEndMs : 0);
          measuredAfter = Number.isFinite(t) && t >= after;
          if (!measuredAfter) p.push('measured-before-latest-document-or-refetch');
          if (Number.isFinite(t) && t > now + 2000) p.push('measured-in-future');
          if (Number.isFinite(t) && now - t > 10 * 60 * 1000) p.push('measurement-too-old');
        }
      } else p.push('unknown-viewport');
      problems.push(...p.map((x) => `${artboard ?? b.viewport.width}:${x}`));
      rows.push({ artboard, width: b.viewport.width, token: b.document.token, connection, document, measuredAfterLatest: measuredAfter, render: 'declared-by-report', problems: p });
    }
    for (const a of Object.keys(ARTBOARDS) as ArtboardId[]) {
      const n = seen.get(a) ?? 0;
      if (n === 0) problems.push(`${a}:viewport-missing`);
      if (n > 1) problems.push(`${a}:duplicate-viewport`);
    }
    return out(rows);
  }
}
