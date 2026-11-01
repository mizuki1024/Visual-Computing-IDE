/* =============================================================================
 * Phase 7B-2 — 要素の選択とソースの特定を、部品の単位で確かめる。
 *   npm run build:lib && node tests/select-unit.spec.mjs
 *
 *   1. 知らせの検査（previewProtocol）— 型・版・nonce・知らないキー・値の範囲
 *   2. 識別子 → ソース位置（anchors）— 本物の変換器（poc/anchor/transform.cjs）で作った対応表を使い、
 *      対応表・ソース・DOM のどれかが食い違えば「特定できません」になること
 *   3. 右ドックへの変換（adapter.fromLiveSelection）— 既存の契約検査（validateDataset）を通ること
 *   4. 差し込むスクリプトの宛先（previewGateway.parentPatterns / agentJs）
 * 実ブラウザでの確認は tests/select-e2e.spec.mjs が行う。
 * ========================================================================== */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const P = require_('../.libjs/lib/previewProtocol.js');
const AN = require_('../.libjs/server/anchors.js');
const AD = require_('../.libjs/lib/adapter.js');
const M = require_('../.libjs/lib/model.js');
const L = require_('../.libjs/lib/layout.js');
const GW = require_('../.libjs/server/previewGateway.js');
const A = require_('../.libjs/server/access.js');
const { transform } = require_('../poc/anchor/transform.cjs');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);

/* ===================================================== 1. 知らせの検査 */
console.log('\n1. 知らせの検査（受け取る側はすべて検査する）');
const N = 'n'.repeat(22);
const SEL = {
  tag: 'span', anchorOnSelf: '9d8bc0d72e', anchorOrdinal: 1, anchorInstanceCount: 3,
  ancestorAnchors: ['2dbe4989ce'], textNodeIndex: 0, valueShape: { chars: 5, cls: 'cjk' }, formControl: false, path: '/cards',
};
const msg = (o) => ({ source: 'vcide-preview', v: 2, nonce: N, ...o });
ok('hello は中身を持たない形だけ受ける', P.isAgentHello({ source: 'vcide-preview', v: 2, kind: 'hello' }));
ok('hello に余計なキーがあれば受けない', !P.isAgentHello({ source: 'vcide-preview', v: 2, kind: 'hello', path: '/' }));
ok('版の違う hello は受けない', !P.isAgentHello({ source: 'vcide-preview', v: 1, kind: 'hello' }));
ok('正しい選択は受ける', P.parseAgentMessage(msg({ kind: 'select', seq: 1, selection: SEL }), N)?.kind === 'select');
eq('nonce が違えば捨てる', P.parseAgentMessage(msg({ kind: 'select', seq: 1, selection: SEL }), 'm'.repeat(22)), null);
eq('版が違えば捨てる', P.parseAgentMessage({ ...msg({ kind: 'connected' }), v: 1 }, N), null);
eq('知らない種別は捨てる', P.parseAgentMessage(msg({ kind: 'eval', code: 'x' }), N), null);
eq('知らないキー（本文など）があれば捨てる', P.parseAgentMessage(msg({ kind: 'select', seq: 1, selection: { ...SEL, html: '<b>x</b>' } }), N), null);
eq('選択にソース位置を書いてきても捨てる', P.parseAgentMessage(msg({ kind: 'select', seq: 1, selection: { ...SEL, file: 'src/a.tsx' } }), N), null);
eq('識別子の形でないものは捨てる', P.parseSelection({ ...SEL, anchorOnSelf: '../../etc' }), null);
eq('祖先の識別子の形も検査する', P.parseSelection({ ...SEL, ancestorAnchors: ['<script>'] }), null);
eq('何番目かが数を超えれば捨てる', P.parseSelection({ ...SEL, anchorOrdinal: 3 }), null);
eq('識別子が無いのに何番目かがあれば捨てる', P.parseSelection({ ...SEL, anchorOnSelf: null, anchorOrdinal: 0 }), null);
eq('フォームの部品に値の形があれば捨てる（値を数えない約束）', P.parseSelection({ ...SEL, formControl: true }), null);
eq('テキストノードが無いのに値の形があれば捨てる', P.parseSelection({ ...SEL, textNodeIndex: null }), null);
eq('文字種は決めたものだけ', P.parseSelection({ ...SEL, valueShape: { chars: 5, cls: 'アオバ台' } }), null);
eq('パスは / で始まるものだけ（別の origin の URL を受けない）', P.parseSelection({ ...SEL, path: 'https://evil.example/' }), null);
eq('// で始まるパスも受けない', P.parseSelection({ ...SEL, path: '//evil.example/' }), null);
eq('祖先が多すぎれば捨てる', P.parseSelection({ ...SEL, ancestorAnchors: Array(33).fill('2dbe4989ce') }), null);
eq('配列を選択として受けない', P.parseSelection([SEL]), null);
eq('場所の知らせの状態は HTTP の範囲だけ', P.parseAgentMessage(msg({ kind: 'ready', path: '/', title: '', status: 999, soft: false, from: 'app' }), N), null);
ok('場所の知らせ（正しい形）は受ける', P.parseAgentMessage(msg({ kind: 'ready', path: '/a?b#c', title: 't', status: 200, soft: false, from: 'app' }), N)?.path === '/a?b#c');
ok('起動の鍵は形を検査する', P.parseRunKey({ instance: 'x', pid: 1, startedAt: 't' }) && !P.parseRunKey({ instance: 'x', pid: -1, startedAt: 't' }) && !P.parseRunKey({ instance: 'x', pid: 1, startedAt: 't', extra: 1 }));

