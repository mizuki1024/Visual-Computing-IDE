/* =============================================================================
 * 視覚編集 E2 — 実ブラウザでの同期（使い捨ての題材・実際の next dev・**実際の中継（PreviewGateway）**・実際の HMR・2幅）。
 *   npm run build:lib && PW_CHANNEL=none node tests/edit-sync-e2e.spec.mjs
 *
 * 確かめること（docs/08c 第5節）
 *   1. 中継の文書の識別子: 2幅のページを**製品の中継**から開き、中継が差し込んだスクリプトの data-vcide-doc（文書の識別子）が、
 *      中継の記録（RelayObserver に渡した docToken）のちょうど1件と結び付くこと。幅ごとに別の文書であること
 *      （探索の bindDocument をそのまま使う。**推測ではなく中継の記録との照合**）
 *   2. 適用 → HMR の後の選択の引き継ぎ（docs/07d 3.3）: HMR の後の DOM の選択は、afterRev と afterFingerprint が一致して引き継がれる。
 *      HMR の前の DOM の選択は引き継がない。引き継いだ対象で次の下書きを作れる
 *   3. 外部変更（同じファイルの別の行）→ HMR の後: 引き継がない・古い対象での下書きも止まる。選び直せば通常どおり解決できる
 *   4. HMR の後の文書の同定（実測の記録）: HMR は文書を読み直さず、RSC の取り直しが中継を通る → 探索の bindDocument は
 *      `refetched-after-document` で同定しない。検証の報告と中継の結び付けの規則を決める材料（**この試験は規則を決めない**）
 *   5. 検証の結果は、文書と中継の結び付けを確かめていないこと（documentBinding: not-checked）を返す
 *   6. 元の題材は1バイトも変わらない（F-10）
 *
 * 選択は、製品の中継のスクリプト（describe）と同じ規則で DOM から作る（iframe の親が無いので、スクリプトの select の知らせは使えない）。
 * この点は**製品の画面からの選択ではない**（docs/08c 第5節の未検証事項）。
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { counter, loadEdit, AN, P, REPO, LIB, FIXTURE_EDIT, CARD, snapshot, sameSnapshot, require_ } from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note } = C;
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let E;
try { E = loadEdit('engine'); } catch (e) { ok('製品の編集エンジンを読み込める', false, String(e.message)); C.finish(); }
const { EditEngine } = E;
const GW = require_(path.join(LIB, 'server', 'previewGateway.js'));
const ACC = require_(path.join(LIB, 'server', 'access.js'));
const LO = require_(path.join(LIB, 'lib', 'liveObservation.js'));
process.env.VCIDE_EDIT_E1_WRITE = '1';

if (!fs.existsSync(path.join(FIXTURE_EDIT, 'node_modules', 'next', 'dist', 'bin', 'next'))) {
  ok(`題材 ${FIXTURE_EDIT} の依存がインストールされている（cd poc/fixture-edit && npm ci）`, false);
  C.finish();
}

/* ------------------------------------------------------------ 使い捨ての題材 */
const WORK = path.join(REPO, 'poc', 'out', 'edit-sync-e2e');
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
const AFTER = ORIG.replace('p-4 md:p-6', 'p-5 md:p-6');

