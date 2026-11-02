/* =============================================================================
 * 編集 PoC — 実ブラウザでの端から端まで。
 *   要素選択 → 内側の余白を変更 → 適用前プレビュー → 差分の確認 → 明示的な適用 → HMR 後の再描画
 *   → 実際の値と状態の検証 → 取り消し
 * と、誤った書き込みを止められること（競合・古い識別子・条件付きクラス・確認していない差分・
 * 適用後の外部変更・HMR の失敗）を確かめる。
 *
 * 自分でハーネス（poc/edit/server.mjs）を起動する。題材のファイルは最初に全部写しを取り、
 * 最後に必ず元へ戻して一致を確かめる。結果は docs/06h-results/e2e.json、画面は docs/06h-screenshots/。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');
const FIXTURE = path.join(REPO, 'poc/fixture-edit');
const SHOTS = path.join(REPO, 'docs/06h-screenshots');
const RESULTS = path.join(REPO, 'docs/06h-results');
const UI = 'http://127.0.0.1:3262';
const CARD = path.join(FIXTURE, 'src/components/PropertyCard.tsx');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(RESULTS, { recursive: true });

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => fs.readFileSync(f, 'utf8');

/* -------------------------------------------- 題材の写し（必ず戻す） */
const SNAP = new Map();
(function snap(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) snap(abs); else SNAP.set(abs, fs.readFileSync(abs));
  }
}(path.join(FIXTURE, 'src')));
function restoreFixture() {
  let n = 0;
  for (const [abs, buf] of SNAP) if (!fs.existsSync(abs) || !fs.readFileSync(abs).equals(buf)) { fs.writeFileSync(abs, buf); n += 1; }
  return n;
}
const ORIGINAL_CARD = SNAP.get(CARD).toString('utf8');

