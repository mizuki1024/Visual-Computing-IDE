/* =============================================================================
 * 探索キャンバスの試験の「前提状態」をそろえる（Phase 7B-2）。
 *
 * 問題（Phase 7A から残っていた）
 *   同じ IDE のプロセスで一度でも開発サーバーを起動・停止すると、サーバーは直近の検出結果と
 *   実行の記録を返し続ける（7A の設計: 画面を開き直しても状態を戻す）。すると右上の
 *   「プロジェクトと実行」パネルが所見の分だけ縦に伸び（実測 約 814px）、キャンバスの
 *   サーバー処理・SQL・テーブル・カラムのノードを覆う。座標でクリックする試験は、
 *   **新しく起動した IDE でだけ**通っていた。
 *
 * やること
 *   ページを開くたびに、そのパネルを**利用者と同じ操作（パネルの ✕）で閉じる**。
 *   探索の試験はキャンバスと右ドックを確かめるものであり、パネルの中身は確かめていない。
 *   閉じれば、IDE のサーバー側の履歴（未起動 / 起動・停止の後）に関わらず同じ前提になる。
 *   画面の配置は変えていない。
 *
 * 使い方: `installCanvasPrecondition(page)` を newPage の直後に1回呼ぶ（page.goto を包む）。
 * ========================================================================== */
export const RUNTIME_PANEL = 'section.fpnl[aria-label="プロジェクトと実行"]';

/** 開いていれば閉じる。閉じたかどうかを返す */
export async function closeRuntimePanel(page) {
  const btn = page.getByRole('button', { name: 'プロジェクトと実行を閉じる' });
  if (!(await btn.count())) return false;
  // 画面が水和（hydration）される前のボタンは押しても何も起きない。閉じたことを確かめるまで押し直す
  for (let i = 0; i < 40; i++) {
    await btn.click({ timeout: 5000 }).catch(() => {});
    const gone = await page.locator(RUNTIME_PANEL).waitFor({ state: 'detached', timeout: 250 }).then(() => true, () => false);
    if (gone) return true;
  }
  throw new Error('「プロジェクトと実行」パネルを閉じられませんでした');
}

export function installCanvasPrecondition(page) {
  const goto = page.goto.bind(page);
  const log = [];
  page.goto = async (...args) => {
    const r = await goto(...args);
    log.push(await closeRuntimePanel(page));
    return r;
  };
  return log;
}

/**
 * N0（上端のバー）が何を出しているか。
 *   'recorded' … 描いているデータセットの記録（IDE がまだ開発サーバーを扱っていない）
 *   'live'     … IDE が扱った開発サーバーの実際の状態（Phase 7A の設計。起動・停止の後はこちら）
 * 記録の計装方式・ポートは、'live' のときもキャンバスの常時の注記と層のラベルに出ている。
 */
export async function n0Shows(page) {
  const t = await page.locator('header.n0').innerText();
  return t.includes('記録') ? 'recorded' : 'live';
}
