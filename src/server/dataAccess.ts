/* =============================================================================
 * Phase 7B-3B-1 — SQL を実行したデータ取得の呼び出し位置（DataAccessSite）を、いまの起動の
 * 記録から特定する（取得手段 server-call-stack）。
 *
 * **照合は PoC-02 のものをそのまま呼ぶ**（`poc/runner/lib/rscattr.mjs`）。新しく作り直さない。
 *   1. 呼び出しの入口（Pool.query）で取ったスタック（スパン開始時のスタックでは代用しない）
 *   2. 上から順に、注入範囲（src/）のソースへソースマップで戻せる最初のフレーム
 *   3. その行をソースから読み直し、データ取得の呼び出しが書かれていること
 *   4. その行を囲むコンポーネントが、ソースの読み直しとビルド時の対応表で一致すること
 *
 * この段階で足した照合（どれか1つでも欠ければ位置を断定しない）:
 *   A. その SQL のスパンに呼び出し位置の記録が**ちょうど1件**ある（0件 / 2件以上は断定しない）
 *   B. 記録のトレース・プロセス・種類が、その SQL のスパンと同じ（spanId が偶然同じ別の記録を使わない）。
 *      PID は記録とスパンの**両方に存在して**一致すること（7B-3B-2。片方が欠ければ断定しない）
 *   C. 戻した位置が対象プロジェクトの src/ の中にある（`..`・シンボリックリンクで外へ出ない）
 *   D. SQL の実行の**後に**、生成物（とソースマップ）も、ソースファイルも書き換わっていない
 *      （書き換わっていれば、戻した位置・読み直した行が、実行したコードのものとは限らない）
 *
 * 根拠にしないもの: 時刻の近さ・SQL 文の一致・ページのパス・コンポーネントの名前の一致。
 * 対象プロジェクトには書き込まない（読むのは src/ のソース・.next の生成物と隣のソースマップ・IDE 側の対応表）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { ideRoot } from './ide';
import { ANCHOR_SCOPE } from './anchors';
import type { DataAccessFailureReason, LiveDataAccess } from '../lib/liveObservation';
import type { ObsSpan } from '../lib/observation';

/** 計装が書いた呼び出し位置の記録（収集ファイルの `type: 'callsite'`）。読むのは形の合うものだけ */
export interface CallsiteRecord {
  spanId: string;
  traceId: string;
  target: string;
  entry: { at: string; frames: CallsiteFrame[]; frameCount: number } | null;
  pid: number | null;
}
export interface CallsiteFrame {
  functionName: string | null; file: string; scope: string; line: number; col: number;
}

/** 生成物の相対パスとして受ける形。`.next/` 以下の .js だけ（記録はアプリのプロセスが書くので信用しない） */
const BUILD_FILE = /^\.next\/[^\0\\]+\.js$/;
const VIRTUAL_FILE = /^(webpack-internal:|turbopack:|rsc:|\[turbopack\])/;
/** 根拠に使いうるフレームの数の上限。PoC-02 の計装は最大 60 フレームを取る */
const MAX_FRAMES = 24;

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 10_000_000;

/**
 * 収集ファイルの1行を、呼び出し位置の記録として読む。形が違えば null。
 * **根拠に使わないフレーム（node_modules・Node 自身）はここで捨てる**（rscattr.mjs も使わない）。
 * 生成物のパスは `..` を含まない `.next/` 以下の .js に限る（IDE が任意のファイルを読まないように）。
 */
