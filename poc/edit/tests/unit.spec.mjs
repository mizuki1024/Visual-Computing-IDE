/* 編集 PoC — 書き込みの中核の単体テスト。
 * 題材そのもの（poc/fixture-edit）は書き換えない。毎回 poc/out/edit-unit/ に使い捨てのコピーを作る。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');
const FIXTURE = path.join(REPO, 'poc/fixture-edit');
const E = require('../engine.cjs');
const TW = require('../tailwind.cjs');

const OUT = path.join(REPO, 'poc/out/edit-unit');
const results = [];
let failed = 0;
async function test(id, name, fn) {
  try { await fn(); results.push({ id, name, ok: true }); console.log(`  ok  ${id} ${name}`); } catch (e) {
    failed += 1; results.push({ id, name, ok: false, error: String(e.stack || e) }); console.log(`  NG  ${id} ${name}\n${e.stack}`);
  }
}

/** 題材の src を使い捨ての場所へ写す */
function sandbox() {
  const dir = path.join(OUT, `sb-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.cpSync(path.join(FIXTURE, 'src'), path.join(dir, 'src'), { recursive: true });
  return dir;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const CARD = 'src/components/PropertyCard.tsx';
/** PropertyCard の外枠（anchors の照合が返す位置。e2e では照合 API の値を使う） */
const CARD_DIV = { line: 7, col: 5, tag: 'div', component: 'PropertyCard' };

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log('edit-poc unit');

await test('U01', '外枠の className の p-4 を位置で特定し、md:p-6 を上書きとして返す', () => {
  const src = read(FIXTURE, CARD);
  const loc = E.locateClassToken(src, CARD, CARD_DIV, 'p-4', 'p-5');
  assert.equal(loc.ok, true, JSON.stringify(loc));
  assert.equal(src.slice(loc.start, loc.end), 'p-4');
  assert.deepEqual(loc.overrides, ['md:p-6']);
  assert.equal(loc.tokenLine, 7);
});

await test('U02', '差し替えは token 1つだけ。md:p-6・他のクラス・コメント・他の行は1文字も変わらない', () => {
  const src = read(FIXTURE, CARD);
  const loc = E.locateClassToken(src, CARD, CARD_DIV, 'p-4', 'p-5');
  const next = E.patchToken(src, loc, 'p-4', 'p-5');
  const d = E.unifiedDiff(CARD, src, next);
  assert.equal(d.changedLines, 1);
  assert.match(d.text, /^-    <div className="rounded-lg border bg-white p-4 md:p-6 shadow-sm">$/m);
  assert.match(d.text, /^\+    <div className="rounded-lg border bg-white p-5 md:p-6 shadow-sm">$/m);
  assert.equal(next.replace('p-5 md:p-6', 'p-4 md:p-6'), src);
  assert.ok(next.includes('/* 共有部品。'));
  assert.equal(next.length, src.length);
});

await test('U03', '同じファイルに同じクラス文字列の要素が2つあっても、選んだ位置の1つだけを変える', () => {
  const src = [
    'export function Two() {',
    '  return (',
    '    <section>',
    '      <div className="rounded-lg border bg-white p-4 md:p-6 shadow-sm">a</div>',
    '      <div className="rounded-lg border bg-white p-4 md:p-6 shadow-sm">b</div>',
    '    </section>',
    '  );',
    '}',
  ].join('\n');
  const loc = E.locateClassToken(src, 'src/x.tsx', { line: 5, col: 7, tag: 'div', component: 'Two' }, 'p-4', 'p-5');
  assert.equal(loc.ok, true);
  const next = E.patchToken(src, loc, 'p-4', 'p-5');
  const lines = next.split('\n');
  assert.ok(lines[3].includes('p-4 md:p-6'), '1つ目は変わらない');
  assert.ok(lines[4].includes('p-5 md:p-6'), '2つ目だけ変わる');
});

await test('U04', '条件付きクラス（テンプレート内の三項演算子）は推測で書き換えず conditional-class で拒否', () => {
  const rel = 'src/components/FilterPanel.tsx';
  const src = read(FIXTURE, rel);
  const r = E.locateClassToken(src, rel, { line: 4, col: 5, tag: 'div', component: 'FilterPanel' }, 'p-4', 'p-5');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conditional-class');
  assert.ok(r.detail.length > 0);
});

await test('U05', 'clsx などの呼び出し・変数は computed-class、重なる指定・複数・無しも拒否', () => {
  const mk = (cls) => `export function C() {\n  return <div className=${cls}>x</div>;\n}\n`;
  const t = { line: 2, col: 10, tag: 'div', component: 'C' };
  assert.equal(E.locateClassToken(mk('{clsx("p-4", "border")}'), 'src/c.tsx', t, 'p-4', 'p-5').reason, 'computed-class');
  assert.equal(E.locateClassToken(mk('{cls}'), 'src/c.tsx', t, 'p-4', 'p-5').reason, 'computed-class');
  assert.equal(E.locateClassToken(mk('{on ? "p-4" : "p-2"}'), 'src/c.tsx', t, 'p-4', 'p-5').reason, 'conditional-class');
  assert.equal(E.locateClassToken(mk('"p-4 border p-4"'), 'src/c.tsx', t, 'p-4', 'p-5').reason, 'token-ambiguous');
  assert.equal(E.locateClassToken(mk('"p-4 px-2"'), 'src/c.tsx', t, 'p-4', 'p-5').reason, 'overlapping-utility');
  assert.equal(E.locateClassToken(mk('"p-2 border"'), 'src/c.tsx', t, 'p-4', 'p-5').reason, 'token-not-found');
  assert.equal(E.locateClassToken(mk('"p-4 p-5"'), 'src/c.tsx', t, 'p-4', 'p-5').reason, 'token-already-present');
  assert.equal(E.locateClassToken(mk('"p-4"'), 'src/c.tsx', t, 'p-4', 'm-5').reason, 'unsupported-token');
  assert.equal(E.locateClassToken('export function C() {\n  return <div {...p} className="p-4" {...q}>x</div>;\n}\n', 'src/c.tsx', t, 'p-4', 'p-5').reason, 'spread-after-classname');
});

await test('U06', '古い位置（上に1行入って行がずれた）では source-mismatch で書き込み先を決めない', () => {
  const src = read(FIXTURE, CARD).replace('export function PropertyCard', '// 外部の編集で1行増えた\nexport function PropertyCard');
  const r = E.locateClassToken(src, CARD, CARD_DIV, 'p-4', 'p-5');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'source-mismatch');
});

await test('U07', '変更案の作成後に外部変更があれば適用しない（ファイルは外部変更のまま）', () => {
  const root = sandbox();
  const src = read(root, CARD);
  const loc = E.locateClassToken(src, CARD, CARD_DIV, 'p-4', 'p-5');
  const baseHash = E.sha256(src);
  const ext = src.replace('竣工 ', '竣工: ');
  fs.writeFileSync(path.join(root, CARD), ext);
  const r = E.applyOne({ root, rel: CARD, baseHash, start: loc.start, end: loc.end, from: 'p-4', to: 'p-5' });
  assert.equal(r.status, 'conflict');
  assert.equal(r.written, false);
  assert.equal(read(root, CARD), ext);
});

await test('U08', '適用 → 読み直しで確認 → 取り消し → 元の内容に戻る（バイト一致）', () => {
  const root = sandbox();
  const src = read(root, CARD);
  const loc = E.locateClassToken(src, CARD, CARD_DIV, 'p-4', 'p-5');
  const a = E.applyOne({ root, rel: CARD, baseHash: E.sha256(src), start: loc.start, end: loc.end, from: 'p-4', to: 'p-5' });
  assert.equal(a.status, 'applied');
  assert.equal(a.readBackHash, a.afterHash);
  assert.ok(read(root, CARD).includes('p-5 md:p-6'));
  assert.equal(fs.readdirSync(path.join(root, 'src/components')).filter((n) => n.endsWith('.tmp')).length, 0, '一時ファイルを残さない');
  const r = E.revertOne(a, root);
  assert.equal(r.status, 'reverted');
  assert.equal(read(root, CARD), src);
  assert.equal(E.revertOne(a, root).status, 'already-at-before');
});

await test('U09', '適用後に外部変更が入ったら、取り消しは拒否し古い内容で上書きしない', () => {
  const root = sandbox();
  const src = read(root, CARD);
  const loc = E.locateClassToken(src, CARD, CARD_DIV, 'p-4', 'p-5');
  const a = E.applyOne({ root, rel: CARD, baseHash: E.sha256(src), start: loc.start, end: loc.end, from: 'p-4', to: 'p-5' });
  const ext = read(root, CARD).replace('text-sm', 'text-base');
  fs.writeFileSync(path.join(root, CARD), ext);
  const r = E.revertOne(a, root);
  assert.equal(r.status, 'refused-changed-after-apply');
  assert.equal(r.written, false);
  assert.equal(read(root, CARD), ext, '外部変更が残っている');
  assert.match(r.diffSinceApply, /text-base/);
});

await test('U10', '変更案の Undo / Redo はファイルを変えない', () => {
  const root = sandbox();
  const before = E.sha256(read(root, CARD));
  const d = new E.Draft({ id: 'd1', rel: CARD, anchor: {}, from: 'p-4', baseHash: before });
  d.set('p-5'); d.set('p-6');
  assert.equal(d.undo(), 'p-5'); assert.equal(d.undo(), 'p-4'); assert.equal(d.isNoop, true);
  assert.equal(d.redo(), 'p-5'); d.set('p-3'); assert.equal(d.canRedo, false);
  assert.equal(E.sha256(read(root, CARD)), before);
});

await test('U11', '版は内容ハッシュで決まる（未コミットの変更でも版が変わり、戻せば同じ版）', () => {
  const root = sandbox();
  const r0 = E.revisionOf(root);
  fs.appendFileSync(path.join(root, CARD), '\n');
  const r1 = E.revisionOf(root);
  assert.notEqual(r0.id, r1.id);
  fs.writeFileSync(path.join(root, CARD), read(FIXTURE, CARD));
  assert.equal(E.revisionOf(root).id, r0.id);
});

/* ---------------- 複数ファイル（EP-06） */
const MULTI = ['src/components/PropertyCard.tsx', 'src/components/SiteNotice.tsx', 'src/components/PropertyList.tsx'];
function txChanges(root) {
  return MULTI.map((rel) => {
    const s = read(root, rel);
    return { rel, baseHash: E.sha256(s), next: `${s}// tx\n` };
  });
}
const snapshot = (root) => MULTI.map((rel) => read(root, rel));

