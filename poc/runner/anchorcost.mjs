/* =============================================================================
 * PoC-03 のビルドコストの再計測（PoC-05 第7節）。
 *   node poc/runner/anchorcost.mjs
 * 出力: poc/out/anchorcost.json / docs/06c-anchorcost.json
 *
 * 測るのは次の5つである。**条件をそろえる**ことを目的にしている。
 *   1 構文解析器の読み込み時間（プロセスごとに1回のコスト）
 *   2 ファイル1枚あたりの変換時間（初回と2回目以降）
 *   3 ルートの初回コンパイルと再コンパイルの差
 *   4 Turbopack と webpack の差
 *   5 ビルドのキャッシュが効いたときに、変換そのものが走るか
 *
 * **注入の結果は変えない。** 計測のための記録は環境変数で切り替え、
 * 既定では一切動かない（PoC-03 の精度と安全性を下げない）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { startApp } from './lib/server.mjs';
import { APP, OUT, POC, REPO, median, sleep } from './lib/util.mjs';

const require_ = createRequire(import.meta.url);
const BASE = 'http://localhost:3200';
const N = Number(process.env.POC05_COST_N ?? 5);
const COST_LOG = path.join(OUT, 'anchorcost.jsonl');
const ANCHORS = path.join(OUT, 'anchors-cost');
/** 初回コンパイルを測る対象。起動時に触られないルートを選ぶ */
const ROUTE = '/cards';
const TOUCH = path.join(APP, 'src', 'app', 'cards', 'page.tsx');

const out = { collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), n: N };

/* ------------------------------------------- 1. 構文解析器の読み込み時間 */
{
  const runs = [];
  for (let i = 0; i < 7; i++) {
    // 毎回まっさらなプロセスで測る。同じプロセスで2回測ると require がキャッシュされる
    const ms = execFileSync(process.execPath, ['-e',
      "const t=Date.now();require('typescript');process.stdout.write(String(Date.now()-t))"],
    { cwd: POC, encoding: 'utf8' });
    runs.push(Number(ms));
  }
  out.parserLoad = { runs, medianMs: median(runs) };
  console.log(`1. 構文解析器の読み込み: 中央値 ${out.parserLoad.medianMs} ms`);
}

/* --------------------------------------------- 2. ファイル1枚の変換時間 */
{
  const { transform } = require_('../anchor/transform.cjs');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.tsx')) files.push(p);
    }
  };
  walk(path.join(APP, 'src'));
  const per = [];
  for (const f of files) {
    const rel = path.relative(APP, f).split(path.sep).join('/');
    const code = fs.readFileSync(f, 'utf8');
    const t0 = process.hrtime.bigint();
    transform(code, rel);
    const first = Number(process.hrtime.bigint() - t0) / 1e6;
    const warm = [];
    for (let i = 0; i < 30; i++) {
      const t = process.hrtime.bigint();
      transform(code, rel);
      warm.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    per.push({ file: rel, bytes: code.length, firstMs: +first.toFixed(3),
      warmMedianMs: +median(warm).toFixed(3) });
  }
  out.perFile = {
    files: per,
    totalWarmMs: +per.reduce((a, x) => a + x.warmMedianMs, 0).toFixed(3),
    // 最初の1枚は構文解析器の遅延初期化を含む
    firstFileMs: per[0].firstMs,
  };
  console.log(`2. 変換 ${per.length} ファイル: 合計 ${out.perFile.totalWarmMs} ms`
    + `（最初の1枚 ${out.perFile.firstFileMs} ms）`);
}

/* ------------------------ 3〜5. dev server での測定（条件をそろえる） */
const INSTR = path.join(APP, 'src', 'instrumentation.ts');
const PARKED = `${INSTR}.parked`;
const park = () => { if (fs.existsSync(INSTR)) fs.renameSync(INSTR, PARKED); };
const unpark = () => { if (fs.existsSync(PARKED)) fs.renameSync(PARKED, INSTR); };

