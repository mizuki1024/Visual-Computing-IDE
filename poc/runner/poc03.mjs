/* =============================================================================
 * PoC-03 — 画面の値 → DOM要素 → Reactコンポーネント → ソース位置。
 *
 *   node poc/runner/poc03.mjs
 * 出力: poc/out/poc03.json（方式比較・正答／誤答／特定不能の内訳・ビルド時間）
 *
 * 判定の原則（01b Q-03.4）: 正解率より**誤答率**を重く見る。
 * 誤ったファイルを自信を持って指すことは、特定不能と返すより有害である。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startApp } from './lib/server.mjs';
import { INSTALL, TARGETS } from './lib/probe.mjs';
import { lineText, verifyLocation } from './lib/srcverify.mjs';
import { originalPositionFor } from './lib/srcmap.mjs';
import { writeMatrixDoc } from './lib/matrixdoc.mjs';
import { APP, APP_PORT, OUT, median, sleep } from './lib/util.mjs';

const BASE = `http://localhost:${APP_PORT}`;
const ANCHOR_OUT = path.join(OUT, 'anchors');
const PAGES = ['/cards', '/cards-rsc'];

/* ------------------------------------------------------------- マニフェスト */

function readManifest() {
  const byId = new Map();
  const files = [];
  if (!fs.existsSync(ANCHOR_OUT)) return { byId, files };
  for (const f of fs.readdirSync(ANCHOR_OUT)) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(ANCHOR_OUT, f), 'utf8'));
    files.push(j);
    for (const a of j.anchors) byId.set(a.id, a);
  }
  return { byId, files };
}

const clearManifest = () => fs.rmSync(ANCHOR_OUT, { recursive: true, force: true });

/* ------------------------------------------------------------ 対応付けの解決 */

/**
 * 観測した DOM の鍵から出所を決める。
 * **要素自身に付いた識別子だけを出所として扱う。** 祖先は文脈にすぎない。
 */
function resolve(byId, pick) {
  if (!pick || !pick.found) return { status: 'element-not-found' };
  if (!pick.documentHasAnchors) {
    return { status: 'failure', reason: 'not-instrumented-build' };
  }
  if (!pick.anchorOnSelf) {
    return {
      status: 'failure',
      reason: 'anchor-missing',
      // 祖先の識別子は出所にしない。ここに書くのは「文脈」としてだけである
      nearestAncestorAnchor: pick.ancestorAnchors[0]?.id ?? null,
    };
  }
  const a = byId.get(pick.anchorOnSelf);
  if (!a) return { status: 'failure', reason: 'unidentifiable', detail: 'manifest-miss' };
  if (a.tag !== pick.tag) {
    // 識別子の指すタグと実際のタグが違う = 対応付けが壊れている
    return { status: 'failure', reason: 'unidentifiable', detail: `tag-mismatch:${a.tag}/${pick.tag}` };
  }
  return {
    status: 'resolved',
    file: a.file, line: a.line, col: a.col, tag: a.tag,
    component: a.component, componentLine: a.componentLine,
  };
}

/* --------------------------------------------- 方式2（_debugStack + sourcemap） */

const mapCache = new Map();

/** チャンクを取り、末尾の sourceMappingURL を辿って本物のソースマップを得る */
async function loadMap(url) {
  if (mapCache.has(url)) return mapCache.get(url);
  let m = null;
  try {
    const r = await fetch(url);
    if (r.ok) {
      const body = await r.text();
      const mm = /\/\/#\s*sourceMappingURL=(\S+)\s*$/.exec(body.trimEnd());
      if (mm) {
        const ref = mm[1];
        if (ref.startsWith('data:')) {
          const b64 = ref.slice(ref.indexOf(',') + 1);
          m = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        } else {
          const abs = new URL(ref, url).href;
          const r2 = await fetch(abs);
          if (r2.ok) m = await r2.json();
        }
      }
    }
  } catch { /* 取れないことは結果である */ }
  mapCache.set(url, m);
  return m;
}

/** パスから `src/...` 部分を取り出す。取り出せなければ null */
function toRel(p) {
  const m = /(?:^|[/[(])(src\/[^\s)\]]+)$/.exec(String(p).replace(/\?.*$/, ''));
  return m ? m[1] : null;
}

/**
 * 方式2: _debugStack のフレームを順に解き、ユーザーのソースに当たった
 * 最初の位置を返す。フレームの URL 自体がソースを指している場合
 * （webpack の eval-source-map 等）はソースマップを使わずに読む。
 */
async function resolveViaDebugStack(react) {
  if (!react || !react.hasDebugStack) return { status: 'no-debug-stack' };
  const frames = react.debugStackFrames ?? [];
  if (!frames.length) return { status: 'no-frames' };
  const tried = [];
  for (const f of frames) {
    const direct = toRel(f.url);
    if (direct) {
      tried.push({ url: f.url, source: direct, line: f.line, column: f.col, via: 'frame-url' });
      return { status: 'resolved', file: direct, line: f.line, col: f.col, via: 'frame-url', tried };
    }
    const map = await loadMap(f.url);
    if (!map) { tried.push({ url: f.url, why: 'no-sourcemap' }); continue; }
    const pos = originalPositionFor(map, f.line, f.col - 1);
    if (!pos) { tried.push({ url: f.url, why: 'no-mapping' }); continue; }
    const rel = toRel(pos.source);
    tried.push({ url: f.url, source: pos.source, rel, line: pos.line, column: pos.column, via: 'sourcemap' });
    if (rel) return { status: 'resolved', file: rel, line: pos.line, col: pos.column, via: 'sourcemap', tried };
  }
  return { status: 'no-user-source', tried };
}

