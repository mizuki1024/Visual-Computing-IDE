/* =============================================================================
 * 7C HMR × 由来の安全性調査 — 診断用スクリプト（試験ではない。製品のコードは変えない）。
 * **既存の題材のすべてのデータ取得の呼び出しについて、HMR の後に起きる位置のずれを机上で当てはめる。**
 *
 *   node docs/07c-hmr-lineage-safety-results/hmr-offset-sim.mjs
 *
 * hmr-lineage-probe.mjs で実測した仕組み:
 *   サーバー側の HMR で差し替わったモジュールは、Turbopack の実行時が `eval` し、`//# sourceURL=<生成物のファイル>?<moduleId>`
 *   を付ける。V8 のスタックの行・列は**その eval したモジュール単体の中**の位置になる（生成物のファイルの中の位置ではない）。
 *   計装はファイル名の `?…` を落とすので、IDE はその行・列を**ディスクの生成物（全モジュールを連結したもの）のソースマップ**で戻す。
 *   ＝ 実際の位置より K 行前（K = 生成物の中でそのモジュールの関数が始まる行 − 1）を戻すことになる。
 *
 * このスクリプトは、使い捨てのコピーで既存の全ページを1回ずつコンパイルし、生成物の中の各データ取得の呼び出し
 * （`.query(` など。rscattr.mjs の CALL_PATTERN と同じ語）について、(行 − K, 列) を製品の照合器
 * （rscattr.mjs の resolveRscAttribution。ソース行の読み直し・コンポーネントの2情報源の一致まで）に掛け、
 * HMR の後にその呼び出しが実行されたら**どこに帰属するか**を予測する。実行はしない（予測）。
 * 予測の妥当性は hmr-lineage-probe.mjs の実測（/hmr-m: 予測どおり a の行へずれる）で確かめてある。
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const SRC_FIXTURE = path.join(REPO, 'poc', 'fixture-app');
const WORK = path.join(REPO, 'poc', 'out', 'hmr-offset-sim');
const APP = path.join(WORK, 'poc', 'fixture-app');
const RT = path.join(WORK, 'runtime');
const PORT = 3497;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.chdir(REPO);
const req = createRequire(path.join(REPO, 'package.json'));
const AN = req('./.libjs/server/anchors.js');
const { resolveRscAttribution } = await import(path.join(REPO, 'poc', 'runner', 'lib', 'rscattr.mjs'));
const { resolveServerFrame } = await import(path.join(REPO, 'poc', 'runner', 'lib', 'srvmap.mjs'));

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(RT, { recursive: true });
fs.cpSync(path.join(REPO, 'poc', 'anchor'), path.join(WORK, 'poc', 'anchor'), { recursive: true });
fs.cpSync(SRC_FIXTURE, APP, { recursive: true, filter: (s) => { const r = path.relative(SRC_FIXTURE, s).split(path.sep); return r[0] !== 'node_modules' && r[0] !== '.next'; } });
execFileSync('cp', ['-al', path.join(SRC_FIXTURE, 'node_modules'), path.join(APP, 'node_modules')]);
/* 予測の妥当性の確認用: hmr-lineage-probe.mjs の /hmr-m（実測で a の行へずれて WRONG になった題材）も同じ予測に掛ける */
fs.mkdirSync(path.join(APP, 'src', 'app', 'hmr-m'), { recursive: true });
fs.writeFileSync(path.join(APP, 'src', 'app', 'hmr-m', 'page.tsx'), `/* HMR 調査の一時的な題材: 同じコンポーネントに SQL が2つ */
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function HmrM() {
  const a = await pool.query('SELECT id, region FROM poc.listings ORDER BY id DESC LIMIT 1');
  const n1 = a.rows.length;
  const n2 = n1 + 1;
  const n3 = n2 + 1;
  const n4 = n3 + 1;
  const n5 = n4 + 1;
  const n6 = n5 + 1;
  const b = await pool.query('SELECT id, name AS region FROM poc.regions ORDER BY id LIMIT 1');
  return (
    <main className="hmr-m">
      <p data-poc-field="m-a">{a.rows[0].region}</p>
      <p data-poc-field="m-b">{b.rows[0].region}</p>
      <p data-poc-field="m-n">{String(n6)}</p>
    </main>
  );
}
`);