/** ルートが応答するまでの時間。コンパイルが走る場合はそれを含む */
async function timeRoute(route) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${route}`);
  await r.arrayBuffer();
  return { ms: Date.now() - t0, status: r.status };
}

/**
 * @param {'off'|'noop'|'on'} variant
 *   off  ローダ無し
 *   noop ローダはあるが何もしない（ローダを挟むこと自体のコスト）
 *   on   要素識別子を注入する
 */
async function runOnce(bundler, variant, { cold }) {
  if (cold) fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  fs.rmSync(ANCHORS, { recursive: true, force: true });
  const env = { off: { POC03_ANCHOR: '0' }, noop: { POC03_ANCHOR: 'noop' },
    on: { POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCHORS, POC03_ANCHOR_COST: COST_LOG } }[variant];
  const app = await startApp({
    mode: 'none', bundler, run: `cost-${bundler}-${variant}`, verbose: false, env,
  });
  try {
    const first = await timeRoute(ROUTE);
    // 同じルートをもう一度。コンパイル済みなので、純粋な応答時間に近い
    const second = await timeRoute(ROUTE);
    // ファイルを触って再コンパイルさせる（内容は変えない）
    const src = fs.readFileSync(TOUCH, 'utf8');
    fs.writeFileSync(TOUCH, src);
    await sleep(400);
    const recompile = await timeRoute(ROUTE);
    return {
      readyMs: app.readyMs,
      firstCompileMs: first.ms,
      servedMs: second.ms,
      recompileMs: recompile.ms,
      status: first.status,
    };
  } finally {
    await app.stop();
  }
}

park();
fs.rmSync(COST_LOG, { force: true });
try {
  out.dev = {};
  for (const bundler of ['turbopack', 'webpack']) {
    for (const variant of ['off', 'noop', 'on']) {
      const key = `${bundler}-${variant}`;
      const cold = [];
      const warm = [];
      for (let i = 0; i < N; i++) {
        cold.push(await runOnce(bundler, variant, { cold: true }));
        // 直後に、ビルドのキャッシュを消さずにもう一度起動する
        warm.push(await runOnce(bundler, variant, { cold: false }));
      }
      const pick = (rows, k) => median(rows.map((r) => r[k]));
      out.dev[key] = {
        cold: {
          readyMs: pick(cold, 'readyMs'),
          firstCompileMs: pick(cold, 'firstCompileMs'),
          servedMs: pick(cold, 'servedMs'),
          recompileMs: pick(cold, 'recompileMs'),
        },
        warmCache: {
          readyMs: pick(warm, 'readyMs'),
          firstCompileMs: pick(warm, 'firstCompileMs'),
          servedMs: pick(warm, 'servedMs'),
          recompileMs: pick(warm, 'recompileMs'),
        },
        runs: { cold, warm },
      };
      console.log(`3. ${key}: 起動 ${out.dev[key].cold.readyMs}ms /`
        + ` 初回 ${out.dev[key].cold.firstCompileMs}ms /`
        + ` 再コンパイル ${out.dev[key].cold.recompileMs}ms /`
        + ` キャッシュあり初回 ${out.dev[key].warmCache.firstCompileMs}ms`);
    }
  }
} finally {
  unpark();
}

/* ------------------------------------------ ローダが実際に払ったコスト */
{
  const rows = fs.existsSync(COST_LOG)
    ? fs.readFileSync(COST_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const workers = new Map();
  for (const r of rows) {
    if (r.event !== 'worker-start') continue;
    if (!workers.has(r.pid)) workers.set(r.pid, r.tsLoadMs);
  }
  const transforms = rows.filter((r) => r.event === 'transform');
  out.loader = {
    workerProcesses: workers.size,
    tsLoadMsPerWorker: [...workers.values()],
    tsLoadTotalMs: [...workers.values()].reduce((a, b) => a + b, 0),
    transformCount: transforms.length,
    transformTotalMs: +transforms.reduce((a, r) => a + r.ms, 0).toFixed(2),
    transformMedianMs: +Number(median(transforms.map((r) => r.ms)) ?? 0).toFixed(3),
    /** 同じファイルが何回変換されたか（キャッシュの効き具合） */
    byFile: Object.entries(transforms.reduce((acc, r) => {
      acc[r.file] = (acc[r.file] ?? 0) + 1; return acc;
    }, {})).sort((a, b) => b[1] - a[1]),
  };
  console.log(`4. ローダ: ワーカー ${out.loader.workerProcesses} 個 /`
    + ` 解析器読み込み合計 ${out.loader.tsLoadTotalMs}ms /`
    + ` 変換 ${out.loader.transformCount} 回 合計 ${out.loader.transformTotalMs}ms`);
}

/* ------------------------------------------------------------ 比較 */
{
  const d = out.dev;
  const pct = (on, off) => (off ? +(((on - off) / off) * 100).toFixed(1) : null);
  out.comparison = {};
  for (const b of ['turbopack', 'webpack']) {
    const on = d[`${b}-on`];
    const noop = d[`${b}-noop`];
    const off = d[`${b}-off`];
    out.comparison[b] = {
      cold: {
        readyPct: pct(on.cold.readyMs, off.cold.readyMs),
        readyDeltaMs: on.cold.readyMs - off.cold.readyMs,
        firstCompilePct: pct(on.cold.firstCompileMs, off.cold.firstCompileMs),
        firstCompileDeltaMs: on.cold.firstCompileMs - off.cold.firstCompileMs,
        recompilePct: pct(on.cold.recompileMs, off.cold.recompileMs),
        recompileDeltaMs: on.cold.recompileMs - off.cold.recompileMs,
      },
      warmCache: {
        readyPct: pct(on.warmCache.readyMs, off.warmCache.readyMs),
        firstCompilePct: pct(on.warmCache.firstCompileMs, off.warmCache.firstCompileMs),
        firstCompileDeltaMs: on.warmCache.firstCompileMs - off.warmCache.firstCompileMs,
      },
      /* 増分の内訳。ローダを挟むこと自体と、注入そのものを分ける */
      split: {
        loaderItselfMs: noop.cold.firstCompileMs - off.cold.firstCompileMs,
        injectionMs: on.cold.firstCompileMs - noop.cold.firstCompileMs,
        loaderItselfPct: pct(noop.cold.firstCompileMs, off.cold.firstCompileMs),
        injectionPct: pct(on.cold.firstCompileMs, noop.cold.firstCompileMs),
        recompileLoaderItselfMs: noop.cold.recompileMs - off.cold.recompileMs,
        recompileInjectionMs: on.cold.recompileMs - noop.cold.recompileMs,
      },
    };
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'anchorcost.json'), JSON.stringify(out, null, 2));
const summary = JSON.parse(JSON.stringify(out).replaceAll(REPO, '<repo>'));
fs.writeFileSync(path.join(REPO, 'docs', '06c-anchorcost.json'), JSON.stringify(summary, null, 2));
console.log(`\n→ ${path.join(OUT, 'anchorcost.json')}`);
console.log('→ docs/06c-anchorcost.json');
