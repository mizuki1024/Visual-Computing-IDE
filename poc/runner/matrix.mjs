/* =============================================================================
 * PoC-01 手順1〜3・5 — 計装の2方式 × バンドラ2種 と、性能影響の測定。
 *   node poc/runner/matrix.mjs
 * 出力: poc/out/measurements.json
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { readSpans, startApp } from './lib/server.mjs';
import { drivePages, hammer } from './lib/drive.mjs';
import * as pglog from './lib/pglog.mjs';
import { APP, OUT, median, sleep } from './lib/util.mjs';

/** バンドラを切り替えるときはビルド成果物を捨てる。混在させない */
function clearBuild() {
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
}

const PAGES = ['/', '/listings', '/listings/3'];
const APIS = ['/api/listings', '/api/listings/3', '/api/stats'];
/** 1リクエストあたり、アプリが発行するはずの SQL の数（コードから数えた期待値） */
const EXPECTED_SQL = { '/api/listings': 1, '/api/listings/3': 2, '/api/stats': 2 };

const SQL_ATTR = (a) => a['db.statement'] ?? a['db.query.text'] ?? null;

function analyzeRun(spans, notes) {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const sql = spans.filter((s) => SQL_ATTR(s.attrs));
  const httpServer = spans.filter(
    (s) => s.attrs['next.span_type'] === 'BaseServer.handleRequest'
      || (s.scope === '@opentelemetry/instrumentation-http' && s.kind === 1),
  );
  const handlers = spans.filter((s) => s.attrs['next.span_type'] === 'AppRouteRouteHandlers.runHandler');

  /** そのスパンから祖先をたどって、条件に合う最初の祖先を返す */
  const ancestor = (s, pred) => {
    let cur = s, depth = 0;
    while (cur?.parentSpanId) {
      cur = byId.get(cur.parentSpanId);
      depth++;
      if (!cur) return null;
      if (pred(cur)) return { span: cur, depth };
    }
    return null;
  };

  const sqlLinked = sql.filter((s) => ancestor(s, (p) =>
    p.attrs['next.span_type'] === 'BaseServer.handleRequest'));
  const sqlLinkedDirect = sql.filter((s) => {
    const p = byId.get(s.parentSpanId);
    return p && p.attrs['next.span_type'] === 'AppRouteRouteHandlers.runHandler';
  });

  const pids = [...new Set(spans.map((s) => s.proc.pid))];
  const registeredPids = [...new Set(notes.filter((n) => n.kind === 'registered').map((n) => n.proc.pid))];

  return {
    spanCount: spans.length,
    scopes: countBy(spans, (s) => s.scope),
    sqlSpanCount: sql.length,
    sqlByScope: countBy(sql, (s) => s.scope),
    httpServerSpanCount: httpServer.length,
    httpScopes: countBy(httpServer, (s) => s.scope),
    handlerSpanCount: handlers.length,
    sqlLinkedToHttpSpan: sqlLinked.length,
    sqlDirectChildOfHandler: sqlLinkedDirect.length,
    emittingPids: pids,
    registeredPids,
    notes: countBy(notes, (n) => n.kind),
    droppedAttributeKeys: [...new Set(spans.flatMap((s) => s.droppedAttributeKeys ?? []))].sort(),
  };
}

const countBy = (xs, f) => {
  const o = {};
  for (const x of xs) { const k = String(f(x)); o[k] = (o[k] ?? 0) + 1; }
  return o;
};

