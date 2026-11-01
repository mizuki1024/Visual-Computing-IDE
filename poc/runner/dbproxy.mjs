/* =============================================================================
 * PoC-01 手順4 — 方式5（DBプロキシ）の成立確認。
 *   node poc/runner/dbproxy.mjs
 *
 * アプリにもライブラリにも計装を入れず、PostgreSQL のワイヤプロトコルを中継して
 * SQL を取り出せるかを見る。あわせて「並行リクエスト時に接続とSQLを対応付けられるか」
 * を確かめる — ここが代替2 が L2 に落ちる理由である（Q-01 C-6）。
 *
 * 取るのは文の構造だけ。パラメータ値（Bind メッセージ）は読まない。
 * ========================================================================== */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startApp } from './lib/server.mjs';
import { drivePages, hammer } from './lib/drive.mjs';
import * as pglog from './lib/pglog.mjs';
import { APP, OUT, sleep } from './lib/util.mjs';

const require_ = createRequire(path.join(APP, 'package.json'));
const { redactSql } = require_('./ide-instrumentation/mask.cjs');

const LISTEN = 55433;
const UPSTREAM = { host: '127.0.0.1', port: 55432 };

/** 取り出した文。接続ごとに並ぶ */
const captured = [];
/** メッセージ種別の出現回数。中身は読まない（Bind にはパラメータ値が入る） */
const messageCounts = {};
let connSeq = 0;

/**
 * フロントエンド側のメッセージを切り出す。
 * 最初の1通は起動パケット（型バイトが無い）。以後は 型1バイト + 長さ4バイト。
 * 読むのは 'Q'(Simple Query) と 'P'(Parse) のクエリ文字列だけである。
 * 'B'(Bind) は**読まない** — パラメータ値が入っているため。
 */
function makeParser(connId) {
  let buf = Buffer.alloc(0);
  let sawStartup = false;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!sawStartup) {
        if (buf.length < 8) return;
        const len = buf.readInt32BE(0);
        if (buf.length < len) return;
        const code = buf.readInt32BE(4);
        buf = buf.subarray(len);
        // SSLRequest / GSSENCRequest は起動パケットの形で来る。
        // サーバーが断ると、本当の起動パケットがもう一度来る（ここを読み違えると
        // 以後のメッセージ境界がずれ、Prisma の通信をまるごと取り落とす）
        const isNegotiation = len === 8 && (code === 80877103 || code === 80877104);
        if (!isNegotiation) sawStartup = true;
        continue;
      }
      if (buf.length < 5) return;
      const type = String.fromCharCode(buf[0]);
      const len = buf.readInt32BE(1);
      if (len < 4 || buf.length < len + 1) return;
      const body = buf.subarray(5, len + 1);
      buf = buf.subarray(len + 1);

      messageCounts[type] = (messageCounts[type] ?? 0) + 1;

      let sql = null;
      if (type === 'Q') {
        const end = body.indexOf(0);
        sql = body.subarray(0, end < 0 ? body.length : end).toString('utf8');
      } else if (type === 'P') {
        const nameEnd = body.indexOf(0);
        const rest = body.subarray(nameEnd + 1);
        const end = rest.indexOf(0);
        sql = rest.subarray(0, end < 0 ? rest.length : end).toString('utf8');
      }
      if (sql) {
        const r = redactSql(sql);
        captured.push({
          conn: connId,
          type,
          atMs: Date.now(),
          sql: r.text,
          redacted: r.redacted,
        });
      }
    }
  };
}

const proxy = net.createServer((client) => {
  const connId = ++connSeq;
  const parse = makeParser(connId);
  const upstream = net.connect(UPSTREAM);
  client.on('data', (c) => { try { parse(c); } catch { /* 中継は止めない */ } upstream.write(c); });
  upstream.on('data', (c) => client.write(c));
  const bye = () => { client.destroy(); upstream.destroy(); };
  client.on('error', bye); upstream.on('error', bye);
  client.on('close', bye); upstream.on('close', bye);
});
await new Promise((r) => proxy.listen(LISTEN, '127.0.0.1', r));
console.log(`proxy listening on ${LISTEN} → ${UPSTREAM.port}`);

