/* =============================================================================
 * 編集 PoC（06h）の独立レビューの再現テスト。報告書は docs/06h-edit-poc-review.md。
 *
 * 各項目は「期待する安全な挙動」を主張する。FAIL は、その挙動になっていない事実（=指摘の証拠）。
 * 既存のテスト（unit.spec.mjs・e2e.spec.mjs）は変更しない。修正の実装もしない。
 *
 *   第1部（エンジン）: 使い捨てのコピー poc/out/edit-review/ だけを書き換える。題材は触らない。
 *   第2部（ハーネス）: REVIEW_ISOLATED=1 のときだけ。ハーネスを別ポート（3360〜3362）で起動し、
 *                     題材 poc/fixture-edit/src を書き換える。**作業ツリーとは別の使い捨てのコピー
 *                     （git archive で書き出したもの）でだけ実行すること**。最初に写しを取り、最後に戻す。
 *
 * 実行: node poc/edit/tests/review-repro.spec.mjs [--out <結果の JSON>]
 * 終了コード: FAIL が1つでもあれば 1（FAIL は指摘の再現であり、このテストの不具合ではない）。
 * ========================================================================== */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../..');
process.chdir(REPO);
const FIXTURE = path.join(REPO, 'poc/fixture-edit');
const E = require('../engine.cjs');
const OUT = path.join(REPO, 'poc/out/edit-review');
const outArg = process.argv.indexOf('--out');
const OUT_JSON = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(REPO, 'poc/out/edit-review.json');

const CARD = 'src/components/PropertyCard.tsx';
const CARD_DIV = { line: 7, col: 5, tag: 'div', component: 'PropertyCard' };
const MULTI = ['src/components/PropertyCard.tsx', 'src/components/SiteNotice.tsx', 'src/components/PropertyList.tsx'];

const results = [];
function record(id, expectation, ok, evidence = {}) {
  results.push({ id, expectation, result: ok ? 'PASS' : 'FAIL', evidence });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} ${expectation}\n        ${JSON.stringify(evidence).slice(0, 700)}`);
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
function sandbox(name) {
  const dir = path.join(OUT, `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  fs.cpSync(path.join(FIXTURE, 'src'), path.join(dir, 'src'), { recursive: true });
  for (const f of ['next.config.mjs', 'package.json']) fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  return dir;
}
const listTmp = (dir) => fs.readdirSync(dir).filter((n) => /\.vcide-[0-9a-f]+\.tmp$/.test(n));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const fixtureRev0 = E.revisionOf(FIXTURE).id;

/* ============================================================ 第1部 エンジン */
console.log('edit-poc review repro — part 1 (engine, disposable copies only)');

/* RV01 / RV02: 書き込み範囲は src/ の中だけ、という主張（poc/README.md・engine.safePath の注記） */
{
  const root = sandbox('rv01');
  fs.writeFileSync(path.join(root, 'outside-src.cfg'), 'value = "p-4"\n');
  fs.symlinkSync('../outside-src.cfg', path.join(root, 'src/inside-link.tsx'));
  const sp = E.safePath(root, 'src/inside-link.tsx');
  record('RV01', 'src/ の中のシンボリックリンクが src/ の外（プロジェクト内）を指すとき、safePath は null を返す',
    sp === null, { returned: sp ? path.relative(root, sp) : null });

  const before = read(root, 'outside-src.cfg');
  const s = read(root, 'src/inside-link.tsx');
  const start = s.indexOf('p-4');
  const r = E.applyOne({ root, rel: 'src/inside-link.tsx', baseHash: E.sha256(s), start, end: start + 3, from: 'p-4', to: 'p-5' });
  const after = read(root, 'outside-src.cfg');
  record('RV02', 'そのリンク経由の applyOne は outside-scope で拒否し、src/ の外のファイルを変えない',
    r.status === 'refused' && after === before, { status: r.status, outsideFileBefore: before.trim(), outsideFileAfter: after.trim() });
}

