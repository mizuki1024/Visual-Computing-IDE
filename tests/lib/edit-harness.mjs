/* =============================================================================
 * 編集 E1（安全なコード変更の基盤）の試験の共通部品。
 *
 *   - 使い捨ての題材（OS の一時ディレクトリ。リポジトリの題材は読むだけで、書き換えない — F-10）
 *   - 要素識別子の対応表を、製品のローダと**同じ純粋変換**（poc/anchor/transform.cjs）で書く
 *     （HMR の再コンパイルでローダが対応表を書き直したのと同じ状態）
 *   - DOM が送る選択（ElementSelection。製品の previewProtocol の形）を作る
 *   - 通過・失敗の数え方は既存の試験と同じ（「N 件通過 / M 件失敗」を scripts/test-all.sh が読む）
 *
 * 製品のコードは .libjs（npm run build:lib の出力）から読む。VCIDE_LIBJS で別の出力先を指せる（開発用）。
 * ========================================================================== */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '..', '..');
export const LIB = process.env.VCIDE_LIBJS ? path.resolve(process.env.VCIDE_LIBJS) : path.join(REPO, '.libjs');
export const require_ = createRequire(import.meta.url);
export const AN = require_(path.join(LIB, 'server', 'anchors.js'));
export const P = require_(path.join(LIB, 'lib', 'previewProtocol.js'));
export const { transform } = require_(path.join(REPO, 'poc', 'anchor', 'transform.cjs'));

/** 製品の編集エンジン。無ければ例外（＝試験の失敗として数える。黙って skip しない） */
export function loadEdit(name = 'engine') {
  return require_(path.join(LIB, 'server', 'edit', `${name}.js`));
}

export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ------------------------------------------------------------ 数え方 */
export function counter() {
  let pass = 0;
  const fails = [];
  const known = [];
  const ok = (name, cond, got) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
  };
  const eq = (name, a, b) => ok(name, a === b, a);
  const note = (s) => console.log(`    · ${s}`);
  /** 既知の限界の**再現の記録**（安全の主張ではない。通過・失敗に数えない） */
  const limit = (name, detail) => { known.push({ name, detail }); console.log(`  ⚠ [既知の限界] ${name} — ${JSON.stringify(detail)}`); };
  /** 試験の本体が例外で止まったら、失敗として数えて続ける */
  const guard = (name, fn) => {
    try { return fn(); } catch (e) { ok(`${name}（例外で止まった）`, false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); return undefined; }
  };
  const finish = () => {
    if (known.length) console.log(`\n既知の限界の記録: ${known.length} 件（安全の主張ではない。docs/08a 第5節）`);
    console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
    if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
    process.exit(0);
  };
  return { ok, eq, note, limit, guard, finish, get pass() { return pass; }, get fails() { return fails; } };
}

/* ------------------------------------------------------------ 使い捨ての題材 */
const NEXT_CONFIG = "/* 試験用。要素識別子のローダを読み込む取り決め（anchors.anchorSupport が読む） */\n"
  + "const A = process.env.POC03_ANCHOR === '1';\nexport default {};\n";

/**
 * 一時ディレクトリに Next.js の形の題材を作る。files: { 'src/components/X.tsx': '...' }
 * 返す root は realpath（macOS の /var → /private/var のような差を消す）。
 */
