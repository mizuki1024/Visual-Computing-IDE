/* =============================================================================
 * 編集 E1 — 既定で無効（T12）と、書き込みの入口が1か所であること（07d 6.2 E1-1・E1-8）。
 *   npm run build && npm run build:lib && BASE=http://127.0.0.1:3100 node tests/edit-disabled.spec.mjs
 *   （scripts/test-all.sh が IDE を next start で起動し BASE を渡す）
 *
 *   1. 環境変数 VCIDE_EDIT_E1_WRITE=1 を明示しない限り、適用・取り消し・復旧はファイルに書かない
 *   2. 通常の IDE の起動（next start）に、編集の書き込みの API は無い（/api/edit/* は 404）
 *   3. コードの検索: 対象のソースへ書く fs の呼び出しは src/server/edit/fsio.ts だけ。
 *      画面・API・探索のモジュールは編集のモジュールを読み込まない（利用者向けの入口を作らない）
 *      E2.1（docs/08d 第3節 D-4）: 例外は読み取り・照合だけの窓口 src/server/editSync/readonlyEdit.ts の1つだけ。
 *      窓口は書き込み（apply・revert・recover・startupRecovery・submitVerification・createDraft・carrySelection）を呼ばない
 *   4. 探索の持ち物（anchors.ts・previewProtocol.ts・dataAccess.ts・注入）は、この段で変えていない
 *      E2.1（D-1）: previewGateway.ts だけは、既定の動作を変えない追加（editSync の知らせ）を許す。消した行は下の一覧と一致すること
 *   5. E2.1: 通常の起動（VCIDE_EDIT_SYNC_DEV を付けない）に、開発用の同期の API は無い（/api/edit-sync/* は 404）
 * ========================================================================== */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { counter, makeProject, selectionOf, loadEdit, readFixture, CARD, REPO, withWrites } from './lib/edit-harness.mjs';

const C = counter();
const { ok, eq, note, guard } = C;
let E;
try { E = loadEdit('engine'); } catch (e) { ok('製品の編集エンジンを読み込める', false, String(e.message)); C.finish(); }
const { EditEngine, EDIT_WRITE_ENV, editWritesEnabled } = E;
const ORIG = readFixture(CARD);
const change = { kind: 'class-token', from: 'p-4', to: 'p-5' };

/* ============================================================ 1 */
console.log('\n1. 環境変数を明示しない限り、書き込まない');
guard('1', () => {
  eq('環境変数の名前', EDIT_WRITE_ENV, 'VCIDE_EDIT_E1_WRITE');
  for (const v of [undefined, '', '0', 'true', 'yes', 'on', '1 ', ' 1', 'TRUE']) {
    const env = v === undefined ? {} : { [EDIT_WRITE_ENV]: v };
    eq(`値 ${JSON.stringify(v)} では無効`, editWritesEnabled(env), false);
  }
  eq('値 "1" のときだけ有効', editWritesEnabled({ [EDIT_WRITE_ENV]: '1' }), true);
  const prev = process.env[EDIT_WRITE_ENV];
  delete process.env[EDIT_WRITE_ENV];
  const p = makeProject({ [CARD]: ORIG }, { name: 'off' });
  p.compile(CARD);
  const eng = new EditEngine({ projectRoot: p.root, journalDir: p.journalDir });
  const s = selectionOf(p.anchorAt(CARD, 'p-4 md:p-6'));
  const t = eng.resolveTarget(s);
  ok('無効でも、対象の解決（読むだけ）はできる', t.ok === true, t);
  const d = eng.createDraft(t.target.id, s, change);
  ok('無効でも、下書き（ファイルに触れない）は作れる', d.ok === true, d);
  const r = eng.apply({ changes: [{ draftId: d.draft.id, reviewedDiffHash: d.draft.diffHash, selection: s }] });
  ok('無効なら適用しない（edit-disabled・written: false）', r.written === false && r.reason === 'edit-disabled', r);
  eq('（同）ファイルは元のまま', p.read(CARD), ORIG);
  ok('（同）ジャーナルを作らない', !fs.existsSync(p.journalDir) || fs.readdirSync(p.journalDir).length === 0);
  /* 有効にして適用し、無効に戻すと取り消しもしない */
  const r2 = withWrites(true, () => eng.apply({ changes: [{ draftId: d.draft.id, reviewedDiffHash: d.draft.diffHash, selection: s }] }));
  eq('前提: 有効にすれば適用できる', r2.status, 'committed');
  const after = p.read(CARD);
  const rv = eng.revert(r2.txId);
  ok('無効なら取り消しも書かない', rv.written === false && rv.reason === 'edit-disabled', rv);
  eq('（同）ファイルは適用後のまま', p.read(CARD), after);
  const rc = eng.recover();
  eq('無効なら復旧は見せるだけ（dry-run）', rc.status, 'dry-run');
  const S = loadEdit('fsio');
  const w = S.replaceSourceFile({ projectRoot: p.root, rel: CARD, expectedHash: 'x', next: 'x', tempName: '.PropertyCard.tsx.vcide-edit-tx-20990101000000-deadbeef.tmp' });
  ok('書き込みの入口（fsio.replaceSourceFile）も、自分で無効を確かめる', w.status === 'not-written' && w.reason === 'edit-disabled', w);
  eq('（同）ファイルは適用後のまま', p.read(CARD), after);
  if (prev !== undefined) process.env[EDIT_WRITE_ENV] = prev;
  p.cleanup();
});

