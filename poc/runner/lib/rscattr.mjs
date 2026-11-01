/* =============================================================================
 * 「このSQL（またはサーバー内部の通信）を実行したのは、どの Server Component か」
 * の解決（PoC-02 Gate B）。
 *
 * 根拠にするのは **呼び出しの入口で取った呼び出しスタック** だけである。
 * 時刻の近さは使わない。SQL 文の一致も使わない。ページのパスも使わない。
 *
 * PoC-05 の B 項（ブラウザ側）とまったく同じ4段の条件を、サーバー側に移したもの。
 *
 *   1. 呼び出しの入口でスタックを取れている
 *      （スパン開始時のスタックでは代用しない。実測で呼び出し元が消えている）
 *   2. スタックの上から順に、注入範囲（src/）のソース位置へ戻せるフレームがある
 *   3. そのソース行を読み直すと、実際にデータ取得の呼び出しが書かれている
 *   4. その行を囲むコンポーネントが、**ソースの読み直し**と
 *      **ビルド時のマニフェスト**の両方で同じ名前に決まる
 *
 * 1つでも欠けたらノードも関係も作らない。理由を返す（FR-11b）。
 * ========================================================================== */
import { enclosingComponent, lineText } from './srcverify.mjs';
import { resolveServerFrame } from './srvmap.mjs';

/** 注入範囲。ここより外のフレームは「ユーザーのコード」として扱わない */
const SCOPE = 'src/';

/** 計装の自分自身のフレーム。根拠から外す */
const SELF = /^ide-instrumentation\//;

/**
 * 「その行が本当にデータ取得を呼んでいるか」の照合。
 * 種別ごとに別の正規表現を使う。**SQL のスパンに fetch の行を当ててはいけない。**
 */
const CALL_PATTERN = {
  sql: /\b(?:query|\$queryRaw|\$executeRaw|findMany|findFirst|findUnique|count|aggregate|groupBy)\s*[(`]/,
  'server-fetch': /\bfetch\s*\(/,
};

/**
 * スタックの上から順に、ユーザーのソース位置へ戻せる最初のフレームを探す。
 * **いちばん内側（呼び出しを書いた場所）を採る。** 外側へ遡って
 * 「結果的に原因となったコンポーネント」を指しにはいかない。
 */
function firstAppFrame(frames) {
  for (const f of frames) {
    if (!f || !f.file) continue;
    if (SELF.test(f.file)) continue;
    if (f.scope !== 'build-output' && f.scope !== 'bundler-virtual') continue;
    const pos = resolveServerFrame(f);
    if (!pos || !pos.file.startsWith(SCOPE)) continue;
    return { frame: f, resolved: pos };
  }
  return null;
}

/**
 * 1本のスパンについて、実行したコンポーネントを解決する。
 *
 * @param {{target:'sql'|'server-fetch', entry:{at:string, frames:object[]}|null,
 *          atSpanStart?:object[]}} callsite   計装が書いた callsite 記録
 * @param {Map<string, object[]>} manifestComponents  file → コンポーネント範囲
 */
export function resolveRscAttribution(callsite, manifestComponents) {
  const target = callsite?.target ?? null;
  const entry = callsite?.entry ?? null;
  const base = {
    target,
    at: entry?.at ?? null,
    frameCount: entry?.frames?.length ?? 0,
    /** 比較用: スパン開始時のスタックに、ユーザーのコードのフレームがあったか */
    appFrameAtSpanStart: (callsite?.atSpanStart ?? []).some(
      (f) => (f.scope === 'build-output' || f.scope === 'bundler-virtual') && !SELF.test(f.file || ''),
    ),
  };

  if (!entry || !entry.frames?.length) {
    return {
      ...base, frame: null, verified: false, sourceLine: null, component: null,
      failure: { reason: 'no-entry-callsite', detail: '呼び出しの入口でスタックを取れていない' },
    };
  }

  const hit = firstAppFrame(entry.frames);
  if (!hit) {
    return {
      ...base, frame: null, verified: false, sourceLine: null, component: null,
      failure: {
        reason: 'no-app-frame',
        detail: '注入範囲（src/）のソース位置へ戻せるフレームが無い',
      },
    };
  }
  const { file, line, col } = hit.resolved;

  /* 3. ソース行の読み直し */
  const text = lineText(file, line);
  const pattern = CALL_PATTERN[target] ?? CALL_PATTERN.sql;
  const verified = !!text && pattern.test(text);
  if (!verified) {
    return {
      ...base,
      frame: { file, line, col, functionName: hit.frame.functionName ?? null },
      verified: false, sourceLine: null, component: null,
      failure: {
        reason: 'source-line-mismatch',
        detail: 'その行にデータ取得の呼び出しが無い',
      },
    };
  }

  /* 4. 囲んでいるコンポーネント。独立した2つの情報源の一致を要求する */
  const bySource = enclosingComponent(file, line);
  const manifest = (manifestComponents.get(file) ?? [])
    .filter((c) => c.line <= line && line <= c.endLine)
    .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0] ?? null;
  const agree = !!bySource && !!manifest && bySource.name === manifest.name;
  if (!agree) {
    return {
      ...base,
      frame: { file, line, col, functionName: hit.frame.functionName ?? null },
      verified: true, sourceLine: text, component: null,
      failure: {
        reason: 'component-not-agreed',
        detail: `ソース読み直し=${bySource?.name ?? 'なし'} / マニフェスト=${manifest?.name ?? 'なし'}`,
      },
    };
  }

  return {
    ...base,
    frame: { file, line, col, functionName: hit.frame.functionName ?? null },
    verified: true,
    sourceLine: text,
    component: { name: bySource.name, file, line: bySource.line, endLine: bySource.endLine },
    failure: null,
  };
}
