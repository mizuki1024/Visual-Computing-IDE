/* =============================================================================
 * EP-12 方式 B の比較実験 — 隔離した作業コピーで変更案を実描画する。
 *
 * 利用者の作業ツリー（ここでは poc/fixture-edit）には書かない。
 *   1. poc/out/edit-shadow/<id>/ に、src と設定だけを写す（node_modules は写さずシンボリックリンク）
 *   2. 写しの中でだけ p-4 → p-5 を適用する（同じ engine.applyOne。基準ハッシュの照合つき）
 *   3. 写しで 2つ目の next dev を別ポートで起動し、375 / 1440 で計算済み padding を測る
 *   4. 起動・初回の描画に掛かった時間、写しの大きさ、メモリを記録する
 *   5. 開発サーバーを止め、写しを消す。題材が1バイトも変わっていないことを確かめる
 * 結果は docs/06h-results/method-b.json。
 * ========================================================================== */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FIXTURE = path.join(REPO, 'poc/fixture-edit');
const E = require('./engine.cjs');
const PORT = 3270;
const id = crypto.randomBytes(4).toString('hex');
const SHADOW = path.join(REPO, 'poc/out/edit-shadow', id);
const REL = 'src/components/PropertyCard.tsx';
const out = { at: new Date().toISOString(), method: 'B: isolated working copy + second next dev', steps: [] };
const step = (k, v) => { out.steps.push({ k, ...v }); console.log(k, JSON.stringify(v)); };

const fixtureRev0 = E.revisionOf(FIXTURE).id;
const t0 = Date.now();
fs.mkdirSync(SHADOW, { recursive: true });
for (const f of ['src', 'next.config.mjs', 'postcss.config.mjs', 'package.json', 'tsconfig.json']) {
  fs.cpSync(path.join(FIXTURE, f), path.join(SHADOW, f), { recursive: true });
}
/* NM=symlink: 写しの外を指すシンボリックリンク（Turbopack は root の外を解決しない — 1回目の結果）
 * NM=hardlink: ハードリンクの写し（データは複製しないが、ファイル数ぶんの inode を使う） */
const NM = process.env.NM ?? 'hardlink';
out.nodeModules = NM;
if (NM === 'symlink') fs.symlinkSync(path.join(FIXTURE, 'node_modules'), path.join(SHADOW, 'node_modules'), 'dir');
else execFileSync('cp', ['-al', path.join(FIXTURE, 'node_modules'), path.join(SHADOW, 'node_modules')]);
const du = (p) => Number(execFileSync('du', ['-sk', '--exclude=node_modules', p]).toString().split('\t')[0]);
step('copy', { ms: Date.now() - t0, kbWithoutNodeModules: du(SHADOW), nodeModules: NM });

/* 写しの中でだけ適用する */
const src = fs.readFileSync(path.join(SHADOW, REL), 'utf8');
const loc = E.locateClassToken(src, REL, { line: 7, col: 5, tag: 'div', component: 'PropertyCard' }, 'p-4', 'p-5');
const ap = E.applyOne({ root: SHADOW, rel: REL, baseHash: E.sha256(src), start: loc.start, end: loc.end, from: 'p-4', to: 'p-5' });
step('apply-in-copy', { status: ap.status, fixtureUnchanged: E.revisionOf(FIXTURE).id === fixtureRev0 });

const bin = path.join(FIXTURE, 'node_modules/next/dist/bin/next');
const t1 = Date.now();
const dev = spawn(process.execPath, [bin, 'dev', '-p', String(PORT), '-H', '127.0.0.1'], {
  cwd: SHADOW, env: { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
let log = '';
dev.stdout.on('data', (d) => { log += d; }); dev.stderr.on('data', (d) => { log += d; });
const get = () => new Promise((r) => { const q = http.get({ host: '127.0.0.1', port: PORT, path: '/properties' }, (res) => { res.resume(); r(res.statusCode); }); q.on('error', () => r(0)); });
let code = 0;
for (let i = 0; i < 240 && code !== 200; i++) { code = await get(); if (code !== 200) await new Promise((r) => setTimeout(r, 250)); }
step('first-200', { ok: code === 200, ms: Date.now() - t1 });

let result = null;
if (code === 200) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  result = {};
  for (const [name, w, h] of [['Mobile', 375, 812], ['Desktop', 1440, 900]]) {
    const pg = await browser.newPage({ viewport: { width: w, height: h } });
    const t2 = Date.now();
    await pg.goto(`http://127.0.0.1:${PORT}/properties`);
    result[name] = {
      ms: Date.now() - t2,
      pads: await pg.$$eval('ul > li > div', (els) => [...new Set(els.map((e) => getComputedStyle(e).paddingTop))]),
      count: await pg.$$eval('ul > li > div', (els) => els.length),
      control: await pg.$eval('main > section', (e) => getComputedStyle(e).paddingTop),
    };
    await pg.close();
  }
  await browser.close();
}
step('measure', result ?? { skipped: true });
let rssKb = null;
try {
  const pids = execFileSync('pgrep', ['-g', String(dev.pid)]).toString().trim().split('\n');
  rssKb = pids.reduce((s, p) => { try { return s + Number(fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]); } catch { return s; } }, 0);
} catch { /* 取れない */ }
step('memory', { rssKb, note: '2つ目の開発サーバーのプロセスグループの RSS 合計' });

try { process.kill(-dev.pid, 'SIGTERM'); } catch { /* 終了済み */ }
await new Promise((r) => setTimeout(r, 1500));
try { process.kill(-dev.pid, 'SIGKILL'); } catch { /* 終了済み */ }
fs.rmSync(SHADOW, { recursive: true, force: true });
step('cleanup', { removed: !fs.existsSync(SHADOW), fixtureUnchanged: E.revisionOf(FIXTURE).id === fixtureRev0 });
out.devLogHead = log.split('\n').slice(0, 30).join('\n');
out.devLogTail = log.split('\n').slice(-8).join('\n');
fs.mkdirSync(path.join(REPO, 'docs/06h-results'), { recursive: true });
fs.writeFileSync(path.join(REPO, `docs/06h-results/method-b-${NM}.json`), JSON.stringify(out, null, 1));
