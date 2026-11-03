/* 7C HMR 最終安全対策 — 診断（試験ではない）: ソースマップと生成物の「組」が同じ世代かを、内容だけで確かめられるか。
 *   node docs/07c-hmr-final-safety-results/map-fit-probe.mjs
 * Turbopack は生成物（.js）とソースマップ（.js.map）を別々に書き、その順序は一定でない（identity-probe の記録: 1回目は map→js、
 * 2回目は js→map）。書き込みの合間に読むと、片方だけ新しい組を読みうる。
 * ここでは page.tsx だけを変える前後の生成物とソースマップを複写し、同じ世代の組（js1+map1・js2+map2）と
 * 世代の違う組（js2+map1・js1+map2）について、ソースマップの区画の開始行がモジュールの見出し（区画）とどう並ぶか、
 * 区画の各セグメントの生成側の列が生成物の行の長さに収まるか、を数える。 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
import { createRequire } from 'node:module';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const WORK = path.join(REPO, 'poc', 'out', 'probe-mapfit');
const APP = path.join(WORK, 'poc', 'fixture-app');
const PORT = 3497;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CR = createRequire(import.meta.url)(path.join(REPO, 'poc/fixture-app/ide-instrumentation/chunkregions.cjs'));
const { mapFit } = await import(path.join(REPO, 'poc/runner/lib/srvmap.mjs'));

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
const env = { ...process.env, POC03_ANCHOR: '1', POC03_ANCHOR_OUT: path.join(WORK, 'anch') };
const child = spawn(process.execPath, [path.join(APP, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(PORT), '-H', '127.0.0.1'], { cwd: APP, env, stdio: 'ignore', detached: true });
process.on('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 終わっている */ } });
const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }).on('error', (e) => res(e.code)));
for (let i = 0; i < 240; i++) { const s = await get('/api/none'); if (s === 404 || s === 200) break; await sleep(500); }
const dir = path.join(APP, '.next/dev/server/chunks/ssr');
const chunkName = () => fs.readdirSync(dir).filter((n) => n.endsWith('.js')).find((n) => fs.readFileSync(path.join(dir, n), 'utf8').includes('[project]/src/components/SA.tsx'));
await get('/hmr-s'); await sleep(2500);
const n = chunkName();
const g1 = { js: fs.readFileSync(path.join(dir, n), 'utf8'), map: fs.readFileSync(path.join(dir, `${n}.map`), 'utf8') };
const pg = path.join(APP, 'src/app/hmr-s/page.tsx');
fs.writeFileSync(pg, fs.readFileSync(pg, 'utf8').replace('export default async function HmrS() {\n', `export default async function HmrS() {\n${Array.from({ length: 7 }, (_, i) => `  const z${i} = ${i};\n`).join('')}`));
await sleep(3000); await get('/hmr-s'); await sleep(2500);
const g2 = { js: fs.readFileSync(path.join(dir, n), 'utf8'), map: fs.readFileSync(path.join(dir, `${n}.map`), 'utf8') };
/* 1文字だけ（SA の中の列）を変えた3つ目の世代: 区画の並びは変わらず、SA の区画の中だけが変わる */
const sa = path.join(APP, 'src/components/SA.tsx');
fs.writeFileSync(sa, fs.readFileSync(sa, 'utf8').replace('const n3 = n2 + 1;', 'const n3 = n2 + 10;'));
await sleep(3000); await get('/hmr-s'); await sleep(2500);
const g3 = { js: fs.readFileSync(path.join(dir, n), 'utf8'), map: fs.readFileSync(path.join(dir, `${n}.map`), 'utf8') };

const show = (label, js, mapText) => {
  const r = mapFit(js, JSON.parse(mapText));
  console.log(`${label.padEnd(22)} fit=${r.fit ? 'yes' : 'NO '} sections=${r.sections} regions=${r.regions} reason=${r.reason ?? '-'}${r.detail ? ` (${r.detail})` : ''}`);
};
console.log(`chunk ${n}`);
console.log(`regions g1: ${CR.chunkRegions(g1.js).map((x) => x.start).join(',')}  g2: ${CR.chunkRegions(g2.js).map((x) => x.start).join(',')}  g3: ${CR.chunkRegions(g3.js).map((x) => x.start).join(',')}`);
show('js1+map1（同じ世代）', g1.js, g1.map);
show('js2+map2（同じ世代）', g2.js, g2.map);
show('js3+map3（同じ世代）', g3.js, g3.map);
show('js2+map1（世代違い）', g2.js, g1.map);
show('js1+map2（世代違い）', g1.js, g2.map);
show('js3+map2（世代違い・区画内だけ）', g3.js, g2.map);
show('js2+map3（世代違い・区画内だけ）', g2.js, g3.map);
/* 実在の全生成物で、同じ世代の組が必ず「合う」か（偽の不一致が無いか） */
let all = 0; let bad = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && fs.existsSync(path.join(dir, `${x}.map`)))) {
  all++;
  const r = mapFit(fs.readFileSync(path.join(dir, f), 'utf8'), JSON.parse(fs.readFileSync(path.join(dir, `${f}.map`), 'utf8')));
  if (!r.fit) { bad++; console.log(`  同じ世代なのに合わない: ${f} ${r.reason} ${r.detail ?? ''}`); }
}
console.log(`同じ世代の組（.next/dev/server/chunks/ssr の全生成物）: ${all} 組中 ${all - bad} 組が合う`);
try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 終わっている */ }
fs.rmSync(WORK, { recursive: true, force: true });
process.exit(0);
