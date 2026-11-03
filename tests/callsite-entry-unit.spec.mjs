/* =============================================================================
 * 7C（lineage-e2e の復旧）— 呼び出し位置の記録（server-call-stack）が、**対象のアプリが使う pg の実体**の
 * 入口を包むことを確かめる。Next.js も DB も使わない（計装の束を NODE_OPTIONS=--require で前置するだけ）。
 *   node tests/callsite-entry-unit.spec.mjs
 *
 * 不具合（修正前）: 計装の束（poc/fixture-app/ide-instrumentation、IDE 側）が素の require('pg') で
 * IDE 側の node_modules の pg を包んでいた。対象のプロジェクトが自分の node_modules に pg を持つと、
 * アプリは包まれていない別の実体を使い、すべての SQL で入口のスタック（entry）が null になる。
 * 題材を IDE の中の poc/fixture-app に置いたときだけ両者が一致するため、7C-3 の全件実行では見えなかった。
 *
 * 使い捨てのプロジェクトは OS の一時ディレクトリに作る（IDE のリポジトリの外。実在のプロジェクトと同じ配置）。
 * pg の依存だけを IDE 側の題材の node_modules から**複製**する（別の実体になる）。
 * 接続先は閉じたポートなので SQL は届かない。それでも pg の計装は接続のスパンを作り、入口の記録はその時点で決まる。
 * ========================================================================== */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(REPO, 'poc', 'fixture-app');
const BOOT = path.join(FIXTURE, 'ide-instrumentation', 'boot.cjs');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);

if (!fs.existsSync(path.join(FIXTURE, 'node_modules', 'pg', 'package.json'))
  || !fs.existsSync(path.join(FIXTURE, 'node_modules', '@opentelemetry', 'instrumentation-pg', 'package.json'))) {
  console.log('\n⊘ poc/fixture-app に依存（pg・@opentelemetry/*）が入っていないため、全件 skip。先に (cd poc/fixture-app && npm ci)');
  process.exit(0);
}

/** 閉じたポート（接続は即座に拒否される） */
const closedPort = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const DSN = `postgresql://u:p@127.0.0.1:${closedPort}/x`;

/** pg とその依存の閉包（package.json の dependencies / optionalDependencies を辿る） */
function pgClosure() {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    const pj = path.join(FIXTURE, 'node_modules', name, 'package.json');
    if (!fs.existsSync(pj)) return; // 入っていない optional
    seen.add(name);
    const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
    for (const d of Object.keys({ ...(p.dependencies ?? {}), ...(p.optionalDependencies ?? {}) })) visit(d);
  };
  visit('pg');
  return [...seen];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-callsite-'));
process.on('exit', () => { fs.rmSync(TMP, { recursive: true, force: true }); });

/** 使い捨てのプロジェクト。nested = pg-pool を pg の下の node_modules に置く（巻き上げない配置） */
function makeProject(name, { withPg = true, nested = false } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true }));
  if (withPg) {
    for (const m of pgClosure()) {
      const dst = nested && m === 'pg-pool'
        ? path.join(dir, 'node_modules', 'pg', 'node_modules', 'pg-pool')
        : path.join(dir, 'node_modules', m);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(path.join(FIXTURE, 'node_modules', m), dst, { recursive: true, dereference: true });
    }
  }
  return dir;
}

/** アプリ側のコード。呼び出しの行を返す（スタックの照合に使う） */
const PROBE = (pgSpec) => [
  `const pg = require(${JSON.stringify(pgSpec)});`,
  `const pool = new pg.Pool({ connectionString: ${JSON.stringify(DSN)}, connectionTimeoutMillis: 2000 });`,
  'async function viaPool() {',
  "  try { await pool.query('select 1 as x'); } catch { /* 閉じたポート */ }", // 4 行目
  '}',
  'async function viaClient() {',
  `  const c = new pg.Client({ connectionString: ${JSON.stringify(DSN)}, connectionTimeoutMillis: 2000 });`,
  "  try { await c.query('select 2 as y'); } catch { /* 未接続 */ }", // 8 行目
  '}',
  `(async () => { await (process.argv[2] === 'client' ? viaClient() : viaPool()); await pool.end().catch(() => {}); })();`,
  '',
].join('\n');
const POOL_LINE = 4;
const CLIENT_LINE = 8;