async function freePort(from) {
  for (let p = from; p < from + 200; p++) {
    const free = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('空きポートが見つかりません');
}
const PORT = await freePort(3390);
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

/* ------------------------------------------------------------ 製品の中継と、その記録 */
const RUN = `edit-sync-e2e:${dev.pid}:${Date.now()}`;
const exchanges = [];
let seq = 0;
const observer = {
  record(run, rec, meta) {
    if (run !== RUN) return;
    exchanges.push({ seq: ++seq, ...rec, ...(meta?.relayId ? { relayId: meta.relayId } : {}), ...(meta?.docToken ? { docToken: meta.docToken } : {}) });
  },
  excludeStatic() {},
};
const GW_PORT = await freePort(3450);
const gateway = new GW.PreviewGateway({
  config: ACC.accessConfig({}), port: GW_PORT,
  target: () => ({ target: { port: PORT, run: RUN }, reason: '' }), observer,
});
/** 探索の bindDocument に渡す観測（中継の記録だけ。サーバーの中の形） */
const obsNow = () => ({ exchanges: exchanges.map((e) => ({ ...e })) });

let browser = null;
async function main() {
  const info = await gateway.ensure();
  eq('製品の中継が待ち受ける', info.state, 'listening');
  const BASE = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    up = await fetch(`${BASE}/properties`).then((r) => r.status === 200).catch(() => false);
    if (!up) await sleep(500);
  }
  ok('題材（使い捨てのコピー）の next dev が /properties に応答する', up, devOut.slice(-400));
  if (!up) return;
  browser = await chromium.launch({ ...(CHANNEL === 'none' ? {} : { channel: CHANNEL }) });
  console.log(`ブラウザ: ${browser.version()} / 題材（使い捨て）: ${ROOT} / 中継: ${GW_PORT}`);
  const VPS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 375, height: 812 }];
  const pages = {};
  const GW_BASE = `http://127.0.0.1:${GW_PORT}`;
  for (const vp of VPS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    pages[vp.name] = await ctx.newPage();
    await pages[vp.name].goto(`${GW_BASE}/properties`, { waitUntil: 'load' });
    await pages[vp.name].waitForSelector('[data-vcide][data-vcide-rev]', { timeout: 60000 });
  }

  /* ------------------------------------------------ 1. 中継の文書の識別子 */
  console.log('\n1. 中継が差し込んだ文書の識別子と、中継の記録の対応（実測）');
  const docTokenOf = (pg) => pg.evaluate(() => document.querySelector('script[data-vcide-doc]')?.getAttribute('data-vcide-doc') ?? null);
  const tokens = {};
  for (const vp of VPS) tokens[vp.name] = await docTokenOf(pages[vp.name]);
  for (const vp of VPS) {
    const tk = tokens[vp.name];
    ok(`[${vp.width}] 文書に中継の識別子がある（32桁の16進）`, typeof tk === 'string' && P.DOC_TOKEN_RE.test(tk), tk);
    const hits = exchanges.filter((e) => e.docToken === tk);
    ok(`[${vp.width}] 中継の記録に、その識別子を持つ通信がちょうど1件（/properties・200・document）`,
      hits.length === 1 && hits[0].path === '/properties' && hits[0].status === 200 && hits[0].kind === 'document', hits);
    const b = LO.bindDocument(obsNow(), { token: tk, soft: false }, '/properties');
    eq(`[${vp.width}] 探索の bindDocument は、適用の前のこの文書を同定する`, b.status, 'identified');
  }
  ok('幅ごとに別の文書（別の識別子）', tokens.desktop !== tokens.mobile, tokens);
  const forged = LO.bindDocument(obsNow(), { token: 'f'.repeat(32), soft: false }, '/properties');
  ok('中継の記録に無い識別子は同定しない（token-not-in-session）', forged.status === 'unidentified' && forged.reason === 'token-not-in-session', forged);

  /** 製品の中継のスクリプト（describe）と同じ規則で、外枠の <div>（何番目か）の選択を作る */
  const selectCard = (pg, ordinal = 0) => pg.evaluate((ord) => {
    const ID = /^[0-9a-f]{10}$/; const REV = /^[0-9a-f]{16}$/;
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
  const waitRev = async (anchorId, rev) => {
    const t0 = Date.now();
    for (const vp of VPS) {
      await pages[vp.name].waitForFunction(([id, rv]) => {
        const els = [...document.querySelectorAll(`[data-vcide="${id}"]`)];
        return els.length > 0 && els.every((e) => e.getAttribute('data-vcide-rev') === rv);
      }, [anchorId, rev], { timeout: 90000 }).catch(() => null);
    }
    return Date.now() - t0;
  };
  const measure = (pg, anchorId) => pg.evaluate((id) => {
    const els = [...document.querySelectorAll(`[data-vcide="${id}"]`)];
    const anchors = [...document.querySelectorAll('[data-vcide][data-vcide-rev]')].map((e) => [e.getAttribute('data-vcide'), e.getAttribute('data-vcide-rev')]);
    return {
      predictionMarkers: document.querySelectorAll('[data-vcide-predict]').length,
      elements: els.map((e) => ({ anchorId: id, rev: e.getAttribute('data-vcide-rev'), classTokens: [...e.classList], computed: { 'padding-top': getComputedStyle(e).paddingTop } })),
      anchors,
    };
  }, anchorId);

  /* ------------------------------------------------ 2. 適用 → HMR → 引き継ぎ */
  console.log('\n2. 適用 → HMR の後の選択の引き継ぎ（afterRev と afterFingerprint）');
  const eng = new EditEngine({ projectRoot: ROOT, journalDir });
  const st0 = eng.startupRecovery();
  ok('起動時の復旧: 未完了の記録は無い（点検 → 復旧）', st0.mode === 'recovered' && st0.inspection.entries.length === 0, { mode: st0.mode });
  const s0 = await selectCard(pages.mobile, 0);
  ok('DOM から作った選択は製品の parseSelection を通る', !!P.parseSelection(s0), s0);
  const t = eng.resolveTarget(s0);
  ok('対象の解決（第1段）', t.ok && t.target.file === CARD && t.target.component === 'PropertyCard', t);
  if (!t.ok) return;
  const d = eng.createDraft(t.target.id, s0, { kind: 'class-token', from: 'p-4', to: 'p-5' });
  const r = eng.apply({ changes: [{ draftId: d.draft.id, reviewedDiffHash: d.draft.diffHash, selection: s0 }] });
  eq('適用は committed', r.status, 'committed');
  eq('ファイルは token 1つだけが変わった', fs.readFileSync(path.join(ROOT, CARD), 'utf8'), AFTER);
  const c0 = eng.carrySelection(r.txId, s0);
  ok('HMR の前の DOM の選択（適用前の版）は引き継がない（dom-not-at-after）', c0.carried === false && c0.reason === 'dom-not-at-after' && c0.reselect === true, c0);
  const ms = await waitRev(t.target.anchorId, r.afterRev);
  note(`HMR の反映まで ${ms} ms（2幅）`);
  const carried = {};
  for (const vp of VPS) {
    const s1 = await selectCard(pages[vp.name], 0);
    eq(`[${vp.width}] 前提: HMR の後の DOM の版は afterRev`, s1.anchorRev, r.afterRev);
    const c = eng.carrySelection(r.txId, s1);
    ok(`[${vp.width}] HMR の後の選択は引き継ぐ（同じ要素・afterRev・afterFingerprint）`, c.carried === true && c.target.anchorId === t.target.anchorId && c.target.sourceRev === r.afterRev
      && c.target.fingerprint === eng.journal(r.txId).target.afterFingerprint.hash, c);
    carried[vp.name] = { s1, c };
  }
  const dNext = carried.desktop.c.carried ? eng.createDraft(carried.desktop.c.target.id, carried.desktop.s1, { kind: 'class-token', from: 'p-5', to: 'p-6' }) : null;
  ok('引き継いだ対象で次の下書きを作れる（第2段の照合を通る。適用はしない）', dNext?.ok === true, dNext);

  /* ------------------------------------------------ 4. HMR の後の文書の同定（実測の記録） */
  console.log('\n4. HMR の後の文書の同定（実測。規則は決めない）');
  for (const vp of VPS) {
    const tk = await docTokenOf(pages[vp.name]);
    const sameDoc = tk === tokens[vp.name];
    note(`[${vp.width}] HMR の後の文書の識別子は適用の前と${sameDoc ? '同じ（文書を読み直していない）' : '違う（読み直した）'}`);
    const doc = exchanges.find((e) => e.docToken === tokens[vp.name]);
    const rsc = exchanges.filter((e) => e.kind === 'rsc' && e.path === '/properties' && doc && e.startMs >= doc.startMs);
    const b = LO.bindDocument(obsNow(), { token: tk, soft: false }, '/properties');
    note(`[${vp.width}] 中継を通った RSC の取り直し（同じパス・文書の後）: ${rsc.length} 件 / 探索の bindDocument: ${b.status}${b.reason ? `（${b.reason}）` : ''}`);
    ok(`[${vp.width}] HMR の後の文書の識別子も、中継の記録の1件にある（偽の識別子ではない）`, exchanges.filter((e) => e.docToken === tk).length === 1, tk);
  }

  /* ------------------------------------------------ 5. 検証の結果の出所 */
  console.log('\n5. 検証の結果は、文書と中継の結び付けを確かめていないことを返す');
  const man = AN.readManifest(outDir);
  const artboards = [];
  const measuredAt = new Date().toISOString();
  for (const vp of VPS) {
    const m = await measure(pages[vp.name], t.target.anchorId);
    const revs = {};
    for (const [id, rv] of m.anchors) { const x = man.get(id); if (x) revs[x.file] = rv; }
    artboards.push({ viewport: { width: vp.width, height: vp.height }, mode: 'measured', predictionMarkers: m.predictionMarkers, measuredAt,
      document: { token: await docTokenOf(pages[vp.name]), path: '/properties', sourceRevs: revs }, elements: m.elements });
  }
  const v = eng.submitVerification({ txId: r.txId, anchorId: t.target.anchorId, file: CARD, sourceRev: r.afterRev, measuredAt, artboards });
  ok('2幅の実測の報告は verified（中身の照合。E1.1 と同じ）', v.status === 'verified', v);
  ok('（同）ただし文書と中継の結び付けは確かめていない（documentBinding: not-checked・measurement: declared-by-report）',
    v.documentBinding === 'not-checked' && v.measurement === 'declared-by-report', v);
  eq('outcome も documentBinding: not-checked', eng.outcome(r.txId).documentBinding, 'not-checked');

  /* ------------------------------------------------ 3. 外部変更 → HMR */
  console.log('\n3. 外部変更（同じファイルの別の行）→ HMR: 引き継がない');
  const EXTERNAL = AFTER.replace('竣工', '完成');
  fs.writeFileSync(path.join(ROOT, CARD), EXTERNAL);   // IDE の外のエディタの保存
  const extRev = AN.sourceRevision(EXTERNAL);
  await waitRev(t.target.anchorId, extRev);
  const s2 = await selectCard(pages.desktop, 0);
  eq('前提: 外部変更の後の DOM の版', s2.anchorRev, extRev);
  const c2 = eng.carrySelection(r.txId, s2);
  ok('外部変更の後の DOM の選択は引き継がない（選び直し）', c2.carried === false && c2.reselect === true, c2);
  const c3 = eng.carrySelection(r.txId, carried.desktop.s1);
  ok('外部変更の前（適用後）の古い選択も、いまは引き継がない', c3.carried === false && c3.reselect === true, c3);
  const dStale = carried.desktop.c.carried ? eng.createDraft(carried.desktop.c.target.id, s2, { kind: 'class-token', from: 'p-5', to: 'p-6' }) : null;
  ok('引き継いだ（外部変更の前の）対象では下書きを作らない（版の照合で止まる）', dStale && dStale.ok === false && dStale.reselect === true, dStale);
  const fresh = eng.resolveTarget(s2);
  ok('選び直せば、いまの版の対象として通常どおり解決できる', fresh.ok === true && fresh.target.sourceRev === extRev, fresh);
  fs.writeFileSync(path.join(ROOT, CARD), ORIG);

  const ins = eng.inspectRecovery();
  ok('最後の点検: 予定の処理は無い（committed の記録には何もしない）', ins.mutates === false && ins.entries.every((e) => e.plannedAction === 'none'), ins.entries);
  eq('src/ に一時ファイルを残さない', fs.readdirSync(path.join(ROOT, 'src/components')).filter((n) => n.includes('vcide-edit')).length, 0);
}

try {
  await main();
} catch (e) {
  ok('e2e の本体が例外なく終わる', false, String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
} finally {
  if (browser) await browser.close().catch(() => {});
  await gateway.close().catch(() => {});
  stopDev();
  await sleep(500);
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
}
ok('元の題材（poc/fixture-edit/src）は1バイトも変わらない（F-10）', sameSnapshot(fixtureBefore, snapshot(path.join(FIXTURE_EDIT, 'src'))));
ok('使い捨てのコピーを消した', !fs.existsSync(WORK));
C.finish();
