/* =============================================================================
 * 視覚編集 E2 — 同期の層の単体試験（docs/08c-visual-editor-e2-report.md）。
 *   npm run build:lib && node tests/edit-sync-unit.spec.mjs
 *
 * E2 の範囲のうち、探索の持ち物（previewProtocol・previewGateway）と画面に触れない部分だけを確かめる。
 *   Y1 書き込みの可否: 環境変数に加えて OS（Linux だけ。macOS は無効のまま — E2 の暫定方針 1）
 *   Y2 起動時の復旧: 読むだけの点検（inspectRecovery）と、ファイルを変える復旧（recover）を分ける。
 *      書き込みが無効なら、点検・復旧・起動時の復旧のどれも、ソース・一時ファイル・ジャーナル・鍵を1バイトも変えない。
 *      判断できない記録・残ったファイルは自動で消さない（保存期間の整理でも）
 *   Y3 持ち主の識別: pid に加えてプロセスの開始時刻（Linux の /proc/<pid>/stat と boot_id）で PID の再利用を見分ける
 *   Y4 自分が書いた変更の後の選択の引き継ぎ（docs/07d 3.3）: afterRev と afterFingerprint の両方が一致するときだけ。
 *      transient・uncertain・failed・取り消し・外部変更の後は引き継がない
 *   Y5 ApplyResult の種類（型の定義）と報告書（08b 第3.5節）の種類の数の照合
 *   Y6 検証の報告の出所: 文書の識別子と中継の結び付けをまだ確かめていないことを、結果に明示する
 * ========================================================================== */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { counter, makeProject, selectionOf, loadEdit, readFixture, CARD, TWO, TWO_SRC, REPO, LIB, withWrites, VIEWPORTS } from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note, guard } = C;
let E; let F; let J; let CFG;
try { E = loadEdit('engine'); F = loadEdit('fsio'); J = loadEdit('journal'); CFG = loadEdit('config'); } catch (e) { ok('製品の編集エンジンを読み込める', false, String(e.message)); C.finish(); }
const { EditEngine } = E;
const ORIG = readFixture(CARD);
const AFTER = ORIG.replace('p-4 md:p-6', 'p-5 md:p-6');
const change = (from = 'p-4', to = 'p-5') => ({ kind: 'class-token', from, to });
const CHILD = path.join(REPO, 'tests', 'lib', 'edit-crash-child.mjs');
const LINUX = process.platform === 'linux';
const fn = (o, k) => typeof o?.[k] === 'function';

