/* =============================================================================
 * PoC-03 方式1 の入口 — webpack / Turbopack 共用のローダ。
 *
 * webpack と Turbopack の両方が「webpack ローダ API」を受け付けるため、
 * **同じ 1 ファイルで両バンドラを賄えるか**が本 PoC の検証点（UR-01 / C-2）。
 *
 * 注入対象は **ユーザーのソースディレクトリに限定する**（01b Q-03 C-3）。
 * node_modules とプロジェクト外のファイルには一切触らない。
 * ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { transform, TS_LOAD_MS } = require('./transform.cjs');

/*
 * 変換コストの内訳を測るための記録（PoC-05 第7節）。
 * `POC03_ANCHOR_COST` が立っているときだけ書く。既定では何もしない。
 * ローダは並列・別プロセスで走るので、プロセスごとの内訳が要る。
 */
const COST = process.env.POC03_ANCHOR_COST || '';
let costFirst = true;
function cost(rec) {
  if (!COST) return;
  try {
    fs.appendFileSync(COST, `${JSON.stringify({ pid: process.pid, ...rec })}\n`);
  } catch { /* 計測が本体を壊さない */ }
}

/** ローダは並列・別プロセスで走る。1ファイル1出力にして競合を避ける。 */
function writeManifest(outDir, relPath, payload) {
  fs.mkdirSync(outDir, { recursive: true });
  const key = crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
  const file = path.join(outDir, `${key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
}

module.exports = function vcideAnchorLoader(source) {
  const opts = (this.getOptions && this.getOptions()) || {};
  const root = opts.root;
  const outDir = opts.outDir;
  const scope = opts.scope || 'src';
  const resourcePath = this.resourcePath || '';

  const rel = path.relative(root, resourcePath).split(path.sep).join('/');
  // 注入範囲の外は素通し。ライブラリ由来の要素は「注入していない」が正しい状態
  if (rel.startsWith('..') || rel.includes('node_modules/') || !rel.startsWith(`${scope}/`)) {
    return source;
  }
  if (!/<[A-Za-z>]/.test(source)) return source;   // JSX が無いファイルは触らない

  if (costFirst) {
    costFirst = false;
    // そのワーカーで構文解析器を読み込むのに掛かった時間（1回限りのコスト）
    cost({ event: 'worker-start', tsLoadMs: TS_LOAD_MS });
  }

  let r;
  const t0 = process.hrtime.bigint();
  try {
    r = transform(source, rel);
    cost({ event: 'transform', file: rel, bytes: source.length,
      ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  } catch (e) {
    // 変換の失敗を黙って成功に見せない。注入せずに理由を残す
    writeManifest(outDir, rel, {
      file: rel, anchors: [], usages: [],
      skipped: [{ file: rel, why: 'transform-error', detail: String(e && e.message) }],
    });
    return source;
  }
  /* rev: 変換したソースの版（DOM の data-vcide-rev と同じ値）。対応表の位置はこの版のソースについてのもの */
  writeManifest(outDir, rel, {
    file: rel, rev: r.rev, anchors: r.anchors, usages: r.usages, skipped: r.skipped,
    components: r.components,
  });
  return r.code;
};
