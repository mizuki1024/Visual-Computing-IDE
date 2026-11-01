/* =============================================================================
 * IDE 本体の場所と、IDE が自分のために使う作業ディレクトリ。
 *
 * **対象プロジェクトの中には何も置かない**（Phase 7A 指示 2.B / E）。
 * 起動の記録・収集物は、すべて IDE 側の `.ide-runtime/` に書く。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

/** package.json の name。これで IDE 本体のルートを同定する。 */
const IDE_PACKAGE_NAME = 'visual-computing-ide';

let cached: string | null = null;

/**
 * IDE 本体のルート。
 * Next は（dev / start のどちらでも）プロジェクトルートを cwd にして走るので、
 * cwd から上へ `package.json` を探す。**推測で `__dirname` を使わない** —
 * ルートハンドラはバンドルされるため、`__dirname` は .next の中を指す。
 */
export function ideRoot(): string {
  if (cached) return cached;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p)) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string };
        if (j.name === IDE_PACKAGE_NAME) { cached = dir; return dir; }
      } catch { /* 読めない package.json は無視して上へ */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `IDE 本体のルートを特定できませんでした（cwd=${process.cwd()} から ${IDE_PACKAGE_NAME} の package.json が見つかりません）`,
  );
}

/** IDE の作業ディレクトリ。.gitignore 済み。 */
export function runtimeDir(): string {
  const d = path.join(ideRoot(), '.ide-runtime');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 起動した開発サーバーの所有記録。IDE の再起動をまたいで引き継ぐための唯一の台帳。 */
export const stateFilePath = (): string => path.join(runtimeDir(), 'dev-server.json');

/** 計装の収集先。対象プロジェクトではなく IDE 側に書く。 */
export const spanDirPath = (): string => path.join(runtimeDir(), 'spans');

/**
 * 計装の入口（PoC-01 方式2）。**新しい計装は作らない** — PoC-01 が検証した
 * `ide-instrumentation/boot.cjs` を絶対パスで前置するだけである（指示 2.B）。
 * この束は IDE 側に在り、対象プロジェクトには1バイトも置かない。
 * 依存（@opentelemetry/*）は束の隣の node_modules から解決される。
 */
export const instrumentationBootPath = (): string =>
  path.join(ideRoot(), 'poc', 'fixture-app', 'ide-instrumentation', 'boot.cjs');
