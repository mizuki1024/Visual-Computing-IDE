/* =============================================================================
 * F-01（06h 独立レビュー）— 位置だけの要素識別子で、コード変更前の選択・DOM・対応表を、変更後の別の要素へ
 * 対応付けないことを、部品の単位で確かめる。
 *   npm run build:lib && node tests/select-revision-unit.spec.mjs
 *
 *   1. 変換器・ローダ — 各要素にソースの版（data-vcide-rev）を付け、対応表にも同じ版を書く
 *   2. 照合（resolveSelection）— レビューの RV07 と同じ題材（poc/fixture-edit の PropertyCard。読むだけ）で、
 *      同じ (ファイル:行:列)・同じタグ・同じコンポーネントに別の要素が来ても、古い DOM の版では特定しない。
 *      いまの DOM の版なら、いまのソースの要素に特定する
 *   3. 版の確かめ（sourceRevisionsOf）と、画面が使う比較（liveResolutionRevisions / sameLiveResolution）
 * 実ブラウザ・実際の HMR での確認は tests/select-revision-e2e.spec.mjs が行う。
 * ========================================================================== */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const AN = require_('../.libjs/server/anchors.js');
const AD = require_('../.libjs/lib/adapter.js');
const P = require_('../.libjs/lib/previewProtocol.js');
const { transform, sourceRevision } = require_('../poc/anchor/transform.cjs');
const loader = require_('../poc/anchor/loader.cjs');
const REPO = path.resolve(import.meta.dirname, '..');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-f01-'));
const root = path.join(tmp, 'app');
fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
fs.writeFileSync(path.join(root, 'next.config.mjs'), "const A = process.env.POC03_ANCHOR === '1'; export default {};\n");
const support = AN.anchorSupport(root);
const outDir = AN.anchorOutDir(root);
fs.rmSync(outDir, { recursive: true, force: true });

/* ============================================ 1. 変換器・ローダ */
console.log('\n1. 変換器・ローダがソースの版を付ける');
const CARD = 'src/components/PropertyCard.tsx';
/* レビューの RV07 と同じ題材（読むだけ。題材は変更しない） */
const ORIG = fs.readFileSync(path.join(REPO, 'poc', 'fixture-edit', CARD), 'utf8');
{
  const t = transform(ORIG, CARD);
  eq('版はソースの内容の sha1 の先頭16桁（IDE 側の計算と同じ規則）', t.rev, AN.sourceRevision(ORIG));
  eq('変換器の sourceRevision と IDE の sourceRevision は同じ値', sourceRevision(ORIG), AN.sourceRevision(ORIG));
  ok('版は 16 進 16 桁', P.SOURCE_REV_RE.test(t.rev));
  const ids = (t.code.match(/data-vcide="[0-9a-f]{10}"/g) ?? []).length;
  const revs = (t.code.match(new RegExp(`data-vcide-rev="${t.rev}"`, 'g')) ?? []).length;
  ok('識別子を付けた要素すべてに、同じ版を並べて付ける', ids > 0 && ids === revs && ids === t.anchors.length, { ids, revs, anchors: t.anchors.length });
  eq('行数を変えない（挿入のみ）', t.code.split('\n').length, ORIG.split('\n').length);
  ok('同じ内容からは同じ版', transform(ORIG, CARD).rev === t.rev);
  ok('1文字でも内容が違えば版が違う', transform(`${ORIG} `, CARD).rev !== t.rev);
  ok('識別子は従来どおり位置だけから決まる（版を混ぜない）', t.anchors.every((a) => a.id === AN.anchorIdOf(a.file, a.line, a.col)));
  /* ローダ（webpack ローダ API）を直接呼び、対応表に版が書かれることを見る */
  const out = loader.call({ getOptions: () => ({ root, outDir, scope: 'src' }), resourcePath: path.join(root, CARD) }, ORIG);
  eq('ローダの出力は変換器の出力と同じ', out, t.code);
  const m = AN.readManifest(outDir);
  ok('対応表の記述に、変換したソースの版が付く', [...m.values()].every((a) => a.rev === t.rev) && m.size === t.anchors.length, [...m.values()].map((a) => a.rev));
  fs.rmSync(outDir, { recursive: true, force: true });
}

