/* =============================================================================
 * PoC-05 — ブラウザの通信とサーバーの計測を、根拠を持って接続できるかの検証。
 *   node poc/runner/poc05.mjs
 * 出力:
 *   poc/out/poc05.json              全文（絶対パスを含みうる生記録）
 *   docs/06c-poc05-matrix.json      判定の要約（テストが読む。絶対パスを落とす）
 *
 * 3種類の関連を**別々に**判定する（指示 第3節）。
 *   A ブラウザHTTP ↔ サーバーHTTP   応答ヘッダの識別子の一致だけで判断する
 *   B コンポーネント ↔ HTTP          通信を開始したコードの証拠があるときだけ
 *   C HTTPレスポンス ↔ 表示値        **やらない**（本文・個人情報を取らない）
 *
 * 収集しないもの: ヘッダ一覧（相関用の2キー以外）/ 本文 / Cookie / 認証情報 /
 * SQLのパラメータ値 / 行データ / クエリ文字列の値 / 個人情報。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { readSpans, startApp } from './lib/server.mjs';
import { observePage } from './lib/netobs.mjs';
import { makeFetcher, resolveInitiator } from './lib/initiator.mjs';
import { compareRules, matchByIdentity, serverEntrySpans, statusOf } from './lib/correlate.mjs';
import { CASES, DOCUMENT_EXPECT, RSC_EXPECT } from './lib/probe05.mjs';
import { APP, OUT, REPO, sleep } from './lib/util.mjs';

const BASE = 'http://localhost:3200';
/** 同じポートの別ホスト名。クロスオリジンでの見え方を測るために使う */
const ALT = 'http://127.0.0.1:3200';
const BUNDLERS = (process.env.POC05_BUNDLERS ?? 'turbopack,webpack').split(',');
const ANCHORS = path.join(OUT, 'anchors05');
const INSTR = path.join(APP, 'src', 'instrumentation.ts');
const PARKED = `${INSTR}.parked`;

/* 非追加(b): 方式2 の計測中はプロジェクトに計装用のファイルを置かない */
const park = () => { if (fs.existsSync(INSTR)) fs.renameSync(INSTR, PARKED); };
const unpark = () => { if (fs.existsSync(PARKED)) fs.renameSync(PARKED, INSTR); };

/** ビルド時マニフェストのコンポーネント範囲。呼び出し元の照合の片側に使う */
function manifestComponents() {
  const m = new Map();
  if (!fs.existsSync(ANCHORS)) return m;
  for (const f of fs.readdirSync(ANCHORS)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ANCHORS, f), 'utf8'));
      if (j.components?.length) m.set(j.file, j.components);
    } catch { /* 壊れた断片は無視する（並列に書かれる） */ }
  }
  return m;
}

const isApi = (r) => r.path.startsWith('/api/');

/** 1ページ分の観測に対して、呼び出し元を解決する差し込み口 */
function resolver() {
  return async (records, { scriptSource }) => {
    const fetcher = makeFetcher(scriptSource);
    const comps = manifestComponents();
    const out = {};
    for (const r of records) {
      out[r.browserRequestId] = await resolveInitiator(r, fetcher, BASE, comps);
    }
    return out;
  };
}

/** 期待値1件と観測1件が同じものかを、呼び出し位置で突き合わせる */
function sameRequest(exp, rec, init) {
  if (exp.method !== rec.method || exp.path !== rec.path) return false;
  if (!exp.initiator) return !init?.component;
  return !!init?.frame && init.frame.file === exp.initiator.file
    && init.frame.line === exp.initiator.line;
}

const result = { collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), byBundler: {} };

