/* =============================================================================
 * 編集 E1.1 — 安全性の監査の試験（S1〜S10。docs/08b-visual-editor-e1-safety-review.md）。
 *   npm run build:lib && node tests/edit-safety-unit.spec.mjs
 *
 * 製品のコード（src/server/edit）に対して、**使い捨ての題材**（OS の一時ディレクトリ）で回す。
 * 競合は偶然のタイミングに頼らず、エンジンの段（hooks.step）・鍵の段（acquireLock の hooks）・子プロセスの段で
 * **明示的に**差し込む。修正できない限界は通過・失敗に数えず［既知の限界］として別枠で記録する（安全の主張ではない）。
 *
 *   S1  正常な変更（1ファイル・1トークン）と、committed の保証の範囲（assurance）
 *   S2  外部変更（適用の前・照合の途中。同じ実体への書き込みと、rename による置き換えの両方）
 *   S3  並行変更（同じエンジンの再入・同じジャーナルの2つのエンジン・別のジャーナルの2つのエンジン・古い下書き）
 *   S4  最後の照合と rename の競合（RV03。退避リンクで検出・外部の版へ戻す／検出できない窓は限界として記録）
 *   S5  安全確認の後のディレクトリの差し替え（src/ の外に、一時的にもファイルを作らない）
 *   S6  範囲外への書き込み（既存のファイルの変更だけでなく、新しいファイルの作成・一時ファイルの名前・記録の書き換え）
 *   S7  異常終了（ジャーナルの各状態・書き込みの各段で SIGKILL → 復旧）・PID の再利用・ホスト名・古いジャーナル・鍵の競合
 *   S8  確定済みの変更の保護（committed は復旧で取り消さない）
 *   S9  検証不足（verified にならない・検証の後の変更）
 *   S10 既定で無効（書き込み・片付け・復旧が何もしない）
 * ========================================================================== */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  counter, makeProject, selectionOf, withWrites, loadEdit, readFixture, snapshot, sameSnapshot, CARD, LIB, REPO, VIEWPORTS,
} from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note, limit, guard } = C;
let E; let F; let J;
try { E = loadEdit('engine'); F = loadEdit('fsio'); J = loadEdit('journal'); } catch (e) { ok('製品の編集エンジンを読み込める', false, String(e.message)); C.finish(); }
const { EditEngine } = E;
process.env.VCIDE_EDIT_E1_WRITE = '1';   // この試験は書き込みを明示して有効にする（S10 は自分で外す）

const ORIG = readFixture(CARD);
const AFTER = ORIG.replace('p-4 md:p-6', 'p-5 md:p-6');
const AFTER2 = ORIG.replace('p-4 md:p-6', 'p-4 md:p-8');
const EXT = `${ORIG}// 外部のエディタが保存した（1）\n`;
const EXT2 = `${ORIG}// 外部のエディタが保存した（2）\n`;
const change = (from = 'p-4', to = 'p-5') => ({ kind: 'class-token', from, to });
const CHILD = path.join(REPO, 'tests', 'lib', 'edit-crash-child.mjs');
const LINUX = process.platform === 'linux';
const require_sha = (t) => crypto.createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');

/* 外部の書き込みの2つの形 */
/** 同じ実体へ書く（VS Code・Prettier・多くのツールの fs.writeFile と同じ O_TRUNC での上書き） */
const inPlace = (p, text = EXT) => fs.writeFileSync(p.abs(CARD), text);
/** 別のファイルに書いて rename で置き換える（JetBrains の safe write・vim の既定の一部・git の checkout などと同じ形） */
const replaceSave = (p, text = EXT) => { const t = `${p.abs(CARD)}.ext-save`; fs.writeFileSync(t, text); fs.renameSync(t, p.abs(CARD)); };

function setup(name, { journalDir, hooks } = {}) {
  const p = makeProject({ [CARD]: ORIG }, { name });
  p.compile(CARD);
  const eng = new EditEngine({ projectRoot: p.root, journalDir: journalDir ?? p.journalDir, hooks });
  return { p, eng };
}
function draft(p, eng, from = 'p-4', to = 'p-5') {
  const s = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
  const t = eng.resolveTarget(s);
  if (!t.ok) throw new Error(`resolve: ${t.reason}`);
  const d = eng.createDraft(t.target.id, s, change(from, to));
  if (!d.ok) throw new Error(`draft: ${d.reason}`);
  return { s, d: d.draft };
}
const applyDraft = (eng, x) => eng.apply({ changes: [{ draftId: x.d.id, reviewedDiffHash: x.d.diffHash, selection: x.s }] });
/** 指定した段で act を1回だけ差し込んで適用する。fired と、段の順を返す */
function applyAt(name, at, act, opts = {}) {
  const steps = [];
  let fired = false;
  let pRef = null;
  const { p, eng } = setup(name, {
    ...opts,
    hooks: { step: (n) => { steps.push(n); if (n === at && !fired) { fired = true; act(pRef, n); } if (opts.onStep) opts.onStep(pRef, n); } },
  });
  pRef = p;
  const x = draft(p, eng);
  const r = applyDraft(eng, x);
  return { p, eng, r, fired, steps };
}
const journals = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^tx-[\w-]+\.json$/.test(n)) : [])
  .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
const nlink = (p) => fs.lstatSync(p.abs(CARD)).nlink;
const artifactsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.includes('vcide-edit')) : []);

