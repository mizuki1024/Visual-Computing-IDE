/* =============================================================================
 * 編集 E1 — ジャーナルと復旧の試験（T7・T8・F-04。06h レビューの RV05・RV06 に相当）。
 *   npm run build:lib && node tests/edit-journal-unit.spec.mjs
 *
 * ジャーナルの状態: prepared → applying → committed | failed（committed と failed は終わり。復旧の対象にしない）
 * 復旧の仕様（docs/08a 第3.4節）:
 *   prepared               → 何も書いていない。failed にする
 *   applying・適用前の内容  → rename していない。残った一時ファイルを消して failed
 *   applying・適用後の内容  → 確定（committed）を記録する前に止まった。**確定していない適用は取り消す**（適用前へ戻し failed）
 *   applying・それ以外      → 外部の変更が混ざった。書かずに failed・要確認
 *   committed・failed       → 何もしない（RV05: 確定した変更を巻き戻さない）
 *   持ち主のプロセスが生きている → 何もしない（同時に走る適用を巻き戻さない）
 *
 *   T7 確定済みのジャーナル: 復旧で取り消されない（ファイルがどんな内容でも）
 *   T8 適用の途中の停止: 子プロセスを各段で SIGKILL し、復旧が仕様どおりになる。復旧の途中の停止も
 * ========================================================================== */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { counter, makeProject, selectionOf, loadEdit, readFixture, CARD, LIB, REPO, withWrites } from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note, guard } = C;
let E; let J;
try { E = loadEdit('engine'); J = loadEdit('journal'); } catch (e) { ok('製品の編集エンジン・ジャーナルを読み込める', false, String(e.message)); C.finish(); }
const { EditEngine } = E;
process.env.VCIDE_EDIT_E1_WRITE = '1';

const ORIG = readFixture(CARD);
const AFTER = ORIG.replace('p-4 md:p-6', 'p-5 md:p-6');
const change = { kind: 'class-token', from: 'p-4', to: 'p-5' };
const CHILD = path.join(REPO, 'tests', 'lib', 'edit-crash-child.mjs');

function setup(name) {
  const p = makeProject({ [CARD]: ORIG }, { name });
  p.compile(CARD);
  const selection = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
  return { p, selection };
}
function child(p, selection, extra) {
  return spawnSync(process.execPath, [CHILD, JSON.stringify({ libjs: LIB, root: p.root, journalDir: p.journalDir, selection, change, mode: 'apply', ...extra })],
    { encoding: 'utf8', timeout: 60000 });
}
const journals = (p) => (fs.existsSync(p.journalDir) ? fs.readdirSync(p.journalDir).filter((n) => /^tx-[\w-]+\.json$/.test(n)) : [])
  .map((n) => JSON.parse(fs.readFileSync(path.join(p.journalDir, n), 'utf8')));
const tempsIn = (p) => fs.readdirSync(path.join(p.root, 'src/components')).filter((n) => n.includes('vcide-edit'));

/* ============================================================ 状態の遷移 */
console.log('\n0. 状態の遷移（純粋な規則）');
guard('0', () => {
  const legal = [['prepared', 'applying'], ['prepared', 'failed'], ['applying', 'committed'], ['applying', 'failed']];
  const all = ['prepared', 'applying', 'committed', 'failed'];
  for (const a of all) for (const b of all) {
    const want = legal.some(([x, y]) => x === a && y === b);
    eq(`${a} → ${b} は${want ? '許す' : '許さない'}`, J.canTransition(a, b), want);
  }
  ok('終わりの状態は committed と failed', J.TERMINAL_STATES.includes('committed') && J.TERMINAL_STATES.includes('failed') && J.TERMINAL_STATES.length === 2);
  const plan = (state, fileState, ownerAlive = false) => J.planRecovery({ state }, fileState, ownerAlive).kind;
  for (const fs_ of ['at-before', 'at-after', 'other', 'missing']) {
    eq(`committed・${fs_}: 何もしない`, plan('committed', fs_), 'none');
    eq(`failed・${fs_}: 何もしない`, plan('failed', fs_), 'none');
    eq(`applying・${fs_}・持ち主が生きている: 何もしない`, plan('applying', fs_, true), 'none');
  }
  eq('prepared: failed にするだけ（書かない）', plan('prepared', 'at-before'), 'mark-failed');
  eq('applying・適用前: failed にするだけ', plan('applying', 'at-before'), 'mark-failed');
  eq('applying・適用後: 適用前へ戻す', plan('applying', 'at-after'), 'restore-before');
  eq('applying・それ以外: 書かずに要確認', plan('applying', 'other'), 'refuse');
  eq('applying・ファイルが無い: 書かずに要確認', plan('applying', 'missing'), 'refuse');
});

