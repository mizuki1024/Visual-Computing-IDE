/* =============================================================================
 * 「この通信を開始したコードはどこか」の解決（PoC-05 の B 項）。
 *
 * 根拠にするのは **ブラウザが要求を送る時点で記録したスタック**（CDP の
 * `Network.requestWillBeSent` の `initiator`）だけである。時刻は使わない。
 * DOM 上の要素の近さも使わない。
 *
 * 成立の条件（1つでも欠けたら対応付けを作らない）:
 *   1. initiator の種別が script であり、スタックを持つ
 *   2. スタックの上から順に、注入範囲（src/）のソース位置へ解決できるフレームがある
 *   3. そのソース行を読み直すと、実際に通信の呼び出し（fetch）が書かれている
 *   4. その行を囲むコンポーネントが、**ソースの読み直し**と
 *      **ビルド時のマニフェスト**の両方で同じ名前に決まる
 *
 * ソースマップは「生成物 → 元の位置」の決定的な写像であり、推測ではない。
 * ただし開発ビルドの生成物に依存する（PoC-03 C-5 と同じ制約）。
 * ========================================================================== */
import { enclosingComponent, lineText } from './srcverify.mjs';
import { originalPositionFor } from './srcmap.mjs';

/** 注入範囲。ここより外のフレームは「ユーザーのコード」として扱わない */
const SCOPE = 'src/';

/** 元ソース名の正規化。バンドラごとに接頭辞が違うので、src/ 以下だけを取る */
export function normalizeSource(source) {
  if (!source) return null;
  const s = String(source).replace(/\\/g, '/');
  // turbopack:///[project]/src/... / webpack://_N_E/./src/... / file:///…/src/…
  const m = /(?:^|\/)(src\/[^?]*\.(?:tsx|ts|jsx|js))(?:$|\?)/.exec(s);
  if (!m) return null;
  if (s.includes('node_modules')) return null;
  return m[1];
}

/**
 * 生成物とソースマップの取得。1プロセス内でキャッシュする。
 * @param {(scriptId:string)=>Promise<string|null>} [scriptSource]
 *   HTTP で取れないスクリプト（webpack の eval されたモジュール）用の退避路
 */
export function makeFetcher(scriptSource) {
  const scripts = new Map();
  const maps = new Map();

  async function mapFor(url, scriptId) {
    const key = `${url}#${scriptId ?? ''}`;
    if (maps.has(key)) return maps.get(key);
    let map = null;
    try {
      let body = scripts.get(key);
      if (body === undefined) {
        if (/^https?:/.test(url)) {
          const r = await fetch(url);
          body = r.ok ? await r.text() : null;
        } else {
          body = scriptId && scriptSource ? await scriptSource(scriptId) : null;
        }
        scripts.set(key, body);
      }
      if (body) {
        const m = /[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/m.exec(body);
        if (m) {
          const ref = m[1];
          if (ref.startsWith('data:')) {
            const b64 = ref.slice(ref.indexOf(',') + 1);
            map = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
          } else if (/^https?:/.test(url)) {
            const abs = new URL(ref, url).toString();
            const r2 = await fetch(abs);
            if (r2.ok) map = await r2.json();
          }
        }
      }
    } catch { map = null; }
    maps.set(key, map);
    return map;
  }
  return { mapFor };
}

/**
 * スタックの先頭から順に、ユーザーのソース位置へ解決できる最初のフレームを探す。
 * @returns {{frame, resolved}|null}
 */
async function firstAppFrame(frames, fetcher, origin) {
  for (const f of frames) {
    if (!f.url || !f.line) continue;
    // 同一オリジンの生成物か、バンドラ内部の仮想URL（webpack-internal:）だけを見る
    const own = f.url.startsWith(origin) || f.url.startsWith('webpack-internal:');
    if (!own) continue;
    const map = await fetcher.mapFor(f.url, f.scriptId);
    if (!map) continue;
    const pos = originalPositionFor(map, f.line, (f.col ?? 1) - 1);
    const file = normalizeSource(pos?.source);
    if (!file || !file.startsWith(SCOPE)) continue;
    return { frame: f, resolved: { file, line: pos.line, col: pos.column } };
  }
  return null;
}

/**
 * 1件の通信について、開始したコードとコンポーネントを解決する。
 * 解決できない場合は理由を返す（無反応にしない — FR-11b）。
 *
 * @param {object} rec        netobs.mjs の記録1件
 * @param {object} fetcher    makeFetcher()
 * @param {string} origin     http://localhost:3200
 * @param {Map<string,object[]>} manifestComponents  file → コンポーネント範囲
 */
export async function resolveInitiator(rec, fetcher, origin, manifestComponents) {
  const type = rec.initiator?.type ?? null;
  const frames = rec.initiator?.frames ?? [];
  const base = { type, frameCount: frames.length };

  if (type !== 'script' || !frames.length) {
    return { ...base, frame: null, verified: false, sourceLine: null, component: null,
      failure: { reason: 'no-script-stack', detail: `initiator.type=${type ?? 'null'}` } };
  }
  const hit = await firstAppFrame(frames, fetcher, origin);
  if (!hit) {
    return { ...base, frame: null, verified: false, sourceLine: null, component: null,
      failure: { reason: 'no-app-frame', detail: '注入範囲（src/）のソース位置へ解決できるフレームが無い' } };
  }
  const { file, line, col } = hit.resolved;

  // 3. ソース行の読み直し。実際に通信の呼び出しが書かれているか
  const text = lineText(file, line);
  const verified = !!text && /\bfetch\s*\(/.test(text);
  if (!verified) {
    return { ...base, frame: { file, line, col, functionName: hit.frame.functionName },
      verified: false, sourceLine: null, component: null,
      failure: { reason: 'source-line-mismatch', detail: 'その行に通信の呼び出しが無い' } };
  }

  // 4. 囲んでいるコンポーネント。独立した2つの情報源の一致を要求する
  const bySource = enclosingComponent(file, line);
  const manifest = (manifestComponents.get(file) ?? [])
    .filter((c) => c.line <= line && line <= c.endLine)
    .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0] ?? null;
  const agree = !!bySource && !!manifest && bySource.name === manifest.name;
  if (!agree) {
    return { ...base, frame: { file, line, col, functionName: hit.frame.functionName },
      verified: true, sourceLine: text, component: null,
      failure: {
        reason: 'component-not-agreed',
        detail: `ソース読み直し=${bySource?.name ?? 'なし'} / マニフェスト=${manifest?.name ?? 'なし'}`,
      } };
  }

  return {
    ...base,
    frame: { file, line, col, functionName: hit.frame.functionName },
    verified: true,
    sourceLine: text,
    component: { name: bySource.name, file, line: bySource.line, endLine: bySource.endLine },
    failure: null,
  };
}