for (const bundler of BUNDLERS) {
  console.log(`\n=== ${bundler} ===`);
  park();
  let app;
  const per = { cases: [], document: null, rsc: null, exposure: null, notes: [] };
  try {
    fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
    fs.rmSync(ANCHORS, { recursive: true, force: true });
    app = await startApp({
      mode: 'method2', bundler, run: `poc05-${bundler}`,
      env: {
        POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCHORS,
        POC05_TRACE_HEADER: '1', POC05_SELF_ORIGIN: BASE,
      },
    });
    // 初回コンパイルと接続確立を観測対象に混ぜない。2回捨てる
    await observePage(BASE, '/flows', async (p) => { await p.click('#btn-one'); }, { settleMs: 1200 });
    await observePage(BASE, '/flows-rsc', null, { settleMs: 1200 });
    fs.writeFileSync(app.spanFile, '');

    /* ---------------------------------------------- 必須ケース（1操作 = 1読み込み） */
    for (const c of CASES) {
      const obs = await observePage(BASE, '/flows', async (p) => {
        await p.click(c.button);
        await p.waitForTimeout(700);
      }, { settleMs: 1300, resolve: resolver() });
      per.cases.push({ case: c, obs });
      console.log(`  ${c.key}: ${obs.records.filter(isApi).length} 件`);
    }

    /* ------------------------------------- Server Component が関与する通信 */
    per.rsc = await observePage(BASE, '/flows-rsc', null,
      { waitFor: 'article.card', settleMs: 1500, resolve: resolver() });

    /* ----------------------------------------- 識別子の公開範囲（第5節） */
    per.exposure = await observePage(BASE, '/flows', async (p) => {
      await p.click('#btn-one');
      await p.waitForTimeout(700);
      const cross = await p.evaluate(`(async () => {
        try {
          const r = await fetch('${ALT}/api/cors');
          return { ok: r.ok, status: r.status,
            serverTiming: r.headers.get('server-timing'),
            dedicated: r.headers.get('x-vcide-trace') };
        } catch (e) { return { error: String(e).slice(0, 160) }; }
      })()`);
      await p.waitForTimeout(400);
      const entries = await p.evaluate(`(() => {
        const rs = performance.getEntriesByType('resource');
        return rs.map((r) => {
          let origin = null; let pathname = r.name;
          try { const u = new URL(r.name); origin = u.origin; pathname = u.pathname; } catch {}
          return { origin, path: pathname,
            serverTiming: (r.serverTiming || []).map((s) => ({ name: s.name, hasDesc: !!s.description })),
            // ヘッダの値そのものは持ち出さない。読めたかどうかだけを数える
            dedicated: (r.serverTiming || []).some((s) => s.name === 'x-vcide-trace') };
        });
      })()`);
      return { cross, entries };
    }, { settleMs: 1200, resolve: resolver() });

    await sleep(1500);
    per.spans = readSpans(app.spanFile).spans;
  } finally {
    if (app) await app.stop();
    unpark();
  }

  /* ======================================================== 判定 */
  const spans = per.spans;
  const bySpanId = new Map(spans.map((s) => [s.spanId, s]));
  const entries = serverEntrySpans(spans);

  const allRecords = [
    ...per.cases.flatMap((c) => c.obs.records),
    ...per.rsc.records, ...per.exposure.records,
  ];
  const allWithIdentity = allRecords.filter((r) => r.server);

  const caseResults = per.cases.map(({ case: c, obs }) => {
    const api = obs.records.filter(isApi);
    const init = (r) => obs.resolved?.[r.browserRequestId] ?? null;

    /* --- A: 識別子による対応付け --- */
    const a = api.map((r) => {
      const m = matchByIdentity(r, bySpanId);
      return {
        path: r.path, status: r.status, hops: r.hops,
        hasIdentity: !!r.server, via: r.via, headersAgree: r.headersAgree,
        readHeaderKeys: r.correlation?.readKeys ?? [],
        failure: r.failure,
        matched: !!m.span,
        reason: m.reason,
        spanId: m.span?.spanId ?? null,
        traceId: m.span?.traceId ?? null,
        serverStatus: m.span ? statusOf(m.span) : null,
        /** リダイレクトの段。段ごとに別のサーバー処理である */
        redirects: (r.redirects ?? []).map((h) => {
          const hm = matchByIdentity({ method: r.method, path: h.path, server: h.server }, bySpanId);
          return { path: h.path, status: h.status, matched: !!hm.span, reason: hm.reason,
            spanId: hm.span?.spanId ?? null, traceId: hm.span?.traceId ?? null };
        }),
      };
    });

    /* --- B: 通信を開始したコードの対応付け --- */
    const b = api.map((r) => {
      const i = init(r);
      return {
        path: r.path,
        type: i?.type ?? null,
        file: i?.frame?.file ?? null,
        line: i?.frame?.line ?? null,
        functionName: i?.frame?.functionName ?? null,
        verified: !!i?.verified,
        component: i?.component?.name ?? null,
        reason: i?.failure?.reason ?? null,
      };
    });

    /* --- 期待値との突き合わせ --- */
    const pool = [...api];
    const matchedExpect = [];
    for (const exp of c.expect) {
      const idx = pool.findIndex((r) => sameRequest(exp, r, init(r)));
      if (idx < 0) { matchedExpect.push({ expect: exp, found: false }); continue; }
      const r = pool.splice(idx, 1)[0];
      const i = init(r);
      const m = matchByIdentity(r, bySpanId);
      matchedExpect.push({
        expect: exp,
        found: true,
        statusOk: (exp.status ?? null) === (r.status ?? null),
        identityOk: exp.identity === false ? !r.server : !!r.server,
        correlatedOk: exp.identity === false ? !m.span : !!m.span,
        hopsOk: (exp.hops ?? 1) === r.hops,
        initiatorOk: exp.initiator
          ? i?.component?.name === exp.initiator.component && i.frame.file === exp.initiator.file
            && i.frame.line === exp.initiator.line && i.verified === true
          : !i?.component,
      });
    }

    const rules = compareRules(api, bySpanId, entries);
    return {
      key: c.key, label: c.label, required: c.required, note: c.note ?? null,
      requestCount: api.length,
      otherRequestCount: obs.records.length - api.length,
      a, b,
      expectations: matchedExpect,
      rules: rules.rows,
      duplicateSpanClaims: rules.duplicates,
      pass: matchedExpect.every((x) => x.found && x.statusOk && x.identityOk
        && x.correlatedOk && x.hopsOk && x.initiatorOk) && pool.length === 0
        && rules.duplicates.length === 0
        && rules.rows.every((x) => x.identity <= 1),
      unexpected: pool.map((r) => ({ path: r.path, status: r.status })),
    };
  });

  /* ---------------------------------------------- 文書取得（操作ではない通信） */
  const docRec = per.cases[0].obs.records.find((r) => r.path === DOCUMENT_EXPECT.path);
  const docInit = docRec ? per.cases[0].obs.resolved?.[docRec.browserRequestId] : null;
  per.document = docRec ? {
    hasIdentity: !!docRec.server,
    matched: !!matchByIdentity(docRec, bySpanId).span,
    isDocument: docRec.isDocument,
    initiatorType: docInit?.type ?? null,
    initiatorComponent: docInit?.component?.name ?? null,
    initiatorReason: docInit?.failure?.reason ?? null,
    expectedReason: DOCUMENT_EXPECT.initiatorReason,
  } : null;

  /* ----------------------------- Server Component が関与する通信 */
  const rscDoc = per.rsc.records.find((r) => r.path === RSC_EXPECT.path && r.isDocument);
  const rscMatch = rscDoc ? matchByIdentity(rscDoc, bySpanId) : { span: null };
  const rscTrace = rscMatch.span?.traceId ?? null;
  const inRscTrace = spans.filter((s) => s.traceId === rscTrace);
  const serverFetchSpan = inRscTrace.find((s) => /^fetch /.test(s.name));
  // サーバーの中の通信が、どのトレースのハンドラに届いたか
  const innerHandlers = spans.filter(
    (s) => s.attrs['next.span_type'] === 'AppRouteRouteHandlers.runHandler'
      && s.attrs['next.route'] === '/api/listings',
  );
  per.rscResult = {
    documentMatched: !!rscMatch.span,
    documentTraceId: rscTrace,
    spansInDocumentTrace: inRscTrace.length,
    serverInternalFetchObserved: !!serverFetchSpan,
    serverInternalFetchSpan: serverFetchSpan?.name ?? null,
    /** サーバー内部の通信の相手ハンドラが、同じトレースに入っているか */
    innerHandlerInSameTrace: innerHandlers.some((s) => s.traceId === rscTrace),
    innerHandlerTraces: [...new Set(innerHandlers.map((s) => s.traceId))].length,
    sqlInDocumentTrace: inRscTrace.filter(
      (s) => s.attrs['db.query.text'] || s.attrs['db.statement'],
    ).length,
    /** ブラウザから見えた通信の件数（文書以外に何があったか） */
    browserRequests: per.rsc.records.map((r) => ({
      path: r.path, isDocument: r.isDocument, hasQuery: r.hasQuery,
      hasIdentity: !!r.server,
      initiatorComponent: per.rsc.resolved?.[r.browserRequestId]?.component?.name ?? null,
      initiatorReason: per.rsc.resolved?.[r.browserRequestId]?.failure?.reason ?? null,
    })),
  };

  /* -------------------------------------------- 識別子の公開範囲 */
  const ex = per.exposure.extra;
  const sameOriginEntries = ex.entries.filter((e) => e.origin === BASE);
  const crossEntries = ex.entries.filter((e) => e.origin === ALT);
  const crossRec = per.exposure.records.find((r) => r.path === '/api/cors');
  per.exposureResult = {
    resourceEntries: ex.entries.length,
    /** 同一オリジン: ページ上の任意のスクリプトが Server-Timing を読めた件数 */
    serverTimingVisibleToPageScript: sameOriginEntries.filter(
      (e) => e.serverTiming.some((s) => s.name === 'traceparent' && s.hasDesc),
    ).length,
    sameOriginEntries: sameOriginEntries.length,
    /** 専用ヘッダは Resource Timing API に出ない */
    dedicatedHeaderVisibleToPageScript: ex.entries.some((e) => e.dedicated),
    crossOrigin: {
      origin: ALT,
      requestSucceeded: !!ex.cross.ok,
      serverTimingReadable: ex.cross.serverTiming !== null && ex.cross.serverTiming !== undefined,
      dedicatedReadable: ex.cross.dedicated !== null && ex.cross.dedicated !== undefined,
      resourceTimingEntries: crossEntries.length,
      resourceTimingServerTiming: crossEntries.filter((e) => e.serverTiming.length).length,
      /** IDE（CDP）からは読めたか */
      readableViaCdp: !!crossRec?.server,
      viaCdp: crossRec?.via ?? null,
      error: ex.cross.error ?? null,
    },
  };

  /* ------------------------------------------------------- 全体の集計 */
  const everyRule = compareRules(allRecords, bySpanId, entries);
  per.summary = {
    browserRequests: allRecords.length,
    withIdentity: allWithIdentity.length,
    apiRequests: allRecords.filter(isApi).length,
    matched: allRecords.filter((r) => matchByIdentity(r, bySpanId).span).length,
    serverEntrySpans: entries.length,
    distinctTracesOnEntrySpans: new Set(entries.map((s) => s.traceId)).size,
    duplicateSpanClaims: everyRule.duplicates.length,
    identityNeverAmbiguous: everyRule.rows.every((r) => r.identity <= 1),
    /** 時間窓では絞れなかった件数（= 時刻で判断してはいけない直接の証拠） */
    timeWindowAmbiguous: everyRule.rows.filter((r) => r.timeWindow > 1).length,
    timeWindowDisagreed: everyRule.rows.filter((r) => r.timeWindowAgrees === false).length,
    /** 識別子が無い（＝対応付けてはいけない）のに、時間窓なら候補が出る件数 */
    timeWindowClaimsWithoutIdentity: everyRule.rows.filter(
      (r) => r.identity === 0 && r.timeWindow >= 1,
    ).length,
    corroborationOnlyAmbiguous: everyRule.rows.filter((r) => r.corroborationOnly > 1).length,
    /** 読んだ応答ヘッダのキー（この2つ以外は読んでいない） */
    headerKeysRead: [...new Set(allRecords.flatMap((r) => r.correlation?.readKeys ?? []))].sort(),
    headersAgreeAlways: allWithIdentity.every((r) => r.headersAgree !== false),
    spans: spans.length,
  };
  per.initiatorSummary = (() => {
    const all = per.cases.flatMap(({ obs }) => obs.records.filter(isApi)
      .map((r) => obs.resolved?.[r.browserRequestId] ?? null));
    return {
      total: all.length,
      resolved: all.filter((i) => i?.component).length,
      verified: all.filter((i) => i?.verified).length,
      unresolved: all.filter((i) => !i?.component).length,
      reasons: all.filter((i) => !i?.component)
        .reduce((acc, i) => { const k = i?.failure?.reason ?? 'none'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    };
  })();
  per.caseResults = caseResults;
  delete per.cases;
  delete per.spans;
  delete per.rsc;
  delete per.exposure;
  result.byBundler[bundler] = per;
  console.log(`  A 対応付け ${per.summary.matched}/${per.summary.withIdentity}`
    + ` / B 呼び出し元 ${per.initiatorSummary.resolved}/${per.initiatorSummary.total}`
    + ` / 時間窓で絞れない ${per.summary.timeWindowAmbiguous} 件`);
}

/* -------------------------------------------- 秘密情報が入っていないかの検査 */
const FORBIDDEN = [
  /postgres(ql)?:\/\//i, /poc01_local_only/, /\bcookie\b/i, /\bauthorization\b/i,
  /\bbearer\b/i, /\bpassword\b/i, /\baccess_token\b/i, /\bsecret\b/i,
  /アオバ台|シラカワ野|ミナト浜|ヒガシ丘/,
];
const text = JSON.stringify(result);
const hits = FORBIDDEN.filter((re) => re.test(text)).map(String);
if (hits.length) throw new Error(`計測結果に収集禁止の痕跡がある: ${hits.join(', ')}`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'poc05.json'), JSON.stringify(result, null, 2));

/* 要約はリポジトリに残す（テストが読む）。絶対パスを落とす */
const summary = JSON.parse(JSON.stringify(result).replaceAll(REPO, '<repo>'));
fs.writeFileSync(path.join(REPO, 'docs', '06c-poc05-matrix.json'), JSON.stringify(summary, null, 2));
console.log(`\n→ ${path.join(OUT, 'poc05.json')}`);
console.log(`→ docs/06c-poc05-matrix.json`);