/* ============================================================ 2 */
console.log('\n2. 通常の IDE の起動に、編集の書き込みの API は無い');
await guard('2', async () => {
  const BASE = process.env.BASE;
  ok('IDE の起動先（BASE）が与えられている（scripts/test-all.sh が next start で起動する）', !!BASE, BASE);
  if (!BASE) return;
  const ping = await fetch(`${BASE}/api/runtime/status`).then((r) => r.status).catch((e) => String(e));
  eq('前提: IDE は応答する（/api/runtime/status）', ping, 200);
  for (const p of ['/api/edit', '/api/edit/apply', '/api/edit/draft', '/api/edit/revert', '/api/edit/recover', '/api/edit/verify', '/api/runtime/edit',
    /* 5. E2.1: 開発用の同期の API も、通常の起動では無い */
    '/api/edit-sync/state', '/api/edit-sync/select', '/api/edit-sync/connect', '/api/edit-sync/recheck', '/api/edit-sync/bind-report', '/api/edit-sync/apply']) {
    for (const method of ['GET', 'POST']) {
      const st = await fetch(`${BASE}${p}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }).then((r) => r.status).catch((e) => String(e));
      eq(`${method} ${p} は 404`, st, 404);
    }
  }
});

/* ============================================================ 3 */
console.log('\n3. 書き込みの入口は1か所・利用者向けの入口を作らない（コードの検索）');
guard('3', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) files.push(p); } };
  walk(path.join(REPO, 'src'));
  const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');
  const WRITE = /\bfs\.(writeFileSync|writeSync|renameSync|unlinkSync|rmSync|openSync|appendFileSync|copyFileSync|mkdirSync|symlinkSync|linkSync|truncateSync|ftruncateSync|chmodSync|writeFile|rename|unlink|rm|open|appendFile|copyFile|mkdir|promises)\b|from 'node:fs\/promises'|require\('fs\/promises'\)/;
  const editFiles = files.filter((f) => rel(f).startsWith('src/server/edit/'));
  ok('編集のモジュールは src/server/edit/ にある', editFiles.length >= 6, editFiles.map(rel));
  const writers = editFiles.filter((f) => WRITE.test(fs.readFileSync(f, 'utf8'))).map(rel);
  eq('src/server/edit/ の中で fs に書くのは fsio.ts だけ', JSON.stringify(writers), JSON.stringify(['src/server/edit/fsio.ts']));
  /* E2.1: 読み込みの指定を実際のパスに解決して、src/server/edit/ の中を指すかで判定する（src/components/edit/ のような名前の似た別の場所を取り違えない） */
  const EDIT_DIR = path.join(REPO, 'src', 'server', 'edit');
  const importsEdit = (f, text = fs.readFileSync(f, 'utf8')) => [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].some(([, spec]) => {
    const target = spec.startsWith('@/') ? path.join(REPO, 'src', spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(f), spec) : null;
    return !!target && (target === EDIT_DIR || target.startsWith(EDIT_DIR + path.sep));
  });
  const importers = files.filter((f) => !rel(f).startsWith('src/server/edit/') && importsEdit(f)).map(rel);
  ok('判定の確かめ: src/server/edit/ の外のファイルが ../edit/engine を読むと検出する（試験の検索が働く）',
    importsEdit(path.join(REPO, 'src', 'server', 'editSync', 'x.ts'), "import { X } from '../edit/engine';\n")
    && importsEdit(path.join(REPO, 'src', 'app', 'x.ts'), "import { X } from '@/server/edit/engine';\n")
    && !importsEdit(path.join(REPO, 'src', 'components', 'x.tsx'), "import X from './edit/EditSyncDevPanel';\n"));
  /* E2.1（D-4）: 読み取り・照合だけの窓口の1つだけを許す */
  eq('画面・API・探索のモジュールは編集のモジュールを読み込まない（読み取りの窓口 editSync/readonlyEdit.ts の1つだけを除く）',
    JSON.stringify(importers), JSON.stringify(['src/server/editSync/readonlyEdit.ts']));
  const ro = fs.readFileSync(path.join(REPO, 'src/server/editSync/readonlyEdit.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('窓口は書き込み（apply・revert・recover・startupRecovery・submitVerification・createDraft・carrySelection）を呼ばない',
    !/\.(apply|revert|recover|startupRecovery|submitVerification|createDraft|carrySelection)\s*\(/.test(ro));
  ok('窓口は書き込みの入口（fsio）を読み込まない', !/fsio/.test(ro));
  ok('窓口はエンジンの実体を外へ渡さない（凍結した4つの関数だけ）', /Object\.freeze\(\{[\s\S]*root: e\.root,[\s\S]*resolveTarget[\s\S]*reresolveTarget[\s\S]*inspectRecovery[\s\S]*\}\)/.test(ro));
  const viaRo = files.filter((f) => /editSync\/readonlyEdit|from '\.\/readonlyEdit'/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  eq('窓口を読み込むのは同期のセッションだけ', JSON.stringify(viaRo), JSON.stringify(['src/server/editSync/session.ts']));
  ok('編集の API のディレクトリ（src/app/api/edit）は無い', !fs.existsSync(path.join(REPO, 'src/app/api/edit')));
  const others = files.filter((f) => !rel(f).startsWith('src/server/edit/') && WRITE.test(fs.readFileSync(f, 'utf8'))).map(rel);
  note(`編集の外で fs に書くモジュール（IDE 自身の .ide-runtime への記録。対象のソースではない）: ${others.join(', ')}`);
  /* E1 の前からあるもの: devServer（所有の記録）・spanFiles（収集物の削除）・anchors・ide（.ide-runtime の作成）・
   * observations（読むための openSync(…, 'r')。正規表現が書き込みと区別しないため一覧に入る） */
  ok('編集の外で fs に触れる上のモジュールは、E1 の前からある IDE 自身の記録だけ（新しく足していない）',
    others.every((f) => ['src/server/devServer.ts', 'src/server/spanFiles.ts', 'src/server/anchors.ts', 'src/server/ide.ts', 'src/server/observations.ts'].includes(f)), others);
});

/* ============================================================ 4 */
console.log('\n4. 探索の持ち物を、この段で変えていない');
guard('4', () => {
  const OWNED = ['src/server/anchors.ts', 'src/lib/previewProtocol.ts', 'src/server/previewGateway.ts', 'src/server/dataAccess.ts',
    'src/server/observations.ts', 'src/lib/liveLineage.ts', 'src/lib/liveObservation.ts', 'poc/anchor', 'poc/fixture-app/ide-instrumentation',
    'poc/runner/lib/srvmap.mjs'];
  const BASELINE = process.env.VCIDE_EXPLORE_BASELINE ?? '2e5c0a2';
  let diff = null;
  try {
    execFileSync('git', ['cat-file', '-e', `${BASELINE}^{commit}`], { cwd: REPO, stdio: 'ignore' });
    diff = execFileSync('git', ['diff', '--name-only', BASELINE, '--', ...OWNED], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch (e) { diff = `git が使えない: ${e.message}`; }
  /* E2.1（D-1）: previewGateway.ts は既定の動作を変えない追加だけを許す（既定のスクリプトの同一性は edit-sync21-unit の E21-19 が sha256 で確かめる） */
  const rest = diff.split('\n').filter((f) => f && f !== 'src/server/previewGateway.ts');
  eq(`探索の持ち物（07d 4.2）は ${BASELINE}（探索の確認済みの先端）から変わっていない（作業ツリーを含む。previewGateway.ts を除く）`, rest.join(','), '');
  let removed = null;
  try {
    removed = execFileSync('git', ['diff', BASELINE, '--', 'src/server/previewGateway.ts'], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1).trim());
  } catch (e) { removed = [`git が使えない: ${e.message}`]; }
  const ALLOWED_REMOVED = [
    'record(run: string, rec: RelayRecord, meta?: { relayId?: string; docToken?: string }): void;',
    'export function agentJs(cfg: AccessConfig): string {',
    'var hoverBox = null, selBox = null, hoverEl = null, selEl = null, raf = 0;',
    'selEl = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;',
    "addL('mousemove', function(e){ if (selecting) hoverEl = e.target; }, true);",
    "if (x && x.source === 'vcide-ide' && x.v === ${PROTOCOL_VERSION} && x.nonce === nonce && x.kind === 'mode' && typeof x.select === 'boolean') setMode(x.select);",
    'res.end(agentJs(this.#opts.config));',
    '}, relayId || docToken ? { ...(relayId ? { relayId } : {}), ...(docToken ? { docToken } : {}) } : undefined);',
  ];
  ok('previewGateway.ts で消した（書き換えた）行は、既定の動作を変えない拡張の差し込み口だけ（D-1）',
    removed.every((l) => ALLOWED_REMOVED.includes(l)), removed.filter((l) => !ALLOWED_REMOVED.includes(l)));
});

C.finish();
