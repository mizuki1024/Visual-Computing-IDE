/* =============================================================================
 * 編集 E1 — 書き込み範囲の試験（T4・F-02。06h レビューの RV01・RV02 に相当）。
 *   npm run build:lib && node tests/edit-scope-unit.spec.mjs
 *
 *   1. パスの形: 絶対パス・..・src/ の外・拡張子・node_modules・隠しファイル・NUL・\ を拒否する
 *   2. シンボリックリンク: 葉・途中のディレクトリ・src そのもの。リンク先がプロジェクトの外でも中（src/ の外）でも拒否（RV01・RV02）
 *   3. ハードリンク: 拒否する
 *   4. 書き込み直前の再検証: 下書きの後に、同じ内容のリンクへ差し替えられても書かない
 *   5. 検査から書き込みまでの競合（段ごとにディレクトリ・ファイルを差し替える）: src/ の外の内容を置き換えない。
 *      残る窓は「既知の限界」として記録する（安全の主張にしない）
 *   6. ジャーナルの書き換えで src/ の外を指させても、取り消し・復旧で書かない
 * すべて使い捨ての題材（OS の一時ディレクトリ）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { counter, makeProject, selectionOf, loadEdit, readFixture, CARD, snapshot, sameSnapshot } from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note, limit, guard } = C;
let E; let S;
try { E = loadEdit('engine'); S = loadEdit('scope'); } catch (e) { ok('製品の編集エンジン・範囲の検査を読み込める', false, String(e.message)); C.finish(); }
const { EditEngine } = E;
process.env.VCIDE_EDIT_E1_WRITE = '1';

const ORIG = readFixture(CARD);
const change = { kind: 'class-token', from: 'p-4', to: 'p-5' };
/** 題材の外（同じ一時ディレクトリの中・プロジェクトの根の外）に、同じ内容のファイルを置く */
const outsideOf = (p, rel = 'outside/PropertyCard.tsx', text = ORIG) => {
  const f = path.join(p.base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};

/* ============================================================ 1 */
console.log('\n1. パスの形');
guard('1', () => {
  const p = makeProject({ [CARD]: ORIG, 'src/components/util.ts': 'export const x = 1;\n', 'src/app/globals.css': '.a{}\n' }, { name: 'scope1' });
  fs.writeFileSync(path.join(p.root, '.env'), 'SECRET=1\n');
  const bad = ['/etc/passwd', '../outside.tsx', 'src/../next.config.mjs', 'next.config.mjs', '.env', 'src/.env.tsx',
    'src/components/util.ts', 'src/app/globals.css', 'src/node_modules/x.tsx', 'src//components/PropertyCard.tsx',
    'src/./components/PropertyCard.tsx', 'src\\components\\PropertyCard.tsx', 'src/components/PropertyCard.tsx\u0000',
    'SRC/components/PropertyCard.tsx', 'src/components/PropertyCard.TSX', '', 42, null];
  for (const rel of bad) {
    const r = S.resolveWritable(p.root, rel);
    ok(`拒否: ${JSON.stringify(rel)}（${r.ok ? 'ok' : r.reason}）`, r.ok === false, r);
  }
  const good = S.resolveWritable(p.root, CARD);
  ok('src/ の下の .tsx は書き込み先になる', good.ok === true && good.file.real === path.join(p.root, CARD), good);
  ok('書き込み先の実体のパスは realpath(root/src) の中', good.ok && good.file.real.startsWith(`${fs.realpathSync(path.join(p.root, 'src'))}${path.sep}`));
  const missing = S.resolveWritable(p.root, 'src/components/Nope.tsx');
  ok('存在しないファイルは拒否（新規作成は E1 の対象外）', missing.ok === false && missing.reason === 'missing', missing);
  p.cleanup();
});

/* ============================================================ 2 */
console.log('\n2. シンボリックリンク（RV01・RV02）');
guard('2', () => {
  /* (a) 葉がプロジェクトの外を指す */
  {
    const p = makeProject({}, { name: 'scope2a' });
    const out = outsideOf(p);
    fs.mkdirSync(path.join(p.root, 'src/components'), { recursive: true });
    fs.symlinkSync(out, path.join(p.root, CARD));
    p.compile(CARD);
    const before = fs.readFileSync(out, 'utf8');
    const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
    const r = eng.resolveTarget(selectionOf(p.anchorAt(CARD, 'p-4 md:p-6')));
    ok('(a) プロジェクトの外を指すリンクの要素は対象にしない', r.ok === false && ['outside-scope', 'target-unresolved'].includes(r.reason), r);
    const w = S.resolveWritable(p.root, CARD);
    ok('(a) 書き込み先の検査も拒否（symlink-in-path）', w.ok === false && w.reason === 'symlink-in-path', w);
    eq('(a) リンク先は変わらない', fs.readFileSync(out, 'utf8'), before);
    p.cleanup();
  }
  /* (b) 葉がプロジェクトの中・src/ の外を指す（RV01: 探索の照合は根の中なので通る。編集は src/ の中だけ） */
  {
    const p = makeProject({ 'notsrc/PropertyCard.tsx': ORIG }, { name: 'scope2b' });
    fs.mkdirSync(path.join(p.root, 'src/components'), { recursive: true });
    fs.symlinkSync(path.join(p.root, 'notsrc/PropertyCard.tsx'), path.join(p.root, CARD));
    p.compile(CARD);
    const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
    const s = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
    const r = eng.resolveTarget(s);
    ok('(b) RV01: src/ の中のリンクが src/ の外（プロジェクトの中）を指すなら対象にしない（outside-scope）', r.ok === false && r.reason === 'outside-scope', r);
    note(`探索の照合（anchors.ts）の結果に依らず、編集は自分で範囲を確かめる（照合: ${r.anchorReason ?? '通過'}）`);
    eq('(b) RV02: リンク先（src/ の外）は変わらない', fs.readFileSync(path.join(p.root, 'notsrc/PropertyCard.tsx'), 'utf8'), ORIG);
    p.cleanup();
  }
  /* (c) 途中のディレクトリがリンク（プロジェクトの中） */
  {
    const p = makeProject({ 'shared/PropertyCard.tsx': ORIG }, { name: 'scope2c' });
    fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
    fs.symlinkSync(path.join(p.root, 'shared'), path.join(p.root, 'src/shared'));
    const rel = 'src/shared/PropertyCard.tsx';
    p.compile(rel);
    const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
    const r = eng.resolveTarget(selectionOf(p.anchorAt(rel, 'p-4 md:p-6')));
    ok('(c) 途中のディレクトリがリンクなら対象にしない', r.ok === false && r.reason === 'outside-scope', r);
    const w = S.resolveWritable(p.root, rel);
    eq('(c) 理由は symlink-in-path', w.ok ? 'ok' : w.reason, 'symlink-in-path');
    eq('(c) リンク先は変わらない', fs.readFileSync(path.join(p.root, 'shared/PropertyCard.tsx'), 'utf8'), ORIG);
    p.cleanup();
  }
  /* (d) src そのものがリンク */
  {
    const p = makeProject({}, { name: 'scope2d' });
    fs.rmSync(path.join(p.root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(p.root, 'real-src/components'), { recursive: true });
    fs.writeFileSync(path.join(p.root, 'real-src', 'components', 'PropertyCard.tsx'), ORIG);
    fs.symlinkSync(path.join(p.root, 'real-src'), path.join(p.root, 'src'));
    const w = S.resolveWritable(p.root, CARD);
    ok('(d) src そのものがリンクなら書き込み先にしない', w.ok === false && w.reason === 'symlink-in-path', w);
    p.cleanup();
  }
});

/* ============================================================ 3 */
console.log('\n3. ハードリンク');
guard('3', () => {
  const p = makeProject({}, { name: 'scope3' });
  const out = outsideOf(p);
  fs.mkdirSync(path.join(p.root, 'src/components'), { recursive: true });
  fs.linkSync(out, path.join(p.root, CARD));
  const w = S.resolveWritable(p.root, CARD);
  ok('ハードリンク（リンク数 > 1）は書き込み先にしない', w.ok === false && w.reason === 'hard-linked', w);
  eq('外のファイルは変わらない', fs.readFileSync(out, 'utf8'), ORIG);
  p.cleanup();
});

/* ============================================================ 4 */
console.log('\n4. 書き込み直前の再検証（下書きの後に同じ内容のリンクへ差し替え）');
guard('4', () => {
  const p = makeProject({ [CARD]: ORIG }, { name: 'scope4' });
  p.compile(CARD);
  const out = outsideOf(p);
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const s = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
  const t = eng.resolveTarget(s).target;
  const d = eng.createDraft(t.id, s, change).draft;
  fs.rmSync(path.join(p.root, CARD));
  fs.symlinkSync(out, path.join(p.root, CARD));   // 内容のハッシュは同じ。リンクかどうかでしか見分けられない
  const r = eng.apply({ changes: [{ draftId: d.id, reviewedDiffHash: d.diffHash, selection: s }] });
  ok('適用の直前にリンクへ差し替えられたら書かない', r.written === false && r.status !== 'committed', r);
  eq('リンク先（プロジェクトの外）は変わらない', fs.readFileSync(out, 'utf8'), ORIG);
  ok('リンクはそのまま（消したり置き換えたりしない）', fs.lstatSync(path.join(p.root, CARD)).isSymbolicLink());
  p.cleanup();
});

/* ============================================================ 5 */
console.log('\n5. 検査から書き込みまでの競合（段ごとの差し替え）');
guard('5', () => {
  const race = (step, swap) => {
    const p = makeProject({ [CARD]: ORIG }, { name: 'scope5' });
    p.compile(CARD);
    const outDir = path.join(p.base, 'outside-dir');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'PropertyCard.tsx'), ORIG);
    const outSnap = () => snapshot(outDir);
    const before = outSnap();
    let fired = false;
    const eng = new EditEngine({
      projectRoot: p.root, journalDir: p.journalDir,
      hooks: { step: (name) => { if (name === step && !fired) { fired = true; swap(p, outDir); } } },
    });
    const s = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
    const t = eng.resolveTarget(s).target;
    const d = eng.createDraft(t.id, s, change).draft;
    const r = eng.apply({ changes: [{ draftId: d.id, reviewedDiffHash: d.diffHash, selection: s }] });
    return { p, r, fired, outsideSame: sameSnapshot(before, outSnap()), outSnap: [...outSnap().keys()], eng };
  };
  /* ディレクトリをリンクへ差し替える（src/components → プロジェクトの外） */
  const swapDir = (p, outDir) => {
    fs.renameSync(path.join(p.root, 'src/components'), path.join(p.root, 'src/components.moved'));
    fs.symlinkSync(outDir, path.join(p.root, 'src/components'));
  };
  /* ファイルをリンクへ差し替える */
  const swapLeaf = (p, outDir) => {
    fs.rmSync(path.join(p.root, CARD));
    fs.symlinkSync(path.join(outDir, 'PropertyCard.tsx'), path.join(p.root, CARD));
  };
  for (const step of ['applying', 'before-temp', 'temp-created', 'temp-written', 'before-final-check', 'before-last-stat']) {
    const { p, r, fired, outsideSame, outSnap } = race(step, swapDir);
    ok(`ディレクトリの差し替え（${step}）: 書き込みを確定しない`, fired && r.status !== 'committed', r);
    ok(`（${step}）src/ の外のディレクトリの中身は変わらない（一時ファイルも残さない）`, outsideSame, outSnap);
    eq(`（${step}）src/ に一時ファイルを残さない`, p.leftovers().length, 0);
    p.cleanup();
  }
  for (const step of ['applying', 'temp-written', 'before-final-check', 'before-last-stat', 'before-rename']) {
    const { p, r, fired, outsideSame } = race(step, swapLeaf);
    ok(`ファイルの差し替え（${step}）: src/ の外のファイルは変わらない`, fired && outsideSame, r);
    if (step === 'before-rename') {
      note(`rename は対象の名前（リンク）を置き換えるだけで、リンク先へは書かない（結果: ${r.status}）`);
    } else {
      ok(`（${step}）書き込みを確定しない`, r.status !== 'committed', r);
    }
    p.cleanup();
  }
  /* rename の直前のディレクトリの差し替え: 一時ファイルは元のディレクトリにあるので、外へは置かれない */
  {
    const { p, r, outsideSame, outSnap } = race('before-rename', swapDir);
    ok('ディレクトリの差し替え（before-rename）: src/ の外の中身は変わらない', outsideSame, { r, outSnap });
    ok('（before-rename）成功と報告しない', r.status !== 'committed', r);
    eq('（before-rename）一時ファイルを残さない（移された元のディレクトリからも消す）', p.leftovers().length, 0);
    p.cleanup();
  }
  limit('同じ権限で src/ を書き換え続ける敵対的なプロセスとの競合（検査と rename の間でディレクトリを2回以上差し替える）',
    { note: 'Node に renameat/openat が無いため 0 にできない。Linux では /proc/self/fd で書いた実体の場所を事後に確かめて要確認として報告する（docs/08a 第5節）' });
});

