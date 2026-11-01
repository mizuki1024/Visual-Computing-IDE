/* =============================================================================
 * PoC-02 — RSC の直読みと、サーバー内部のトレース伝播の検証。
 *   node poc/runner/poc02.mjs
 * 出力:
 *   poc/out/poc02.json           全文（絶対パスを含みうる生記録）
 *   docs/06d-poc02-matrix.json   判定の要約（テストが読む。絶対パスを落とす）
 *
 * **2つのゲートを別々に判定する**（指示 第2節）。
 *   Gate A  サーバー → サーバーの HTTP。親子関係とトレースIDの一致だけで判断する
 *   Gate B  Server Component → サーバー内部処理 → SQL → PostgreSQL
 *
 * どちらも、伝播の有無（POC02_UNDICI=1/0）× バンドラ（Turbopack / webpack）の
 * 4条件で回す。**伝播が無い条件で「別トレースを同一経路にしない」ことを測る**
 * のが、この構成の目的である。
 *
 * 収集しないもの: ヘッダの値（相関用2キー以外）/ 本文 / Cookie / 認証情報 /
 * SQLのパラメータ値 / 行データ / 接続文字列 / クエリ文字列の値 / 個人情報 /
 * トレースコンテキストの値そのもの（付いていたかの真偽だけ）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { readRecords, startApp } from './lib/server.mjs';
import { startSvc, SVC_ORIGIN } from './lib/svc.mjs';
import { observePage } from './lib/netobs.mjs';
import { resolveRscAttribution } from './lib/rscattr.mjs';
import { resetSrvMaps, srvMapStats } from './lib/srvmap.mjs';
import {
  ancestryTo, clientSpans, comparePropagationRules, destPathOf, entrySpans,
  matchByParentage, overlaps, statusOf, treeOf,
} from './lib/propagate.mjs';
import { analyzeSql } from './lib/sqlparse.mjs';
import { introspectTables } from './lib/introspect.mjs';
import { DOCUMENT_EXPECT, FORBIDDEN, GATE_A_CASES, GATE_B_CASES } from './lib/probe02.mjs';
import { APP, OUT, REPO, sleep } from './lib/util.mjs';

const BASE = 'http://localhost:3200';
const BUNDLERS = (process.env.POC02_BUNDLERS ?? 'turbopack,webpack').split(',');
const MODES = (process.env.POC02_MODES ?? 'on,off').split(',');
const ANCHORS = path.join(OUT, 'anchors02');
const INSTR = path.join(APP, 'src', 'instrumentation.ts');
const PARKED = `${INSTR}.parked`;

/* 非追加(b): 方式2 の計測中はプロジェクトに計装用のファイルを置かない */
const park = () => { if (fs.existsSync(INSTR)) fs.renameSync(INSTR, PARKED); };
const unpark = () => { if (fs.existsSync(PARKED)) fs.renameSync(PARKED, INSTR); };

const ALL_PAGES = [
  ...GATE_B_CASES.map((c) => c.page),
  ...GATE_A_CASES.map((c) => c.page),
];

/** ビルド時マニフェストのコンポーネント範囲。帰属の照合の片側に使う */
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

const isSqlSpan = (s) => !!(s.attrs['db.query.text'] || s.attrs['db.statement']);
const sqlTextOf = (s) => s.attrs['db.query.text'] ?? s.attrs['db.statement'] ?? null;
/** Next.js がページの描画に付けるスパン。ルート単位であって、コンポーネント単位ではない */
const isRenderSpan = (s) => s.attrs['next.span_type'] === 'AppRender.getBodyResult';

const result = {
  collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  app: { framework: 'Next.js', service: 'poc01-fixture-app', port: 3200 },
  svc: { service: 'poc02-fixture-svc', origin: SVC_ORIGIN, note: 'ループバックにのみ listen する隔離した2つ目の検証用サービス' },
  byRun: {},
};