const before = pglog.snapshot();
const app = await startApp({
  mode: 'none', bundler: 'turbopack', run: 'dbproxy',
  env: {
    // 接続先だけを差し替える。アプリのコードは一切変えていない
    DATABASE_URL: `postgresql://poc01:poc01_local_only@127.0.0.1:${LISTEN}/poc01?schema=poc`,
  },
});

let result;
try {
  // 先にコンパイルを済ませる。初回コンパイルの待ちを観測に混ぜない
  await hammer(['/api/listings', '/api/listings/3', '/api/stats'], 1);
  await drivePages(['/', '/listings', '/listings/3']);
  // 並行リクエスト。接続とSQLの対応付けができるかを見る
  const concurrent = await Promise.all([
    hammer(['/api/listings'], 5),
    hammer(['/api/listings/3'], 5),
    hammer(['/api/stats'], 5),
  ]);
  await sleep(800);
  const gt = pglog.since(before);
  const dml = captured.filter((c) => /^(select|insert|update|delete|with)\b/i.test(c.sql));
  const byConn = {};
  for (const c of dml) (byConn[c.conn] ??= []).push(c.sql.slice(0, 60));

  result = {
    method: '方式5（PostgreSQL ワイヤプロトコルのローカルプロキシ）',
    appInstrumented: false,
    connections: connSeq,
    capturedStatements: captured.length,
    capturedDml: dml.length,
    dbLogDml: gt.dml.length,
    /*
     * 文の「種類」は取れる。しかし Prisma はプリペアドステートメントを使うため、
     * 同じ文の2回目以降は Parse を送らない。文字列としての取得率が低いのは
     * 取りこぼしではなく、プロトコルの性質である。
     */
    distinctStatementCaptureNote:
      'Parse は文ごとに1回しか飛ばない。文字列の出現数と実行回数は一致しない',
    uniqueStatementsCaptured: new Set(dml.map((c) => c.sql)).size,
    uniqueStatementsInDbLog: new Set(gt.dml).size,
    uniqueStatementCaptureRate: new Set(gt.dml).size
      ? +(new Set(dml.map((c) => c.sql)).size / new Set(gt.dml).size).toFixed(4) : null,
    /** 実行回数は Execute メッセージの数で数えられる（中身は読まない） */
    executeMessages: messageCounts.E ?? 0,
    simpleQueryMessages: messageCounts.Q ?? 0,
    executionCountVsDbLog: gt.dml.length
      ? +(((messageCounts.E ?? 0) + (messageCounts.Q ?? 0)) / gt.dml.length).toFixed(4) : null,
    messageCounts,
    textCaptureRateVsDbLog: gt.dml.length ? +(dml.length / gt.dml.length).toFixed(4) : null,
    statementsPerConnection: Object.fromEntries(
      Object.entries(byConn).map(([k, v]) => [k, v.length]),
    ),
    // どの HTTP リクエストが出した SQL かは、プロキシからは分からない
    httpCorrelation: {
      possible: false,
      why: 'プロキシが見えるのは接続とSQLだけで、どの HTTP リクエストが発行したかの情報が無い。'
        + '接続プールが複数リクエストで使い回されるため、接続IDでも一意にならない。',
      fallback: '時間窓による推定（02d の source = time-window、L2）',
    },
    parametersRead: false,
    note: 'Bind メッセージ（パラメータ値が入る）は読んでいない。Parse / Simple Query の文だけを取っている。',
    concurrentRequests: concurrent.flat().length,
    sample: dml.slice(0, 4).map((c) => ({ conn: c.conn, sql: c.sql.slice(0, 120), redacted: c.redacted })),
  };
} finally {
  await app.stop();
  proxy.close();
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'dbproxy.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, sample: undefined }, null, 2));
console.log(`→ ${path.join(OUT, 'dbproxy.json')}`);
process.exit(0);
