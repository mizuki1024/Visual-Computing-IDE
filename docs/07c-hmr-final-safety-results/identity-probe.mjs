/* 7C HMR 最終安全対策 — 診断（試験ではない）: SQL を実行したフレームの「実行中のスクリプトの版」と、ディスクの生成物の版の関係。
 *   node docs/07c-hmr-final-safety-results/identity-probe.mjs [--nsfr]
 * 使い捨てのコピー（poc/out/probe-identity[-nsfr]）で next dev（Turbopack・server fast refresh は既定）を起動し、
 *   1. 初回のコンパイルの要求 / 2回目の要求 / page.tsx だけを変えた後の要求 ×2 / 開発サーバーの再起動の後
 * の各段で、SQL の呼び出しの入口のフレーム（.next の生成物）ごとに
 *   frame.scriptHash（計装が V8 の CallSite.getScriptHash() で記録）と sha256(ディスクの生成物のいまの内容)
 * を並べる。あわせて、生成物（.js）とソースマップ（.js.map）の書き込みの順序（fs.watch）、Turbopack の実行時が
 * 生成物を読み込む方法（[turbopack]_runtime.js の中の require / runInThisContext）、生成物とソースマップの区画の対応を記録する。
 * 製品の照合（resolveDataAccess）は呼ばない（生の証拠だけ）。 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
import { createRequire } from 'node:module';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NSFR = process.argv.includes('--nsfr');
const WORK = path.join(REPO, 'poc', 'out', `probe-identity${NSFR ? '-nsfr' : ''}`);
const APP = path.join(WORK, 'poc', 'fixture-app');
const SPAN = path.join(WORK, 'spans.jsonl');
const PORT = NSFR ? 3496 : 3495;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const CR = createRequire(import.meta.url)(path.join(REPO, 'poc/fixture-app/ide-instrumentation/chunkregions.cjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.cpSync(path.join(REPO, 'poc', 'anchor'), path.join(WORK, 'poc', 'anchor'), { recursive: true });
fs.cpSync(path.join(REPO, 'poc/fixture-app'), APP, { recursive: true, filter: (s) => { const r = path.relative(path.join(REPO, 'poc/fixture-app'), s).split(path.sep); return r[0] !== 'node_modules' && r[0] !== '.next'; } });
execFileSync('cp', ['-al', path.join(REPO, 'poc/fixture-app/node_modules'), path.join(APP, 'node_modules')]);
const put = (rel, t) => { fs.mkdirSync(path.dirname(path.join(APP, rel)), { recursive: true }); fs.writeFileSync(path.join(APP, rel), t); };
put('src/app/hmr-s/page.tsx', `import SA from '../../components/SA';
import { pool } from '../../lib/db';

export const dynamic = 'force-dynamic';

export default async function HmrS() {
  const p = await pool.query('SELECT id, plan FROM poc.listings ORDER BY id LIMIT 1');
  return (<main><p data-poc-field="s-plan">{p.rows[0].plan}</p><SA /></main>);
}
`);
put('src/components/SA.tsx', `import { pool } from '../lib/db';

export default async function SA() {
  const a = await pool.query('SELECT id, region FROM poc.listings ORDER BY id DESC LIMIT 1');
  const n1 = a.rows.length;
  const n2 = n1 + 1;
  const n3 = n2 + 1;
  const n4 = n3 + 1;
  const n5 = n4 + 1;
  const n6 = n5 + 1;
  const b = await pool.query('SELECT id, name AS region FROM poc.regions ORDER BY id LIMIT 1');
  return (<div><p data-poc-field="s-a">{a.rows[0].region}</p><p data-poc-field="s-b">{b.rows[0].region}{n6}</p></div>);
}
`);
const env = { ...process.env, NODE_OPTIONS: `--require "${path.join(REPO, 'poc/fixture-app/ide-instrumentation/boot.cjs')}"`,
  POC01_MODE: 'method2', POC01_RUN: 'probe', POC01_SPAN_FILE: SPAN, NEXT_OTEL_VERBOSE: '1', POC05_TRACE_HEADER: '1', POC05_SERVER_TIMING: '0',
  POC02_CALLSITE: '1', POC07_RELAY_ID: '1', POC03_ANCHOR: '1', POC03_ANCHOR_OUT: path.join(WORK, 'anch') };
let child = null;
const startDev = () => {
  child = spawn(process.execPath, [path.join(APP, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(PORT), '-H', '127.0.0.1', ...(NSFR ? ['--no-server-fast-refresh'] : [])], { cwd: APP, env, stdio: 'ignore', detached: true });
};
const stopDev = async () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 終わっている */ } await sleep(1500); };
process.on('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 終わっている */ } });
const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { r.resume(); r.on('end', () => res({ status: r.statusCode, trace: r.headers['x-vcide-trace'] })); }).on('error', (e) => res({ status: e.code })));
const waitUp = async () => { for (let i = 0; i < 240; i++) { const r = await get('/api/health-not-exist'); if (r.status === 404 || r.status === 200) return; await sleep(500); } throw new Error('dev server did not start'); };
const rd = () => fs.readFileSync(SPAN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

/* 生成物・ソースマップの書き込みの順序 */
const events = [];
let watcher = null;
const watchChunks = () => {
  const dir = path.join(APP, '.next/dev/server/chunks/ssr');
  try {
    watcher = fs.watch(dir, (ev, name) => { if (name && /hmr-s|\.js(\.map)?$/.test(name)) events.push({ t: Date.now(), ev, name }); });
  } catch (e) { console.log('watch failed', e.message); }
};

async function req(p, label) {
  const t = Date.now();
  const r = await get(p); await sleep(3500);
  const tid = /^00-([0-9a-f]{32})/.exec(r.trace ?? '')?.[1];
  const recs = rd().filter((o) => o.traceId === tid);
  const sqls = recs.filter((o) => o.type === 'span' && o.attrs?.['db.statement']).sort((a, b) => a.startMs - b.startMs);
  console.log(`\n## ${label} ${p} status=${r.status}`);
  for (const s of sqls) {
    const cs = recs.find((o) => o.type === 'callsite' && o.spanId === s.spanId);
    console.log(`  SQL「${s.attrs['db.statement'].slice(0, 44)}」 start=+${(s.startMs - t).toFixed(0)}ms frameSource=${cs?.entry?.frameSource}`);
    const scopes = (cs?.entry?.frames ?? []).map((f) => f.scope);
    console.log(`    scopes: ${scopes.join(' ')}`);
    for (const f of (cs?.entry?.frames ?? []).filter((x) => x.scope === 'build-output' || x.scope === 'evaluated').slice(0, 4)) {
      if (f.scope === 'evaluated') { console.log(`    frame ${f.functionName} <evaluated> (A1 の印)`); continue; }
      const abs = path.join(APP, f.file);
      let disk = null; let regions = [];
      try { const buf = fs.readFileSync(abs); disk = sha(buf); regions = CR.chunkRegions(buf.toString('utf8')); } catch { disk = 'unreadable'; }
      console.log(`    frame ${f.functionName} ${path.basename(f.file)}:${f.line}:${f.col} scriptHash=${f.scriptHash ? f.scriptHash.slice(0, 12) : 'none'} disk=${String(disk).slice(0, 12)} → ${f.scriptHash && f.scriptHash === disk ? 'SAME（実行中のコード＝ディスクの生成物）' : 'DIFFERENT（実行中のコードはディスクの生成物ではない）'}`);
      const mr = f.moduleRegion;
      const same = mr ? regions.filter((x) => x.hash === mr.hash) : [];
      console.log(`      moduleRegion=${mr ? `${mr.hash.slice(0, 12)}+${mr.line}` : 'none'} → ディスクの同じ内容の区画 ${same.length} 個${same.length === 1 ? `（ディスクでは ${same[0].start + mr.line} 行目 ＝ 実行時の ${f.line} 行目）` : ''}`);
    }
  }
  return { tid, t };
}

function chunkLayout(label) {
  const dir = path.join(APP, '.next/dev/server/chunks/ssr');
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const body = fs.readFileSync(path.join(dir, n), 'utf8');
    if (!body.includes('[project]/src/components/SA.tsx')) continue;
    const heads = [...body.matchAll(/^"(\[project\]\/[^"]+)", \(\(__turbopack_context__\)/gm)].map((m) => `${body.slice(0, m.index).split('\n').length}:${m[1].slice(0, 70)}`);
    let map = null; try { map = JSON.parse(fs.readFileSync(path.join(dir, `${n}.map`), 'utf8')); } catch { map = null; }
    const secs = (map?.sections ?? []).map((s) => `${s.offset.line + 1}:${(s.map?.sources ?? []).map((x) => String(x).replace(/^turbopack:\/\/\//, '')).join(',').slice(0, 70)}`);
    const tail = body.trimEnd().split('\n').slice(-2).join(' | ');
    console.log(`\n[layout ${label}] ${n} lines=${body.split('\n').length} sha=${sha(Buffer.from(body)).slice(0, 12)} debugId(js)=${/debugId=([0-9a-f-]+)/.exec(body)?.[1] ?? 'none'} debugId(map)=${map?.debugId ?? 'none'}`);
    console.log(`  module headers (1-based line): ${heads.join(' ; ')}`);
    console.log(`  map sections (1-based line): ${secs.join(' ; ')}`);
    console.log(`  tail: ${tail.slice(0, 200)}`);
  }
}

