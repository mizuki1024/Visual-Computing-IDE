/* =============================================================================
 * 編集 E1 — 書き込みエンジンの単体試験（T1・T2・T3・T5・T6・T11 と、F-01 の3段の照合）。
 *   npm run build:lib && node tests/edit-engine-unit.spec.mjs
 *
 * 06h 独立レビューの再現試験（RV03・RV04・RV07・RV08）に相当するものを、**製品のコード**（src/server/edit）に対して、
 * **使い捨ての題材**（OS の一時ディレクトリ）で回す。リポジトリの題材（poc/fixture-edit）は読むだけ。
 *
 *   T1  正常な変更: p-4 → p-5（1ファイル・1トークン。差分は1文字・md:p-6 は変えない）
 *   T2  古い版: 対象のソースが変わったら、下書きの作成・適用を拒否する
 *   T3  別の要素への誤編集: 同じ (行:列)・同じタグ・同じコンポーネントに別の要素が来たら拒否する（RV07・RV08）。
 *       いまの DOM で選び直した要素には、正しく対応付ける
 *   T5  外部変更: 下書きの後・適用の途中でファイルが変わったら上書きしない（RV03 の窓は既知の限界として記録）
 *   T6  複数ファイル・複数の変更: E1 では拒否する（RV04）
 *   T11 外部変更の後の取り消し: 危険な取り消しを拒否する（F-11 も）
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import {
  counter, makeProject, selectionOf, withWrites, loadEdit, sha256, readFixture, CARD, TWO, TWO_SRC, AN,
} from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note, limit, guard } = C;
let E;
try { E = loadEdit('engine'); } catch (e) { ok('製品の編集エンジン（.libjs/server/edit/engine.js）を読み込める', false, String(e.message)); C.finish(); }
const { EditEngine } = E;
process.env.VCIDE_EDIT_E1_WRITE = '1';   // この試験は書き込みを明示して有効にする（既定で無効なことは edit-disabled が確かめる）

const ORIG_CARD = readFixture(CARD);
const change = (from, to) => ({ kind: 'class-token', from, to });
const fresh = (files = { [CARD]: ORIG_CARD }) => {
  const p = makeProject(files, { name: 'eng' });
  for (const rel of Object.keys(files)) p.compile(rel);
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  return { p, eng };
};
/** 選択 → 下書き → 適用（成功を前提にする手順。途中の失敗は試験の失敗） */
function flow(p, eng, rel, needle, from, to) {
  const a = p.anchorAt(rel, needle);
  const s = selectionOf(a);
  const t = eng.resolveTarget(s);
  if (!t.ok) throw new Error(`resolve: ${t.reason} ${t.detail}`);
  const d = eng.createDraft(t.target.id, s, change(from, to));
  if (!d.ok) throw new Error(`draft: ${d.reason} ${d.detail}`);
  return { a, s, t: t.target, d: d.draft };
}