for (const bundler of BUNDLERS) {
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  fs.rmSync(ANCHORS, { recursive: true, force: true });

  for (const mode of MODES) {
    const runKey = `${bundler}-propagation-${mode}`;
    console.log(`\n=== ${runKey} ===`);
    park();
    let app;
    let svc;
    const per = { bundler, propagation: mode, pages: {}, notes: [] };
    try {
      svc = await startSvc({ run: runKey, undici: mode === 'on', callsite: true });
      app = await startApp({
        mode: 'method2', bundler, run: runKey,
        env: {
          POC02_UNDICI: mode === 'on' ? '1' : '0',
          POC02_CALLSITE: '1',
          POC02_SVC_ORIGIN: SVC_ORIGIN,
          POC05_TRACE_HEADER: '1',
          POC05_SELF_ORIGIN: BASE,
          POC03_ANCHOR: '1',
          POC03_ANCHOR_OUT: ANCHORS,
        },
      });

      /* 初回コンパイルと接続確立を観測対象に混ぜない。1周捨てる */
      for (const p of ALL_PAGES) {
        await fetch(`${BASE}${p}`).then((r) => r.text()).catch(() => null);
      }
      await sleep(1000);
      fs.writeFileSync(app.spanFile, '');
      fs.writeFileSync(svc.spanFile, '');
      resetSrvMaps();

      /* ---------------------------------------- 1ページ = 1回の読み込み */
      for (const p of ALL_PAGES) {
        if (per.pages[p]) continue;
        const obs = await observePage(BASE, p, null, { settleMs: 1200 });
        per.pages[p] = {
          requests: obs.records.map((r) => ({
            method: r.method, path: r.path, status: r.status,
            isDocument: r.isDocument, hasQuery: r.hasQuery,
            hasIdentity: !!r.server, via: r.via,
            readHeaderKeys: r.readHeaderKeys,
            initiatorType: r.initiator?.type ?? null,
            server: r.server,
          })),
          excludedAssets: obs.excludedAssets,
        };
        await sleep(250);
      }

      await sleep(1500);
      per.svcSeen = await svc.seen();
      const appRec = readRecords(app.spanFile, 'app');
      const svcRec = readRecords(svc.spanFile, 'svc');
      per.notes = [...appRec.notes, ...svcRec.notes].map((n) => ({ kind: n.kind, detail: n.detail }));
      per.raw = {
        spans: [...appRec.spans, ...svcRec.spans],
        callsites: [...appRec.callsites, ...svcRec.callsites],
      };
    } finally {
      if (app) await app.stop();
      if (svc) await svc.stop();
      unpark();
    }

    /* ==================================================== 判定 */
    const spans = per.raw.spans;
    const callsiteBySpan = new Map(per.raw.callsites.map((c) => [c.spanId, c]));
    const comps = manifestComponents();
    const allEntries = entrySpans(spans);
    const clients = clientSpans(spans);
    const sqlSpans = spans.filter(isSqlSpan);

    /** ドキュメント要求 → その入口スパン（PoC-05 の A 項の方式をそのまま使う） */
    const docSpanFor = (p) => {
      const rec = (per.pages[p]?.requests ?? []).find((r) => r.isDocument && r.path === p);
      if (!rec?.server) return { rec, span: null, reason: 'no-identity-in-response' };
      const span = spans.find((s) => s.spanId === rec.server.spanId
        && s.traceId === rec.server.traceId && s.kind === 1);
      return { rec, span: span ?? null, reason: span ? null : 'span-not-collected' };
    };

    /* ------------------------------------------------------------ Gate A */
    const gateA = [];
    for (const c of GATE_A_CASES) {
      const doc = docSpanFor(c.page);
      const trace = doc.span?.traceId ?? null;
      const { byId } = treeOf(spans, trace ?? '-');
      /* 送信側の候補。伝播がある条件では undici の client スパン、
       * 無い条件では Next 自身の fetch スパン（親子は付かない）を見る */
      const senders = mode === 'on'
        ? clients.filter((s) => s.traceId === trace)
        : spans.filter((s) => s.traceId === trace && /^fetch /.test(s.name));

      const observed = senders.map((sender) => {
        const m = matchByParentage(sender, allEntries);
        const entry = m.entry;
        const childSqlSpans = entry
          ? sqlSpans.filter((s) => s.traceId === entry.traceId
            && ancestryTo(new Map(spans.filter((x) => x.traceId === entry.traceId).map((x) => [x.spanId, x])), s, entry.spanId))
          : [];
        const cs = callsiteBySpan.get(sender.spanId) ?? null;
        const attr = cs ? resolveRscAttribution(cs, comps) : null;
        return {
          senderSpanId: sender.spanId,
          senderName: sender.name,
          senderService: sender.service,
          destPath: destPathOf(sender),
          destHost: sender.attrs['server.address'] ?? null,
          destPort: sender.attrs['server.port'] ?? null,
          status: statusOf(sender),
          statusCode: sender.statusCode,
          /* ---- 伝播の判定（親子関係とトレースIDだけ） ---- */
          propagated: !!entry,
          propagationFailure: m.reason,
          entrySpanId: entry?.spanId ?? null,
          entryService: entry?.service ?? null,
          entryTraceId: entry?.traceId ?? null,
          sameTrace: entry ? entry.traceId === sender.traceId : null,
          crossProcess: entry ? entry.service !== sender.service : null,
          childSqlCount: childSqlSpans.length,
          /* ---- どのコンポーネントが始めたか（根拠つき） ---- */
          initiator: attr ? {
            file: attr.frame?.file ?? null, line: attr.frame?.line ?? null,
            component: attr.component?.name ?? null,
            verified: attr.verified, sourceLine: attr.sourceLine,
            reason: attr.failure?.reason ?? null,
            appFrameAtSpanStart: attr.appFrameAtSpanStart,
          } : null,
          parentChainDepth: entry ? ancestryTo(byId, entry, doc.span.spanId)?.depth ?? null : null,
        };
      });

      /* 期待値との突き合わせ */
      const pool = [...observed];
      const checks = [];
      for (const exp of c.expect) {
        const i = pool.findIndex((o) => o.destPath === exp.destPath);
        if (i < 0) { checks.push({ expect: exp, found: false }); continue; }
        const o = pool.splice(i, 1)[0];
        const propagationOk = mode === 'on'
          ? o.propagated === exp.propagated
            && (!exp.propagated || (o.sameTrace === true
              && (exp.destService ? (exp.destService === 'poc02-fixture-svc' ? o.crossProcess === true : o.crossProcess === false) : true)))
          // 伝播を入れない条件では、**必ず対応付かないこと**が正解である
          : o.propagated === false;
        checks.push({
          expect: exp,
          found: true,
          propagationOk,
          statusOk: mode === 'on' ? (exp.status ?? null) === (o.status ?? null) : true,
          childSqlOk: mode === 'on' ? (exp.childSql ?? 0) === o.childSqlCount : o.childSqlCount === 0,
          initiatorOk: !!exp.initiator && !!o.initiator
            && o.initiator.file === exp.initiator.file
            && o.initiator.line === exp.initiator.line
            && o.initiator.component === exp.initiator.component
            && o.initiator.verified === true,
        });
      }

      const rules = comparePropagationRules(senders, allEntries);
      gateA.push({
        key: c.key, label: c.label, page: c.page,
        documentCorrelated: !!doc.span,
        documentTraceId: trace,
        senderCount: senders.length,
        observed, checks,
        rules: rules.rows,
        duplicateEntryClaims: rules.duplicates,
        /* 伝播が無い条件で「別トレースの入口スパンが時間窓なら候補に出る」ことの記録 */
        timeWindowWouldMatch: rules.rows.filter((r) => r.parentage === 0 && r.timeWindow >= 1).length,
        pathOnlyAmbiguous: rules.rows.filter((r) => r.pathOnly > 1).length,
        pass: checks.every((x) => x.found && x.propagationOk && x.statusOk && x.childSqlOk
          && (mode === 'off' ? true : x.initiatorOk))
          && rules.duplicates.length === 0
          && rules.rows.every((r) => r.parentage <= 1),
      });
    }

    /* ------------------------------------------------------------ Gate B */
    const knownTables = new Set(introspectTables('poc').map((t) => t.name));
    const gateB = [];
    for (const c of GATE_B_CASES) {
      const doc = docSpanFor(c.page);
      const trace = doc.span?.traceId ?? null;
      const { inTrace, byId } = treeOf(spans, trace ?? '-');
      const render = inTrace.find((s) => isRenderSpan(s) && s.attrs['next.route'] === c.renderRoute)
        ?? null;
      const sqlInTrace = inTrace.filter(isSqlSpan);
      /* **描画スパンの子孫である SQL だけ**を採る。同一トレースにあるだけでは採らない */
      const sqlUnderRender = render
        ? sqlInTrace
          .map((s) => ({ span: s, chain: ancestryTo(byId, s, render.spanId) }))
          .filter((x) => x.chain)
          .sort((a, b) => a.span.startMs - b.span.startMs)
        : [];

      const sql = sqlUnderRender.map(({ span: s, chain }) => {
        const text = sqlTextOf(s);
        const a = analyzeSql(text);
        const cs = callsiteBySpan.get(s.spanId) ?? null;
        const attr = cs ? resolveRscAttribution(cs, comps) : null;
        return {
          spanId: s.spanId,
          scope: s.scope,
          depthFromRender: chain.depth,
          durationMs: +s.durationMs.toFixed(2),
          failed: s.statusCode === 2,
          parseOk: a.parseOk,
          tables: a.tables.map((t) => t.name),
          tablesInSchema: a.tables.filter((t) => knownTables.has(t.name)).map((t) => t.name),
          columns: a.projections.map((p) => p.column),
          unresolved: a.unresolved.map((u) => u.why),
          attribution: attr ? {
            at: attr.at,
            file: attr.frame?.file ?? null,
            line: attr.frame?.line ?? null,
            functionName: attr.frame?.functionName ?? null,
            component: attr.component?.name ?? null,
            verified: attr.verified,
            sourceLine: attr.sourceLine,
            reason: attr.failure?.reason ?? null,
            /** 比較用: スパン開始時のスタックに、ユーザーのコードがあったか */
            appFrameAtSpanStart: attr.appFrameAtSpanStart,
          } : { reason: 'no-callsite-record' },
        };
      });

      /* 期待値との突き合わせ。SQL 文の一致では照合しない（同じ文が2本ある） */
      const pool = [...sql];
      const checks = [];
      for (const exp of c.sql) {
        const i = pool.findIndex((o) => o.attribution?.file === exp.file
          && o.attribution?.line === exp.line);
        if (i < 0) {
          // 位置で見つからなければテーブル名で探し、「位置が取れなかった」と記録する
          const j = pool.findIndex((o) => o.tables.includes(exp.table));
          if (j < 0) { checks.push({ expect: exp, found: false }); continue; }
          const o = pool.splice(j, 1)[0];
          checks.push({
            expect: exp, found: true, locatedOk: false,
            attributionOk: exp.component === null && o.attribution?.component === null,
            tableOk: exp.tableInSchema === false
              ? o.tablesInSchema.length === 0
              : o.tablesInSchema.includes(exp.table),
            failedOk: (exp.failed ?? false) === o.failed,
            underRenderOk: o.depthFromRender >= 1,
          });
          continue;
        }
        const o = pool.splice(i, 1)[0];
        checks.push({
          expect: exp, found: true, locatedOk: true,
          attributionOk: exp.component === null
            ? o.attribution.component === null
              && o.attribution.reason === (exp.failureReason ?? o.attribution.reason)
            : o.attribution.component === exp.component && o.attribution.verified === true,
          tableOk: exp.tableInSchema === false
            ? o.tablesInSchema.length === 0
            : o.tablesInSchema.includes(exp.table),
          columnsOk: exp.columns ? exp.columns.every((k) => o.columns.includes(k)) : true,
          failedOk: (exp.failed ?? false) === o.failed,
          underRenderOk: o.depthFromRender >= 1,
        });
      }

      const browserApi = (per.pages[c.page]?.requests ?? [])
        .filter((r) => r.path.startsWith('/api/'));
      const docInitiatorType = (per.pages[c.page]?.requests ?? [])
        .find((r) => r.isDocument)?.initiatorType ?? null;

      gateB.push({
        key: c.key, label: c.label, page: c.page,
        documentCorrelated: !!doc.span,
        documentTraceId: trace,
        /** ブラウザから見えた通信（文書以外）。API 通信は 0 件であるべき */
        browserRequests: (per.pages[c.page]?.requests ?? []).length,
        browserApiRequests: browserApi.length,
        documentInitiatorType: docInitiatorType,
        renderSpanObserved: !!render,
        renderSpanName: render?.name ?? null,
        renderRoute: render?.attrs['next.route'] ?? null,
        spansInTrace: inTrace.length,
        sqlInTrace: sqlInTrace.length,
        sqlUnderRender: sqlUnderRender.length,
        /** 並行実行の検出。兄弟スパンの区間の重なり（01b Q-02 C-2） */
        overlaps: overlaps(sqlUnderRender.map((x) => x.span)),
        sql,
        checks,
        unexpected: pool.length,
        pass: checks.every((x) => x.found && x.attributionOk && x.tableOk
          && (x.columnsOk !== false) && x.failedOk && x.underRenderOk)
          && pool.length === 0
          && browserApi.length === (c.apiRequestsFromBrowser ?? 0)
          && !!render
          && (!c.expectOverlap || overlaps(sqlUnderRender.map((x) => x.span)).length > 0),
      });
    }

    /* ------------------------------------------------------ 全体の集計 */
    const attrAll = gateB.flatMap((g) => g.sql.map((s) => s.attribution));
    per.summary = {
      spans: spans.length,
      callsites: per.raw.callsites.length,
      entrySpans: allEntries.length,
      clientSpans: clients.length,
      sqlSpans: sqlSpans.length,
      distinctTraces: new Set(spans.map((s) => s.traceId)).size,
      /** 2つのサービスのスパンが同じトレースに入った件数 */
      crossServiceTraces: [...new Set(spans.map((s) => s.traceId))].filter((t) => {
        const svcs = new Set(spans.filter((s) => s.traceId === t).map((s) => s.service));
        return svcs.size > 1;
      }).length,
      /** 受け側が「traceparent が付いていた」と見た件数（値は持たない） */
      svcRequestsWithTraceparent: per.svcSeen?.withTraceparent ?? null,
      svcRequestsTotal: per.svcSeen?.total ?? null,
      /** 宛先ごとの内訳。計装されていない要求（ランナー自身）には付かない */
      svcTraceparentByPath: per.svcSeen?.byPath ?? null,
      gateAPass: gateA.every((g) => g.pass),
      gateBPass: gateB.every((g) => g.pass),
      attribution: {
        total: attrAll.length,
        resolved: attrAll.filter((a) => a.component).length,
        verified: attrAll.filter((a) => a.verified).length,
        refused: attrAll.filter((a) => !a.component).length,
        reasons: attrAll.filter((a) => !a.component).reduce((acc, a) => {
          const k = a.reason ?? 'none';
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
        /** スパン開始時のスタックに呼び出し元があった件数（**0 であることが要点**） */
        appFrameAtSpanStart: attrAll.filter((a) => a.appFrameAtSpanStart).length,
      },
    };
    /* ソースマップの索引の規模。位置を戻せなかったときの切り分けに使う */
    per.srvMapStats = srvMapStats();
    per.gateA = gateA;
    per.gateB = gateB;
    delete per.raw;
    result.byRun[runKey] = per;
    console.log(`  Gate A ${gateA.filter((g) => g.pass).length}/${gateA.length}`
      + ` / Gate B ${gateB.filter((g) => g.pass).length}/${gateB.length}`
      + ` / 帰属 ${per.summary.attribution.resolved}/${per.summary.attribution.total}`
      + ` / 伝播した要求 ${per.summary.svcRequestsWithTraceparent}/${per.summary.svcRequestsTotal}`);
  }
}

/* -------------------------------------------- 秘密情報が入っていないかの検査 */
const text = JSON.stringify(result);
const hits = FORBIDDEN.filter((re) => re.test(text)).map(String);
if (hits.length) throw new Error(`計測結果に収集禁止の痕跡がある: ${hits.join(', ')}`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'poc02.json'), JSON.stringify(result, null, 2));

/* 要約はリポジトリに残す（テストが読む）。絶対パスを落とす */
const summary = JSON.parse(JSON.stringify(result).replaceAll(REPO, '<repo>'));
fs.writeFileSync(path.join(REPO, 'docs', '06d-poc02-matrix.json'), JSON.stringify(summary, null, 2));
console.log(`\n→ ${path.join(OUT, 'poc02.json')}`);
console.log('→ docs/06d-poc02-matrix.json');
