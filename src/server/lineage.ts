/* =============================================================================
 * Phase 7B-3B-2 — PoC-04 の静的解析（`poc/runner/lib/lineage.mjs`）を、IDE が起動したプロジェクトに対して実行する。
 *
 * **解析器は作り直さない。** lineage.mjs に対象の場所を引数で渡せるようにしただけで、
 * 保守規則 R1〜R6・白表・記号解決はそのまま使う（rscattr.mjs / sqlparse.mjs と同じ使い方）。
 *
 * 守っていること
 *   - 解析の結果は **ソースの状態（ファイルの一覧・更新時刻・大きさ）が同じ間だけ**使い回す
 *   - 解析した時点のソースが、選択した文書の取得の**後に**書き換わっていれば、その解析を由来の根拠にしない
 *     （`changedAfter`。実行したコードと解析したコードが同じとは限らないため）
 *   - 対象プロジェクトには書き込まない。読むのは src/（と lineage.mjs が読む vendor-ui/）のソースだけ
 *   - ソース全文を返さない。返すのは描いている式1つ（最大 90 文字）と参照の連鎖（位置と名前）だけ
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { ideRoot } from './ide';
import { ANCHOR_SCOPE } from './anchors';
import type { LinAnalysis, ResolveLineage } from '../lib/liveLineage';

interface LineageMod {
  analyzeLineage: (opt: { root: string; scope: string }) => LinAnalysis & { files: string[] };
  resolveLineage: ResolveLineage;
  LINEAGE_REASON: Record<string, string>;
}
let mod: Promise<LineageMod | null> | null = null;
let modError: string | null = null;

/** lineage.mjs を実行時に読む（画面のバンドルに入れない。7B-3A の sqlparse.mjs と同じ） */
export function lineageAnalyzer(): Promise<LineageMod | null> {
  mod ??= (async () => {
    try {
      const file = path.join(ideRoot(), 'poc', 'runner', 'lib', 'lineage.mjs');
      return await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ file) as LineageMod;
    } catch (e) {
      modError = e instanceof Error ? e.message.split('\n')[0].slice(0, 200) : String(e);
      return null;
    }
  })();
  return mod;
}
export const lineageAnalyzerError = (): string | null => modError;

const SOURCE_DIRS = [ANCHOR_SCOPE, 'vendor-ui'];
const SRC_EXT = /\.(tsx?|jsx?|mjs)$/;

/** 解析の対象になるソースの一覧と状態（相対パス → 更新時刻・大きさ）。シンボリックリンクはたどらない */
function sourceState(root: string): Map<string, { mtimeMs: number; size: number }> {
  const out = new Map<string, { mtimeMs: number; size: number }>();
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && SRC_EXT.test(e.name) && !e.name.endsWith('.d.ts')) {
        try {
          const st = fs.statSync(p);
          out.set(path.relative(root, p).split(path.sep).join('/'), { mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* 消えた */ }
      }
    }
  };
  for (const d of SOURCE_DIRS) walk(path.join(/* turbopackIgnore: true */ root, d));
  return out;
}

const sig = (m: Map<string, { mtimeMs: number; size: number }>): string =>
  [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}|${v.mtimeMs}|${v.size}`).join('\n');

let cache: { root: string; sig: string; analysis: LinAnalysis; state: Map<string, { mtimeMs: number; size: number }> } | null = null;

export interface ProjectLineage {
  analysis: LinAnalysis | null;
  error: string | null;
  resolveLineage: ResolveLineage | null;
  reasonText: Record<string, string>;
  /** 指定した時刻の後に書き換わったソース（相対パス）。解析に使った状態で判定する */
  changedAfter: (sinceMs: number) => string[];
}

/** 対象プロジェクトを解析する（ソースの状態が変わっていなければ前の結果を使う） */
export async function analyzeProject(root: string): Promise<ProjectLineage> {
  const m = await lineageAnalyzer();
  if (!m) {
    return { analysis: null, error: modError ?? '理由不明', resolveLineage: null, reasonText: {}, changedAfter: () => [] };
  }
  const state = sourceState(root);
  const s = sig(state);
  if (!cache || cache.root !== root || cache.sig !== s) {
    try {
      const a = m.analyzeLineage({ root, scope: `${ANCHOR_SCOPE}/` });
      cache = { root, sig: s, analysis: { sites: a.sites, queries: a.queries, scope: a.scope }, state };
    } catch (e) {
      return {
        analysis: null, error: e instanceof Error ? e.message.slice(0, 200) : String(e),
        resolveLineage: null, reasonText: {}, changedAfter: () => [],
      };
    }
  }
  const used = cache.state;
  return {
    analysis: cache.analysis,
    error: null,
    resolveLineage: m.resolveLineage,
    reasonText: m.LINEAGE_REASON,
    changedAfter: (sinceMs: number) => [...used].filter(([, v]) => v.mtimeMs > sinceMs).map(([k]) => k).sort(),
  };
}

/** 試験用: 使い回しを捨てる */
export function resetLineageCache(): void { cache = null; }
