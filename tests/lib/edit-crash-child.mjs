/* =============================================================================
 * 編集 E1 の試験用の子プロセス（tests/edit-journal-unit.spec.mjs から起動する）。
 * 製品のエンジンで「解決 → 下書き → 適用」または「復旧」を行い、指定した段で
 *   - crash: 自分を SIGKILL する（電源断・OOM と同じく、後始末の処理を一切走らせない）
 *   - pause: 印のファイルを書いてから一定時間止まる（別のプロセスが同時に復旧を試す試験用）
 * 引数: JSON { libjs, root, journalDir, selection, change, mode: 'apply'|'recover', at, action: 'crash'|'pause', pauseMs, mark }
 * ========================================================================== */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(process.argv[2]);
process.env.VCIDE_EDIT_E1_WRITE = '1';
const require_ = createRequire(import.meta.url);
const { EditEngine } = require_(path.join(cfg.libjs, 'server', 'edit', 'engine.js'));

const step = (name) => {
  if (name !== cfg.at) return;
  if (cfg.action === 'crash') process.kill(process.pid, 'SIGKILL');
  if (cfg.action === 'pause') {
    fs.writeFileSync(cfg.mark, String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cfg.pauseMs ?? 3000);
  }
};
const eng = new EditEngine({ projectRoot: cfg.root, journalDir: cfg.journalDir, hooks: { step } });
let out;
if (cfg.mode === 'recover') {
  out = eng.recover();
} else {
  const t = eng.resolveTarget(cfg.selection);
  if (!t.ok) { console.log(JSON.stringify({ error: 'resolve', t })); process.exit(3); }
  const d = eng.createDraft(t.target.id, cfg.selection, cfg.change);
  if (!d.ok) { console.log(JSON.stringify({ error: 'draft', d })); process.exit(4); }
  out = eng.apply({ changes: [{ draftId: d.draft.id, reviewedDiffHash: d.draft.diffHash, selection: cfg.selection }] });
}
console.log(JSON.stringify(out));
process.exit(0);