/* ============================================================ S1 */
console.log('\nS1 正常なファイル変更（1ファイル・1トークン）と committed の保証の範囲');
guard('S1', () => {
  const { p, eng, r, steps } = applyAt('s1', 'never', () => {});
  eq('適用は committed', r.status, 'committed');
  eq('ファイルは p-4 → p-5 だけが変わる', p.read(CARD), AFTER);
  eq('一時ファイル・退避リンクを残さない', p.leftovers().length, 0);
  eq('書き込み先のリンク数は 1（退避リンクを外した）', nlink(p), 1);
  eq('ジャーナルは committed', eng.journal(r.txId)?.state, 'committed');
  ok('committed は検証前（verification: pending）で、成功（success）ではない', r.verification === 'pending' && eng.outcome(r.txId).success === false, eng.outcome(r.txId));
  const a = r.assurance;
  ok('committed の保証: 置き換えた元の実体が基準とバイト一致したことを rename の後に確かめた', a?.displacedOriginalVerified === true && a?.readBackVerified === true, a);
  eq('committed の保証: ディレクトリの実体を固定して操作した（Linux の /proc/self/fd）', a?.directoryPinned, LINUX);
  ok('committed は「競合が無かった」ことを保証しない（検出できない競合の種類を必ず返す）',
    Array.isArray(a?.undetectable) && ['replace-save-between-link-and-rename', 'write-through-descriptor-opened-before-replace', 'external-write-after-commit'].every((k) => a.undetectable.includes(k)), a);
  const order = ['before-final-check', 'before-rename', 'snapshot-linked', 'renamed', 'snapshot-verified'];
  ok('書き込みの段は 照合 → 退避リンク → rename → 退避リンクの照合 の順', order.every((s, i) => steps.indexOf(s) >= 0 && (i === 0 || steps.indexOf(s) > steps.indexOf(order[i - 1]))), steps);
  p.cleanup();
});

/* ============================================================ S2 */
console.log('\nS2 外部変更: 適用の前・照合の途中に外部がファイルを変えたら拒否する');
guard('S2', () => {
  for (const [label, how] of [['同じ実体への上書き', inPlace], ['rename による置き換え', replaceSave]]) {
    /* 下書きの後・適用の前 */
    {
      const { p, eng } = setup('s2a');
      const x = draft(p, eng);
      how(p);
      const r = applyDraft(eng, x);
      /* 探索の照合（DOM の版 ≠ いまのファイルの版）が先に止める（refused・target-unresolved・source-changed）か、内容のハッシュで止める（conflict） */
      ok(`[${label}] 下書きの後の外部変更: 書かない（written: false・選び直しを求める）`, r.written === false && r.reselect === true
        && (r.status === 'conflict' || (r.status === 'refused' && r.anchorReason === 'source-changed')), r);
      eq(`[${label}]（同）外部の版が残る`, p.read(CARD), EXT);
      eq(`[${label}]（同）一時ファイルを残さない`, p.leftovers().length, 0);
      p.cleanup();
    }
    /* 適用の途中（照合の段ごと） */
    for (const at of ['applying', 'before-temp', 'temp-written', 'before-final-check', 'before-last-stat']) {
      const { p, eng, r, fired } = applyAt('s2b', at, (q) => how(q));
      ok(`[${label}] ${at} の外部変更: 書かない（conflict・written: false）`, fired && r.status === 'conflict' && r.written === false, r);
      eq(`[${label}]（${at}）外部の版が残る`, p.read(CARD), EXT);
      eq(`[${label}]（${at}）一時ファイル・退避リンクを残さない`, p.leftovers().length, 0);
      eq(`[${label}]（${at}）ジャーナルは failed（committed にしない）`, eng.journal(r.txId)?.state ?? 'none', r.txId ? 'failed' : 'none');
      p.cleanup();
    }
  }
});