/* ============================================================ T1 */
console.log('\nT1 正常な変更（p-4 → p-5。1ファイル・1トークン）');
guard('T1', () => {
  const { p, eng } = fresh();
  const { s, t, d } = flow(p, eng, CARD, 'p-4 md:p-6', 'p-4', 'p-5');
  ok('対象の解決は、選んだ要素（外枠の <div>）・版・内容の指紋を持つ', t.tag === 'div' && t.component === 'PropertyCard'
    && /^[0-9a-f]{16}$/.test(t.sourceRev) && /^[0-9a-f]{64}$/.test(t.contentHash) && /^[0-9a-f]{64}$/.test(t.fingerprint), t);
  ok('対象は DOM の版・対応表の版・ファイルの版が一致したもの', t.domRev === t.sourceRev && t.manifestRev === t.sourceRev, t);
  eq('下書きはファイルに触れない（内容は元のまま）', p.read(CARD), ORIG_CARD);
  ok('下書きの差分は1行だけを変える（-/+ が1行ずつ）', (d.diff.match(/^-[^-]/gm) ?? []).length === 1 && (d.diff.match(/^\+[^+]/gm) ?? []).length === 1, d.diff);
  ok('差分の行は p-4 → p-5 で、md:p-6 は残る', /-.*p-4 md:p-6/.test(d.diff) && /\+.*p-5 md:p-6/.test(d.diff), d.diff);
  const r = eng.apply({ changes: [{ draftId: d.id, reviewedDiffHash: d.diffHash, selection: s }] });
  eq('適用の結果は committed', r.status, 'committed');
  eq('書き込んだ（written: true）', r.written, true);
  const after = p.read(CARD);
  const expected = ORIG_CARD.replace('p-4 md:p-6', 'p-5 md:p-6');
  eq('ファイルは token 1つだけが変わった内容とバイト一致', after, expected);
  eq('変わった文字は1文字（4 → 5）', [...ORIG_CARD].filter((ch, i) => ch !== after[i]).length, 1);
  eq('適用後の版は、書いた内容の版（読み直して確かめた）', r.afterRev, AN.sourceRevision(after));
  eq('ジャーナルは committed', eng.journal(r.txId)?.state, 'committed');
  const o = eng.outcome(r.txId);
  ok('検証の前は成功扱いにしない（committed だが未検証）', o.write === 'committed' && o.verification === 'pending' && o.success === false, o);
  eq('src/ に一時ファイルを残さない（F-06）', p.leftovers().length, 0);
  ok('ジャーナルは題材の外に置く（.ide-runtime と同じ扱い）', path.relative(p.root, p.journalDir).startsWith('..'), p.journalDir);
  const inside = (() => { try { return new EditEngine({ projectRoot: p.root, journalDir: path.join(p.root, '.journal') }); } catch (e) { return e; } })();
  ok('ジャーナルを題材の中に置く設定は受け付けない', inside instanceof Error, String(inside));
  const jtext = fs.readdirSync(p.journalDir).filter((n) => n.endsWith('.json')).map((n) => fs.readFileSync(path.join(p.journalDir, n), 'utf8')).join('\n');
  ok('ジャーナルにソースの本文を写さない（ハッシュと範囲と token だけ）', !jtext.includes('PropertyCard({ property }') && !jtext.includes('rounded-lg border'), jtext.slice(0, 200));
  /* 同じ下書きを2回は適用しない */
  const again = eng.apply({ changes: [{ draftId: d.id, reviewedDiffHash: d.diffHash, selection: s }] });
  ok('適用済みの下書きは2回目を拒否する（書き込まない）', again.status !== 'committed' && again.written === false, again);
  /* 確認した差分と違うハッシュでは適用しない */
  const { p: p2, eng: eng2 } = fresh();
  const f2 = flow(p2, eng2, CARD, 'p-4 md:p-6', 'p-4', 'p-5');
  const bad = eng2.apply({ changes: [{ draftId: f2.d.id, reviewedDiffHash: '0'.repeat(64), selection: f2.s }] });
  ok('確認した差分のハッシュが違えば適用しない（diff-not-reviewed）', bad.written === false && bad.reason === 'diff-not-reviewed', bad);
  eq('（同）ファイルは元のまま', p2.read(CARD), ORIG_CARD);
  /* 扱えない class の指定は下書きを作らない */
  const cond = fresh({ 'src/components/Cond.tsx': 'export function Cond({ on }: { on: boolean }) {\n  return <div className={on ? "p-4" : "p-2"}>x</div>;\n}\n' });
  const ca = cond.p.anchorAt('src/components/Cond.tsx', '<div');
  const ct = cond.eng.resolveTarget(selectionOf(ca));
  const cd = ct.ok ? cond.eng.createDraft(ct.target.id, selectionOf(ca), change('p-4', 'p-5')) : ct;
  ok('条件付きの className は推測で書き換えない（unsupported-class）', cd.ok === false && cd.reason === 'unsupported-class', cd);
  const dup = fresh({ 'src/components/Dup.tsx': 'export function Dup() {\n  return <div className="p-4 md:p-4 p-4">x</div>;\n}\n' });
  const da = dup.p.anchorAt('src/components/Dup.tsx', '<div');
  const dd = dup.eng.createDraft(dup.eng.resolveTarget(selectionOf(da)).target.id, selectionOf(da), change('p-4', 'p-5'));
  ok('同じ token が2つ以上なら一意に決めない（token-ambiguous）', dd.ok === false && dd.reason === 'token-ambiguous', dd);
  const tdv = fresh();
  const tda = tdv.p.anchorAt(CARD, 'p-4 md:p-6');
  const tdt = tdv.eng.resolveTarget(selectionOf(tda)).target;
  for (const [ch, why] of [[change('p-4', 'md:p-5'), 'variant を変える'], [change('p-4', 'p-[13px]'), '任意値'], [change('p-4', 'p-4'), '同じ値'],
    [change('p-4', 'p-5"'), '引用符'], [change('p-9', 'p-5'), '無い token'], [change('p-4', 'shadow-sm'), '既にある token'],
    [{ kind: 'class-token', from: 'p-4', to: 'p-5', file: 'src/x.tsx' }, '知らないキー'], [{ kind: 'jsx', from: 'p-4', to: 'p-5' }, '種類が違う']]) {
    const r2 = tdv.eng.createDraft(tdt.id, selectionOf(tda), ch);
    ok(`変更の検証: ${why} は下書きを作らない（${r2.reason}）`, r2.ok === false, r2);
  }
  eq('（同）ファイルは元のまま', tdv.p.read(CARD), ORIG_CARD);
  for (const x of [p, p2, cond.p, dup.p, tdv.p]) x.cleanup();
});

