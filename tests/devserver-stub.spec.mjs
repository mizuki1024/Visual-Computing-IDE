/* =============================================================================
 * Phase 7A — 起動の待ちが切れる経路と、対象ファイルの変化の観測（R2 / R3 / R4）。
 *   node tests/devserver-stub.spec.mjs
 *
 * 実際の Next.js では再現に数分かかる、または環境に依存する経路を、
 * **next の代わりに置いた小さなスクリプト**で確かめる。IDE 側のコード
 * （DevServerManager）は本物をそのまま使う。代役は検出が認める位置
 * （node_modules/next/dist/bin/next）に置くだけである。
 *
 * 代役が真似るのは、実測で観測した Next.js の出力の文言だけである。
 *   - R3: blog-app（Next 16.2.6）の「Detected additional lockfiles」と「○ Compiling / ...」
 *   - R4: blog-app の「We detected TypeScript in your project and reconfigured your tsconfig.json」
 * 実物の Next.js での確認は tests/devserver.spec.mjs と tests/runtime-e2e.spec.mjs が行う。
 * ========================================================================== */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// 待ちが切れる経路を 180 秒待たずに見るため、IDE 側の待ち時間だけを縮める（モジュールを読む前に設定する）
process.env.VCIDE_START_TIMEOUT_MS = '4000';

const require_ = createRequire(import.meta.url);
const DS = require_('../.libjs/server/devServer.js');
const IDE = require_('../.libjs/server/ide.js');
const SO = require_('../.libjs/lib/snapshotOrder.js');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const aliveNow = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function freePort(from) {
  for (let p = from; p < from + 60; p++) {
    const got = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (got) return p;
  }
  throw new Error('空きポートが見つかりません');
}

/* ------------------------------------------------------------- 代役を組む */
const FIX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-stub-')));
process.on('exit', () => { try { fs.rmSync(FIX, { recursive: true, force: true }); } catch { /* 残っても害はない */ } });
const mk = (rel, body) => {
  const p = path.join(FIX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

/** next の代役。`dev -p PORT -H HOST` を受け取り、mode に応じて振る舞う */
const STUB = (mode) => `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const a = process.argv.slice(2);
const port = Number(a[a.indexOf('-p') + 1]);
const host = a[a.indexOf('-H') + 1];
console.log('ENV ' + JSON.stringify(Object.fromEntries(['NODE_ENV', 'PORT', '__NEXT_PRIVATE_ORIGIN', 'TURBOPACK', 'NEXT_RUNTIME', 'npm_package_name', 'npm_config_https_proxy', 'VCIDE_USER_VAR'].map((k) => [k, process.env[k] ?? null]))));
console.log('   ▲ Next.js 16.2.6 (Turbopack)');
console.log('   - Local:        http://' + host + ':' + port);
if (${JSON.stringify(mode)} === 'hang') {
  console.warn(' ⚠ Warning: Next.js inferred your workspace root, but it may not be correct.');
  console.warn(' We detected multiple lockfiles and selected the directory of ' + ${JSON.stringify(FIX)} + ' as the root directory.');
  console.warn(' Detected additional lockfiles: ');
  console.warn('   * ' + process.cwd() + '/package-lock.json');
  console.log(' ✓ Ready in 900ms');
  setTimeout(() => console.log(' ○ Compiling / ...'), 300);
  setInterval(() => {}, 1000);   // 待ち受けずに居続ける（応答しない）
} else {
  if (${JSON.stringify(mode)} === 'writes') {
    const tc = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
    tc.compilerOptions = { ...(tc.compilerOptions || {}), isolatedModules: true };
    fs.writeFileSync('tsconfig.json', JSON.stringify(tc, null, 2) + '\\n');
    fs.writeFileSync('next-env.d.ts', '/// <reference types="next" />\\n');
    console.log('   We detected TypeScript in your project and reconfigured your tsconfig.json file for you.');
  }
  http.createServer((q, r) => { r.end('ok'); }).listen(port, host, () => console.log(' ✓ Ready in 120ms'));
}
`;
const stubProject = (rel, mode, extra = {}) => {
  mk(`${rel}/package.json`, JSON.stringify({ name: path.basename(rel), dependencies: { next: '^16.0.0' } }));
  mk(`${rel}/node_modules/next/package.json`, JSON.stringify({ name: 'next', version: '16.2.6' }));
  mk(`${rel}/node_modules/next/dist/bin/next`, STUB(mode));
  mk(`${rel}/app/page.${extra.ts ? 'tsx' : 'jsx'}`, 'export default function P() { return null }\n');
  mk(`${rel}/package-lock.json`, '{}');
  if (extra.ts) {
    mk(`${rel}/tsconfig.json`, '{\n  "compilerOptions": {}\n}\n');
    for (const d of ['typescript', '@types/react', '@types/node']) {
      mk(`${rel}/node_modules/${d}/package.json`, JSON.stringify({ name: d, version: '0.0.0' }));
    }
  }
  return path.join(FIX, rel);
};
mk('package-lock.json', '{}');                       // R3: プロジェクトより上の lockfile
const HANG = stubProject('hang-app', 'hang');
const WRITES = stubProject('writes-app', 'writes', { ts: true });
const QUIET = stubProject('quiet-app', 'quiet', { ts: true });

fs.rmSync(IDE.stateFilePath(), { force: true });

/* ============================================ 0. 応答の新旧判定（R2） */
console.log('\n0. 画面は操作中も状態を取り続け、古い応答だけを捨てる（R2）');
{
  const a = { instance: 'A', seq: 5 };
  eq('手元が無ければ反映する', SO.isNewerSnapshot(null, a), true);
  eq('新しい seq は反映する', SO.isNewerSnapshot(a, { instance: 'A', seq: 6 }), true);
  eq('同じ seq も反映する（進み具合・HTTP の観測は seq を変えずに進む）', SO.isNewerSnapshot(a, { instance: 'A', seq: 5 }), true);
  eq('古い seq は捨てる（起動の応答の後に届いた、起動前の取得結果）', SO.isNewerSnapshot(a, { instance: 'A', seq: 4 }), false);
  eq('IDE が再起動して seq が数え直しになっても反映する', SO.isNewerSnapshot(a, { instance: 'B', seq: 1 }), true);
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'state', 'RuntimeStore.tsx'), 'utf8');
  ok('RuntimeStore は操作中に取得を止めていない（pendingRef による早期 return が無い）',
    !/pendingRef/.test(src) && /isNewerSnapshot/.test(src));
  const m = new DS.DevServerManager();
  const s = m.snapshot();
  ok('スナップショットは instance を持つ', typeof s.instance === 'string' && s.instance.length > 8, s.instance);
  ok('管理実体ごとに instance が違う', new DS.DevServerManager().snapshot().instance !== s.instance);
}