/* ============================================================ S3 */
console.log('\nS3 並行変更: 2つの変更要求が同じファイルを同時に編集しようとした');
guard('S3', () => {
  /* (a) 同じエンジンの再入: 適用の途中（退避リンクと rename の間）に、同じエンジンで2つ目の適用 */
  {
    const p = makeProject({ [CARD]: ORIG }, { name: 's3a' });
    p.compile(CARD);
    let inner = null; let fired = false;
    let eng = null; let x2 = null;
    eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir,
      hooks: { step: (n) => { if (n === 'snapshot-linked' && !fired) { fired = true; inner = applyDraft(eng, x2); } } } });
    const x1 = draft(p, eng, 'p-4', 'p-5');
    x2 = draft(p, eng, 'md:p-6', 'md:p-8');
    const r1 = applyDraft(eng, x1);
    ok('(a) 同じエンジンの適用の途中の2つ目の適用は busy（書かない）', fired && inner?.status === 'busy' && inner?.written === false, inner);
    eq('(a) 1つ目は committed', r1.status, 'committed');
    eq('(a) ファイルは1つ目の変更だけ', p.read(CARD), AFTER);
    const r2 = applyDraft(eng, x2);
    ok('(a) 古い基準の2つ目の下書きは、後から適用しても書かない（版の照合・内容のハッシュで止める）', r2.written === false && r2.status !== 'committed' && r2.reselect === true, r2);
    eq('(a)（同）ファイルは1つ目の変更のまま', p.read(CARD), AFTER);
    p.cleanup();
  }
  /* (b) 同じジャーナルを使う2つのエンジン（2つの IDE のプロセスと同じ取り決め） */
  {
    const p = makeProject({ [CARD]: ORIG }, { name: 's3b' });
    p.compile(CARD);
    let inner = null; let fired = false;
    const engB = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
    const xb = draft(p, engB, 'md:p-6', 'md:p-8');
    const engA = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir,
      hooks: { step: (n) => { if (n === 'snapshot-linked' && !fired) { fired = true; inner = applyDraft(engB, xb); } } } });
    const ra = applyDraft(engA, draft(p, engA));
    ok('(b) 同じジャーナルの別のエンジンは、適用の途中に割り込めない（busy）', fired && inner?.status === 'busy', inner);
    eq('(b) 1つ目は committed・ファイルは1つ目の変更だけ', `${ra.status}:${p.read(CARD) === AFTER}`, 'committed:true');
    p.cleanup();
  }
  /* (c) 別のジャーナル（鍵を共有しない）の2つのエンジン: B が A の最後の照合の後・退避リンクの前に適用を終える */
  {
    const p = makeProject({ [CARD]: ORIG }, { name: 's3c' });
    p.compile(CARD);
    let inner = null; let fired = false;
    const engB = new EditEngine({ projectRoot: p.root, journalDir: `${p.journalDir}-b` });
    const xb = draft(p, engB, 'md:p-6', 'md:p-8');
    const engA = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir,
      hooks: { step: (n) => { if (n === 'before-rename' && !fired) { fired = true; inner = applyDraft(engB, xb); } } } });
    const ra = applyDraft(engA, draft(p, engA));
    ok('(c) 前提: B は A の照合の後に committed', fired && inner?.status === 'committed', inner);
    ok('(c) A は書かない（committed と報告しない）', ra.status !== 'committed' && ra.written === false, ra);
    eq('(c) B の変更が残る（失われない）', p.read(CARD), AFTER2);
    eq('(c) 一時ファイル・退避リンクを残さない', p.leftovers().length, 0);
    p.cleanup();
  }
  /* (d) 別のジャーナルの2つのエンジン: B が A の退避リンクと rename の間に適用を試みる
   *     （その間、書き込み先のリンク数は 2。範囲の検査がハードリンクとして止めるので、エンジンどうしはこの窓で書けない） */
  {
    const p = makeProject({ [CARD]: ORIG }, { name: 's3d' });
    p.compile(CARD);
    let inner = null; let fired = false;
    const engB = new EditEngine({ projectRoot: p.root, journalDir: `${p.journalDir}-b` });
    const xb = draft(p, engB, 'md:p-6', 'md:p-8');
    const engA = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir,
      hooks: { step: (n) => { if (n === 'snapshot-linked' && !fired) { fired = true; inner = applyDraft(engB, xb); } } } });
    const ra = applyDraft(engA, draft(p, engA));
    ok('(d) 退避リンクと rename の間の別のエンジンの適用は書かない', fired && inner?.written === false && inner?.status !== 'committed', inner);
    eq('(d) A は committed・ファイルは A の変更', `${ra.status}:${p.read(CARD) === AFTER}`, 'committed:true');
    const rb = applyDraft(engB, xb);
    ok('(d) B の下書きは古い基準なので、後から適用しても書かない', rb.written === false && rb.status !== 'committed', rb);
    eq('(d) 一時ファイル・退避リンクを残さない', p.leftovers().length, 0);
    limit('S3(d) 鍵を共有しない2つのエンジン（別の IDE のプロセスの組）',
      { note: '同じジャーナルなら鍵で直列にする（S3 b）。別のジャーナルの組は鍵を共有せず、退避リンクのリンク数と内容の照合だけで守る。互いの照合の間の rename の窓は外部のエディタと同じ残余（S4 d）' });
    p.cleanup();
  }
});

