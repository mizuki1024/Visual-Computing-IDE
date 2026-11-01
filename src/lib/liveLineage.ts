/* =============================================================================
 * Phase 7B-3B-2 — 選択した要素の値の由来（`supplies`）を、静的解析と実測の照合で評価する（純粋な層）。
 *
 * **静的解析は PoC-04 の `poc/runner/lib/lineage.mjs` をそのまま使う**（解析器を作り直さない）。
 * この関数はその結果（`analyzeLineage` の sites / queries）と `resolveLineage` を引数で受け取り、
 * いまの起動の観測（文書の同定・呼び出し位置・実行SQL の SELECT 句）と照合するだけである。
 *
 * `supplies` を作る条件（1つでも欠ければ作らず、どの段の条件が欠けたかを返す）
 *   文書     1. 選択した要素を描いた文書が、中継の記録の1件に同定できる（bindDocument）
 *   静的解析 2. 要素識別子が指す JSX 要素（ファイル・行・列）の**直下**に、値を描く式がちょうど1つある
 *               （固定の文字と混在しない。静的解析が見た描画位置と要素の位置が列まで一致）
 *            3. 解析した時点のソースが、その文書を取得した後に書き換わっていない
 *            4. 参照の連鎖が、**1つの**データ取得の呼び出しの結果に届く（R1〜R4 は lineage.mjs が守る）
 *   実測     5. その呼び出し位置（ファイル・行・メソッド名の列）で、**その文書の通信の中で**実行された SQL が
 *               あり、その SQL の実行位置を server-call-stack で特定できている（R5: 走っていない SQL の列は使わない）
 *            6. 同じ位置から SELECT 句の構成が違う SQL が走っていない
 *   SELECT 句 7. 参照の鍵が、実行された SQL の SELECT 句にある（R6。無ければテーブルも主張しない）
 *
 * 根拠にしないもの: 値の一致・実行時刻の近さ・SQL 文の一致・ソース上の SQL リテラル・
 * ページのパス・コンポーネントの名前の一致・同じコンポーネントの中にあること。
 * 結論はつねに L2（推定）。実測との照合を通っても昇格しない。
 * ========================================================================== */
import {
  LINEAGE_CUT_LABEL, DOC_UNBOUND_LABEL,
  type DocBinding, type LineageCutReason, type LiveLineage, type LiveLineageCandidate, type LiveRunObservation,
} from './liveObservation';
import { liveExchangeLinks } from './adapter';

export const LINEAGE_METHOD = 'PoC-04 の静的解析（TypeScript の AST と記号解決による参照の連鎖）＋ 実行された SQL の SELECT 句';

/* ---------------------------------------- lineage.mjs が返す形（使う項目だけ） */
export interface LinRef { queryId: string; kind: 'field' | 'anyfield'; name: string | null; trail: string[] }
export interface LinSite {
  file: string; line: number; col: number; component: string | null; expr: string;
  element: { file: string; line: number; col: number; tag: string; textChildren: number; exprChildren: number } | null;
  transformed: boolean; refs: LinRef[]; literalCount: number; unknowns: { why: string; trail: string[] }[];
}
export interface LinQuery { id: string; file: string; line: number; col: number; nameLine: number; nameCol: number; method: string }
export interface LinAnalysis { sites: LinSite[]; queries: LinQuery[]; scope: string }
export interface LinSqlEntry {
  spanId: string; selectOk: boolean; selectStar: boolean; parseOk: boolean;
  tables: { schema: string | null; name: string }[];
  items: { key: string; resolved: { schema: string; table: string; column: string } | null }[];
}
export interface LinResolution {
  outcome: 'confirmed' | 'candidates' | 'table-only' | 'none';
  candidates: { schema: string; table: string; column: string; queryId: string; via: 'field' | 'anyfield'; trail: string[]; note?: string }[];
  tableCandidates: { schema: string; name: string; why: string }[];
  unresolved: { why: string }[];
  transformed: boolean;
  reasons: string[];
}
export type ResolveLineage = (site: LinSite, sqlByQuery: Map<string, LinSqlEntry>) => LinResolution;

export interface EvaluateLineageInput {
  obs: LiveRunObservation;
  binding: DocBinding;
  /** 要素識別子が指す、照合済みの JSX 要素の位置（7B-2 の6段の照合を通ったもの）。無ければ null */
  anchor: { file: string; line: number; col: number; tag: string; component: string } | null;
  /** 静的解析の結果。解析器を使えなければ null（理由は analyzerError） */
  analysis: LinAnalysis | null;
  analyzerError?: string | null;
  resolveLineage: ResolveLineage | null;
  /** 文書の取得の後に書き換わったソース（相対パス）。空なら書き換わっていない */
  changedAfter: (sinceMs: number) => string[];
  /** lineage.mjs の LINEAGE_REASON（解決できなかった参照の文言） */
  reasonText?: Record<string, string>;
}