/** ディレクトリの完全なスナップショット（隠しファイル・種類・大きさ・内容・リンク数・inode・更新時刻・権限） */
function deepSnapshot(dir) {
  const m = new Map();
  if (!fs.existsSync(dir)) return m;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      const rel = path.relative(dir, p);
      if (st.isSymbolicLink()) m.set(rel, `link:${fs.readlinkSync(p)}:${st.mtimeMs}`);
      else if (st.isDirectory()) { m.set(rel, `dir:${st.ino}:${st.mode}:${st.mtimeMs}`); walk(p); }
      else m.set(rel, `file:${st.size}:${st.nlink}:${st.ino}:${st.mode}:${st.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return m;
}
const diffSnap = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));

/** 指定した段で SIGKILL した子プロセスの跡（ジャーナル・一時ファイル）を作る */
function crashAt(p, selection, at) {
  return spawnSync(process.execPath, [CHILD, JSON.stringify({ libjs: LIB, root: p.root, journalDir: p.journalDir, selection, change: change(), mode: 'apply', at, action: 'crash' })],
    { encoding: 'utf8', timeout: 60000 });
}
const journalFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^tx-[\w-]+\.json$/.test(n) && !n.includes('verification')) : []);
const prep = (name, files = { [CARD]: ORIG }) => { const p = makeProject(files, { name }); for (const f of Object.keys(files)) p.compile(f); return p; };
function setPlatform(v) {
  const d = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...d, value: v });
  return () => Object.defineProperty(process, 'platform', d);
}
/** 独立に読む: /proc/<pid>/stat の 22 番目（開始時刻・起動からの tick）と boot_id */
function startOfIndependent(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return `${boot}:${rest[19]}`;
  } catch { return null; }
}
/** 適用（committed）まで進める */
function applyCommitted(p, eng, needle = 'p-4 md:p-6', file = CARD, ch = change()) {
  const s = selectionOf(p.anchorAt(file, needle));
  const t = eng.resolveTarget(s);
  if (!t.ok) throw new Error(`resolve: ${t.reason}`);
  const d = eng.createDraft(t.target.id, s, ch);
  if (!d.ok) throw new Error(`draft: ${d.reason}`);
  const r = withWrites(true, () => eng.apply({ changes: [{ draftId: d.draft.id, reviewedDiffHash: d.draft.diffHash, selection: s }] }));
  return { s, t: t.target, d: d.draft, r };
}

/* ============================================================ Y1 */
console.log('\nY1 書き込みの可否: 環境変数に加えて OS（Linux だけ。macOS では無効のまま）');
guard('Y1', () => {
  ok('editWriteGate がある', fn(CFG, 'editWriteGate'));
  if (!fn(CFG, 'editWriteGate')) return;
  const on = { VCIDE_EDIT_E1_WRITE: '1' };
  ok('Linux・環境変数 "1" → 有効', CFG.editWriteGate(on, 'linux').enabled === true, CFG.editWriteGate(on, 'linux'));
  for (const plat of ['darwin', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix', 'android']) {
    const g = CFG.editWriteGate(on, plat);
    ok(`${plat}・環境変数 "1" → 無効（platform-unsupported）`, g.enabled === false && g.reason === 'platform-unsupported' && typeof g.detail === 'string' && g.detail.length > 0, g);
    eq(`${plat}: editWritesEnabled も無効`, CFG.editWritesEnabled(on, plat), false);
  }
  const g0 = CFG.editWriteGate({}, 'linux');
  ok('Linux・環境変数なし → 無効（env-not-set）', g0.enabled === false && g0.reason === 'env-not-set', g0);
  ok('macOS・環境変数なし → 無効（env-not-set より OS の理由を優先しない／どちらでも無効）', CFG.editWriteGate({}, 'darwin').enabled === false);
  ok('書き込みを許す OS の一覧は linux だけ', JSON.stringify(CFG.EDIT_WRITE_PLATFORMS) === '["linux"]', CFG.EDIT_WRITE_PLATFORMS);

  /* エンジン・書き込みの入口が、実行中の OS を見ること（macOS を装う） */
  const p = prep('y1-darwin');
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const s = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
  const t = eng.resolveTarget(s);
  const d = eng.createDraft(t.target.id, s, change());
  const before = deepSnapshot(p.base);
  const restore = setPlatform('darwin');
  let r; let rc; let w; let st;
  try {
    r = withWrites(true, () => eng.apply({ changes: [{ draftId: d.draft.id, reviewedDiffHash: d.draft.diffHash, selection: s }] }));
    rc = withWrites(true, () => eng.recover());
    st = withWrites(true, () => (fn(eng, 'startupRecovery') ? eng.startupRecovery() : null));
    w = withWrites(true, () => F.replaceSourceFile({ projectRoot: p.root, rel: CARD, expectedHash: 'x', next: 'x', tempName: '.PropertyCard.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp' }));
  } finally { restore(); }
  ok('macOS では環境変数 "1" でも適用しない（edit-disabled・written: false）', r.status === 'refused' && r.written === false && r.reason === 'edit-disabled', r);
  ok('（同）理由の文言は OS を挙げる', /macOS|darwin|OS/.test(r.detail ?? ''), r.detail);
  eq('（同）macOS では復旧は見せるだけ（dry-run）', rc.status, 'dry-run');
  ok('（同）起動時の復旧も点検だけ（inspect-only）', st && st.mode === 'inspect-only' && st.recovery === null, st);
  ok('（同）書き込みの入口も OS を確かめる', w.status === 'not-written' && w.reason === 'edit-disabled', w);
  eq('（同）ソース・ジャーナル・鍵を1バイトも変えない', JSON.stringify(diffSnap(before, deepSnapshot(p.base))), '[]');
  p.cleanup();
});

/* ============================================================ Y2 */
console.log('\nY2 起動時の復旧: 読むだけの点検とファイルを変える復旧を分ける。無効なら何も変えない');
guard('Y2', () => {
  ok('inspectRecovery・startupRecovery がある', fn(EditEngine.prototype, 'inspectRecovery') && fn(EditEngine.prototype, 'startupRecovery'));
  if (!fn(EditEngine.prototype, 'inspectRecovery')) return;
  /* 止まった跡を段ごとに作る（各段 1 プロジェクト）。加えて、形の合わない記録・古い終わりの記録（要確認・片付いたもの） */
  const STAGES = [
    { at: 'prepared', action: 'mark-failed', effects: ['journal'] },
    { at: 'temp-written', action: 'mark-failed', effects: ['journal', 'artifacts'] },
    { at: 'snapshot-linked', action: 'mark-failed', effects: ['journal', 'artifacts'] },
    { at: 'renamed', action: 'restore-before', effects: ['journal', 'artifacts', 'source'] },
  ];
  for (const k of STAGES) {
    const p = prep(`y2-${k.at}`);
    const s = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
    const c = crashAt(p, s, k.at);
    eq(`[${k.at}] 前提: 子プロセスは SIGKILL で止まった`, c.signal, 'SIGKILL');
    fs.writeFileSync(path.join(p.journalDir, 'tx-20200101000000-0badf00d.json'), '{"v":1,"broken":');   // 形の合わない記録
    const before = { src: deepSnapshot(p.root), journal: deepSnapshot(p.journalDir) };
    const lockExisted = fs.existsSync(path.join(p.journalDir, 'apply.lock'));
    const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
    /* 1) 書き込みが無効（環境変数なし） */
    const ins = withWrites(false, () => eng.inspectRecovery());
    const rc = withWrites(false, () => eng.recover());
    const st = withWrites(false, () => eng.startupRecovery());
    /* 2) 点検は、書き込みが有効でも何も変えない */
    const ins2 = withWrites(true, () => eng.inspectRecovery());
    const after = { src: deepSnapshot(p.root), journal: deepSnapshot(p.journalDir) };
    eq(`[${k.at}] 無効の点検・復旧・起動時の復旧と、有効の点検は、題材（ソース・一時ファイル・退避リンク）を変えない`, JSON.stringify(diffSnap(before.src, after.src)), '[]');
    eq(`[${k.at}]（同）ジャーナル・検証の記録・鍵を変えない（作らない・消さない・書き換えない）`, JSON.stringify(diffSnap(before.journal, after.journal)), '[]');
    eq(`[${k.at}]（同）鍵を作らない`, fs.existsSync(path.join(p.journalDir, 'apply.lock')), lockExisted);
    ok(`[${k.at}] 点検は mutates: false を返す`, ins.status === 'inspected' && ins.mutates === false && ins2.mutates === false, { status: ins.status, mutates: ins.mutates });
    const e = ins.entries.find((x) => x.state && x.state !== 'committed');
    eq(`[${k.at}] 点検の判断（予定の処理）`, e?.plannedAction, k.action);
    ok(`[${k.at}] 点検は、処理が何を変えるか（effects）を分けて示す`, Array.isArray(e?.effects) && JSON.stringify([...e.effects].sort()) === JSON.stringify([...k.effects].sort()), e?.effects);
    ok(`[${k.at}] 点検は持ち主の確かめ方（開始時刻）を示す`, e?.ownerCheck === (LINUX ? 'start-time' : 'pid-only') && e?.ownerAlive === false, e);
    ok(`[${k.at}] 形の合わない記録は点検で「読めない」と示し、消さない`, ins.unreadable.includes('tx-20200101000000-0badf00d.json') && fs.existsSync(path.join(p.journalDir, 'tx-20200101000000-0badf00d.json')), ins.unreadable);
    eq(`[${k.at}] 無効の復旧は dry-run`, rc.status, 'dry-run');
    ok(`[${k.at}] 無効の起動時の復旧は点検だけ（inspect-only・recovery: null・理由 env-not-set）`, st.mode === 'inspect-only' && st.recovery === null && st.gate?.reason === 'env-not-set' && st.inspection?.mutates === false, { mode: st.mode, gate: st.gate });
    /* 3) 有効の起動時の復旧: 点検の後に、仕様どおりの復旧を1回 */
    const st2 = withWrites(true, () => eng.startupRecovery());
    ok(`[${k.at}] 有効の起動時の復旧は点検 → 復旧（recovered）`, st2.mode === 'recovered' && st2.recovery?.status === 'done', { mode: st2.mode });
    const done = st2.recovery?.entries.find((x) => x.txId && x.state !== 'committed');
    eq(`[${k.at}]（同）実際の処理は点検の予定と同じ`, done?.action, k.action);
    eq(`[${k.at}]（同）ソースは適用前`, p.read(CARD), ORIG);
    ok(`[${k.at}]（同）形の合わない記録は消さない`, fs.existsSync(path.join(p.journalDir, 'tx-20200101000000-0badf00d.json')));
    p.cleanup();
  }

  /* 保存期間の整理: 判断できない（要確認）・ファイルを残した記録は、期間を過ぎても消さない */
  {
    const p = prep('y2-prune');
    const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
    const a = applyCommitted(p, eng);
    eq('前提: 1つ目は committed', a.r.status, 'committed');
    const OLD = '2020-01-01T00:00:00.000Z';
    const jf = (tx) => path.join(p.journalDir, `${tx}.json`);
    const j = JSON.parse(fs.readFileSync(jf(a.r.txId), 'utf8'));
    fs.writeFileSync(jf(a.r.txId), JSON.stringify({ ...j, createdAt: OLD, updatedAt: OLD }));
    /* 要確認の終わりの記録（failed・needsAttention） */
    const att = { ...j, txId: 'tx-20200101000000-aaaaaaaa', tempName: `.PropertyCard.tsx.vcide-edit-tx-20200101000000-aaaaaaaa.tmp`, state: 'failed', committedAt: null,
      createdAt: OLD, updatedAt: OLD, needsAttention: true, failure: { reason: 'external-change', detail: 'x', written: 'unknown', fileState: 'other' } };
    fs.writeFileSync(jf(att.txId), JSON.stringify(att));
    /* 残したファイル（外部の内容を含みうる退避リンク）がある終わりの記録（needsAttention は false に書き換えてある） */
    const kept = { ...j, txId: 'tx-20200101000000-bbbbbbbb', tempName: `.PropertyCard.tsx.vcide-edit-tx-20200101000000-bbbbbbbb.tmp`, state: 'failed', committedAt: null,
      createdAt: OLD, updatedAt: OLD, needsAttention: false, failure: { reason: 'x', detail: 'x', written: false, fileState: 'at-before' } };
    fs.writeFileSync(jf(kept.txId), JSON.stringify(kept));
    const keptFile = path.join(p.root, 'src/components', '.PropertyCard.tsx.vcide-edit-tx-20200101000000-bbbbbbbb.orig.tmp');
    fs.writeFileSync(keptFile, '// 外部の内容\n');
    ok('前提: 3つの記録は形が正しい', [a.r.txId, att.txId, kept.txId].every((tx) => eng.journal(tx)), [a.r.txId, att.txId, kept.txId].map((tx) => !!eng.journal(tx)));
    const ins = eng.inspectRecovery();
    ok('点検は、整理の対象と、残す記録（理由つき）を分けて示す', ins.prunable?.includes(a.r.txId) && ins.retained?.some((x) => x.txId === att.txId) && ins.retained?.some((x) => x.txId === kept.txId), { prunable: ins.prunable, retained: ins.retained });
    const rc = withWrites(true, () => eng.recover());
    ok('期間を過ぎた、片付いた committed の記録は整理する（従来どおり）', rc.pruned.includes(a.r.txId) && !fs.existsSync(jf(a.r.txId)), rc.pruned);
    ok('期間を過ぎても、要確認の記録は消さない', !rc.pruned.includes(att.txId) && fs.existsSync(jf(att.txId)), rc.pruned);
    ok('期間を過ぎても、残したファイルがある記録は消さない', !rc.pruned.includes(kept.txId) && fs.existsSync(jf(kept.txId)), rc.pruned);
    ok('残したファイルそのものも消さない', fs.existsSync(keptFile));
    p.cleanup();
  }
});

/* ============================================================ Y3 */
console.log('\nY3 持ち主の識別: pid ＋ プロセスの開始時刻（PID の再利用を見分ける）');
guard('Y3', () => {
  ok('processStartId・judgeOwner がある', fn(F, 'processStartId') && fn(F, 'judgeOwner'));
  if (!fn(F, 'processStartId')) return;
  const mine = F.processStartId(process.pid);
  if (LINUX) {
    eq('自分の開始時刻は /proc/self/stat と boot_id から独立に読んだ値と一致する', mine, startOfIndependent(process.pid));
    ok('形は <boot_id>:<tick>', /^[0-9a-f-]{36}:[0-9]+$/.test(mine ?? ''), mine);
  } else {
    eq('/proc の無い OS では読めない（null）', mine, null);
  }
  eq('存在しない pid は null', F.processStartId(2 ** 22 + 12345), null);
  /* 判断の規則（純粋）。facts: いまの機械の名前・pid が生きているか・その pid のいまの開始時刻 */
  const host = os.hostname();
  const B = '01234567-89ab-cdef-0123-456789abcdef';
  const S100 = `${B}:100`; const S99 = `${B}:99`;
  const J_ = (owner, facts) => F.judgeOwner(owner, { host, alive: true, start: S100, ...facts });
  eq('別のホスト → 確かめられない（alive 扱い・other-host）', JSON.stringify(J_({ pid: 10, host: 'other', start: S100 }, {})), JSON.stringify({ alive: true, check: 'other-host' }));
  eq('pid が死んでいる → いない', J_({ pid: 10, host, start: S100 }, { alive: false }).alive, false);
  eq('pid が生きていて開始時刻が同じ → いる', JSON.stringify(J_({ pid: 10, host, start: S100 }, {})), JSON.stringify({ alive: true, check: 'start-time' }));
  eq('pid が生きていて開始時刻が違う → いない（PID の再利用）', JSON.stringify(J_({ pid: 10, host, start: S99 }, {})), JSON.stringify({ alive: false, check: 'start-time' }));
  eq('開始時刻を記録していない（古い記録）→ pid だけで判断（生きていれば alive・安全側）', JSON.stringify(J_({ pid: 10, host }, {})), JSON.stringify({ alive: true, check: 'pid-only' }));
  eq('いまの開始時刻を読めない → pid だけで判断（安全側）', JSON.stringify(J_({ pid: 10, host, start: S100 }, { start: null })), JSON.stringify({ alive: true, check: 'pid-only' }));
  eq('記録の開始時刻の形が違う → 使わず pid だけで判断（安全側）', JSON.stringify(J_({ pid: 10, host, start: 'B:99' }, {})), JSON.stringify({ alive: true, check: 'pid-only' }));

  /* ジャーナルと鍵に開始時刻を記録する */
  const p = prep('y3');
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  let lockSeen = null;
  const eng2 = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir, hooks: { step: (n) => { if (n === 'applying' && !lockSeen) lockSeen = JSON.parse(fs.readFileSync(path.join(p.journalDir, 'apply.lock'), 'utf8')); } } });
  const a = applyCommitted(p, eng2);
  eq('前提: committed', a.r.status, 'committed');
  eq('ジャーナルの持ち主に開始時刻を記録する', eng.journal(a.r.txId)?.owner?.start ?? null, mine);
  eq('鍵の持ち主にも開始時刻を記録する', lockSeen?.start ?? null, mine);
  /* parseJournal: 開始時刻は無い（古い記録）か、正しい形 */
  const j = eng.journal(a.r.txId);
  ok('開始時刻の無い記録（E1.1 の形）も読める', !!J.parseJournal({ ...j, owner: { pid: 1, host } }));
  ok('形の違う開始時刻の記録は読まない', J.parseJournal({ ...j, owner: { pid: 1, host, start: 'x; rm -rf' } }) === null);
  p.cleanup();

  if (!LINUX) { note('PID の再利用の実地の試験は Linux だけ（/proc が要る）'); return; }
  /* PID の再利用: 持ち主の pid に、別の生きているプロセスがいる */
  {
    const q = prep('y3-reuse');
    const s = selectionOf(q.anchorAt(CARD, 'p-4 md:p-6'));
    crashAt(q, s, 'renamed');
    const jf = path.join(q.journalDir, journalFiles(q.journalDir)[0]);
    const j0 = JSON.parse(fs.readFileSync(jf, 'utf8'));
    ok('前提: 止まった子プロセスの記録に開始時刻がある', /^[0-9a-f-]{36}:[0-9]+$/.test(j0.owner?.start ?? ''), j0.owner);
    const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    const deadline = Date.now() + 5000;
    while (!F.processStartId(alive.pid) && Date.now() < deadline) { /* 起動を待つ */ }
    const real = F.processStartId(alive.pid);
    const recover = () => withWrites(true, () => new EditEngine({ projectRoot: q.root, journalDir: q.journalDir }).recover());
    fs.writeFileSync(jf, JSON.stringify({ ...j0, owner: { pid: alive.pid, host, start: real } }));
    const r1 = recover();
    ok('[同じ開始時刻] 持ち主が生きている → 何もしない', r1.entries[0]?.action === 'none' && q.read(CARD) === AFTER, r1.entries);
    fs.writeFileSync(jf, JSON.stringify({ ...j0, owner: { pid: alive.pid, host } }));
    const r2 = recover();
    ok('[開始時刻の無い古い記録] pid が生きていれば何もしない（E1.1 と同じ安全側）', r2.entries[0]?.action === 'none' && q.read(CARD) === AFTER, r2.entries);
    fs.writeFileSync(jf, JSON.stringify({ ...j0, owner: { pid: alive.pid, host, start: j0.owner.start } }));
    const ins = new EditEngine({ projectRoot: q.root, journalDir: q.journalDir }).inspectRecovery();
    ok('[PID の再利用] 点検は「持ち主はいない（開始時刻が違う）」と示す', ins.entries[0]?.ownerAlive === false && ins.entries[0]?.ownerCheck === 'start-time', ins.entries[0]);
    const r3 = recover();
    ok('[PID の再利用] 開始時刻が違えば持ち主はいない → 仕様どおり適用前へ戻す', r3.entries[0]?.action === 'restore-before' && q.read(CARD) === ORIG, r3.entries);
    /* 鍵: 生きている pid・違う開始時刻の鍵は古い鍵として取り除ける。同じ開始時刻なら取れない */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-y3-lock-'));
    const lock = path.join(dir, 'apply.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: alive.pid, host, at: new Date().toISOString(), start: real }));
    eq('[鍵] 生きている持ち主（同じ開始時刻）の鍵は取らない', F.acquireLock(dir), null);
    fs.writeFileSync(lock, JSON.stringify({ pid: alive.pid, host, at: new Date().toISOString() }));
    eq('[鍵] 開始時刻の無い古い鍵は pid が生きていれば取らない（安全側）', F.acquireLock(dir), null);
    fs.writeFileSync(lock, JSON.stringify({ pid: alive.pid, host, at: new Date().toISOString(), start: `${real.split(':')[0]}:1` }));
    const got = F.acquireLock(dir);
    ok('[鍵] PID が再利用された鍵（開始時刻が違う）は古い鍵として取り除いて取る', typeof got === 'function' && JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid, typeof got);
    if (typeof got === 'function') got();
    eq('[鍵] 外した後に名前を残さない', fs.readdirSync(dir).length, 0);
    alive.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
    q.cleanup();
  }
});

/* ============================================================ Y4 */
console.log('\nY4 自分が書いた変更の後の選択の引き継ぎ（afterRev と afterFingerprint の両方が一致するときだけ）');
guard('Y4', () => {
  ok('carrySelection がある', fn(EditEngine.prototype, 'carrySelection'));
  if (!fn(EditEngine.prototype, 'carrySelection')) return;
  const p = prep('y4');
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const a = applyCommitted(p, eng);
  eq('前提: committed', a.r.status, 'committed');
  /* HMR の前（DOM は適用前の版のまま）の選択 */
  const stale = a.s;
  const c0 = eng.carrySelection(a.r.txId, stale);
  ok('HMR の前の DOM（適用前の版）の選択は引き継がない', c0.carried === false && c0.reselect === true && c0.reason === 'dom-not-at-after', c0);
  /* DOM は適用後の版だが、対応表がまだ（ローダが再変換していない）→ 探索の7段で止まる */
  const sAfterNoManifest = selectionOf(p.anchorAt(CARD, 'p-5 md:p-6'));
  const c1 = eng.carrySelection(a.r.txId, sAfterNoManifest);
  ok('対応表が古い（HMR の途中）なら引き継がない（探索の照合で止まる）', c1.carried === false && c1.reason === 'target-unresolved', c1);
  /* HMR の後: 対応表もファイルも適用後 */
  p.compile(CARD);
  const s1 = selectionOf(p.anchorAt(CARD, 'p-5 md:p-6'));
  const before = deepSnapshot(p.base);
  const c2 = eng.carrySelection(a.r.txId, s1);
  ok('HMR の後の選択（版 = afterRev・指紋 = afterFingerprint）は引き継ぐ', c2.carried === true && c2.target?.sourceRev === a.r.afterRev && c2.target?.file === CARD, c2);
  ok('（同）引き継いだ対象は、同じ要素（識別子・位置・タグ・コンポーネント）', c2.carried && c2.target.anchorId === a.t.anchorId && c2.target.line === a.t.line && c2.target.col === a.t.col && c2.target.component === 'PropertyCard', c2.target);
  ok('（同）引き継いだ対象の指紋は、ジャーナルの afterFingerprint', c2.carried && c2.target.fingerprint === eng.journal(a.r.txId).target.afterFingerprint.hash, c2.target);
  ok('（同）引き継いだ元の適用を示す', c2.carried && c2.carriedFrom === a.r.txId, c2.carriedFrom);
  eq('（同）引き継ぎは読むだけ（ソース・ジャーナルを変えない）', JSON.stringify(diffSnap(before, deepSnapshot(p.base))), '[]');
  /* 引き継いだ対象で次の下書き・適用ができる（通常の3段の照合を通る） */
  const d2 = eng.createDraft(c2.target.id, s1, change('p-5', 'p-6'));
  ok('引き継いだ対象で次の下書きを作れる（第2段の照合を通る）', d2.ok === true, d2);
  /* 取り消し・取り消した適用 */
  const rv = withWrites(true, () => eng.revert(a.r.txId));
  eq('前提: 取り消しは committed', rv.status, 'committed');
  p.compile(CARD);
  const s2 = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
  const c3 = eng.carrySelection(a.r.txId, s2);
  ok('取り消した適用からは引き継がない', c3.carried === false && c3.reselect === true && c3.reason === 'reverted', c3);
  const c4 = eng.carrySelection(rv.txId, s2);
  ok('取り消し（kind: revert）からは引き継がない（選び直し）', c4.carried === false && c4.reselect === true && c4.reason === 'not-carriable', c4);
  p.cleanup();

  /* 外部変更の後 */
  {
    const q = prep('y4-ext');
    const e2 = new EditEngine({ projectRoot: q.root, journalDir: q.journalDir });
    const b = applyCommitted(q, e2);
    q.compile(CARD);
    const sOld = selectionOf(q.anchorAt(CARD, 'p-5 md:p-6'));
    q.write(CARD, q.read(CARD).replace('竣工', '完成'));   // 確定の後に、外部のエディタが同じファイルの別の行を変えた
    const c5 = e2.carrySelection(b.r.txId, sOld);
    ok('[外部変更・DOM はまだ適用後の版] 引き継がない', c5.carried === false && c5.reselect === true, c5);
    q.compile(CARD);
    const sNew = selectionOf(q.anchorAt(CARD, 'p-5 md:p-6'));
    const c6 = e2.carrySelection(b.r.txId, sNew);
    ok('[外部変更・HMR の後] DOM の版が afterRev でないので引き継がない（dom-not-at-after）',c6.carried === false && c6.reselect === true && c6.reason === 'dom-not-at-after', c6);
    const rr = e2.resolveTarget(sNew);
    ok('（同）選び直せば、いまの版の対象として通常どおり解決できる', rr.ok === true && rr.target.sourceRev !== b.r.afterRev, rr);
    /* 外部変更で書いた内容と同じ版に戻った（書いた内容とバイト一致）→ 引き継げる */
    q.write(CARD, AFTER);
    q.compile(CARD);
    const c7 = e2.carrySelection(b.r.txId, selectionOf(q.anchorAt(CARD, 'p-5 md:p-6')));
    ok('[外部変更の後に書いた内容とバイト一致へ戻った] 版と指紋が一致すれば引き継ぐ（内容で判断する）', c7.carried === true, c7);
    q.cleanup();
  }

  /* 同じ版の別の要素・指紋の不一致・他の結果 */
  {
    const q = prep('y4-two', { [TWO]: TWO_SRC });
    const e3 = new EditEngine({ projectRoot: q.root, journalDir: q.journalDir });
    const b = applyCommitted(q, e3, 'first', TWO, change('p-4', 'p-5'));
    eq('前提: 1つ目の <div> の適用は committed', b.r.status, 'committed');
    q.compile(TWO);
    const other = selectionOf(q.anchorAt(TWO, 'second'));
    const c8 = e3.carrySelection(b.r.txId, other);
    ok('同じ版（afterRev）の別の要素は引き継がない', c8.carried === false && c8.reselect === true && c8.reason === 'target-moved', c8);
    const jf = path.join(q.journalDir, `${b.r.txId}.json`);
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
    fs.writeFileSync(jf, JSON.stringify({ ...j, target: { ...j.target, afterFingerprint: { ...j.target.afterFingerprint, hash: 'f'.repeat(64) } } }));
    const c9 = e3.carrySelection(b.r.txId, selectionOf(q.anchorAt(TWO, 'first')));
    ok('版が一致しても、指紋（afterFingerprint）が違えば引き継がない', c9.carried === false && c9.reselect === true && c9.reason === 'fingerprint-mismatch', c9);
    fs.writeFileSync(jf, JSON.stringify({ ...j, target: { ...j.target, afterFingerprint: null } }));
    const c10 = e3.carrySelection(b.r.txId, selectionOf(q.anchorAt(TWO, 'first')));
    ok('適用後の指紋の記録が無ければ引き継がない', c10.carried === false && c10.reason === 'not-carriable', c10);
    fs.writeFileSync(jf, JSON.stringify(j));
    ok('前提: 記録を戻せば引き継げる', e3.carrySelection(b.r.txId, selectionOf(q.anchorAt(TWO, 'first'))).carried === true);
    eq('形の違う txId', e3.carrySelection('tx-x', other).reason, 'bad-request');
    eq('記録の無い txId', e3.carrySelection('tx-20990101000000-deadbeef', other).reason, 'tx-unknown');
    eq('形の違う選択', e3.carrySelection(b.r.txId, { tag: 'div' }).reason, 'bad-request');
    q.cleanup();
  }
  /* transient（外部の版へ戻した）・uncertain（確かめられない）・failed の後は引き継がない */
  for (const [label, at, want] of [['transient', 'snapshot-linked', 'conflict'], ['uncertain', 'renamed', 'uncertain']]) {
    const q = prep(`y4-${label}`);
    let fired = false;
    const EXT = `${ORIG}// 外部のエディタが保存した\n`;
    const e4 = new EditEngine({ projectRoot: q.root, journalDir: q.journalDir, hooks: { step: (n) => { if (n === at && !fired) { fired = true; fs.writeFileSync(q.abs(CARD), EXT); } } } });
    const b = applyCommitted(q, e4);
    ok(`[${label}] 前提: 結果は ${want}${label === 'transient' ? '・transient' : ''}`, fired && b.r.status === want && (label !== 'transient' || b.r.transient === true), b.r);
    q.compile(CARD);
    /* DOM が一瞬だけ自分の内容を描いた（HMR が transient の内容を拾った）と仮定した選択 */
    const ghost = { ...selectionOf(q.anchorAt(CARD, 'p-4 md:p-6')), anchorRev: e4.journal(b.r.txId)?.afterRev };
    const c = e4.carrySelection(b.r.txId, ghost);
    ok(`[${label}] 引き継がない（not-committed・選び直し）`, c.carried === false && c.reselect === true && c.reason === 'not-committed', c);
    const cNow = e4.carrySelection(b.r.txId, selectionOf(q.anchorAt(CARD, 'p-4 md:p-6')));
    ok(`[${label}] いまの DOM の選択でも引き継がない`, cNow.carried === false && cNow.reason === 'not-committed', cNow);
    q.cleanup();
  }
  {
    const q = prep('y4-refused');
    const e5 = new EditEngine({ projectRoot: q.root, journalDir: q.journalDir });
    const s = selectionOf(q.anchorAt(CARD, 'p-4 md:p-6'));
    const t = e5.resolveTarget(s);
    const d = e5.createDraft(t.target.id, s, change());
    const r = withWrites(false, () => e5.apply({ changes: [{ draftId: d.draft.id, reviewedDiffHash: d.draft.diffHash, selection: s }] }));
    ok('[refused] 書き込みが無効の結果には txId が無く、引き継げない', r.status === 'refused' && !r.txId && e5.carrySelection(r.txId, s).reason === 'bad-request', r);
    q.cleanup();
  }
});

