/* =============================================================================
 * 対象プロジェクトの検出（Phase 7A 指示 2.A）。
 *
 * ここは **読むだけ** である。対象プロジェクトへの書き込みを一切しない。
 *
 * 出力は `02a` 3.1節の `Project` / `SupportMatrix` に対応する最小形であり、
 * 判定できなかったことを「対応している」と書かない（OBS-05）。
 * 各所見は `03d` 1.1節の4要素（事実 / 理由 / わからないこと / 次の操作）を持つ。
 * ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { instrumentationBootPath } from './ide';
import { pidAlive, pidCommand } from './net';

/** 03d 1.1節の状態カードそのもの。文言は実装側で作らず、ここで1か所に持つ。 */
export interface Finding {
  code: string;
  /** blocker = 起動させない / limit = 起動はするが見えない範囲がある / info = 記録 */
  severity: 'blocker' | 'limit' | 'info';
  /** ① 何が起きたか（観測された事実だけ） */
  fact: string;
  /** ② なぜか。特定できない場合は「特定できません」と書く */
  reason: string;
  /** ③ この結果わからないこと（省略不可） */
  impact: string;
  /** ④ 次にできること。無ければ null（偽の選択肢を置かない — ER-05） */
  action: string | null;
}

export type Verdict = 'supported' | 'partial' | 'unsupported' | 'invalid';

export interface ExistingDevServer {
  pid: number;
  port: number | null;
  appUrl: string | null;
  /** 観測手段。`next-dev-lock` は Next 16 が置く `.next/dev/lock` である */
  source: 'next-dev-lock';
  /** その PID のコマンド行（PID 再利用の判定に使う） */
  command: string | null;
}

export interface InstrumentationAvailability {
  available: boolean;
  /** 使えない場合の理由。使える場合は null */
  reason: string | null;
  /** 前置するファイル（IDE 側の絶対パス） */
  boot: string | null;
  /** 解決できなかった依存 */
  missing: string[];
}

export interface ProjectInspection {
  /** 利用者が入力した文字列そのまま（表示のため保持する） */
  input: string;
  /** 正規化した絶対パス。同定できなければ null */
  root: string | null;
  name: string | null;
  verdict: Verdict;
  next: {
    declared: string | null;
    installed: string | null;
    major: number | null;
    /** 起動に使う実体。`node_modules/next/dist/bin/next` */
    binPath: string | null;
  };
  router: {
    kind: 'app' | 'pages' | 'both' | 'none';
    appDir: string | null;
    pagesDir: string | null;
  };
  packageManager: string | null;
  /** package.json の dev スクリプト。**IDE はこれを実行しない**（指示 2.E） */
  devScript: string | null;
  nodeModulesInstalled: boolean;
  nextConfig: string | null;
  existingDevServer: ExistingDevServer | null;
  instrumentation: InstrumentationAvailability;
  findings: Finding[];
  checkedAt: string;
}

/** App Router / Pages Router の入口として認める構成ファイル */
const ENTRY_BASENAMES = ['layout', 'page'];
const ENTRY_EXTS = ['tsx', 'ts', 'jsx', 'js', 'mjs'];

/** 計装の束が必要とする依存。1つでも解決できなければ計装は使えない。 */
const INSTRUMENTATION_DEPS = [
  '@opentelemetry/api',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/resources',
  '@opentelemetry/instrumentation',
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/instrumentation-pg',
];

/** 実測で成立を確認した Next のメジャー。これ以外は「未検証」と書く。 */
const VERIFIED_NEXT_MAJORS = [15, 16];
/** App Router が存在しない世代 */
const MIN_NEXT_MAJOR = 13;

/* これらの参照先は、利用者が入力したプロジェクトのパスである。静的には決まらない。
 * Turbopack は「プロジェクト全体が追跡対象になる」と警告するが、ここで見たいのは
 * **IDE の外のディレクトリ**であって、バンドルに含めたいものではない。
 * したがって追跡から除外する（警告の指示どおりの対処）。
 *
 * **ただし 3 件は消えない。** `exists()` が呼び出し側へ展開されるため、
 * 注釈が効かない箇所が残る（`hasRouterEntry` / lockfile / next.config の判定）。
 * 残る警告は出力の追跡範囲（配布物の大きさ）についてのものであり、
 * ローカルで動かす IDE には当たらない。ビルドは成功する。 */
