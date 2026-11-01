/* =============================================================================
 * ブラウザ側の通信観測（PoC-05）。CDP の Network ドメインを使う。
 *
 * **取るもの**
 *   ブラウザ内の要求識別子（requestId）/ メソッド / パス / ステータス /
 *   失敗の種別 / 開始時刻 / 所要時間 / リダイレクトの段 /
 *   相関用ヘッダ **2つの値だけ** / initiator の種別とスタックの先頭フレーム
 *
 * **取らないもの**
 *   ヘッダ一覧（2つのキー以外は取り出さない。生の headers を保存しない）/
 *   リクエスト・レスポンス本文 / Cookie / Authorization / クエリ文字列の値
 *
 * 設計上の要点: 相関の鍵は **応答ヘッダに載ったトレース識別子** である。
 * 時刻は記録するが、**対応付けの判断には使わない**（PoC-01 2.5節の実測による）。
 * ========================================================================== */
import { chromium } from 'playwright-core';

/** 静的資材は「通信」として数えない。除外したことは件数で残す。 */
const isAsset = (p) =>
  p.startsWith('/_next/') || p.startsWith('/__next') || p.startsWith('/__nextjs')
  || p === '/favicon.ico' || /\.(js|css|map|woff2?|png|svg|ico)$/.test(p);

/** Server-Timing: traceparent;desc="00-<traceId>-<spanId>-01" */
function parseServerTiming(v) {
  if (!v) return null;
  const m = /traceparent;desc="00-([0-9a-f]{32})-([0-9a-f]{16})-\d\d"/.exec(v);
  return m ? { traceId: m[1], spanId: m[2] } : null;
}

/** X-Vcide-Trace: 00-<traceId>-<spanId>-01（専用ヘッダ。公開範囲が狭い） */
function parseTraceparent(v) {
  if (!v) return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-\d\d$/.exec(String(v).trim());
  return m ? { traceId: m[1], spanId: m[2] } : null;
}

/**
 * 応答ヘッダから相関の識別子だけを取り出す。
 * **ここで2つのキー以外を捨てる。** 生のヘッダ集合は呼び出し側へ渡さない。
 */
function correlationOf(headers) {
  const lower = {};
  for (const k of Object.keys(headers ?? {})) {
    const lk = k.toLowerCase();
    if (lk === 'server-timing' || lk === 'x-vcide-trace') lower[lk] = headers[k];
  }
  const dedicated = parseTraceparent(lower['x-vcide-trace']);
  const timing = parseServerTiming(lower['server-timing']);
  return {
    server: dedicated ?? timing ?? null,
    via: dedicated ? 'dedicated-header' : timing ? 'server-timing' : null,
    /** 両方から読めた場合、同じ識別子だったか（ヘッダ間の整合） */
    headersAgree: dedicated && timing
      ? dedicated.traceId === timing.traceId && dedicated.spanId === timing.spanId
      : null,
    readKeys: Object.keys(lower).sort(),
  };
}

/** initiator のスタックから、先頭数フレームだけを取る。関数名は記録する */
function framesOf(initiator) {
  const out = [];
  const push = (f) => {
    if (out.length >= 8) return;
    out.push({
      url: f.url ?? null,
      // バンドラによっては URL が HTTP で取れない（webpack-internal:///…）。
      // そのときは scriptId から CDP でソースを引く
      scriptId: f.scriptId ?? null,
      line: typeof f.lineNumber === 'number' ? f.lineNumber + 1 : null,   // CDP は0始まり
      col: typeof f.columnNumber === 'number' ? f.columnNumber + 1 : null,
      functionName: f.functionName || null,
    });
  };
  for (let s = initiator?.stack; s; s = s.parent) {
    for (const f of s.callFrames ?? []) push(f);
  }
  return out;
}

/**
 * ページを開き、操作を行い、その間に起きた通信を CDP で記録する。
 *
 * @param {string} base            http://localhost:3200
 * @param {string} path            開くページ
 * @param {(page, api) => Promise<any>} [act]  操作（ボタンを押す等）
 * @param {{waitFor?: string, settleMs?: number}} [opts]
 */