/* ============================================================ S4 */
console.log('\nS4 最後の照合と rename の競合（同期点で差し込む。RV03）');
guard('S4', () => {
  /* (a) 最後の照合の後（従来の RV03 の窓）: 同じ実体への上書き */
  {
    const { p, eng, r, fired } = applyAt('s4a', 'before-rename', (q) => inPlace(q));
    ok('(a) 最後の照合の後の上書き: committed と報告しない', fired && r.status !== 'committed', r);
    eq('(a)（同）外部の版が残る（失われない）', p.read(CARD), EXT);
    ok('(a)（同）書いていない扱い（conflict・written: false）', r.status === 'conflict' && r.written === false, r);
    eq('(a)（同）一時ファイル・退避リンクを残さない', p.leftovers().length, 0);
    eq('(a)（同）ジャーナルは failed', eng.journal(r.txId)?.state, 'failed');
    p.cleanup();
  }
  /* (b) 退避リンクと rename の間: 同じ実体への上書き → rename の後の照合で見つけ、外部の版へ戻す */
  {
    const { p, eng, r, fired } = applyAt('s4b', 'snapshot-linked', (q) => inPlace(q));
    ok('(b) 退避リンクの後の上書き: committed と報告しない', fired && r.status !== 'committed', r);
    eq('(b)（同）外部の版が書き込み先に戻る', p.read(CARD), EXT);
    ok('(b)（同）conflict・written: false・transient（ごく短い間だけ自分の内容があった）', r.status === 'conflict' && r.written === false && r.transient === true, r);
    eq('(b)（同）一時ファイル・退避リンクを残さない', p.leftovers().length, 0);
    ok('(b)（同）ジャーナルは failed・書いていない', eng.journal(r.txId)?.state === 'failed' && eng.journal(r.txId)?.failure?.written === false, eng.journal(r.txId));
    p.cleanup();
  }
  /* (c) 最後の照合の後: rename による置き換え → 退避リンクの直前のパスの照合で見つける */
  {
    const { p, r, fired } = applyAt('s4c', 'before-rename', (q) => replaceSave(q));
    ok('(c) 最後の照合の後の置き換え: 書かない（conflict・written: false）', fired && r.status === 'conflict' && r.written === false, r);
    eq('(c)（同）外部の版が残る', p.read(CARD), EXT);
    eq('(c)（同）一時ファイル・退避リンクを残さない', p.leftovers().length, 0);
    p.cleanup();
  }
  /* (d) 退避リンクと rename の間: rename による置き換え → 検出できない（限界） */
  {
    const { p, r, fired } = applyAt('s4d', 'snapshot-linked', (q) => replaceSave(q));
    ok('(d) 前提: 差し込みが起きた', fired);
    ok('(d) committed なら、その結果は「この窓の置き換えを検出できない」ことを明示している',
      r.status !== 'committed' || r.assurance?.undetectable?.includes('replace-save-between-link-and-rename'), r);
    limit('S4(d) 退避リンクと rename の間（連続する2つの系呼び出しの間）の、rename による外部の置き換え',
      { status: r.status, externalLost: p.read(CARD) !== EXT, note: 'POSIX に条件付きの rename が無い（Node に renameat2 も無い）。docs/08b 第3.4節' });
    p.cleanup();
  }
  /* (e) rename の後・退避リンクの照合の前: 書き込み先（自分の版）への上書き → 外部の版が勝つ。成功扱いにしない */
  {
    const { p, eng, r, fired } = applyAt('s4e', 'renamed', (q) => inPlace(q));
    ok('(e) rename の直後の上書き: committed と報告しない（uncertain・written: true）', fired && r.status === 'uncertain' && r.written === true, r);
    eq('(e)（同）外部の版が残る（書き戻さない）', p.read(CARD), EXT);
    eq('(e)（同）一時ファイル・退避リンクを残さない', p.leftovers().length, 0);
    const rv = eng.revert(r.txId);
    ok('(e)（同）成否が確定しない書き込みは取り消しの対象にしない', rv.written === false && rv.reason === 'tx-not-committed', rv);
    p.cleanup();
  }
  /* (f) 適用の前から開いていた fd で、退避リンクの照合の後・外す前に書く */
  {
    let hold = null;
    const { p, r, fired } = applyAt('s4f', 'snapshot-verified', () => { fs.writeSync(hold, 'X', 0); }, {
      onStep: (q, n) => { if (n === 'before-temp' && hold === null) hold = fs.openSync(q.abs(CARD), 'r+'); },
    });
    ok('(f) 照合の後・外す前の fd からの書き込み: committed と報告しない', fired && r.status !== 'committed', r);
    eq('(f)（同）fd からの書き込みを含む版が書き込み先に残る', p.read(CARD), `X${ORIG.slice(1)}`);
    if (hold !== null) fs.closeSync(hold);
    p.cleanup();
  }
  /* (g) 適用の前から開いていた fd で、適用が終わった後に書く（限界） */
  {
    let hold = null;
    const { p, r } = applyAt('s4g', 'never', () => {}, {
      onStep: (q, n) => { if (n === 'before-temp' && hold === null) hold = fs.openSync(q.abs(CARD), 'r+'); },
    });
    if (hold !== null) { fs.writeSync(hold, 'X', 0); fs.closeSync(hold); }
    limit('S4(g) 置き換えの前から開いていた fd で、確定の後に書いた内容（名前の無くなった元の実体へ書かれる）',
      { status: r.status, lost: !p.read(CARD).startsWith('X'), note: 'rename による保存（外部のエディタの多く）と同じ性質。fd の持ち主を知る手段（リース）が Node に無い' });
    p.cleanup();
  }
  /* (h) 外部の版へ戻す途中に、自分の版へさらに外部が書く: 両方の外部の版を残し、要確認 */
  {
    const { p, r } = applyAt('s4h', 'snapshot-linked', (q) => inPlace(q, EXT), {
      onStep: (q, n) => { if (n === 'restore-linked') inPlace(q, EXT2); },
    });
    eq('(h) 1つ目の外部の版が書き込み先に戻る', p.read(CARD), EXT);
    ok('(h) 2つ目の外部の版（自分の版の実体へ書かれた）も消さずに残し、要確認', r.status === 'conflict' && r.needsAttention === true
      && (r.kept ?? []).length === 1 && fs.readFileSync(path.join(path.dirname(p.abs(CARD)), r.kept[0]), 'utf8') === EXT2, r);
    p.cleanup();
  }
});

/* ============================================================ S5 */
console.log('\nS5 安全確認の後のディレクトリの差し替え（src/components → src/ の外へのリンク）');
guard('S5', () => {
  for (const at of ['applying', 'before-temp', 'temp-created', 'temp-written', 'before-final-check', 'before-rename', 'snapshot-linked', 'renamed']) {
    let outDir = null;
    const seenOutside = new Set();
    const watch = (q) => { if (outDir) for (const n of fs.readdirSync(outDir)) if (n !== 'PropertyCard.tsx') seenOutside.add(n); };
    const { p, r, fired } = applyAt('s5', at, (q) => {
      fs.renameSync(path.join(q.root, 'src/components'), path.join(q.root, 'src/components.moved'));
      fs.symlinkSync(outDir, path.join(q.root, 'src/components'));
    }, {
      onStep: (q, n) => {
        if (outDir === null) { outDir = path.join(q.base, 'outside-dir'); fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'PropertyCard.tsx'), ORIG); }
        watch(q, n);
      },
    });
    watch(p);
    const outside = snapshot(outDir);
    ok(`[${at}] 差し替えが起きた・committed と報告しない`, fired && r.status !== 'committed', r);
    eq(`[${at}] src/ の外のディレクトリには、どの段でも（一時的にも）ファイルが作られない`, [...seenOutside].join(','), '');
    ok(`[${at}] src/ の外のファイルの内容は変わらない`, outside.size === 1 && fs.readFileSync(path.join(outDir, 'PropertyCard.tsx'), 'utf8') === ORIG, [...outside.keys()]);
    eq(`[${at}] src/ の中（移された元のディレクトリを含む）に一時ファイル・退避リンクを残さない`, p.leftovers().length, 0);
    const movedPath = path.join(p.root, 'src/components.moved/PropertyCard.tsx');
    const movedText = fs.existsSync(movedPath) ? fs.readFileSync(movedPath, 'utf8') : null;
    if (['snapshot-linked', 'renamed'].includes(at)) {
      ok(`[${at}] 置き換えは検査したディレクトリの実体の中だけ（移された元のディレクトリ）。成否は要確認として返す`, r.status === 'uncertain' && movedText === AFTER, { r, movedText: movedText === AFTER });
    } else {
      eq(`[${at}] 移された元のファイルは元のまま`, movedText, ORIG);
    }
    p.cleanup();
  }
});

