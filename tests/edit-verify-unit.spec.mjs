/* =============================================================================
 * 編集 E1 — 適用結果の検証の契約（T9・T10・F-05。06h レビューの RS02・RS04 に相当）。
 *   npm run build:lib && node tests/edit-verify-unit.spec.mjs
 *
 * E1 は利用者向けのプレビューを作らない。プレビュー（E2 以降）が送る「検証の報告」を**サーバーが自分で**確かめる。
 * 成功（success）は「書き込みが committed」かつ「検証が verified」のときだけ。確かめるもの:
 *   必須の幅（1440・375）がすべて揃う／実測（measured）であり予測（predicted）でない／予測の印が無い描画
 *   検証した文書の版・要素の版 = 適用後の版／検証の時点のいまのファイルの版 = 適用後の版（RS04）
 *   検証時刻: 確定より後・未来でない・古すぎない／適用対象（txId・要素の識別子・ファイル）との対応
 *   描画に変更後の token があり、変更前の token が無い／（与えたときだけ）期待する計算済みスタイル
 * ========================================================================== */
import { counter, makeProject, selectionOf, loadEdit, readFixture, CARD, AN, VIEWPORTS } from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, guard } = C;
let E;
try { E = loadEdit('engine'); } catch (e) { ok('製品の編集エンジンを読み込める', false, String(e.message)); C.finish(); }
const { EditEngine } = E;
process.env.VCIDE_EDIT_E1_WRITE = '1';

const ORIG = readFixture(CARD);
const change = { kind: 'class-token', from: 'p-4', to: 'p-5' };
const DOC = 'a'.repeat(32);
let now = Date.now();
const clock = () => now;

/** 適用まで済ませた状態を作る（expect: 期待する計算済みスタイル。サーバー側のコードが渡すもの） */
function applied({ expect } = {}) {
  const p = makeProject({ [CARD]: ORIG, 'src/components/Other.tsx': 'export function Other() {\n  return <p className="m-1">x</p>;\n}\n' }, { name: 'ver' });
  p.compile(CARD);
  p.compile('src/components/Other.tsx');
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir, clock });
  const a = p.anchorAt(CARD, 'p-4 md:p-6');
  const s = selectionOf(a);
  const d = eng.createDraft(eng.resolveTarget(s).target.id, s, change).draft;
  const r = eng.apply({ changes: [{ draftId: d.id, reviewedDiffHash: d.diffHash, selection: s }], ...(expect ? { expect } : {}) });
  if (r.status !== 'committed') throw new Error(`apply: ${JSON.stringify(r)}`);
  now += 1000;   // 計測は確定の後
  return { p, eng, r, a };
}
/** プレビューが送る報告（正しい形）。parts で一部を差し替える */
function report({ r, a }, parts = {}) {
  const at = new Date(now - 200).toISOString();
  const board = (vp, extra = {}) => ({
    viewport: { width: vp.width, height: vp.width === 1440 ? 900 : 812 },
    mode: 'measured',
    predictionMarkers: 0,
    measuredAt: at,
    document: { token: DOC, path: '/properties', sourceRevs: { [r.file]: r.afterRev } },
    elements: [{ anchorId: a.id, rev: r.afterRev, classTokens: ['rounded-lg', 'border', 'bg-white', 'p-5', 'md:p-6', 'shadow-sm'],
      computed: { 'padding-top': vp.width === 1440 ? '24px' : '20px' } }],
    ...extra,
  });
  return {
    txId: r.txId, anchorId: a.id, file: r.file, sourceRev: r.afterRev, measuredAt: at,
    artboards: VIEWPORTS.map((vp) => board(vp, parts[vp.name] ?? {})),
    ...(parts.top ?? {}),
  };
}

/* ============================================================ 正しい報告 */
console.log('\n正しい報告（2幅・実測・適用後の版）');
guard('ok', () => {
  const x = applied();
  const v = x.eng.submitVerification(report(x));
  eq('2幅の実測で、版・時刻・対応がすべて合えば verified', v.status, 'verified');
  ok('問題は0件', v.problems.length === 0, v.problems);
  const o = x.eng.outcome(x.r.txId);
  ok('成功（success）は committed かつ verified のとき', o.write === 'committed' && o.verification === 'verified' && o.success === true, o);
  ok('検証した版（いまのファイルの版）を記録する', v.verifiedRevisions?.[x.r.file] === x.r.afterRev, v);
  x.p.cleanup();
});