await test('U12', '複数ファイル: 全部書けたら committed（読み直して全ファイル変更後）', () => {
  const root = sandbox();
  const r = E.applyTransaction({ root, changes: txChanges(root), journalDir: path.join(root, '.journal') });
  assert.equal(r.outcome, 'committed');
  assert.ok(r.files.every((f) => f.content === 'at-after'));
});

await test('U13', '複数ファイル: 2件目で失敗 → 1件目を書き戻す。「何も書き込んでいません」と言わない', () => {
  const root = sandbox();
  const s0 = snapshot(root);
  const r = E.applyTransaction({ root, changes: txChanges(root), journalDir: path.join(root, '.journal'), faults: { failWriteAt: 1 } });
  assert.equal(r.outcome, 'failed-rolled-back');
  assert.deepEqual(r.files.map((f) => f.state), ['rolled-back', 'not-written', 'not-written']);
  assert.ok(!r.message.includes('何も書き込んでいません') && !r.message.includes('どのファイルにも書き込んでいません'));
  assert.match(r.message, /書き込んだ 1 件は元の内容に戻しました/);
  assert.deepEqual(snapshot(root), s0);
});

await test('U14', '複数ファイル: 1件目で失敗 → 書いていないことを読み直して確かめたときだけ「どのファイルにも書き込んでいません」', () => {
  const root = sandbox();
  const r = E.applyTransaction({ root, changes: txChanges(root), journalDir: path.join(root, '.journal'), faults: { failWriteAt: 0 } });
  assert.equal(r.outcome, 'failed-nothing-written');
  assert.match(r.message, /どのファイルにも書き込んでいません/);
});