/* ===================================================== 2. 識別子 → ソース位置 */
console.log('\n2. 識別子 → ソース位置（照合の6段）');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-7b2-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-7b2-out-'));
const root = path.join(tmp, 'app');
fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
const BADGE = `export default function Badge({ v }: { v: string }) {
  return (
    <span className="badge">
      <b className="t">{v}</b>
    </span>
  );
}
`;
const PAGE = `'use client';
import Badge from './components/Badge';
export default function Page() {
  return <main className="p"><h1>Title</h1><Badge v="x" /></main>;
}
`;
fs.writeFileSync(path.join(root, 'src', 'components', 'Badge.tsx'), BADGE);
fs.writeFileSync(path.join(root, 'src', 'page.tsx'), PAGE);
fs.writeFileSync(path.join(root, 'next.config.mjs'), "const A = process.env.POC03_ANCHOR === '1'; export default {};\n");
const outDir = AN.anchorOutDir(root);
fs.mkdirSync(outDir, { recursive: true });
const writeManifest = (name, file, anchors) => fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ file, anchors }));
const tB = transform(BADGE, 'src/components/Badge.tsx');
const tP = transform(PAGE, 'src/page.tsx');
writeManifest('a'.repeat(16), 'src/components/Badge.tsx', tB.anchors);
writeManifest('b'.repeat(16), 'src/page.tsx', tP.anchors);
const idOf = (t, tag) => t.anchors.find((a) => a.tag === tag).id;
const bId = idOf(tB, 'b');
const spanId = idOf(tB, 'span');
const mainId = idOf(tP, 'main');
const h1Id = idOf(tP, 'h1');

const support = AN.anchorSupport(root);
eq('next.config がローダを読む設定なら「使える」', support.state, 'enabled');
const env = AN.anchorEnv(root, support);
ok('起動先に足すのはローダの有効化と対応表の置き場所（IDE 側）だけ', env.POC03_ANCHOR === '1' && env.POC03_ANCHOR_OUT === outDir && Object.keys(env).length === 2, env);
ok('対応表の置き場所は IDE の .ide-runtime の中（対象プロジェクトの外）', outDir.includes(`${path.sep}.ide-runtime${path.sep}anchors${path.sep}`) && !outDir.startsWith(root));
{
  const r2 = path.join(tmp, 'noanchor');
  fs.mkdirSync(r2);
  fs.writeFileSync(path.join(r2, 'next.config.mjs'), 'export default {};\n');
  const s2 = AN.anchorSupport(r2);
  eq('設定が無いプロジェクトは「使えない」（IDE は設定を書き換えない）', s2.state, 'unavailable');
  ok('理由を言う', /書き換えない/.test(s2.reason), s2.reason);
  eq('使えないときは起動先に何も足さない', Object.keys(AN.anchorEnv(r2, s2)).length, 0);
  const r = AN.resolveSelection(r2, s2, { ...SEL, anchorOnSelf: bId, tag: 'b' });
  eq('使えないプロジェクトでの選択は「注入していません」', r.reason, 'injection-unavailable');
}
const S = (o) => ({ tag: 'b', anchorOnSelf: bId, anchorOrdinal: 0, anchorInstanceCount: 1, ancestorAnchors: [spanId, mainId], textNodeIndex: 0, valueShape: { chars: 1, cls: 'latin' }, formControl: false, path: '/', ...o });