/* ============================================================ T2 */
console.log('\nT2 古い版（対象のソースが変わった）');
guard('T2', () => {
  const { p, eng } = fresh();
  const a = p.anchorAt(CARD, 'p-4 md:p-6');
  const s = selectionOf(a);
  const t = eng.resolveTarget(s).target;
  /* 対象と同じ要素は同じ位置のまま、別の行だけを変える（版だけが変わる） */
  p.write(CARD, ORIG_CARD.replace('竣工 {property.done}', '竣工年 {property.done}'));
  /* DOM は古いまま（HMR の前） */
  const d1 = eng.createDraft(t.id, s, change('p-4', 'p-5'));
  ok('下書きの作成（第2段）: 古い DOM の版では拒否し、再選択を求める', d1.ok === false && d1.stage === 'draft' && d1.reselect === true, d1);
  note(`理由: ${d1.reason}${d1.anchorReason ? `（照合: ${d1.anchorReason}）` : ''}`);
  /* HMR の後（DOM も対応表も新しい版）でも、選択した時点の版と違えば拒否する（E1 は版の引き継ぎをしない — 07d 3.3 は E2） */
  const t2 = p.compile(CARD);
  const s2 = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6', t2), t2.rev);
  const d2 = eng.createDraft(t.id, s2, change('p-4', 'p-5'));
  ok('下書きの作成: いまの DOM でも、選択した時点の版と違えば拒否（source-changed）', d2.ok === false && d2.reason === 'source-changed' && d2.reselect === true, d2);
  /* 適用の直前（第3段）: 下書きの後にソースが変わった */
  const { p: q, eng: e2 } = fresh();
  const f = flow(q, e2, CARD, 'p-4 md:p-6', 'p-4', 'p-5');
  const edited = ORIG_CARD.replace('竣工 {property.done}', '竣工年 {property.done}');
  q.write(CARD, edited);
  const r = e2.apply({ changes: [{ draftId: f.d.id, reviewedDiffHash: f.d.diffHash, selection: f.s }] });
  ok('適用の直前（第3段）: 古い版の下書きは適用しない', r.written === false && r.status !== 'committed', r);
  eq('（同）外部の変更は残る（上書きしない）', q.read(CARD), edited);
  const tq = q.compile(CARD);
  const r2 = e2.apply({ changes: [{ draftId: f.d.id, reviewedDiffHash: f.d.diffHash, selection: selectionOf(q.anchorAt(CARD, 'p-4 md:p-6', tq), tq.rev) }] });
  ok('適用の直前: いまの DOM の選択を付けても、古い版の下書きは適用しない', r2.written === false && ['source-changed', 'external-change'].includes(r2.reason), r2);
  eq('（同）外部の変更は残る', q.read(CARD), edited);
  /* 対応表だけが古い（再コンパイル待ち） */
  const { p: m, eng: e3 } = fresh();
  const am = m.anchorAt(CARD, 'p-4 md:p-6');
  m.write(CARD, ORIG_CARD.replace('竣工 {property.done}', '竣工年 {property.done}'));
  const sm = selectionOf(am, AN.sourceRevision(m.read(CARD)));   // DOM は新しい版、対応表は古い版
  const rm = e3.resolveTarget(sm);
  ok('解決（第1段）: 対応表の版が古ければ特定しない（manifest-stale）', rm.ok === false && rm.anchorReason === 'manifest-stale', rm);
  for (const x of [p, q, m]) x.cleanup();
});