await test('U15', '複数ファイル: 書き戻しにも失敗 → partial。残ったファイルと状態を特定できる', () => {
  const root = sandbox();
  const r = E.applyTransaction({ root, changes: txChanges(root), journalDir: path.join(root, '.journal'), faults: { failWriteAt: 2, failRollbackAt: 0 } });
  assert.equal(r.outcome, 'failed-partial');
  assert.deepEqual(r.files.map((f) => [f.state, f.content]), [['rollback-failed', 'at-after'], ['rolled-back', 'at-before'], ['not-written', 'at-before']]);
  assert.match(r.message, /元に戻せていないファイルがあります: src\/components\/PropertyCard.tsx（書き戻せなかった・変更後の内容）/);
  const j = JSON.parse(fs.readFileSync(r.journalFile, 'utf8'));
  assert.equal(j.state, 'partial');
});

await test('U16', '複数ファイル: 書いた後に外部変更が入ったファイルは書き戻さない（外部変更を保持）', () => {
  const root = sandbox();
  const r = E.applyTransaction({ root, changes: txChanges(root), journalDir: path.join(root, '.journal'),
    faults: { failWriteAt: 2, externalEditBeforeRollback: { index: 1, content: 'external\n' } } });
  assert.equal(r.outcome, 'failed-partial');
  assert.deepEqual(r.files.map((f) => [f.state, f.content]), [['rolled-back', 'at-before'], ['rollback-refused', 'other'], ['not-written', 'at-before']]);
  assert.equal(read(root, MULTI[1]), 'external\n');
});

