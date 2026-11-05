/* =============================================================================
 * 編集 E1 — 端から端まで（使い捨ての題材・実際の next dev・実際の HMR・実ブラウザの2幅）。
 *   npm run build:lib && PW_CHANNEL=none node tests/edit-e2e.spec.mjs
 *
 * E1 には利用者向けの画面が無い。ここでは**エンジンだけ**を、実際の DOM・注入・HMR の上で回す:
 *   1. 題材（poc/fixture-edit）の使い捨てのコピー（poc/out/edit-e2e。Git 管理外）を、要素識別子の注入を有効にして next dev で起動
 *   2. Desktop 1440・Mobile 375 の2枚のページで /properties を開き、DOM（data-vcide・data-vcide-rev）から選択を作る
 *      （製品の previewGateway のスクリプトと同じ規則。製品の parseSelection を通す）
 *   3. 解決 → 下書き → 適用（p-4 → p-5）→ HMR を待つ → 2幅で実測 → 検証の報告をエンジンへ → verified
 *      予測だけ・1幅だけの報告は成功扱いにしない。古い DOM の選択は特定しない
 *   4. 取り消し → HMR → 2幅で実測 → verified
 *   5. 外部の編集で同じ位置に別の要素が来たとき（RV07 の実際の HMR 版）、古い対象を別の要素へ付け替えない
 *   6. 元の題材は1バイトも変わらない（F-10）
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { counter, loadEdit, AN, P, REPO, FIXTURE_EDIT, CARD, sha256, snapshot, sameSnapshot } from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note } = C;
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let E;
try { E = loadEdit('engine'); } catch (e) { ok('製品の編集エンジンを読み込める', false, String(e.message)); C.finish(); }
const { EditEngine } = E;
process.env.VCIDE_EDIT_E1_WRITE = '1';

if (!fs.existsSync(path.join(FIXTURE_EDIT, 'node_modules', 'next', 'dist', 'bin', 'next'))) {
  ok(`題材 ${FIXTURE_EDIT} の依存がインストールされている（cd poc/fixture-edit && npm ci）`, false);
  C.finish();
}

/* ------------------------------------------------------------ 使い捨ての題材 */
const WORK = path.join(REPO, 'poc', 'out', 'edit-e2e');
const PROJECT = path.join(WORK, 'poc', 'fixture-edit');
const fixtureBefore = snapshot(path.join(FIXTURE_EDIT, 'src'));
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'poc'), { recursive: true });
fs.cpSync(path.join(REPO, 'poc', 'anchor'), path.join(WORK, 'poc', 'anchor'), { recursive: true });
fs.cpSync(FIXTURE_EDIT, PROJECT, {
  recursive: true,
  filter: (src) => { const r = path.relative(FIXTURE_EDIT, src).split(path.sep); return r[0] !== 'node_modules' && r[0] !== '.next'; },
});
execFileSync('cp', ['-al', path.join(FIXTURE_EDIT, 'node_modules'), path.join(PROJECT, 'node_modules')]);
const ROOT = fs.realpathSync(PROJECT);
const outDir = AN.anchorOutDir(ROOT);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const journalDir = path.join(WORK, 'journal');
const ORIG = fs.readFileSync(path.join(ROOT, CARD), 'utf8');