/* --------------------------------------------------------------- 記録 */
const results = [];
let failed = 0;
function check(id, name, ok, evidence = {}) {
  results.push({ id, name, ok: !!ok, evidence });
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok' : 'NG'}  ${id} ${name}${ok ? '' : `\n      ${JSON.stringify(evidence).slice(0, 600)}`}`);
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

/* ------------------------------------------------------- ハーネス起動 */
const server = spawn(process.execPath, [path.join(REPO, 'poc/edit/server.mjs')], {
  cwd: REPO, env: { ...process.env, POC_EDIT_FAULTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
const ready = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 120000);
  const iv = setInterval(() => { if (serverOut.includes('POC_EDIT_READY')) { clearTimeout(t); clearInterval(iv); resolve(true); } }, 200);
  server.on('exit', () => { clearTimeout(t); clearInterval(iv); resolve(false); });
});
if (!ready) { console.error(serverOut); process.exit(1); }

const browser = await chromium.launch({ executablePath: process.env.PW_EXECUTABLE ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const T = (expr) => page.evaluate(expr);
const waitT = (fn, arg, ms = 30000) => page.waitForFunction(fn, arg, { timeout: ms });
const dockText = () => page.textContent('[data-testid=dock]');
const apiCall = (p, body) => page.evaluate(async ([p2, b]) => {
  const cfg = JSON.parse(atob(document.querySelector('meta[name="poc-config"]').content));
  const r = await fetch(p2, { method: b === undefined ? 'GET' : 'POST', headers: { 'x-poc-session': cfg.session, 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { ...(await r.json().catch(() => ({}))), http: r.status };
}, [p, body]);
const state = () => apiCall('/api/state');
const measure = (ab, anchor) => page.evaluate(([a, id]) => window.__poc.api.measure(a, id), [ab, anchor]);
const mobile = () => page.frameLocator('[data-testid=frame-Mobile]');
const desktop = () => page.frameLocator('[data-testid=frame-Desktop]');
const mobileCard = (n) => mobile().locator('ul > li').nth(n).locator('> div');
const waitConnected = () => waitT(() => document.querySelector('#connChip')?.textContent.includes('2/2') && window.__poc.api.ARTBOARDS.every((a) => a.ready));
async function selectMobileCard(n) {
  await page.click('[data-testid=mode-select]');
  await mobileCard(n).click({ position: { x: 3, y: 3 } });
  await waitT((k) => window.__poc.sel?.ordinal === k && window.__poc.sel?.resolved?.status === 'resolved' && window.__poc.measures?.Mobile, n);
}
/** n 件目の適用（1始まり）の状態が条件を満たし、画面の処理が終わるまで待つ */
const waitApplied = (n, cond, ms = 60000) => waitT(([k, c]) => {
  const a = window.__poc.server?.applied?.[k - 1];
  if (!a || window.__poc.busy) return false;
  const st = c.revert ? a.revert : a.status;
  return !!st && Object.entries(c.want).every(([key, v]) => st[key] === v);
}, [n, cond], ms);
async function waitFixtureHmr() { await sleep(2500); }
/** 重ね表示は計測のたびに描き直すので、取れるまで（最大 3 秒）読み直す */
const box = async (loc) => {
  for (let i = 0; i < 30; i++) { const b = await loc.boundingBox({ timeout: 500 }).catch(() => null); if (b) return b; await sleep(100); }
  return null;
};
const near = (a, b, tol = 1) => a && b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= tol);

let anchorId = null;
let sameClassId = null;
try {
  console.log('edit-poc e2e');
  await page.goto(UI);
  await waitConnected();

  /* ---------------------------------------------- 1. 複数幅と倍率 */
  const vps = await Promise.all(['Desktop', 'Mobile'].map(async (n) => {
    const fr = page.frameLocator(`[data-testid=frame-${n}]`);
    const inner = await fr.locator('html').evaluate(() => [window.innerWidth, window.innerHeight, document.documentElement.clientWidth, matchMedia('(width >= 48rem)').matches]);
    return { n, inner, display: await box(page.locator(`[data-testid=viewport-${n}]`)) };
  }));
  check('E01', 'CSS 上のビューポートは 1440×900 と 375×812（倍率と独立）。md は Desktop だけで有効', vps[0].inner[0] === 1440 && vps[0].inner[1] === 900 && vps[1].inner[0] === 375 && vps[1].inner[1] === 812 && vps[0].inner[3] && !vps[1].inner[3], vps);
  const cw = (b) => ({ w: b.width - 2, h: b.height - 2 });   // 枠線 1px×2 を除いた表示寸法
  const [dc, mc] = [cw(vps[0].display), cw(vps[1].display)];
  check('E02', '同じ倍率（50%）の表示寸法: 720×450 と 187.5×406。幅の比 = 1440/375・高さの比 = 900/812',
    Math.abs(dc.w - 720) < 0.6 && Math.abs(dc.h - 450) < 0.6 && Math.abs(mc.w - 187.5) < 0.6 && Math.abs(mc.h - 406) < 0.6
    && Math.abs(dc.w / mc.w - 1440 / 375) < 0.01 && Math.abs(dc.h / mc.h - 900 / 812) < 0.01,
    { desktop: vps[0].display, mobile: vps[1].display, note: '表示寸法は枠線 1px×2 を含む' });

  /* ---------------------------------------------- 2. 選択とソースの対応 */
  await selectMobileCard(1);
  const sel = await T(() => ({ ...window.__poc.sel, resolved: window.__poc.resolved ?? window.__poc.sel.resolved }));
  anchorId = sel.anchorId;
  sameClassId = sel.resolved.sameClass?.[0]?.id ?? null;
  const domIds = await mobile().locator('ul > li > div').evaluateAll((els) => els.map((e) => e.getAttribute('data-vcide')));
  const dt = await dockText();
  check('E03', 'map の2番目を選ぶと、共有する定義 PropertyCard.tsx:7:5 の <div> に照合される（6段の照合を通過）',
    sel.resolved.anchor.file === 'src/components/PropertyCard.tsx' && sel.resolved.anchor.line === 7 && sel.resolved.anchor.col === 5
    && sel.resolved.anchor.component === 'PropertyCard' && sel.resolved.checks.length === 6 && sel.ordinal === 1,
    { anchor: sel.resolved.anchor, ordinal: sel.ordinal, checks: sel.resolved.checks.length });
  check('E04', '10 個の描画は同じ識別子（同じコード）。描画回数 10 とソース上の利用箇所 2 を別の数として出す',
    new Set(domIds).size === 1 && domIds.length === 10 && sel.count === 10 && sel.resolved.usages.length === 2
    && /この幅で10回描画/.test(dt) && /検出できた利用箇所 2件/.test(dt),
    { domIds: [...new Set(domIds)], renders: sel.count, usages: sel.resolved.usages, usageCount: sel.resolved.usageCount });
  check('E05', '画面で選んだ対象（Mobile・2番目）と書き込み先（部品の定義のファイル:行）を別に示し、共有定義の変更を警告する',
    /Mobile 375 で選択 · 2番目/.test(dt) && /共有部品の定義を変更します/.test(dt) && /src\/components\/PropertyCard\.tsx:7 · className の p-4/.test(dt)
    && /この利用箇所だけの変更は不可/.test(dt), { dock: dt.slice(0, 400) });
  check('E05b', '利用箇所は静的走査で 2 件。開いたページの対応表だけだと 1 件（/favorites は未コンパイル）',
    sel.resolved.usageCount.staticScan === 2 && sel.resolved.usageCount.manifestOnly === 1, sel.resolved.usageCount);

  /* 選択枠と拡大縮小 */
  const tBox = await box(mobileCard(1));
  const oBox = await box(page.locator('[data-testid=overlay-primary-Mobile]'));
  const secM = await page.locator('[data-testid=overlay-sec-Mobile]').count();
  const secD = await page.locator('[data-testid=overlay-sec-Desktop]').count();
  check('E06', '別 origin の iframe から受け取った矩形 × 倍率で描いた選択枠が、実要素の画面上の位置と 1px 以内で一致',
    near(tBox, oBox, 1), { element: tBox, overlay: oBox });
  check('E07', '同じコードの他の描画は四隅の印（Mobile 9・Desktop 10）。主選択は1つ', secM === 9 && secD === 10
    && await page.locator('[data-testid^=overlay-primary]').count() === 1, { secM, secD });
  const m0 = await measure('Mobile', anchorId);
  const d0 = await measure('Desktop', anchorId);
  check('E08', '現在のコードの計算済み padding: Mobile 16px・Desktop 24px（境界越しに取得）',
    m0.items.every((i) => i.pad.every((p) => p === 16)) && d0.items.every((i) => i.pad.every((p) => p === 24)) && !m0.predicted,
    { mobile: [...new Set(m0.items.map((i) => i.pad.join('/')))], desktop: [...new Set(d0.items.map((i) => i.pad.join('/')))] });
  const st0 = await state();
  check('E09', 'ブレークポイントと spacing は題材の Tailwind 設定をコンパイルして読む（md=48rem=768px・spacing=0.25rem=4px）',
    st0.theme.breakpoints.md.px === 768 && st0.theme.spacing.px === 4 && st0.theme.source === 'tailwind-compile', st0.theme);
  check('E10', '観測の記録は書き込み前は「現在のコードと一致」', st0.observation.freshness.state === 'current', st0.observation);
  check('E11', 'コンテナ（値を持たない外枠）では経路を代表1本にまとめず「出所を見る値を選択してください」と案内',
    /この要素自体は値を表示していません/.test(await page.textContent('[data-testid=dataflow]')) && /出所を見る値を選択してください/.test(await page.textContent('[data-testid=dataflow]')),
    { flow: (await page.textContent('[data-testid=dataflow]')).slice(0, 300) });
  await shot(page, '01-selected-mobile-2nd');

  /* ---------------------------------------------- 3. 下書きと適用前プレビュー */
  const h0 = sha(read(CARD));
  await page.selectOption('[data-testid=value]', 'p-5');
  await waitT(() => window.__poc.view === 'preview' && document.querySelector('[data-testid=draft-summary]'));
  await sleep(500);
  const mp = await measure('Mobile', anchorId);
  const dp = await measure('Desktop', anchorId);
  const heads = await page.$$eval('.ab-head .l2', (els) => els.map((e) => e.textContent));
  check('E12', '下書きの段階では題材のソースを変更しない', sha(read(CARD)) === h0, { before: h0.slice(0, 12), now: sha(read(CARD)).slice(0, 12) });
  check('E13', '適用前プレビュー（予測・方式 A）: Mobile 20px・Desktop 24px。予測であることを測定値と見出しで区別',
    mp.predicted && dp.predicted && mp.items.every((i) => i.pad[0] === 20) && dp.items.every((i) => i.pad[0] === 24)
    && heads.every((h) => /適用前プレビュー（予測）/.test(h)) && /この幅は変化なし（予測）/.test(heads[0]) && /この幅は変わる（予測）/.test(heads[1]),
    { mobile: mp.items[0].pad, desktop: dp.items[0].pad, heads });
  check('E14', 'N0 は「下書き 1件 · コードは未変更」。書き込み・再描画・検証のチップはまだ無い',
    /下書き 1件 · 1ファイル · コードは未変更/.test(await page.textContent('[data-testid=change-chip]')) && /書き込み —/.test(await page.textContent('[data-testid=write-chip]')));
  await shot(page, '02-draft-preview-predicted');

  /* Undo / Redo（変更案の中） */
  await page.click('[data-testid=draft-undo]');
  await waitT(() => window.__poc.server?.draft?.isNoop === true);
  const afterUndo = await state();
  await page.click('[data-testid=draft-redo]');
  await waitT(() => window.__poc.server?.draft?.value === 'p-5' && window.__poc.view === 'preview');
  check('E15', '下書きの Undo（p-5 → p-4）と Redo（→ p-5）はファイルを変えない', afterUndo.draft.value === 'p-4' && sha(read(CARD)) === h0, { undoValue: afterUndo.draft.value });

  /* ---------------------------------------------- 4. 差分の確認 */
  await page.click('[data-testid=open-review]');
  await page.waitForSelector('[data-testid=diff]');
  const diff = await page.textContent('[data-testid=diff]');
  const minus = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
  const plus = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  check('E16', '差分は1行だけ: p-4 → p-5。md:p-6・他のクラスは同じ行に残る',
    minus.length === 1 && plus.length === 1 && minus[0] === '-    <div className="rounded-lg border bg-white p-4 md:p-6 shadow-sm">'
    && plus[0] === '+    <div className="rounded-lg border bg-white p-5 md:p-6 shadow-sm">', { diff });
  await shot(page, '03-review-diff');

  /* 確認していない差分での適用を拒否 */
  const dv = (await state()).draft;
  const bad = await apiCall('/api/apply', { draftId: dv.id, baseHash: dv.baseHash, diffHash: '0000000000000000' });
  check('E17', '確認した差分と違う差分（diffHash 不一致）では適用しない', bad.http === 409 && bad.reason === 'diff-not-reviewed' && sha(read(CARD)) === h0, bad);

  /* ---------------------------------------------- 5. 競合（外部変更） */
  const external = `${ORIGINAL_CARD}// 外部の編集（e2e）\n`;
  fs.writeFileSync(CARD, external);
  await waitFixtureHmr();
  await page.evaluate(() => window.__poc.api.apply());
  await page.waitForSelector('[data-testid=conflict], [data-testid=review-conflict]');
  check('E18', '変更案を作った後に外部変更があれば適用しない。ファイルは外部変更のまま（上書きしない）',
    read(CARD) === external && /外部変更|ファイルが変わりました/.test(await dockText()), { file: sha(read(CARD)).slice(0, 12) });
  await shot(page, '04-conflict-external-change');
  await page.click('[data-testid=recheck]');
  await page.waitForSelector('[data-testid=diff]');
  const dv2 = (await state()).draft;
  check('E19', '再確認でいまの内容から差分を作り直す（基準が外部変更後の内容になる）', dv2.baseHash === sha(external) && dv2.upToDate, { base: dv2.baseHash.slice(0, 12) });

  /* ---------------------------------------------- 6. 適用・再描画・検証 */
  const revBefore = (await state()).revision.id;
  await page.click('[data-testid=apply]');
  await waitApplied(1, { want: { verify: 'passed', rerender: 'reload' } });
  const st1 = await state();
  const a1 = st1.applied.at(-1);
  const after = read(CARD);
  const md = await measure('Mobile', anchorId);
  const dd = await measure('Desktop', anchorId);
  const ctrlM = await measure('Mobile', sameClassId);
  const ctrlD = await measure('Desktop', sameClassId);
  check('E20', '明示的な適用の後にだけソースが変わる: 変更は p-4 → p-5 の1か所だけ（外部変更・コメント・md:p-6 は保持）',
    after === external.replace('bg-white p-4 md:p-6', 'bg-white p-5 md:p-6') && after.includes('// 外部の編集（e2e）') && after.includes('/* 共有部品。'),
    { diff: a1.diff });
  check('E21', '同じクラスを持つ無関係な要素（SiteNotice）と条件付きクラスのファイルは変わらない',
    read(path.join(FIXTURE, 'src/components/SiteNotice.tsx')) === SNAP.get(path.join(FIXTURE, 'src/components/SiteNotice.tsx')).toString()
    && read(path.join(FIXTURE, 'src/components/FilterPanel.tsx')) === SNAP.get(path.join(FIXTURE, 'src/components/FilterPanel.tsx')).toString()
    && ctrlM.items.every((i) => i.pad[0] === 16 && i.has['p-4']) && ctrlD.items.every((i) => i.pad[0] === 24), { ctrlM: ctrlM.items.map((i) => i.pad[0]), ctrlD: ctrlD.items.map((i) => i.pad[0]) });
  check('E22', 'HMR 後の実描画（予測ではない）: Mobile 10 件すべて 20px・Desktop 10 件すべて 24px（md:p-6 が優先）',
    !md.predicted && !dd.predicted && md.items.length === 10 && dd.items.length === 10
    && md.items.every((i) => i.pad.every((p) => p === 20) && i.has['p-5'] && !i.has['p-4']) && dd.items.every((i) => i.pad.every((p) => p === 24) && i.has['p-5']),
    { mobile: [...new Set(md.items.map((i) => i.pad.join('/')))], desktop: [...new Set(dd.items.map((i) => i.pad.join('/')))] });
  const v1 = a1.verifications;
  check('E23', '書き込み・再描画・検証を別々に記録: 書き込み=読み直して一致 / 再描画=HMR / 検証=通過、続けて再読み込みでも通過',
    a1.status.write === 'written-verified' && v1[0].rerender === 'hmr' && v1[0].verify === 'passed' && v1.at(-1).rerender === 'reload' && v1.at(-1).verify === 'passed',
    { status: a1.status, verifications: v1.map((v) => [v.rerender, v.verify]), rerender: await T(() => window.__poc.lastRerender), revisionHashMs: st1.revision.ms, revisionFiles: st1.revision.files });
  check('E24', '適用した版と確かめた描画の対応: 再読み込みした文書の版 = 適用後の版（内容ハッシュ）',
    v1.at(-1).verifiedRevision === a1.revAfter && a1.revAfter !== revBefore && v1.at(-1).artboards.every((x) => x.docRev === a1.revAfter),
    { revBefore, revAfter: a1.revAfter, docRevs: v1.at(-1).artboards.map((x) => x.docRev) });
  check('E25', '書き込み後、観測の記録は「古い」（新しいコードの実測として出さない）', st1.observation.freshness.state === 'stale', st1.observation.freshness);
  const note1 = await T(() => window.__poc.selNote);
  check('E26', '適用・HMR・再読み込みの後も同じ要素の選択を再解決できる（同じ識別子・6段の照合）', note1?.ok === true && /選択を再解決しました/.test(note1.text), note1);
  check('E27', '幅の帯は予測で、実際に開いた幅は 375・1440 だけと明示（中間の幅は未確認）', /376〜767px などの中間の幅は確かめていません/.test(await dockText()));
  await waitT(() => window.__poc.measures?.Mobile?.items?.length === 10);
  const swText = await page.textContent('[data-testid=selected-width]');
  const tagText = await page.textContent('[data-testid=overlay-primary-Mobile] ~ .padtag').catch(() => null);
  check('E22b', '適用・検証の直後、右ドックと選択の札に出す値も新しい描画の実測（p-5・20px）。古い計測を残さない',
    /効いている指定 p-5/.test(swText) && /計算済み 20px/.test(swText) && !/16px/.test(swText), { swText, tagText });
  await shot(page, '05-applied-hmr-verified');

  /* ---------------------------------------------- 7. 取り消し */
  await page.click('[data-testid=revert]');
  await waitApplied(1, { revert: true, want: { verify: 'passed', rerender: 'reload' } });
  const st2 = await state();
  const mr = await measure('Mobile', anchorId);
  check('E28', '適用の取り消し: 適用直後の内容と一致したので戻す。外部変更を含む適用前の内容とバイト一致',
    read(CARD) === external && st2.applied.at(-1).revert.status === 'reverted', { revert: st2.applied.at(-1).revert });
  check('E29', '取り消し後の再描画を確認: Mobile 16px・p-4 に戻る（HMR → 再読み込みでも通過）',
    mr.items.every((i) => i.pad[0] === 16 && i.has['p-4'] && !i.has['p-5']) && st2.applied.at(-1).revert.verify === 'passed',
    { mobile: [...new Set(mr.items.map((i) => i.pad.join('/')))], verifications: st2.applied.at(-1).verifications.map((v) => [v.phase, v.rerender, v.verify]) });
  check('E30', '取り消しで内容が元に戻っても、観測の記録は「古い」のまま（観測の後に書き込んだ）', st2.observation.freshness.state === 'stale', st2.observation.freshness);
  await shot(page, '06-reverted-verified');

  /* ---------------------------------------------- 8. 適用後の外部変更 → 取り消しを拒否 */
  await selectMobileCard(1);
  await page.selectOption('[data-testid=value]', 'p-5');
  await page.waitForSelector('[data-testid=open-review]');
  await page.click('[data-testid=open-review]');
  await page.waitForSelector('[data-testid=diff]');
  await page.click('[data-testid=apply]');
  await waitApplied(2, { want: { verify: 'passed', rerender: 'reload' } });
  const external2 = read(CARD).replace('<dl className="text-sm">', '<dl className="text-sm leading-6">');
  fs.writeFileSync(CARD, external2);
  await waitFixtureHmr();
  await page.click('[data-testid=applied-' + (await state()).applied[1].id + '] [data-testid=revert]');
  await page.waitForSelector('[data-testid=revert-refused]');
  check('E31', '適用後に外部変更が入ったら、取り消しを拒否し古いファイル全体で上書きしない（外部変更と p-5 が残る）',
    read(CARD) === external2 && /取り消しませんでした/.test(await dockText()) && read(CARD).includes('leading-6') && read(CARD).includes('p-5 md:p-6'),
    { refused: (await page.textContent('[data-testid=revert-refused]')).slice(0, 200) });
  await page.locator('[data-testid=revert-refused]').scrollIntoViewIfNeeded();
  await shot(page, '07-revert-refused-external-change');

  /* 題材を元に戻す（試験の手で。IDE の取り消しではない） */
  fs.writeFileSync(CARD, ORIGINAL_CARD);
  await waitFixtureHmr();
  await page.reload(); await waitConnected();

  /* ---------------------------------------------- 9. 古い識別子・選択の消失 */
  await selectMobileCard(1);
  const oldId = await T(() => window.__poc.sel.anchorId);
  const oldSel = await T(() => window.__poc.sel.selection);
  fs.writeFileSync(CARD, ORIGINAL_CARD.replace('export function PropertyCard', '// 外部の編集で1行増えた（e2e）\nexport function PropertyCard'));
  await waitT(() => window.__poc.selNote && window.__poc.selNote.ok === false, null, 30000);
  const lost = await T(() => ({ note: window.__poc.selNote, sel: window.__poc.sel }));
  const newIds = [...new Set(await mobile().locator('ul > li > div').evaluateAll((els) => els.map((e) => e.getAttribute('data-vcide'))))];
  check('E32', '行がずれて識別子が変わったら、選択を維持できない理由を示し、別の要素を黙って選ばない',
    lost.sel === null && /選択を維持できません/.test(lost.note.text) && newIds.length === 1 && newIds[0] !== oldId
    && await page.locator('[data-testid^=overlay-primary]').count() === 0, { note: lost.note.text, oldId, newIds });
  const staleDraft = await apiCall('/api/draft', { anchorId: oldId, to: 'p-5' });
  const staleResolve = await apiCall('/api/resolve', { instance: (await state()).instance, selection: oldSel });
  check('E33', '古い識別子での変更案・照合は拒否（変更済みのソースの誤った位置へ書かない）',
    staleDraft.http === 422 && staleDraft.error === 'source-mismatch' && staleResolve.status === 'unresolved', { staleDraft, staleResolve: { reason: staleResolve.reason } });
  const staleInst = await apiCall('/api/resolve', { instance: '0000000000000000', selection: oldSel });
  check('E34', '別の起動インスタンスから来た選択は照合しない', staleInst.http === 409 && staleInst.reason === 'stale-instance', staleInst);
  await shot(page, '08-selection-lost-stale-anchor');
  fs.writeFileSync(CARD, ORIGINAL_CARD);
  await waitFixtureHmr();
  await page.reload(); await waitConnected();

  /* ---------------------------------------------- 10. 条件付きクラスの拒否 */
  await page.click('[data-testid=mode-select]');
  await desktop().locator('main > div.rounded-lg').first().click({ position: { x: 3, y: 3 } });
  await waitT(() => window.__poc.sel?.resolved?.anchor?.component === 'FilterPanel');
  const fp = await T(() => window.__poc.sel.resolved);
  const fpDraft = await apiCall('/api/draft', { anchorId: fp.anchor.id, to: 'p-5' });
  check('E35', '条件付きクラス（テンプレート内の三項演算子）は推測で書き換えず、理由付きで編集不可',
    fp.editable.state === 'not-editable' && fp.editable.reason === 'conditional-class' && fpDraft.http === 422 && fpDraft.error === 'conditional-class'
    && /編集できません/.test(await dockText()) && await page.locator('[data-testid=value]').count() === 0,
    { editable: fp.editable, fpDraft });
  await shot(page, '09-conditional-class-refused');

  /* ---------------------------------------------- 11. HMR の失敗 */
  await selectMobileCard(1);
  await page.selectOption('[data-testid=value]', 'p-5');
  await page.waitForSelector('[data-testid=open-review]');
  await page.click('[data-testid=open-review]');
  await page.waitForSelector('[data-testid=diff]');
  await apiCall('/api/test/hmr', { blocked: true });
  await page.click('[data-testid=apply]');
  await waitApplied(3, { want: { verify: 'not-verified', rerender: 'not-confirmed' } });
  const st3 = await state();
  const a3 = st3.applied.at(-1);
  const chips = { write: await page.textContent('[data-testid=write-chip]'), rerender: await page.textContent('[data-testid=rerender-chip]'), verify: await page.textContent('[data-testid=verify-chip]') };
  check('E36', 'HMR が届かないとき: 書き込みは済み、再描画は「確認できません」、検証は「未検証」（適用成功＝検証成功と出さない）',
    a3.status.write === 'written-verified' && a3.status.rerender === 'not-confirmed' && a3.status.verify === 'not-verified'
    && /済み/.test(chips.write) && /確認できません/.test(chips.rerender) && /未検証/.test(chips.verify) && !/通過/.test(chips.verify),
    { status: a3.status, chips });
  const heads3 = await page.$$eval('.ab-head .l2', (els) => els.map((e) => e.textContent));
  check('E36b', 'アートボードの見出しも「書き込み前の描画の可能性・文書の版 ≠ コードの版」と示し、現在のコードの描画と呼ばない',
    heads3.every((h) => /書き込み前の描画の可能性/.test(h) && !/^現在のコード/.test(h)), heads3);
  const mh = await measure('Mobile', a3.anchor.id);
  check('E37', 'そのとき画面は書き込み前のコードのまま（16px）で、予測の値を実測として扱っていない',
    mh.items.every((i) => i.pad[0] === 16 && i.has['p-4']) && !mh.predicted, { mobile: mh.items[0]?.pad });
  await shot(page, '10-hmr-failed-not-verified');
  await apiCall('/api/test/hmr', { blocked: false });
  await page.click(`[data-testid=applied-${(await state()).applied[2].id}] [data-testid=reload-check]`);
  await waitApplied(3, { want: { verify: 'passed', rerender: 'reload' } });
  const a3b = (await state()).applied.at(-1);
  check('E38', 'HMR を戻して［再読み込みして確認］→ 再読み込みの描画で検証が通過（版も一致）',
    a3b.status.rerender === 'reload' && a3b.status.verify === 'passed' && a3b.verifications.at(-1).verifiedRevision === a3b.revAfter, { status: a3b.status });
  await page.click(`[data-testid=applied-${(await state()).applied[2].id}] [data-testid=revert]`);
  await waitApplied(3, { revert: true, want: { verify: 'passed', rerender: 'reload' } });
  check('E39', '後片付けの取り消しも照合して戻した（元の内容とバイト一致）', read(CARD) === ORIGINAL_CARD);

  /* ---------------------------------------------- 12. 境界越しの通信の検査 */
  const rej0 = await T(() => window.__poc.rejected);
  await mobile().locator('html').evaluate(() => { window.parent.postMessage({ source: 'vcide-edit-agent', v: 1, kind: 'measure', req: 1, anchor: '0dca476ff6', items: [], vw: 1, vh: 1, predicted: true }, '*'); });
  await page.evaluate(() => window.postMessage({ source: 'vcide-edit-agent', v: 1, kind: 'hello' }, '*'));
  await sleep(500);
  const rej1 = await T(() => window.__poc.rejected);
  const connOk = await T(() => window.__poc.api.ARTBOARDS.every((a) => a.conn));
  check('E40', 'iframe のアプリが port を通さずに送った偽の計測は捨てる（拒否 +1）。親自身からの偽の hello は送り主が iframe でないので使わない',
    rej1 === rej0 + 1 && connOk, { rej0, rej1 });

  /* ---------------------------------------------- 13. 倍率の変更 */
  await selectMobileCard(1);
  await page.selectOption('[data-testid=scale]', '0.35');
  await sleep(900);
  const t35 = await box(mobileCard(1));
  const o35 = await box(page.locator('[data-testid=overlay-primary-Mobile]'));
  const vd35 = await box(page.locator('[data-testid=viewport-Desktop]'));
  const vm35 = await box(page.locator('[data-testid=viewport-Mobile]'));
  const inner35 = await mobile().locator('html').evaluate(() => window.innerWidth);
  check('E41', '倍率 35% でも CSS ビューポートは 375 のまま、表示は 1440×0.35 / 375×0.35、選択枠は実要素と 1px 以内',
    inner35 === 375 && Math.abs(vd35.width - (504 + 2)) < 0.6 && Math.abs(vm35.width - (131.25 + 2)) < 0.6 && near(t35, o35, 1),
    { desktop: vd35, mobile: vm35, element: t35, overlay: o35 });
  await shot(page, '11-scale-35');
  await page.selectOption('[data-testid=scale]', '0.5');

  check('E42', '画面のスクリプトエラーなし', pageErrors.length === 0, pageErrors);
} catch (e) {
  failed += 1;
  results.push({ id: 'EXC', name: '例外', ok: false, evidence: String(e.stack || e) });
  console.error(e);
  try { await shot(page, '99-exception'); } catch { /* 画面が無い */ }
} finally {
  const restored = restoreFixture();
  const intact = [...SNAP].every(([abs, buf]) => fs.readFileSync(abs).equals(buf));
  check('E99', `題材を元の内容に戻した（戻したファイル ${restored} 件）・全ファイルが写しとバイト一致`, intact, { restored });
  await browser.close();
  server.kill('SIGTERM');
  await sleep(1500);
  fs.writeFileSync(path.join(RESULTS, 'e2e.json'), JSON.stringify({
    at: new Date().toISOString(), browser: 'chromium (playwright-core 1.64.1, /opt/pw-browsers/chromium)', viewport: '1600x1000', results,
  }, null, 1));
  fs.writeFileSync(path.join(RESULTS, 'e2e-server.log'), serverOut);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
