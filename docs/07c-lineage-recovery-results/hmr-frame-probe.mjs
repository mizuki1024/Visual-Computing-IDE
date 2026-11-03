/* =============================================================================
 * 7C（lineage-e2e の復旧）の診断用スクリプト（試験ではない。結果は hmr-frame-probe.txt）。
 * 第2の事象「同じ起動の中でサーバー側のコードが HMR で差し替わると、SQL の呼び出し位置を src/ へ戻せない」の確認。
 *   node docs/07c-lineage-recovery-results/hmr-frame-probe.mjs <題材のコピー> <収集ファイル> <IDE>/poc/fixture-app/ide-instrumentation/boot.cjs <IDE>
 * IDE と同じ計装の環境変数で next dev を起動し、/lin-a を要求 → ソースの末尾にコメント → 再要求 → 元に戻す → 再要求。
 * 各回の LinA のフレームを IDE の照合器（poc/runner/lib/srvmap.mjs の resolveServerFrame）で戻し、
 * ディスクの生成物のその位置に何が書かれているかを並べる。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
const [,, APPDIR, SPAN, BOOT, REPO] = process.argv;
const { resolveServerFrame } = await import(path.join(REPO, 'poc/runner/lib/srvmap.mjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3477;
const env = { ...process.env, NODE_OPTIONS: `--require "${BOOT}"`, POC01_MODE: 'method2', POC01_SPAN_FILE: SPAN, POC02_CALLSITE: '1', POC03_ANCHOR: '1', POC03_ANCHOR_OUT: path.join(path.dirname(SPAN), 'anchors-probe') };
const child = spawn(process.execPath, [path.join(APPDIR, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(PORT), '-H', '127.0.0.1'], { cwd: APPDIR, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
const get = (p) => new Promise((res) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res([r.statusCode, b.length])); }).on('error', (e) => res([String(e.code), 0])); });
for (let i = 0; i < 120; i++) { const [s] = await get('/'); if (s === 200 || s === 404) break; await sleep(500); }
const frames = (since) => fs.readFileSync(SPAN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((o) => o.type === 'callsite' && o.target === 'sql' && o.entry).map((o) => o.entry.frames.find((f) => f.functionName === 'LinA')).filter(Boolean).slice(since);
const report = (label, since) => {
  const fs_ = frames(since);
  const f = fs_.at(-1);
  if (!f) { console.log(label, 'no LinA frame'); return fs_.length + since; }
  const abs = path.join(APPDIR, f.file);
  const st = fs.statSync(abs); const stm = fs.existsSync(abs + '.map') ? fs.statSync(abs + '.map') : null;
  const line = fs.readFileSync(abs, 'utf8').split('\n')[f.line - 1] ?? '';
  console.log(label, `${f.file}:${f.line}:${f.col}`, '→', JSON.stringify(resolveServerFrame(f, APPDIR)), '| chunk mtime', new Date(st.mtimeMs).toISOString().slice(11, 23), 'map mtime', stm && new Date(stm.mtimeMs).toISOString().slice(11, 23), '| disk line at frame:', JSON.stringify(line.slice(Math.max(0, f.col - 40), f.col + 40)));
  return since + fs_.length;
};
console.log('first GET', await get('/lin-a'));
await sleep(1500);
let n = report('BEFORE', 0);
const page = path.join(APPDIR, 'src/app/lin-a/page.tsx');
const orig = fs.readFileSync(page, 'utf8');
fs.writeFileSync(page, `${orig}\n// comment only ${Date.now()}\n`);
await sleep(3000);
console.log('after-change GET', await get('/lin-a'));
await sleep(1500);
n = report('AFTER-CHANGE', n);
fs.writeFileSync(page, orig);
await sleep(3000);
console.log('after-restore GET', await get('/lin-a'));
await sleep(1500);
report('AFTER-RESTORE', n);
const chunks = fs.readdirSync(path.join(APPDIR, '.next/dev/server/chunks/ssr')).filter((f) => f.includes('1zojl'));
console.log('chunk files:', chunks);
try { process.kill(-child.pid, 'SIGTERM'); } catch {}
await sleep(500);
process.exit(0);
