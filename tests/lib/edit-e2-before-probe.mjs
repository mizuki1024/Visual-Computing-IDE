/* 変更前のコードの挙動の記録（docs/08c 第6.1節）。試験ではなく、E2 の変更の前後の差を示すための実測。
 *   npm run build:lib && node tests/lib/edit-e2-before-probe.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, selectionOf, loadEdit, readFixture, CARD, withWrites } from './edit-harness.mjs';
const { EditEngine } = loadEdit('engine');
const ORIG = readFixture(CARD);
const change = { kind: 'class-token', from: 'p-4', to: 'p-5' };
const out = (k, v) => console.log(`${k}: ${JSON.stringify(v)}`);
const prep = (n) => { const p = makeProject({ [CARD]: ORIG }, { name: n }); p.compile(CARD); return p; };
const flow = (p, eng) => { const s = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6')); const t = eng.resolveTarget(s); const d = eng.createDraft(t.target.id, s, change); return { s, t: t.target, d: d.draft, r: () => eng.apply({ changes: [{ draftId: d.draft.id, reviewedDiffHash: d.draft.diffHash, selection: s }] }) }; };
/* 1. macOS を装う + VCIDE_EDIT_E1_WRITE=1 */
{
  const p = prep('probe-darwin'); const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const f = flow(p, eng);
  const d = Object.getOwnPropertyDescriptor(process, 'platform'); Object.defineProperty(process, 'platform', { ...d, value: 'darwin' });
  const r0 = withWrites(true, f.r);
  Object.defineProperty(process, 'platform', d);
  out('1. darwin + env=1 の適用の結果', { status: r0.status, written: r0.written, directoryPinned: r0.assurance?.directoryPinned });
  out('1. ファイルが変わったか', p.read(CARD) !== ORIG);
  /* 以後の項目のために、実際の OS（Linux）で適用しておく（変更前のコードでは 1 で既に適用済み） */
  const r = r0.status === 'committed' ? r0 : withWrites(true, f.r);
  /* 2. 自分の書き込みの後の選択（07d 3.3 の引き継ぎは無い） */
  p.compile(CARD);
  const t2 = eng.reresolveTarget(f.t.id, selectionOf(p.anchorAt(CARD, 'p-5 md:p-6')));
  out('2. 書いた後の reresolveTarget（対象 id は解決時のもの）', { reason: t2.reason, reselect: t2.reselect });
  out('2. carrySelection の有無', typeof eng.carrySelection);
  if (typeof eng.carrySelection === 'function') out('2. carrySelection の結果', (({ carried, reason }) => ({ carried, reason }))(eng.carrySelection(r.txId, selectionOf(p.anchorAt(CARD, 'p-5 md:p-6')))));
  /* 3. 保存期間の整理: 要確認の古い記録 */
  const j = JSON.parse(fs.readFileSync(path.join(p.journalDir, `${r.txId}.json`), 'utf8'));
  const OLD = '2020-01-01T00:00:00.000Z';
  const att = { ...j, txId: 'tx-20200101000000-aaaaaaaa', tempName: '.PropertyCard.tsx.vcide-edit-tx-20200101000000-aaaaaaaa.tmp', state: 'failed', committedAt: null, createdAt: OLD, updatedAt: OLD, needsAttention: true, failure: { reason: 'external-change', detail: 'x', written: 'unknown', fileState: 'other' } };
  fs.writeFileSync(path.join(p.journalDir, `${att.txId}.json`), JSON.stringify(att));
  const rc = withWrites(true, () => eng.recover());
  out('3. 要確認（needsAttention）の古い記録を整理で消したか', rc.pruned.includes(att.txId));
  out('4. outcome の documentBinding', { outcome: eng.outcome(r.txId).documentBinding });
  out('5. ジャーナルの持ち主', j.owner);
  p.cleanup();
}