/* ============================================================ T9 */
console.log('\nT9 検証不足（必須の幅が欠ける・版・時刻・対応が合わない）');
guard('T9', () => {
  const cases = [
    ['RS02: Mobile だけ（Desktop が欠ける）', (x) => { const r = report(x); r.artboards = r.artboards.filter((b) => b.viewport.width === 375); return r; }, 'viewport-missing'],
    ['Desktop だけ（Mobile が欠ける）', (x) => { const r = report(x); r.artboards = r.artboards.filter((b) => b.viewport.width === 1440); return r; }, 'viewport-missing'],
    ['幅が0件', (x) => ({ ...report(x), artboards: [] }), 'viewport-missing'],
    ['同じ幅が2回（どちらを信じるか決めない）', (x) => { const r = report(x); r.artboards.push(r.artboards[0]); return r; }, 'duplicate-viewport'],
    ['必須でない幅に置き換えた（1024）', (x) => { const r = report(x); r.artboards[0].viewport.width = 1024; return r; }, 'viewport-missing'],
    ['要素を測っていない', (x) => report(x, { mobile: { elements: [] } }), 'no-elements'],
    ['文書の版が適用前（HMR の前の描画）', (x) => report(x, { desktop: { document: { token: DOC, path: '/properties', sourceRevs: { [x.r.file]: x.r.beforeRev } } } }), 'document-revision-mismatch'],
    ['文書が対象のファイルの版を持たない', (x) => report(x, { desktop: { document: { token: DOC, path: '/properties', sourceRevs: {} } } }), 'document-revision-mismatch'],
    ['要素の版が適用前', (x) => { const r = report(x); r.artboards[1].elements[0].rev = x.r.beforeRev; return r; }, 'element-revision-mismatch'],
    ['報告の版が適用後の版と違う', (x) => report(x, { top: { sourceRev: x.r.beforeRev } }), 'revision-mismatch'],
    ['別の要素を測った', (x) => { const r = report(x); r.artboards[0].elements[0].anchorId = '0123456789'; return r; }, 'anchor-mismatch'],
    ['別のファイルの報告', (x) => report(x, { top: { file: 'src/components/Other.tsx' } }), 'file-mismatch'],
    ['描画に変更後の token が無い（変更前の描画）', (x) => { const r = report(x); r.artboards[0].elements[0].classTokens = ['p-4', 'md:p-6']; return r; }, 'token-not-rendered'],
    ['確定より前に測った', (x) => { const r = report(x); const t = new Date(Date.parse(x.eng.journal(x.r.txId).committedAt) - 60000).toISOString(); r.measuredAt = t; r.artboards.forEach((b) => { b.measuredAt = t; }); return r; }, 'measured-before-commit'],
    ['未来の時刻', (x) => { const r = report(x); const t = new Date(now + 3600000).toISOString(); r.measuredAt = t; r.artboards.forEach((b) => { b.measuredAt = t; }); return r; }, 'measured-in-future'],
    ['文書の識別子が無い', (x) => report(x, { mobile: { document: { token: null, path: '/properties', sourceRevs: { [x.r.file]: x.r.afterRev } } } }), 'bad-report'],
    ['知らないキー（形の検査）', (x) => report(x, { top: { passed: true } }), 'bad-report'],
  ];
  for (const [name, make, code] of cases) {
    const x = applied();
    const v = x.eng.submitVerification(make(x));
    ok(`${name} → 成功扱いにしない（${code}）`, v.status === 'not-verified' && v.problems.some((q) => q.code === code), v);
    const o = x.eng.outcome(x.r.txId);
    ok(`（同）適用の結果は success ではない`, o.success === false && o.verification !== 'verified', o);
    x.p.cleanup();
  }
  /* 古すぎる計測（受け取った時点で10分以上前） */
  {
    const x = applied();
    const rep = report(x);
    now += 11 * 60 * 1000;
    const v = x.eng.submitVerification(rep);
    ok('検証の報告が古すぎる（10分超）→ 成功扱いにしない（measurement-too-old）', v.status === 'not-verified' && v.problems.some((q) => q.code === 'measurement-too-old'), v);
    now = Date.now();
    x.p.cleanup();
  }
  /* RS04: 適用の後・検証の前にファイルが変わった（いまの版 ≠ 適用直後の版） */
  {
    const x = applied();
    x.p.write(CARD, `${x.p.read(CARD)}// 適用の後の変更\n`);
    const v = x.eng.submitVerification(report(x));
    ok('RS04: 検証の時点でファイルが適用後の版でない → 適用後の版で検証済みと記録しない（stale-source）', v.status === 'not-verified' && v.problems.some((q) => q.code === 'stale-source'), v);
    x.p.cleanup();
  }
  /* RS04 の別形: 文書が持つ他のファイルの版が、いまの版と違う（無関係なファイルの変更の後） */
  {
    const x = applied();
    const rep = report(x);
    const otherRev = AN.sourceRevision(x.p.read('src/components/Other.tsx'));
    rep.artboards.forEach((b) => { b.document.sourceRevs['src/components/Other.tsx'] = otherRev; });
    x.p.write('src/components/Other.tsx', `${x.p.read('src/components/Other.tsx')}// 無関係なファイルの変更\n`);
    const v = x.eng.submitVerification(rep);
    ok('RS04: 文書が描いた他のファイルの版が、いまの版と違う → verified にしない（stale-source）', v.status === 'not-verified' && v.problems.some((q) => q.code === 'stale-source'), v);
    x.p.cleanup();
  }
  /* 期待する計算済みスタイル（サーバー側で決めたもの）と違う */
  {
    const x = applied({ expect: { desktop: { 'padding-top': '24px' }, mobile: { 'padding-top': '20px' } } });
    const rep = report(x);
    rep.artboards[1].elements[0].computed['padding-top'] = '16px';
    const v = x.eng.submitVerification(rep);
    ok('期待する計算済みスタイルと違えば成功扱いにしない（expectation-mismatch）', v.status === 'not-verified' && v.problems.some((q) => q.code === 'expectation-mismatch'), v);
    const ok2 = x.eng.submitVerification(report(x));
    eq('（同）期待どおりなら verified', ok2.status, 'verified');
    x.p.cleanup();
  }
  /* 確定していない適用・知らない適用 */
  {
    const x = applied();
    const v = x.eng.submitVerification({ ...report(x), txId: 'tx-20990101000000-deadbeef' });
    ok('知らない適用の報告は受け取らない（tx-unknown）', v.status === 'not-verified' && v.problems.some((q) => q.code === 'tx-unknown'), v);
    const rv = x.eng.revert(x.r.txId);
    const v2 = x.eng.submitVerification(report(x));
    ok('取り消した後の古い適用の報告は verified にしない（いまのファイルは適用前の版）', rv.status === 'committed' && v2.status === 'not-verified', v2);
    x.p.cleanup();
  }
  /* 検証済みの後にファイルが変わったら、結果に「古い」と出す */
  {
    const x = applied();
    x.eng.submitVerification(report(x));
    x.p.write(CARD, `${x.p.read(CARD)}// 後の変更\n`);
    const o = x.eng.outcome(x.r.txId);
    ok('検証済みの後にファイルが変わったら、結果は古いと出す（staleSinceVerification）', o.verification === 'verified' && o.staleSinceVerification === true, o);
    x.p.cleanup();
  }
});