const exists = (p: string): boolean => {
  try { return fs.existsSync(/* turbopackIgnore: true */ p); } catch { return false; }
};
const isDir = (p: string): boolean => {
  try { return fs.statSync(/* turbopackIgnore: true */ p).isDirectory(); } catch { return false; }
};

function hasRouterEntry(dir: string): boolean {
  for (const b of ENTRY_BASENAMES) {
    for (const e of ENTRY_EXTS) if (exists(path.join(dir, `${b}.${e}`))) return true;
  }
  return false;
}

/** `~` を展開する。相対パスは展開しない（どこ基準かが決まらないため） */
export function normalizeInput(input: string): { root: string | null; code?: string } {
  const raw = (input ?? '').trim();
  if (!raw) return { root: null, code: 'path-empty' };
  if (raw.includes('\0')) return { root: null, code: 'path-invalid' };
  let p = raw;
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) return { root: null, code: 'path-not-absolute' };
  return { root: path.normalize(p).replace(/\/+$/, '') || '/' };
}

/** 既に走っている開発サーバーの検出。Next 16 の `.next/dev/lock` を読む。 */
async function detectExistingDevServer(root: string): Promise<ExistingDevServer | null> {
  const lock = path.join(root, '.next', 'dev', 'lock');
  if (!exists(lock)) return null;
  let o: { pid?: number; port?: number; appUrl?: string };
  try { o = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { return null; }
  if (typeof o.pid !== 'number' || !pidAlive(o.pid)) return null;
  const command = await pidCommand(o.pid);
  // PID の再利用を外す。next のプロセスでなければ、記録が古いだけである
  if (command && !/next/i.test(command)) return null;
  return {
    pid: o.pid,
    port: typeof o.port === 'number' ? o.port : null,
    appUrl: typeof o.appUrl === 'string' ? o.appUrl : null,
    source: 'next-dev-lock',
    command,
  };
}

/** 計装が使えるか。**依存が解決できないことを「計装失敗」と書かない**（ST-25） */
export function checkInstrumentation(): InstrumentationAvailability {
  const boot = instrumentationBootPath();
  if (!exists(boot)) {
    return {
      available: false, boot: null, missing: [],
      reason: `計装の入口が見つかりません（${boot}）`,
    };
  }
  const req = createRequire(boot);
  const missing = INSTRUMENTATION_DEPS.filter((d) => {
    try { req.resolve(d); return false; } catch { return true; }
  });
  if (missing.length) {
    return {
      available: false, boot, missing,
      reason: `計装の依存が IDE 側に入っていません（${missing.join(' / ')}）`,
    };
  }
  return { available: true, boot, missing: [], reason: null };
}

/* -------------------------------------------------------------- 所見の文言 */

const F = {
  pathEmpty: (): Finding => ({
    code: 'path-empty', severity: 'blocker',
    fact: 'プロジェクトのパスが入力されていません。',
    reason: '入力が空です。',
    impact: 'プロジェクトを検出できないため、構成の判定も起動もできません。',
    action: '解析したい Next.js プロジェクトの絶対パスを入力してください。',
  }),
  pathNotAbsolute: (input: string): Finding => ({
    code: 'path-not-absolute', severity: 'blocker',
    fact: `入力されたパスは絶対パスではありません（${input}）。`,
    reason: 'IDE はブラウザ上で動くため、相対パスの基準になる作業ディレクトリを利用者と共有できません。',
    impact: 'どのディレクトリを指しているか確定できないため、検出を行いません。',
    action: '/ から始まる絶対パス（または ~ から始まるパス）で入力してください。',
  }),
  pathInvalid: (): Finding => ({
    code: 'path-invalid', severity: 'blocker',
    fact: 'パスに使用できない文字が含まれています。',
    reason: 'NUL 文字が含まれています。',
    impact: 'パスを解釈できないため、検出を行いません。',
    action: null,
  }),
  pathNotFound: (root: string): Finding => ({
    code: 'path-not-found', severity: 'blocker',
    fact: `指定されたパスが存在しません（${root}）。`,
    reason: 'そのパスにファイルもディレクトリもありません。',
    impact: 'プロジェクトの構成は判定できません。',
    action: 'パスを確認して入力し直してください。',
  }),
  pathNotDirectory: (root: string): Finding => ({
    code: 'path-not-directory', severity: 'blocker',
    fact: `指定されたパスはディレクトリではありません（${root}）。`,
    reason: 'ファイルを指しています。',
    impact: 'プロジェクトルートとして扱えないため、構成は判定できません。',
    action: 'プロジェクトのルートディレクトリを指定してください。',
  }),
  pathUnreadable: (root: string, detail: string): Finding => ({
    code: 'path-unreadable', severity: 'blocker',
    fact: `指定されたディレクトリを読めません（${root}）。`,
    reason: detail,
    impact: '構成を判定できません。',
    action: 'ディレクトリの権限を確認してください。',
  }),
  noPackageJson: (): Finding => ({
    code: 'no-package-json', severity: 'blocker',
    fact: 'package.json がありません。',
    reason: 'プロジェクトルートに package.json が見つかりません。',
    impact: 'フレームワークと依存関係を判定できないため、対応可否を決められません。',
    action: 'Next.js プロジェクトのルート（package.json がある階層）を指定してください。',
  }),
  invalidPackageJson: (detail: string): Finding => ({
    code: 'invalid-package-json', severity: 'blocker',
    fact: 'package.json を読めません。',
    reason: detail,
    impact: '依存関係を判定できないため、対応可否を決められません。',
    action: 'package.json の内容を確認してください。',
  }),
  nextNotDeclared: (): Finding => ({
    code: 'next-not-declared', severity: 'blocker',
    fact: 'package.json の依存関係に next がありません。',
    reason: 'dependencies / devDependencies のどちらにも next が宣言されていません。',
    impact: 'Next.js プロジェクトとして扱えません。この IDE は Next.js の App Router のみを対象にしています。',
    action: null,
  }),
  nextNotInstalled: (): Finding => ({
    code: 'next-not-installed', severity: 'blocker',
    fact: 'next は宣言されていますが、node_modules にインストールされていません。',
    reason: 'node_modules/next/dist/bin/next が見つかりません。',
    impact: '起動する実体が無いため、開発サーバーを起動できません。',
    action: 'プロジェクトで依存関係をインストール（npm install など）してから、もう一度検出してください。',
  }),
  nextTooOld: (v: string): Finding => ({
    code: 'next-version-unsupported', severity: 'blocker',
    fact: `インストールされている Next.js のバージョンが ${v} です。`,
    reason: `App Router は Next.js ${MIN_NEXT_MAJOR} 以降の機能です。`,
    impact: 'App Router を前提とした観測ができないため、対応していません。',
    action: null,
  }),
  nextUnverified: (v: string): Finding => ({
    code: 'next-version-unverified', severity: 'limit',
    fact: `インストールされている Next.js のバージョンが ${v} です。`,
    reason: `実測で成立を確認したのは ${VERIFIED_NEXT_MAJORS.join(' / ')} 系だけです。この世代では検証していません。`,
    impact: '起動は試せますが、起動できること・計装が効くことを保証できません。',
    action: '起動して結果を確認してください。失敗した場合は、出力に理由が出ます。',
  }),
  appRouterMissing: (): Finding => ({
    code: 'app-router-not-found', severity: 'blocker',
    fact: 'App Router のディレクトリ（app/ または src/app/）が見つかりません。',
    reason: 'layout / page のいずれも置かれていません。',
    impact: 'この IDE が観測できるのは App Router の構成だけです。対応していません。',
    action: null,
  }),
  pagesOnly: (dir: string): Finding => ({
    code: 'pages-router-only', severity: 'blocker',
    fact: `Pages Router（${dir}）だけが見つかりました。`,
    reason: 'App Router のディレクトリ（app/ または src/app/）がありません。',
    impact: 'Pages Router は未対応です。要素とコンポーネント・取得の対応づけは、App Router の構成で検証しています。',
    action: null,
  }),
  routerAmbiguous: (): Finding => ({
    code: 'app-router-ambiguous', severity: 'blocker',
    fact: 'app/ と src/app/ の両方に App Router の入口があります。',
    reason: 'Next.js はどちらか一方しか使いません。どちらが有効かをこの検出では決められません。',
    impact: 'どのディレクトリを解析対象にすべきか確定できないため、対応していません。',
    action: '使っていない方のディレクトリを整理してから、もう一度検出してください。',
  }),
  pagesAlso: (dir: string): Finding => ({
    code: 'pages-router-present', severity: 'limit',
    fact: `App Router に加えて Pages Router（${dir}）もあります。`,
    reason: '両方のルーターが同居しています。',
    impact: 'Pages Router 側のページは観測の対象外です。App Router のページだけが見えます。',
    action: null,
  }),
  devScriptNotUsed: (script: string): Finding => ({
    code: 'dev-script-not-used', severity: 'info',
    fact: `package.json の dev スクリプトは「${script}」です。`,
    reason: 'IDE はこのスクリプトを実行せず、node_modules の next を直接起動します（任意のシェルコマンドを実行しないため）。',
    impact: 'dev スクリプトに書かれた追加の処理（環境変数の設定・前処理など）は実行されません。',
    action: null,
  }),
  noDevScript: (): Finding => ({
    code: 'dev-script-absent', severity: 'info',
    fact: 'package.json に dev スクリプトがありません。',
    reason: '宣言されていません。',
    impact: '起動には影響しません。IDE は node_modules の next を直接起動します。',
    action: null,
  }),
  instrumentationUnavailable: (reason: string): Finding => ({
    code: 'instrumentation-unavailable', severity: 'limit',
    fact: '計装（方式2）を適用できません。',
    reason,
    impact: 'サーバー内部の処理と実行された SQL は観測できません。起動と停止、HTTP の応答確認は行えます。',
    action: '計装なしで起動できます。観測が必要な場合は IDE 側の計装の依存を用意してください。',
  }),
  alreadyRunning: (s: ExistingDevServer): Finding => ({
    code: 'another-dev-server-running', severity: 'limit',
    fact: `このプロジェクトの開発サーバーが既に起動しています（PID ${s.pid}${s.port ? ` / ポート ${s.port}` : ''}）。`,
    reason: 'Next.js は1つのプロジェクトに対して1つの開発サーバーしか起動しません。このプロセスは IDE が起動したものではありません。',
    impact: '外部で起動されたプロセスには計装が適用されないため、サーバー内部の処理と SQL は観測できません（INS-08）。',
    action: '外部のサーバーを停止してから、IDE から起動し直してください。',
  }),
} as const;

/* ------------------------------------------------------------------ 本体 */

function readJson(p: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      value: JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ p, 'utf8')) as Record<string, unknown>,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function empty(input: string, finding: Finding): ProjectInspection {
  return {
    input, root: null, name: null, verdict: finding.code.startsWith('path-') ? 'invalid' : 'unsupported',
    next: { declared: null, installed: null, major: null, binPath: null },
    router: { kind: 'none', appDir: null, pagesDir: null },
    packageManager: null, devScript: null, nodeModulesInstalled: false, nextConfig: null,
    existingDevServer: null,
    instrumentation: { available: false, reason: null, boot: null, missing: [] },
    findings: [finding], checkedAt: new Date().toISOString(),
  };
}

