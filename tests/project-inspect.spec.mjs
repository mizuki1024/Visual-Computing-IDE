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
 *   - 構成だけを組んだ骨（OS の一時ディレクトリに毎回作り直す）
 *
 * 骨を IDE のリポジトリの中に置かないのは、リポジトリ直下の package-lock.json が
 * 「プロジェクトより上の階層の lockfile」（R3）として、すべての骨に効いてしまうためである。
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
const FIX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-fix-')));
process.on('exit', () => { try { fs.rmSync(FIX, { recursive: true, force: true }); } catch { /* 残っても害はない */ } });

/* ------------------------------------------------------------- 骨を組み直す */
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
/** TypeScript の依存を「入っていること」にする（R4 の所見を正常系に混ぜないため） */
const stubTsDeps = (dir) => {
  for (const d of ['typescript', '@types/react', '@types/node']) {
    mk(`${dir}/node_modules/${d}/package.json`, JSON.stringify({ name: d, version: '0.0.0' }));
  }
};
pkg('good-stub', { name: 'good-stub', dependencies: { next: '^16.0.0' }, scripts: { dev: 'next dev --turbopack' } });
stubNext('good-stub', '16.4.3'); mk('good-stub/src/app/layout.tsx', 'x\n');
mk('good-stub/package-lock.json', '{}'); mk('good-stub/tsconfig.json', '{}\n'); stubTsDeps('good-stub');
mk('good-stub/next-env.d.ts', '/// <reference types="next" />\n');

/* R3 — プロジェクトより上の階層に lockfile がある（blog-app の構成） */
mk('outer/package-lock.json', '{}');
pkg('outer/nested', { name: 'nested', dependencies: { next: '^16.0.0' } }); stubNext('outer/nested', '16.2.6');
mk('outer/nested/app/page.jsx', 'x\n'); mk('outer/nested/package-lock.json', '{}');
pkg('outer/configured', { name: 'configured', dependencies: { next: '^16.0.0' } }); stubNext('outer/configured', '16.2.6');
mk('outer/configured/app/page.jsx', 'x\n');
mk('outer/configured/next.config.mjs', 'export default {\n  turbopack: {\n    root: import.meta.dirname,\n  },\n};\n');
/* ワークスペースの宣言を持つ package.json は推定に使われ、持たないものは使われない */
pkg('ws', { name: 'ws-root', private: true, workspaces: ['apps/*'] });
pkg('ws/apps/web', { name: 'web', dependencies: { next: '^16.0.0' } }); stubNext('ws/apps/web', '16.4.3');
mk('ws/apps/web/app/page.jsx', 'x\n');
pkg('plain', { name: 'plain-root', private: true });
pkg('plain/web', { name: 'web2', dependencies: { next: '^16.0.0' } }); stubNext('plain/web', '16.4.3');
mk('plain/web/app/page.jsx', 'x\n');

/* R4 — TypeScript の構成。next dev が対象のファイルを書き換える条件 */
pkg('ts-missing', { name: 'tsm', dependencies: { next: '^16.0.0' } }); stubNext('ts-missing', '16.4.3');
mk('ts-missing/app/page.tsx', 'x\n');
pkg('ts-ok', { name: 'tso', dependencies: { next: '^16.0.0' } }); stubNext('ts-ok', '16.4.3');
mk('ts-ok/app/page.tsx', 'x\n'); mk('ts-ok/tsconfig.json', '{}\n'); stubTsDeps('ts-ok');
pkg('js-only', { name: 'jso', dependencies: { next: '^16.0.0' } }); stubNext('js-only', '16.4.3');
mk('js-only/app/page.jsx', 'x\n');
mk('a-file.txt', 'not a directory\n');

const INS = PI.checkInstrumentation();
/** 計装が使えない環境では「部分対応」になる。環境差を期待値に混ぜない */
const expectedGoodVerdict = INS.available ? 'supported' : 'partial';
/** 一時ディレクトリより上に lockfile があると、骨にも R3 の所見が付く。その環境では判定の検証を skip する */
const TMP_ANCESTORS = PI.findAncestorRootMarkers(path.join(FIX, 'probe'));

const codes = (r) => r.findings.map((f) => f.code);
const has = (r, code) => codes(r).includes(code);

