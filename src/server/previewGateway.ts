/* =============================================================================
 * プレビューの中継（Phase 7B-1）。
 *
 * IDE が起動した開発サーバーのページを、**IDE とは別の origin（別ポート）**から
 * ブラウザに渡す。既存のプレビューパネルは、この中継の URL を iframe で開く。
 *
 * なぜ中継が要るか
 *   クラウドの開発環境では、ブラウザの localhost とサーバーの localhost が違う。
 *   iframe に http://127.0.0.1:3000 を書いても、ブラウザは自分の機械の 3000 番を見に行く。
 *   ブラウザから届くのは、転送される IDE 側のポートだけである。
 *
 * なぜ IDE と同じ origin にしないか
 *   1. 対象のアプリは `/_next/...` `/api/...` をルート相対で参照する。IDE 自身も Next なので
 *      パスの前置き（/preview/...）で同居させると衝突し、HTML の書き換えが必要になる
 *   2. 同じ origin で動かすと、プレビューの中のスクリプトが IDE の API（起動・停止）を
 *      同一オリジンとして呼べてしまう。別 origin なら guard.ts の Origin 検査で止まる
 *
 * 守っていること
 *   - **転送先は1つだけ。** IDE が起動し、HTTP の応答を確かめた開発サーバー（127.0.0.1:<そのポート>）。
 *     要求の URL・Host・ヘッダから転送先を決めない。絶対形式の要求（GET http://… / CONNECT）は拒否する
 *   - 待ち受けはループバックだけ。Host はループバックか、明示した公開ホストだけ（DNS リバインディング対策）
 *   - 開発サーバーが実行中でなければ転送しない（IDE が作った説明のページを返す）
 *   - IDE の画面以外から埋め込まれないよう、CSP の frame-ancestors を足す
 *   - 転送元の情報（X-Forwarded-*）や中継の資格情報（Proxy-Authorization）を転送先へ渡さない
 * ========================================================================== */
import http from 'node:http';
import net from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
import {
  ideFrameAncestors, isAllowedPreviewHost, isIdeOrigin, type AccessConfig,
} from './access';

/** 中継が自分で答えるパス。対象のアプリのパスと重ならない名前にする */
export const AGENT_PREFIX = '/__vcide_preview/';

export type GatewayState = 'idle' | 'listening' | 'unavailable';

export interface GatewayInfo {
  state: GatewayState;
  port: number | null;
  /** 待ち受けできなかった理由など */
  reason: string | null;
}

export interface GatewayTarget {
  port: number;
}

export interface GatewayOptions {
  config: AccessConfig;
  /** 転送先。実行中でなければ null と、その理由 */
  target: () => { target: GatewayTarget | null; reason: string };
  /** テスト用。省略時は config.previewPort から探す */
  port?: number;
}

/* --------------------------------------------------------------- 埋め込む部品 */

/**
 * プレビューのページから IDE の画面へ、いまの場所を知らせる小さなスクリプト。
 * 中継の origin から配る（インラインにしない。対象のアプリの CSP が 'self' を許すなら動く）。
 * 送るのはパス・タイトル・最初の文書の HTTP 状態だけで、DOM の中身は送らない。
 */
export const AGENT_JS = `(function(){
  if (window.__vcidePreviewAgent) return; window.__vcidePreviewAgent = 1;
  var s = document.currentScript, st = s && s.getAttribute('data-vcide-status');
  var status = st ? Number(st) : null, soft = false;
  var from = (s && s.getAttribute('data-vcide-from')) || 'app';
  function send(kind){
    try {
      parent.postMessage({ source: 'vcide-preview', v: 1, kind: kind,
        path: location.pathname + location.search + location.hash,
        title: document.title || '', status: soft ? null : status, soft: soft, from: from }, '*');
    } catch (e) {}
  }
  var ps = history.pushState, rs = history.replaceState;
  history.pushState = function(){ var r = ps.apply(this, arguments); soft = true; send('navigate'); return r; };
  history.replaceState = function(){ var r = rs.apply(this, arguments); send('replace'); return r; };
  addEventListener('popstate', function(){ soft = true; send('navigate'); });
  addEventListener('hashchange', function(){ send('navigate'); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ send('ready'); });
  else send('ready');
  addEventListener('load', function(){ send('load'); });
})();
`;

