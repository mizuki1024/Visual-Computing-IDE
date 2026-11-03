/* 7C HMR 安全対策 — 診断（試験ではない）: 同じ生成物に連結された「変更していない」モジュール（SA.tsx）の位置のずれ（第3の経路）。
 *   npm run build:lib && node docs/07c-hmr-lineage-guard-results/chunk-layout-probe.mjs [--nsfr]
 * 使い捨てのコピー（poc/out/probe-layout[-nsfr]）で next dev を起動し、page.tsx だけを変えた前後で、製品の resolveDataAccess
 * （修正後の A1〜A3 を含む）が SA の SQL をどこへ帰属させるかを並べる。--nsfr は --no-server-fast-refresh（比較のためだけ）。 */
// 診断: 初回コンパイルの時刻関係・生成物の中のモジュールの並び・フレームの形
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
const REPO = path.resolve(import.meta.dirname, '..', '..');
const WORK = path.join(REPO, 'poc', 'out', 'probe-layout' + (process.argv.includes('--nsfr') ? '-nsfr' : '') + '');
const APP = path.join(WORK, 'poc', 'fixture-app');
const SPAN = path.join(WORK, 'spans.jsonl');
const NSFR = process.argv.includes('--nsfr');
const PORT = NSFR ? 3494 : 3493;
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
const child = spawn(process.execPath, [path.join(APP, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(PORT), '-H', '127.0.0.1', ...(NSFR ? ['--no-server-fast-refresh'] : [])], { cwd: APP, env, stdio: 'ignore', detached: true });
process.on('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { r.resume(); r.on('end', () => res({ status: r.statusCode, trace: r.headers['x-vcide-trace'] })); }).on('error', (e) => res({ status: e.code })));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 200; i++) { const r = await get('/api/health-not-exist'); if (r.status === 404 || r.status === 200) break; await sleep(500); }
const rd = () => fs.readFileSync(SPAN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
async function req(p, label) {
  const t = Date.now();
  const r = await get(p); await sleep(3500);
  const tid = /^00-([0-9a-f]{32})/.exec(r.trace ?? '')?.[1];
  const recs = rd().filter((o) => o.traceId === tid);
  const roots = recs.filter((o) => o.type === 'span' && o.kind === 1 && !o.parentSpanId);
  const sqls = recs.filter((o) => o.type === 'span' && (o.attrs?.['db.statement']));
  console.log(`\n## ${label} ${p} status=${r.status} roots=${roots.length} rootStart=+${roots[0] ? (roots[0].startMs - t).toFixed(1) : '-'} rootPid=${roots[0]?.proc?.pid}`);
  for (const s of sqls) {
    const cs = recs.find((o) => o.type === 'callsite' && o.spanId === s.spanId);
    const fr = (cs?.entry?.frames ?? []).filter((f) => f.scope === 'build-output').slice(0, 2);
    console.log(`  SQL ${s.attrs['db.statement'].slice(0, 40)} start=+${(s.startMs - t).toFixed(1)} pid=${s.proc?.pid}`);
    for (const f of fr) {
      const abs = path.join(APP, f.file);
      const st = fs.statSync(abs), sm = fs.statSync(abs + '.map');
      console.log(`    frame ${f.functionName} ${path.basename(f.file)}:${f.line}:${f.col} chunk mtime=+${(st.mtimeMs - t).toFixed(1)} map mtime=+${(sm.mtimeMs - t).toFixed(1)}`);
    }
    console.log('    all scopes:', (cs?.entry?.frames ?? []).map((f) => f.scope + (f.scope === 'build-output' ? ':' + path.basename(f.file) : '')).join(' '));
  }
  return { tid, t };
}

const req2 = createRequire(path.join(REPO, 'package.json'));
process.chdir(REPO);
const DA = req2('./.libjs/server/dataAccess.js'); const AN = req2('./.libjs/server/anchors.js');
async function product(tid) {
  const recs = rd(); const spans = []; const pidOf = new Map(); const cs = new Map();
  for (const o of recs) {
    if (o.type === 'callsite' && o.traceId === tid) { const c = DA.parseCallsiteRecord(o); if (c) cs.set(c.spanId, [c]); }
    if (o.type === 'span' && o.traceId === tid) { spans.push({ ...o, attrs: o.attrs ?? {} }); if (o.proc?.pid) pidOf.set(o.spanId, o.proc.pid); }
  }
  const sql = spans.filter((x) => x.attrs['db.statement']).sort((a,b)=>a.startMs-b.startMs);
  const d = await DA.resolveDataAccess({ projectRoot: APP, sql: sql.map((x) => ({ span: x, pid: pidOf.get(x.spanId), request: DA.requestOfSql(spans, x).request })), callsites: cs, manifest: AN.readManifestComponents(path.join(WORK, 'anch')), enabled: true });
  for (const x of sql) { const r = d.find((y) => y.spanId === x.spanId); const fr = cs.get(x.spanId)?.[0]?.entry?.frames.find((f)=>f.scope==='build-output'); console.log(`  PRODUCT ${x.attrs['db.statement'].slice(0,45)} frame ${fr?.line}:${fr?.col} -> ${r.site ? r.site.file+':'+r.site.line+':'+r.site.col : '-'} ${r.failure?.reason ?? ''}`); }
}
const truth = () => { const l = fs.readFileSync(path.join(APP,'src/components/SA.tsx'),'utf8').split('\n'); return l.map((x,i)=>x.includes('pool.query')?`SA.tsx:${i+1}`:null).filter(Boolean).join(' '); };
let r = await req('/hmr-s', 'first'); await product(r.tid); console.log('  truth', truth());
r = await req('/hmr-s', 'second'); await product(r.tid);
const pg = path.join(APP, 'src/app/hmr-s/page.tsx');
fs.writeFileSync(pg, fs.readFileSync(pg, 'utf8').replace("export default async function HmrS() {\n", "export default async function HmrS() {\n" + Array.from({length: 7}, (_, i) => `  const z${i} = ${i};\n`).join('')));
console.log('\n# page.tsx に 7 文を足した（SA.tsx は変えていない）');
await sleep(4000);
r = await req('/hmr-s', 'after page edit'); await product(r.tid); console.log('  truth', truth());
r = await req('/hmr-s', 'after page edit 2'); await product(r.tid);
// chunk module order
const chunkDir = path.join(APP, '.next/dev/server/chunks/ssr');
for (const n of fs.readdirSync(chunkDir).filter((n) => n.endsWith('.js'))) {
  const body = fs.readFileSync(path.join(chunkDir, n), 'utf8');
  const heads = [...body.matchAll(/^"(\[project\]\/src\/[^"]+)", \(\(__turbopack_context__\)/gm)].map((m) => `${body.slice(0, m.index).split('\n').length}:${m[1]}`);
  if (heads.some((h) => h.includes('hmr-s') || h.includes('SA.tsx'))) console.log('\nchunk', n, heads);
}
fs.writeFileSync(path.join(WORK, 'done'), '1');
process.exit(0);