/* ============================================================ Y5 */
console.log('\nY5 ApplyResult の種類と報告書（08b 第3.5節）の照合');
guard('Y5', () => {
  ok('APPLY_STATUSES がある', Array.isArray(E.APPLY_STATUSES));
  if (!Array.isArray(E.APPLY_STATUSES)) return;
  eq('種類は6つ', E.APPLY_STATUSES.length, 6);
  eq('種類の名前', JSON.stringify([...E.APPLY_STATUSES].sort()), JSON.stringify(['busy', 'committed', 'conflict', 'failed', 'refused', 'uncertain']));
  const doc = fs.readFileSync(path.join(REPO, 'docs', '08b-visual-editor-e1-safety-review.md'), 'utf8');
  const sec = doc.slice(doc.indexOf('### 3.5'), doc.indexOf('## 4.'));
  const rows = [...sec.matchAll(/^\| `([\w.]+)`(?:（[^）]*）)? \|/gm)].map((m) => m[1]).filter((x) => x !== 'verified' && x !== 'outcome.success');
  eq('08b 第3.5節の表の書き込みの結果の種類は、型の種類と同じ', JSON.stringify([...rows].sort()), JSON.stringify([...E.APPLY_STATUSES].sort()));
  const src = fs.readFileSync(path.join(REPO, 'src', 'server', 'edit', 'engine.ts'), 'utf8');
  const typeBlock = src.slice(src.indexOf('export type ApplyResult'), src.indexOf('export interface RecoveryEntry'));
  const inType = [...typeBlock.matchAll(/status: ((?:'[a-z]+'(?: \| )?)+)/g)].flatMap((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]));
  eq('engine.ts の ApplyResult の型の種類は APPLY_STATUSES と同じ', JSON.stringify([...new Set(inType)].sort()), JSON.stringify([...E.APPLY_STATUSES].sort()));
  /* 成功の扱い: committed も検証の前は success ではない（E1.1 の契約の再確認） */
  const p = prep('y5');
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const a = applyCommitted(p, eng);
  ok('committed は検証の前は成功（success）ではない', a.r.status === 'committed' && eng.outcome(a.r.txId).success === false, eng.outcome(a.r.txId));
  p.cleanup();
});