/* ---------------------------------------------------------------- 採点 */

function grade(target, res) {
  if (target.expect === null) {
    if (res.status === 'failure') return { verdict: 'correct-unidentifiable', reason: res.reason };
    if (res.status === 'resolved') {
      return {
        verdict: 'wrong',
        why: 'resolved-but-should-be-unidentifiable',
        got: `${res.file}:${res.line}`,
        hitForbidden: res.file === target.mustNotResolveTo,
      };
    }
    return { verdict: 'error', why: res.status };
  }
  if (res.status !== 'resolved') return { verdict: 'unidentifiable', reason: res.reason ?? res.status };
  const e = target.expect;
  const same = res.file === e.file && res.line === e.line
    && res.tag === e.tag && res.component === e.component;
  if (!same) {
    return { verdict: 'wrong', why: 'mismatch', got: `${res.file}:${res.line} ${res.tag} @${res.component}` };
  }
  // マニフェストを信用しない。ソースを読み直して同じ位置に同じ要素があるか見る
  const v = verifyLocation({ file: res.file, line: res.line, col: res.col, tag: res.tag, component: res.component });
  if (!v.ok) return { verdict: 'wrong', why: `source-verify:${v.why}` };
  return { verdict: 'correct' };
}

/* ------------------------------------------------------------- 1構成の観測 */