/* ============================================ 2. 照合 */
console.log('\n2. 同じ位置に別の要素が来ても、古い DOM・古い対応表で特定しない（RV07 と同じ題材）');
fs.mkdirSync(outDir, { recursive: true });
const MF = path.join(outDir, '0000000000000000.json');
const abs = path.join(root, CARD);
/** ソースを書き、ローダと同じ純粋変換で対応表を書き直す（HMR の再コンパイルと同じ状態） */
const compile = (code) => { const t = transform(code, CARD); fs.writeFileSync(MF, JSON.stringify({ file: CARD, rev: t.rev, anchors: t.anchors })); return t; };
const at = (t, needle) => {
  const lines = (t.src).split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  const col = lines[i].indexOf('<') + 1;
  return t.anchors.find((a) => a.line === i + 1 && a.col === col);
};
const sel = (a, rev, o = {}) => ({
  tag: a.tag, anchorOnSelf: a.id, anchorRev: rev, anchorOrdinal: 0, anchorInstanceCount: 1,
  ancestorAnchors: [], ancestorRevs: [], textNodeIndex: 0, valueShape: null, formControl: false, path: '/properties', ...o,
});
{
  fs.writeFileSync(abs, ORIG);
  const v1 = { ...compile(ORIG), src: ORIG };
  const pref = at(v1, '<dd>{property.pref}</dd>');
  ok('前提: <dd>{property.pref}</dd> が対応表にある', !!pref, pref);
  const r1 = AN.resolveSelection(root, support, sel(pref, v1.rev));
  eq('変更前: いまの DOM の版で選べば特定できる', r1.status, 'resolved');
  eq('変更前: その行', r1.anchor?.sourceLine, '<dd>{property.pref}</dd>');

  /* 外部の編集で <dd>{property.pref}</dd> の行が消え、同じ (行:列) に <dd>{property.utility}</dd> が来る */
  const lines = ORIG.split('\n');
  const edited = lines.filter((_, i) => i !== pref.line - 1).join('\n');
  fs.writeFileSync(abs, edited);
  const notYet = AN.resolveSelection(root, support, sel(pref, v1.rev));
  eq('変更後・再コンパイル前（対応表は古い）: 古い DOM の要素は source-changed', notYet.reason, 'source-changed');
  ok('変更後・再コンパイル前: 位置を返さない', notYet.status === 'unresolved' && !('anchor' in notYet));

  const v2 = { ...compile(edited), src: edited };
  const stale = AN.resolveSelection(root, support, sel(pref, v1.rev));
  ok('RV07 相当: 再コンパイル後（対応表は新しい）でも、古い DOM の識別子を同じ位置の新しい要素へ対応付けない', stale.status !== 'resolved', { status: stale.status, line: stale.anchor?.sourceLine });
  eq('RV07 相当: 理由は source-changed', stale.reason, 'source-changed');
  ok('RV07 相当: 理由に再選択を求める文言と、版の違い', /もう一度選択/.test(stale.detail) && stale.detail.includes(v1.rev) && stale.detail.includes(v2.rev), stale.detail);

  const util = at(v2, '<dd>{property.utility}</dd>');
  eq('前提: 新しいソースでは、同じ (行:列) に <dd>{property.utility}</dd>（同じ識別子）', util?.id, pref.id);
  const fresh = AN.resolveSelection(root, support, sel(util, v2.rev));
  eq('いまの DOM（新しい版）を選び直せば、いまのソースの要素に特定する', fresh.status, 'resolved');
  eq('いまのソースの行', fresh.anchor?.sourceLine, '<dd>{property.utility}</dd>');
  eq('照合した版を返す', fresh.anchor?.rev, v2.rev);

  /* DOM は新しいが、対応表がまだ古い（または別の版） */
  fs.writeFileSync(MF, JSON.stringify({ file: CARD, rev: v1.rev, anchors: v1.anchors }));
  eq('対応表だけが古い版なら manifest-stale（対応表の位置を使わない）', AN.resolveSelection(root, support, sel(util, v2.rev)).reason, 'manifest-stale');
  compile(edited);

  /* 版が無い */
  eq('DOM に版が無い要素（以前の変換結果）は revision-missing', AN.resolveSelection(root, support, sel(util, null)).reason, 'revision-missing');
  eq('版を持たない選択（レビューの RV07 の形: anchorRev のキー自体が無い）も revision-missing', AN.resolveSelection(root, support, (({ anchorRev, ...o }) => o)(sel(util, v2.rev))).reason, 'revision-missing');
  fs.writeFileSync(MF, JSON.stringify({ file: CARD, anchors: v2.anchors }));
  eq('対応表に版が無い（以前のローダ）なら revision-missing', AN.resolveSelection(root, support, sel(util, v2.rev)).reason, 'revision-missing');
  compile(edited);
}
{
  /* 同じタグ・同じコンポーネントの中で、兄弟の2要素を入れ替える */
  const A = ['export default function Pair() {', '  return (', '    <ul>', '      <li className="a">a</li>', '      <li className="b">b</li>', '    </ul>', '  );', '}', ''].join('\n');
  const B = A.replace('      <li className="a">a</li>\n      <li className="b">b</li>', '      <li className="b">b</li>\n      <li className="a">a</li>');
  const PAIR = 'src/components/Pair.tsx';
  const pabs = path.join(root, PAIR);
  const MF2 = path.join(outDir, '1111111111111111.json');
  const comp = (code) => { const t = transform(code, PAIR); fs.writeFileSync(pabs, code); fs.writeFileSync(MF2, JSON.stringify({ file: PAIR, rev: t.rev, anchors: t.anchors })); return t; };
  const ta = comp(A);
  const liA = ta.anchors.find((x) => x.line === 4);
  const ul = ta.anchors.find((x) => x.tag === 'ul');
  const s = (a, rev, ancRev) => sel(a, rev, { ancestorAnchors: [ul.id], ancestorRevs: [ancRev] });
  eq('前提: 入れ替え前の li.a', AN.resolveSelection(root, support, s(liA, ta.rev, ta.rev)).anchor?.sourceLine, '<li className="a">a</li>');
  const tb = comp(B);
  const st = AN.resolveSelection(root, support, s(liA, ta.rev, ta.rev));
  ok('入れ替え後、古い DOM の li.a を、同じ位置に来た li.b として特定しない', st.status !== 'resolved', { status: st.status, line: st.anchor?.sourceLine });
  eq('入れ替え後: 理由は source-changed', st.reason, 'source-changed');
  const now = AN.resolveSelection(root, support, s(tb.anchors.find((x) => x.line === 4), tb.rev, tb.rev));
  eq('入れ替え後、いまの DOM の 4 行目は li.b', now.anchor?.sourceLine, '<li className="b">b</li>');
  /* 祖先（文脈）も版で照合する。祖先だけ古い版なら、包含関係に入れない */
  const anc = AN.resolveSelection(root, support, s(tb.anchors.find((x) => x.line === 4), tb.rev, ta.rev));
  ok('祖先の版が古ければ、祖先を包含関係に入れない（要素自身は特定できる）', anc.status === 'resolved' && anc.ancestors.length === 0, anc.ancestors);

  /* 同じ大きさ・同じ更新時刻のまま内容が変わっても、前の内容の索引を使わない（版はキャッシュより先に内容で決める） */
  const C = B.replace('className="b">b<', 'className="c">c<');
  const T = 1_700_000_000;               // 秒の整数（時刻の丸めで比較が揺れないように）
  fs.utimesSync(pabs, T, T);
  AN.resolveSelection(root, support, s(tb.anchors.find((x) => x.line === 4), tb.rev, tb.rev));   // 前の内容で索引を作らせる
  const st0 = fs.statSync(pabs);
  const tc = transform(C, PAIR);
  fs.writeFileSync(pabs, C);
  fs.utimesSync(pabs, T, T);
  fs.writeFileSync(MF2, JSON.stringify({ file: PAIR, rev: tc.rev, anchors: tc.anchors }));
  ok('前提: 大きさも更新時刻も同じ', fs.statSync(pabs).size === st0.size && fs.statSync(pabs).mtimeMs === st0.mtimeMs);
  eq('同じ大きさ・同じ時刻の書き換えでも、照合はいまの内容で行う', AN.resolveSelection(root, support, s(tc.anchors.find((x) => x.line === 4), tc.rev, tc.rev)).anchor?.sourceLine, '<li className="c">c</li>');
  eq('その書き換えの前の版の DOM は source-changed', AN.resolveSelection(root, support, s(tb.anchors.find((x) => x.line === 4), tb.rev, tb.rev)).reason, 'source-changed');
}