/** from: そのページを作ったのが開発サーバー（app）か、この中継（gateway）か */
const agentTag = (status: number, from: 'app' | 'gateway' = 'app'): string =>
  `<script src="${AGENT_PREFIX}agent.js" data-vcide-status="${status}" data-vcide-from="${from}"></script>`;

/** IDE が作る説明のページ。03d 1.1節の4要素で書く。エスケープしてから埋める */
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c] as string));

export function explainPage(status: number, f: { fact: string; reason: string; impact: string; action: string }): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">${agentTag(status, 'gateway')}
<title>プレビュー: ${esc(f.fact)}</title>
<style>body{font:13px/1.7 system-ui,sans-serif;margin:0;padding:18px;color:#1b2430;background:#fbfcfd}
b{display:block;font-size:14px;margin-bottom:6px}p{margin:4px 0}.imp{color:#55606e}.act{color:#5a4fb0;border-top:1px dashed #d9dde3;padding-top:6px;margin-top:8px}
code{font:12px ui-monospace,monospace;color:#55606e}</style></head>
<body data-vcide-gateway="${status}"><b>${esc(f.fact)}</b><p>${esc(f.reason)}</p><p class="imp">${esc(f.impact)}</p><p class="act">${esc(f.action)}</p>
<p><code>HTTP ${status} — IDE のプレビュー中継が返したページです（開発サーバーの応答ではありません）</code></p></body></html>`;
}

/**
 * HTML の <head> の直後に、場所を知らせるスクリプトを差し込む。
 * 流れてくる順に見て、<head> が見つかるまでだけ溜める（最大 64KB）。見つからなければ何も足さない。
 */
class InjectAgent extends Transform {
  /** 探すのは ASCII の <head> だけなので、latin1 で読む（バイト列を壊さずに戻せる） */
  #buf = '';
  #done = false;
  constructor(private readonly tag: string) { super(); }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.#done) { cb(null, chunk); return; }
    this.#buf += chunk.toString('latin1');
    const m = /<head(\s[^>]*)?>/i.exec(this.#buf);
    if (m) {
      const at = m.index + m[0].length;
      this.push(Buffer.from(this.#buf.slice(0, at), 'latin1'));
      this.push(Buffer.from(this.tag, 'utf8'));
      this.push(Buffer.from(this.#buf.slice(at), 'latin1'));
      this.#buf = ''; this.#done = true; cb(); return;
    }
    if (this.#buf.length > 65536) { this.push(Buffer.from(this.#buf, 'latin1')); this.#buf = ''; this.#done = true; }
    cb();
  }

  _flush(cb: TransformCallback): void {
    if (this.#buf) this.push(Buffer.from(this.#buf, 'latin1'));
    cb();
  }
}

/* -------------------------------------------------------------- ヘッダの整理 */

/** 転送しないヘッダ（ホップごとのもの・転送元の情報・中継の資格情報） */
const DROP_REQ = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-forwarded-server', 'x-real-ip',
]);
const DROP_RES = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'trailer', 'upgrade',
]);

function sameHost(value: string | undefined, host: string): boolean {
  if (!value || value === 'null') return false;
  try { return new URL(value).host === host.toLowerCase(); } catch { return false; }
}

/**
 * 転送先へ送るヘッダ。
 * Host と、**中継自身の origin から来た** Origin / Referer を、転送先のものに置き換える。
 * Next.js の開発サーバーは、localhost 以外の Origin からの `/_next/*` を拒否する
 * （next/dist/server/lib/router-utils/block-cross-site-dev.js）。中継の origin は
 * ブラウザから見れば同一オリジンなので、転送先から見ても同一オリジンにする。
 * **別の origin から来た Origin は書き換えない**（Next.js の CSRF の検査をそのまま効かせる）。
 */
export function forwardHeaders(
  h: http.IncomingHttpHeaders, targetPort: number, { upgrade = false } = {},
): http.OutgoingHttpHeaders {
  const host = String(h.host ?? '');
  const targetOrigin = `http://127.0.0.1:${targetPort}`;
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || DROP_REQ.has(k)) continue;
    out[k] = v;
  }
  out.host = `127.0.0.1:${targetPort}`;
  if (typeof h.origin === 'string' && sameHost(h.origin, host)) out.origin = targetOrigin;
  if (typeof h.referer === 'string' && sameHost(h.referer, host)) {
    const u = new URL(h.referer);
    out.referer = `${targetOrigin}${u.pathname}${u.search}`;
  }
  if (upgrade) { out.connection = 'Upgrade'; out.upgrade = h.upgrade; }
  else out['accept-encoding'] = 'identity';   // 差し込みのため。ローカルなので圧縮の利点は無い
  return out;
}

/* ------------------------------------------------------------------ 本体 */

export class PreviewGateway {
  #server: http.Server | null = null;
  #info: GatewayInfo = { state: 'idle', port: null, reason: null };
  #starting: Promise<GatewayInfo> | null = null;
  readonly #opts: GatewayOptions;

  constructor(opts: GatewayOptions) { this.#opts = opts; }

  info(): GatewayInfo { return { ...this.#info }; }

  /** 待ち受けを始める。何度呼んでもよい */
  ensure(): Promise<GatewayInfo> {
    if (this.#info.state === 'listening') return Promise.resolve(this.info());
    this.#starting ??= this.#listen().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  close(): Promise<void> {
    const s = this.#server;
    this.#server = null;
    this.#info = { state: 'idle', port: null, reason: null };
    return new Promise((r) => { if (!s) { r(); return; } s.closeAllConnections?.(); s.close(() => r()); });
  }

  async #listen(): Promise<GatewayInfo> {
    const { config } = this.#opts;
    const first = this.#opts.port ?? config.previewPort;
    const fixed = this.#opts.port !== undefined || config.previewPortFixed;
    const last = fixed ? first : first + 20;
    let lastErr = '';
    for (let p = first; p <= last; p++) {
      const server = http.createServer((req, res) => { this.#onRequest(req, res); });
      server.on('upgrade', (req, socket, head) => { this.#onUpgrade(req, socket as net.Socket, head); });
      server.on('connect', (_req, socket) => { socket.end('HTTP/1.1 405 Method Not Allowed\r\nconnection: close\r\n\r\n'); });
      server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* 閉じている */ } });
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', (e) => { lastErr = (e as NodeJS.ErrnoException).code ?? String(e); resolve(false); });
        // **ループバックだけで待ち受ける。** 外のネットワークからは直接届かない
        server.listen(p, '127.0.0.1', () => resolve(true));
      });
      if (ok) {
        this.#server = server;
        this.#info = { state: 'listening', port: p, reason: null };
        return this.info();
      }
    }
    this.#info = {
      state: 'unavailable', port: null,
      reason: fixed
        ? `プレビューの中継がポート ${first} で待ち受けできませんでした（${lastErr}）。`
        : `プレビューの中継が ${first}〜${last} のどのポートでも待ち受けできませんでした（${lastErr}）。`,
    };
    return this.info();
  }

  /** Host の検査。通さないなら応答を書いて false */
  #hostOk(req: http.IncomingMessage): boolean {
    const host = req.headers.host;
    return !!host && isAllowedPreviewHost(host, this.#opts.config);
  }

  #securityHeaders(): Record<string, string> {
    return {
      'content-security-policy': `frame-ancestors ${ideFrameAncestors(this.#opts.config).join(' ')}`,
      'x-content-type-options': 'nosniff',
    };
  }

  #explain(res: http.ServerResponse, status: number, f: Parameters<typeof explainPage>[1]): void {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      ...this.#securityHeaders(),
    });
    res.end(explainPage(status, f));
  }

  #onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';
    // 絶対形式（GET http://other/ …）は「任意の宛先へ転送してほしい」という要求である。受けない
    if (!url.startsWith('/')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('この中継は、IDE が起動した開発サーバーにしか転送しません。');
      return;
    }
    if (!this.#hostOk(req)) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('このホスト名からのプレビューは受け付けません（IDE の起動時に許可したホスト名ではありません）。');
      return;
    }

    /* ------------------------------------------------- 中継が自分で答えるパス */
    if (url.startsWith(AGENT_PREFIX)) {
      const p = url.slice(AGENT_PREFIX.length).split('?')[0];
      if (p === 'agent.js') {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store',
          ...this.#securityHeaders(),
        });
        res.end(AGENT_JS);
        return;
      }
      if (p === 'ping') {
        // IDE の画面が「ブラウザから中継に届くか」を確かめる。IDE の画面の origin にだけ CORS で答える
        const origin = req.headers.origin;
        const headers: Record<string, string> = {
          'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'origin',
        };
        if (origin && isIdeOrigin(origin, this.#opts.config)) headers['access-control-allow-origin'] = origin;
        const t = this.#opts.target();
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true, forwarding: !!t.target }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    /* ------------------------------------------------------- 転送先を決める */
    const { target, reason } = this.#opts.target();
    if (!target) {
      this.#explain(res, 503, {
        fact: '開発サーバーは実行中ではありません。',
        reason,
        impact: 'プレビューに表示するページはありません。',
        action: 'IDE の「プロジェクトと実行」から開発サーバーを起動してください。',
      });
      return;
    }

    const upstream = http.request({
      host: '127.0.0.1', port: target.port, method: req.method, path: url,
      headers: forwardHeaders(req.headers, target.port),
    }, (up) => {
      const headers: Record<string, string | string[] | number> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v === undefined || DROP_RES.has(k)) continue;
        headers[k] = v;
      }
      // 転送先の絶対 URL へのリダイレクトは、パスだけにする（ブラウザに 127.0.0.1 を踏ませない）
      const loc = headers.location;
      if (typeof loc === 'string') {
        for (const o of [`http://127.0.0.1:${target.port}`, `http://localhost:${target.port}`]) {
          if (loc.startsWith(o)) headers.location = loc.slice(o.length) || '/';
        }
      }
      const sec = this.#securityHeaders();
      const csp = headers['content-security-policy'];
      headers['content-security-policy'] = csp === undefined ? sec['content-security-policy']
        : [...(Array.isArray(csp) ? csp : [String(csp)]), sec['content-security-policy']];
      const html = /^text\/html/i.test(String(up.headers['content-type'] ?? ''))
        && req.method === 'GET' && !up.headers['content-encoding'];
      if (html) delete headers['content-length'];
      res.writeHead(up.statusCode ?? 502, up.statusMessage ?? '', headers);
      if (html) up.pipe(new InjectAgent(agentTag(up.statusCode ?? 0))).pipe(res);
      else up.pipe(res);
    });
    upstream.on('error', (e) => {
      this.#explain(res, 502, {
        fact: '開発サーバーに接続できませんでした。',
        reason: `127.0.0.1:${target.port} への接続が失敗しました（${(e as NodeJS.ErrnoException).code ?? e.message}）。`,
        impact: '開発サーバーが応答できない状態です。IDE の状態の表示は、次の確認で更新されます。',
        action: 'しばらく待ってから再読み込みしてください。続く場合は「プロジェクトと実行」の出力を確認してください。',
      });
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  /** HMR の WebSocket（/_next/webpack-hmr など）。同じ検査をして、同じ1つの宛先へつなぐ */
  #onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const refuse = (code: number, msg: string) => {
      socket.end(`HTTP/1.1 ${code} ${msg}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    };
    const url = req.url ?? '';
    if (!url.startsWith('/') || !this.#hostOk(req)) { refuse(421, 'Misdirected Request'); return; }
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') { refuse(400, 'Bad Request'); return; }
    const { target } = this.#opts.target();
    if (!target) { refuse(503, 'Service Unavailable'); return; }

    const up = net.connect(target.port, '127.0.0.1');
    up.once('connect', () => {
      const headers = forwardHeaders(req.headers, target.port, { upgrade: true });
      const lines = [`${req.method} ${url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`);
      }
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => { up.destroy(); socket.destroy(); };
    up.on('error', () => { if (!socket.destroyed) refuse(502, 'Bad Gateway'); end(); });
    socket.on('error', end);
    socket.on('close', () => up.destroy());
  }
}
