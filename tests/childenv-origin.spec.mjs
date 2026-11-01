/* =============================================================================
 * Phase 7B-3B-2 — 起動先の環境変数の「出所」の検査が、本来の漏えいを検出できることの否定テスト。
 *   npm run build:lib && node tests/childenv-origin.spec.mjs
 *
 * **DB も IDE のビルドも要らない。** 実物のプロセスを起こし、/proc/<pid>/environ を読む（Linux）。
 *
 * 再現する構造（7B-3B-1 第9.3節で preview-e2e が失敗した構造と同じ）
 *   IDE（ダミーの秘密情報を持つ）
 *    └ 起動先（親）: IDE が childEnv() で決めた環境で起動。プロジェクトの .env を自分で読み込む（@next/env の代役）
 *        └ 作業プロセス（子）: 親の process.env を受け継ぐ（Turbopack のローダの作業プロセスの代役）
 *
 * 確かめること
 *   1. 正しい起動では、子が DATABASE_URL を持っていても「プロジェクトの .env 由来」と分類され、失敗にならない
 *   2. **IDE の DATABASE_URL が漏れた起動では、同じ名前でも「IDE の秘密情報」と分類されて失敗になる**
 *      （「DATABASE_URL を検査対象から外す」という直し方ではこれを見逃すことも確かめる）
 *   3. 名前を変えて渡った IDE の値も見逃さない
 *   4. どちらの出所とも一致しない値は「説明できない」として失敗にする
 * ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  assertDistinguishable, classifyEnviron, parseDotenv, parseEnviron, projectDotenv,
} from './lib/envOrigin.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { childEnvReport } = require(path.join(REPO, '.libjs', 'server', 'childEnv.js'));

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARK = 'DUMMY-SECRET-7B3B2-ORIGIN';
const DUMMY = {
  GITHUB_TOKEN: `ghp_${MARK}`, AWS_SECRET_ACCESS_KEY: MARK, ANTHROPIC_API_KEY: `sk-ant-${MARK}`,
  DATABASE_URL: `postgres://u:${MARK}@db.invalid/x`,
};
const PROJECT_DB = 'postgresql://app:project_only@127.0.0.1:55432/app';

/* ------------------------------------------------------------------ 1. 読み取り */
console.log('\n1. .env と /proc/<pid>/environ の読み取り');
{
  const m = parseDotenv([
    '# 注釈', 'DATABASE_URL="postgresql://a:b@h/db?schema=poc"', "export TOKEN='x y'", 'PLAIN=v # 注釈', 'EMPTY=', 'bad line',
  ].join('\n'));
  eq('二重引用符を外す', m.get('DATABASE_URL'), 'postgresql://a:b@h/db?schema=poc');
  eq('export 前置と単引用符', m.get('TOKEN'), 'x y');
  eq('行末の注釈を落とす', m.get('PLAIN'), 'v');
  eq('空の値', m.get('EMPTY'), '');
  eq('形の違う行は読まない', m.size, 4);
  eq('environ を名前 → 値に', [...parseEnviron('A=1\0B=x=y\0\0')], [['A', '1'], ['B', 'x=y']]);
}

/* -------------------------------------------------- 2. 実物のプロセスで分類する */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcide-envorigin-'));
fs.writeFileSync(path.join(tmp, '.env'), `DATABASE_URL="${PROJECT_DB}"\n`);
const dotenv = projectDotenv(tmp);
assertDistinguishable(DUMMY, dotenv);