/* ============================================================ Y6 */
console.log('\nY6 検証の報告の出所: 文書と中継の結び付けを確かめていないことを結果に明示する');
guard('Y6', () => {
  const p = prep('y6');
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const a = applyCommitted(p, eng);
  p.compile(CARD);
  const now = new Date(Date.now() + 1000).toISOString();
  const sAfter = p.anchorAt(CARD, 'p-5 md:p-6');
  const rep = {
    txId: a.r.txId, anchorId: sAfter.id, file: CARD, sourceRev: a.r.afterRev, measuredAt: now,
    artboards: VIEWPORTS.map((v) => ({ viewport: { width: v.width, height: 800 }, mode: 'measured', predictionMarkers: 0, measuredAt: now,
      document: { token: 'a'.repeat(32), path: '/', sourceRevs: { [CARD]: a.r.afterRev } },
      elements: [{ anchorId: sAfter.id, rev: a.r.afterRev, classTokens: ['p-5', 'md:p-6'], computed: {} }] })),
  };
  const v = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir, clock: () => Date.now() + 2000 }).submitVerification(rep);
  eq('前提: 報告の中身は合格（verified）', v.status, 'verified');
  eq('検証の結果は「文書と中継の結び付けは確かめていない」（documentBinding: not-checked）', v.documentBinding, 'not-checked');
  eq('（同）実測か予測かは報告の申告（measurement: declared-by-report）', v.measurement, 'declared-by-report');
  const o = eng.outcome(a.r.txId);
  eq('outcome も documentBinding: not-checked を返す', o.documentBinding, 'not-checked');
  p.cleanup();
});

C.finish();