/* ============================================================ T7 */
console.log('\nT7 確定済み（committed）のジャーナルは、復旧で取り消されない（RV05）');
guard('T7', () => {
  const { p, selection } = setup('j7');
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const d = eng.createDraft(eng.resolveTarget(selection).target.id, selection, change).draft;
  const r = eng.apply({ changes: [{ draftId: d.id, reviewedDiffHash: d.diffHash, selection }] });
  eq('前提: 適用は committed', r.status, 'committed');
  const rc = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover();
  eq('復旧の後もファイルは適用後の内容（巻き戻さない）', p.read(CARD), AFTER);
  ok('復旧は committed のジャーナルに何もしない', rc.entries.filter((e) => e.txId === r.txId).every((e) => e.action === 'none' && e.wrote === false), rc);
  eq('ジャーナルは committed のまま', journals(p).find((j) => j.txId === r.txId)?.state, 'committed');
  /* ファイルが適用前の内容に戻っていても（git checkout など）、確定済みを「復旧」しない */
  p.write(CARD, ORIG);
  new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover();
  eq('利用者が戻した内容にも触れない', p.read(CARD), ORIG);
  p.write(CARD, AFTER);
  /* 子プロセスで committed を記録した直後に落ちても同じ */
  const { p: q, selection: s2 } = setup('j7b');
  const c = child(q, s2, { at: 'committed', action: 'crash' });
  eq('前提: 子プロセスは SIGKILL で止まった', c.signal, 'SIGKILL');
  eq('前提: ファイルは適用後', q.read(CARD), AFTER);
  eq('前提: ジャーナルは committed', journals(q)[0]?.state, 'committed');
  const rc2 = new EditEngine({ projectRoot: q.root, journalDir: q.journalDir }).recover();
  eq('committed の直後に落ちた後の復旧でも、適用後の内容のまま', q.read(CARD), AFTER);
  ok('（同）復旧は何も書かない', rc2.entries.every((e) => e.wrote === false), rc2);
  /* failed も同じ */
  const { p: f, selection: s3 } = setup('j7c');
  const ef = new EditEngine({ projectRoot: f.root, journalDir: f.journalDir });
  const df = ef.createDraft(ef.resolveTarget(s3).target.id, s3, change).draft;
  f.write(CARD, `${ORIG}// ext\n`);
  const rf = ef.apply({ changes: [{ draftId: df.id, reviewedDiffHash: df.diffHash, selection: s3 }] });
  const jf = journals(f);
  ok('前提: 外部変更で止まった適用は、ジャーナルを作らないか failed', jf.every((j) => j.state === 'failed'), { rf, jf });
  new EditEngine({ projectRoot: f.root, journalDir: f.journalDir }).recover();
  eq('failed のジャーナルにも何もしない（外部変更は残る）', f.read(CARD), `${ORIG}// ext\n`);
  for (const x of [p, q, f]) x.cleanup();
});

