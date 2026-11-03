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
 * 7C HMR 後の誤対応の安全対策（案A。docs/07c-hmr-lineage-guard-report.md）で足した照合（独立した3つの条件。どれか1つでも欠ければ断定しない）:
 *   A1. 呼び出しを書いたフレームより内側に、HMR で eval されたコードのフレーム（計装が V8 の CallSite.isEval() で印を付けた
 *       `evaluated`）・形を認識できないフレームが無い。印のフレームを飛ばして外側の生成物のフレームを採ることはしない。
 *       記録が V8 の判定で作られていなければ（frameSource ≠ v8-callsite）、印の有無を確かめられないので断定しない
 *   A2. その SQL が属する要求（同じトレースの受付スパン。ちょうど1本）の開始の FRESHNESS_MARGIN_MS 前より後に、
 *       生成物・ソースマップ・戻した先のソースのどれも書き換わっていない（同時刻は「書き換わった」とみなす）。
 *       要求の開始を確かめられなければ断定しない。**時刻の比較は同一性の証明ではない**（A1・A3 と併せて使う）
 *   A3. 位置を戻すのに使ったソースマップの**区画**の sourcesContent が、いまのソース（そのもの、または IDE が持つ
 *       要素識別子のローダの変換を同じ規則で当てたもの）とバイト単位で一致する。sourcesContent が無ければ一致とは扱わない
 * A1〜A3 のどれで止めた場合も、位置（site）も参考の位置（located）も返さない。
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
  /**
   * frameSource: 計装がフレームを何から作ったか（7C）。`v8-callsite` = V8 の呼び出し位置の API（CallSite）で、
   * eval されたコードを `isEval()` で判定した。それ以外・無しは、eval の印の有無を確かめられない
   */
  entry: { at: string; frames: CallsiteFrame[]; frameCount: number; frameSource: string | null } | null;
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
/** 根拠にしないと分かっているフレームの種別（ユーザーのコードではない）。読み飛ばす */
const NON_USER_SCOPES = new Set(['node_modules', 'node-builtin', 'outside', 'native']);
/**
 * 7C（A1）: その位置より外側のフレームを根拠にしてはいけない印。
 *   evaluated     HMR などで eval されたコード（計装が CallSite.isEval() で判定）。行・列がディスクの生成物の座標ではない
 *   unrecognized  種別を認識できないフレーム（計装・記録の形が変わった）。捨てると外側のフレームを誤って採りうる
 */
export const BARRIER_SCOPES = new Set(['evaluated', 'unrecognized']);
/** A1 で受け入れる記録の作り方 */
export const FRAME_SOURCE_V8 = 'v8-callsite';
/**
 * A2: 更新時刻の比較の幅（ミリ秒）。要求の開始のこの幅だけ前より後の書き換えも「処理中の変更」とみなす。
 * ファイルシステムの更新時刻の分解能（粗い時計で数 ms 古く付く・1〜2 秒単位のファイルシステム）と、
 * スパンの時刻（Date.now() に基づく）との差を吸収するため。安全側（未観測が増える側）にだけ倒れる
 */
export const FRESHNESS_MARGIN_MS = 2000;

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
      const r = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const fn = typeof r.functionName === 'string' ? r.functionName.slice(0, 80) : null;
      const scope = typeof r.scope === 'string' ? r.scope : null;
      /* 7C（A1）: 根拠にしないと分かっている種別だけを読み飛ばす。eval の印・未知の種別は**黙って捨てずに**、
       * 印のフレームとして順序どおりに残す（ファイル名は読まない。照合はこの位置より外側を使わない） */
      if (scope !== null && NON_USER_SCOPES.has(scope)) continue;
      if (scope === null || (!BARRIER_SCOPES.has(scope) && !['build-output', 'bundler-virtual', 'app-source'].includes(scope))
        || scope === 'unrecognized') {
        if (frames.length < MAX_FRAMES) frames.push({ functionName: fn, file: '<unrecognized>', scope: 'unrecognized', line: 0, col: 0 });
        continue;
      }
      if (scope === 'evaluated') {
        if (frames.length < MAX_FRAMES) {
          frames.push({ functionName: fn, file: '<evaluated>', scope: 'evaluated', line: isPos(r.line) ? r.line : 0, col: isPos(r.col) ? r.col : 0 });
        }
        continue;
      }
      if (typeof r.file !== 'string' || !isPos(r.line) || !isPos(r.col)) continue;
      if (r.scope === 'build-output') {
        if (!BUILD_FILE.test(r.file) || r.file.split('/').includes('..')) continue;
      } else if (r.scope === 'bundler-virtual') {
        if (!VIRTUAL_FILE.test(r.file) || r.file.length > 300) continue;
      } else if (r.scope === 'app-source' && /^ide-instrumentation\//.test(r.file)) {
        /* 計装自身のフレーム。rscattr.mjs が飛ばす（ここでも残しておくのは数のため） */
      } else continue;
      if (frames.length < MAX_FRAMES) frames.push({ functionName: fn, file: r.file, scope: r.scope, line: r.line, col: r.col });
    }
    const src = (e as { frameSource?: unknown }).frameSource;
    entry = {
      at: typeof e.at === 'string' ? e.at.slice(0, 60) : 'unknown', frames, frameCount: e.frames.length,
      frameSource: typeof src === 'string' && src.length <= 40 ? src : null,
    };
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
/** 7C（A3）: 位置を戻すのに使ったソースマップの区画の情報（srvmap.mjs の serverFrameProvenance） */
type Provenance = { file: string; line: number; col: number; sourceContent: string | null } | null;
interface Resolver {
  resolveRscAttribution: (cs: unknown, comps: Map<string, unknown[]>, opts: { root: string }) => Attribution;
  resetSrvMaps: () => void;
  serverFrameProvenance: (frame: { file: string; scope: string; line: number; col: number }, root: string) => Provenance;
  compareMapSource: (sourceContent: string, current: string, rel: string) => 'match' | 'mismatch' | 'unverified';
}
let resolverMod: Promise<Resolver | null> | null = null;
let resolverError: string | null = null;