/* ============================================================ T3 */
console.log('\nT3 別の要素への誤編集（RV07・RV08 — 同じ行・列・タグ・コンポーネントに別の要素）');
guard('T3', () => {
  /* RV08 と同じ題材。1つ目の <div> を選んだ後、外部の編集で1つ目が消え、2つ目が同じ (行:列) に来る */
  const { p, eng } = fresh({ [TWO]: TWO_SRC });
  const first = p.anchorAt(TWO, 'first');
  const s1 = selectionOf(first);
  const t1 = eng.resolveTarget(s1).target;
  const dEarly = eng.createDraft(t1.id, s1, change('p-4', 'p-5')).draft;
  const edited = TWO_SRC.split('\n').filter((l) => !l.includes('first')).join('\n');
  p.write(TWO, edited);
  const tc = p.compile(TWO);   // HMR の再コンパイル
  const second = p.anchorAt(TWO, 'second', tc);
  ok('前提: 2つ目の要素が、1つ目と同じ識別子（同じ 行:列・タグ・コンポーネント）になった', second.id === first.id && second.line === first.line && second.col === first.col, { first, second });
  const sNew = selectionOf(second, tc.rev);   // HMR の後の DOM（同じ識別子・新しい版）
  const sOld = s1;                            // HMR の前の DOM
  const rOld = eng.resolveTarget(sOld);
  ok('RV07: 古い DOM の選択は特定しない（照合: source-changed）', rOld.ok === false && rOld.anchorReason === 'source-changed', rOld);
  const re = eng.reresolveTarget(t1.id, sNew);
  ok('RV07: 選んだ対象を新しい DOM で再解決すると、別の要素なので拒否する（element-mismatch）', re.ok === false && re.reason === 'element-mismatch' && re.reselect === true, re);
  const d = eng.createDraft(t1.id, sNew, change('p-4', 'p-5'));
  ok('RV08（下書き・第2段）: 選んだ要素の下書きを、同じ位置の別の要素に作らない', d.ok === false && d.reason === 'element-mismatch', d);
  const ap = eng.apply({ changes: [{ draftId: dEarly.id, reviewedDiffHash: dEarly.diffHash, selection: sNew }] });
  ok('RV08（適用・第3段）: 変更前に作った下書きを、同じ位置の別の要素へ適用しない', ap.written === false && ap.status !== 'committed', ap);
  eq('（同）2つ目の要素の p-4 は書き換えられていない（ファイルは外部の編集のまま）', p.read(TWO), edited);
  const ap2 = eng.apply({ changes: [{ draftId: dEarly.id, reviewedDiffHash: dEarly.diffHash, selection: sOld }] });
  ok('（同）古い DOM の選択を付けても適用しない', ap2.written === false, ap2);
  eq('（同）ファイルは外部の編集のまま', p.read(TWO), edited);
  /* 正しく対応付ける: いまの DOM で2つ目を選び直せば、2つ目を書き換える（1つ目の指紋とは別の対象になる） */
  const t2 = eng.resolveTarget(sNew);
  ok('いまの DOM で選び直すと、2つ目の要素を対象にする（指紋は1つ目と違う）', t2.ok && t2.target.fingerprint !== t1.fingerprint, t2);
  const d2 = eng.createDraft(t2.target.id, sNew, change('p-4', 'p-5')).draft;
  const r2 = eng.apply({ changes: [{ draftId: d2.id, reviewedDiffHash: d2.diffHash, selection: sNew }] });
  eq('（同）適用は committed', r2.status, 'committed');
  eq('（同）書き換わったのは2つ目（second）の p-4 だけ', p.read(TWO), edited.replace('border p-4 shadow', 'border p-5 shadow'));

  /* 並びの入れ替え（同じ行数・同じ大きさ）。RV07 の別形: 兄弟の <dd> を入れ替える */
  const { p: q, eng: e2 } = fresh();
  const pref = q.anchorAt(CARD, '{property.pref}');
  const sp = selectionOf(pref);
  const tp = e2.resolveTarget(sp).target;
  const swapped = ORIG_CARD.replace('<dd>{property.pref}</dd>\n          <dd>{property.utility}</dd>', '<dd>{property.utility}</dd>\n          <dd>{property.pref}</dd>');
  ok('前提: 入れ替えた内容は同じ大きさ', swapped !== ORIG_CARD && swapped.length === ORIG_CARD.length);
  q.write(CARD, swapped);
  const tq = q.compile(CARD);
  const util = q.anchorAt(CARD, '{property.utility}', tq);
  ok('前提: 入れ替え後、utility の <dd> が pref の <dd> と同じ識別子', util.id === pref.id, { pref, util });
  const rq = e2.reresolveTarget(tp.id, selectionOf(util, tq.rev));
  ok('兄弟の入れ替えの後、同じ識別子の別の <dd> を、選んだ要素として扱わない（element-mismatch）', rq.ok === false && rq.reason === 'element-mismatch', rq);
  /* 同じ要素が行だけ動いた: 識別子が変わるので、古い対象は再選択を求める（推測で付け替えない） */
  const { p: m, eng: e3 } = fresh();
  const outer = m.anchorAt(CARD, 'p-4 md:p-6');
  const to = e3.resolveTarget(selectionOf(outer)).target;
  const moved = ORIG_CARD.replace('  return (\n', '  // 追記\n  return (\n');
  m.write(CARD, moved);
  const tm = m.compile(CARD);
  const outer2 = m.anchorAt(CARD, 'p-4 md:p-6', tm);
  const rm = e3.reresolveTarget(to.id, selectionOf(outer2, tm.rev));
  ok('同じ要素が別の行へ動いた後の古い対象は、付け替えずに再選択を求める（target-moved）', rm.ok === false && rm.reason === 'target-moved' && rm.reselect === true, rm);
  for (const x of [p, q, m]) x.cleanup();
});