/* ============================================================ T8 */
console.log('\nT8 適用の途中の停止（子プロセスを各段で SIGKILL）と、仕様どおりの復旧');
guard('T8', () => {
  const CASES = [
    { at: 'prepared', file: ORIG, state: 'prepared', temp: false, recovered: ORIG, action: 'mark-failed' },
    { at: 'applying', file: ORIG, state: 'applying', temp: false, recovered: ORIG, action: 'mark-failed' },
    { at: 'temp-created', file: ORIG, state: 'applying', temp: true, recovered: ORIG, action: 'mark-failed' },
    { at: 'temp-written', file: ORIG, state: 'applying', temp: true, recovered: ORIG, action: 'mark-failed' },
    { at: 'before-rename', file: ORIG, state: 'applying', temp: true, recovered: ORIG, action: 'mark-failed' },
    /* E1.1: rename の直後は、置き換えた元の実体の退避リンク（.orig.tmp）が残る（復旧で、適用前の内容のときだけ外す） */
    { at: 'renamed', file: AFTER, state: 'applying', temp: true, recovered: ORIG, action: 'restore-before' },
  ];
  for (const k of CASES) {
    const { p, selection } = setup(`j8-${k.at}`);
    const c = child(p, selection, { at: k.at, action: 'crash' });
    eq(`[${k.at}] 子プロセスは SIGKILL で止まった`, c.signal, 'SIGKILL');
    ok(`[${k.at}] 止まった時点のファイルは${k.file === ORIG ? '適用前' : '適用後'}の内容（途中で切れた内容にならない）`, p.read(CARD) === k.file);
    eq(`[${k.at}] 止まった時点のジャーナルは ${k.state}`, journals(p)[0]?.state, k.state);
    eq(`[${k.at}] 止まった時点の一時ファイルは${k.temp ? '残っている' : '無い'}`, tempsIn(p).length > 0, k.temp);
    /* 書き込みが無効の起動では、復旧も書かない（見せるだけ） */
    const dry = withWrites(false, () => new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover());
    ok(`[${k.at}] 書き込みが無効なら、復旧は見せるだけ（ファイル・ジャーナル・一時ファイルを変えない）`,
      dry.status === 'dry-run' && p.read(CARD) === k.file && journals(p)[0]?.state === k.state && (tempsIn(p).length > 0) === k.temp, dry);
    const rc = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover();
    const e = rc.entries[0];
    eq(`[${k.at}] 復旧の判断は ${k.action}`, e?.action, k.action);
    eq(`[${k.at}] 復旧の後のファイルは適用前の内容（確定していない適用を残さない）`, p.read(CARD), k.recovered);
    eq(`[${k.at}] 復旧の後のジャーナルは failed（committed にしない）`, journals(p)[0]?.state, 'failed');
    eq(`[${k.at}] 復旧の後に一時ファイルを残さない（F-06）`, tempsIn(p).length, 0);
    const again = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover();
    ok(`[${k.at}] 2回目の復旧は何もしない`, again.entries.every((x) => x.action === 'none' && x.wrote === false) && p.read(CARD) === k.recovered, again);
    p.cleanup();
  }
  /* 適用後で止まり、復旧の前に外部変更が入った: 書かずに要確認 */
  {
    const { p, selection } = setup('j8-ext');
    child(p, selection, { at: 'renamed', action: 'crash' });
    const ext = `${AFTER}// 停止の後に別のエディタが保存\n`;
    p.write(CARD, ext);
    const rc = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover();
    ok('停止の後の外部変更: 復旧は書かない（refuse）', rc.entries[0]?.action === 'refuse' && rc.entries[0]?.wrote === false, rc);
    eq('（同）外部変更は残る', p.read(CARD), ext);
    const j = journals(p)[0];
    ok('（同）ジャーナルは failed・要確認', j.state === 'failed' && j.needsAttention === true, j);
    p.cleanup();
  }
  /* 復旧の途中（適用前へ戻す書き込みの途中）で止まった: 次の復旧で完了する */
  for (const at of ['temp-written', 'before-rename', 'renamed']) {
    const { p, selection } = setup(`j8-rec-${at}`);
    child(p, selection, { at: 'renamed', action: 'crash' });
    const c2 = spawnSync(process.execPath, [CHILD, JSON.stringify({ libjs: LIB, root: p.root, journalDir: p.journalDir, mode: 'recover', at, action: 'crash' })], { encoding: 'utf8', timeout: 60000 });
    eq(`[復旧の途中 ${at}] 復旧の子プロセスも SIGKILL で止まった`, c2.signal, 'SIGKILL');
    eq(`[復旧の途中 ${at}] ジャーナルはまだ applying（終わりの状態にしていない）`, journals(p)[0]?.state, 'applying');
    const rc = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover();
    eq(`[復旧の途中 ${at}] 次の復旧でファイルは適用前`, p.read(CARD), ORIG);
    eq(`[復旧の途中 ${at}] ジャーナルは failed`, journals(p)[0]?.state, 'failed');
    eq(`[復旧の途中 ${at}] 一時ファイル（適用と復旧の両方）を残さない`, tempsIn(p).length, 0);
    note(`判断: ${rc.entries[0]?.action}`);
    p.cleanup();
  }
});