/* 親: プロジェクトの .env を「既に在る変数は上書きしない」で読み込み（@next/env と同じ規則）、子を起こして待つ */
const PARENT = `
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
for (const l of fs.readFileSync(path.join(process.argv[1], '.env'), 'utf8').split('\\n')) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)="?([^"]*)"?$/.exec(l.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { stdio: 'ignore' });
process.stdout.write(String(c.pid) + '\\n');
setTimeout(() => { c.kill(); process.exit(0); }, 20000);
`;
const procs = [];
async function launch(env) {
  const p = spawn(process.execPath, ['-e', PARENT, tmp], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(p);
  const childPid = await new Promise((r) => p.stdout.once('data', (d) => r(Number(String(d).trim()))));
  await sleep(150);
  const read = (pid) => parseEnviron(fs.readFileSync(`/proc/${pid}/environ`, 'utf8'));
  return { parent: read(p.pid), child: read(childPid) };
}
const classify = (environ) => classifyEnviron({ environ, ideSecrets: DUMMY, mark: MARK, dotenv });
/** 7B-1 の旧い検査（名前だけ）。参考として比べる */
const byName = (environ, names) => names.filter((k) => environ.has(k));

const IDE_ENV = { ...process.env, ...DUMMY };
try {
  console.log('\n2. 正しい起動（IDE は childEnv() の環境だけを渡す。親がプロジェクトの .env を読む）');
  {
    const { env } = childEnvReport(IDE_ENV);
    const r = await launch(env);
    const p = classify(r.parent);
    const c = classify(r.child);
    eq('親（IDE が直接起動した）: IDE の秘密情報なし', p.ideSecret, []);
    eq('親: 起動時の環境に秘密情報の名前が1つも無い（IDE が渡したものそのもの）',
      byName(r.parent, Object.keys(DUMMY)), []);
    eq('子: IDE の秘密情報なし', c.ideSecret, []);
    eq('子: DATABASE_URL はプロジェクトの .env 由来と分類する', c.projectDotenv, ['DATABASE_URL']);
    eq('子: 出所を説明できない値は無い', c.unexplained, []);
    ok('（参考）旧い名前だけの検査は、この正常な起動を失敗にしていた', byName(r.child, Object.keys(DUMMY)).includes('DATABASE_URL'));
  }

  console.log('\n3. 否定: IDE の DATABASE_URL が漏れる起動（VCIDE_CHILD_ENV_PASS で IDE の値を渡してしまった場合）');
  {
    const { env, explicit } = childEnvReport({ ...IDE_ENV, VCIDE_CHILD_ENV_PASS: 'DATABASE_URL' });
    eq('前提: 実物の childEnv() が IDE の DATABASE_URL を渡す設定になっている', explicit, ['DATABASE_URL']);
    const r = await launch(env);
    const c = classify(r.child);
    eq('子: DATABASE_URL を IDE の秘密情報として検出する（同じ名前でも .env 由来と取り違えない）',
      c.ideSecret.map((x) => x.name), ['DATABASE_URL']);
    eq('子: プロジェクトの .env 由来には数えない（@next/env は既在の値を上書きしないため IDE の値が残る）', c.projectDotenv, []);
    eq('親: 直接起動したプロセスでも検出する', classify(r.parent).ideSecret.map((x) => x.name), ['DATABASE_URL']);
    /* 「DATABASE_URL を検査対象から外す」直し方ではこれを見逃す */
    const naive = byName(r.child, Object.keys(DUMMY).filter((k) => k !== 'DATABASE_URL'));
    eq('（比較）DATABASE_URL を名前の検査から外す直し方では、この漏えいを見逃す', naive, []);
  }

  console.log('\n4. 否定: IDE の環境をそのまま渡す起動（許可リストを使わない — 7A までの不具合の形）');
  {
    const r = await launch(IDE_ENV);
    const c = classify(r.child);
    eq('子: 4つの秘密情報をすべて IDE のものとして検出する',
      c.ideSecret.map((x) => x.name).sort(), Object.keys(DUMMY).sort());
    eq('子: 出所の判定はすべて値による（名前の一覧に頼らない）', c.ideSecret.every((x) => x.why.startsWith('value-')), true);
  }

  console.log('\n5. 否定: 名前を変えて渡った IDE の値 / どちらの出所とも一致しない値');
  {
    const { env } = childEnvReport(IDE_ENV);
    const r = await launch({ ...env, APP_DB: DUMMY.DATABASE_URL, GITHUB_TOKEN: 'ghp_not_the_ide_one' });
    const c = classify(r.child);
    ok('名前を変えた IDE の値（APP_DB）を検出する', c.ideSecret.some((x) => x.name === 'APP_DB'), c.ideSecret);
    eq('秘密情報の名前だが値がどちらの出所でもない（GITHUB_TOKEN）→ 説明できないとして失敗側', c.unexplained, ['GITHUB_TOKEN']);
  }

  console.log('\n6. 前提の検査: ダミーとプロジェクトの値が同じなら試験を止める');
  {
    let threw = false;
    try { assertDistinguishable({ DATABASE_URL: PROJECT_DB }, dotenv); } catch { threw = true; }
    ok('IDE のダミーとプロジェクトの .env が同じ値なら、出所を区別できないので止める', threw);
  }
} finally {
  for (const p of procs) { try { p.kill(); } catch { /* 終わっている */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails.length ? `\n✗ ${fails.length} 件失敗 / ${pass} 件通過` : `\n✓ すべて通過 — ${pass} 件通過 / 0 件失敗`);
process.exit(fails.length ? 1 : 0);
