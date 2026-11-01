/* =============================================================================
 * プロセス管理 API の入口の防御（Phase 7A 指示 2.E）。
 *
 * この API はローカルの開発サーバーを起動・停止できる。したがって
 *   1. ループバック以外のホスト名で来た要求を通さない（外部ネットワーク対策）
 *   2. 別オリジンからの操作を通さない（CSRF 対策）
 *   3. 変更操作は POST + JSON + 独自ヘッダを要求する
 *      （独自ヘッダは単純要求にならないため、必ず事前検査が走る）
 * を満たす。**任意のコマンドを受け取る口は作らない** — 起動対象は
 * 検出済みプロジェクトの node_modules の next に限られる（devServer.ts）。
 *
 * Phase 7B-1: クラウドの転送 URL（Codespaces など）で使えるよう、1 の「ループバック」に
 * **IDE を起動した人が環境変数で明示したホスト名**を足せるようにした（access.ts）。
 * 2 と 3 は変えていない。Origin は Host と完全に一致しなければならない。
 * ========================================================================== */
import { accessConfig, isAllowedIdeHost, type AccessConfig } from './access';

/** 変更操作に必要な独自ヘッダ。値は問わない（存在が事前検査を強制する） */
export const REQUEST_HEADER = 'x-vcide-request';

export interface GuardFailure { status: number; code: string; message: string }

/** 通してよければ null。駄目なら理由を返す。 */
export function guardRequest(
  req: Request, { mutating }: { mutating: boolean }, cfg: AccessConfig = accessConfig(),
): GuardFailure | null {
  const host = req.headers.get('host');
  if (!host || !isAllowedIdeHost(host, cfg)) {
    return {
      status: 403, code: 'non-local-host',
      message: 'このAPIはローカルからのみ使用できます（Host がループバックでも、IDE の起動時に許可したホスト名でもありません）。',
    };
  }

  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return {
      status: 403, code: 'cross-site',
      message: 'このAPIは同一オリジンからのみ使用できます。',
    };
  }

  const origin = req.headers.get('origin');
  if (origin) {
    let u: URL;
    try { u = new URL(origin); } catch {
      return { status: 403, code: 'bad-origin', message: 'Origin を解釈できません。' };
    }
    if (u.host !== host.trim().toLowerCase() || !isAllowedIdeHost(u.host, cfg)) {
      return {
        status: 403, code: 'cross-origin',
        message: 'このAPIは同一オリジンからのみ使用できます。',
      };
    }
  }

  if (mutating) {
    if (req.method !== 'POST') {
      return { status: 405, code: 'method-not-allowed', message: 'POST のみ受け付けます。' };
    }
    const ct = req.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('application/json')) {
      return {
        status: 415, code: 'unsupported-media-type',
        message: 'Content-Type: application/json のみ受け付けます。',
      };
    }
    if (!req.headers.get(REQUEST_HEADER)) {
      return {
        status: 403, code: 'missing-request-header',
        message: `${REQUEST_HEADER} ヘッダのない要求は受け付けません。`,
      };
    }
  }
  return null;
}
