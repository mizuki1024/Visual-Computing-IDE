/* 検証アプリの dev server の起動と停止。計装の2方式をここで切り替える。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { APP, APP_PORT, DB_URL, OUT, sleep, waitFor } from './util.mjs';

/** ポートが空くまで待つ。空いていないと Next が別のポートへ逃げる。 */
async function waitPortFree(port, timeout = 30000) {
  const free = () => new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
  await waitFor(free, { timeout, interval: 300 });
}

/**
 * @param {{mode:'method1'|'method2'|'none', bundler:'turbopack'|'webpack',
 *          run:string, verbose?:boolean}} opt
 */
export async function startApp(opt) {
  const spanFile = path.join(OUT, 'spans', `${opt.run}.jsonl`);
  fs.mkdirSync(path.dirname(spanFile), { recursive: true });
  fs.rmSync(spanFile, { force: true });

  const env = {
    ...process.env,
    DATABASE_URL: DB_URL,
    POC01_MODE: opt.mode,
    POC01_BUNDLER: opt.bundler,
    POC01_RUN: opt.run,
    POC01_SPAN_FILE: spanFile,
    // 方式1 を黙らせる場合は instrumentation.ts 側で POC01_MODE を見ている
    NEXT_OTEL_VERBOSE: opt.verbose === false ? '' : '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  if (opt.mode === 'method2') {
    // 方式2: プロジェクトへファイルを追加せず、環境変数だけで前置する。
    // dev server がワーカーを分けても環境は継承される（UR-03 の検証点）
    // NODE_OPTIONS は空白で分割される。空白を含むパスは二重引用符で囲む必要がある
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require "${
      path.join(APP, 'ide-instrumentation', 'boot.cjs')}"`.trim();
  }
  if (opt.mode === 'none') env.POC01_SPAN_FILE = '';
  /* 呼び出し側が Node のフラグを足せるようにする（PoC-02 で
   * --enable-source-maps の効果を測るために使う）。既定では何も足さない */
  if (opt.nodeOptions) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ''} ${opt.nodeOptions}`.trim();
  }
  // 呼び出し側が環境を差し替えられるようにする（DBプロキシ方式の検証で使う）
  Object.assign(env, opt.env ?? {});

  const args = ['next', 'dev', '-p', String(APP_PORT),
    opt.bundler === 'webpack' ? '--webpack' : '--turbopack'];

  await waitPortFree(APP_PORT);

  const t0 = Date.now();
  // プロセスグループを作る。npx の子である next-server まで確実に止めるため
  const child = spawn('npx', args, {
    cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));

  // 「Ready」の出力ではなく、実際に応答が返ることを起動完了とする
  await waitFor(async () => {
    const r = await fetch(`http://localhost:${APP_PORT}/api/listings`).catch(() => null);
    return r && r.ok;
  }, { timeout: 120000 });
  const readyMs = Date.now() - t0;

  return {
    child, spanFile, readyMs, log,
    async stop() {
      for (const sig of ['SIGTERM', 'SIGKILL']) {
        try { process.kill(-child.pid, sig); } catch { /* 既に落ちている */ }
        await sleep(sig === 'SIGTERM' ? 900 : 300);
      }
      await waitPortFree(APP_PORT).catch(() => {});
    },
  };
}

/**
 * 収集した JSONL を、記録の種別ごとに分けて読む（PoC-02）。
 * `readSpans` はスパンと注記の2種類しか知らないので、
 * 呼び出しスタックの記録（type: 'callsite'）を混ぜないための関数である。
 */
export function readRecords(file, service = 'app') {
  if (!file || !fs.existsSync(file)) return { spans: [], notes: [], callsites: [] };
  const spans = [];
  const notes = [];
  const callsites = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'note') notes.push(o);
    else if (o.type === 'callsite') callsites.push({ ...o, service });
    else spans.push({ ...o, service });
  }
  return { spans, notes, callsites };
}

/** 収集した JSONL を読む。 */
export function readSpans(file) {
  if (!file || !fs.existsSync(file)) return { spans: [], notes: [] };
  const spans = [];
  const notes = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    (o.type === 'note' ? notes : spans).push(o);
  }
  return { spans, notes };
}
