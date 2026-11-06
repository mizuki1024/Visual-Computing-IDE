/* =============================================================================
 * 視覚編集 E2.1 — 中継の台帳（編集の同期専用。docs/08d 第8節）。
 *
 * 中継（PreviewGateway）の記録先（RelayObserver）に、探索の観測（observations）と並べて置く（teeObserver）。
 * 探索の観測の記録の形・保持・判定は変えない。ここが持つのは編集の照合に要るものだけ:
 *   - HTML の応答（文書）: 文書の識別子・パス・状態・時刻
 *   - RSC の要求: パス・状態・時刻・**要求を出した文書の識別子**（文書のスクリプトが x-vcide-doc に載せたもの。
 *     台帳に文書として有る識別子だけを initiator にする。無い識別子は「名乗ったが台帳に無い」と記す）
 * クエリの値・ヘッダの一覧・本文は持たない（中継の記録の形にそもそも無い）。
 * 起動（run）ごとに分け、直近の2起動だけ持つ。件数の上限で古いものから外し、外したことを記す（外した後の事実を推測で埋めない）。
 * ========================================================================== */
import type { RelayObserver, RelayRecord } from '../previewGateway';
import type { LedgerDocument, LedgerRsc, LedgerView } from '../../lib/editSyncBinding';

const DOC_RE = /^[0-9a-f]{32}$/;
export const LEDGER_LIMITS = { documents: 400, rsc: 2000, runs: 2 } as const;

interface RunLedger {
  documents: LedgerDocument[];
  rsc: LedgerRsc[];
  seq: number;
  lostDocumentsThroughMs: number | null;
  lostRscThroughMs: number | null;
}

export class EditRelayLedger implements RelayObserver {
  readonly #runs = new Map<string, RunLedger>();
  readonly #limits: { documents: number; rsc: number; runs: number };

  constructor(limits: Partial<{ documents: number; rsc: number; runs: number }> = {}) {
    this.#limits = { ...LEDGER_LIMITS, ...limits };
  }

  #run(run: string): RunLedger {
    let r = this.#runs.get(run);
    if (!r) {
      r = { documents: [], rsc: [], seq: 0, lostDocumentsThroughMs: null, lostRscThroughMs: null };
      this.#runs.set(run, r);
      while (this.#runs.size > this.#limits.runs) this.#runs.delete(this.#runs.keys().next().value as string);
    }
    return r;
  }

  record(run: string, rec: RelayRecord, meta?: { relayId?: string; docToken?: string; initiatorDoc?: string }): void {
    const r = this.#run(run);
    const endMs = rec.durationMs === null ? Date.now() : rec.startMs + rec.durationMs;
    const failed = !!rec.failure;
    if (meta?.docToken && DOC_RE.test(meta.docToken)) {
      r.documents.push({ token: meta.docToken, path: rec.path, status: rec.status, startMs: rec.startMs, endMs, failed });
      if (r.documents.length > this.#limits.documents) {
        const gone = r.documents.splice(0, r.documents.length - this.#limits.documents);
        r.lostDocumentsThroughMs = Math.max(r.lostDocumentsThroughMs ?? 0, ...gone.map((g) => g.startMs));
      }
    }
    if (rec.kind === 'rsc') {
      const declared = meta?.initiatorDoc && DOC_RE.test(meta.initiatorDoc) ? meta.initiatorDoc : null;
      const known = declared !== null && r.documents.some((d) => d.token === declared);
      r.rsc.push({
        seq: ++r.seq, path: rec.path, status: rec.status, startMs: rec.startMs, endMs, failed,
        initiator: known ? declared : null, declaredUnknown: declared !== null && !known,
      });
      if (r.rsc.length > this.#limits.rsc) {
        const gone = r.rsc.splice(0, r.rsc.length - this.#limits.rsc);
        r.lostRscThroughMs = Math.max(r.lostRscThroughMs ?? 0, ...gone.map((g) => g.startMs));
      }
    }
  }

  excludeStatic(): void { /* 静的資材は数えない */ }

  /** その起動の台帳の写し（無ければ null）。返したものを書き換えても台帳は変わらない */
  view(run: string): LedgerView | null {
    const r = this.#runs.get(run);
    if (!r) return null;
    return {
      run,
      documents: r.documents.map((d) => ({ ...d })),
      rsc: r.rsc.map((x) => ({ ...x })),
      lostDocumentsThroughMs: r.lostDocumentsThroughMs,
      lostRscThroughMs: r.lostRscThroughMs,
    };
  }
}

/** 中継の記録を2つの記録先へ渡す（探索の観測が先。どちらかの例外がもう一方を止めない） */
export function teeObserver(first: RelayObserver, second: RelayObserver): RelayObserver {
  return {
    record(run, rec, meta) {
      try { first.record(run, rec, meta); } finally { try { second.record(run, rec, meta); } catch { /* 編集の台帳の失敗で探索を止めない */ } }
    },
    excludeStatic(run) {
      try { first.excludeStatic(run); } finally { try { second.excludeStatic(run); } catch { /* 同上 */ } }
    },
  };
}