/* ============================================================ T5 */
console.log('\nT5 外部変更（編集の途中でファイルが変わった）');
guard('T5', () => {
  /* (a) 下書きの後・適用の前 */
  {
    const { p, eng } = fresh();
    const f = flow(p, eng, CARD, 'p-4 md:p-6', 'p-4', 'p-5');
    const ext = `${ORIG_CARD}// 外部のエディタが保存した\n`;
    p.write(CARD, ext);
    const r = eng.apply({ changes: [{ draftId: f.d.id, reviewedDiffHash: f.d.diffHash, selection: f.s }] });
    ok('(a) 下書きの後の外部変更: 適用しない（written: false）', r.written === false && r.status !== 'committed', r);
    eq('(a) 外部変更はそのまま残る', p.read(CARD), ext);
    eq('(a) 一時ファイルを残さない', p.leftovers().length, 0);
    p.cleanup();
  }
  /* (b)〜(e) 書き込みの途中（エンジンの段ごとに外部の書き込みを差し込む） */
  const midway = (step, mutate) => {
    const p = makeProject({ [CARD]: ORIG_CARD }, { name: 'eng5' });
    p.compile(CARD);
    let fired = false;
    const eng = new EditEngine({
      projectRoot: p.root, journalDir: p.journalDir,
      hooks: { step: (name) => { if (name === step && !fired) { fired = true; mutate(p); } } },
    });
    const f = flow(p, eng, CARD, 'p-4 md:p-6', 'p-4', 'p-5');
    const r = eng.apply({ changes: [{ draftId: f.d.id, reviewedDiffHash: f.d.diffHash, selection: f.s }] });
    return { p, eng, r, fired };
  };
  const EXT = `${ORIG_CARD}// 外部の変更（書き込みの途中）\n`;
  for (const step of ['applying', 'temp-written', 'before-final-check', 'before-last-stat']) {
    const { p, eng, r, fired } = midway(step, (x) => x.write(CARD, EXT));
    ok(`書き込みの途中（${step}）の外部変更: 適用しない（conflict・written: false）`, fired && r.written === false && r.status === 'conflict' && r.reason === 'external-change', r);
    eq(`（${step}）外部変更はそのまま残る`, p.read(CARD), EXT);
    eq(`（${step}）一時ファイルを残さない`, p.leftovers().length, 0);
    eq(`（${step}）ジャーナルは failed（committed と報告しない）`, eng.journal(r.txId)?.state ?? 'none', r.txId ? 'failed' : 'none');
    p.cleanup();
  }
  /* (f) 書き込んだ直後（読み直しの前）の外部変更: 成功扱いにしない */
  {
    const { p, eng, r } = midway('renamed', (x) => x.write(CARD, EXT));
    /* E1.1: 書いたが確かめられない結果は failed から uncertain に分けた（docs/08b 第3.5節） */
    ok('(f) 書き込みの直後に外部変更が入ったら、成功扱いにしない（uncertain・書き込みの状態は yes）', r.status === 'uncertain' && r.written === true && r.fileState === 'other', r);
    eq('(f) 外部変更は残る（書き戻さない）', p.read(CARD), EXT);
    ok('(f) ジャーナルは failed・要確認', eng.journal(r.txId)?.state === 'failed' && eng.journal(r.txId)?.needsAttention === true, eng.journal(r.txId));
    const rv = eng.revert(r.txId);
    ok('(f) 成否が確定しない書き込みは、取り消しの対象にしない（F-11）', rv.written === false && rv.reason === 'tx-not-committed', rv);
    p.cleanup();
  }
  /* RV03: 最後の照合から rename までの窓。E1.1 で退避リンク（rename の後に、置き換えた元の実体を確かめる）により、
   * 同じ実体への上書きは検出して外部の版へ戻すようになった。rename による置き換えの残る窓は edit-safety-unit S4(d) */
  {
    const { p, r } = midway('before-rename', (x) => x.write(CARD, EXT));
    ok('RV03: 最後の照合〜rename の窓の上書きを、committed と報告しない', r.status !== 'committed' && r.written === false, r);
    eq('RV03:（同）外部の変更は失われない', p.read(CARD), EXT);
    eq('RV03:（同）一時ファイル・退避リンクを残さない', p.leftovers().length, 0);
    p.cleanup();
  }
});