export function makeProject(files, { name = 'e1' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `vcide-${name}-`)));
  const root = path.join(base, 'app');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'next.config.mjs'), NEXT_CONFIG);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"edit-e1-fixture","private":true}\n');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const outDir = AN.anchorOutDir(root);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const journalDir = path.join(base, 'journal');   // 題材（root）の外。IDE の .ide-runtime と同じ扱い

  const abs = (rel) => path.join(root, rel);
  const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
  const write = (rel, text) => fs.writeFileSync(abs(rel), text);
  /** ローダと同じ変換で、そのファイルの対応表を書き直す（キーも loader.cjs の writeManifest と同じ） */
  const compile = (rel) => {
    const code = read(rel);
    const t = transform(code, rel);
    const key = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify({ file: rel, rev: t.rev, anchors: t.anchors, usages: t.usages, components: t.components }));
    return t;
  };
  /** needle を含む行で始まる JSX の対応表の記述（行の最初の '<' の列）。**正解は対応表ではなく、ソースの文字列から決める** */
  const anchorAt = (rel, needle, t = transform(read(rel), rel)) => {
    const lines = read(rel).split('\n');
    const hits = lines.map((l, i) => (l.includes(needle) ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) throw new Error(`needle が1行に決まりません: ${needle} → ${hits.length}`);
    const line = hits[0] + 1;
    const col = lines[hits[0]].indexOf('<') + 1;
    const a = t.anchors.find((x) => x.line === line && x.col === col);
    if (!a) throw new Error(`対応表に要素がありません: ${rel}:${line}:${col}`);
    return { ...a, rev: t.rev };
  };
  const cleanup = () => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  };
  /** src/ の下に残った一時ファイル（F-06） */
  const leftovers = () => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
        else if (/\.tmp$/.test(e.name) || e.name.includes('vcide-edit')) out.push(path.relative(root, p));
      }
    };
    walk(path.join(root, 'src'));
    return out;
  };
  return { base, root, outDir, journalDir, abs, read, write, compile, anchorAt, cleanup, leftovers };
}

/** DOM が送る選択（製品の previewProtocol.parseSelection を通る形）。rev は DOM の data-vcide-rev */
export function selectionOf(anchor, rev = anchor.rev, extra = {}) {
  const s = {
    tag: anchor.tag, anchorOnSelf: anchor.id, anchorRev: rev, anchorOrdinal: 0, anchorInstanceCount: 1,
    ancestorAnchors: [], ancestorRevs: [], textNodeIndex: null, valueShape: null, formControl: false, path: '/',
    ...extra,
  };
  if (!P.parseSelection(s)) throw new Error(`試験の選択が製品の parseSelection を通りません: ${JSON.stringify(s)}`);
  return s;
}

/** 書き込みを有効にした状態で fn を実行し、元へ戻す */
export const WRITE_ENV = 'VCIDE_EDIT_E1_WRITE';
export function withWrites(on, fn) {
  const prev = process.env[WRITE_ENV];
  if (on) process.env[WRITE_ENV] = '1'; else delete process.env[WRITE_ENV];
  try { return fn(); } finally { if (prev === undefined) delete process.env[WRITE_ENV]; else process.env[WRITE_ENV] = prev; }
}

/** ディレクトリの中身のスナップショット（バイト一致の比較用） */
export function snapshot(dir) {
  const m = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) m.set(path.relative(dir, p), `link:${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) walk(p);
      else m.set(path.relative(dir, p), sha256(fs.readFileSync(p)));
    }
  };
  walk(dir);
  return m;
}
export const sameSnapshot = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** 編集 PoC の題材（読むだけ） */
export const FIXTURE_EDIT = path.join(REPO, 'poc', 'fixture-edit');
export const CARD = 'src/components/PropertyCard.tsx';
export const readFixture = (rel) => fs.readFileSync(path.join(FIXTURE_EDIT, rel), 'utf8');

/** RV08 と同じ題材: 同じ字下げ・同じタグ・同じコンポーネントの兄弟 */
export const TWO = 'src/components/Two.tsx';
export const TWO_SRC = ['export function Two() {', '  return (', '    <section>',
  '      <div className="rounded border p-4">first</div>',
  '      <div className="rounded border p-4 shadow">second</div>',
  '    </section>', '  );', '}', ''].join('\n');

/** 必須の2幅（docs/07d 1.2: Desktop 1440・Mobile 375） */
export const VIEWPORTS = [{ name: 'desktop', width: 1440 }, { name: 'mobile', width: 375 }];