const env = {
  ...process.env,
  NODE_OPTIONS: `--require "${path.join(REPO, 'poc/fixture-app/ide-instrumentation/boot.cjs')}"`,
  POC01_MODE: 'method2', POC01_SPAN_FILE: path.join(RT, 'spans.jsonl'), POC02_CALLSITE: '1', POC03_ANCHOR: '1', POC03_ANCHOR_OUT: path.join(RT, 'anchors'),
};
const child = spawn(process.execPath, [path.join(APP, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(PORT), '-H', '127.0.0.1'], { cwd: APP, env, stdio: 'ignore', detached: true });
process.on('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* */ } });
const get = (p) => new Promise((res) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }).on('error', (e) => res(String(e.code))); });
for (let i = 0; i < 240; i++) { const s = await get('/'); if (s === 200 || s === 404) break; await sleep(500); }
const pages = fs.readdirSync(path.join(APP, 'src', 'app'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'api' && fs.existsSync(path.join(APP, 'src', 'app', d.name, 'page.tsx'))).map((d) => `/${d.name}`);
const status = {};
for (const p of pages) status[p] = await get(p);
await sleep(1500);
try { process.kill(-child.pid, 'SIGTERM'); } catch { /* */ }
for (let i = 0; i < 40; i++) { try { process.kill(child.pid, 0); await sleep(250); } catch { break; } }

const CALL = /\.(query|\$queryRaw|\$executeRaw|findMany|findFirst|findUnique|count|aggregate|groupBy)\s*[(`]/g;
const manifest = AN.readManifestComponents(path.join(RT, 'anchors'));
const dir = path.join(APP, '.next', 'dev', 'server', 'chunks', 'ssr');
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.startsWith('['.concat('turbopack')))) {
  const rel = `.next/dev/server/chunks/ssr/${f}`;
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
  /* モジュールの開始行: `"[project]/src/... (ecmascript)", ((__turbopack_context__) => {` の行 */
  const starts = [];
  lines.forEach((l, i) => { const m = /^"\[project\]\/(src\/[^ "]+) \[[a-z-]+\] \(ecmascript\)", \(\(__turbopack_context__\) => \{/.exec(l); if (m) starts.push({ line: i + 1, src: m[1] }); });
  if (!starts.length) continue;
  lines.forEach((l, i) => {
    CALL.lastIndex = 0;
    let m;
    while ((m = CALL.exec(l))) {
      const line = i + 1;
      const col = m.index + 2;                       // `.` の次 = メソッド名の先頭（V8 が指す列。/hmr-m の実測と同じ）
      const mod = starts.filter((s) => s.line <= line).at(-1);
      if (!mod) continue;
      const frame = { file: rel, scope: 'build-output', line, col, functionName: null };
      const truth = resolveServerFrame(frame, APP);
      if (!truth || !truth.file.startsWith('src/')) continue;   // 題材のソースに戻らない呼び出し（node_modules 等）は対象外
      const K = mod.line - 1;
      const shifted = { ...frame, line: line - K };
      const a = resolveRscAttribution({ target: 'sql', entry: { at: 'sim', frames: [shifted] }, atSpanStart: [] }, manifest, { root: APP });
      const site = !a.failure && a.frame ? `${a.frame.file}:${a.frame.line}:${a.frame.col}` : null;
      const t = `${truth.file}:${truth.line}:${truth.col}`;
      rows.push({
        chunk: f, module: mod.src, K, gen: `${line}:${col}`, truth: t,
        predicted: site ?? `unresolved(${a.failure?.reason})`, located: a.frame ? `${a.frame.file}:${a.frame.line}` : null,
        verdict: site ? (site === t ? 'same-site' : 'WRONG') : 'unresolved',
      });
    }
  });
}
console.log(`# hmr-offset-sim ${new Date().toISOString()}（予測。実行はしていない）`);
console.log(`# ページ ${pages.length} 枚をコンパイル: ${Object.entries(status).map(([p, s]) => `${p}=${s}`).join(' ')}`);
const seen = new Set();
for (const r of rows) {
  const k = `${r.truth}|${r.module}`;
  if (seen.has(k)) continue;                          // 同じモジュールが複数の生成物に入っている場合は1回だけ
  seen.add(k);
  console.log(`${r.verdict.padEnd(10)} ${r.truth.padEnd(42)} K=${String(r.K).padEnd(4)} → ${r.predicted}${r.verdict === 'unresolved' && r.located ? `（戻した位置 ${r.located}）` : ''}  [${r.chunk}]`);
}
const fixtureRows = rows.filter((r) => !r.module.startsWith('src/app/hmr-m/'));
const uniq = fixtureRows.filter((r, i) => fixtureRows.findIndex((x) => x.truth === r.truth && x.module === r.module) === i);
const c = uniq.reduce((m, r) => { m[r.verdict] = (m[r.verdict] ?? 0) + 1; return m; }, {});
console.log(`\n# 集計（既存の題材の呼び出し ${uniq.length} 件。/hmr-m は除く）: ${JSON.stringify(c)}`);
console.log('# unresolved の内訳:', JSON.stringify(uniq.filter((r) => r.verdict === 'unresolved').reduce((m, r) => { const k = r.predicted; m[k] = (m[k] ?? 0) + 1; return m; }, {})));
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 後で消す */ }
process.exit(0);
