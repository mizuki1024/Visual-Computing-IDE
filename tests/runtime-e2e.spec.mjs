/* =============================================================================
 * Phase 7A — 完了条件の体験を、実ブラウザから端から端まで確かめる。
 *   node tests/runtime-e2e.spec.mjs
 *   BASE=http://127.0.0.1:3101 VCIDE_E2E_PROJECT=/Users/me/my-app node tests/runtime-e2e.spec.mjs
 *
 * 「IDE を開く → Next.js プロジェクトを指定する → 起動する → 起動状態を確認する
 *   → 停止する」が、固定デモではなく実際のローカルプロジェクトで動くこと。
 *
 * 画面の操作だけで行う。API を直接叩かない。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const REPO = path.resolve(import.meta.dirname, '..');
const PROJECT = process.env.VCIDE_E2E_PROJECT ?? path.join(REPO, 'poc', 'fixture-app');
const SHOTS = process.env.SHOTS ?? null;

let pass = 0;
const fails = [];
const skips = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);
const skip = (name, why) => { skips.push(`${name} — ${why}`); console.log(`  ⊘ ${name} — ${why}（skip）`); };

if (!fs.existsSync(path.join(PROJECT, 'node_modules', 'next', 'dist', 'bin', 'next'))) {
  console.log(`\n⊘ ${PROJECT} に next がインストールされていないため、全件 skip`);
  process.exit(0);
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) pageErrors.push(m.text()); });

const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const panel = () => page.locator('.fpnl[aria-label="プロジェクトと実行"]');
const stateText = () => panel().locator('.rt-st b').innerText();
const waitState = async (text, timeout = 200000) => {
  await page.locator('.rt-st b', { hasText: text }).first().waitFor({ state: 'visible', timeout });
};
const aliveNow = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const groupMembers = (pgid) => execFileSync('ps', ['-ax', '-o', 'pid=,pgid='], { encoding: 'utf8' })
  .split('\n').map((l) => /^\s*(\d+)\s+(\d+)/.exec(l)).filter(Boolean)
  .filter((m) => +m[2] === pgid).length;

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

/* --------------------------------------------------- 1. IDE を開いた直後 */
console.log('\n1. IDE を開く');
eq('Phase 5 の確定 UI が出ている（N0 / キャンバス / 右ドック）',
  await page.locator('.n0').count() + await page.locator('.canvas').count() + await page.locator('.dock').count(), 3);
eq('「プロジェクトと実行」のパネルが出ている', await panel().count(), 1);
eq('最初は未起動', await stateText(), '未起動');
eq('N0 は「記録」であることを明示している（実プロセスの状態と混ぜない）',
  (await page.locator('.n0 .chipbar').nth(1).innerText()).startsWith('記録'), true);
eq('起動ボタンは押せない（まだ検出していない）',
  await panel().locator('.rt-b.go.off').count(), 1);
eq('停止ボタンも押せない', await panel().locator('.rt-b.off', { hasText: '停止する' }).count(), 1);
await shot('01-open');

/* ------------------------------------------- 2. 不正なパス / 対応外の構成 */
console.log('\n2. 指定が不正・対応外なら理由が出る');
const typePath = async (p) => {
  await panel().locator('#rt-path').fill(p);
  await panel().locator('.rt-b', { hasText: '検出' }).click();
  await panel().locator('.rt-vd').first().waitFor({ state: 'visible', timeout: 15000 });
};
await typePath('relative/path');
eq('相対パスは「指定が不正」', await panel().locator('.rt-vd').innerText(), '指定が不正');
ok('理由が読める', (await panel().locator('.rt-card b').first().innerText()).includes('絶対パス'),
  await panel().locator('.rt-card b').first().innerText());
eq('起動ボタンは押せないまま', await panel().locator('.rt-b.go.off').count(), 1);
await shot('02-invalid-path');

await typePath('/no/such/project-7a');
eq('存在しないパスも「指定が不正」', await panel().locator('.rt-vd').innerText(), '指定が不正');
ok('わからないことを書いている（③ を省略しない）',
  (await panel().locator('.rt-card p.imp').first().innerText()).length > 0);

if (fs.existsSync('/Users/mizuki/portfolio-site-1/src/pages')) {
  await typePath('/Users/mizuki/portfolio-site-1');
  eq('Pages Router だけのプロジェクトは「未対応」', await panel().locator('.rt-vd').innerText(), '未対応');
  ok('検出した構成名が具体的に出る',
    (await panel().locator('.rt-card b').first().innerText()).includes('src/pages'),
    await panel().locator('.rt-card b').first().innerText());
  await shot('03-unsupported');
} else {
  skip('Pages Router だけのプロジェクトの表示', 'この環境に題材が無い');
}

/* ----------------------------------------------- 3. 実在のプロジェクトを指定 */
console.log('\n3. Next.js プロジェクトを指定する');
await typePath(PROJECT);
const verdict = await panel().locator('.rt-vd').innerText();
ok(`判定は「${verdict}」（対応 または 部分対応）`, ['対応', '部分対応'].includes(verdict), verdict);
const dd = await panel().locator('.rt-ins .rt-dl dd').allInnerTexts();
eq('検出したルートを表示する', dd[0], PROJECT);
ok('Next のバージョンを実体から読んで表示する', /^\d+\.\d+/.test(dd[1]), dd[1]);
ok('App Router のディレクトリを表示する', /app$/.test(dd[2].split(' ')[0]), dd[2]);
ok('依存がインストール済みであることを表示する', dd[3].startsWith('インストール済み'), dd[3]);
eq('起動ボタンが押せるようになる', await panel().locator('.rt-b.go:not(.off)').count(), 1);
await shot('04-detected');

