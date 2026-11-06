/* =============================================================================
 * 視覚編集 E2.1 — 実ブラウザ・製品の画面での同期（docs/08d 第12節）。
 *   npm run build && npm run build:lib && PW_CHANNEL=none node tests/edit-sync21-e2e.spec.mjs
 *
 * この試験は IDE（next start）を **VCIDE_EDIT_SYNC_DEV=1** で自分で起動し、画面を `?editSyncDev=1` で開く。
 * 題材は poc/fixture-edit の使い捨てのコピー（poc/out/edit-sync21-e2e。Git 管理外。Client Component を1つ足す）。
 * 開発サーバーの起動・停止は製品の画面（プロジェクトと実行）から行い、選択は製品の開発用の同期の画面の
 * Desktop（1440×900）・Mobile（375×812）の iframe の中を**実際にクリック**して行う。
 * 中継・MessagePort・nonce・中継の台帳・探索の7段の照合・編集エンジンの読み取りの照合を通る（試験は DOM から選択を作らない）。
 * 正解は試験がソースを自分で読んで決める。書き込みは無効のまま（VCIDE_EDIT_E1_WRITE を渡さない）。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { counter, REPO, LIB, AN, FIXTURE_EDIT, CARD, snapshot, sameSnapshot, transform } from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note } = C;
const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const SHOTS = process.env.SHOTS ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1rev = (t) => crypto.createHash('sha1').update(t, 'utf8').digest('hex').slice(0, 16);

if (!fs.existsSync(path.join(REPO, '.next', 'BUILD_ID'))) { ok('IDE がビルドされている（npm run build）', false); C.finish(); }
if (!fs.existsSync(path.join(FIXTURE_EDIT, 'node_modules', 'next', 'dist', 'bin', 'next'))) { ok(`題材 ${FIXTURE_EDIT} の依存（npm ci）`, false); C.finish(); }

/* ------------------------------------------------------------ 使い捨ての題材 */
const WORK = path.join(REPO, 'poc', 'out', 'edit-sync21-e2e');
const PROJECT = path.join(WORK, 'poc', 'fixture-edit');
const fixtureBefore = snapshot(path.join(FIXTURE_EDIT, 'src'));
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'poc'), { recursive: true });
fs.cpSync(path.join(REPO, 'poc', 'anchor'), path.join(WORK, 'poc', 'anchor'), { recursive: true });
fs.cpSync(FIXTURE_EDIT, PROJECT, { recursive: true, filter: (s) => { const r = path.relative(FIXTURE_EDIT, s).split(path.sep); return r[0] !== 'node_modules' && r[0] !== '.next'; } });
execFileSync('cp', ['-al', path.join(FIXTURE_EDIT, 'node_modules'), path.join(PROJECT, 'node_modules')]);
const ROOT = fs.realpathSync(PROJECT);
const LIKE = 'src/components/LikeCounter.tsx';
const PAGE = 'src/app/properties/page.tsx';
const SN = 'src/components/SiteNotice.tsx';
const LIKE_SRC = ["'use client';", "import { useState } from 'react';", '', 'export function LikeCounter() {', '  const [n, setN] = useState(0);', '  return (',
  '    <div className="flex gap-2">',
  '      <button type="button" className="rounded border px-2" onClick={() => setN(n + 1)}>いいね {n}</button>',
  '    </div>', '  );', '}', ''].join('\n');
const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
const write = (rel, t) => fs.writeFileSync(abs(rel), t);
write(LIKE, LIKE_SRC);
write(PAGE, read(PAGE).replace("import { SiteNotice } from '../../components/SiteNotice';", "import { SiteNotice } from '../../components/SiteNotice';\nimport { LikeCounter } from '../../components/LikeCounter';")
  .replace('      <SiteNotice />', '      <LikeCounter />\n      <SiteNotice />'));
