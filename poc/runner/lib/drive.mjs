/* =============================================================================
 * ブラウザ側の観測（02d の source = browser-network / L0）。
 * 取るのは メソッド・パス・ステータス・所要時間 と、応答に載ってきたトレースIDだけ。
 * ヘッダ一覧・本文・Cookie は読まない。
 * ========================================================================== */
import { chromium } from 'playwright-core';
import { APP_PORT } from './util.mjs';

const BASE = `http://localhost:${APP_PORT}`;

/** 静的資材は「通信」として数えない。除外したことは件数で残す。 */
const isAsset = (p) =>
  p.startsWith('/_next/') || p.startsWith('/__next') || p.startsWith('/__nextjs')
  || p === '/favicon.ico' || /\.(js|css|map|woff2?|png|svg|ico)$/.test(p);

/** Server-Timing: traceparent;desc="00-<traceId>-<spanId>-01" を読む */
function parseServerTiming(v) {
  if (!v) return null;
  const m = /traceparent;desc="00-([0-9a-f]{32})-([0-9a-f]{16})-\d\d"/.exec(v);
  return m ? { traceId: m[1], spanId: m[2] } : null;
}

/**
 * ページを開いて、そのページで起きた通信を記録する。
 * @param {string[]} paths 開くページのパス
 * @param {{after?: (page: import('playwright-core').Page, path: string) => Promise<unknown>,
 *          waitFor?: string}} [opts]
 *   after   通信記録のあとに追加の観測を行う差し込み口（PoC-03 の要素観測で使う）
 *   waitFor 先に出現を待つセレクタ
 */
export async function drivePages(paths, opts = {}) {
  const browser = await chromium.launch({ channel: 'chrome' });
  const out = [];
  try {
    for (const p of paths) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const records = [];
      let excludedAssets = 0;

      // 応答イベントの時点では responseEnd が未確定なので、要求オブジェクトを
      // 覚えておき、ページが落ち着いたあとに所要時間を読む
      const pending = [];
      page.on('response', (res) => {
        const req = res.request();
        let url;
        try { url = new URL(res.url()); } catch { return; }
        if (url.origin !== BASE) return;
        if (isAsset(url.pathname)) { excludedAssets++; return; }
        // ヘッダは Server-Timing の1つだけを取り出し、他は保持しない
        let st = null;
        try { st = res.headers()['server-timing'] ?? null; } catch { /* noop */ }
        pending.push({
          req,
          method: req.method(),
          path: url.pathname,
          status: res.status(),
          resourceType: req.resourceType(),
          server: parseServerTiming(st),
        });
      });

      const t0 = Date.now();
      // networkidle は開発サーバーの常時接続で落ち着かないことがある。
      // load を待ってから、クライアント側の fetch（水和のあとに走る）を待つ
      await page.goto(`${BASE}${p}`, { waitUntil: 'load', timeout: 90000 });
      await page.waitForResponse((r) => new URL(r.url()).pathname.startsWith('/api/'),
        { timeout: 30000 }).catch(() => null);
      if (opts.waitFor) {
        await page.waitForSelector(opts.waitFor, { timeout: 30000 }).catch(() => null);
      }
      await page.waitForTimeout(900);
      const navMs = Date.now() - t0;
      const extra = opts.after ? await opts.after(page, p) : null;

      for (const e of pending) {
        let t = null;
        try { t = e.req.timing(); } catch { /* 取れないことがある */ }
        records.push({
          method: e.method, path: e.path, status: e.status, resourceType: e.resourceType,
          server: e.server,
          startMsEpoch: t ? t.startTime : null,
          // responseEnd は要求開始からの相対ミリ秒。負の値は「取れなかった」
          durationMs: t && t.responseEnd >= 0 ? +t.responseEnd.toFixed(2) : null,
        });
      }
      out.push({ page: p, navMs, excludedAssets, requests: records, extra });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

/** 直接の連打。取得率の分母を増やすために使う（ブラウザを介さない） */
export async function hammer(paths, times) {
  const latencies = [];
  for (let i = 0; i < times; i++) {
    for (const p of paths) {
      const t0 = performance.now();
      const r = await fetch(`${BASE}${p}`);
      await r.arrayBuffer();
      latencies.push({ path: p, ms: performance.now() - t0, status: r.status });
    }
  }
  return latencies;
}