export function parseCallsiteRecord(o: Record<string, unknown>): CallsiteRecord | null {
  if (o.type !== 'callsite' || typeof o.spanId !== 'string' || typeof o.traceId !== 'string') return null;
  if (!/^[0-9a-f]{16}$/.test(o.spanId) || !/^[0-9a-f]{32}$/.test(o.traceId)) return null;
  const proc = o.proc as { pid?: unknown } | undefined;
  const pid = proc && isPos(proc.pid) ? proc.pid : null;
  const e = o.entry as { at?: unknown; frames?: unknown[] } | null | undefined;
  let entry: CallsiteRecord['entry'] = null;
  if (e && typeof e === 'object' && Array.isArray(e.frames)) {
    const frames: CallsiteFrame[] = [];
    for (const f of e.frames) {
      const r = f as Record<string, unknown>;
      if (!r || typeof r.file !== 'string' || typeof r.scope !== 'string' || !isPos(r.line) || !isPos(r.col)) continue;
      const fn = typeof r.functionName === 'string' ? r.functionName.slice(0, 80) : null;
      if (r.scope === 'build-output') {
        if (!BUILD_FILE.test(r.file) || r.file.split('/').includes('..')) continue;
      } else if (r.scope === 'bundler-virtual') {
        if (!VIRTUAL_FILE.test(r.file) || r.file.length > 300) continue;
      } else if (r.scope === 'app-source' && /^ide-instrumentation\//.test(r.file)) {
        /* 計装自身のフレーム。rscattr.mjs が飛ばす（ここでも残しておくのは数のため） */
      } else continue;
      if (frames.length < MAX_FRAMES) frames.push({ functionName: fn, file: r.file, scope: r.scope, line: r.line, col: r.col });
    }
    entry = { at: typeof e.at === 'string' ? e.at.slice(0, 60) : 'unknown', frames, frameCount: e.frames.length };
  }
  return { spanId: o.spanId, traceId: o.traceId, target: String(o.target ?? ''), entry, pid };
}

/* ------------------------------------------------------- PoC-02 の照合器 */

type Attribution = {
  frame: { file: string; line: number; col: number; functionName: string | null } | null;
  generated?: { file: string; scope: string; line: number; col: number };
  verified: boolean;
  sourceLine: string | null;
  component: { name: string; file: string; line: number; endLine: number } | null;
  at: string | null;
  failure: { reason: string; detail: string } | null;
};
interface Resolver {
  resolveRscAttribution: (cs: unknown, comps: Map<string, unknown[]>, opts: { root: string }) => Attribution;
  resetSrvMaps: () => void;
}
let resolverMod: Promise<Resolver | null> | null = null;
let resolverError: string | null = null;

/** PoC-02 の rscattr.mjs / srvmap.mjs を実行時に読む（解析器を2つ持たない — 7B-3A の sqlparse と同じ） */
function resolver(): Promise<Resolver | null> {
  resolverMod ??= (async () => {
    try {
      const dir = path.join(ideRoot(), 'poc', 'runner', 'lib');
      const a = await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ path.join(dir, 'rscattr.mjs')) as Pick<Resolver, 'resolveRscAttribution'>;
      const m = await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ path.join(dir, 'srvmap.mjs')) as Pick<Resolver, 'resetSrvMaps'>;
      return { resolveRscAttribution: a.resolveRscAttribution, resetSrvMaps: m.resetSrvMaps };
    } catch (e) {
      resolverError = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e);
      return null;
    }
  })();
  return resolverMod;
}

/** 起動が変わったら、生成物のソースマップの索引を捨てる（前の起動の生成物で戻さない） */
export async function resetDataAccess(): Promise<void> {
  const r = resolverMod ? await resolverMod : null;
  r?.resetSrvMaps();
}

export function resolverStatus(): { available: boolean; reason: string | null } {
  return resolverError ? { available: false, reason: resolverError } : { available: true, reason: null };
}

/* ------------------------------------------------------------------ 照合 */

