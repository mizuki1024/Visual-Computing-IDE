/* =============================================================================
 * 編集 E1 — 適用結果の検証の契約（06h レビュー F-05）。**サーバーが自分で確かめる。** UI の手順に頼らない。
 *
 * E1 には利用者向けのプレビューが無い。ここで決めるのは、プレビュー（E2 以降）が送る「検証の報告」の形と、
 * それを受け入れる条件だけ。条件を1つでも満たさなければ verified にしない（成功扱いにしない）:
 *   1. 適用対象との対応: txId が committed の適用・取り消しで、要素の識別子・ファイル・版が一致する
 *   2. 必須の幅: 必須の幅（既定 1440・375）がすべて、ちょうど1回ずつある
 *   3. 実測であること: 各幅の mode が 'measured'、描画の中の予測の印（data-vcide-predict）が 0 個
 *   4. 版: 報告の版・各幅の文書が描いた対象のファイルの版・測った要素の版 = 適用後の版
 *   5. 検証の時点の版（RS04）: 受け取った時点で、対象のファイルと文書が描いた他のファイルのいまの版が、報告の版と一致する
 *   6. 時刻: 確定の後に測った・未来でない・古すぎない
 *   7. 描画: 測った要素がある・すべてに変更後の token があり、変更前の token が無い
 *   8. （サーバー側で与えたときだけ）期待する計算済みスタイル
 * 文書の識別子（token）は形を確かめて記録する。**実際の中継の応答との結び付け（previewGateway の文書の識別子）は確かめていない**
 * （E2 で探索の持ち物の変更が要ると分かり、決定待ち — docs/08c 第4節）。結果の documentBinding: 'not-checked' がそれを示す。
 * ========================================================================== */
import type { RequiredViewport } from './config';

export type VerificationProblemCode =
  | 'bad-report' | 'tx-unknown' | 'tx-not-committed' | 'anchor-mismatch' | 'file-mismatch' | 'revision-mismatch'
  | 'viewport-missing' | 'duplicate-viewport' | 'predicted-not-accepted' | 'document-revision-mismatch'
  | 'element-revision-mismatch' | 'stale-source' | 'measured-before-commit' | 'measured-in-future' | 'measurement-too-old'
  | 'no-elements' | 'token-not-rendered' | 'expectation-mismatch';

export interface VerificationProblem { code: VerificationProblemCode; detail: string }

export interface MeasuredElement { anchorId: string; rev: string; classTokens: string[]; computed: Record<string, string> }
export interface Artboard {
  viewport: { width: number; height: number };
  mode: 'measured' | 'predicted';
  predictionMarkers: number;
  measuredAt: string;
  document: { token: string; path: string; sourceRevs: Record<string, string> };
  elements: MeasuredElement[];
}
export interface VerificationReport {
  txId: string; anchorId: string; file: string; sourceRev: string; measuredAt: string; artboards: Artboard[];
}

export interface VerificationRequirement {
  txId: string; anchorId: string; file: string; afterRev: string;
  /** 描画にあるべき token・無いべき token */
  present: string; absent: string;
  committedAtMs: number;
  viewports: readonly RequiredViewport[];
  maxAgeMs: number; skewMs: number;
  expect: Record<string, Record<string, string>> | null;
}

