/* =============================================================================
 * 計測記録のうち、報告とテストに必要な部分だけを docs/ へ書き出す。
 *
 * poc/out/ は .gitignore されている。判定の根拠がリポジトリに残らないと
 * 報告書の数値を後から確かめられないので、**絶対パスを落とした要約**を残す。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './util.mjs';

/** ローカルの絶対パスを持ち出さない */
const clean = (s) => (typeof s === 'string' ? s.replace(/file:\/\/\/[^\s"')]*/g, '<local-path>') : s);

export function writeMatrixDoc(result) {
  const out = {
    poc: result.poc,
    collectedAt: result.collectedAt,
    note: 'poc/runner/poc03.mjs の計測記録の要約。絶対パスは落としてある。'
      + '全文は poc/out/poc03.json（.gitignore 済み）。',
    buildTime: result.buildTime,
    byBundler: {},
  };
  for (const [b, x] of Object.entries(result.byBundler)) {
    out.byBundler[b] = {
      facts: {
        startupMs: x.facts.startupMs,
        pages: x.facts.pages,
        ownerStack: clean(x.facts.ownerStack),
        clickCount: x.facts.clickCount,
      },
      manifest: x.manifest,
      summary: x.summary,
      targets: x.targets.map((t) => ({
        key: t.key, group: t.group, page: t.page, sel: t.sel, ord: t.ord,
        primary: t.primary, expect: t.expect,
        observed: t.observed,
        method1: t.method1,
        method1Verdict: t.method1Verdict,
        sourceLine: t.sourceLine,
        method2: t.method2.status === 'resolved'
          ? { status: 'resolved', file: t.method2.file, line: t.method2.line, via: t.method2.via }
          : { status: t.method2.status, tried: (t.method2.tried ?? []).map((y) => clean(y.url ?? '')) },
        method2Verdict: t.method2Verdict,
        react: t.react && {
          hostKeys: t.react.hostKeys,
          fiber: t.react.fiber,
          hasDebugSource: t.react.hasDebugSource,
          hasDebugStack: t.react.hasDebugStack,
          hasDebugOwner: t.react.hasDebugOwner,
          debugOwnerName: t.react.debugOwnerName,
          returnChainOwnerName: t.react.returnChainOwnerName,
          propsHasSource: t.react.propsHasSource,
        },
      })),
    };
  }
  const file = path.join(REPO, 'docs', '06b-poc03-matrix.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  return file;
}