/**
 * プロジェクトを検出する。**例外を投げない** — 判定できなかったことも所見として返す。
 * ER-06 により、上流の原因が1つ確定した時点で下流は見に行かない。
 */
export async function inspectProject(input: string): Promise<ProjectInspection> {
  const norm = normalizeInput(input);
  if (!norm.root) {
    if (norm.code === 'path-empty') return empty(input, F.pathEmpty());
    if (norm.code === 'path-not-absolute') return empty(input, F.pathNotAbsolute(input.trim()));
    return empty(input, F.pathInvalid());
  }
  const root = norm.root;

  let stat: fs.Stats;
  try { stat = fs.statSync(/* turbopackIgnore: true */ root); } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return empty(input, F.pathNotFound(root));
    return empty(input, F.pathUnreadable(root, err.message));
  }
  if (!stat.isDirectory()) return empty(input, F.pathNotDirectory(root));
  try { fs.accessSync(root, fs.constants.R_OK); } catch (e) {
    return empty(input, F.pathUnreadable(root, (e as Error).message));
  }

  const pkgPath = path.join(root, 'package.json');
  if (!exists(pkgPath)) return empty(input, F.noPackageJson());
  const pkgRead = readJson(pkgPath);
  if (!pkgRead.ok) return empty(input, F.invalidPackageJson(pkgRead.error));
  const pkg = pkgRead.value;

  const deps = { ...(pkg.dependencies as Record<string, string> ?? {}) };
  const devDeps = { ...(pkg.devDependencies as Record<string, string> ?? {}) };
  const declared = deps.next ?? devDeps.next ?? null;
  const name = typeof pkg.name === 'string' ? pkg.name : path.basename(root);
  const scripts = (pkg.scripts as Record<string, string> ?? {});
  const devScript = typeof scripts.dev === 'string' ? scripts.dev : null;

  const packageManager = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json']
    .find((f) => exists(path.join(root, f)))
    ?.replace('pnpm-lock.yaml', 'pnpm').replace('yarn.lock', 'yarn')
    .replace('bun.lockb', 'bun').replace('bun.lock', 'bun')
    .replace('package-lock.json', 'npm') ?? null;
  const nextConfig = ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']
    .find((f) => exists(path.join(root, f))) ?? null;

  const base: ProjectInspection = {
    input, root, name, verdict: 'unsupported',
    next: { declared, installed: null, major: null, binPath: null },
    router: { kind: 'none', appDir: null, pagesDir: null },
    packageManager, devScript, nodeModulesInstalled: false, nextConfig,
    existingDevServer: null,
    instrumentation: { available: false, reason: null, boot: null, missing: [] },
    findings: [], checkedAt: new Date().toISOString(),
  };

  if (!declared) return { ...base, findings: [F.nextNotDeclared()] };

  // 起動する実体。dev スクリプトではなく、この実体を直接起動する（指示 2.E）
  const binPath = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!exists(binPath)) return { ...base, findings: [F.nextNotInstalled()] };
  base.nodeModulesInstalled = true;
  base.next.binPath = binPath;

  const installedPkg = readJson(path.join(root, 'node_modules', 'next', 'package.json'));
  const installed = installedPkg.ok && typeof installedPkg.value.version === 'string'
    ? installedPkg.value.version : null;
  const major = installed ? Number(installed.split('.')[0]) : null;
  base.next.installed = installed;
  base.next.major = Number.isFinite(major) ? major : null;

  if (base.next.major !== null && base.next.major < MIN_NEXT_MAJOR) {
    return { ...base, findings: [F.nextTooOld(installed ?? '不明')] };
  }

  /* ---------------------------------------------------------- ルーターの判定 */
  const appCandidates = [
    { rel: 'app', abs: path.join(root, 'app') },
    { rel: 'src/app', abs: path.join(root, 'src', 'app') },
  ].filter((c) => isDir(c.abs) && hasRouterEntry(c.abs));
  const pagesCandidate = [
    { rel: 'pages', abs: path.join(root, 'pages') },
    { rel: 'src/pages', abs: path.join(root, 'src', 'pages') },
  ].find((c) => isDir(c.abs));

  if (appCandidates.length > 1) return { ...base, findings: [F.routerAmbiguous()] };
  if (appCandidates.length === 0) {
    if (pagesCandidate) return { ...base, findings: [F.pagesOnly(pagesCandidate.rel)] };
    return { ...base, findings: [F.appRouterMissing()] };
  }

  base.router = {
    kind: pagesCandidate ? 'both' : 'app',
    appDir: appCandidates[0].rel,
    pagesDir: pagesCandidate?.rel ?? null,
  };

  /* ------------------------------------------------- ここから先は起動できる */
  const findings: Finding[] = [];
  if (base.next.major !== null && !VERIFIED_NEXT_MAJORS.includes(base.next.major)) {
    findings.push(F.nextUnverified(installed ?? '不明'));
  }
  if (pagesCandidate) findings.push(F.pagesAlso(pagesCandidate.rel));

  const ins = checkInstrumentation();
  base.instrumentation = ins;
  if (!ins.available) findings.push(F.instrumentationUnavailable(ins.reason ?? '理由を特定できません。'));

  const existing = await detectExistingDevServer(root);
  base.existingDevServer = existing;
  if (existing) findings.push(F.alreadyRunning(existing));

  if (devScript) findings.push(F.devScriptNotUsed(devScript));
  else findings.push(F.noDevScript());

  const verdict: Verdict = findings.some((f) => f.severity === 'limit') ? 'partial' : 'supported';
  return { ...base, verdict, findings };
}

/** 起動してよい構成か。`unsupported` / `invalid` では起動を試さない。 */
export const isStartable = (i: ProjectInspection): boolean =>
  (i.verdict === 'supported' || i.verdict === 'partial') && !!i.root && !!i.next.binPath;