await test('U17', '複数ファイル: 書く前の照合で1件でも違えば1件も書かない', () => {
  const root = sandbox();
  const ch = txChanges(root);
  fs.appendFileSync(path.join(root, MULTI[2]), '// ext\n');
  const s0 = snapshot(root);
  const r = E.applyTransaction({ root, changes: ch, journalDir: path.join(root, '.journal') });
  assert.equal(r.outcome, 'conflict-nothing-written');
  assert.deepEqual(r.mismatch, [MULTI[2]]);
  assert.deepEqual(snapshot(root), s0);
});

await test('U18', '複数ファイル: 1件書いた直後にプロセスが落ちても、ジャーナルから状態を特定して戻せる', () => {
  const root = sandbox();
  const s0 = snapshot(root);
  const jdir = path.join(root, '.journal');
  const child = `
    const E = require(${JSON.stringify(path.join(here, '../engine.cjs'))});
    const fs = require('fs'), path = require('path');
    const root = ${JSON.stringify(root)};
    const changes = ${JSON.stringify(MULTI)}.map((rel) => { const s = fs.readFileSync(path.join(root, rel), 'utf8'); return { rel, baseHash: E.sha256(s), next: s + '// tx\\n' }; });
    E.applyTransaction({ root, changes, journalDir: ${JSON.stringify(jdir)}, faults: { crashAfterWrite: 0 } });`;
  const p = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8' });
  assert.equal(p.status, 70, p.stderr);
  const jf = path.join(jdir, fs.readdirSync(jdir).find((n) => n.endsWith('.json')));
  const ins = E.inspectJournal(jf);
  assert.equal(ins.state, 'applying');
  assert.deepEqual(ins.files.map((f) => f.content), ['at-after', 'at-before', 'at-before']);
  const rec = E.recoverJournal(jf);
  assert.equal(rec.state, 'recovered');
  assert.deepEqual(snapshot(root), s0);
});