export interface VerificationResult {
  status: 'verified' | 'not-verified';
  txId: string | null;
  problems: VerificationProblem[];
  /** verified のとき: 検証の時点で確かめたファイルの版 */
  verifiedRevisions: Record<string, string> | null;
  measuredAt: string | null;
  receivedAt: string;
  /**
   * E2: 報告の文書（`document.token`）が、いまの起動の中継（previewGateway）が実際に返した文書・IDE の接続のものかを
   * **確かめていない**ことを明示する（docs/08c 第4節）。結び付けは探索の持ち物（previewProtocol・previewGateway）への
   * 知らせの追加が要り、E2 のこの段では実装していない。verified はこの結び付けの証拠ではない
   */
  documentBinding: 'not-checked';
  /** 実測か予測かは、報告の申告（各幅の mode・予測の印の数）に依る。サーバーは描画を自分で測っていない */
  measurement: 'declared-by-report';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const isStr = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const ANCHOR_RE = /^[0-9a-f]{10}$/;
const REV_RE = /^[0-9a-f]{16}$/;
const DOC_RE = /^[0-9a-f]{32}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const FILE_RE = /^src\/[^\0\\]{1,500}\.(tsx|jsx)$/;
const CSS_PROP_RE = /^[a-z-]{1,60}$/;
const MAX_ELEMENTS = 500;
const MAX_FILES = 200;

/** 報告の形の検査。合わなければ null（知らないキー・型・値の範囲） */
export function parseVerificationReport(v: unknown): VerificationReport | null {
  if (!isObj(v) || !only(v, ['txId', 'anchorId', 'file', 'sourceRev', 'measuredAt', 'artboards'])) return null;
  if (!isStr(v.txId, 40) || !isStr(v.anchorId) || !ANCHOR_RE.test(v.anchorId) || !isStr(v.file, 600) || !FILE_RE.test(v.file)
    || !isStr(v.sourceRev) || !REV_RE.test(v.sourceRev) || !isStr(v.measuredAt, 40) || !ISO_RE.test(v.measuredAt)) return null;
  if (!Array.isArray(v.artboards) || v.artboards.length > 16) return null;
  const artboards: Artboard[] = [];
  for (const b of v.artboards) {
    if (!isObj(b) || !only(b, ['viewport', 'mode', 'predictionMarkers', 'measuredAt', 'document', 'elements'])) return null;
    if (!isObj(b.viewport) || !only(b.viewport, ['width', 'height']) || !isInt(b.viewport.width, 1, 10000) || !isInt(b.viewport.height, 1, 10000)) return null;
    if (b.mode !== 'measured' && b.mode !== 'predicted') return null;
    if (!isInt(b.predictionMarkers, 0, 1_000_000)) return null;
    if (!isStr(b.measuredAt, 40) || !ISO_RE.test(b.measuredAt)) return null;
    const d = b.document;
    if (!isObj(d) || !only(d, ['token', 'path', 'sourceRevs']) || !isStr(d.token) || !DOC_RE.test(d.token)
      || !isStr(d.path, 2048) || !d.path.startsWith('/') || !isObj(d.sourceRevs)) return null;
    const revs = Object.entries(d.sourceRevs);
    if (revs.length > MAX_FILES || !revs.every(([f, r]) => FILE_RE.test(f) && typeof r === 'string' && REV_RE.test(r))) return null;
    if (!Array.isArray(b.elements) || b.elements.length > MAX_ELEMENTS) return null;
    const elements: MeasuredElement[] = [];
    for (const e of b.elements) {
      if (!isObj(e) || !only(e, ['anchorId', 'rev', 'classTokens', 'computed'])) return null;
      if (!isStr(e.anchorId) || !ANCHOR_RE.test(e.anchorId) || !isStr(e.rev) || !REV_RE.test(e.rev)) return null;
      if (!Array.isArray(e.classTokens) || e.classTokens.length > 200 || !e.classTokens.every((t) => isStr(t, 200))) return null;
      if (!isObj(e.computed) || Object.keys(e.computed).length > 50
        || !Object.entries(e.computed).every(([k, x]) => CSS_PROP_RE.test(k) && isStr(x, 200))) return null;
      elements.push({ anchorId: e.anchorId, rev: e.rev, classTokens: [...e.classTokens] as string[], computed: { ...(e.computed as Record<string, string>) } });
    }
    artboards.push({
      viewport: { width: b.viewport.width, height: b.viewport.height }, mode: b.mode, predictionMarkers: b.predictionMarkers,
      measuredAt: b.measuredAt, document: { token: d.token, path: d.path, sourceRevs: Object.fromEntries(revs) as Record<string, string> }, elements,
    });
  }
  return { txId: v.txId, anchorId: v.anchorId, file: v.file, sourceRev: v.sourceRev, measuredAt: v.measuredAt, artboards };
}

/**
 * 報告を要求と照らす（**純粋な関数**）。currentRevs は受け取った時点でサーバーがファイルを読み直した版
 * （報告に出てくる全ファイル。読めない・範囲の外は null）。
 */
export function evaluateVerification(req: VerificationRequirement, rep: VerificationReport, nowMs: number,
  currentRevs: Record<string, string | null>): VerificationResult {
  const problems: VerificationProblem[] = [];
  const add = (code: VerificationProblemCode, detail: string) => { problems.push({ code, detail }); };
  if (rep.txId !== req.txId) add('tx-unknown', '報告の適用が、照らす適用と違います。');
  if (rep.anchorId !== req.anchorId) add('anchor-mismatch', `報告の要素（${rep.anchorId}）が、適用した要素（${req.anchorId}）と違います。`);
  if (rep.file !== req.file) add('file-mismatch', `報告のファイル（${rep.file}）が、適用したファイル（${req.file}）と違います。`);
  if (rep.sourceRev !== req.afterRev) add('revision-mismatch', `報告の版 ${rep.sourceRev} が、適用後の版 ${req.afterRev} と違います。`);

  /* 2. 必須の幅 */
  const byWidth = new Map<number, Artboard[]>();
  for (const b of rep.artboards) byWidth.set(b.viewport.width, [...(byWidth.get(b.viewport.width) ?? []), b]);
  for (const vp of req.viewports) {
    const got = byWidth.get(vp.width) ?? [];
    if (got.length === 0) add('viewport-missing', `必須の幅 ${vp.name}（${vp.width}px）の検証がありません。`);
    if (got.length > 1) add('duplicate-viewport', `幅 ${vp.width}px の検証が ${got.length} 回あります（どれを信じるかを決めません）。`);
  }

  const commitMs = req.committedAtMs;
  const checkTime = (iso: string, where: string) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) { add('bad-report', `${where}: 時刻を読めません。`); return; }
    if (t < commitMs) add('measured-before-commit', `${where}: 確定（${new Date(commitMs).toISOString()}）より前の計測です。`);
    if (t > nowMs + req.skewMs) add('measured-in-future', `${where}: 未来の時刻です。`);
    if (nowMs - t > req.maxAgeMs) add('measurement-too-old', `${where}: 計測から ${Math.round((nowMs - t) / 1000)} 秒経っています（上限 ${Math.round(req.maxAgeMs / 1000)} 秒）。`);
  };
  checkTime(rep.measuredAt, '報告');

  const verified: Record<string, string> = {};
  for (const b of rep.artboards) {
    const vp = req.viewports.find((x) => x.width === b.viewport.width);
    const where = vp ? `${vp.name}（${vp.width}px）` : `${b.viewport.width}px`;
    /* 3. 実測 */
    if (b.mode !== 'measured') add('predicted-not-accepted', `${where}: 予測（${b.mode}）は実測として受け入れません。`);
    if (b.predictionMarkers !== 0) add('predicted-not-accepted', `${where}: 描画に予測の印が ${b.predictionMarkers} 個残っています（予測の重ね合わせを測った可能性）。`);
    checkTime(b.measuredAt, where);
    /* 4. 版 */
    const docRev = b.document.sourceRevs[req.file];
    if (docRev !== req.afterRev) add('document-revision-mismatch', `${where}: 文書が描いた ${req.file} の版（${docRev ?? '無し'}）が、適用後の版 ${req.afterRev} と違います。`);
    /* 5. 検証の時点の版 */
    for (const [f, r] of Object.entries(b.document.sourceRevs)) {
      const cur = currentRevs[f] ?? null;
      if (cur !== r) add('stale-source', `${where}: 文書が描いた ${f} の版 ${r} が、いまのファイルの版（${cur ?? '読めない'}）と違います。`);
      else verified[f] = cur;
    }
    /* 7. 描画 */
    if (b.elements.length === 0) add('no-elements', `${where}: 対象の要素を測っていません。`);
    for (const [i, e] of b.elements.entries()) {
      if (e.anchorId !== req.anchorId) add('anchor-mismatch', `${where}: ${i + 1} 件目の要素が、適用した要素と違います。`);
      if (e.rev !== req.afterRev) add('element-revision-mismatch', `${where}: ${i + 1} 件目の要素の版 ${e.rev} が、適用後の版と違います。`);
      if (!e.classTokens.includes(req.present) || e.classTokens.includes(req.absent)) {
        add('token-not-rendered', `${where}: ${i + 1} 件目の要素の class に ${req.present} が無いか、${req.absent} が残っています。`);
      }
      /* 8. 期待する計算済みスタイル */
      const want = vp && req.expect ? req.expect[vp.name] : null;
      if (want) {
        for (const [prop, val] of Object.entries(want)) {
          if (e.computed[prop] !== val) add('expectation-mismatch', `${where}: ${i + 1} 件目の ${prop} が ${e.computed[prop] ?? '無し'}（期待 ${val}）。`);
        }
      }
    }
  }
  const curTarget = currentRevs[req.file] ?? null;
  if (curTarget !== req.afterRev) add('stale-source', `いまの ${req.file} の版（${curTarget ?? '読めない'}）が、適用後の版 ${req.afterRev} と違います（適用の後に変わった）。`);
  const dedup = problems.filter((p, i) => problems.findIndex((q) => q.code === p.code && q.detail === p.detail) === i);
  const ok = dedup.length === 0;
  return {
    status: ok ? 'verified' : 'not-verified', txId: rep.txId, problems: dedup,
    verifiedRevisions: ok ? verified : null, measuredAt: rep.measuredAt, receivedAt: new Date(nowMs).toISOString(),
    documentBinding: 'not-checked', measurement: 'declared-by-report',
  };
}