/* ============================================================ T10 */
console.log('\nT10 予測（predicted）を実測として受け入れない');
guard('T10', () => {
  const cases = [
    ['Mobile が予測', (x) => report(x, { mobile: { mode: 'predicted' } })],
    ['両方とも予測', (x) => report(x, { mobile: { mode: 'predicted' }, desktop: { mode: 'predicted' } })],
    ['実測と名乗るが、予測の印（data-vcide-predict）が描画に残っている', (x) => report(x, { desktop: { predictionMarkers: 1 } })],
    ['実測か予測かを言わない', (x) => { const r = report(x); delete r.artboards[0].mode; return r; }],
    ['予測の印の数を言わない', (x) => { const r = report(x); delete r.artboards[1].predictionMarkers; return r; }],
  ];
  for (const [name, make] of cases) {
    const x = applied();
    const v = x.eng.submitVerification(make(x));
    ok(`${name} → verified にしない`, v.status === 'not-verified', v);
    ok('（同）理由は予測・形の不備のどちらか', v.problems.some((q) => ['predicted-not-accepted', 'bad-report'].includes(q.code)), v.problems);
    eq('（同）成功扱いにしない', x.eng.outcome(x.r.txId).success, false);
    x.p.cleanup();
  }
  /* 予測の報告の後に、正しい実測を送れば verified になる（予測は記録に残っても成功の根拠にしない） */
  const x = applied();
  x.eng.submitVerification(report(x, { mobile: { mode: 'predicted' } }));
  eq('予測の報告の後でも、正しい実測の報告なら verified', x.eng.submitVerification(report(x)).status, 'verified');
  x.p.cleanup();
});

C.finish();
