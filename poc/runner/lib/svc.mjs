/* =============================================================================
 * 隔離した2つ目の検証用サービスの起動と停止（PoC-02 Gate A の相手側）。
 *
 * 検証用アプリと**同じ計装**を NODE_OPTIONS=--require で前置する。
 * サービス自身のコードは計装を知らない。スパンは別ファイルへ書き出す。
 * ループバックにしか listen しない。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP, DB_URL, OUT, POC, sleep, waitFor } from './util.mjs';

export const SVC_PORT = 3300;
export const SVC_ORIGIN = `http://127.0.0.1:${SVC_PORT}`;

/** @param {{run:string, undici?:boolean, callsite?:boolean}} opt */
export async function startSvc(opt) {
  const spanFile = path.join(OUT, 'spans', `${opt.run}-svc.jsonl`);
  fs.mkdirSync(path.dirname(spanFile), { recursive: true });
  fs.rmSync(spanFile, { force: true });

  const env = {
    ...process.env,
    DATABASE_URL: DB_URL,
    POC01_MODE: 'method2',
    POC01_BUNDLER: 'none',
    POC01_RUN: `${opt.run}-svc`,
    POC01_SPAN_FILE: spanFile,
    POC02_SERVICE_NAME: 'poc02-fixture-svc',
    POC02_SVC_PORT: String(SVC_PORT),
    POC02_UNDICI: opt.undici ? '1' : '0',
    POC02_CALLSITE: opt.callsite ? '1' : '0',
    // 応答にトレース識別子を載せ返すのはブラウザ向けの仕組みであり、
    // サービス間では使わない。サービス間の対応付けは伝播で見る
    POC05_SERVER_TIMING: '0',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${
      path.join(APP, 'ide-instrumentation', 'boot.cjs')}"`.trim(),
  };

  const child = spawn('node', [path.join(POC, 'fixture-svc', 'server.cjs')], {
    cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));

  await waitFor(async () => {
    const r = await fetch(`${SVC_ORIGIN}/echo`).catch(() => null);
    return r && r.ok;
  }, { timeout: 30000 });

  return {
    child, spanFile, log,
    /** 相手側が「traceparent が付いていたか」をどう見たか（値は持たない） */
    async seen() {
      const r = await fetch(`${SVC_ORIGIN}/__seen`).catch(() => null);
      return r && r.ok ? r.json() : null;
    },
    async stop() {
      for (const sig of ['SIGTERM', 'SIGKILL']) {
        try { process.kill(-child.pid, sig); } catch { /* 既に落ちている */ }
        await sleep(sig === 'SIGTERM' ? 400 : 200);
      }
    },
  };
}