const r = AN.resolveSelection(root, support, S({}));
eq('要素自身の識別子 → 位置が特定できる', r.status, 'resolved');
eq('正しいファイル・行・列（変換器と同じ位置）', `${r.anchor.file}:${r.anchor.line}:${r.anchor.col}`, 'src/components/Badge.tsx:4:7');
eq('正しいコンポーネント', r.anchor.component, 'Badge');
eq('ソースから読んだ1行（DOM からではない）', r.anchor.sourceLine, '<b className="t">{v}</b>');
eq("'use client' が無いファイル", r.directive, 'none');
eq('包含関係は照合できた祖先から作る（文脈）', r.chain.join(' ← '), 'Badge ← Page');
eq('照合した根拠を6つ返す', r.checks.length, 6);
eq("'use client' のあるファイル", AN.resolveSelection(root, support, S({ tag: 'h1', anchorOnSelf: h1Id, ancestorAnchors: [mainId] })).directive, 'use-client');

const miss = AN.resolveSelection(root, support, S({ anchorOnSelf: null, anchorOrdinal: null, anchorInstanceCount: 0 }));
eq('識別子の無い要素は「特定できません」', miss.reason, 'anchor-missing');
ok('祖先に識別子があっても出所にしない（位置を返さない）', miss.status === 'unresolved' && !('anchor' in miss));
eq('祖先は文脈として返す', miss.context?.component, 'Badge');
eq('対応表に無い識別子', AN.resolveSelection(root, support, S({ anchorOnSelf: 'ffffffffff' })).reason, 'anchor-not-in-manifest');
eq('DOM のタグと対応表のタグが違えば止める', AN.resolveSelection(root, support, S({ tag: 'span' })).reason, 'tag-mismatch');

/* 対応表が書き換えられた場合 */
writeManifest('c'.repeat(16), 'x', [{ ...tB.anchors.find((a) => a.tag === 'b'), id: '1111111111', line: 3 }]);
eq('識別子を位置から計算し直して一致しなければ止める', AN.resolveSelection(root, support, S({ anchorOnSelf: '1111111111' })).reason, 'id-mismatch');
const escId = AN.anchorIdOf('src/../../escape.tsx', 1, 1);
writeManifest('d'.repeat(16), 'x', [{ id: escId, tag: 'b', file: 'src/../../escape.tsx', line: 1, col: 1, component: 'X', componentLine: 1 }]);
eq('注入範囲の外を指す対応表（..）は止める', AN.resolveSelection(root, support, S({ anchorOnSelf: escId })).reason, 'outside-scope');
const libId = AN.anchorIdOf('lib/a.tsx', 1, 1);
writeManifest('e'.repeat(16), 'x', [{ id: libId, tag: 'b', file: 'lib/a.tsx', line: 1, col: 1, component: 'X', componentLine: 1 }]);
eq('src/ の外のファイルを指す対応表は止める', AN.resolveSelection(root, support, S({ anchorOnSelf: libId })).reason, 'outside-scope');
fs.writeFileSync(path.join(outside, 'Evil.tsx'), 'export default function Evil() { return <b>x</b>; }\n');
fs.symlinkSync(path.join(outside, 'Evil.tsx'), path.join(root, 'src', 'Evil.tsx'));
const evil = transform(fs.readFileSync(path.join(outside, 'Evil.tsx'), 'utf8'), 'src/Evil.tsx').anchors[0];
writeManifest('f'.repeat(16), 'src/Evil.tsx', [evil]);
eq('シンボリックリンクでプロジェクトの外へ出るファイルは止める', AN.resolveSelection(root, support, S({ anchorOnSelf: evil.id, ancestorAnchors: [] })).reason, 'outside-scope');
eq('壊れた対応表の記述は読まない（形の検査）', AN.readManifest(outDir).has('1111111111') && !AN.readManifest(outDir).has('zz'), true);

