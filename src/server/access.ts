/* =============================================================================
 * どのホスト名からの接続を受け付けるか（Phase 7B-1）。
 *
 * IDE の API と、プレビューの中継（previewGateway.ts）が使う。
 *
 * 既定は **ループバックだけ**（Phase 7A と同じ）。クラウドの開発環境（Codespaces など）では
 * ブラウザは転送用の URL（例: https://<名前>-3100.app.github.dev）で来るため、Host が
 * ループバックにならない。そのときは **IDE を起動する人が、IDE の環境変数で、ホスト名を
 * 1つずつ明示する。** ワイルドカードは受け付けない。画面や API からは変えられない。
 *
 *   VCIDE_ALLOWED_HOSTS   IDE の画面・API に来てよいホスト名（カンマ区切り。host または host:port）
 *                         `codespaces` と書くと、Codespaces の環境変数から IDE のポートの
 *                         転送ホスト名を1つだけ組み立てる
 *   VCIDE_PREVIEW_ORIGIN  ブラウザから見たプレビューの中継の URL（例: https://<名前>-3150.app.github.dev）
 *   VCIDE_PREVIEW_PORT    中継が待ち受けるポート（既定 3150。使えなければ 3151〜3170 を探す。
 *                         明示した場合と、公開 URL がポートに依存する場合は探さない）
 *
 * これは**アクセス制御の代わりではない。** 転送 URL を誰が開けるかは、転送する側
 * （Codespaces なら「ポートの公開範囲」が Private であること）が決める。
 * ========================================================================== */

export const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export const DEFAULT_PREVIEW_PORT = 3150;
export const PREVIEW_PORT_SCAN = 20;

export interface AccessConfig {
  /** ループバック以外で、IDE に来てよいホスト（小文字。host または host:port） */
  ideHosts: string[];
  /** ブラウザから見たプレビューの中継の origin。ループバックで使うときは不要 */
  previewPublicOrigin: string | null;
  previewPort: number;
  /** ポートを探してよいか。明示した場合・公開 URL がポートに依存する場合は探さない */
  previewPortFixed: boolean;
  /** 設定の誤り。黙って無視せず、画面に出す */
  problems: string[];
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** Host ヘッダからホスト名を取り出す（IPv6 の [::1]:3100 を含む） */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

export const isLoopbackHost = (hostHeader: string): boolean =>
  LOOPBACK_HOSTNAMES.has(hostnameOf(hostHeader));

/** 明示されたホスト一覧に一致するか。ポートつきの指定は完全一致、ポート無しはホスト名で比べる */
export function matchesHostList(hostHeader: string, list: readonly string[]): boolean {
  const h = hostHeader.trim().toLowerCase();
  const name = hostnameOf(h);
  return list.some((e) => (e.includes(':') ? e === h : e === name));
}

export function accessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const problems: string[] = [];
  const ideHosts: string[] = [];
  let previewPublicOrigin: string | null = null;

  /* ---------------------------------------------------------- 中継のポート */
  let previewPort = DEFAULT_PREVIEW_PORT;
  let previewPortFixed = false;
  if (env.VCIDE_PREVIEW_PORT) {
    const n = Number(env.VCIDE_PREVIEW_PORT);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) { previewPort = n; previewPortFixed = true; }
    else problems.push(`VCIDE_PREVIEW_PORT「${env.VCIDE_PREVIEW_PORT}」は 1024〜65535 の整数ではないため使いません。`);
  }

  /* -------------------------------------------------------- 許可するホスト */
  const entries = (env.VCIDE_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const e of entries) {
    if (e === 'codespaces') {
      const name = env.CODESPACE_NAME;
      const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
      if (!name || !domain) {
        problems.push('VCIDE_ALLOWED_HOSTS に codespaces とありますが、CODESPACE_NAME / GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN がありません。');
        continue;
      }
      const idePort = Number(env.PORT) || 3100;
      ideHosts.push(`${name}-${idePort}.${domain}`.toLowerCase());
      if (!env.VCIDE_PREVIEW_ORIGIN) {
        previewPublicOrigin = `https://${name}-${previewPort}.${domain}`.toLowerCase();
        previewPortFixed = true;          // 公開 URL がポート番号を含むため、ポートを探さない
      }
      continue;
    }
    if (e.includes('*')) { problems.push(`「${e}」: ワイルドカードは受け付けません。ホスト名を1つずつ書いてください。`); continue; }
    if (!HOST_RE.test(e)) { problems.push(`「${e}」はホスト名として解釈できないため使いません。`); continue; }
    if (LOOPBACK_HOSTNAMES.has(hostnameOf(e))) continue;   // 既定で許可している
    ideHosts.push(e);
  }

  /* ------------------------------------------------ ブラウザから見た中継の URL */
  if (env.VCIDE_PREVIEW_ORIGIN) {
    try {
      const u = new URL(env.VCIDE_PREVIEW_ORIGIN);
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
        throw new Error('origin ではない');
      }
      previewPublicOrigin = u.origin;
    } catch {
      problems.push(`VCIDE_PREVIEW_ORIGIN「${env.VCIDE_PREVIEW_ORIGIN}」は http(s)://ホスト[:ポート] の形ではないため使いません。`);
    }
  }

  return { ideHosts, previewPublicOrigin, previewPort, previewPortFixed, problems };
}

/** IDE の画面・API に来てよい Host か */
export function isAllowedIdeHost(hostHeader: string, cfg: AccessConfig): boolean {
  return isLoopbackHost(hostHeader) || matchesHostList(hostHeader, cfg.ideHosts);
}

/** プレビューの中継に来てよい Host か（ループバックか、公開 URL のホスト） */
export function isAllowedPreviewHost(hostHeader: string, cfg: AccessConfig): boolean {
  if (isLoopbackHost(hostHeader)) return true;
  if (!cfg.previewPublicOrigin) return false;
  const u = new URL(cfg.previewPublicOrigin);
  return matchesHostList(hostHeader, [u.host]);
}

/**
 * プレビューを埋め込んでよい親（IDE の画面）の origin。CSP の frame-ancestors に使う。
 * ループバックの IDE はポートを問わない（IDE のポートは IDE を起動した人が決める）。
 */
export function ideFrameAncestors(cfg: AccessConfig): string[] {
  // IPv6 の [::1] は CSP の host-source に書けない（Chrome が拒否し、警告を出す）。ループバックの IPv6 で開いた IDE は埋め込めない
  const out = ['http://127.0.0.1:*', 'http://localhost:*'];
  for (const h of cfg.ideHosts) out.push(`https://${h}`, `http://${h}`);
  return out;
}

/** 中継の ping に CORS で答えてよい相手（IDE の画面の origin）か */
export function isIdeOrigin(origin: string, cfg: AccessConfig): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isAllowedIdeHost(u.host, cfg);
  } catch { return false; }
}