/* ------------------------------------------------------- 4. 起動する */
console.log('\n4. 起動する');
await panel().locator('.rt-b.go', { hasText: '起動する' }).click();
await page.waitForTimeout(400);
const during = await stateText();
ok(`起動中は「${during}」であって「実行中」ではない`, during !== '実行中', during);
await shot('05-starting');
await waitState('実行中');
eq('状態は「実行中」', await stateText(), '実行中');

const runDd = await panel().locator('.rt-run dd').allInnerTexts();
eq('起動元は IDE', runDd[0], 'IDE');
ok(`計装は「${runDd[1]}」`, runDd[1].length > 0, runDd[1]);
ok('HTTP の応答を観測したことを表示する', runDd[2].startsWith('応答あり'), runDd[2]);
const pidText = await panel().locator('.rt-st .rt-k').first().innerText();
const pid = Number(/\d+/.exec(pidText)[0]);
ok(`PID ${pid} を表示し、そのプロセスは生きている`, aliveNow(pid), pidText);
const url = await panel().locator('.rt-run .rt-a').innerText();
ok(`URL を表示する（${url}）`, /^http:\/\/127\.0\.0\.1:\d+$/.test(url), url);
ok('N0 も実プロセスの状態に変わる',
  (await page.locator('.n0 .chipbar').nth(1).innerText()).includes('実行中'),
  await page.locator('.n0 .chipbar').nth(1).innerText());
ok('N0 に計装の状態が常時出ている（ST-26）',
  (await page.locator('.n0 .chipbar').nth(2).innerText()).includes('計装'),
  await page.locator('.n0 .chipbar').nth(2).innerText());
await shot('06-running');

console.log('\n5. 起動状態を確認する');
{
  const tab = await browser.newPage();
  const res = await tab.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => e);
  ok('別のタブから、起動したプロジェクトが実際に応答する',
    res && typeof res.status === 'function', String(res));
  if (res && typeof res.status === 'function') ok(`状態コード ${res.status()}`, true);
  if (SHOTS) await tab.screenshot({ path: path.join(SHOTS, '07-target-app.png') });
  await tab.close();
}
{
  await panel().locator('.rt-more').click();
  await page.waitForTimeout(400);
  const lines = await panel().locator('.rt-log div').allInnerTexts();
  ok('標準出力・エラー出力を画面で確認できる', lines.length > 0, lines.length);
  ok('Next の起動ログが読める', lines.join('\n').includes('Next.js'), lines.slice(0, 2));
  ok('資格情報つき URL が素で出ていない', !/:\/\/[^\s/@:]+:[^\s/@]+@/.test(lines.join('\n')));
  await shot('08-logs');
  await panel().locator('.rt-more').click();
}
{
  await panel().locator('.rt-b.go.off, .rt-b.go').first().hover();
  const blocked = await panel().locator('.rt-b.go.off').count();
  eq('実行中は起動ボタンが押せない（二重起動の防止が画面に出ている）', blocked, 1);
}

/* ------------------------------------------------------- 6. 停止する */
console.log('\n6. 停止する');
await panel().locator('.rt-b', { hasText: '停止する' }).click();
await waitState('停止しています', 40000);
eq('状態は「停止しています」', await stateText(), '停止しています');
eq('プロセスは消えた', aliveNow(pid), false);
eq('同じプロセスグループに誰も残っていない', groupMembers(pid), 0);
{
  const r = await fetch(url).catch(() => null);
  eq('停止後は HTTP も応答しない', r, null);
}
ok('N0 も「記録」の表示に戻る',
  (await page.locator('.n0 .chipbar').nth(1).innerText()).startsWith('記録')
  || (await page.locator('.n0 .chipbar').nth(1).innerText()).includes('停止'),
  await page.locator('.n0 .chipbar').nth(1).innerText());
await shot('09-stopped');

console.log('\n7. 停止後に再起動できる');
await panel().locator('.rt-b.go', { hasText: '起動する' }).click();
await waitState('実行中');
const pid2 = Number(/\d+/.exec(await panel().locator('.rt-st .rt-k').first().innerText())[0]);
ok('新しい PID で実行中になる', pid2 !== pid && aliveNow(pid2), { pid, pid2 });
await panel().locator('.rt-b', { hasText: '停止する' }).click();
await waitState('停止しています', 40000);
eq('もう一度止められる', aliveNow(pid2), false);
eq('最後にプロセスが残っていない', groupMembers(pid2), 0);

eq('JS エラーなし', pageErrors.length, 0);
if (pageErrors.length) console.log(pageErrors);

await browser.close();
console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗${skips.length ? ` / ${skips.length} 件 skip` : ''}`);
if (skips.length) for (const s of skips) console.log(`  ⊘ ${s}`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