const CHECKS_POC02 = [
  '呼び出しの入口（pg-pool.Pool.query）で記録したスタックである（スパン開始時のスタックではない）',
  'スタックの上から、注入範囲（src/）のソースへソースマップで戻せた最初のフレーム',
  '戻した位置のソース行を読み直し、データ取得の呼び出しが書かれていることを確認',
  '囲むコンポーネントが、ソースの読み直しとビルド時の対応表で一致',
];
const CHECK_RECORD = 'この SQL のスパンに呼び出し位置の記録がちょうど1件あり、同じトレースのもの。書いたプロセスの PID が記録とスパンの両方にあり一致する';
const CHECK_SCOPE = '戻した位置が対象プロジェクトの src/ の中（シンボリックリンクで外へ出ない）';
const CHECK_FRESH = 'SQL の実行の後に、生成物・ソースマップ・ソースファイルのどれも書き換わっていない';

const mtimeOf = (abs: string): number | null => { try { return fs.statSync(abs).mtimeMs; } catch { return null; } };

/** 注入範囲の中か（`..`・絶対パス・シンボリックリンクで外へ出るものを拒む）。anchors.ts の safeSourcePath と同じ考え方 */
function insideScope(projectRoot: string, rel: string): string | null {
  if (!rel.startsWith(`${ANCHOR_SCOPE}/`) || rel.includes('\0') || rel.includes('\\')) return null;
  if (rel.split('/').some((s) => s === '..' || s === '.' || s === '' || s === 'node_modules')) return null;
  try {
    const realRoot = fs.realpathSync(projectRoot);
    const real = fs.realpathSync(path.resolve(projectRoot, rel));
    return real.startsWith(realRoot + path.sep) ? real : null;
  } catch { return null; }
}

export interface DataAccessInput {
  projectRoot: string;
  /** その SQL のスパンと、それを書いたプロセス（収集ファイルの proc.pid） */
  sql: { span: ObsSpan; pid: number | null }[];
  callsites: Map<string, CallsiteRecord[]>;
  /** ビルド時の対応表のコンポーネント範囲（要素識別子の注入が有効なときだけ） */
  manifest: Map<string, unknown[]> | null;
  /** この起動で呼び出し位置の記録を有効にしたか */
  enabled: boolean;
}

const fail = (
  span: ObsSpan, reason: DataAccessFailureReason, detail: string,
  extra: Partial<LiveDataAccess> = {},
): LiveDataAccess => ({
  spanId: span.spanId, traceId: span.traceId, at: null, site: null, located: null,
  failure: { reason, detail }, checks: [], ...extra,
});