const samePos = (a: { file: string; line: number; col: number }, b: { file: string; line: number; col: number }) =>
  a.file === b.file && a.line === b.line && a.col === b.col;

export function evaluateLineage(input: EvaluateLineageInput): LiveLineage {
  const { obs, binding, anchor, analysis } = input;
  const out: LiveLineage = {
    method: LINEAGE_METHOD, scope: analysis?.scope ?? 'src/',
    status: 'cut', cut: null, binding,
    site: null, fetch: null, staticFetches: [], exchangeSeq: null, sqlSpanIds: [],
    outcome: 'none', candidates: [], tableCandidates: [], transformed: false, literalPaths: 0,
    untracked: [], unresolved: [], reasons: [], checks: [],
  };
  const cut = (reason: LineageCutReason, detail = ''): LiveLineage => ({
    ...out, status: 'cut', cut: { reason, stage: LINEAGE_CUT_LABEL[reason].stage, detail },
  });

  /* ---------------------------------------------------------- 1. 文書の同定 */
  if (binding.status !== 'identified') {
    return cut('document-unidentified', `${DOC_UNBOUND_LABEL[binding.reason]}${binding.detail ? `（${binding.detail}）` : ''}`);
  }
  const ex = obs.exchanges.find((e) => e.seq === binding.seq);
  if (!ex) return cut('document-unidentified', `通信 #${binding.seq} がこの観測にありません`);
  out.exchangeSeq = ex.seq;
  out.checks.push(`選択した要素を描いた文書を、中継の記録の通信 #${ex.seq}（${ex.method} ${ex.path}）に同定（応答ごとの文書の識別子）`);

  /* ---------------------------------------------------------- 2〜4. 静的解析 */
  if (!anchor) return cut('selection-unresolved');
  if (!analysis || !input.resolveLineage) return cut('analyzer-unavailable', input.analyzerError ?? '');
  const changed = input.changedAfter(ex.startMs);
  if (changed.length) {
    return cut('source-changed-after-run', `${changed.slice(0, 3).join(' / ')}${changed.length > 3 ? ` ほか ${changed.length - 3} 件` : ''}`);
  }
  const inElement = analysis.sites.filter((s) => s.element && samePos(s.element, anchor));
  if (!inElement.length) {
    return cut('no-value-site', `${anchor.file}:${anchor.line}:${anchor.col} の <${anchor.tag}>`);
  }
  const el = inElement[0].element!;
  if (el.tag !== anchor.tag) return cut('no-value-site', `静的解析の要素は <${el.tag}>、要素識別子は <${anchor.tag}>`);
  if (el.textChildren > 0) return cut('mixed-text-children', `固定の文字 ${el.textChildren} 箇所・式 ${el.exprChildren} 個`);
  if (inElement.length > 1 || el.exprChildren > 1) return cut('multiple-value-sites', `式 ${Math.max(inElement.length, el.exprChildren)} 個`);
  const site = inElement[0];
  if (site.component !== anchor.component) {
    return cut('no-value-site', `静的解析が見た囲むコンポーネント（${site.component ?? 'なし'}）が、要素識別子の照合（${anchor.component}）と違います`);
  }
  out.site = {
    file: site.file, line: site.line, col: site.col, component: site.component, expr: site.expr,
    element: { file: el.file, line: el.line, col: el.col, tag: el.tag },
  };
  out.transformed = site.transformed;
  out.literalPaths = site.literalCount;
  out.untracked = site.unknowns.map((u) => ({ why: u.why, detail: u.trail.length ? u.trail.join(' ← ') : null }));
  out.checks.push(`要素識別子が指す <${anchor.tag}>（${anchor.file}:${anchor.line}:${anchor.col}）の直下に、値を描く式がちょうど1つ（${site.expr} — ${site.file}:${site.line}:${site.col}）。静的解析が見た描画位置と列まで一致`);
  out.checks.push('解析したソースは、その文書を取得した後に書き換わっていない');

  const qids = [...new Set(site.refs.map((r) => r.queryId))];
  const qOf = (id: string) => analysis.queries.find((q) => q.id === id) ?? null;
  out.staticFetches = qids.map(qOf).filter((q): q is LinQuery => !!q)
    .map((q) => ({ file: q.file, line: q.nameLine, col: q.nameCol, measured: false }));
  if (!qids.length) {
    const whys = [...new Set(site.unknowns.map((u) => u.why))];
    return cut('no-reference', [
      site.literalCount ? `固定値の経路 ${site.literalCount} 本` : '',
      whys.length ? `追えない経路: ${whys.join(' / ')}` : '',
      !site.literalCount && !whys.length ? '参照なし' : '',
    ].filter(Boolean).join('。'));
  }
  if (qids.length > 1) {
    return cut('multiple-fetch-sites', out.staticFetches.map((q) => `${q.file}:${q.line}:${q.col}`).join(' / '));
  }
  const q = qOf(qids[0]);
  if (!q) return cut('no-reference', '参照した取得の呼び出しが解析結果にありません');
  out.checks.push(`参照の連鎖が1つのデータ取得の呼び出し（${q.file}:${q.nameLine}:${q.nameCol}）の結果に届く（PoC-04 の保守規則 R1〜R4）`);

  /* ---------------------------------------------------------- 5〜6. 実測との照合 */
  const links = liveExchangeLinks(obs, ex);
  if (!links.server) return cut('no-server-link', links.reason ?? '');
  const das = links.sql.map((sp) => ({ sp, d: obs.dataAccess?.find((x) => x.spanId === sp.spanId && x.traceId === sp.traceId) ?? null }));
  const at = { file: q.file, line: q.nameLine, col: q.nameCol };
  const hits = das.filter(({ d }) => d?.site && samePos(d.site, at));
  if (!hits.length) {
    const located = das.find(({ d }) => d && !d.site && d.located && samePos(d.located, at));
    if (located) {
      return cut('fetch-site-unverified', `${q.file}:${q.nameLine}:${q.nameCol} — ${located.d!.failure?.reason ?? '理由不明'}`);
    }
    return cut('fetch-not-measured',
      `${q.file}:${q.nameLine}:${q.nameCol}。この文書の通信で実行位置を特定した SQL: ${
        das.filter(({ d }) => d?.site).map(({ d }) => `${d!.site!.file}:${d!.site!.line}:${d!.site!.col}`).join(' / ') || 'なし'}`);
  }
  out.staticFetches = out.staticFetches.map((f) => ({ ...f, measured: true }));
  const entries: LinSqlEntry[] = hits.map(({ sp }) => {
    const a = obs.sqlAnalyses.find((x) => x.spanId === sp.spanId);
    const items = (a?.selectItems ?? [])
      .filter((i) => i.kind !== 'star' && i.key !== null)
      .map((i) => ({ key: i.key as string, resolved: i.resolved ?? null }));
    return {
      spanId: sp.spanId,
      parseOk: !!a?.parseOk,
      selectOk: !!a?.parseOk && a.statementType === 'select' && !a.setOperation,
      selectStar: !!a?.selectStar,
      tables: (a?.tables ?? []).filter((t) => !t.op || t.op === 'select').map((t) => ({ schema: t.schema ?? null, name: t.name })),
      items,
    };
  });
  const sig = (e: LinSqlEntry) => `${e.selectOk}|${e.selectStar}|${e.items.map((i) => `${i.key}=${i.resolved ? `${i.resolved.schema}.${i.resolved.table}.${i.resolved.column}` : '-'}`).sort().join(',')}`;
  if (new Set(entries.map(sig)).size > 1) return cut('select-list-differs', `${entries.length} 本`);
  const d0 = hits[0].d!;
  out.fetch = { file: d0.site!.file, line: d0.site!.line, col: d0.site!.col, component: d0.site!.component.name };
  out.sqlSpanIds = entries.map((e) => e.spanId);
  out.checks.push(`その呼び出し位置で実行された SQL ${entries.length} 本を、この文書の通信の中で観測し、実行位置を呼び出しスタック（server-call-stack）で列まで特定（R5）`);

  /* ---------------------------------------------------------- 7. SELECT 句 */
  const res = input.resolveLineage(site, new Map([[q.id, entries[0]]]));
  const reasonText = input.reasonText ?? {};
  out.outcome = res.outcome;
  out.transformed = res.transformed;
  out.reasons = res.reasons;
  out.unresolved = res.unresolved.map((u) => ({ why: u.why, text: reasonText[u.why] ?? u.why }));
  out.tableCandidates = res.tableCandidates.map((t) => ({ schema: t.schema, name: t.name, why: t.why }));
  out.candidates = res.candidates.map((c): LiveLineageCandidate => ({
    schema: c.schema, table: c.table, column: c.column, via: c.via, note: c.note ?? null,
    query: { file: q.file, line: q.nameLine, col: q.nameCol }, trail: c.trail,
  }));
  if (res.outcome === 'none') {
    const r = res.unresolved.find((u) => u.why === 'field-not-in-select-list' || u.why === 'select-list-parse-failed');
    return cut(r ? 'no-column' : 'no-reference', out.unresolved.map((u) => u.text).join(' / ') || res.reasons.join(' / '));
  }
  out.checks.push(res.outcome === 'table-only'
    ? '参照している取得のテーブルは実行された SQL から決まる（列は決まらない）'
    : `参照の鍵が、実行された SQL の SELECT 句にある（R6。候補 ${out.candidates.length} 件）`);
  return { ...out, status: 'linked', cut: null };
}