/* ============================================================ 6 */
console.log('\n6. ジャーナルの書き換えで src/ の外を指させても書かない');
guard('6', () => {
  const p = makeProject({ [CARD]: ORIG }, { name: 'scope6' });
  p.compile(CARD);
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const s = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
  const d = eng.createDraft(eng.resolveTarget(s).target.id, s, change).draft;
  const r = eng.apply({ changes: [{ draftId: d.id, reviewedDiffHash: d.diffHash, selection: s }] });
  const jf = path.join(p.journalDir, `${r.txId}.json`);
  const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
  const cfgBefore = fs.readFileSync(path.join(p.root, 'next.config.mjs'), 'utf8');
  for (const file of ['next.config.mjs', 'src/../next.config.mjs', '/etc/hosts']) {
    fs.writeFileSync(jf, JSON.stringify({ ...j, file }));
    const eng2 = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
    const rv = eng2.revert(r.txId);
    ok(`ジャーナルの file を ${file} に書き換えても取り消しで書かない`, rv.written === false, rv);
    const rc = eng2.recover();
    ok(`（同）復旧も書かない`, rc.entries.every((e) => e.wrote !== true), rc);
  }
  eq('next.config.mjs は変わらない', fs.readFileSync(path.join(p.root, 'next.config.mjs'), 'utf8'), cfgBefore);
  fs.writeFileSync(jf, JSON.stringify({ ...j, projectRoot: '/' }));
  const rv = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir }).revert(r.txId);
  ok('ジャーナルのプロジェクトの根が違えば取り消さない', rv.written === false, rv);
  p.cleanup();
});

C.finish();