/* S5b: ディレクトリを固定できない OS（/proc が無い macOS 等）と同じ経路（試験用の hooks.unpinned） */
guard('S5b', () => {
  for (const at of ['before-temp', 'temp-written', 'before-rename']) {
    const p = makeProject({ [CARD]: ORIG }, { name: 's5b' });
    const outDir = path.join(p.base, 'outside-dir');
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, 'PropertyCard.tsx'), ORIG);
    const seen = new Set();
    let fired = false;
    const H = (s) => { for (const n of fs.readdirSync(outDir)) if (n !== 'PropertyCard.tsx') seen.add(n); if (s === at && !fired) {
      fired = true;
      fs.renameSync(path.join(p.root, 'src/components'), path.join(p.root, 'src/components.moved'));
      fs.symlinkSync(outDir, path.join(p.root, 'src/components'));
    } };
    const sha = (t) => F.replaceSourceFile ? require_sha(t) : '';
    const w = F.replaceSourceFile({ projectRoot: p.root, rel: CARD, expectedHash: sha(ORIG), next: AFTER,
      tempName: '.PropertyCard.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp', hooks: { step: H, unpinned: true } });
    for (const n of fs.readdirSync(outDir)) if (n !== 'PropertyCard.tsx') seen.add(n);
    ok(`[固定なし ${at}] 書き込みを確定しない`, fired && w.status !== 'replaced', w);
    eq(`[固定なし ${at}] src/ の外のファイルの内容は変わらず、最後に何も残らない`, `${fs.readFileSync(path.join(outDir, 'PropertyCard.tsx'), 'utf8') === ORIG}:${fs.readdirSync(outDir).length}`, 'true:1');
    if (seen.size) limit(`S5b 固定なしの経路（${at}）: 自分の一時ファイルが一時的に src/ の外に作られ、検出して消す`, { seen: [...seen], status: w.status, reason: w.reason });
    p.cleanup();
  }
});

/* ============================================================ S6 */
console.log('\nS6 範囲外への書き込み（既存のファイルの変更と、新しいファイルの作成）');
guard('S6', () => {
  const p = makeProject({ [CARD]: ORIG }, { name: 's6' });
  p.compile(CARD);
  const outDir = path.join(p.base, 'outside-dir');
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'Exists.tsx'), 'export {}\n');
  fs.symlinkSync(outDir, path.join(p.root, 'src', 'linked'));
  const before = snapshot(p.base);
  const tempName = '.PropertyCard.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp';
  const H = 'a'.repeat(64);
  const tries = [
    ['next.config.mjs', tempName], ['src/../next.config.mjs', tempName], ['/etc/hosts', tempName],
    ['src/components/New.tsx', '.New.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp'],
    ['src/new/Deep.tsx', '.Deep.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp'],
    ['src/linked/Exists.tsx', '.Exists.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp'],
    ['src/linked/Missing.tsx', '.Missing.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp'],
    ['src/components/PropertyCard.css', tempName],
    [CARD, '../../evil.tmp'], [CARD, '.PropertyCard.tsx.vcide-edit-tx-20990101000000-deadbeef.orig.tmp'], [CARD, 'evil.tmp'],
  ];
  for (const [rel, tn] of tries) {
    const w = F.replaceSourceFile({ projectRoot: p.root, rel, expectedHash: H, next: 'export {}\n', tempName: tn });
    ok(`書き込みの入口は ${rel}（一時ファイル ${tn}）へ書かない`, w.status === 'not-written', w);
  }
  ok('src/ の外・新しい名前・リンク先のどこにもファイルを作らず、何も変えない', sameSnapshot(before, snapshot(p.base)),
    [...snapshot(p.base).keys()].filter((k) => !before.has(k)));
  /* 片付けの入口も、範囲の外・形の違う名前を消さない */
  fs.writeFileSync(path.join(outDir, '.Exists.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp'), 'decoy');
  const c1 = F.cleanupRecordedArtifacts?.(p.root, 'src/linked/Exists.tsx', '.Exists.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp', [], []);
  ok('片付けは src/ の外（リンクの先）の名前を消さない', c1 === null && fs.existsSync(path.join(outDir, '.Exists.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp')), c1);
  /* 記録の書き換え: 一時ファイルの名前を別の適用のもの（外部の内容を持つ退避リンク）に向けても、それを消させない */
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const x = draft(p, eng);
  const r = applyDraft(eng, x);
  const jf = path.join(p.journalDir, `${r.txId}.json`);
  const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
  const decoy = '.PropertyCard.tsx.vcide-edit-tx-20990101000000-cafebabe.orig.tmp';
  fs.writeFileSync(path.join(p.root, 'src/components', decoy), EXT);
  fs.writeFileSync(jf, JSON.stringify({ ...j, state: 'applying', owner: { pid: 999999, host: os.hostname() }, tempName: '.PropertyCard.tsx.vcide-edit-tx-20990101000000-cafebabe.tmp' }));
  const rc = eng.recover();
  ok('別の適用の一時ファイルの名前を持つ記録は形の不備（読まない・従わない）', rc.entries.some((e) => e.why === 'unreadable'), rc);
  ok('（同）外部の内容を持つ退避リンクは消えない', fs.existsSync(path.join(p.root, 'src/components', decoy)));
  eq('（同）ソースは適用後のまま', p.read(CARD), AFTER);
  p.cleanup();
});

