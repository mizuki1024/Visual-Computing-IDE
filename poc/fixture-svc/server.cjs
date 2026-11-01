/* =============================================================================
 * PoC-02 Gate A の相手側 — **隔離した2つ目の検証用サービス**。
 *
 * 検証用アプリ（Next.js, :3200）とは別プロセス・別の service.name で動く。
 * 実案件のサービスではない。ループバックにしか listen しない。
 *
 * 計装は検証用アプリと同じ `ide-instrumentation/otel.cjs` を
 * `NODE_OPTIONS=--require` で前置して読む（このファイルは計装を知らない）。
 *
 * 目的はただ1つ: **Next.js のサーバーから出た要求に W3C トレースコンテキストが
 * 載っていれば、こちら側の入口スパンがその子になる**ことを、
 * 別プロセスで確かめることである。
 *
 * 収集しないもの: ヘッダの値 / 本文 / Cookie / 認証情報 / 行データ。
 * この file が読むのは `traceparent` が**付いていたかの真偽だけ**である。
 * ========================================================================== */
const http = require('node:http');
const path = require('node:path');
/* `pg` は検証用アプリの node_modules から読む（このサービス専用の依存を増やさない）。
 * 計装も同じ node_modules を使うので、同じ `pg` のモジュール実体にフックが当たる。 */
const appRequire = require('node:module').createRequire(
  path.join(process.cwd(), 'package.json'),
);
const { Pool } = appRequire('pg');

const PORT = Number(process.env.POC02_SVC_PORT || 3300);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

/** 受け取った要求にトレースコンテキストが載っていたか（値は持たない） */
const seen = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // ヘッダは「付いていたか」だけを見る。値を保存も出力もしない
  seen.push({ path: url.pathname, hadTraceparent: !!req.headers.traceparent });
  res.setHeader('content-type', 'application/json');
  try {
    if (url.pathname === '/echo') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, service: 'poc02-fixture-svc' }));
      return;
    }
    if (url.pathname === '/rows') {
      // 2つ目のサービスの中で SQL を実行する。経路が
      // Next → svc → PostgreSQL と2段になる
      const r = await pool.query(
        'SELECT code, name FROM poc.regions ORDER BY code LIMIT 4',
      );
      res.writeHead(200);
      res.end(JSON.stringify({ count: r.rowCount }));
      return;
    }
    if (url.pathname === '/boom') {
      // 失敗の題材。本文に内部情報を出さない
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'intentional-failure' }));
      return;
    }
    if (url.pathname === '/__seen') {
      // 検証用。トレースコンテキストが付いていたかの集計だけを返す
      res.writeHead(200);
      res.end(JSON.stringify({
        total: seen.length,
        withTraceparent: seen.filter((s) => s.hadTraceparent).length,
        byPath: seen.reduce((a, s) => {
          const k = s.path;
          a[k] = a[k] || { total: 0, withTraceparent: 0 };
          a[k].total++;
          if (s.hadTraceparent) a[k].withTraceparent++;
          return a;
        }, {}),
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not-found' }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'query-failed' }));
  }
});

// ループバックにのみ listen する
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`poc02-fixture-svc listening on 127.0.0.1:${PORT}\n`);
});
