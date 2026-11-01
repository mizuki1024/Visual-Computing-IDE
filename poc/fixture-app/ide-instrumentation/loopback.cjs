/* =============================================================================
 * 「この宛先はこの開発機の中か」の判定。
 *
 * PoC-02 Gate A の伝播は、**ここが真を返す宛先に対してだけ**行う。
 * トレースコンテキスト（traceparent）は開発用の識別子であり、
 * 隔離した検証用サービスの間から外へ出してはならない（指示 第2節・第6節）。
 *
 * 計装本体（otel.cjs）とテストの両方がこの1つの関数を使う。
 * 判定を2箇所に書かないため、独立したファイルにしてある。
 * ========================================================================== */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * @param {string} origin  'http://127.0.0.1:3300' のような文字列
 * @returns {boolean} ループバック宛なら true。解釈できなければ false（＝伝播しない）
 */
function isLoopbackOrigin(origin) {
  try {
    const h = new URL(String(origin)).hostname;
    return LOOPBACK_HOSTS.has(h);
  } catch {
    return false;
  }
}

module.exports = { isLoopbackOrigin, LOOPBACK_HOSTS };