/* ====================================================== 1. 正常なプロジェクト */
console.log('\n1. 正常な Next.js（App Router）プロジェクトを読める');
{
  const r = await PI.inspectProject(path.join(FIX, 'good-stub'));
  if (TMP_ANCESTORS.length) skip('判定が対応', `一時ディレクトリの上に ${TMP_ANCESTORS.join(' / ')} がある`);
  else eq('判定が対応（計装が使える環境）', r.verdict, expectedGoodVerdict);
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
  // 「展開された結果で判定している」ことだけを見る。
  // 検出結果の root は package.json が無ければ null になる（推測で埋めない）ため、
  // 展開そのものは normalizeInput で見る。以前は inspectProject の root を見ており、
  // ホームに package.json がある環境でしか通らなかった。
  const home = os.homedir().replace(/\/+$/, '');
  eq('~ はホームに展開される', PI.normalizeInput('~').root, home);
  eq('~/x はホームの下に展開される', PI.normalizeInput('~/x').root, path.join(home, 'x'));
  const r = await PI.inspectProject('~');
  ok('検出も展開後のパスで行う（root か所見のどちらかにホームが出る）',
    r.root === home || r.findings.some((f) => f.fact.includes(home)) || r.findings[0]?.code === 'no-package-json',
    { root: r.root, codes: codes(r) });
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

console.log('\n6a. プロジェクトより上の階層の lockfile を、起動の前に言う（R3）');
{
  const r = await PI.inspectProject(path.join(FIX, 'outer', 'nested'));
  const f = r.findings.find((x) => x.code === 'ancestor-root-marker');
  ok('上の階層の lockfile を所見に出す', !!f, codes(r));
  eq('重大度は「限定」（起動は試せる）', f?.severity, 'limit');
  eq('見つけたファイルを近い順に持つ', r.ancestorRootMarkers[0], path.join(FIX, 'outer', 'package-lock.json'));
  ok('事実に見つけたパスを具体的に書く', f?.fact.includes(path.join(FIX, 'outer', 'package-lock.json')), f?.fact);
  ok('turbopack.root の設定を次の操作として示す', /turbopack\.root/.test(f?.action ?? ''), f?.action);
  ok('「プロジェクトが壊れている」と書かない',
    !/壊れて(い|お)ます|不具合があります/.test(`${f?.fact}${f?.reason}`) && /不具合を意味しません/.test(f?.impact ?? ''), f);
  ok('IDE が代わりに設定しないことを明記する', /代わりに行いません/.test(f?.action ?? ''), f?.action);
  eq('起動は試せる', PI.isStartable(r), true);
  eq('判定は部分対応', r.verdict, 'partial');
  eq('next.config の記述は無い', r.rootConfigured, false);
}
{
  const r = await PI.inspectProject(path.join(FIX, 'outer', 'configured'));
  ok('turbopack.root の記述があれば「限定」にしない', !has(r, 'ancestor-root-marker'), codes(r));
  const f = r.findings.find((x) => x.code === 'ancestor-root-marker-configured');
  eq('記述があることは記録として残す', f?.severity, 'info');
  ok('値を評価していないことを書く', /確認していません/.test(f?.impact ?? ''), f?.impact);
  eq('記述を見つけた', r.rootConfigured, true);
}
{
  const r = await PI.inspectProject(path.join(FIX, 'ws', 'apps', 'web'));
  ok('workspaces を持つ package.json は推定に使われるファイルとして出す',
    r.ancestorRootMarkers.includes(path.join(FIX, 'ws', 'package.json')), r.ancestorRootMarkers);
  const r2 = await PI.inspectProject(path.join(FIX, 'plain', 'web'));
  ok('workspaces を持たない package.json は出さない（Next.js は推定に使わない）',
    !r2.ancestorRootMarkers.includes(path.join(FIX, 'plain', 'package.json')), r2.ancestorRootMarkers);
}

console.log('\n6b. next dev が対象のファイルを書き換えることを、主体を明示して言う（R4）');
{
  const r = await PI.inspectProject(path.join(FIX, 'ts-missing'));
  const f = r.findings.find((x) => x.code === 'next-dev-installs-typescript');
  ok('TypeScript の依存が無ければ、next dev が入れることを先に言う', !!f, codes(r));
  eq('重大度は「限定」', f?.severity, 'limit');
  ok('不足している依存を具体的に書く', /typescript/.test(f?.fact ?? ''), f?.fact);
  ok('書き換える主体は next dev であり IDE ではないと書く',
    /next dev/.test(f?.reason ?? '') && /IDE ではなく next dev/.test(f?.impact ?? ''), f);
  ok('tsconfig.json の書き換えも言う', has(r, 'next-dev-writes-tsconfig'), codes(r));
  eq('tsconfig.json が無いことを記録する', r.typescript.tsconfig, false);
}
{
  const r = await PI.inspectProject(path.join(FIX, 'ts-ok'));
  const f = r.findings.find((x) => x.code === 'next-dev-writes-tsconfig');
  ok('TypeScript の構成なら tsconfig.json / next-env.d.ts の書き換えを言う', !!f, codes(r));
  eq('重大度は「記録」（起動にも観測範囲にも影響しない）', f?.severity, 'info');
  ok('主体は next dev', /next dev/.test(f?.reason ?? ''), f?.reason);
  ok('IDE は書き込まないと明記する', /IDE は対象プロジェクトに書き込みません/.test(f?.impact ?? ''), f?.impact);
  ok('next-env.d.ts が無ければ「作成します」と書く', /next-env\.d\.ts を作成します/.test(f?.reason ?? ''), f?.reason);
  ok('書き換えるかを事前に判定していないことを書く', /事前に判定しません/.test(f?.impact ?? ''), f?.impact);
  ok('依存が揃っていればインストールの所見は出ない', !has(r, 'next-dev-installs-typescript'), codes(r));
}
{
  const r = await PI.inspectProject(path.join(FIX, 'js-only'));
  ok('JavaScript だけの構成では、どちらの所見も出さない',
    !has(r, 'next-dev-writes-tsconfig') && !has(r, 'next-dev-installs-typescript'), codes(r));
  eq('TypeScript は使っていない', r.typescript.used, false);
}
{
  const all = [];
  for (const d of ['outer/nested', 'outer/configured', 'ts-missing', 'ts-ok']) {
    all.push(...(await PI.inspectProject(path.join(FIX, d))).findings);
  }
  ok('新しい所見も4要素を満たす', all.every((f) => f.fact.trim() && f.reason.trim() && f.impact.trim()));
  ok('新しい所見も推測の語を使わない',
    all.every((f) => !/おそらく|と思われます|かもしれません/.test(f.fact + f.reason + f.impact)));
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