/* ============================================================ S7 */
console.log('\nS7 異常終了: ジャーナルの各状態・書き込みの各段で SIGKILL → 復旧');
guard('S7', () => {
  const child = (p, selection, extra) => spawnSync(process.execPath, [CHILD, JSON.stringify({ libjs: LIB, root: p.root, journalDir: p.journalDir, selection, change: change(), mode: 'apply', ...extra })],
    { encoding: 'utf8', timeout: 60000 });
  const recover = (p) => new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).recover();
  const prep = (name) => { const p = makeProject({ [CARD]: ORIG }, { name }); p.compile(CARD); return { p, selection: selectionOf(p.anchorAt(CARD, 'p-4 md:p-6')) }; };
  const CASES = [
    { at: 'prepared', file: ORIG, state: 'prepared', arts: 0, action: 'mark-failed', after: ORIG },
    { at: 'applying', file: ORIG, state: 'applying', arts: 0, action: 'mark-failed', after: ORIG },
    { at: 'temp-written', file: ORIG, state: 'applying', arts: 1, action: 'mark-failed', after: ORIG },
    { at: 'before-rename', file: ORIG, state: 'applying', arts: 1, action: 'mark-failed', after: ORIG },
    { at: 'snapshot-linked', file: ORIG, state: 'applying', arts: 2, action: 'mark-failed', after: ORIG },
    { at: 'renamed', file: AFTER, state: 'applying', arts: 1, action: 'restore-before', after: ORIG },
    { at: 'snapshot-verified', file: AFTER, state: 'applying', arts: 1, action: 'restore-before', after: ORIG },
    { at: 'committed', file: AFTER, state: 'committed', arts: 0, action: 'none', after: AFTER },
  ];
  for (const k of CASES) {
    const { p, selection } = prep(`s7-${k.at}`);
    const c = child(p, selection, { at: k.at, action: 'crash' });
    const dir = path.join(p.root, 'src/components');
    eq(`[${k.at}] 子プロセスは SIGKILL で止まった`, c.signal, 'SIGKILL');
    ok(`[${k.at}] 止まった時点のファイルは${k.file === ORIG ? '適用前' : '適用後'}の内容（途中で切れた内容・名前が無い状態にならない）`, fs.existsSync(p.abs(CARD)) && p.read(CARD) === k.file);
    eq(`[${k.at}] 止まった時点のジャーナルは ${k.state}`, journals(p.journalDir)[0]?.state, k.state);
    eq(`[${k.at}] 止まった時点の一時ファイル・退避リンクの数`, artifactsIn(dir).length, k.arts);
    const dry = withWrites(false, () => recover(p));
    ok(`[${k.at}] 書き込みが無効なら復旧は見せるだけ（何も変えない）`, dry.status === 'dry-run' && p.read(CARD) === k.file && artifactsIn(dir).length === k.arts
      && journals(p.journalDir)[0]?.state === k.state, dry);
    const rc = recover(p);
    eq(`[${k.at}] 復旧の判断は ${k.action}`, rc.entries[0]?.action, k.action);
    eq(`[${k.at}] 復旧の後のファイル`, p.read(CARD), k.after);
    eq(`[${k.at}] 復旧の後のジャーナルは${k.state === 'committed' ? ' committed のまま' : ' failed（committed にしない）'}`, journals(p.journalDir)[0]?.state, k.state === 'committed' ? 'committed' : 'failed');
    eq(`[${k.at}] 復旧の後に一時ファイル・退避リンクを残さない`, artifactsIn(dir).length, 0);
    eq(`[${k.at}] 復旧の後のリンク数は 1`, nlink(p), 1);
    const again = recover(p);
    ok(`[${k.at}] 2回目の復旧は何もしない`, again.entries.every((x) => x.action === 'none' && x.wrote === false), again);
    p.cleanup();
  }
  /* 外部の版へ戻す途中で止まった: 外部の版（退避リンク）を消さず、適用前へも戻さず、要確認 */
  {
    const { p, selection } = prep('s7-restore');
    const c = child(p, selection, { at: 'restore-linked', action: 'crash', mutate: { at: 'snapshot-linked', file: p.abs(CARD), text: EXT, how: 'inplace' } });
    eq('[外部の版へ戻す途中] 子プロセスは SIGKILL で止まった', c.signal, 'SIGKILL');
    const rc = recover(p);
    const dir = path.join(p.root, 'src/components');
    const keptExt = artifactsIn(dir).filter((n) => fs.readFileSync(path.join(dir, n), 'utf8') === EXT);
    ok('[外部の版へ戻す途中] 復旧は書かない（refuse）', rc.entries[0]?.action === 'refuse' && rc.entries[0]?.wrote === false, rc);
    eq('[外部の版へ戻す途中] 外部の版は退避リンクとして残る（消さない）', keptExt.length, 1);
    ok('[外部の版へ戻す途中] ジャーナルは failed・要確認', journals(p.journalDir)[0]?.state === 'failed' && journals(p.journalDir)[0]?.needsAttention === true);
    eq('[外部の版へ戻す途中] 書き込み先のリンク数は 1（自分の版への余分な名前は外した）', nlink(p), 1);
    p.cleanup();
  }
  /* rename の後で止まり、復旧の前に外部変更: 書かずに要確認（外部変更を巻き戻さない） */
  {
    const { p, selection } = prep('s7-ext');
    child(p, selection, { at: 'renamed', action: 'crash' });
    inPlace(p, `${AFTER}// 停止の後に保存\n`);
    const rc = recover(p);
    ok('[停止の後の外部変更] 復旧は書かない（refuse）', rc.entries[0]?.action === 'refuse' && rc.entries[0]?.wrote === false, rc);
    eq('[停止の後の外部変更] 外部変更は残る', p.read(CARD), `${AFTER}// 停止の後に保存\n`);
    p.cleanup();
  }
  /* 復旧の途中（適用前へ戻す書き込み）の退避リンクの後で止まった → 次の復旧で片付く */
  for (const at of ['snapshot-linked', 'renamed', 'snapshot-verified']) {
    const { p, selection } = prep(`s7-rec-${at}`);
    child(p, selection, { at: 'renamed', action: 'crash' });
    const c2 = spawnSync(process.execPath, [CHILD, JSON.stringify({ libjs: LIB, root: p.root, journalDir: p.journalDir, mode: 'recover', at, action: 'crash' })], { encoding: 'utf8', timeout: 60000 });
    eq(`[復旧の途中 ${at}] 復旧の子プロセスも SIGKILL で止まった`, c2.signal, 'SIGKILL');
    const rc = recover(p);
    eq(`[復旧の途中 ${at}] 次の復旧でファイルは適用前`, p.read(CARD), ORIG);
    eq(`[復旧の途中 ${at}] ジャーナルは failed`, journals(p.journalDir)[0]?.state, 'failed');
    eq(`[復旧の途中 ${at}] 一時ファイル・退避リンク（適用と復旧の両方）を残さない`, artifactsIn(path.join(p.root, 'src/components')).length, 0);
    note(`判断: ${rc.entries[0]?.action}`);
    p.cleanup();
  }
  /* PID の再利用（持ち主の pid が別の生きているプロセス）・別のホスト・古いジャーナル */
  {
    const { p, selection } = prep('s7-pid');
    child(p, selection, { at: 'renamed', action: 'crash' });
    const jf = path.join(p.journalDir, fs.readdirSync(p.journalDir).find((n) => /^tx-.*\.json$/.test(n)));
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
    const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    fs.writeFileSync(jf, JSON.stringify({ ...j, owner: { pid: alive.pid, host: os.hostname() } }));
    const r1 = recover(p);
    ok('[PID の再利用] 持ち主の pid が生きていれば、別のプロセスでも何もしない（安全側。片付かない）', r1.entries[0]?.action === 'none' && p.read(CARD) === AFTER, r1);
    alive.kill('SIGKILL');
    fs.writeFileSync(jf, JSON.stringify({ ...j, owner: { pid: 999999, host: 'another-host.example' } }));
    const r2 = recover(p);
    ok('[別のホスト] 持ち主を確かめられない記録は何もしない（安全側）', r2.entries[0]?.action === 'none' && p.read(CARD) === AFTER && journals(p.journalDir)[0]?.state === 'applying', r2);
    fs.writeFileSync(jf, JSON.stringify({ ...j, owner: { pid: 999999, host: os.hostname() }, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }));
    const r3 = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir, clock: () => Date.now() }).recover();
    ok('[古いジャーナル] 終わっていない古い記録は保存期間で消さず、仕様どおりに復旧する', r3.entries[0]?.action === 'restore-before' && p.read(CARD) === ORIG && journals(p.journalDir)[0]?.state === 'failed', r3);
    limit('S7 PID の再利用・別のホスト（コンテナの作り直し）', { note: '持ち主が生きているかを確かめられない記録は、安全側で何もしない。そのため自動では片付かず要確認として残る（E2 で画面に出す）' });
    p.cleanup();
  }
  /* 古い鍵を2つのプロセスが同時に取り除く競合（同期点: 古いと判断した直後） */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-s7-lock-'));
    const lock = path.join(dir, 'apply.lock');
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
    fs.writeFileSync(lock, JSON.stringify({ pid: dead, host: os.hostname(), at: new Date().toISOString() }));
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    let fired = false;
    const got = F.acquireLock(dir, { afterStaleRead: () => {
      fired = true;
      /* 別のプロセスが先に古い鍵を取り除き、新しい鍵を取った */
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, JSON.stringify({ pid: other.pid, host: os.hostname(), at: new Date().toISOString() }));
    } });
    ok('[鍵の競合] 前提: 同期点で割り込んだ', fired);
    ok('[鍵の競合] 別のプロセスの新しい鍵を消さず、自分は鍵を取らない', got === null && JSON.parse(fs.readFileSync(lock, 'utf8')).pid === other.pid, { got: typeof got });
    eq('[鍵の競合] 取り除き用の一時的な名前を残さない', fs.readdirSync(dir).filter((n) => n !== 'apply.lock').length, 0);
    if (typeof got === 'function') got();
    other.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================ S8 */