/* RV03: 1ファイル — 直前の照合の後・rename の前に入った外部の書き込み（報告書 3.8 で「失われうる」と記載済みの限界） */
{
  const root = sandbox('rv03');
  const src = read(root, CARD);
  const loc = E.locateClassToken(src, CARD, CARD_DIV, 'p-4', 'p-5');
  const ext = src.replace('竣工 ', '竣工: ');
  const io = {
    read: E.realIo.read,
    writeAtomic(abs, content) { fs.writeFileSync(abs, ext); return E.realIo.writeAtomic(abs, content); },
  };
  const r = E.applyOne({ root, rel: CARD, baseHash: E.sha256(src), start: loc.start, end: loc.end, from: 'p-4', to: 'p-5' }, io);
  const now = read(root, CARD);
  record('RV03', '照合〜rename の間の外部変更は、保持されるか、少なくとも結果が applied にならない（既知の限界の確認）',
    now.includes('竣工: ') || r.status !== 'applied',
    { status: r.status, written: r.written, externalChangeKept: now.includes('竣工: '), readBackEqualsAfter: r.readBackHash === r.afterHash });
}

/* RV04: 複数ファイル — 1件目を書いている間に3件目へ外部変更。各ファイルの書く直前の照合が無い */
{
  const root = sandbox('rv04');
  const changes = MULTI.map((rel) => { const s = read(root, rel); return { rel, baseHash: E.sha256(s), next: `${s}// tx\n` }; });
  let n = 0;
  const io = {
    read: E.realIo.read,
    writeAtomic(abs, c) {
      if (n++ === 0) fs.appendFileSync(path.join(root, MULTI[2]), '// external edit while the transaction is writing\n');
      return E.realIo.writeAtomic(abs, c);
    },
  };
  const r = E.applyTransaction({ root, changes, journalDir: path.join(root, '.journal') }, io);
  const third = read(root, MULTI[2]);
  record('RV04', '複数ファイルの適用中に未着手のファイルへ入った外部変更は上書きしない（committed にしない）',
    third.includes('external edit') && r.outcome !== 'committed',
    { outcome: r.outcome, files: r.files.map((f) => [f.rel.split('/').pop(), f.state, f.content]), externalChangeKept: third.includes('external edit') });
}

/* RV05: 確定（committed）したジャーナルに復旧を当てると、確定した変更が巻き戻る */
{
  const root = sandbox('rv05');
  const changes = MULTI.map((rel) => { const s = read(root, rel); return { rel, baseHash: E.sha256(s), next: `${s}// tx\n` }; });
  const r = E.applyTransaction({ root, changes, journalDir: path.join(root, '.journal') });
  const snapAfter = MULTI.map((rel) => read(root, rel));
  const rec = E.recoverJournal(r.journalFile);
  const snapNow = MULTI.map((rel) => read(root, rel));
  record('RV05', 'state=committed のジャーナルには recoverJournal が何も書かない（確定した変更を巻き戻さない）',
    r.outcome === 'committed' && snapNow.every((s, i) => s === snapAfter[i]),
    { txOutcome: r.outcome, journalStateBefore: 'committed', recover: rec });
}

/* RV06: writeAtomic の途中（fsync 後・rename 前）でプロセスが落ちた */
{
  const root = sandbox('rv06');
  const abs = path.join(root, CARD);
  const before = fs.readFileSync(abs);
  const child = `
    const fs = require('node:fs');
    const E = require(${JSON.stringify(path.join(here, '../engine.cjs'))});
    fs.renameSync = () => process.exit(71);   // rename の直前に落ちたことの再現
    E.realIo.writeAtomic(${JSON.stringify(abs)}, 'NEW CONTENT');`;
  const p = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8' });
  const tmps = listTmp(path.dirname(abs));
  const unchanged = fs.readFileSync(abs).equals(before);
  record('RV06a', 'rename の前に落ちても、対象ファイルは元の内容のまま（途中で切れたファイルにならない）', p.status === 71 && unchanged, { exit: p.status, targetUnchanged: unchanged });
  record('RV06b', 'rename の前に落ちても、利用者の作業ツリー（src/ の中）に一時ファイルを残さない',
    tmps.length === 0, { leftInSrcComponents: tmps, note: 'この名前は .gitignore の対象外（git check-ignore で確認）。起動時の掃除も無い' });
}