/** 計装の束を前置して走らせ、収集ファイルを返す */
function run(cwd, probeFile, mode = 'pool') {
  const spanFile = path.join(TMP, `${path.basename(cwd)}-${mode}-${Math.random().toString(16).slice(2)}.jsonl`);
  let exit = 0;
  try {
    execFileSync(process.execPath, [probeFile, mode], {
      cwd,
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: `--require "${BOOT}"`,
        POC01_MODE: 'method2', POC01_SPAN_FILE: spanFile, POC02_CALLSITE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    });
  } catch (e) { exit = e.status ?? -1; }
  const recs = fs.existsSync(spanFile)
    ? fs.readFileSync(spanFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return {
    exit,
    recs,
    sqlCallsites: recs.filter((r) => r.type === 'callsite' && r.target === 'sql'),
    pgSpans: recs.filter((r) => r.type === 'span' && /instrumentation-pg/.test(r.scope ?? '')),
    notes: recs.filter((r) => r.type === 'note'),
  };
}
const appFrame = (cs) => cs.entry?.frames?.find((f) => f.scope === 'app-source' && !f.file.startsWith('ide-instrumentation/')) ?? null;

try {
  /* ---------------------------------------------------------------- 1 */
  console.log('\n1. 対照: 題材が IDE の中の poc/fixture-app（IDE 側の pg = アプリの pg）');
  {
    const probe = path.join(TMP, 'control-probe.cjs');
    fs.writeFileSync(probe, PROBE(path.join(FIXTURE, 'node_modules', 'pg')));
    const r = run(FIXTURE, probe);
    ok('SQL のスパン（pg の計装）がある', r.pgSpans.length > 0, r.pgSpans.length);
    ok('SQL の呼び出し位置の記録がある', r.sqlCallsites.length > 0, r.sqlCallsites.length);
    ok('すべての記録に入口のスタック（pg-pool.Pool.query）がある', r.sqlCallsites.length > 0 && r.sqlCallsites.every((c) => c.entry?.at === 'pg-pool.Pool.query'), r.sqlCallsites.map((c) => c.entry?.at ?? null));
  }

  /* ---------------------------------------------------------------- 2 */
  console.log('\n2. 対象のプロジェクトが自分の node_modules に pg を持つ（IDE のリポジトリの外）');
  const projA = makeProject('own-pg');
  fs.writeFileSync(path.join(projA, 'probe.cjs'), PROBE('pg'));
  {
    const realApp = fs.realpathSync(path.join(projA, 'node_modules', 'pg'));
    const realIde = fs.realpathSync(path.join(FIXTURE, 'node_modules', 'pg'));
    ok('前提: アプリの pg と IDE 側の pg は別の実体（実パスが違う）', realApp !== realIde, { realApp: path.relative(TMP, realApp) });
    const r = run(projA, path.join(projA, 'probe.cjs'));
    eq('計装を前置したアプリが正常に終わる', r.exit, 0);
    ok('SQL のスパン（pg の計装）がある', r.pgSpans.length > 0, r.pgSpans.length);
    ok('SQL の呼び出し位置の記録がある', r.sqlCallsites.length > 0, r.sqlCallsites.length);
    ok('すべての記録に入口のスタック（pg-pool.Pool.query）がある（修正前は null）', r.sqlCallsites.length > 0 && r.sqlCallsites.every((c) => c.entry?.at === 'pg-pool.Pool.query'), r.sqlCallsites.map((c) => c.entry?.at ?? null));
    ok('入口のスタックに、アプリの呼び出し（probe.cjs の pool.query の行）がある', r.sqlCallsites.length > 0 && r.sqlCallsites.every((c) => { const f = appFrame(c); return f?.file === 'probe.cjs' && f.line === POOL_LINE; }), r.sqlCallsites.map((c) => appFrame(c)));
    ok('記録はどれも SQL のスパンの1本に対応する（同じスパン ID・トレース ID）', r.sqlCallsites.every((c) => r.pgSpans.some((s) => s.spanId === c.spanId && s.traceId === c.traceId)));
    ok('入口を包んだ知らせ（pg-pool.Pool.query・pg.Client.query）', ['pg-pool.Pool.query', 'pg.Client.query'].every((l) => r.notes.some((n) => n.kind === 'callsite-entry-patched' && n.detail === l)), r.notes.map((n) => `${n.kind}:${n.detail}`));
    ok('pg が見つからないという知らせは無い', !r.notes.some((n) => /callsite-pg(-pool)?-missing/.test(n.kind)), r.notes.filter((n) => /missing/.test(n.kind)));
    ok('収集物に絶対パス（一時ディレクトリ）を書かない', !JSON.stringify(r.recs).includes(TMP));

    const rc = run(projA, path.join(projA, 'probe.cjs'), 'client');
    ok('Client.query を直接呼んだ: 入口のスタック（pg.Client.query）がある（修正前は null）', rc.sqlCallsites.length > 0 && rc.sqlCallsites.every((c) => c.entry?.at === 'pg.Client.query'), rc.sqlCallsites.map((c) => c.entry?.at ?? null));
    ok('Client.query を直接呼んだ: アプリの呼び出し（probe.cjs の c.query の行）がある', rc.sqlCallsites.length > 0 && rc.sqlCallsites.every((c) => { const f = appFrame(c); return f?.file === 'probe.cjs' && f.line === CLIENT_LINE; }), rc.sqlCallsites.map((c) => appFrame(c)));
  }

  /* ---------------------------------------------------------------- 3 */
  console.log('\n3. pg-pool が pg の下に入れ子（巻き上げない配置）');
  {
    const projB = makeProject('nested-pg-pool', { nested: true });
    fs.writeFileSync(path.join(projB, 'probe.cjs'), PROBE('pg'));
    ok('前提: プロジェクトの直下に pg-pool が無い', !fs.existsSync(path.join(projB, 'node_modules', 'pg-pool')));
    const r = run(projB, path.join(projB, 'probe.cjs'));
    ok('入口のスタック（pg-pool.Pool.query）がある（pg が使う pg-pool を包む）', r.sqlCallsites.length > 0 && r.sqlCallsites.every((c) => c.entry?.at === 'pg-pool.Pool.query'), r.sqlCallsites.map((c) => c.entry?.at ?? null));
    ok('アプリの呼び出しの行がある', r.sqlCallsites.length > 0 && r.sqlCallsites.every((c) => appFrame(c)?.line === POOL_LINE), r.sqlCallsites.map((c) => appFrame(c)));
  }

  /* ---------------------------------------------------------------- 4 */
  console.log('\n4. 対象のプロジェクトに pg が無い');
  {
    const projC = makeProject('no-pg', { withPg: false });
    fs.writeFileSync(path.join(projC, 'probe.cjs'), "console.log('no db');\n");
    const r = run(projC, path.join(projC, 'probe.cjs'));
    eq('計装を前置したアプリが正常に終わる', r.exit, 0);
    ok('「pg が見つからない」と知らせる（IDE 側の pg を代わりに包まない）', r.notes.some((n) => n.kind === 'callsite-pg-missing'), r.notes.map((n) => n.kind));
    ok('pg の入口を包んだとは知らせない', !r.notes.some((n) => n.kind === 'callsite-entry-patched' && /^pg/.test(n.detail)), r.notes.filter((n) => n.kind === 'callsite-entry-patched').map((n) => n.detail));
    ok('知らせに絶対パスを書かない', !r.notes.some((n) => String(n.detail).includes(TMP) || String(n.detail).includes(REPO)), r.notes.map((n) => n.detail));
    ok('fetch の入口は従来どおり包む', r.notes.some((n) => n.kind === 'callsite-entry-patched' && n.detail === 'globalThis.fetch'));
  }
} catch (e) {
  fails.push(`例外: ${e?.stack ?? e}`);
  console.log(e);
}

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
