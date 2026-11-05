// 起動を押してから、パネルの状態（.rt-st b）と .rt-prog の有無を 20ms ごとに記録する（観測だけ。IDE も題材も変えない）
import { createRequire } from 'node:module';
const require = createRequire('/home/user/Visual-Computing-IDE/package.json');
const { chromium } = require('playwright-core');
const BASE = process.env.BASE; const PROJECT = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
const panel = () => page.locator('.fpnl[aria-label="プロジェクトと実行"]');
await panel().locator('#rt-path').fill(PROJECT);
await panel().locator('.rt-b', { hasText: '検出' }).click();
await page.locator('.rt-b.go:not(.off)').waitFor({ timeout: 15000 });
const t0 = Date.now();
await panel().locator('.rt-b.go', { hasText: '起動する' }).click();
const tl = []; let last = '';
while (Date.now() - t0 < 120000) {
  const s = await panel().evaluate((el) => `${el.querySelector('.rt-st b')?.textContent}|prog=${!!el.querySelector('.rt-prog')}`);
  if (s !== last) { tl.push(`${Date.now() - t0}ms ${s}`); last = s; }
  if (s.startsWith('実行中')) break;
  await page.waitForTimeout(20);
}
const startAt = parseInt((tl.find((x) => x.includes('起動中')) ?? 'NaN').split('ms')[0], 10);
const runAt = parseInt((tl.find((x) => x.includes('実行中')) ?? 'NaN').split('ms')[0], 10);
console.log(JSON.stringify({ timeline: tl, startingMs: runAt - startAt, wouldOldTestFail: runAt - startAt < 1500 }));
await panel().locator('.rt-b', { hasText: '停止する' }).click().catch(() => {});
await page.locator('.rt-st b', { hasText: '停止しています' }).waitFor({ timeout: 40000 }).catch(() => {});
await browser.close();