async function freePort(from) {
  for (let p = from; p < from + 200; p++) {
    const free = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('空きポートが見つかりません');
}
const PORT = await freePort(3290);
const dev = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', String(PORT), '-H', '127.0.0.1'], {
  cwd: ROOT,
  env: { ...process.env, POC03_ANCHOR: '1', POC03_ANCHOR_OUT: outDir, NEXT_TELEMETRY_DISABLED: '1', VCIDE_EDIT_E1_WRITE: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let devOut = '';
dev.stdout.on('data', (b) => { devOut += b; });
dev.stderr.on('data', (b) => { devOut += b; });
const stopDev = () => { try { process.kill(-dev.pid, 'SIGKILL'); } catch { /* 止まっている */ } };
process.on('exit', stopDev);

let browser = null;
async function main() {
  const BASE = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    up = await fetch(`${BASE}/properties`).then((r) => r.status === 200).catch(() => false);
    if (!up) await sleep(500);
  }
  ok('題材（使い捨てのコピー）の next dev が /properties に応答する', up, devOut.slice(-400));
  if (!up) return;
  browser = await chromium.launch({ ...(CHANNEL === 'none' ? {} : { channel: CHANNEL }) });
  console.log(`ブラウザ: ${browser.version()} / 題材（使い捨て）: ${ROOT}`);
  const VPS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 375, height: 812 }];
  const pages = {};
  for (const vp of VPS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    pages[vp.name] = await ctx.newPage();
    await pages[vp.name].goto(`${BASE}/properties`, { waitUntil: 'load' });
    await pages[vp.name].waitForSelector('[data-vcide][data-vcide-rev]', { timeout: 60000 });
  }
  const docToken = sha256(`${ROOT}:${PORT}:${Date.now()}`).slice(0, 32);

  /** 製品の previewGateway のスクリプト（describe）と同じ規則で、外枠の <div>（何番目か）の選択を作る */
  const selectCard = (pg, ordinal = 0) => pg.evaluate((ord) => {
    const ID = /^[0-9a-f]{10}$/; const REV = /^[0-9a-f]{16}$/;
    /* 一覧の各 <li> の中の外枠（PropertyCard）。同じ class の SiteNotice（別の部品）は選ばない */
    const cards = [...document.querySelectorAll('li > div[data-vcide]')].filter((el) => el.classList.contains('md:p-6'));
    const el = cards[ord];
    const anchorOf = (e) => { const v = e.getAttribute('data-vcide'); return v && ID.test(v) ? v : null; };
    const revOf = (e) => { const v = e.getAttribute('data-vcide-rev'); return v && REV.test(v) ? v : null; };
    const self = anchorOf(el); const anc = []; const ancRev = [];
    for (let p = el.parentElement; p && anc.length < 32; p = p.parentElement) { const a = anchorOf(p); if (a) { anc.push(a); ancRev.push(revOf(p)); } }
    const all = [...document.querySelectorAll(`[data-vcide="${self}"]`)];
    return { tag: el.localName, anchorOnSelf: self, anchorRev: revOf(el), anchorOrdinal: all.indexOf(el), anchorInstanceCount: all.length,
      ancestorAnchors: anc, ancestorRevs: ancRev, textNodeIndex: null, valueShape: null, formControl: false, path: location.pathname };
  }, ordinal);
  /** 実測: 同じ識別子の描画すべての class・計算済みスタイル・版と、文書の中の予測の印の数 */
  const measure = (pg, anchorId) => pg.evaluate((id) => {
    const els = [...document.querySelectorAll(`[data-vcide="${id}"]`)];
    const anchors = [...document.querySelectorAll('[data-vcide][data-vcide-rev]')].map((e) => [e.getAttribute('data-vcide'), e.getAttribute('data-vcide-rev')]);
    return {
      predictionMarkers: document.querySelectorAll('[data-vcide-predict]').length,
      elements: els.map((e) => ({ anchorId: id, rev: e.getAttribute('data-vcide-rev'), classTokens: [...e.classList], computed: { 'padding-top': getComputedStyle(e).paddingTop } })),
      anchors,
    };
  }, anchorId);
  /** 文書が描いたファイルとその版（**サーバー側で**対応表から引く。ページから受け取るのは識別子と版だけ） */
  const docRevs = (anchors) => {
    const man = AN.readManifest(outDir);
    const out = {};
    for (const [id, rev] of anchors) { const m = man.get(id); if (m) out[m.file] = rev; }
    return out;
  };
  const reportOf = async (r, anchorId, mode = { desktop: 'measured', mobile: 'measured' }) => {
    const measuredAt = new Date().toISOString();
    const artboards = [];
    for (const vp of VPS) {
      const m = await measure(pages[vp.name], anchorId);
      artboards.push({ viewport: { width: vp.width, height: vp.height }, mode: mode[vp.name], predictionMarkers: m.predictionMarkers, measuredAt,
        document: { token: docToken, path: '/properties', sourceRevs: docRevs(m.anchors) }, elements: m.elements });
    }
    return { txId: r.txId, anchorId, file: r.file, sourceRev: r.afterRev, measuredAt, artboards };
  };
  const waitRender = async (anchorId, rev, token) => {
    const t0 = Date.now();
    for (const vp of VPS) {
      await pages[vp.name].waitForFunction(([id, rv, tk]) => {
        const els = [...document.querySelectorAll(`[data-vcide="${id}"]`)];
        return els.length > 0 && els.every((e) => e.getAttribute('data-vcide-rev') === rv && e.classList.contains(tk));
      }, [anchorId, rev, token], { timeout: 90000 }).catch(() => null);
    }
    return Date.now() - t0;
  };

  const eng = new EditEngine({ projectRoot: ROOT, journalDir });
  const rc0 = eng.recover();
  ok('起動時の復旧: 未完了のジャーナルは無い', rc0.entries.length === 0, rc0);

  /* ------------------------------------------------ 3. 適用 */
  console.log('\n3. 解決 → 下書き → 適用 → HMR → 2幅の実測 → 検証');
  const s0 = await selectCard(pages.mobile, 0);
  ok('DOM から作った選択は製品の parseSelection を通る', !!P.parseSelection(s0), s0);
  ok('選んだ要素は複数回描かれている（同じ部品の利用）', s0.anchorInstanceCount > 1, s0.anchorInstanceCount);
  const t = eng.resolveTarget(s0);
  ok('対象の解決（第1段）', t.ok && t.target.file === CARD && t.target.component === 'PropertyCard', t);
  if (!t.ok) return;
  /* 対照: 同じ class の並びを持つ別の部品（SiteNotice の <section>）。PropertyCard の変更で変わってはならない */
  const notice = () => pages.mobile.evaluate(() => { const e = document.querySelector('section[data-vcide]'); return e ? { cls: [...e.classList], pad: getComputedStyle(e).paddingTop } : null; });
  const notice0 = await notice();
  ok('対照: SiteNotice の <section> も p-4 md:p-6（同じ class）', !!notice0 && notice0.cls.includes('p-4') && notice0.cls.includes('md:p-6'), notice0);
  const before = await measure(pages.mobile, t.target.anchorId);
  ok('適用前: Mobile の padding-top は 16px（p-4）', before.elements.every((e) => e.computed['padding-top'] === '16px'), before.elements.map((e) => e.computed));
  const d = eng.createDraft(t.target.id, s0, { kind: 'class-token', from: 'p-4', to: 'p-5' });
  ok('下書き（第2段）', d.ok, d);
  eq('下書きはファイルに触れない', fs.readFileSync(path.join(ROOT, CARD), 'utf8'), ORIG);
  const s1 = await selectCard(pages.desktop, 0);
  const r = eng.apply({ changes: [{ draftId: d.draft.id, reviewedDiffHash: d.draft.diffHash, selection: s1 }],
    expect: { desktop: { 'padding-top': '24px' }, mobile: { 'padding-top': '20px' } } });
  eq('適用（第3段・Desktop の DOM の選択で照合）は committed', r.status, 'committed');
  eq('ファイルは token 1つだけが変わった', fs.readFileSync(path.join(ROOT, CARD), 'utf8'), ORIG.replace('p-4 md:p-6', 'p-5 md:p-6'));
  eq('検証の前は成功扱いにしない', eng.outcome(r.txId).success, false);
  const ms = await waitRender(t.target.anchorId, r.afterRev, 'p-5');
  note(`HMR の反映まで ${ms} ms（2幅）`);
  const stale = eng.resolveTarget(s0);
  ok('HMR の後、適用前の DOM の選択は特定しない（古い版）', stale.ok === false && stale.anchorReason === 'source-changed', stale);
  const one = await reportOf(r, t.target.anchorId);
  const v1 = eng.submitVerification({ ...one, artboards: one.artboards.filter((b) => b.viewport.width === 375) });
  ok('Mobile だけの報告は verified にしない（viewport-missing）', v1.status === 'not-verified' && v1.problems.some((q) => q.code === 'viewport-missing'), v1);
  const vp = eng.submitVerification(await reportOf(r, t.target.anchorId, { desktop: 'measured', mobile: 'predicted' }));
  ok('予測を含む報告は verified にしない（predicted-not-accepted）', vp.status === 'not-verified' && vp.problems.some((q) => q.code === 'predicted-not-accepted'), vp);
  const rep = await reportOf(r, t.target.anchorId);
  const pads = Object.fromEntries(rep.artboards.map((b) => [b.viewport.width, [...new Set(b.elements.map((e) => e.computed['padding-top']))]]));
  eq('実測: Mobile 375 は 20px（p-5）', JSON.stringify(pads[375]), '["20px"]');
  eq('対照: 同じ class の SiteNotice は変わらない（p-4・16px のまま）', JSON.stringify(await notice()), JSON.stringify(notice0));
  eq('実測: Desktop 1440 は 24px のまま（md:p-6 が優先）', JSON.stringify(pads[1440]), '["24px"]');
  const v = eng.submitVerification(rep);
  eq('2幅の実測の報告は verified', v.status, 'verified');
  ok('成功（committed かつ verified）', eng.outcome(r.txId).success === true, eng.outcome(r.txId));

  /* ------------------------------------------------ 4. 取り消し */
  console.log('\n4. 取り消し → HMR → 2幅の実測 → 検証');
  const rv = eng.revert(r.txId);
  eq('取り消しは committed', rv.status, 'committed');
  eq('ファイルは適用前とバイト一致', fs.readFileSync(path.join(ROOT, CARD), 'utf8'), ORIG);
  await waitRender(t.target.anchorId, rv.afterRev, 'p-4');
  const rrep = await reportOf(rv, t.target.anchorId);
  eq('実測: 取り消し後の Mobile は 16px', JSON.stringify([...new Set(rrep.artboards[1].elements.map((e) => e.computed['padding-top']))]), '["16px"]');
  eq('取り消しの検証は verified', eng.submitVerification(rrep).status, 'verified');
  const old = eng.submitVerification(await reportOf(r, t.target.anchorId));
  ok('取り消した後に、古い適用の報告を verified にしない', old.status === 'not-verified', old);

  /* ------------------------------------------------ 5. RV07 の実際の HMR 版 */
  console.log('\n5. 外部の編集で同じ位置に別の要素が来た（兄弟の <dd> の入れ替え）');
  const selectDd = (pg, i) => pg.evaluate((k) => {
    const el = document.querySelectorAll('li dl dd')[k];
    const v = el.getAttribute('data-vcide');
    const all = [...document.querySelectorAll(`[data-vcide="${v}"]`)];
    return { tag: 'dd', anchorOnSelf: v, anchorRev: el.getAttribute('data-vcide-rev'), anchorOrdinal: all.indexOf(el), anchorInstanceCount: all.length,
      ancestorAnchors: [], ancestorRevs: [], textNodeIndex: 0, valueShape: { chars: 2, cls: 'cjk' }, formControl: false, path: location.pathname };
  }, i);
  const sp = await selectDd(pages.desktop, 0);   // 最初のカードの1つ目の <dd>（{property.pref}）
  const tp = eng.resolveTarget(sp);
  ok('前提: <dd>{property.pref}</dd>（PropertyCard）を対象にした', tp.ok && tp.target.file === CARD && tp.target.tag === 'dd', tp);
  const swapped = ORIG.replace('<dd>{property.pref}</dd>\n          <dd>{property.utility}</dd>', '<dd>{property.utility}</dd>\n          <dd>{property.pref}</dd>');
  fs.writeFileSync(path.join(ROOT, CARD), swapped);   // IDE の外のエディタの保存
  const newRev = AN.sourceRevision(swapped);
  for (const vpn of ['desktop', 'mobile']) {
    await pages[vpn].waitForFunction((rv2) => document.querySelector('li dl dd')?.getAttribute('data-vcide-rev') === rv2, newRev, { timeout: 90000 }).catch(() => null);
  }
  const sn = await selectDd(pages.desktop, 0);
  eq('前提: HMR の後、同じ位置の <dd>（いまは utility）が同じ識別子を持つ', sn.anchorOnSelf, sp.anchorOnSelf);
  const rr = eng.reresolveTarget(tp.target.id, sn);
  ok('古い対象（pref の <dd>）を、同じ識別子の別の要素（utility の <dd>）へ付け替えない（element-mismatch）', rr.ok === false && rr.reason === 'element-mismatch', rr);
  fs.writeFileSync(path.join(ROOT, CARD), ORIG);

  const rcEnd = eng.recover();
  ok('最後の復旧: 確定済みのジャーナルに何もしない', rcEnd.entries.every((e) => e.wrote === false), rcEnd);
  eq('src/ に一時ファイルを残さない', fs.readdirSync(path.join(ROOT, 'src/components')).filter((n) => n.includes('vcide-edit')).length, 0);
}

try {
  await main();
} catch (e) {
  ok('e2e の本体が例外なく終わる', false, String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
} finally {
  if (browser) await browser.close().catch(() => {});
  stopDev();
  await sleep(500);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
}
ok('元の題材（poc/fixture-edit/src）は1バイトも変わらない（F-10）', sameSnapshot(fixtureBefore, snapshot(path.join(FIXTURE_EDIT, 'src'))));
ok('使い捨てのコピーを消した', !fs.existsSync(WORK));
C.finish();
