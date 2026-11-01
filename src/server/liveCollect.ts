/* =============================================================================
 * いまの起動の観測をまとめる（観測の API と、7B-3B-2 の由来の API が同じ手順を使う）。
 * 要求が指す起動が、いま実行中の開発サーバーと違えば観測を返さない（起動をまたいで混ぜない）。
 * ========================================================================== */
import { devServer, type DevServerSnapshot as RuntimeSnapshot } from './devServer';
import { observations } from './observations';
import { anchorOutDir, readManifestComponents } from './anchors';
import { pidAlive } from './net';
import type { RunKey } from '../lib/previewProtocol';
import { runKeyString, type LiveRunObservation } from '../lib/liveObservation';

export type CollectResult =
  | { ok: true; observation: LiveRunObservation; snapshot: RuntimeSnapshot }
  | { ok: false; code: 'stale-run' | 'no-session'; message: string };

export function isCurrentRun(s: RuntimeSnapshot, run: RunKey): boolean {
  return s.state === 'running' && s.pid !== null && s.startedAt !== null
    && s.instance === run.instance && s.pid === run.pid && s.startedAt === run.startedAt
    && pidAlive(s.pid);
}

export async function collectCurrent(run: RunKey): Promise<CollectResult> {
  const s = devServer().snapshot();
  if (!isCurrentRun(s, run) || !s.project || !s.port) {
    return {
      ok: false, code: 'stale-run',
      message: s.state === 'running'
        ? 'この要求は、いま実行中の開発サーバーとは別の起動を指しています。その観測は返しません。'
        : '開発サーバーは実行中ではありません。観測は返しません。',
    };
  }
  const ideOwned = s.instrumentation.state === 'enabled' && s.owner === 'ide';
  const observation = await observations().collect({
    run, runString: runKeyString(run), project: s.project.name, port: s.port,
    instrumentation: s.instrumentation,
    traceHeader: ideOwned,
    /* 7B-3B-1: SQL を実行した呼び出し位置の照合。対応表（コンポーネント範囲）は要素識別子の注入が有効なときだけ読む */
    dataAccess: {
      projectRoot: s.project.root,
      enabled: ideOwned,
      manifest: s.anchors?.state === 'enabled' ? readManifestComponents(anchorOutDir(s.project.root)) : null,
    },
  });
  if (!observation) {
    return { ok: false, code: 'no-session', message: 'この起動の観測セッションがありません（IDE の外で起動されたか、セッションが閉じられました）。' };
  }
  return { ok: true, observation, snapshot: s };
}