/* =================================== 1. 待ちが切れたときの説明（R3） */
console.log('\n1. 応答しないまま待ちが切れる — 理由を先に、壊れているとは書かない（R3）');
{
  const m = new DS.DevServerManager();
  const port = await freePort(3600);
  const seen = [];
  let progressLine = null;
  const sampler = setInterval(() => {
    const s = m.snapshot();
    if (seen[seen.length - 1] !== s.state) seen.push(s.state);
    if (s.state === 'starting' && s.progress) progressLine = s.progress.line;
  }, 50);
  const s = await m.start({ project: HANG, port, instrument: false });
  clearInterval(sampler);

  const pre = m.lastInspection();
  ok('起動前の検出で、上の階層の lockfile を所見に出している',
    pre?.findings.some((f) => f.code === 'ancestor-root-marker'), pre?.findings.map((f) => f.code));
  ok('起動中は running にならない', !seen.includes('running'), seen);
  ok('起動中の進み具合として Next.js の出力をそのまま持つ', /Compiling/.test(progressLine ?? ''), progressLine);
  eq('待ちが切れたら error', s.state, 'error');
  eq('理由コードは start-timeout', s.error?.code, 'start-timeout');
  ok('ルートの推定が関わっている証拠を理由に書く',
    /ワークスペースのルートを推定/.test(s.error?.reason ?? '') && s.error.reason.includes(path.join(FIX, 'package-lock.json')),
    s.error?.reason);
  ok('「プロジェクトが壊れている」と書かない',
    !/壊れて(い|お)ます|不具合があります/.test(`${s.error?.fact}${s.error?.reason}`)
    && /わかりません/.test(s.error?.impact ?? ''), s.error?.impact);
  ok('次の操作として turbopack.root を示す', /turbopack\.root/.test(s.error?.action ?? ''), s.error?.action);
  ok('最後の出力を添えている', /Compiling/.test(s.error?.reason ?? ''), s.error?.reason);
  ok('IDE はプロセスを止めている', s.pid === null || !aliveNow(s.pid), s.pid);
  eq('台帳を残していない', fs.existsSync(IDE.stateFilePath()), false);
}