function runtimeLoading() {
  const rt = path.join(APP, '.next/dev/server/chunks/ssr/[turbopack]_runtime.js');
  if (!fs.existsSync(rt)) { console.log('\n[runtime] not found'); return; }
  const body = fs.readFileSync(rt, 'utf8').split('\n');
  const hits = body.map((l, i) => [i + 1, l]).filter(([, l]) => /require\(resolved|require\(chunkPath|runInThisContext|loadRuntimeChunkPath|require\(path\.resolve|= require\(/.test(l)).slice(0, 12);
  console.log('\n[runtime] chunk loading lines in [turbopack]_runtime.js:');
  for (const [n, l] of hits) console.log(`  ${n}: ${l.trim().slice(0, 160)}`);
}

startDev(); await waitUp();
console.log(`next dev ${NSFR ? '--no-server-fast-refresh' : '(server fast refresh 既定)'} 起動`);
await req('/hmr-s', '1 初回のコンパイルの要求');
watchChunks();
await req('/hmr-s', '2 2回目の要求');
chunkLayout('before edit');
runtimeLoading();
const pg = path.join(APP, 'src/app/hmr-s/page.tsx');
const tEdit = Date.now();
fs.writeFileSync(pg, fs.readFileSync(pg, 'utf8').replace('export default async function HmrS() {\n', `export default async function HmrS() {\n${Array.from({ length: 7 }, (_, i) => `  const z${i} = ${i};\n`).join('')}`));
console.log('\n# page.tsx に 7 文を足した（SA.tsx は変えていない）。要求を送らずに 4 秒待つ');
await sleep(4000);
console.log(`  書き込みの順序（保存の時点からの ms）: ${events.map((e) => `+${e.t - tEdit}ms ${e.ev} ${e.name}`).join(' ; ') || '（なし）'}`);
events.length = 0;
await req('/hmr-s', '3 変更の後の1回目の要求');
console.log(`  要求中の書き込み: ${events.map((e) => `${e.ev} ${e.name}`).join(' ; ') || '（なし）'}`);
events.length = 0;
await req('/hmr-s', '4 変更の後の2回目の要求');
chunkLayout('after edit');
const dbf = path.join(APP, 'src/lib/db.ts');
fs.writeFileSync(dbf, `${fs.readFileSync(dbf, 'utf8')}\n// shared lib edit (probe)\n`);
console.log('\n# 共有の lib/db.ts の末尾にコメントを足した（同じ生成物の後ろの区画）');
await sleep(4000);
await req('/hmr-s', '4b lib/db.ts の変更の後の要求');
chunkLayout('after db edit');
watcher?.close();
await stopDev();
startDev(); await waitUp();
console.log('\n# 開発サーバーを起動し直した');
await req('/hmr-s', '5 再起動の後の1回目の要求');
await req('/hmr-s', '6 再起動の後の2回目の要求');
await stopDev();
fs.writeFileSync(path.join(WORK, 'done'), '1');
process.exit(0);
