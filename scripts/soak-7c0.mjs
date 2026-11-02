/* =============================================================================
 * Phase 7C-0 — 長時間起動の計測（上限つき）。記録用のスクリプトで、試験ではない。
 *   BASE=http://127.0.0.1:3100 node scripts/soak-7c0.mjs
 *
 * IDE の画面から題材を起動し、プレビューの中継へ一定の速さで要求を送り続ける。
 * 区切りごとに、収集ファイルの量・観測 API の応答時間と大きさ・セッションの件数を記録する。
 * 途中（通信の上限 200 件を超えた後）で、画面から要素を選んで文書の同定が成り立つかを見る。
 *   VCIDE_SOAK_TOTAL  送る要求の数（既定 1500）
 *   VCIDE_SOAK_RPS    1 秒あたりの要求（既定 5。並列にしない）
 *   VCIDE_SOAK_OUT    記録の JSON
 * ========================================================================== */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const PROJECT = process.env.VCIDE_ACC_PROJECT ?? path.join(REPO, 'poc', 'fixture-app');
const TOTAL = Number(process.env.VCIDE_SOAK_TOTAL ?? 1500);
const RPS = Number(process.env.VCIDE_SOAK_RPS ?? 5);
const OUT = process.env.VCIDE_SOAK_OUT ?? null;
const PATHS = ['/lin-a', '/rsc-db', '/api/listings', '/lin-c', '/rsc-parallel'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = { startedAt: new Date().toISOString(), total: TOTAL, rps: RPS, points: [], picks: [] };

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL === 'none' ? undefined : 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const rt = page.locator('.fpnl[aria-label="プロジェクトと実行"]');
const pv = () => page.locator('section[aria-label="プレビュー"] .pvlive');
await rt.locator('#rt-path').fill(PROJECT);
await rt.locator('.rt-b', { hasText: '検出' }).click();
await page.waitForFunction((x) => document.querySelector('.fpnl[aria-label="プロジェクトと実行"] .rt-ins')?.getAttribute('data-input') === x, PROJECT, { timeout: 30000 });
await rt.locator('.rt-b.go', { hasText: '起動する' }).click();
await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') === 'live', null, { timeout: 240000 });
const st = await page.evaluate(async () => (await fetch('/api/runtime/status')).json());
const run = { instance: st.runtime.instance, pid: st.runtime.pid, startedAt: st.runtime.startedAt };
const origin = st.preview.origin;
const spanFile = st.runtime.instrumentation.spanFile;
console.log(`起動: PID ${run.pid} / 中継 ${origin} / 収集 ${spanFile}`);

async function obsPoint(sent) {
  const t0 = performance.now();
  const r = await page.evaluate(async (run) => {
    const res = await fetch('/api/runtime/observations', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vcide-request': '1' }, body: JSON.stringify({ run }) });
    const text = await res.text();
    const j = JSON.parse(text);
    return { bytes: text.length, ex: j.observation?.exchanges.length ?? null, overflow: j.observation?.session.overflow ?? null, spans: j.observation?.spans.length ?? null, truncated: j.observation?.truncated ?? null };
  }, run);
  const p = { sent, t: Date.now(), apiMs: Math.round(performance.now() - t0), apiBytes: r.bytes, exchanges: r.ex, overflow: r.overflow, spans: r.spans, spanFileBytes: fs.statSync(spanFile).size };
  rec.points.push(p);
  console.log(JSON.stringify(p));
}

async function pickNow(label) {
  const n = Number(await pv().getAttribute('data-loads'));
  await pv().locator('input[aria-label="プレビューのパス"]').fill('/lin-a');
  await pv().locator('.rt-b', { hasText: '移動' }).click();
  await page.waitForFunction((k) => Number(document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-loads')) > k, n, { timeout: 60000 });
  await sleep(800);
  if ((await pv().getAttribute('data-select-mode')) !== 'on') await pv().locator('.rt-b', { hasText: '選択' }).click();
  await sleep(500);
  await page.frameLocator('section[aria-label="プレビュー"] iframe.pvframe').locator('li[data-poc-field="a-region"]').first().click();
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !(await pv().getAttribute('data-lineage'))) await sleep(250);
  await sleep(500);
  const x = { label, binding: await pv().getAttribute('data-doc-binding'), lineage: await pv().getAttribute('data-lineage'), reason: await pv().getAttribute('data-lineage-reason'), cands: await pv().getAttribute('data-lineage-cands'), line: await pv().locator('.pvlin').innerText().catch(() => '') };
  await pv().locator('.rt-b', { hasText: '選択' }).click();
  rec.picks.push(x);
  console.log('PICK', JSON.stringify(x));
}

await obsPoint(0);
await pickNow('最初');
let sent = 0;
const gap = 1000 / RPS;
while (sent < TOTAL) {
  const t = performance.now();
  const p = PATHS[sent % PATHS.length];
  await fetch(`${origin}${p}`, { headers: { accept: 'text/html' } }).then((r) => r.arrayBuffer()).catch(() => null);
  sent += 1;
  if (sent % 100 === 0) await obsPoint(sent);
  if (sent === 250) await pickNow('通信が 200 件を超えた後');
  const rest = gap - (performance.now() - t);
  if (rest > 0) await sleep(rest);
}
await pickNow('最後');
await obsPoint(sent);
const t0 = Date.now();
await rt.locator('.rt-b', { hasText: '停止する' }).click();
await page.waitForFunction(() => document.querySelector('section[aria-label="プレビュー"] .pvlive')?.getAttribute('data-preview-state') === 'stopped', null, { timeout: 60000 });
rec.stopMs = Date.now() - t0;
rec.stoppedPid = run.pid;
rec.finishedAt = new Date().toISOString();
if (OUT) fs.writeFileSync(OUT, JSON.stringify(rec, null, 1));
await browser.close();