const locate = (rel, needle) => {
  const lines = read(rel).split('\n');
  const hits = lines.map((l, i) => (l.includes(needle) ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) throw new Error(`正解が1つに決まりません: ${rel} ${needle}`);
  const c = lines[hits[0]].indexOf('<') + 1;
  return `${rel}:${hits[0] + 1}:${c}`;
};

/* ------------------------------------------------------------ 要確認の復旧の記録（E21-17 の前提）
 * IDE の既定のジャーナルの場所（.ide-runtime/edit-journal/<鍵>）に、適用の途中で止まった記録を作る（子プロセスを SIGKILL）。
 * 子プロセスだけが VCIDE_EDIT_E1_WRITE=1。IDE には渡さない */
const JKEY = crypto.createHash('sha1').update(ROOT).digest('hex').slice(0, 12);
const JDIR = path.join(REPO, '.ide-runtime', 'edit-journal', JKEY);
fs.rmSync(JDIR, { recursive: true, force: true });
{
  const outDir = AN.anchorOutDir(ROOT);
  fs.mkdirSync(outDir, { recursive: true });
  const t = transform(read(CARD), CARD);
  fs.writeFileSync(path.join(outDir, `${crypto.createHash('sha1').update(CARD).digest('hex').slice(0, 16)}.json`), JSON.stringify({ file: CARD, rev: t.rev, anchors: t.anchors, usages: t.usages, components: t.components }));
  const lines = read(CARD).split('\n');
  const li = lines.findIndex((l) => l.includes('p-4 md:p-6'));
  const a = t.anchors.find((x) => x.line === li + 1 && x.col === lines[li].indexOf('<') + 1);
  const sel = { tag: a.tag, anchorOnSelf: a.id, anchorRev: t.rev, anchorOrdinal: 0, anchorInstanceCount: 1, ancestorAnchors: [], ancestorRevs: [], textNodeIndex: null, valueShape: null, formControl: false, path: '/properties' };
  const r = spawnSync(process.execPath, [path.join(REPO, 'tests', 'lib', 'edit-crash-child.mjs'), JSON.stringify({
    libjs: LIB, root: ROOT, journalDir: JDIR, selection: sel, change: { kind: 'class-token', from: 'p-4', to: 'p-5' }, mode: 'apply', at: 'applying', action: 'crash',
  })], { encoding: 'utf8' });
  ok('前提: 適用の途中で止まった記録を、IDE の既定のジャーナルの場所に作った（子プロセスを SIGKILL）', r.signal === 'SIGKILL' && fs.readdirSync(JDIR).length > 0, { signal: r.signal, out: r.stdout.slice(0, 200) });
}
const jsnap = () => JSON.stringify(fs.readdirSync(JDIR).sort().map((f) => { const st = fs.lstatSync(path.join(JDIR, f)); return [f, st.ino, st.size, st.mtimeMs, crypto.createHash('sha256').update(fs.readFileSync(path.join(JDIR, f))).digest('hex')]; }));
const journalBefore = jsnap();
const cardBefore = read(CARD);

/* ------------------------------------------------------------ IDE（開発用の同期を有効） */
async function freePort(from) {
  for (let p = from; p < from + 200; p++) {
    const free = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('空きポートが見つかりません');
}
const IDE_PORT = await freePort(3700);
const GW_PORT = await freePort(3760);
const ideEnv = { ...process.env, VCIDE_EDIT_SYNC_DEV: '1', VCIDE_PREVIEW_PORT: String(GW_PORT) };
delete ideEnv.VCIDE_EDIT_E1_WRITE;
const ide = spawn(process.execPath, [path.join(REPO, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(IDE_PORT), '-H', '127.0.0.1'],
  { cwd: REPO, env: ideEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let ideOut = '';
ide.stdout.on('data', (d) => { ideOut += d; });
ide.stderr.on('data', (d) => { ideOut += d; });
const killIde = () => { try { process.kill(-ide.pid, 'SIGTERM'); } catch { /* 終わっている */ } };
process.on('exit', killIde);
const IDE = `http://127.0.0.1:${IDE_PORT}`;
for (let i = 0; ; i++) {
  const up = await fetch(`${IDE}/api/runtime/status`).then((r) => r.status === 200).catch(() => false);
  if (up) break;
  if (i > 240) { console.log(ideOut); throw new Error('IDE が起動しませんでした'); }
  await sleep(250);
}

const browser = await chromium.launch({ ...(CHANNEL === 'none' ? {} : { channel: CHANNEL }) });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const ideErrors = [];
await page.exposeBinding('__e21Error', (_s, m) => { ideErrors.push(String(m)); });
await page.addInitScript(() => {
  if (window !== window.top) return;
  addEventListener('error', (e) => window.__e21Error(e.message));
  addEventListener('unhandledrejection', (e) => window.__e21Error(e.reason?.message ?? String(e.reason)));
  /* 開発用の画面が作る MessageChannel の port1 を覚えておく（E21-06・07: 古い port・偽の知らせを差し込むため） */
  window.__ports = [];
  const MC = window.MessageChannel;
  window.MessageChannel = function Spy() { const c = new MC(); window.__ports.push(c.port1); return c; };
});
const shot = async (n) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${n}.png`) }); } };

const panel = () => page.locator('section[data-edit-sync-dev]');
const B = (a) => `[data-edit-board="${a}"]`;
const attrs = (a) => page.evaluate((sel) => { const el = document.querySelector(sel); return el ? { ...el.dataset } : null; }, B(a));
const waitBoard = (a, fnSrc, timeout = 60000) => page.waitForFunction(([sel, src]) => {
  const el = document.querySelector(sel);
  // eslint-disable-next-line no-new-func
  return !!el && new Function('d', `return (${src})`)(el.dataset);
}, [B(a), fnSrc], { timeout });
const frame = (a) => page.frameLocator(`iframe[data-edit-frame="${a}"]`);
const rtPanel = () => page.locator('.fpnl[aria-label="プロジェクトと実行"]');
const state = () => page.evaluate(async () => (await fetch('/api/edit-sync/state')).json());
const postApi = (op, body) => page.evaluate(async ([o, b]) => {
  const r = await fetch(`/api/edit-sync/${o}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: JSON.stringify(b) });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
}, [op, body]);
const toggleSelect = async (on) => {
  const cur = await panel().getAttribute('data-select-mode');
  if ((cur === 'on') !== on) await panel().locator('[data-edit-select]').click();
  await page.waitForFunction((v) => document.querySelector('section[data-edit-sync-dev]')?.getAttribute('data-select-mode') === v, on ? 'on' : 'off');
  await sleep(200);
};
/** 要素の端（内側の余白）をクリックする（中央は子の要素に当たる）。選択の結果を受けた回数が増えるまで待つ */
async function pick(a, locator, edge = true) {
  const n = Number((await attrs(a))?.selN ?? 0);
  await locator.click({ timeout: 30000, ...(edge ? { position: { x: 3, y: 3 } } : {}) });
  await waitBoard(a, `Number(d.selN) > ${n} && d.sync !== 'verifying'`, 30000);
  return attrs(a);
}
const connected = (a) => waitBoard(a, "d.connState === 'connected' && d.connection === 'identified'", 90000);

async function main() {
  /* ======================================================== 起動 */
  console.log('\n0. IDE（VCIDE_EDIT_SYNC_DEV=1）を開き、題材を製品の画面から起動する');
  await page.goto(`${IDE}/`, { waitUntil: 'networkidle' });
  eq('?editSyncDev=1 が無ければ開発用の同期は描かない（通常の探索の画面）', await page.locator('section[data-edit-sync-dev]').count(), 0);
  await page.goto(`${IDE}/?editSyncDev=1`, { waitUntil: 'networkidle' });
  await panel().waitFor({ timeout: 20000 });
  ok('?editSyncDev=1 のとき開発用の同期を描く（開発サーバーの起動前は待機）', (await panel().getAttribute('data-edit-sync-dev')) === 'waiting');
  await rtPanel().locator('#rt-path').fill(ROOT);
  await rtPanel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction((p) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === p, ROOT, { timeout: 30000 });
  /* E21-17: プロジェクトを選んだ後の状態に、要確認の記録が出る（読むだけ） */
  await page.waitForFunction(() => Number(document.querySelector('[data-edit-recovery]')?.getAttribute('data-recovery-attention')) >= 1, null, { timeout: 30000 }).catch(() => {});
  await rtPanel().locator('.rt-b.go', { hasText: '起動する' }).click();
  await page.waitForFunction(() => document.querySelector('section[data-edit-sync-dev]')?.getAttribute('data-edit-sync-dev') === 'on', null, { timeout: 240000 });
  await panel().locator('[data-edit-path]').fill('/properties');
  await panel().locator('[data-edit-go]').click();
  await connected('desktop'); await connected('mobile');
  await frame('desktop').locator('[data-vcide]').first().waitFor({ timeout: 120000 });
  await frame('mobile').locator('[data-vcide]').first().waitFor({ timeout: 120000 });
  const d0 = await attrs('desktop'); const m0 = await attrs('mobile');
  ok('Desktop・Mobile とも接続済み（接続の識別子が別）', d0.connId && m0.connId && d0.connId !== m0.connId, [d0.connId, m0.connId]);
  const iw = await frame('desktop').locator('html').evaluate(() => [innerWidth, innerHeight]);
  const mw = await frame('mobile').locator('html').evaluate(() => [innerWidth, innerHeight]);
  eq('Desktop の文書のビューポートは 1440×900', iw.join('x'), '1440x900');
  eq('Mobile の文書のビューポートは 375×812', mw.join('x'), '375x812');
  eq('書き込みは無効（この画面からは書けない）', await panel().getAttribute('data-write-enabled'), 'off');
  await shot('01-connected');

  /* ======================================================== E21-01 */
  console.log('\nE21-01 実プレビューで選んだ要素の正しいソース位置');
  await toggleSelect(true);
  const cards = frame('desktop').locator('div.rounded-lg.border.bg-white.p-4');
  const nCards = await cards.count();
  ok('前提: 同じコンポーネント（PropertyCard）が複数描かれている', nCards >= 3, nCards);
  const a1 = await pick('desktop', cards.nth(0));
  eq('selected', a1.sync, 'selected');
  eq('正しいソース位置（試験がソースを読んで決めた正解）', a1.at, locate(CARD, 'p-4 md:p-6'));
  eq('コンポーネント', a1.component, 'PropertyCard');
  eq('ソースの版 = 試験が読んだ内容の sha1', a1.sourceRev, sha1rev(read(CARD)));
  ok('DOM の版 = 対応表の版 = ソースの版', a1.domRev === a1.sourceRev && a1.manifestRev === a1.sourceRev, a1);
  eq('文書の照合: 中継の応答と照合済み（document-identified）', a1.docLevel, 'document-identified');
  eq('描画は未検証（not-verified）', a1.render, 'not-verified');
  const text1 = await page.locator(B('desktop')).innerText();
  ok('画面に コンポーネント・ファイル:行:列・描画: 未検証 が出る', text1.includes('PropertyCard') && text1.includes(a1.at) && text1.includes('描画: 未検証'), text1.slice(0, 300));
  ok('プレビューの中のクリックはページを操作しない（同じパスのまま）', (await frame('desktop').locator('html').evaluate(() => location.pathname)) === '/properties');
  await shot('02-desktop-selected');

  /* ======================================================== E21-02 */
  console.log('\nE21-02 同一コンポーネントの複数インスタンス');
  const a2 = await pick('desktop', cards.nth(2));
  eq('3つ目のインスタンスも同じソース位置', a2.at, a1.at);
  ok('DOM のインスタンスは別（3番目・全体の数）', a2.ordinal === '2' && Number(a2.count) === nCards, [a2.ordinal, a2.count]);
  ok('画面に「どの利用箇所かは区別していません」', (await page.locator(B('desktop')).innerText()).includes('区別していません'));

  /* ======================================================== E21-03 */
  console.log('\nE21-03 Desktop と Mobile の接続の分離');
  const m3 = await pick('mobile', frame('mobile').locator('section.rounded-lg').first());
  eq('Mobile で別の要素（SiteNotice）を選ぶ', m3.component, 'SiteNotice');
  eq('（同）位置', m3.at, locate(SN, 'p-4 md:p-6'));
  ok('Mobile の文書は Desktop の文書と別', m3.docToken && m3.docToken !== a2.docToken, [m3.docToken, a2.docToken]);
  await sleep(1800);
  const d3 = await attrs('desktop');
  eq('Desktop の選択は変わらない（同じ対象・selected）', `${d3.sync}:${d3.targetId}`, `selected:${a2.targetId}`);
  const st3 = await state();
  ok('サーバーの登録も2枚別の文書', st3.connections.desktop.token === a2.docToken && st3.connections.mobile.token === m3.docToken, st3.connections);

  /* ======================================================== E21-17 */
  console.log('\nE21-17 復旧の状態を読み取り専用で確認');
  eq('状態の復旧は点検（inspected・mutates: false）', `${st3.recovery.status}:${st3.recovery.mutates}`, 'inspected:false');
  ok('止まった適用の記録が要確認として出る', st3.recovery.needsAttention >= 1, st3.recovery.entries);
  ok('画面にも要確認の記録が出る', Number(await page.locator('[data-edit-recovery]').first().getAttribute('data-recovery-attention')) >= 1);
  eq('IDE は記録を変えていない（自動の復旧・削除なし）', jsnap(), journalBefore);
  eq('（同）対象のソースも変えていない', read(CARD), cardBefore);

  /* ======================================================== E21-12 / E21-09 / E21-10 */
  console.log('\nE21-12・E21-09・E21-10 Server Component の更新（HMR・RSC の取り直し）');
  const mBefore = await attrs('mobile');
  write(CARD, cardBefore.replace('竣工', '完成'));
  await frame('desktop').locator('text=完成').first().waitFor({ timeout: 60000 });
  await frame('mobile').locator('text=完成').first().waitFor({ timeout: 60000 });
  await waitBoard('desktop', "d.sync === 'stale'", 20000);
  const d9 = await attrs('desktop');
  ok('E21-09: HMR の後、Desktop の選択は失効（stale・再選択が必要）', d9.sync === 'stale' && d9.reselect === 'yes', d9);
  ok('（同）理由は版の違い・要素の置き換わり', ['source-changed', 'element-mismatch', 'target-unresolved', 'dom-detached', 'target-moved'].includes(d9.syncReason), d9.syncReason);
  await sleep(1800);
  const m9 = await attrs('mobile');
  eq('Mobile の SiteNotice（変えていないファイル）の選択は selected のまま', `${m9.sync}:${m9.targetId}`, `selected:${mBefore.targetId}`);
  ok('E21-12: Mobile の文書も RSC で取り直した（自分の取り直しとして照合）', m9.refetch === 'self' && Number(m9.refetchCount) >= 1 && m9.docLevel === 'document-identified', m9);
  const a10 = await pick('desktop', cards.nth(0));
  eq('E21-10: 選び直すと selected', a10.sync, 'selected');
  eq('新しいソースの版 = 試験が読んだ新しい内容の sha1', a10.sourceRev, sha1rev(read(CARD)));
  ok('前の版とは違う版・別の対象', a10.sourceRev !== a1.sourceRev && a10.targetId !== a2.targetId);
  ok('E21-12: Desktop の文書の取り直しは自分のもの（出した文書で区別）・文書は照合済み', a10.refetch === 'self' && Number(a10.refetchCount) >= 1 && a10.docLevel === 'document-identified', a10);
  await shot('03-after-rsc');

  /* ======================================================== E21-13 */
  console.log('\nE21-13 別のアートボードの RSC の取り直し');
  const dc = Number((await attrs('desktop')).refetchCount);
  const mc = Number((await attrs('mobile')).refetchCount);
  /* Mobile の文書だけで、Next のルーターに同じページの取り直し（RSC）をさせる（ページ内の遷移ではない） */
  await frame('mobile').locator('html').evaluate(() => { window.next.router.refresh(); });
  await waitBoard('mobile', `Number(d.refetchCount) === ${mc + 1}`, 20000).catch(async (e) => { note(JSON.stringify(await attrs('mobile'))); throw e; });
  await sleep(1800);
  const d13 = await attrs('desktop'); const m13 = await attrs('mobile');
  eq('Mobile だけが取り直した: Mobile の自分の取り直しが1件増える', Number(m13.refetchCount), mc + 1);
  eq('Desktop の取り直しの数は変わらない', Number(d13.refetchCount), dc);
  ok('Desktop の文書の照合は落ちない（document-identified・selected のまま）', d13.docLevel === 'document-identified' && d13.sync === 'selected', d13);

  /* ======================================================== E21-11（Client Component） */
  console.log('\nE21-11 Client Component の再描画・ソースの変更・別の要素への置き換わり');
  const btn = frame('desktop').locator('button.rounded.border');
  const b0 = await pick('desktop', btn, false);
  eq('Client Component のボタンを選ぶ', `${b0.component}:${b0.tag}:${b0.at}`, `LikeCounter:button:${locate(LIKE, 'いいね')}`);
  await toggleSelect(false);
  await btn.click();
  await frame('desktop').locator('text=いいね 1').waitFor({ timeout: 10000 });
  await sleep(3500);
  const b1 = await attrs('desktop');
  eq('ソースを変えない再描画（状態の更新）では選択は失効しない', `${b1.sync}:${b1.targetId}`, `selected:${b0.targetId}`);
  write(LIKE, LIKE_SRC.replace('いいね {n}', 'Like {n}'));
  await frame('desktop').locator('text=Like').first().waitFor({ timeout: 60000 });
  await waitBoard('desktop', "d.sync === 'stale'", 20000);
  ok('Client Component のソースが変わると失効（HMR の通常の再描画を自分の適用と混同して引き継がない）', (await attrs('desktop')).reselect === 'yes');
  await toggleSelect(true);
  const b2 = await pick('desktop', btn, false);
  ok('選び直すと新しい版で selected', b2.sync === 'selected' && b2.sourceRev === sha1rev(read(LIKE)), b2);
  write(LIKE, LIKE_SRC.replace('      <button type="button" className="rounded border px-2" onClick={() => setN(n + 1)}>いいね {n}</button>', '      <span className="text-xs">固定 {n}</span>'));
  await frame('desktop').locator('text=固定').waitFor({ timeout: 60000 });
  await waitBoard('desktop', "d.sync === 'stale'", 20000);
  const b3 = await attrs('desktop');
  ok('同じ行・列に別の要素（span）が来た: 前の要素（button）を維持しない', b3.sync === 'stale' && b3.reselect === 'yes', b3);
  const b4 = await pick('desktop', frame('desktop').locator('span.text-xs'), false);
  ok('選び直すと、いまの要素（span）として解決する', b4.sync === 'selected' && b4.tag === 'span' && b4.at === b0.at && b4.fingerprint !== b2.fingerprint, b4);

  /* ======================================================== E21-06 / E21-07 / E21-08 */
  console.log('\nE21-06・07・08 古い MessagePort・nonce・起動の不一致');
  const st6 = await state();
  const deskReg = st6.connections.desktop;
  const run = st6.run;
  const rejBefore = Number((await attrs('desktop')).rejected);
  const forged = await page.evaluate(() => {
    /* いまの Desktop の接続の port に、nonce の違う偽の観測を差し込む（画面の受け口だけを通る） */
    const n = window.__ports.length;
    for (const p of window.__ports) p.dispatchEvent(new MessageEvent('message', { data: { source: 'vcide-preview', v: 3, kind: 'edit-observation', ev: 1, nonce: 'nonce-forgedforgedforged', req: 1, state: 'none', selection: null, rect: null, style: null, doc: null, soft: false, rsc: { started: 0, settled: 0 }, vw: 1440, vh: 900 } }));
    return n;
  });
  await sleep(300);
  ok('E21-07: nonce の違う知らせは捨てる（拒否の数が増え、選択は変わらない）', Number((await attrs('desktop')).rejected) > rejBefore && (await attrs('desktop')).sync === 'selected', { forged, rej: (await attrs('desktop')).rejected });
  const oldConn = deskReg.conn;
  const portsBefore = await page.evaluate(() => window.__ports.length);
  await page.locator('[data-edit-reload="desktop"]').click();
  await waitBoard('desktop', `d.connState === 'connected' && d.connection === 'identified' && d.connId !== ${JSON.stringify((await attrs('desktop')).connId)}`, 60000);
  const rej6 = Number((await attrs('desktop')).rejected);
  await page.evaluate((k) => {
    /* 読み込み直す前の文書の port（古い MessagePort）に、形の正しい観測を差し込む */
    for (const p of window.__ports.slice(0, k)) p.dispatchEvent(new MessageEvent('message', { data: { source: 'vcide-preview', v: 3, kind: 'select', nonce: 'x', seq: 1 } }));
  }, portsBefore);
  await sleep(300);
  ok('E21-06: 古い MessagePort からの知らせは受けない（選択を作らない）', Number((await attrs('desktop')).rejected) >= rej6 && (await attrs('desktop')).sync !== 'selected');
  const obsBody = { state: 'none', selection: null, document: { token: deskReg.token, soft: false }, rsc: { started: 0, settled: 0 }, viewport: { width: 1440, height: 900 } };
  const r6 = await postApi('select', { ideBoot: st6.ideBoot, run, artboard: 'desktop', conn: oldConn, observation: obsBody });
  eq('E21-06: サーバーも古い接続の選択を受けない（stale-connection）', `${r6.body?.status}:${r6.body?.reason}`, 'disconnected:stale-connection');
  const r7 = await postApi('select', { ideBoot: crypto.randomBytes(16).toString('hex'), run, artboard: 'desktop', conn: oldConn, observation: obsBody });
  eq('E21-08: IDE の起動が違えば ide-restarted', r7.body?.reason, 'ide-restarted');
  const r8 = await postApi('select', { ideBoot: st6.ideBoot, run: { ...run, pid: run.pid + 100000 }, artboard: 'desktop', conn: oldConn, observation: obsBody });
  eq('E21-08: 開発サーバーの起動が違えば stale-run', r8.body?.reason, 'stale-run');

  /* ======================================================== E21-04 */
  console.log('\nE21-04 片方のページの読み込み直し');
  const d4 = await attrs('desktop'); const m4 = await attrs('mobile');
  ok('Desktop は新しい接続・前の選択は失効（再選択が必要）', d4.connId !== b4.connId && d4.sync !== 'selected' && d4.reselect === 'yes', d4);
  const st4 = await state();
  ok('Desktop は新しい文書を登録', st4.connections.desktop.token !== deskReg.token && st4.connections.desktop.conn !== oldConn, st4.connections.desktop);
  eq('Mobile の接続は変わらない', `${m4.connId}:${st4.connections.mobile.token}`, `${m13.connId}:${st6.connections.mobile.token}`);
  eq('Mobile の選択は selected のまま', `${m4.sync}:${m4.targetId}`, `selected:${mBefore.targetId}`);
  const d4b = await pick('desktop', frame('desktop').locator('div.rounded-lg.border.bg-white.p-4').nth(1));
  ok('Desktop で選び直せる（新しい文書・新しい対象）', d4b.sync === 'selected' && d4b.docToken === st4.connections.desktop.token, d4b);

  /* ======================================================== E21-14 / E21-15 / E21-16 */
  console.log('\nE21-14・15・16 文書の識別子と中継の記録・検証の報告・未確認');
  const st14 = await state();
  const now = new Date().toISOString();
  const rev = sha1rev(read(CARD));
  const art = (w, h, token, at = now) => ({ viewport: { width: w, height: h }, mode: 'measured', predictionMarkers: 0, measuredAt: at, document: { token, path: '/properties', sourceRevs: { [CARD]: rev } }, elements: [] });
  const rep = (arts) => ({ txId: 'tx-20261106000000-deadbeef', anchorId: '0123456789', file: CARD, sourceRev: rev, measuredAt: now, artboards: arts });
  const T = st14.connections;
  const good = await postApi('bind-report', { ideBoot: st14.ideBoot, report: rep([art(1440, 900, T.desktop.token), art(375, 812, T.mobile.token)]) });
  ok('E21-14: いまの2枚の文書（中継の台帳の応答）で測った報告は bound（描画は申告のまま・検証は評価しない）',
    good.body?.binding === 'bound' && good.body.render === 'declared-by-report' && good.body.verification === 'not-evaluated', good.body);
  const swap = await postApi('bind-report', { ideBoot: st14.ideBoot, report: rep([art(1440, 900, T.mobile.token), art(375, 812, T.desktop.token)]) });
  eq('E21-15: 2枚の文書を入れ替えた報告は unbound', swap.body?.binding, 'unbound');
  const old = await postApi('bind-report', { ideBoot: st14.ideBoot, report: rep([art(1440, 900, deskReg.token), art(375, 812, T.mobile.token)]) });
  eq('E21-15: 読み込み直す前の文書の報告は unbound', old.body?.binding, 'unbound');
  const fake = await postApi('bind-report', { ideBoot: st14.ideBoot, report: rep([art(1440, 900, crypto.randomBytes(16).toString('hex')), art(375, 812, T.mobile.token)]) });
  eq('E21-15: 中継が出していない識別子の報告は unbound', fake.body?.binding, 'unbound');
  const early = await postApi('bind-report', { ideBoot: st14.ideBoot, report: rep([art(1440, 900, T.desktop.token, new Date(Date.now() - 3600_000).toISOString()), art(375, 812, T.mobile.token)]) });
  eq('E21-15: 文書を表示する前の時刻の報告は unbound', early.body?.binding, 'unbound');
  /* E21-16: どの文書が出したか分からない RSC（中継に直接。文書の識別子を名乗らない） */
  await new Promise((res) => { http.get({ host: '127.0.0.1', port: GW_PORT, path: '/properties?_rsc=e21', headers: { rsc: '1' } }, (r) => { r.resume(); r.on('end', res); }).on('error', res); });
  await waitBoard('desktop', "d.docLevel === 'unverified'", 20000);
  await waitBoard('mobile', "d.docLevel === 'unverified'", 20000).catch(() => {});   // 画面の再照合は 1.5 秒ごと。待っても変わらなければ下で失敗にする
  const d16 = await attrs('desktop'); const m16 = await attrs('mobile');
  ok('E21-16: 出した文書の分からない取り直しの後、文書の照合は未確認（rsc-unattributed）', d16.docLevel === 'unverified' && d16.docReasons.includes('rsc-unattributed'), d16);
  ok('（同）Mobile も未確認（どちらを描き直したか決めない）', m16.docLevel === 'unverified', m16);
  ok('画面は「未確認」と書き、verified と書かない', (await page.locator(B('desktop')).innerText()).includes('未確認') && !/verified/.test(await page.locator(B('desktop')).innerText().then((t) => t.replace(/not-verified|unverified/g, ''))));
  const bound16 = await postApi('bind-report', { ideBoot: st14.ideBoot, report: rep([art(1440, 900, T.desktop.token, new Date().toISOString()), art(375, 812, T.mobile.token, new Date().toISOString())]) });
  eq('（同）その後の報告は unbound（文書の照合が未確認）', bound16.body?.binding, 'unbound');
  await shot('04-unverified');

  /* ======================================================== E21-05・ページ遷移 */
  console.log('\nE21-05 両方の読み込み直し・ページ遷移');
  const before5 = await state();
  await panel().locator('[data-edit-path]').fill('/');
  await panel().locator('[data-edit-go]').click();
  await waitBoard('desktop', `d.connState === 'connected' && d.connection === 'identified' && d.connId !== ${JSON.stringify(d16.connId)}`, 60000);
  await waitBoard('mobile', `d.connState === 'connected' && d.connection === 'identified' && d.connId !== ${JSON.stringify(m16.connId)}`, 60000);
  const st5 = await state();
  ok('両方とも新しい文書・新しい接続', st5.connections.desktop.token !== before5.connections.desktop.token && st5.connections.mobile.token !== before5.connections.mobile.token);
  const d5 = await attrs('desktop'); const m5 = await attrs('mobile');
  ok('両方とも前の選択は失効（selected でない）', d5.sync !== 'selected' && m5.sync !== 'selected', [d5.sync, m5.sync]);
  const l5 = await pick('desktop', frame('desktop').locator('a.underline'), false);
  eq('遷移先（/）のページの要素を選べる', l5.at, locate('src/app/page.tsx', '<a className="underline"'));
  eq('新しい文書は照合済み（取り直しなし）', `${l5.docLevel}:${l5.refetch}`, 'document-identified:none');
  await toggleSelect(false);
  const conn5 = (await attrs('desktop')).connId;
  await frame('desktop').locator('a.underline').click();
  await waitBoard('desktop', `d.connState === 'connected' && d.connection === 'identified' && d.connId !== ${JSON.stringify(conn5)}`, 60000);
  ok('ページ内のリンクでの遷移（新しい文書）: 前の選択は失効し、新しい接続', (await attrs('desktop')).sync !== 'selected');
  eq('（同）Mobile は / のまま変わらない', await frame('mobile').locator('html').evaluate(() => location.pathname), '/');

  /* ======================================================== 停止・再起動 */
  console.log('\n停止・再起動');
  const run1 = (await state()).run;
  await rtPanel().locator('.rt-b', { hasText: '停止する' }).click();
  await page.waitForFunction(() => document.querySelector('section[data-edit-sync-dev]')?.getAttribute('data-edit-sync-dev') === 'waiting', null, { timeout: 60000 });
  ok('停止すると、アートボードを外して待機に戻る（前の起動の選択を表示しない）', (await page.locator('[data-edit-board]').count()) === 0);
  await page.waitForFunction(() => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-st')?.classList.contains('stopped'), null, { timeout: 60000 });
  await rtPanel().locator('button.rt-b.go', { hasText: '起動する' }).click();
  await page.waitForFunction(() => document.querySelector('section[data-edit-sync-dev]')?.getAttribute('data-edit-sync-dev') === 'on', null, { timeout: 240000 });
  await connected('desktop'); await connected('mobile');
  const st9 = await state();
  ok('再起動の後は新しい起動', st9.run && (st9.run.pid !== run1.pid || st9.run.startedAt !== run1.startedAt), [run1, st9.run]);
  const d9b = await attrs('desktop');
  ok('再起動の後は前の選択を持たない', d9b.sync !== 'selected', d9b.sync);
  const r9 = await postApi('select', { ideBoot: st9.ideBoot, run: run1, artboard: 'desktop', conn: st9.connections.desktop.conn, observation: { ...obsBody, document: { token: st9.connections.desktop.token, soft: false } } });
  eq('前の起動を指す要求は stale-run', r9.body?.reason, 'stale-run');
  await toggleSelect(true);
  const s9 = await pick('desktop', frame('desktop').locator('a.underline'), false);
  eq('再起動の後も、実プレビューから正しいソース位置へ結び付く', s9.at, locate('src/app/page.tsx', '<a className="underline"'));
  await shot('05-restarted');

  /* ======================================================== E21-18・E21-19 */
  console.log('\nE21-18・E21-19 書き込みの道が無い・探索のプレビューは今までどおり');
  for (const op of ['apply', 'revert', 'draft', 'recover', 'verify']) {
    const r = await postApi(op, {});
    eq(`POST /api/edit-sync/${op} は 404`, r.status, 404);
  }
  const e404 = await page.evaluate(async () => (await fetch('/api/edit/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: '{}' })).status);
  eq('POST /api/edit/apply は 404', e404, 404);
  eq('IDE は記録を変えていない（最後まで自動の復旧・削除なし）', jsnap(), journalBefore);
  const pv = page.locator('section[aria-label="プレビュー"] .pvlive');
  ok('探索のプレビューも同時に実ページを表示している', (await pv.getAttribute('data-preview-state')) === 'live');
  await page.waitForFunction(() => Number(document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-conn')) >= 1, null, { timeout: 60000 });
  await pv.locator('.rt-b', { hasText: '選択' }).click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-agent-mode') === 'on', null, { timeout: 15000 });
  await page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe').locator('a.underline').click();
  await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-selection') === 'resolved', null, { timeout: 30000 });
  eq('E21-19: 探索の選択は今までどおり（同じソース位置へ resolved）', await pv.getAttribute('data-sel-at'), locate('src/app/page.tsx', '<a className="underline"'));
  ok('IDE の画面にエラーが出ていない', ideErrors.length === 0, ideErrors);
}

try {
  await main();
} catch (e) {
  ok('試験の本体が最後まで進む', false, String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  note(`状態: ${JSON.stringify(await page.evaluate(async () => (await fetch('/api/runtime/status')).json()).catch((x) => String(x))).slice(0, 1500)}`);
  await shot('zz-failure').catch(() => {});
} finally {
  /* IDE の API で開発サーバーを止めてから IDE を止める（台帳を残して次の IDE に引き継がせない） */
  await page.evaluate(async () => {
    await fetch('/api/runtime/stop', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: '{}' });
    for (let i = 0; i < 60; i++) { const s = await (await fetch('/api/runtime/status')).json(); if (s.runtime?.state !== 'running' && s.runtime?.state !== 'stopping') break; await new Promise((r) => setTimeout(r, 500)); }
  }).catch(() => {});
  await browser.close().catch(() => {});
  killIde();
}
ok('元の題材（poc/fixture-edit/src）は1バイトも変わらない', sameSnapshot(fixtureBefore, snapshot(path.join(FIXTURE_EDIT, 'src'))));
fs.rmSync(JDIR, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
C.finish();
