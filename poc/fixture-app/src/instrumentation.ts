/* =============================================================================
 * 方式1 の入口。Next.js が起動時に register() を1度だけ呼ぶ。
 * IDE が生成する補助ファイルであり、アプリのロジックには手を入れていない
 * （01b Q-01.0 の解釈 (a) 非改変）。
 *
 * 計装の本体はここから「バンドラに追跡させない形で」読み込む。
 *   * webpack はこのファイルの依存を辿ってバンドルしようとし、`http` などの
 *     Node 組み込みを解決できずに失敗する（実測。PoC-01 の記録）
 *   * バンドルされた複製に対して require フックを張っても、アプリが使う
 *     本物のモジュールには当たらない恐れがある（Q-01 C-4 / UR-02）
 * そのため実行時の素の require を使い、計装だけはバンドルの外に置く。
 * ========================================================================== */
export async function register() {
  if (process.env.POC01_MODE === 'method2') return;   // 方式2 と二重に初期化しない
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;  // Edge では計装できない（Q-01 C-3）
  const runtimeRequire = eval('require') as (id: string) => unknown;
  runtimeRequire(`${process.cwd()}/ide-instrumentation/otel.cjs`);
}