/** PoC-02 の rscattr.mjs / srvmap.mjs を実行時に読む（解析器を2つ持たない — 7B-3A の sqlparse と同じ） */
function resolver(): Promise<Resolver | null> {
  resolverMod ??= (async () => {
    try {
      const dir = path.join(ideRoot(), 'poc', 'runner', 'lib');
      const a = await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ path.join(dir, 'rscattr.mjs')) as Pick<Resolver, 'resolveRscAttribution'>;
      const m = await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ path.join(dir, 'srvmap.mjs')) as Pick<Resolver, 'resetSrvMaps' | 'serverFrameProvenance' | 'compareMapSource'>;
      if (typeof m.serverFrameProvenance !== 'function' || typeof m.compareMapSource !== 'function') throw new Error('srvmap.mjs に A3 の照合（serverFrameProvenance / compareMapSource）がありません');
      return {
        resolveRscAttribution: a.resolveRscAttribution, resetSrvMaps: m.resetSrvMaps,
        serverFrameProvenance: m.serverFrameProvenance, compareMapSource: m.compareMapSource,
      };
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
const CHECK_A1 = '呼び出しを書いたフレームより内側に、HMR で eval されたコード（V8 の CallSite.isEval() で判定）・形を認識できないフレームが無い';
const CHECK_A2 = `その SQL が属する要求（同じトレースの受付スパン）の開始の ${FRESHNESS_MARGIN_MS / 1000} 秒前より後に、生成物・ソースマップ・戻した先のソースのどれも書き換わっていない`;
const CHECK_A3 = '位置を戻したソースマップの区画の sourcesContent が、いまのソース（要素識別子のローダの変換を同じ規則で当てたもの）とバイト単位で一致';

/**
 * 7C（A2）: その SQL が属する要求を、**同じトレースの受付スパン**（HTTP の受付・親なし）で特定する。
 * ちょうど1本で、SQL より前に始まっていること。まだ書かれていない（応答を送り終える前）・2本以上・時刻の向きが
 * 合わなければ特定しない（推測で補わない）。時刻の近さ・パスでは探さない
 */
export function requestOfSql(traceSpans: readonly ObsSpan[], sql: ObsSpan): { request: { spanId: string; startMs: number } | null; issue: string | null } {
  const roots = traceSpans.filter((s) => s.traceId === sql.traceId && s.kind === 1 && s.parentSpanId === null
    && s.scope.includes('instrumentation-http'));
  if (!roots.length) return { request: null, issue: '同じトレースの受付スパンがまだ収集ファイルにありません（応答を送り終える前など）' };
  if (roots.length > 1) return { request: null, issue: `同じトレースの受付スパンが ${roots.length} 本あり、1つに決まりません` };
  const r = roots[0];
  if (!Number.isFinite(r.startMs) || !(r.startMs <= sql.startMs)) return { request: null, issue: '受付スパンの開始が SQL の開始より後です（時刻の向きが合いません）' };
  return { request: { spanId: r.spanId, startMs: r.startMs }, issue: null };
}

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
  /**
   * その SQL のスパンと、それを書いたプロセス（収集ファイルの proc.pid）。
   * 7C（A2）: request = その SQL が属する要求（requestOfSql で特定した受付スパン）。無ければ断定しない
   */
  sql: { span: ObsSpan; pid: number | null; request?: { spanId: string; startMs: number } | null; requestIssue?: string | null }[];
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
  for (const { span, pid, request = null, requestIssue = null } of input.sql) {
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
    /* 7C（A1）: 実行したコードのフレーム。eval の印（または形を認識できないフレーム）より外側は照合に渡さない
     * （印のフレームを飛ばして呼び出し元の生成物のフレームを採らない）。印の有無を確かめられない記録は使わない */
    let entry = rec.entry;
    let barrier: CallsiteFrame | null = null;
    if (entry) {
      if (entry.frameSource !== FRAME_SOURCE_V8) {
        out.push(fail(span, 'frame-origin-unverified',
          entry.frameSource ? `記録の作り方が ${entry.frameSource.slice(0, 40)} です（V8 の CallSite.isEval() による判定ではない）` : '記録に作り方（frameSource）がありません',
          { at: entry.at }));
        continue;
      }
      const cut = entry.frames.findIndex((f) => BARRIER_SCOPES.has(f.scope));
      if (cut >= 0) {
        barrier = entry.frames[cut];
        entry = { ...entry, frames: entry.frames.slice(0, cut) };
      }
    }
    /* 1〜4. PoC-02 の照合（rscattr.mjs をそのまま呼ぶ） */
    let a: Attribution;
    try {
      a = r.resolveRscAttribution({ target: 'sql', entry, atSpanStart: [] }, input.manifest ?? new Map(), { root: input.projectRoot });
    } catch (e) {
      out.push(fail(span, 'resolver-unavailable', e instanceof Error ? e.message.slice(0, 160) : String(e), { at: rec.entry?.at ?? null }));
      continue;
    }
    const at = rec.entry?.at ?? null;
    /* A1: 印より内側に、ソースへ戻せるフレームが無い → 呼び出しを書いたのは印のフレームでありうる。位置を出さない */
    if (barrier && !a.frame) {
      out.push(barrier.scope === 'evaluated'
        ? fail(span, 'hmr-evaluated-code', `呼び出しの入口から ${rec.entry!.frames.indexOf(barrier) + 1} 番目のフレームが eval されたコード${barrier.functionName ? `（${barrier.functionName}）` : ''}です`, { at })
        : fail(span, 'unrecognized-frame', `呼び出しの入口から ${rec.entry!.frames.indexOf(barrier) + 1} 番目のフレームの形を認識できません`, { at }));
      continue;
    }
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
      /* 7C（A2）: 要求の開始から。D は「実行の後」だけを見ていた。要求の処理中（開始の直前の幅を含む）の書き換えも拒む */
      if (!request) {
        out.push(fail(span, 'request-start-unknown', requestIssue ?? 'この SQL が属する要求の受付スパンを特定していません', { at }));
        continue;
      }
      const since = request.startMs - FRESHNESS_MARGIN_MS;
      const changed = ([['生成物', mtimeOf(gen)], ['ソースマップ', mtimeOf(`${gen}.map`)], [a.frame?.file ?? 'ソース', tSrc]] as const)
        .filter(([what, t]) => (t === null ? what !== 'ソースマップ' : t >= since));
      if (changed.length) {
        out.push(fail(span, 'changed-during-request',
          `${changed.map(([w, t]) => (t === null ? `${w}（読めません）` : `${w}（要求の開始の ${Math.round(t - request.startMs)} ms ${t >= request.startMs ? '後' : '前'}）`)).join('・')} が書き換わっています`,
          { at }));
        continue;
      }
      /* 7C（A3）: 位置を戻した区画の sourcesContent と、いまのソースの内容 */
      if (a.frame && srcAbs) {
        let prov: Provenance = null;
        try { prov = r.serverFrameProvenance(a.generated, input.projectRoot); } catch { prov = null; }
        if (!prov || prov.file !== a.frame.file || prov.line !== a.frame.line || prov.col !== a.frame.col) {
          out.push(fail(span, 'map-source-unverified', '位置を戻したソースマップの区画を特定し直せません', { at }));
          continue;
        }
        if (typeof prov.sourceContent !== 'string') {
          out.push(fail(span, 'map-source-unverified', `${a.frame.file} の区画に sourcesContent がありません`, { at }));
          continue;
        }
        let current: string | null = null;
        try { current = fs.readFileSync(srcAbs, 'utf8'); } catch { current = null; }
        const cmp = current === null ? 'unverified' : r.compareMapSource(prov.sourceContent, current, a.frame.file);
        if (cmp !== 'match') {
          out.push(cmp === 'mismatch'
            ? fail(span, 'map-source-mismatch', `${a.frame.file} の区画の sourcesContent が、いまのソース（とそのローダの変換結果）のどちらとも一致しません`, { at })
            : fail(span, 'map-source-unverified', `${a.frame.file} の内容を比べられません（ソースを読めない・ローダの変換器を読み込めない）`, { at }));
          continue;
        }
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
      checks: [CHECK_RECORD, CHECK_A1, ...CHECKS_POC02, CHECK_SCOPE, CHECK_FRESH, CHECK_A2, CHECK_A3],
    });
  }
  return out;
}
