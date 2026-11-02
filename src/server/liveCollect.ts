/* =============================================================================
 * いまの起動の観測をまとめる（観測の API と、7B-3B-2 の由来の API が同じ手順を使う）。
 * 要求が指す起動が、いま実行中の開発サーバーと違えば観測を返さない（起動をまたいで混ぜない）。
 * ========================================================================== */
import { devServer, type DevServerSnapshot as RuntimeSnapshot } from './devServer';
import { observations } from './observations';
import { anchorOutDir, readManifestComponents } from './anchors';
import { pidAlive } from './net';
import type { RunKey } from '../lib/previewProtocol';
import { runKeyString, type ExchangeHistory, type LiveRunObservation } from '../lib/liveObservation';

export type CollectResult =
  | {
    ok: true;
    /** 保持しているすべての通信の証拠（サーバーの中で使う。画面へは observationView で絞って返す） */
    observation: LiveRunObservation;
    snapshot: RuntimeSnapshot;
    /** 7C-1: 保持範囲から外した通信の記録（サーバーの中だけ） */
    history: ExchangeHistory;
    /** 7C-1: 通信の保持を頼む（表示中・同定した通信） */
    pin: (seqs: readonly number[]) => void;
  }
  | { ok: false; code: 'stale-run' | 'no-session'; message: string };

export function isCurrentRun(s: RuntimeSnapshot, run: RunKey): boolean {
  return s.state === 'running' && s.pid !== null && s.startedAt !== null
    && s.instance === run.instance && s.pid === run.pid && s.startedAt === run.startedAt
    && pidAlive(s.pid);
}

export async function collectCurrent(run: RunKey, opts: { pin?: readonly number[] } = {}): Promise<CollectResult> {
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
  const store = observations();
  const runString = runKeyString(run);
  /* 7C-1: 画面が表示中の通信の保持を、読み取りの整理より先に頼み直す（整理で外さないため） */
  if (opts.pin?.length) store.pin(runString, opts.pin);
  const observation = await store.collect({
    run, runString, project: s.project.name, port: s.port,
    instrumentation: s.instrumentation,
    traceHeader: ideOwned,
    /* 7B-3B-1: SQL を実行した呼び出し位置の照合。対応表（コンポーネント範囲）は要素識別子の注入が有効なときだけ読む */
    dataAccess: {
      projectRoot: s.project.root,
      enabled: ideOwned,
      manifest: s.anchors?.state === 'enabled' ? readManifestComponents(anchorOutDir(s.project.root)) : null,
    },
  });
  const history = store.history(runString);
  if (!observation || !history) {
    return { ok: false, code: 'no-session', message: 'この起動の観測セッションがありません（IDE の外で起動されたか、セッションが閉じられました）。' };
  }
  return { ok: true, observation, snapshot: s, history, pin: (seqs) => store.pin(runString, seqs) };
}