console.log('\nS8 確定済み（committed）の変更は、復旧で取り消されない');
guard('S8', () => {
  const { p, eng, r } = applyAt('s8', 'never', () => {});
  eq('前提: committed', r.status, 'committed');
  const dir = path.join(p.root, 'src/components');
  const stray = `.PropertyCard.tsx.vcide-edit-${r.txId}.orig.tmp`;
  fs.writeFileSync(path.join(dir, stray), EXT);
  const rc = eng.recover();
  ok('committed のジャーナルに何もしない', rc.entries.every((e) => e.action === 'none' && e.wrote === false), rc);
  eq('ファイルは適用後のまま', p.read(CARD), AFTER);
  ok('終わった記録の名前を持つファイルにも触れない（外部の内容を持ちうる）', fs.existsSync(path.join(dir, stray)));
  fs.rmSync(path.join(dir, stray));
  inPlace(p, ORIG);
  eng.recover();
  eq('利用者が適用前へ戻した内容にも触れない', p.read(CARD), ORIG);
  inPlace(p, `${AFTER}// 確定の後の編集\n`);
  const rv = eng.revert(r.txId);
  ok('確定の後に外部変更があれば、取り消しも書かない', rv.written === false && rv.reason === 'changed-after-apply', rv);
  p.cleanup();
});