/* RV07: 製品の照合（src/server/anchors.ts resolveSelection）— 位置だけの識別子で別の要素へ移る */
{
  const LIB = path.join(REPO, '.libjs/server/anchors.js');
  if (!fs.existsSync(LIB)) {
    record('RV07', '（前提）.libjs が必要。npm run build:lib を先に実行', false, { missing: LIB });
  } else {
    const anchors = require(LIB);
    const { transform } = require('../../anchor/transform.cjs');
    const root = sandbox('rv07');
    const orig = read(root, CARD);
    const lines = orig.split('\n');
    /* 12 行目 11 列: <dd>{property.pref}</dd>。利用者がこれを選んだ後、外部の編集で 12 行目が消える */
    const selectedLine = lines[11].trim();
    const oldId = anchors.anchorIdOf(CARD, 12, 11);
    const edited = lines.filter((_, i) => i !== 11).join('\n');
    fs.writeFileSync(path.join(root, CARD), edited);
    /* HMR の再コンパイルでローダが対応表を書き直したのと同じ状態を作る（同じ純粋変換） */
    const outDir = anchors.anchorOutDir(root);
    fs.mkdirSync(outDir, { recursive: true });
    const t = transform(edited, CARD);
    fs.writeFileSync(path.join(outDir, '0000000000000000.json'), JSON.stringify({ file: CARD, anchors: t.anchors, usages: t.usages }));
    const sel = { tag: 'dd', anchorOnSelf: oldId, anchorOrdinal: 0, anchorInstanceCount: 1, ancestorAnchors: [], textNodeIndex: 0, valueShape: null, formControl: false, path: '/properties' };
    const r = anchors.resolveSelection(root, anchors.anchorSupport(root), sel);
    fs.rmSync(outDir, { recursive: true, force: true });
    record('RV07', '選んだ要素の行が消えた後、古い識別子は「特定できません」になり、同じ位置に来た別の要素へは照合しない',
      r.status !== 'resolved',
      { selectedSourceLine: selectedLine, status: r.status, resolvedTo: r.anchor ? `${r.anchor.file}:${r.anchor.line}:${r.anchor.col}` : null, resolvedSourceLine: r.anchor?.sourceLine ?? null, checksPassed: r.checks?.length ?? 0 });
  }
}

/* RV08: エンジンの位置の特定 — 同じ理由で、別の要素の token を書き換える位置を返す */
{
  const two = ['export function Two() {', '  return (', '    <section>',
    '      <div className="rounded border p-4">first</div>',
    '      <div className="rounded border p-4 shadow">second</div>',
    '    </section>', '  );', '}'].join('\n');
  const target = { line: 4, col: 7, tag: 'div', component: 'Two' };          // 1つ目を選んだ
  const edited = two.split('\n').filter((_, i) => i !== 3).join('\n');        // 外部の編集で1つ目が消えた
  const loc = E.locateClassToken(edited, 'src/two.tsx', target, 'p-4', 'p-5');
  const patchedLine = loc.ok ? E.patchToken(edited, loc, 'p-4', 'p-5').split('\n')[3].trim() : null;
  record('RV08', '選んだ要素が消えた後の古い位置では source-mismatch になり、別の要素の token を書き換えない',
    !loc.ok, { ok: loc.ok, reason: loc.reason ?? null, wouldPatch: patchedLine,
      note: '実際の流れでは draft の baseHash が新しい内容から作られるため、照合（RV07）を通った後はこの位置へ書ける' });
}

/* ============================================================ 第2部 ハーネス */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isListening = (port) => new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });

if (process.env.REVIEW_ISOLATED !== '1') {
  console.log('\npart 2 skipped（REVIEW_ISOLATED=1 と、作業ツリーとは別の使い捨てのコピーが必要）');
} else {
  console.log('\nedit-poc review repro — part 2 (harness on 3360-3362; fixture is written, then restored)');
  const PORTS = { POC_EDIT_DEV_PORT: '3360', POC_EDIT_RELAY_PORT: '3361', POC_EDIT_UI_PORT: '3362' };
  const UI = 'http://127.0.0.1:3362';
  const SNAP = new Map();
  (function snap(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) snap(abs); else SNAP.set(abs, fs.readFileSync(abs));
    }
  }(path.join(FIXTURE, 'src')));
  const restore = () => { let n = 0; for (const [abs, b] of SNAP) if (!fs.existsSync(abs) || !fs.readFileSync(abs).equals(b)) { fs.writeFileSync(abs, b); n += 1; } return n; };

  /* RS01: ポート競合 — 無関係なプロセスを止めずに、起動しない */
  {
    const dummy = net.createServer((s) => s.end()).listen(3360, '127.0.0.1');
    await new Promise((r) => dummy.once('listening', r));
    const p = spawnSync(process.execPath, [path.join(REPO, 'poc/edit/server.mjs')], { env: { ...process.env, ...PORTS }, encoding: 'utf8', timeout: 60000 });
    const alive = await isListening(3360);
    dummy.close();
    record('RS01', '使用中のポートでは起動せず（終了コード 2）、そのポートの無関係なプロセスは生きたまま', p.status === 2 && alive,
      { exit: p.status, unrelatedStillListening: alive, stderr: (p.stderr || '').trim().slice(0, 120) });
  }

  const server = spawn(process.execPath, [path.join(REPO, 'poc/edit/server.mjs')], { env: { ...process.env, ...PORTS }, stdio: ['ignore', 'pipe', 'pipe'] });
  let sout = '';
  server.stdout.on('data', (d) => { sout += d; }); server.stderr.on('data', (d) => { sout += d; });
  try {
    const t0 = Date.now();
    while (!sout.includes('POC_EDIT_READY')) { if (Date.now() - t0 > 180000 || server.exitCode !== null) throw new Error(`harness not ready:\n${sout}`); await sleep(200); }

    const get = (p) => new Promise((resolve, reject) => { http.get(`${UI}${p}`, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); }).on('error', reject); });
    const html = await get('/');
    const CFG = JSON.parse(Buffer.from(/name="poc-config" content="([^"]+)"/.exec(html)[1], 'base64').toString('utf8'));
    const api = (p, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const q = http.request(`${UI}${p}`, { method: data ? 'POST' : 'GET', headers: { 'x-poc-session': CFG.session, origin: UI, 'content-type': 'application/json' } }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve({ http: res.statusCode, ...JSON.parse(b || '{}') }); } catch { resolve({ http: res.statusCode, raw: b }); } });
      });
      q.on('error', reject); if (data) q.write(data); q.end();
    });

    /* RS05（計測）: 方式 B の「メモリ約2倍」の基準として、ハーネスの開発サーバー1つの RSS を同じ方法で測る */
    {
      const pid = execFileSync('pgrep', ['-f', 'next/dist/bin/next dev -p 3360']).toString().trim().split('\n')[0];
      const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', pid]).toString().trim();
      const pids = execFileSync('pgrep', ['-g', pgid]).toString().trim().split('\n');
      const rssKb = pids.reduce((s, p) => { try { return s + Number(fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]); } catch { return s; } }, 0);
      results.push({ id: 'RS05', expectation: '計測のみ: ハーネスの開発サーバー（/properties をコンパイル済み）のプロセスグループの RSS 合計', result: 'MEASURED', evidence: { rssKb, processes: pids.length, method: 'shadow-preview.mjs と同じ（pgrep -g の VmRSS の合計。共有ページを重複して数える）' } });
      console.log(`  MEASURED RS05 dev server RSS ${rssKb} kB (${pids.length} processes)`);
    }

    /* 適用まで（実際の UI と同じ API の順序。選択は iframe の代わりにここで作る） */
    const anchorId = require(path.join(REPO, '.libjs/server/anchors.js')).anchorIdOf(CARD, 7, 5);
    const sel = { tag: 'div', anchorOnSelf: anchorId, anchorOrdinal: 1, anchorInstanceCount: 10, ancestorAnchors: [], textNodeIndex: null, valueShape: null, formControl: false, path: '/properties' };
    const res = await api('/api/resolve', { instance: CFG.instance, selection: sel });
    if (res.status !== 'resolved') throw new Error(`resolve failed: ${JSON.stringify(res)}`);
    await api('/api/draft', { anchorId, to: 'p-5' });
    const st0 = await api('/api/state');
    const ap = await api('/api/apply', { draftId: st0.draft.id, baseHash: st0.draft.baseHash, diffHash: st0.draft.diffHash });
    if (!ap.applied) throw new Error(`apply failed: ${JSON.stringify(ap)}`);
    const A = ap.applied;
    const items = (px, n = 10) => Array.from({ length: n }, (_, i) => ({ i, x: 0, y: i * 100, w: 300, h: 90, pad: [px, px, px, px], has: { 'p-4': false, 'p-5': true, 'p-6': false, 'md:p-6': true } }));
    const ctrl = (px) => [{ i: 0, x: 0, y: 0, w: 300, h: 50, pad: [px, px, px, px], has: { 'p-4': true, 'p-5': false, 'p-6': false, 'md:p-6': true } }];
    const mobileOk = { name: 'Mobile', vw: 375, docRev: A.revBefore, reloaded: false, items: items(20), control: ctrl(16) };
    const desktopOk = { name: 'Desktop', vw: 1440, docRev: A.revBefore, reloaded: false, items: items(24), control: ctrl(24) };

    /* RS02: 片方のアートボードだけの計測で、全体の検証が通る */
    {
      const v = await api('/api/verify', { appliedId: A.id, phase: 'apply', rerender: 'hmr', artboards: [mobileOk] });
      record('RS02', 'サーバーの検証は、開いている2つの幅の計測が揃わなければ passed にしない（Desktop の計測が欠けた要求）',
        v.verification?.verify !== 'passed',
        { verify: v.verification?.verify, artboards: v.verification?.artboards?.map((a) => a.name), verifiedRevision: v.verification?.verifiedRevision,
          note: '現在の UI の collect() は計測失敗でも空の items で2幅を送るので失敗になる。サーバー自身は2幅を要求していない' });
    }

    /* RS04: 適用後に無関係なファイルが変わった（いまの版 ≠ 適用直後の版）のに、HMR の検証が「適用後の版で通過」と記録する */
    {
      const sn = path.join(FIXTURE, 'src/components/SiteNotice.tsx');
      fs.appendFileSync(sn, '// external edit after apply (review RS04)\n');
      const cur = (await api('/api/state')).revision.id;
      const v = await api('/api/verify', { appliedId: A.id, phase: 'apply', rerender: 'hmr', artboards: [mobileOk, desktopOk] });
      record('RS04', '検証の時点のコードの版が適用直後の版と違えば、その版で検証済み（verifiedRevision = revAfter）と記録しない',
        !(v.verification?.verify === 'passed' && v.verification?.verifiedRevision === A.revAfter && cur !== A.revAfter),
        { verify: v.verification?.verify, verifiedRevision: v.verification?.verifiedRevision, revAfter: A.revAfter, currentRevision: cur });
      fs.writeFileSync(sn, SNAP.get(sn));
    }

    /* 後片付け: 適用の取り消し（照合つき）→ 題材を写しと一致させる */
    const rv = await api('/api/revert', { appliedId: A.id });
    results.push({ id: 'RS-cleanup-revert', expectation: '後片付けの取り消し', result: rv.applied?.revert?.status === 'reverted' ? 'PASS' : 'FAIL', evidence: { status: rv.applied?.revert?.status ?? rv.status } });
  } catch (e) {
    results.push({ id: 'RS-error', expectation: '第2部の実行', result: 'FAIL', evidence: { error: String(e.stack || e).slice(0, 1500) } });
    console.log(String(e.stack || e));
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => { if (server.exitCode !== null) r(); else server.once('exit', r); });
    await sleep(1500);
    const leftover = await Promise.all([3360, 3361, 3362].map(isListening));
    let devLeft = '';
    try { devLeft = execFileSync('pgrep', ['-f', 'next/dist/bin/next dev -p 3360']).toString().trim(); } catch { devLeft = ''; }
    record('RS06', 'ハーネスの停止で、所有する開発サーバー（プロセスグループ）も止まり、ポートが空く',
      leftover.every((x) => !x) && !devLeft, { listening: leftover, devProcesses: devLeft || null });
    const n = restore();
    record('RS07', '第2部の後、題材 src/ は写しとバイト一致（戻したファイル数は記録のみ）', [...SNAP].every(([abs, b]) => fs.readFileSync(abs).equals(b)), { restoredFiles: n });
  }
}

record('RV99', '第1部・第2部の後、題材の版は開始時と同じ', E.revisionOf(FIXTURE).id === fixtureRev0, { rev0: fixtureRev0, now: E.revisionOf(FIXTURE).id });
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 1));
const nFail = results.filter((r) => r.result === 'FAIL').length;
console.log(`\n${results.filter((r) => r.result === 'PASS').length} PASS / ${nFail} FAIL / ${results.filter((r) => r.result === 'MEASURED').length} MEASURED`);
process.exit(nFail ? 1 : 0);
