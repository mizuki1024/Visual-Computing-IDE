/* =============================================================================
 * 視覚編集 E2.1 — 開発用の同期の単一実体（devServer・previewGateway と同じく globalThis に置く）。
 * VCIDE_EDIT_SYNC_DEV=1 で IDE を起動したときだけ使う。無効なら null（API は 404・中継は E2 までと同じスクリプト）。
 * ========================================================================== */
import { devServer } from '../devServer';
import { pidAlive } from '../net';
import { runKeyString } from '../../lib/liveObservation';
import { EditRelayLedger } from './relayLedger';
import { EditSyncSession, editSyncEnabled } from './session';

interface EditSyncRuntime { ledger: EditRelayLedger; session: EditSyncSession }

export function editSyncRuntime(): EditSyncRuntime | null {
  if (!editSyncEnabled()) return null;
  const g = globalThis as unknown as { __vcideEditSync__?: EditSyncRuntime };
  if (!g.__vcideEditSync__) {
    const ledger = new EditRelayLedger();
    const session = new EditSyncSession({
      ledger,
      current: () => {
        const s = devServer().snapshot();
        if (s.state !== 'running' || s.pid === null || !s.startedAt || !s.project || !pidAlive(s.pid)) return null;
        const run = { instance: s.instance, pid: s.pid, startedAt: s.startedAt };
        return { run, runString: runKeyString(run), projectRoot: s.project.root, projectName: s.project.name };
      },
      project: () => devServer().snapshot().project,
    });
    g.__vcideEditSync__ = { ledger, session };
  }
  return g.__vcideEditSync__;
}