/* ============================================================ S9 */
console.log('\nS9 検証不足: プレビューの検証が足りなければ verified にしない');
guard('S9', () => {
  const NOTE = 'src/components/Note.tsx';
  const p = makeProject({ [CARD]: ORIG, [NOTE]: 'export function Note() {\n  return <p className="text-sm">n</p>;\n}\n' }, { name: 's9' });
  p.compile(CARD); p.compile(NOTE);
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const x = draft(p, eng);
  const a = p.anchorAt(CARD, 'p-4 md:p-6');
  const r = applyDraft(eng, x);
  eq('前提: committed', r.status, 'committed');
  const noteRev = p.compile(NOTE).rev;
  const at = new Date(Math.max(Date.now(), Date.parse(eng.journal(r.txId).committedAt))).toISOString();   // 確定の後に測った
  const board = (w, extra = {}) => ({
    viewport: { width: w, height: 800 }, mode: 'measured', predictionMarkers: 0, measuredAt: at,
    document: { token: 'a'.repeat(32), path: '/', sourceRevs: { [CARD]: r.afterRev, [NOTE]: noteRev } },
    elements: [{ anchorId: a.id, rev: r.afterRev, classTokens: ['rounded-lg', 'border', 'bg-white', 'p-5', 'md:p-6', 'shadow-sm'], computed: {} }],
    ...extra,
  });
  const rep = (boards) => ({ txId: r.txId, anchorId: a.id, file: CARD, sourceRev: r.afterRev, measuredAt: at, artboards: boards });
  const v1 = eng.submitVerification(rep([board(375)]));
  ok('Mobile だけ: verified にしない（viewport-missing）', v1.status === 'not-verified' && v1.problems.some((q) => q.code === 'viewport-missing'), v1.problems);
  const v2 = eng.submitVerification(rep([board(1440), board(375, { mode: 'predicted' })]));
  ok('予測を含む: verified にしない', v2.status === 'not-verified' && v2.problems.some((q) => q.code === 'predicted-not-accepted'), v2.problems);
  const v3 = eng.submitVerification(rep([board(1440), board(375, { predictionMarkers: 2 })]));
  ok('予測の印が残る描画: verified にしない', v3.status === 'not-verified', v3.problems);
  const v4 = eng.submitVerification(rep([board(1440), board(375), board(375)]));
  ok('同じ幅が2回: verified にしない', v4.status === 'not-verified' && v4.problems.some((q) => q.code === 'duplicate-viewport'), v4.problems);
  eq('ここまで outcome は成功ではない', eng.outcome(r.txId).success, false);
  const v5 = eng.submitVerification(rep(VIEWPORTS.map((vp) => board(vp.width))));
  eq('2幅の実測・版・対応が揃えば verified', v5.status, 'verified');
  const o1 = eng.outcome(r.txId);
  ok('（同）success = committed かつ verified', o1.success === true && o1.staleSinceVerification === false, o1);
  /* 検証の後に、文書が描いた別のファイルが変わった */
  fs.writeFileSync(p.abs(NOTE), 'export function Note() {\n  return <p className="text-base">n</p>;\n}\n');
  ok('検証の後に描いた別のファイルが変わると staleSinceVerification（検証はいまの内容の証拠ではない）', eng.outcome(r.txId).staleSinceVerification === true, eng.outcome(r.txId));
  /* 検証の後に、対象のファイルが変わった */
  inPlace(p, `${AFTER}// 検証の後\n`);
  ok('検証の後に対象のファイルが変わると staleSinceVerification', eng.outcome(r.txId).staleSinceVerification === true, eng.outcome(r.txId));
  const v6 = eng.submitVerification(rep(VIEWPORTS.map((vp) => board(vp.width))));
  ok('変わった後に同じ報告を送っても verified にしない（stale-source）', v6.status === 'not-verified' && v6.problems.some((q) => q.code === 'stale-source'), v6.problems);
  /* committed でない適用は検証しない */
  const { p: q, r: rq } = applyAt('s9b', 'renamed', (z) => inPlace(z));
  const engQ = new EditEngine({ projectRoot: q.root, journalDir: q.journalDir });
  const vq = engQ.submitVerification({ txId: rq.txId, anchorId: a.id, file: CARD, sourceRev: r.afterRev, measuredAt: at, artboards: VIEWPORTS.map((vp) => board(vp.width)) });
  ok('uncertain の適用は検証の対象にしない（tx-not-committed）', vq.status === 'not-verified' && vq.problems.some((x2) => x2.code === 'tx-not-committed'), vq);
  p.cleanup(); q.cleanup();
});

/* ============================================================ S10 */
console.log('\nS10 既定で無効: 通常の起動では編集できない');
guard('S10', () => {
  const p = makeProject({ [CARD]: ORIG }, { name: 's10' });
  p.compile(CARD);
  const dir = path.join(p.root, 'src/components');
  const tn = '.PropertyCard.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp';
  fs.writeFileSync(path.join(dir, tn), 'temp');
  fs.writeFileSync(path.join(dir, tn.replace(/\.tmp$/, '.orig.tmp')), ORIG);
  const before = snapshot(p.base);
  withWrites(false, () => {
    eq('環境変数が無いと書き込みは無効', E.editWritesEnabled(), false);
    const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
    const x = draft(p, eng);
    const r = applyDraft(eng, x);
    ok('適用は書かない（refused・edit-disabled）', r.status === 'refused' && r.reason === 'edit-disabled' && r.written === false, r);
    const w = F.replaceSourceFile({ projectRoot: p.root, rel: CARD, expectedHash: 'a'.repeat(64), next: 'x', tempName: tn.replace('deadbeef', 'deadbeee') });
    ok('書き込みの入口も書かない', w.status === 'not-written' && w.reason === 'edit-disabled', w);
    const c = F.cleanupRecordedArtifacts?.(p.root, CARD, tn, [], []);
    ok('片付けの入口も消さない', c === null, c);
    const rc = eng.recover();
    eq('復旧は見せるだけ（dry-run）', rc.status, 'dry-run');
  });
  ok('無効の間、ソース・一時ファイル・退避リンク・記録のどれも変わらない（ジャーナルの置き場所も作らない）',
    sameSnapshot(before, snapshot(p.base)), [...snapshot(p.base).keys()].filter((k) => !before.has(k)));
  p.cleanup();
});

C.finish();