/* ソースが変わった（対応表は古いまま） */
fs.writeFileSync(path.join(root, 'src', 'components', 'Badge.tsx'), `// 1行足した\n${BADGE}`);
const moved = AN.resolveSelection(root, support, S({}));
eq('ソースが変わって位置に JSX が無ければ止める（古い対応表を信じない）', moved.reason, 'source-mismatch');
fs.writeFileSync(path.join(root, 'src', 'components', 'Badge.tsx'), BADGE.replace('<b className="t">', '<i className="t">').replace('</b>', '</i>'));
eq('同じ位置の要素のタグが変わっていれば止める', AN.resolveSelection(root, support, S({})).reason, 'source-mismatch');
fs.writeFileSync(path.join(root, 'src', 'components', 'Badge.tsx'), BADGE.replace('function Badge', 'function Chip'));
eq('囲むコンポーネントが変わっていれば止める', AN.resolveSelection(root, support, S({})).reason, 'source-mismatch');
fs.writeFileSync(path.join(root, 'src', 'components', 'Badge.tsx'), BADGE);
eq('元に戻せば再び特定できる', AN.resolveSelection(root, support, S({})).status, 'resolved');
{
  const r3 = AN.resolveSelection(root, support, S({ ancestorAnchors: ['ffffffffff', spanId] }));
  eq('照合できない祖先は包含関係に入れない', r3.chain.join(' ← '), 'Badge');
}

/* ===================================================== 3. 右ドックへの変換 */
console.log('\n3. 右ドックへの変換（PoC-03 と同じ部品・同じ契約検査）');
const input = (resolution, sel = S({})) => ({ project: 'app', port: 3000, page: { path: '/', title: '' }, selection: sel, resolution, selectedAt: '2026-11-01T00:00:00Z' });
{
  const res = AN.resolveSelection(root, support, S({ anchorOrdinal: 1, anchorInstanceCount: 2 }));
  const { dataset } = AD.fromLiveSelection(input(res, S({ anchorOrdinal: 1, anchorInstanceCount: 2 })));
  eq('特定できた: ① 値 と ② コンポーネント', dataset.nodes.map((n) => n.kind).join(','), 'value,component');
  eq('特定できた: renders の関係1本', dataset.hops.map((h) => h.relation).join(','), 'renders');
  eq('既存の契約検査（validateDataset）を通る', JSON.stringify(M.validateDataset(dataset)), '[]');
  ok('実測（element-anchor / dom-read）として出す', dataset.nodes.every((n) => n.observability === 'measured'));
  const comp = dataset.nodes.find((n) => n.kind === 'component');
  const rows = Object.fromEntries(comp.overview.map((x) => [x.k, x.v]));
  eq('行・列の位置を出す（省略されても読めるよう行・列を先に）', rows['位置（行・列）'], '4 行 7 列 — src/components/Badge.tsx:4:7');
  ok('特定方法を出す', /対応表/.test(rows['特定方法']));
  ok('照合の根拠を出す', /読み直し/.test(rows['照合']));
  ok('複数インスタンスは区別しないと書く', /観測していません/.test(rows['この JSX が生んだ要素']), rows['この JSX が生んだ要素']);
  ok('値の由来までは主張しない', /観測していません/.test(rows['主張の範囲']));
  ok("'use client' の有無とその限界を書く", /このファイルだけでは決まりません/.test(rows['ファイルの指定']));
  ok('切断「ここから先は観測していません（props の由来）」', dataset.cuts.some((c) => c.from === comp.id && /props/.test(c.sub)));
  ok('通信・SQL・テーブルを作らない', !dataset.nodes.some((n) => ['http', 'server', 'sql', 'table', 'column'].includes(n.kind)));
  ok('derives を作らない', !dataset.hops.some((h) => h.relation === 'derives'));
  const laid = L.layout(dataset);
  ok('既存の座標付け（layout）を通る', laid.nodes.length === 2 && laid.hops[0].d.startsWith('M '));
}
{
  const res = AN.resolveSelection(root, support, S({ anchorOnSelf: null, anchorOrdinal: null, anchorInstanceCount: 0 }));
  const { dataset, skipped } = AD.fromLiveSelection(input(res, S({ anchorOnSelf: null, anchorOrdinal: null, anchorInstanceCount: 0 })));
  eq('特定できない: 選んだ要素だけ（コンポーネントを作らない）', dataset.nodes.map((n) => n.kind).join(','), 'value');
  eq('特定できない: 関係を作らない', dataset.hops.length, 0);
  ok('特定できない: 理由を概要に書く', dataset.nodes[0].overview.some((x) => x.k === '特定できなかった理由' && /要素識別子がありません/.test(x.v)));
  ok('特定できない: 祖先は文脈と明記', dataset.nodes[0].overview.some((x) => x.k === '祖先の文脈' && /出所ではありません/.test(x.v)));
  ok('特定できない: 切断を置く', dataset.cuts.length === 1 && /特定できません/.test(dataset.cuts[0].head));
  ok('特定できない: 作らなかったことを skipped に残す', skipped.length === 1);
  eq('特定できない: 契約検査を通る', JSON.stringify(M.validateDataset(dataset)), '[]');
}
{
  const { dataset } = AD.fromLiveSelection(input({ status: 'unresolved', reason: 'anchor-missing', detail: '', context: null }, S({ tag: 'input', anchorOnSelf: null, anchorOrdinal: null, anchorInstanceCount: 0, textNodeIndex: null, valueShape: null, formControl: true })));
  ok('フォームの部品は「値の形は収集していません」', dataset.nodes[0].overview.some((x) => x.k === '値の形' && /収集していません/.test(x.v)));
}
ok('件数が 0 と出る理由（通信を観測していない）を書く', /通信が無かったという意味ではありません/.test(AD.fromLiveSelection(input({ status: 'unresolved', reason: 'anchor-missing', detail: '', context: null })).dataset.overviewNote));

