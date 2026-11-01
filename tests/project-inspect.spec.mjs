/* =============================================================================
 * Phase 7A — プロジェクトの検出の検証。
 *   node tests/project-inspect.spec.mjs
 *
 * 見るのは次の点である（指示 2.A / 第5節 1〜3）。
 *   1. 正常な Next.js（App Router）プロジェクトを読める
 *   2. 不正なパスで安全に失敗する（例外を投げない・推測で埋めない）
 *   3. 対応外の構成では**理由が出る**（4要素が揃っている）
 *   4. 検出は**対象プロジェクトを書き換えない**
 *
 * 題材は2種類ある。
 *   - 実在するプロジェクト（poc/fixture-app）。依存が無い環境では skip する
 *   - 構成だけを組んだ骨（.ide-runtime/test-fixtures/ に毎回作り直す）
 * ========================================================================== */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const PI = require_('../.libjs/server/projectInspect.js');

let pass = 0;
const fails = [];
const skips = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);
const skip = (name, why) => { skips.push(`${name} — ${why}`); console.log(`  ⊘ ${name} — ${why}（skip）`); };

const REPO = path.resolve(import.meta.dirname, '..');
const FIX = path.join(REPO, '.ide-runtime', 'test-fixtures');

/* ------------------------------------------------------------- 骨を組み直す */
fs.rmSync(FIX, { recursive: true, force: true });
const mk = (rel, body) => {
  const p = path.join(FIX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
/** next を「入っていること」にする骨。検出は実体の有無だけを見る */
const stubNext = (dir, version) => {
  mk(`${dir}/node_modules/next/package.json`, JSON.stringify({ name: 'next', version }));
  mk(`${dir}/node_modules/next/dist/bin/next`, '#!/usr/bin/env node\n');
};
const pkg = (dir, o) => mk(`${dir}/package.json`, JSON.stringify(o, null, 2));

fs.mkdirSync(path.join(FIX, 'empty-dir'), { recursive: true });
mk('broken-pkg/package.json', '{ this is not json');
pkg('no-next', { name: 'no-next', dependencies: { express: '^4.0.0' } });
pkg('next-not-installed', { name: 'nni', dependencies: { next: '^16.0.0' } });
mk('next-not-installed/app/page.tsx', 'export default function P(){return null}\n');
pkg('old-next', { name: 'old', dependencies: { next: '^12.0.0' } }); stubNext('old-next', '12.3.4');
mk('old-next/app/page.tsx', 'x\n');
pkg('pages-only', { name: 'po', dependencies: { next: '^16.0.0' }, scripts: { dev: 'next dev' } });
stubNext('pages-only', '16.0.3'); mk('pages-only/src/pages/index.tsx', 'x\n');
pkg('ambiguous', { name: 'amb', dependencies: { next: '^16.0.0' } }); stubNext('ambiguous', '16.0.3');
mk('ambiguous/app/page.tsx', 'x\n'); mk('ambiguous/src/app/page.tsx', 'x\n');
pkg('both-routers', { name: 'both', dependencies: { next: '^16.0.0' }, scripts: { dev: 'next dev' } });
stubNext('both-routers', '16.2.6'); mk('both-routers/app/layout.tsx', 'x\n'); mk('both-routers/pages/old.tsx', 'x\n');
pkg('unverified', { name: 'unv', dependencies: { next: '^14.0.0' }, scripts: { dev: 'next dev' } });
stubNext('unverified', '14.2.15'); mk('unverified/src/app/layout.tsx', 'x\n');
pkg('good-stub', { name: 'good-stub', dependencies: { next: '^16.0.0' }, scripts: { dev: 'next dev --turbopack' } });
stubNext('good-stub', '16.4.3'); mk('good-stub/src/app/layout.tsx', 'x\n');
mk('good-stub/package-lock.json', '{}');
mk('a-file.txt', 'not a directory\n');

const INS = PI.checkInstrumentation();
/** 計装が使えない環境では「部分対応」になる。環境差を期待値に混ぜない */
const expectedGoodVerdict = INS.available ? 'supported' : 'partial';

const codes = (r) => r.findings.map((f) => f.code);
const has = (r, code) => codes(r).includes(code);

/* ====================================================== 1. 正常なプロジェクト */
console.log('\n1. 正常な Next.js（App Router）プロジェクトを読める');
{
  const r = await PI.inspectProject(path.join(FIX, 'good-stub'));
  eq('判定が対応（計装が使える環境）', r.verdict, expectedGoodVerdict);
  eq('ルートを正規化した絶対パスで持つ', r.root, path.join(FIX, 'good-stub'));
  eq('プロジェクト名は package.json の name', r.name, 'good-stub');
  eq('インストールされている Next のバージョンを読む', r.next.installed, '16.4.3');
  eq('宣言されているバージョンも持つ', r.next.declared, '^16.0.0');
  eq('App Router のディレクトリを特定する', r.router.appDir, 'src/app');
  eq('ルーター種別は app', r.router.kind, 'app');
  eq('Pages Router は無い', r.router.pagesDir, null);
  eq('依存はインストール済み', r.nodeModulesInstalled, true);
  eq('起動する実体のパスを持つ', r.next.binPath, path.join(FIX, 'good-stub', 'node_modules/next/dist/bin/next'));
  eq('パッケージマネージャを lockfile から判定する', r.packageManager, 'npm');
  eq('dev スクリプトは読むが、使わないと明記する', r.devScript, 'next dev --turbopack');
  ok('dev スクリプトを実行しないことを所見に出す', has(r, 'dev-script-not-used'), codes(r));
  eq('起動してよい構成である', PI.isStartable(r), true);
  ok('検出時刻を持つ', typeof r.checkedAt === 'string' && r.checkedAt.includes('T'), r.checkedAt);
}
{
  const r = await PI.inspectProject(path.join(FIX, 'both-routers'));
  eq('app/ 直下の構成も読める', r.router.appDir, 'app');
  eq('Pages Router が同居していれば kind は both', r.router.kind, 'both');
  ok('同居は「限定」として所見に出る', has(r, 'pages-router-present'), codes(r));
  eq('同居していても起動はできる', PI.isStartable(r), true);
  eq('判定は部分対応', r.verdict, 'partial');
}
{
  const r = await PI.inspectProject(path.join(FIX, 'unverified'));
  ok('検証していないバージョンは「未検証」と書く', has(r, 'next-version-unverified'), codes(r));
  eq('未検証でも起動は試せる', PI.isStartable(r), true);
  eq('ただし判定は部分対応', r.verdict, 'partial');
  ok('「対応している」と書いていない',
    !r.findings.some((f) => /対応しています/.test(f.fact + f.reason)), codes(r));
}

/* ----------------------------------------------- 実在するプロジェクトで確認 */
console.log('\n1b. 実在するプロジェクト（poc/fixture-app）');
const APP = path.join(REPO, 'poc', 'fixture-app');
if (!fs.existsSync(path.join(APP, 'node_modules', 'next', 'dist', 'bin', 'next'))) {
  skip('実在するプロジェクトの検出', 'poc/fixture-app に依存がインストールされていない');
} else {
  const before = fs.readdirSync(APP).sort().join(',');
  const r = await PI.inspectProject(APP);
  ok('起動してよい構成として判定する', PI.isStartable(r), { verdict: r.verdict, codes: codes(r) });
  eq('App Router を src/app として検出する', r.router.appDir, 'src/app');
  ok('Next のバージョンを実体から読む', /^\d+\./.test(r.next.installed ?? ''), r.next.installed);
  eq('検出でプロジェクトの中身を変えない', fs.readdirSync(APP).sort().join(','), before);
}

/* ============================================== 2. 不正なパスで安全に失敗する */
console.log('\n2. 不正なパスで安全に失敗する');
for (const [label, input, code] of [
  ['空文字', '', 'path-empty'],
  ['空白だけ', '   ', 'path-empty'],
  ['相対パス', 'some/relative/path', 'path-not-absolute'],
  ['存在しないパス', '/no/such/directory/xyz-7a', 'path-not-found'],
  ['ディレクトリでない', path.join(FIX, 'a-file.txt'), 'path-not-directory'],
  ['package.json が無い', path.join(FIX, 'empty-dir'), 'no-package-json'],
  ['package.json が壊れている', path.join(FIX, 'broken-pkg'), 'invalid-package-json'],
]) {
  const r = await PI.inspectProject(input);
  eq(`${label} → ${code}`, r.findings[0]?.code, r.findings[0]?.code === code ? code : codes(r));
  eq(`${label} → 起動しない`, PI.isStartable(r), false);
  eq(`${label} → 入力をそのまま保持する`, r.input, input);
}
{
  const r = await PI.inspectProject('/no/such/directory/xyz-7a');
  eq('存在しないパスは invalid 判定', r.verdict, 'invalid');
  eq('ルートは null（推測で埋めない）', r.root, null);
}
{
  // ~ の展開。ホームそのものは Next プロジェクトではないはずなので、
  // 「展開された結果で判定している」ことだけを見る
  const r = await PI.inspectProject('~');
  eq('~ はホームに展開される', r.root, os.homedir().replace(/\/+$/, ''));
}
{
  const n = PI.normalizeInput('/tmp/x/');
  eq('末尾のスラッシュを落とす', n.root, '/tmp/x');
  eq('ルートだけは残す', PI.normalizeInput('/').root, '/');
  eq('NUL 文字は不正として扱う', PI.normalizeInput('/tmp/\0x').code, 'path-invalid');
}
ok('検出は例外を投げない（上の全件が戻り値で返っている）', true);

/* ========================================== 3. 対応外の構成では理由が出る */
console.log('\n3. 対応外の構成では理由が出る');
for (const [label, dir, code] of [
  ['next が宣言されていない', 'no-next', 'next-not-declared'],
  ['next が未インストール', 'next-not-installed', 'next-not-installed'],
  ['App Router が無い世代', 'old-next', 'next-version-unsupported'],
  ['Pages Router だけ', 'pages-only', 'pages-router-only'],
  ['app/ と src/app/ の両方', 'ambiguous', 'app-router-ambiguous'],
]) {
  const r = await PI.inspectProject(path.join(FIX, dir));
  eq(`${label} → ${code}`, r.findings[0]?.code, r.findings[0]?.code === code ? code : codes(r));
  eq(`${label} → 判定は未対応`, r.verdict, 'unsupported');
  eq(`${label} → 起動させない`, PI.isStartable(r), false);
}
{
  const r = await PI.inspectProject(path.join(FIX, 'pages-only'));
  const f = r.findings[0];
  ok('理由に検出した構成名が具体的に出る（E-07）', /src\/pages/.test(f.fact), f.fact);
  ok('「今後対応予定」と書いていない', !/予定/.test(f.fact + f.reason + f.impact), f);
}

console.log('\n4. すべての所見が 03d 1.1節の4要素を満たす');
{
  const all = [];
  for (const d of ['good-stub', 'both-routers', 'unverified', 'no-next', 'next-not-installed',
    'old-next', 'pages-only', 'ambiguous', 'empty-dir', 'broken-pkg']) {
    const r = await PI.inspectProject(path.join(FIX, d));
    all.push(...r.findings);
  }
  for (const r of [await PI.inspectProject(''), await PI.inspectProject('rel'),
    await PI.inspectProject('/no/such/dir-7a')]) all.push(...r.findings);
  ok(`所見を ${all.length} 件集めた`, all.length > 0, all.length);
  ok('① 事実が空でない', all.every((f) => f.fact.trim().length > 0));
  ok('② 理由が空でない', all.every((f) => f.reason.trim().length > 0));
  ok('③ わからないことを省略していない（省略不可）', all.every((f) => f.impact.trim().length > 0),
    all.filter((f) => !f.impact.trim()).map((f) => f.code));
  ok('④ 次の操作は 0 または 1 件（ER-04 の上限2を超えない）',
    all.every((f) => f.action === null || typeof f.action === 'string'));
  ok('推測の語を使っていない（ER-03）',
    all.every((f) => !/おそらく|と思われます|かもしれません/.test(f.fact + f.reason + f.impact)),
    all.filter((f) => /おそらく|と思われます|かもしれません/.test(f.fact + f.reason + f.impact)).map((f) => f.code));
  ok('重大度は3種だけ', all.every((f) => ['blocker', 'limit', 'info'].includes(f.severity)),
    [...new Set(all.map((f) => f.severity))]);
  ok('起動を止める所見には必ず blocker が付く',
    (await PI.inspectProject(path.join(FIX, 'no-next'))).findings.every((f) => f.severity === 'blocker'));
}

console.log('\n5. 計装の可用性（ST-25 — 「適用不可」と「失敗」を混同しない）');
{
  eq('可用性の判定は1か所', typeof PI.checkInstrumentation, 'function');
  const i = PI.checkInstrumentation();
  ok('available は真偽値', typeof i.available === 'boolean', i.available);
  if (i.available) {
    eq('使えるときは理由を書かない', i.reason, null);
    ok('前置するファイルは IDE 側の絶対パス',
      typeof i.boot === 'string' && i.boot.startsWith(REPO) && i.boot.endsWith('boot.cjs'), i.boot);
    ok('その実体が在る', fs.existsSync(i.boot), i.boot);
    ok('対象プロジェクトの中を指していない', !i.boot.includes(path.join(FIX, 'good-stub')), i.boot);
    eq('不足している依存は無い', i.missing.length, 0);
  } else {
    ok('使えないときは理由を書く', typeof i.reason === 'string' && i.reason.length > 0, i.reason);
    skip('計装を使える場合の検証', i.reason);
  }
  const r = await PI.inspectProject(path.join(FIX, 'good-stub'));
  eq('検出結果にも可用性が入る', r.instrumentation.available, i.available);
  ok('使えない場合は「限定」として出る（失敗ではない）',
    i.available ? !has(r, 'instrumentation-unavailable') : has(r, 'instrumentation-unavailable'), codes(r));
}

console.log('\n6. 検出が対象プロジェクトを書き換えない');
{
  const dir = path.join(FIX, 'good-stub');
  const snap = (d) => fs.readdirSync(d, { recursive: true }).sort().join('\n');
  const before = snap(dir);
  await PI.inspectProject(dir);
  await PI.inspectProject(dir);
  eq('2回検出してもファイル構成は同じ', snap(dir), before);
}

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗${skips.length ? ` / ${skips.length} 件 skip` : ''}`);
if (skips.length) for (const s of skips) console.log(`  ⊘ ${s}`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