await test('U19', '観測の鮮度: 版が違えば古い。同じ版でも観測の後に書き込んでいれば古い', () => {
  const obs = { revision: 'aaaaaaaaaaaa', at: 100 };
  assert.equal(E.observationFreshness(obs, 'aaaaaaaaaaaa', []).state, 'current');
  assert.equal(E.observationFreshness(obs, 'bbbbbbbbbbbb', []).state, 'stale');
  assert.equal(E.observationFreshness(obs, 'aaaaaaaaaaaa', [{ at: 200 }]).state, 'stale');
  assert.equal(E.observationFreshness(null, 'aaaaaaaaaaaa', []).state, 'unknown');
});

await test('U20', '注入範囲の外・.. ・外を指すシンボリックリンクには書かない', () => {
  const root = sandbox();
  assert.equal(E.safePath(root, '../x.tsx'), null);
  assert.equal(E.safePath(root, '/etc/passwd'), null);
  assert.equal(E.safePath(root, 'next.config.mjs'), null);
  fs.symlinkSync('/etc/hostname', path.join(root, 'src/link.tsx'));
  assert.equal(E.safePath(root, 'src/link.tsx'), null);
});

await test('U21', 'Tailwind の実設定から md=768px・spacing=4px を読む。予測 CSS は基本→md の順', async () => {
  const th = await TW.readTheme(FIXTURE);
  assert.equal(th.breakpoints.md.px, 768);
  assert.equal(th.spacing.px, 4);
  const p = await TW.predictCss(FIXTURE, ['rounded-lg', 'border', 'bg-white', 'p-5', 'md:p-6', 'shadow-sm'], 'data-vcide-predict');
  assert.ok(p.css.indexOf('.p-5') < p.css.indexOf('md\\:p-6'));
  assert.ok(!/\.p-4\b/.test(p.css));
});

await test('U22', '幅の帯（予測）: md 未満は変わる・md 以上は md:p-6 が優先', () => {
  const b = E.widthBand([{ token: 'md:p-6', minPx: 768 }], [375, 1440]);
  assert.deepEqual(b.changes, { from: 0, to: 767 });
  assert.deepEqual(b.opened, [{ width: 375, expectChange: true }, { width: 1440, expectChange: false }]);
});

await test('U23', '親とエージェントの検査: nonce・起動インスタンス・知らないキー・範囲外の矩形は捨てる', () => {
  const PR = require('../public/protocol.js');
  const nonce = 'abcdefghijklmnop1234';
  const inst = '0123456789abcdef';
  const base = { source: PR.AGENT, v: PR.V, nonce, instance: inst };
  const item = { i: 0, x: 1, y: 2, w: 3, h: 4, pad: [16, 16, 16, 16], has: { 'p-4': true } };
  const ok = { ...base, kind: 'measure', req: 1, anchor: '0dca476ff6', items: [item], vw: 375, vh: 812, predicted: false };
  assert.ok(PR.parseAgentMessage(ok, nonce, inst));
  assert.equal(PR.parseAgentMessage(ok, 'zzzzzzzzzzzzzzzz0000', inst), null, '別の接続の nonce');
  assert.equal(PR.parseAgentMessage(ok, nonce, 'fedcba9876543210'), null, '別の起動の文書');
  assert.equal(PR.parseAgentMessage({ ...ok, extra: 1 }, nonce, inst), null, '知らないキー');
  assert.equal(PR.parseAgentMessage({ ...ok, items: [{ ...item, pad: [16, 16, 16] }] }, nonce, inst), null);
  assert.equal(PR.parseAgentMessage({ ...ok, items: [{ ...item, w: -1 }] }, nonce, inst), null);
  assert.equal(PR.parseAgentMessage({ ...ok, items: [{ ...item, text: 'x' }] }, nonce, inst), null, '本文の入る場所が無い');
  assert.equal(PR.parseAgentMessage({ ...ok, anchor: '../x' }, nonce, inst), null);
  assert.equal(PR.isHello({ source: PR.AGENT, v: PR.V, kind: 'hello', x: 1 }), false);
  assert.equal(PR.parseAgentMessage({ ...base, kind: 'connected', rev: 'e75cfba70b46', doc: 'a'.repeat(32) }, nonce, inst).kind, 'connected');
});

fs.writeFileSync(path.join(REPO, 'poc/out/edit-unit.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