/* ============================================================ T6 */
console.log('\nT6 複数ファイル・複数の変更（E1 は1ファイル・1トークンだけ）');
guard('T6', () => {
  const A = 'src/components/A.tsx';
  const B = 'src/components/B.tsx';
  const files = {
    [A]: 'export function A() {\n  return <div className="p-4">a</div>;\n}\n',
    [B]: 'export function B() {\n  return <div className="p-4 m-2">b</div>;\n}\n',
  };
  const { p, eng } = fresh(files);
  const fa = flow(p, eng, A, '<div', 'p-4', 'p-5');
  const fb = flow(p, eng, B, '<div', 'p-4', 'p-5');
  const before = Object.fromEntries(Object.keys(files).map((k) => [k, p.read(k)]));
  const r = eng.apply({ changes: [fa, fb].map((f) => ({ draftId: f.d.id, reviewedDiffHash: f.d.diffHash, selection: f.s })) });
  ok('2ファイルの変更は拒否する（multi-file-unsupported）', r.written === false && r.reason === 'multi-file-unsupported', r);
  ok('（同）どのファイルも書き込まない', Object.keys(files).every((k) => p.read(k) === before[k]));
  const fb2 = flow(p, eng, B, '<div', 'm-2', 'm-3');
  const fb3 = { d: eng.createDraft(fb2.t.id, fb2.s, change('p-4', 'p-6')).draft, s: fb2.s };
  const r2 = eng.apply({ changes: [fb2, fb3].map((f) => ({ draftId: f.d.id, reviewedDiffHash: f.d.diffHash, selection: f.s })) });
  ok('同じファイルの2つの変更も拒否する（multi-change-unsupported）', r2.written === false && r2.reason === 'multi-change-unsupported', r2);
  ok('（同）どのファイルも書き込まない', Object.keys(files).every((k) => p.read(k) === before[k]));
  const r3 = eng.apply({ changes: [] });
  ok('変更が0件の要求は拒否する', r3.written === false, r3);
  ok('拒否した要求はジャーナルを作らない', !fs.existsSync(p.journalDir) || fs.readdirSync(p.journalDir).filter((n) => /^tx-.*\.json$/.test(n)).length === 0);
  const r4 = eng.apply({ changes: [{ draftId: fa.d.id, reviewedDiffHash: fa.d.diffHash, selection: fa.s }], files: [A, B] });
  ok('知らないキーを持つ要求は拒否する（形の検査）', r4.written === false && r4.reason === 'bad-request', r4);
  p.cleanup();
});