/* ===================================================== 4. 差し込むスクリプト */
console.log('\n4. 差し込むスクリプトの宛先');
{
  const cfg = A.accessConfig({ VCIDE_ALLOWED_HOSTS: 'ide.example.test', VCIDE_PREVIEW_ORIGIN: 'http://pv.example.test' });
  const pats = GW.parentPatterns(cfg);
  ok('親として受け入れるのは IDE の画面の origin だけ（frame-ancestors と同じ範囲）',
    JSON.stringify(pats) === JSON.stringify([
      { s: 'http:', h: '127.0.0.1', p: '*' }, { s: 'http:', h: 'localhost', p: '*' },
      { s: 'https:', h: 'ide.example.test', p: '' }, { s: 'http:', h: 'ide.example.test', p: '' },
    ]), pats);
  const js = GW.agentJs(cfg);
  ok('宛先の origin を埋め込む', js.includes('"ide.example.test"'));
  ok("'*' 宛てに送るのは中身の無い hello だけ（ancestorOrigins が使えない場合）",
    (js.match(/postMessage\(/g) ?? []).length === 2 && /P\.postMessage\(\{ source: 'vcide-preview', v: 2, kind: 'hello' \}, target\)/.test(js));
  ok('以後は MessagePort で送る', /port\.postMessage\(m\)/.test(js));
  ok('本物のクリックだけで選ぶ（isTrusted）', js.includes('e.isTrusted'));
  ok('接続の知らせをアプリのリスナーに渡さない（stopImmediatePropagation）', js.includes('stopImmediatePropagation'));
  ok('送り主が親の window で、許した origin のときだけ接続する', js.includes('e.source !== P') && js.includes('allowed(e.origin)'));
  ok('本文・属性・Cookie を読まない', !/innerHTML|outerHTML|textContent|innerText|cookie|localStorage|\.value\b|attributes/.test(js));
  ok('構文として正しい JavaScript', (() => { try { new Function(js); return true; } catch { return false; } })());
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
fs.rmSync(outDir, { recursive: true, force: true });

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