async function observe(bundler) {
  clearManifest();
  fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
  const app = await startApp({
    mode: 'none', bundler, run: `poc03-${bundler}`,
    env: { POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCHOR_OUT },
  });
  const rows = [];
  const facts = { bundler, startupMs: app.readyMs, pages: {}, ownerStack: null };
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const p of PAGES) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${BASE}${p}`, { waitUntil: 'load', timeout: 90000 });
      if (p === '/cards') {
        await page.waitForSelector('article.card', { timeout: 30000 });
        await page.waitForSelector('span.injected', { timeout: 10000 }).catch(() => null);
      }
      await page.waitForTimeout(400);
      await page.evaluate(INSTALL);
      facts.pages[p] = {
        anchoredElements: await page.evaluate('document.querySelectorAll("[data-vcide]").length'),
        totalElements: await page.evaluate('document.querySelectorAll("*").length'),
      };

      for (const t of TARGETS.filter((x) => x.page === p)) {
        // 本物の click イベントを、本物の捕捉リスナーで受ける
        const ok = await page.evaluate(
          `(() => { const l = document.querySelectorAll(${JSON.stringify(t.sel)});
             const el = l[${t.ord}]; if (!el) return false;
             el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; })()`,
        );
        const pick = ok ? await page.evaluate('window.__vcidePick') : { found: false };
        // ソースマップは dev server からしか取れない。**止める前に**解く
        const m2 = await resolveViaDebugStack(pick.react);
        rows.push({ target: t, pick, m2 });
      }

      if (p === '/cards') {
        // 1件はハードウェア相当の実クリックでも通す（経路が同じことの確認）
        await page.click('span.badge-text', { timeout: 10000 }).catch(() => null);
        facts.hardwareClick = await page.evaluate('window.__vcidePick');
        facts.clickCount = await page.evaluate('window.__vcidePickCount');
        facts.ownerStack = await page.evaluate(
          '(() => { const s = window.__vcideOwnerStack; return s == null ? null '
          + ': String(s).split("\\n").slice(0, 4).join(" | "); })()',
        );
      }
      await page.close();
    }
  } finally {
    await browser.close();
    await app.stop();
  }
  return { facts, rows };
}

/* ------------------------------------------------- ビルド時間（注入あり/なし） */

async function buildTime(bundler, anchor, times = 3) {
  const starts = [];
  const firstPaints = [];
  for (let i = 0; i < times; i++) {
    clearManifest();
    fs.rmSync(path.join(APP, '.next'), { recursive: true, force: true });
    const app = await startApp({
      mode: 'none', bundler, run: `poc03-bt-${bundler}-${anchor}-${i}`,
      env: anchor ? { POC03_ANCHOR: '1', POC03_ANCHOR_OUT: ANCHOR_OUT } : { POC03_ANCHOR: '0' },
    });
    starts.push(app.readyMs);
    const t0 = Date.now();
    const r = await fetch(`${BASE}/cards`);
    await r.text();
    firstPaints.push(Date.now() - t0);
    await app.stop();
    await sleep(300);
  }
  return { startupMedian: median(starts), firstCompileMedian: median(firstPaints), starts, firstPaints };
}

/* ------------------------------------------------------------------- 本体 */

const result = { poc: 'PoC-03', collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), byBundler: {} };

for (const bundler of ['turbopack', 'webpack']) {
  console.log(`\n=== ${bundler} ===`);
  const { facts, rows } = await observe(bundler);
  const { byId, files } = readManifest();

  const graded = [];
  for (const { target, pick, m2 } of rows) {
    const res = resolve(byId, pick);
    const g = grade(target, res);
    const m2g = target.expect
      ? (m2.status === 'resolved'
        ? (m2.file !== target.expect.file ? 'file-wrong'
          : m2.line === target.expect.line ? 'line-correct' : 'file-correct-line-wrong')
        : m2.status)
      : (m2.status === 'resolved' ? 'resolved-should-be-unidentifiable' : m2.status);
    graded.push({
      key: target.key, group: target.group, page: target.page, sel: target.sel, ord: target.ord,
      primary: !!target.primary, note: target.note ?? null,
      expect: target.expect,
      observed: {
        tag: pick.found ? pick.tag : null,
        anchorOnSelf: pick.anchorOnSelf ?? null,
        anchorOrdinal: pick.anchorOrdinal ?? null,
        anchorInstanceCount: pick.anchorInstanceCount ?? null,
        ancestorAnchors: (pick.ancestorAnchors ?? []).map((a) => a.id),
        textNodeIndex: pick.textNodeIndex ?? null,
        valueShape: pick.valueShape ?? null,
      },
      method1: res,
      method1Verdict: g,
      sourceLine: res.status === 'resolved' ? lineText(res.file, res.line) : null,
      method2: m2,
      method2Verdict: m2g,
      react: pick.react ?? null,
    });
  }

  const tally = (pred) => graded.filter(pred).length;
  const own = (r) => r.group !== 'library' && r.group !== 'no-jsx';
  result.byBundler[bundler] = {
    facts,
    manifest: {
      files: files.map((f) => ({ file: f.file, anchors: f.anchors.length, usages: f.usages.length, skipped: f.skipped })),
      anchorCount: byId.size,
    },
    summary: {
      targets: graded.length,
      own: {
        total: tally(own),
        correct: tally((r) => own(r) && r.method1Verdict.verdict === 'correct'),
        wrong: tally((r) => own(r) && r.method1Verdict.verdict === 'wrong'),
        unidentifiable: tally((r) => own(r) && r.method1Verdict.verdict === 'unidentifiable'),
      },
      nonOwn: {
        total: tally((r) => !own(r)),
        correctUnidentifiable: tally((r) => !own(r) && r.method1Verdict.verdict === 'correct-unidentifiable'),
        wrong: tally((r) => !own(r) && r.method1Verdict.verdict === 'wrong'),
      },
      method2: {
        lineCorrect: tally((r) => r.method2Verdict === 'line-correct'),
        fileCorrectLineWrong: tally((r) => r.method2Verdict === 'file-correct-line-wrong'),
        fileWrong: tally((r) => r.method2Verdict === 'file-wrong'),
        resolvedButShouldNot: tally((r) => r.method2Verdict === 'resolved-should-be-unidentifiable'),
        other: tally((r) => !['line-correct', 'file-correct-line-wrong', 'file-wrong',
          'resolved-should-be-unidentifiable'].includes(r.method2Verdict)),
      },
    },
    targets: graded,
  };
  const s = result.byBundler[bundler].summary;
  console.log(`own ${s.own.correct}/${s.own.total} correct, wrong=${s.own.wrong}, `
    + `unident=${s.own.unidentifiable} | non-own correct-unident=${s.nonOwn.correctUnidentifiable}, wrong=${s.nonOwn.wrong}`);
  console.log(`method2 line=${s.method2.lineCorrect} fileOnly=${s.method2.fileCorrectLineWrong}`
    + ` fileWrong=${s.method2.fileWrong} resolvedButShouldNot=${s.method2.resolvedButShouldNot}`
    + ` other=${s.method2.other}`);
}

console.log('\n=== build time ===');
result.buildTime = process.env.POC03_SKIP_BUILDTIME === '1'
  ? JSON.parse(fs.readFileSync(path.join(OUT, 'poc03.json'), 'utf8')).buildTime
  : {};
for (const bundler of (process.env.POC03_SKIP_BUILDTIME === '1' ? [] : ['turbopack', 'webpack'])) {
  const off = await buildTime(bundler, false);
  const on = await buildTime(bundler, true);
  result.buildTime[bundler] = { off, on,
    startupDeltaPct: +(((on.startupMedian - off.startupMedian) / off.startupMedian) * 100).toFixed(1),
    firstCompileDeltaPct: +(((on.firstCompileMedian - off.firstCompileMedian) / off.firstCompileMedian) * 100).toFixed(1) };
  console.log(bundler, JSON.stringify(result.buildTime[bundler].startupDeltaPct),
    JSON.stringify(result.buildTime[bundler].firstCompileDeltaPct));
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'poc03.json'), JSON.stringify(result, null, 2));
console.log(`\n→ ${path.join(OUT, 'poc03.json')}`);
console.log(`→ ${writeMatrixDoc(result)}`);