/* ============================================ 3. 版の確かめと、画面が使う比較 */
console.log('\n3. 選択の後の版の確かめ（sourceRevisionsOf）と、画面が使う比較');
{
  const cur = fs.readFileSync(abs, 'utf8');
  const got = AN.sourceRevisionsOf(root, [CARD, 'src/../../etc/passwd.tsx', 'lib/x.tsx', 'src/components/Missing.tsx']);
  eq('注入範囲のファイルは、いまの内容の版', got[CARD], AN.sourceRevision(cur));
  eq('.. を含むパスは null（読まない）', got['src/../../etc/passwd.tsx'], null);
  eq('src/ の外は null', got['lib/x.tsx'], null);
  eq('無いファイルは null', got['src/components/Missing.tsx'], null);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-f01-out-'));
  fs.writeFileSync(path.join(outside, 'E.tsx'), 'export default function E() { return <b>x</b>; }\n');
  fs.symlinkSync(path.join(outside, 'E.tsx'), path.join(root, 'src', 'E.tsx'));
  eq('シンボリックリンクで外へ出るファイルは null', AN.sourceRevisionsOf(root, ['src/E.tsx'])['src/E.tsx'], null);
  fs.rmSync(outside, { recursive: true, force: true });
  eq('一度に確かめるのは上限まで', Object.keys(AN.sourceRevisionsOf(root, Array.from({ length: 50 }, (_, i) => `src/a${i}.tsx`))).length, AN.MAX_REVISION_FILES);

  const r = (file, rev, anc = []) => ({
    status: 'resolved', directive: 'none', checks: [], chain: [],
    anchor: { id: 'aaaaaaaaaa', tag: 'dd', file, line: 12, col: 11, component: 'C', componentLine: 1, sourceLine: 'x', rev },
    ancestors: anc.map(([f, v]) => ({ id: 'bbbbbbbbbb', tag: 'dl', file: f, line: 1, col: 1, component: 'C', componentLine: 1, sourceLine: 'y', rev: v })),
  });
  const R1 = '1'.repeat(16); const R2 = '2'.repeat(16); const R3 = '3'.repeat(16);
  eq('解決が依存するファイルと版（選んだ要素と祖先）', JSON.stringify(AD.liveResolutionRevisions(r('src/a.tsx', R1, [['src/p.tsx', R2]]))), JSON.stringify({ 'src/a.tsx': R1, 'src/p.tsx': R2 }));
  eq('版の無い解決は「照合した」と扱わない', AD.liveResolutionRevisions(r('src/a.tsx', undefined)), null);
  eq('同じファイルに別の版が混ざった解決は扱わない', AD.liveResolutionRevisions(r('src/a.tsx', R1, [['src/a.tsx', R2]])), null);
  ok('同じ位置・同じ版なら同じ解決', AD.sameLiveResolution(r('src/a.tsx', R1, [['src/p.tsx', R2]]), r('src/a.tsx', R1, [['src/p.tsx', R2]])));
  ok('同じ位置でも、選んだ要素のファイルの版が違えば別の解決（位置だけで同一としない）', !AD.sameLiveResolution(r('src/a.tsx', R1), r('src/a.tsx', R3)));
  ok('祖先のファイルの版が違っても別の解決', !AD.sameLiveResolution(r('src/a.tsx', R1, [['src/p.tsx', R2]]), r('src/a.tsx', R1, [['src/p.tsx', R3]])));
  ok('祖先が照合に通らなくなった解決も別の解決', !AD.sameLiveResolution(r('src/a.tsx', R1, [['src/p.tsx', R2]]), r('src/a.tsx', R1)));
  ok('特定できなかった解決とは同じにならない', !AD.sameLiveResolution(r('src/a.tsx', R1), { status: 'unresolved', reason: 'source-changed', detail: '', context: null }));
  eq('理由の見出し: source-changed は再選択を求める', /もう一度選択/.test(AD.LIVE_UNRESOLVED_LABEL['source-changed']), true);
  ok('理由の見出し: manifest-stale・revision-missing もある', !!AD.LIVE_UNRESOLVED_LABEL['manifest-stale'] && !!AD.LIVE_UNRESOLVED_LABEL['revision-missing']);
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(outDir, { recursive: true, force: true });

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