/* ============================================================ T11 */
console.log('\nT11 外部変更の後の取り消し');
guard('T11', () => {
  const { p, eng } = fresh();
  const f = flow(p, eng, CARD, 'p-4 md:p-6', 'p-4', 'p-5');
  const r = eng.apply({ changes: [{ draftId: f.d.id, reviewedDiffHash: f.d.diffHash, selection: f.s }] });
  const applied = p.read(CARD);
  const ext = applied.replace('竣工 {property.done}', '竣工年 {property.done}');
  p.write(CARD, ext);
  const rv = eng.revert(r.txId);
  ok('適用の後に外部変更が入ったら、取り消さない（changed-after-apply・written: false）', rv.written === false && rv.reason === 'changed-after-apply', rv);
  eq('（同）外部変更は残る（適用前の内容で上書きしない）', p.read(CARD), ext);
  eq('（同）元の適用のジャーナルは committed のまま', eng.journal(r.txId).state, 'committed');
  /* 外部変更を元に戻せば（適用直後の内容と一致すれば）取り消せる */
  p.write(CARD, applied);
  const rv2 = eng.revert(r.txId);
  eq('適用直後の内容のままなら、取り消しは committed', rv2.status, 'committed');
  eq('（同）取り消し後の内容は適用前とバイト一致', p.read(CARD), ORIG_CARD);
  eq('（同）取り消しも別のジャーナル（kind: revert）として記録する', eng.journal(rv2.txId)?.kind, 'revert');
  const rv3 = eng.revert(r.txId);
  ok('2回目の取り消しは拒否する（already-reverted）', rv3.written === false && rv3.reason === 'already-reverted', rv3);
  eq('（同）ファイルは適用前のまま', p.read(CARD), ORIG_CARD);
  const rv4 = eng.revert('tx-20990101000000-deadbeef');
  ok('知らない適用の取り消しは拒否する', rv4.written === false && rv4.reason === 'tx-unknown', rv4);
  const rv5 = eng.revert('../../etc/passwd');
  ok('形の合わない識別子は拒否する（ジャーナルの外を読まない）', rv5.written === false && rv5.reason === 'bad-request', rv5);
  eq('sha256 は内容のハッシュ（自己確認）', sha256(p.read(CARD)), sha256(ORIG_CARD));
  p.cleanup();
});

C.finish();
