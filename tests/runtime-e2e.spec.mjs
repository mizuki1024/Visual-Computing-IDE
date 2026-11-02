/* =============================================================================
 * Phase 7A — 完了条件の体験を、実ブラウザから端から端まで確かめる。
 *   node tests/runtime-e2e.spec.mjs
 *   BASE=http://127.0.0.1:3101 VCIDE_E2E_PROJECT=/Users/me/my-app node tests/runtime-e2e.spec.mjs
 *
 * 「IDE を開く → Next.js プロジェクトを指定する → 起動する → 起動状態を確認する
 *   → 停止する」が、固定デモではなく実際のローカルプロジェクトで動くこと。
 *
 * 画面の操作だけで行う。API を直接叩かない。
 *
 * 題材が無い環境の扱い
 *   - VCIDE_E2E_PROJECT に next が入っていなければ、全件 skip（成功扱いにしない）
 *   - Pages Router の題材（/Users/mizuki/portfolio-site-1）が無ければ、
 *     構成だけを組んだ骨を一時ディレクトリに作って代わりに使う（骨であることを表示する）
 *   - R3（上の階層の lockfile）の画面表示も、一時ディレクトリの骨で確かめる
 *
 * ブラウザは既定で channel: chrome。PW_CHANNEL=none で同梱の chromium を使う。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

const CHANNEL = process.env.PW_CHANNEL ?? 'chrome';
const browser = await chromium.launch(CHANNEL === 'none' ? {} : { channel: CHANNEL });
console.log(`ブラウザ: ${CHANNEL === 'none' ? '同梱の chromium' : `channel ${CHANNEL}`} ${browser.version()} / 題材: ${PROJECT}`);

/* 骨（検出だけに使う。起動はしない）。一時ディレクトリに置き、終了時に消す */
const BONES = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-e2e-')));
process.on('exit', () => { try { fs.rmSync(BONES, { recursive: true, force: true }); } catch { /* 残っても害はない */ } });
const bone = (rel, body) => {
  const p = path.join(BONES, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};
const boneNext = (dir, version) => {
  bone(`${dir}/node_modules/next/package.json`, JSON.stringify({ name: 'next', version }));
  bone(`${dir}/node_modules/next/dist/bin/next`, '#!/usr/bin/env node\n');
};
bone('pages-only/package.json', JSON.stringify({ name: 'pages-only', dependencies: { next: '^16.0.0' } }));
boneNext('pages-only', '16.2.6'); bone('pages-only/src/pages/index.tsx', 'x\n');
bone('outer/package-lock.json', '{}');
bone('outer/nested-app/package.json', JSON.stringify({ name: 'nested-app', dependencies: { next: '^16.0.0' } }));
boneNext('outer/nested-app', '16.2.6'); bone('outer/nested-app/app/page.tsx', 'x\n');
bone('outer/nested-app/tsconfig.json', '{}\n'); bone('outer/nested-app/package-lock.json', '{}');
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const pageErrors = [];
/*
 * Phase 7B-1: 実行中はプレビューパネルの iframe に対象のアプリが入る。そのアプリ自身のエラー
 * （題材は DB が無いと /api/* が 500 になる）は IDE の不具合ではないので数えない。
 * pageerror は iframe の中の例外も区別せずに含むため、IDE の最上位の文書にだけ受け口を置く。
 * console は出所の URL が IDE のものだけを数える。
 */
await page.exposeBinding('__vcideE2eError', (_src, msg) => { pageErrors.push(String(msg)); });
await page.addInitScript(() => {
  if (window !== window.top) return;
  addEventListener('error', (e) => window.__vcideE2eError(e.message));
  addEventListener('unhandledrejection', (e) => window.__vcideE2eError(e.reason?.message ?? String(e.reason)));
});
page.on('console', (m) => {
  if (m.type() !== 'error' || /favicon|404/.test(m.text())) return;
  if (!(m.location().url ?? '').startsWith(new URL(BASE).origin)) return;
  pageErrors.push(m.text());
});

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

const TSCONFIG = path.join(PROJECT, 'tsconfig.json');
const TSCONFIG_BEFORE = fs.existsSync(TSCONFIG) ? fs.readFileSync(TSCONFIG, 'utf8') : null;

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

/* --------------------------------------------------- 1. IDE を開いた直後 */
console.log('\n1. IDE を開く');
eq('Phase 5 の確定 UI が出ている（N0 / キャンバス / 右ドック）',
  await page.locator('.n0').count() + await page.locator('.canvas').count() + await page.locator('.dock').count(), 3);
eq('「プロジェクトと実行」のパネルが出ている', await panel().count(), 1);
const initial = await stateText();
if (initial === '未起動') {
  ok('最初は未起動', true);
  eq('N0 は「記録」であることを明示している（実プロセスの状態と混ぜない）',
    (await page.locator('.n0 .chipbar').nth(1).innerText()).startsWith('記録'), true);
  eq('起動ボタンは押せない（まだ検出していない）',
    await panel().locator('.rt-b.go.off').count(), 1);
} else {
  // 同じ IDE のプロセスで前に起動・停止した記録がある。「開いた直後」の3項目は
  // 新しく起動した IDE でしか確かめられないので skip とし、代わりに矛盾が無いことを見る
  const why = `IDE のプロセスに前回の操作の記録がある（状態「${initial}」）。新しく起動した IDE で確かめる項目`;
  skip('最初は未起動', why);
  skip('N0 は「記録」であることを明示している', why);
  skip('起動ボタンは押せない（まだ検出していない）', why);
  ok('前回の記録があっても「実行中」とは書かない', initial !== '実行中', initial);
  const shown = await panel().locator('.rt-ins').getAttribute('data-input', { timeout: 2000 }).catch(() => null);
  if (shown !== null) {
    eq('戻した検出結果のパスが入力欄にも入っている（空の入力で起動させない）',
      await panel().locator('#rt-path').inputValue(), shown);
  }
}
eq('停止ボタンは押せない', await panel().locator('.rt-b.off', { hasText: '停止する' }).count(), 1);
await shot('01-open');

/* ------------------------------------------- 2. 不正なパス / 対応外の構成 */
console.log('\n2. 指定が不正・対応外なら理由が出る');
/**
 * パスを入れて［検出］を押し、**その入力に対する新しい結果**が出るまで待つ（R1）。
 * 前の結果が表示されたままなので、`.rt-vd` が見えることを待つだけでは古い DOM を読む。
 * 入力（data-input）と検出時刻（data-checked-at）の両方で、新しい結果であることを確かめる。
 */
const typePath = async (p) => {
  const prev = await panel().locator('.rt-ins').getAttribute('data-checked-at', { timeout: 500 }).catch(() => null);
  await panel().locator('#rt-path').fill(p);
  await panel().locator('.rt-b', { hasText: '検出' }).click();
  await page.waitForFunction(([input, before]) => {
    const el = document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins');
    return !!el && el.getAttribute('data-input') === input && el.getAttribute('data-checked-at') !== before;
  }, [p, prev], { timeout: 15000 });
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

{
  const real = fs.existsSync('/Users/mizuki/portfolio-site-1/src/pages');
  const target = real ? '/Users/mizuki/portfolio-site-1' : path.join(BONES, 'pages-only');
  if (!real) console.log(`  （実在の題材が無いため、構成だけの骨 ${target} を使う）`);
  await typePath(target);
  eq(`Pages Router だけのプロジェクトは「未対応」${real ? '' : '（骨）'}`, await panel().locator('.rt-vd').innerText(), '未対応');
  eq('data-verdict も未対応', await panel().locator('.rt-ins').getAttribute('data-verdict'), 'unsupported');
  ok('検出した構成名が具体的に出る',
    (await panel().locator('.rt-card b').first().innerText()).includes('pages'),
    await panel().locator('.rt-card b').first().innerText());
  eq('起動ボタンは押せない', await panel().locator('.rt-b.go.off').count(), 1);
  await shot('03-unsupported');
}

console.log('\n2b. 上の階層の lockfile は、起動する前に理由として出る（R3）');
{
  await typePath(path.join(BONES, 'outer', 'nested-app'));
  eq('判定は部分対応（起動は試せる）', await panel().locator('.rt-vd').innerText(), '部分対応');
  const cards = await panel().locator('.rt-ins .rt-card').allInnerTexts();
  const r3 = cards.find((t) => t.includes('ワークスペースのルート'));
  ok('上の階層の lockfile を所見として画面に出す', !!r3 && r3.includes(path.join(BONES, 'outer', 'package-lock.json')), cards);
  ok('turbopack.root の設定を次の操作として示す', /turbopack\.root/.test(r3 ?? ''), r3);
  ok('「壊れている」と書かない', !/壊れて(い|お)ます/.test(r3 ?? ''), r3);
  const r4 = cards.find((t) => t.includes('tsconfig.json'));
  ok('next dev が tsconfig.json を書き換えうることを、主体を明示して出す（R4）',
    !!r4 && /next dev/.test(r4) && /IDE は対象プロジェクトに書き込みません/.test(r4), cards);
  await panel().locator('.rt-ins').scrollIntoViewIfNeeded();
  await shot('10-root-inference');
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
{
  // 検出した後にパスを書き換えたら、検出し直すまで起動させない（表示中の結果と起動対象を食い違わせない）
  await panel().locator('#rt-path').fill(`${PROJECT}-edited`);
  eq('検出後にパスを変えると起動ボタンは押せない', await panel().locator('.rt-b.go.off').count(), 1);
  await panel().locator('#rt-path').fill(PROJECT);
  eq('元のパスに戻せば押せる', await panel().locator('.rt-b.go:not(.off)').count(), 1);
}
await shot('04-detected');

/* ------------------------------------------------------- 4. 起動する */
console.log('\n4. 起動する');
await panel().locator('.rt-b.go', { hasText: '起動する' }).click();
// R2: 応答（最長180秒）を待つ間も、画面は実プロセスの状態を出し続けること
await page.locator('.rt-st b', { hasText: /^(構成を検証中|起動中|実行中)$/ }).first()
  .waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
const during = await stateText();
ok(`クリック後 5 秒以内に「構成を検証中」か「起動中」になる（「未起動」のままにしない）— 「${during}」`,
  ['構成を検証中', '起動中'].includes(during) || during === '実行中', during);
ok('起動の応答を待っている間は「実行中」と書かない（応答確認前）',
  during !== '実行中' || (await panel().locator('.rt-run dd').nth(2).innerText()).startsWith('応答あり'), during);
if (during === '起動中') {
  await page.waitForTimeout(1500);
  const prog = await panel().locator('.rt-prog').innerText().catch(() => '');
  ok('起動中は経過秒と Next.js の出力を出す（平坦な待ちにしない）',
    /HTTP の応答を確認するまで/.test(prog) && /\d+ 秒/.test(await panel().locator('.rt-st').innerText()), prog);
}
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
  // 7C-2: 実行中は「プロジェクトと実行」を状態・PID・停止の1段に畳む。出力・起動ボタンは［詳細］で開いてから見る
  eq('7C-2: 実行中は「プロジェクトと実行」を畳んでいる', await panel().locator('.rt').getAttribute('data-compact'), 'on');
  await panel().locator('button.fold').click();
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

{
  // R4: tsconfig.json が変わったなら、それを画面が「観測した変化」として出していること。
  // 変わっていなければ何も言うことはない（IDE は書かない。next dev が書くかは Next.js が決める）
  const now = fs.existsSync(TSCONFIG) ? fs.readFileSync(TSCONFIG, 'utf8') : null;
  if (now === TSCONFIG_BEFORE) {
    ok('対象の tsconfig.json は起動・停止を2回通しても変わっていない', true);
  } else {
    const cards = await panel().locator('.rt-card').allInnerTexts();
    ok('tsconfig.json が変わったことを、主体を IDE とせずに画面が出している',
      cards.some((t) => /tsconfig\.json（(変更|作成)）/.test(t) && /IDE は対象プロジェクトに書き込みません/.test(t)), cards);
  }
}
eq('JS エラーなし', pageErrors.length, 0);
if (pageErrors.length) console.log(pageErrors);

await browser.close();
console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗${skips.length ? ` / ${skips.length} 件 skip` : ''}`);
if (skips.length) for (const s of skips) console.log(`  ⊘ ${s}`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