async function cell(mode, bundler) {
  const run = `${mode}-${bundler}`;
  process.stdout.write(`\n▶ ${run}\n`);
  clearBuild();
  const before = pglog.snapshot();
  const app = await startApp({ mode, bundler, run });
  let result;
  try {
    const browser = await drivePages(PAGES);
    const lat = await hammer(APIS, 10);
    await sleep(1200);                                  // 書き出しの取りこぼしを避ける
    const { spans, notes } = readSpans(app.spanFile);
    const gt = pglog.since(before);

    // 期待値（コードから数えた数）と、DBログ（独立した基準）の両方で取得率を出す
    const expected = 10 * APIS.reduce((a, p) => a + EXPECTED_SQL[p], 0)
      + browser.flatMap((b) => b.requests)
        .filter((r) => EXPECTED_SQL[r.path.replace(/\/\d+$/, '/3')] !== undefined)
        .reduce((a, r) => a + (EXPECTED_SQL[r.path.replace(/\/\d+$/, '/3')] ?? 0), 0);

    const a = analyzeRun(spans, notes);
    const httpFromBrowser = browser.flatMap((b) => b.requests);
    const linkedByTraceId = httpFromBrowser.filter((r) => r.server?.traceId).length;

    result = {
      run, mode, bundler,
      readyMs: app.readyMs,
      ...a,
      expectedSqlFromCode: expected,
      groundTruthDml: gt.dml.length,
      groundTruthHousekeeping: gt.housekeeping.length,
      sqlCaptureRateVsCode: expected ? +(a.sqlSpanCount / expected).toFixed(4) : null,
      sqlCaptureRateVsDbLog: gt.dml.length ? +(a.sqlSpanCount / gt.dml.length).toFixed(4) : null,
      browserRequests: httpFromBrowser.length,
      browserRequestsWithServerTraceId: linkedByTraceId,
      httpCaptureRate: httpFromBrowser.length
        ? +(linkedByTraceId / httpFromBrowser.length).toFixed(4) : null,
      apiLatencyMs: {
        median: median(lat.map((l) => l.ms)),
        samples: lat.length,
        byPath: Object.fromEntries(APIS.map((p) => [p, median(lat.filter((l) => l.path === p).map((l) => l.ms))])),
      },
      browserPages: browser.map((b) => ({
        page: b.page, navMs: b.navMs, excludedAssets: b.excludedAssets,
        requests: b.requests.length,
      })),
      tail: app.log.join('').split('\n').filter((l) => /Error|error|warn/i.test(l)).slice(-6),
    };
  } finally {
    await app.stop();
  }
  console.log(`   spans=${result.spanCount} sql=${result.sqlSpanCount}`
    + ` http=${result.httpServerSpanCount} linked=${result.sqlLinkedToHttpSpan}`
    + ` pids=${result.emittingPids.length} ready=${result.readyMs}ms`);
  return result;
}

/** 手順5 — 計装の有無での起動時間と遅延。各10回。 */
async function perf() {
  const runs = [
    { mode: 'none', bundler: 'turbopack' },
    { mode: 'method1', bundler: 'turbopack' },
    { mode: 'method2', bundler: 'turbopack' },
  ];
  const out = [];
  clearBuild();
  // 1回捨てて、冷えたビルドの差が起動時間の比較に混ざらないようにする
  await (await startApp({ mode: 'none', bundler: 'turbopack', run: 'warmup', verbose: false })).stop();
  for (const r of runs) {
    const starts = [];
    const lats = [];
    for (let i = 0; i < 10; i++) {
      const app = await startApp({ ...r, run: `perf-${r.mode}-${i}`, verbose: false });
      starts.push(app.readyMs);
      const l = await hammer(['/api/listings'], 1);
      lats.push(l[0].ms);
      // 計装込みの定常状態の遅延も見る（初回はコンパイルを含むため）
      const l2 = await hammer(['/api/listings'], 5);
      lats.push(median(l2.map((x) => x.ms)));
      await app.stop();
      process.stdout.write('.');
    }
    out.push({
      ...r,
      startupMsMedian: median(starts), startupMs: starts,
      latencyMsMedian: median(lats), latencyMs: lats.map((x) => +x.toFixed(2)),
    });
    process.stdout.write(` ${r.mode}\n`);
  }
  return out;
}

const results = [];
for (const mode of ['method1', 'method2']) {
  for (const bundler of ['turbopack', 'webpack']) {
    results.push(await cell(mode, bundler));
  }
}
console.log('\n▶ 性能（手順5）');
const performance_ = await perf();

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'measurements.json'),
  JSON.stringify({ matrix: results, performance: performance_ }, null, 2),
);
console.log(`\n→ ${path.join(OUT, 'measurements.json')}`);