/* ======================= 2. 対象ファイルの変化を、主体を明示して出す（R4） */
console.log('\n2. next dev が書き換えた対象ファイルを、観測した事実として出す（R4）');
{
  const m = new DS.DevServerManager();
  const port = await freePort(3620);
  const tsBefore = fs.readFileSync(path.join(WRITES, 'tsconfig.json'), 'utf8');
  const s = await m.start({ project: WRITES, port, instrument: false });
  eq('起動できる', s.state, 'running');
  const c = s.targetChanges;
  ok('変化を観測した', !!c, c);
  eq('重大度は「限定」', c?.severity, 'limit');
  ok('変わったファイルを具体的に書く', /tsconfig\.json（変更）/.test(c?.fact ?? '') && /next-env\.d\.ts（作成）/.test(c?.fact ?? ''), c?.fact);
  ok('Next.js の出力を証拠として示す', /reconfigured your tsconfig\.json/.test(c?.reason ?? ''), c?.reason);
  ok('IDE は書き込まないと明記する', /IDE は対象プロジェクトに書き込みません/.test(c?.reason ?? ''), c?.reason);
  ok('IDE が元に戻していないことを書く', /元に戻していません/.test(c?.impact ?? ''), c?.impact);
  ok('実際に tsconfig.json は変わっている（観測の裏付け）',
    fs.readFileSync(path.join(WRITES, 'tsconfig.json'), 'utf8') !== tsBefore);
  const stopped = await m.stop();
  eq('停止できる', stopped.state, 'stopped');
  ok('停止後も、観測した変化は残して見せる', !!stopped.targetChanges, stopped.targetChanges);
  // 再起動しても消さない（代役は2回目も書くが、内容は同じなので2回目だけを見れば「変化なし」になる）
  const again = await m.start({ project: WRITES, port: await freePort(3630), instrument: false });
  eq('再起動できる', again.state, 'running');
  ok('再起動しても、最初の起動からの変化として残して見せる', /tsconfig\.json（変更）/.test(again.targetChanges?.fact ?? ''), again.targetChanges);
  ok('出力の証拠も起動をまたいで残す', /reconfigured your tsconfig\.json/.test(again.targetChanges?.reason ?? ''), again.targetChanges?.reason);
  await m.stop();
}
{
  const m = new DS.DevServerManager();
  const port = await freePort(3640);
  const s = await m.start({ project: QUIET, port, instrument: false });
  eq('書き換えない代役でも起動できる', s.state, 'running');
  eq('変化が無ければ何も出さない（推測で出さない）', s.targetChanges, null);
  await m.refresh();
  eq('確認し直しても出さない', m.snapshot().targetChanges, null);
  await m.stop();
}

/* ================= 3. IDE 自身の実行時の環境変数を、対象の next dev に渡さない */
console.log('\n3. IDE 自身の実行時の環境変数を、対象の next dev に渡さない');
{
  const polluted = {
    NODE_ENV: 'production', PORT: '3101', __NEXT_PRIVATE_ORIGIN: 'http://127.0.0.1:3101',
    TURBOPACK: '1', NEXT_RUNTIME: 'nodejs', NEXT_PRIVATE_START_TIME: '1', NEXT_DEPLOYMENT_ID: '',
    npm_package_name: 'visual-computing-ide', npm_lifecycle_event: 'dev',
    npm_config_https_proxy: 'http://proxy.example:8080', NODE_OPTIONS: '--use-openssl-ca', PATH: '/usr/bin',
  };
  const e = DS.childEnv(polluted);
  for (const k of ['NODE_ENV', 'PORT', '__NEXT_PRIVATE_ORIGIN', 'TURBOPACK', 'NEXT_RUNTIME', 'NEXT_PRIVATE_START_TIME',
    'NEXT_DEPLOYMENT_ID', 'npm_package_name', 'npm_lifecycle_event']) {
    eq(`${k} は渡さない（IDE の実行時の状態）`, k in e, false);
  }
  eq('利用者のプロキシ設定は渡す', e.npm_config_https_proxy, 'http://proxy.example:8080');
  eq('利用者の NODE_OPTIONS は渡す', e.NODE_OPTIONS, '--use-openssl-ca');
  eq('PATH は渡す', e.PATH, '/usr/bin');
  eq('テレメトリは切る', e.NEXT_TELEMETRY_DISABLED, '1');

  // 実際に起動して、子のプロセスが受け取った環境を見る（IDE が Next の上で動いている状態を再現する）
  const saved = {};
  const set = { NODE_ENV: 'production', PORT: '3101', __NEXT_PRIVATE_ORIGIN: 'http://127.0.0.1:3101', TURBOPACK: '1',
    NEXT_RUNTIME: 'nodejs', npm_package_name: 'visual-computing-ide', VCIDE_USER_VAR: 'kept' };
  for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
  const m = new DS.DevServerManager();
  const s = await m.start({ project: QUIET, port: await freePort(3660), instrument: false });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  eq('起動できる', s.state, 'running');
  const line = m.logs(50).lines.find((l) => l.startsWith('ENV '));
  const got = line ? JSON.parse(line.slice(4)) : {};
  eq('子は NODE_ENV=production を受け取らない', got.NODE_ENV, null);
  eq('子は IDE のポートを受け取らない', got.PORT, null);
  eq('子は IDE の URL（__NEXT_PRIVATE_ORIGIN）を受け取らない', got.__NEXT_PRIVATE_ORIGIN, null);
  eq('子は TURBOPACK を受け取らない', got.TURBOPACK, null);
  eq('子は IDE の package 名を受け取らない', got.npm_package_name, null);
  eq('利用者の環境変数は届く', got.VCIDE_USER_VAR, 'kept');
  await m.stop();
}

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