/* ============================================================ 同時に走る適用 */
console.log('\n同時に走る適用（別のプロセスが適用の途中）を、復旧で巻き戻さない');
await guard('concurrent', async () => {
  const { p, selection } = setup('j-conc');
  const mark = path.join(p.base, 'paused');
  const ch = spawn(process.execPath, [CHILD, JSON.stringify({ libjs: LIB, root: p.root, journalDir: p.journalDir, selection, change, mode: 'apply', at: 'renamed', action: 'pause', pauseMs: 4000, mark })], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  ch.stdout.on('data', (b) => { out += b; });
  const t0 = Date.now();
  while (!fs.existsSync(mark) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
  ok('前提: 子プロセスは rename の後で止まっている（ファイルは適用後・ジャーナルは applying）', fs.existsSync(mark) && p.read(CARD) === AFTER && journals(p)[0]?.state === 'applying');
  const rc = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover();
  ok('別のプロセスが適用の途中なら、復旧は何もしない（busy または持ち主が生きている）', (rc.status === 'busy' || rc.entries.every((e) => e.action === 'none')) && p.read(CARD) === AFTER, rc);
  const code = await new Promise((r) => ch.on('exit', r));
  eq('子プロセスは最後まで進んだ', code, 0);
  eq('（同）子プロセスの適用は committed', JSON.parse(out.trim().split('\n').pop()).status, 'committed');
  eq('（同）ファイルは適用後', p.read(CARD), AFTER);
  p.cleanup();
});

/* ============================================================ 残った鍵 */
console.log('\n残った排他の鍵（持ち主が死んだ・同じ pid だった前のプロセス）を取り除き、生きている持ち主の鍵は尊重する');
guard('lock', () => {
  const { p, selection } = setup('j-lock');
  const lock = path.join(p.journalDir, 'apply.lock');
  fs.mkdirSync(p.journalDir, { recursive: true });
  const put = (pid) => fs.writeFileSync(lock, JSON.stringify({ pid, host: os.hostname(), at: new Date().toISOString() }));
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  put(Number(dead));
  eq('持ち主が死んだ鍵は取り除いて復旧できる', new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover().status, 'done');
  put(process.pid);
  eq('同じ pid でも、このプロセスが持っていない鍵（前のプロセスの残り）は取り除く', new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover().status, 'done');
  const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
  put(alive.pid);
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  eq('生きている別のプロセスの鍵があれば復旧しない（busy）', eng.recover().status, 'busy');
  const d = eng.createDraft(eng.resolveTarget(selection).target.id, selection, change).draft;
  const r = eng.apply({ changes: [{ draftId: d.id, reviewedDiffHash: d.diffHash, selection }] });
  ok('（同）適用もしない（busy・written: false）', r.status === 'busy' && r.written === false, r);
  eq('（同）ファイルは元のまま', p.read(CARD), ORIG);
  alive.kill('SIGKILL');
  p.cleanup();
});

/* ============================================================ 保存期間 */
console.log('\nジャーナルの保存期間（終わりのものだけを消す）');
guard('retention', () => {
  const { p, selection } = setup('j-ret');
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const d = eng.createDraft(eng.resolveTarget(selection).target.id, selection, change).draft;
  const r = eng.apply({ changes: [{ draftId: d.id, reviewedDiffHash: d.diffHash, selection }] });
  const later = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir, clock: () => Date.now() + 40 * 24 * 3600 * 1000 });
  const rc = later.recover();
  ok('保存期間（30日）を過ぎた committed のジャーナルは消す', !journals(p).some((j) => j.txId === r.txId), rc);
  eq('（同）ソースには触れない', p.read(CARD), AFTER);
  /* 終わっていないジャーナルは、古くても消さない */
  const { p: q, selection: s2 } = setup('j-ret2');
  const mark = path.join(q.base, 'paused');
  const ch = spawn(process.execPath, [CHILD, JSON.stringify({ libjs: LIB, root: q.root, journalDir: q.journalDir, selection: s2, change, mode: 'apply', at: 'renamed', action: 'pause', pauseMs: 2500, mark })], { stdio: 'ignore' });
  const t0 = Date.now();
  while (!fs.existsSync(mark) && Date.now() - t0 < 30000) spawnSync('sleep', ['0.05']);
  new EditEngine({ projectRoot: q.root, journalDir: q.journalDir, clock: () => Date.now() + 400 * 24 * 3600 * 1000 }).recover();
  eq('終わっていない（applying の）ジャーナルは、保存期間を過ぎても消さない', journals(q)[0]?.state, 'applying');
  spawnSync('sleep', ['3']);
  ch.kill('SIGKILL');
  for (const x of [p, q]) x.cleanup();
});

C.finish();