/** SQL のスパンごとに、呼び出し位置を特定する（できなければ理由を返す。推測で埋めない） */
export async function resolveDataAccess(input: DataAccessInput): Promise<LiveDataAccess[]> {
  if (!input.sql.length) return [];
  if (!input.enabled) {
    return input.sql.map(({ span }) => fail(span, 'callsite-disabled', '起動先に呼び出し位置の記録を指示していません'));
  }
  const r = await resolver();
  if (!r) return input.sql.map(({ span }) => fail(span, 'resolver-unavailable', resolverError ?? '理由不明'));

  const out: LiveDataAccess[] = [];
  for (const { span, pid } of input.sql) {
    /* A. 記録がちょうど1件 */
    const recs = input.callsites.get(span.spanId) ?? [];
    if (!recs.length) { out.push(fail(span, 'no-callsite-record', 'この SQL のスパン ID の記録が収集ファイルにありません')); continue; }
    if (recs.length > 1) { out.push(fail(span, 'multiple-callsite-records', `記録が ${recs.length} 件あります`)); continue; }
    const rec = recs[0];
    /* B. 同じトレース・同じプロセス・SQL の記録。
     * 7B-3B-2: **PID は両方が存在して一致するときだけ通す。** 片方でも欠けていれば「同じプロセス」を
     * 確かめられないので、比べずに通すのではなく断定しない（7B-3B-1 は片方が欠けると照合を飛ばしていた） */
    if (rec.traceId !== span.traceId || rec.target !== 'sql') {
      out.push(fail(span, 'callsite-mismatch',
        rec.traceId !== span.traceId ? '記録のトレース ID が SQL のスパンと違います'
          : `記録の種類が SQL ではありません（${rec.target}）`,
        { at: rec.entry?.at ?? null }));
      continue;
    }
    if (rec.pid === null || pid === null) {
      out.push(fail(span, 'callsite-pid-missing',
        rec.pid === null && pid === null ? '呼び出し位置の記録にも SQL のスパンにも、書いたプロセスの PID がありません'
          : rec.pid === null ? '呼び出し位置の記録に、書いたプロセスの PID がありません'
            : 'SQL のスパンに、書いたプロセスの PID がありません',
        { at: rec.entry?.at ?? null }));
      continue;
    }
    if (rec.pid !== pid) {
      out.push(fail(span, 'callsite-mismatch', `記録を書いたプロセス（PID ${rec.pid}）が SQL のスパン（PID ${pid}）と違います`,
        { at: rec.entry?.at ?? null }));
      continue;
    }
    /* 1〜4. PoC-02 の照合（rscattr.mjs をそのまま呼ぶ） */
    let a: Attribution;
    try {
      a = r.resolveRscAttribution({ target: 'sql', entry: rec.entry, atSpanStart: [] }, input.manifest ?? new Map(), { root: input.projectRoot });
    } catch (e) {
      out.push(fail(span, 'resolver-unavailable', e instanceof Error ? e.message.slice(0, 160) : String(e), { at: rec.entry?.at ?? null }));
      continue;
    }
    const at = rec.entry?.at ?? null;
    const located = a.frame ? { file: a.frame.file, line: a.frame.line, col: a.frame.col } : null;

    /* C. 注入範囲の中 */
    let srcAbs: string | null = null;
    if (a.frame) {
      srcAbs = insideScope(input.projectRoot, a.frame.file);
      if (!srcAbs) { out.push(fail(span, 'outside-scope', `${a.frame.file} は src/ の中にありません`, { at, located })); continue; }
    }
    /* D. 実行の後に書き換わっていない（戻した位置があるときだけ確かめられる） */
    if (a.generated) {
      if (a.generated.scope !== 'build-output') {
        out.push(fail(span, 'build-freshness-unverified', `生成物 ${a.generated.file.slice(0, 80)} は仮想モジュールです`, { at, located }));
        continue;
      }
      const gen = path.join(input.projectRoot, a.generated.file);
      const tGen = Math.max(mtimeOf(gen) ?? Infinity, mtimeOf(`${gen}.map`) ?? 0);
      if (!(tGen <= span.startMs)) {
        out.push(fail(span, 'build-changed-after-call', `生成物が SQL の実行の ${Number.isFinite(tGen) ? `${Math.round(tGen - span.startMs)} ms 後` : '後（読めません）'}に書かれています`, { at, located }));
        continue;
      }
      const tSrc = srcAbs ? mtimeOf(srcAbs) : null;
      if (tSrc === null || !(tSrc <= span.startMs)) {
        out.push(fail(span, 'source-changed-after-call', `${a.frame?.file ?? 'ソース'} が SQL の実行の後に書き換わっています`, { at, located }));
        continue;
      }
    }
    if (a.failure || !a.frame || !a.verified || !a.component || !a.sourceLine) {
      const reason = (a.failure?.reason ?? 'component-not-agreed') as DataAccessFailureReason;
      const why = reason === 'component-not-agreed' && !input.manifest ? 'manifest-unavailable' : reason;
      out.push(fail(span, why, a.failure?.detail ?? '成立の条件が揃いませんでした', { at, located }));
      continue;
    }
    out.push({
      spanId: span.spanId, traceId: span.traceId, at,
      site: {
        file: a.frame.file, line: a.frame.line, col: a.frame.col,
        functionName: a.frame.functionName,
        sourceLine: a.sourceLine.length > 200 ? `${a.sourceLine.slice(0, 199)}…` : a.sourceLine,
        component: a.component,
      },
      located, failure: null,
      checks: [CHECK_RECORD, ...CHECKS_POC02, CHECK_SCOPE, CHECK_FRESH],
    });
  }
  return out;
}
