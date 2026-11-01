/* =============================================================================
 * ブラウザへ返す文字列から、秘密情報らしきものを落とす（指示 2.E）。
 *
 * **これは保証ではない。** 「鍵らしい名前の代入」と「資格情報つき URL」という
 * 2つの形だけを落とす、最小限の措置である。環境変数そのものは API で返さない。
 * ========================================================================== */

/**
 * 鍵らしい名前への代入（KEY= / SECRET: / TOKEN= など）。
 * 大文字小文字を問わない。`monkey=1` のような**落としすぎ**は起こるが、
 * 秘密が出るより落としすぎるほうを選ぶ。
 */
const ASSIGN = /\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DSN)[A-Za-z0-9_]*)(\s*[=:]\s*)(\S+)/gi;
/** 資格情報つきの URL（postgres://user:pass@host など） */
const URL_CREDS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/g;

export function redact(line: string): string {
  return line
    .replace(ASSIGN, (_m, k: string, sep: string) => `${k}${sep}[秘匿]`)
    .replace(URL_CREDS, (_m, scheme: string) => `${scheme}[秘匿]@`);
}

export const redactAll = (lines: readonly string[]): string[] => lines.map(redact);