export async function observePage(base, path, act, opts = {}) {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    /*
     * Debugger を開けておく。バンドラが eval でモジュールを読み込む構成
     * （webpack）では、スクリプトの中身を HTTP で取れない。scriptId から
     * 引けるようにしておかないと、呼び出し元を解決できない。
     */
    if (opts.debugger !== false) await cdp.send('Debugger.enable').catch(() => null);

    /** requestId → 観測中の1件 */
    const open = new Map();
    const records = [];
    let excludedAssets = 0;

    const pathOf = (url) => { try { return new URL(url).pathname; } catch { return null; } };
    const sameOrigin = (url) => { try { return new URL(url).origin === base; } catch { return false; } };

    cdp.on('Network.requestWillBeSent', (e) => {
      const p = pathOf(e.request.url);
      if (p === null) return;
      const external = !sameOrigin(e.request.url);
      if (!external && isAsset(p)) { excludedAssets++; return; }

      const prev = open.get(e.requestId);
      if (prev && e.redirectResponse) {
        // リダイレクト。前段の応答をこの要求の「段」として積む
        prev.redirects.push({
          path: pathOf(e.redirectResponse.url),
          status: e.redirectResponse.status,
          ...correlationOf(e.redirectResponse.headers),
        });
        prev.path = p;
        prev.hops++;
        return;
      }
      open.set(e.requestId, {
        browserRequestId: e.requestId,
        method: e.request.method,
        path: p,
        // クエリ文字列は値を持ちうるので、**付いていたかどうかだけ**を残す
        hasQuery: (() => { try { return !!new URL(e.request.url).search; } catch { return false; } })(),
        external,
        origin: external ? new URL(e.request.url).origin : null,
        resourceType: e.type ?? null,
        startMsEpoch: e.wallTime ? e.wallTime * 1000 : null,
        t0: e.timestamp,
        hops: 1,
        redirects: [],
        initiator: { type: e.initiator?.type ?? null, frames: framesOf(e.initiator) },
        status: null,
        correlation: null,
        durationMs: null,
        failure: null,
      });
    });

    cdp.on('Network.responseReceived', (e) => {
      const r = open.get(e.requestId);
      if (!r) return;
      r.status = e.response.status;
      r.correlation = correlationOf(e.response.headers);
    });

    cdp.on('Network.loadingFinished', (e) => {
      const r = open.get(e.requestId);
      if (!r) return;
      r.durationMs = +((e.timestamp - r.t0) * 1000).toFixed(2);
      records.push(r);
      open.delete(e.requestId);
    });

    cdp.on('Network.loadingFailed', (e) => {
      const r = open.get(e.requestId);
      if (!r) return;
      r.durationMs = +((e.timestamp - r.t0) * 1000).toFixed(2);
      /*
       * 失敗は2種類ある。混ぜてはいけない。
       *   no-response            応答が1つも返っていない。**識別情報が存在しない**
       *   canceled-after-response 応答は返った（識別情報はある）。本文の読み取りを
       *                          ページ側が打ち切った、等
       */
      r.failure = {
        kind: r.status === null ? 'no-response' : 'canceled-after-response',
        detail: e.errorText ?? null,
      };
      records.push(r);
      open.delete(e.requestId);
    });

    await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 90000 });
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(500);

    /** scriptId からソースを引く。初期化子の解決で使う */
    const scriptSource = async (scriptId) => {
      try {
        const r = await cdp.send('Debugger.getScriptSource', { scriptId });
        return r?.scriptSource ?? null;
      } catch { return null; }
    };

    const extra = act ? await act(page, { cdp, scriptSource }) : null;
    await page.waitForTimeout(opts.settleMs ?? 1200);

    // 取り残し（応答も失敗も来なかったもの）は、観測できなかったこととして残す
    for (const r of open.values()) {
      r.failure = r.failure ?? { kind: 'unterminated', detail: 'no response, no failure event' };
      records.push(r);
    }
    for (const r of records) {
      delete r.t0;
      r.isDocument = r.resourceType === 'Document';
      // 相関の識別子を記録の第一階層へ出す（対応付けの入力はこの3つだけ）
      r.server = r.correlation?.server ?? null;
      r.via = r.correlation?.via ?? null;
      r.headersAgree = r.correlation?.headersAgree ?? null;
      r.readHeaderKeys = r.correlation?.readKeys ?? [];
      // 入力スキーマ（observation.ts）に合わせた名前にする
      r.startMs = r.startMsEpoch;
      delete r.startMsEpoch;
    }
    // 呼び出し元の解決は、ページを閉じる前に行う（scriptId が生きているうちに）
    const resolved = opts.resolve ? await opts.resolve(records, { scriptSource }) : null;
    await context.close();
    return { page: path, records, excludedAssets, extra, resolved };
  } finally {
    await browser.close();
  }
}
