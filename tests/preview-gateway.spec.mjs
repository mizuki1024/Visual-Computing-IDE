/* =============================================================================
 * Phase 7B-1 — プレビューの中継・接続の許可・起動先の環境変数を、部品の単位で確かめる。
 *   npm run build:lib && node tests/preview-gateway.spec.mjs
 *
 * 中継（PreviewGateway）は本物を使い、転送先だけを小さな HTTP サーバー（代役）にする。
 * 代役は受け取った要求をそのまま JSON で返すので、**中継が何を転送先へ渡したか**が見える。
 * 実物の Next.js と実ブラウザでの確認は tests/preview-e2e.spec.mjs が行う。
 * ========================================================================== */
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';

const require_ = createRequire(import.meta.url);
const A = require_('../.libjs/server/access.js');
const G = require_('../.libjs/server/guard.js');
const GW = require_('../.libjs/server/previewGateway.js');
const CE = require_('../.libjs/server/childEnv.js');
const PV = require_('../.libjs/server/preview.js');

let pass = 0;
const fails = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);

async function freePort(from) {
  for (let p = from; p < from + 200; p++) {
    const got = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (got) return p;
  }
  throw new Error('空きポートが見つかりません');
}

/** 生の HTTP を送る（Host・絶対形式・CONNECT を自由に書くため） */
function raw(port, text) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let buf = '';
    s.on('data', (d) => { buf += d.toString('utf8'); });
    s.on('end', () => resolve(buf));
    s.on('error', () => resolve(buf));
    setTimeout(() => { s.destroy(); resolve(buf); }, 3000);
  });
}

/** fetch では Host を変えられないので http.request を使う */
function get(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

/* ======================================================== 1. 接続の許可の設定 */
console.log('\n1. 接続を許可するホストは、IDE の起動時に明示したものだけ');
{
  const d = A.accessConfig({});
  eq('既定ではループバック以外を許可しない', d.ideHosts.length, 0);
  eq('既定では公開 URL を持たない', d.previewPublicOrigin, null);
  eq('既定の中継のポートは 3150', d.previewPort, 3150);
  eq('既定ではポートを探してよい', d.previewPortFixed, false);

  const c = A.accessConfig({ VCIDE_ALLOWED_HOSTS: 'ide.example.test, *.evil.test, bad host, localhost:3100', VCIDE_PREVIEW_ORIGIN: 'https://pv.example.test' });
  ok('明示したホストは許可する', c.ideHosts.includes('ide.example.test'), c.ideHosts);
  ok('ワイルドカードは受け付けない', !c.ideHosts.some((h) => h.includes('*')), c.ideHosts);
  ok('ワイルドカードを黙って捨てず、問題として出す', c.problems.some((p) => p.includes('ワイルドカード')), c.problems);
  ok('解釈できないホスト名も問題として出す', c.problems.some((p) => p.includes('bad host')), c.problems);
  eq('公開 URL は origin の形で持つ', c.previewPublicOrigin, 'https://pv.example.test');

  const bad = A.accessConfig({ VCIDE_PREVIEW_ORIGIN: 'https://pv.example.test/path?x=1' });
  eq('パスつきの公開 URL は使わない', bad.previewPublicOrigin, null);
  const cred = A.accessConfig({ VCIDE_PREVIEW_ORIGIN: 'https://u:p@pv.example.test' });
  eq('資格情報つきの公開 URL は使わない', cred.previewPublicOrigin, null);

  const cs = A.accessConfig({
    VCIDE_ALLOWED_HOSTS: 'codespaces', CODESPACE_NAME: 'fuzzy-train-abc', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev', PORT: '3100',
  });
  eq('codespaces: IDE のポートの転送ホストを1つだけ組み立てる', JSON.stringify(cs.ideHosts), JSON.stringify(['fuzzy-train-abc-3100.app.github.dev']));
  eq('codespaces: 中継の公開 URL も組み立てる', cs.previewPublicOrigin, 'https://fuzzy-train-abc-3150.app.github.dev');
  eq('codespaces: 公開 URL がポートに依存するので、ポートを探さない', cs.previewPortFixed, true);
  const csMissing = A.accessConfig({ VCIDE_ALLOWED_HOSTS: 'codespaces' });
  ok('codespaces の変数が無ければ何も許可せず、問題として出す', csMissing.ideHosts.length === 0 && csMissing.problems.length === 1, csMissing);

  eq('Host の判定: ループバック', A.isAllowedIdeHost('127.0.0.1:3100', d), true);
  eq('Host の判定: 許可していない名前', A.isAllowedIdeHost('evil.test:3100', d), false);
  eq('Host の判定: 明示した名前（ポート無しの指定はポートを問わない）', A.isAllowedIdeHost('ide.example.test:8443', c), true);
  eq('Host の判定: 前方一致では通さない', A.isAllowedIdeHost('ide.example.test.evil.test', c), false);
  eq('Host の判定: 大文字小文字は問わない', A.isAllowedIdeHost('IDE.Example.Test', c), true);
  eq('中継の Host: 公開 URL のホストは通す', A.isAllowedPreviewHost('pv.example.test', c), true);
  eq('中継の Host: IDE のホストは中継には通さない', A.isAllowedPreviewHost('ide.example.test', c), false);
}

/* ======================================================== 2. API の入口の防御 */
console.log('\n2. IDE の API の入口（Host・Origin の検査は撤廃していない）');
{
  const cfg = A.accessConfig({ VCIDE_ALLOWED_HOSTS: 'ide.example.test', VCIDE_PREVIEW_ORIGIN: 'https://pv.example.test' });
  const none = A.accessConfig({});
  const req = (headers, method = 'POST') => new Request('http://x/api/runtime/start', { method, headers });
  const M = { 'content-type': 'application/json', 'x-vcide-request': '1' };
  eq('転送ホスト: 設定していなければ拒否する（従来どおり）', G.guardRequest(req({ host: 'ide.example.test', ...M }), { mutating: true }, none)?.code, 'non-local-host');
  eq('転送ホスト: 明示していれば通す', G.guardRequest(req({ host: 'ide.example.test', origin: 'https://ide.example.test', 'sec-fetch-site': 'same-origin', ...M }), { mutating: true }, cfg), null);
  eq('転送ホスト: Origin が Host と違えば拒否する', G.guardRequest(req({ host: 'ide.example.test', origin: 'https://other.example.test', ...M }), { mutating: true }, cfg)?.code, 'cross-origin');
  eq('プレビュー（中継の origin）から IDE の API は呼べない', G.guardRequest(req({ host: 'ide.example.test', origin: 'https://pv.example.test', ...M }), { mutating: true }, cfg)?.code, 'cross-origin');
  eq('同じサイトの別 origin（sec-fetch-site: same-site）も拒否する', G.guardRequest(req({ host: 'ide.example.test', 'sec-fetch-site': 'same-site', ...M }), { mutating: true }, cfg)?.code, 'cross-site');
  eq('ループバックのプレビュー（別ポート）からも呼べない', G.guardRequest(req({ host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3150', ...M }), { mutating: true }, none)?.code, 'cross-origin');
  eq('転送ホストでも独自ヘッダは要る', G.guardRequest(req({ host: 'ide.example.test', 'content-type': 'application/json' }), { mutating: true }, cfg)?.code, 'missing-request-header');
  eq('許可していない名前（DNS リバインディング）', G.guardRequest(req({ host: 'rebind.evil.test:3100' }, 'GET'), { mutating: false }, cfg)?.code, 'non-local-host');
}

/* ===================================================== 3. 起動先の環境変数 */
console.log('\n3. 起動先に渡す環境変数は許可したものだけ（ダミーの秘密情報で確かめる）');
{
  const DUMMY = {
    GITHUB_TOKEN: 'ghp_DUMMYgithubTOKEN000', GH_TOKEN: 'gho_DUMMY000',
    AWS_ACCESS_KEY_ID: 'AKIADUMMY000', AWS_SECRET_ACCESS_KEY: 'dummy/aws/secret',
    ANTHROPIC_API_KEY: 'sk-ant-dummy-000', ANTHROPIC_BASE_URL: 'https://dummy.invalid',
    CLAUDE_CODE_OAUTH_TOKEN: 'dummy-oauth', CLAUDE_CODE_SESSION_ID: 'dummy-session',
    OPENAI_API_KEY: 'sk-dummy', CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.dummy',
    DATABASE_URL: 'postgres://u:dummypass@db.invalid/x', SESSION_INGRESS_URL: 'https://dummy.invalid',
    npm_config__authToken: 'npm_dummy', 'npm_config_//registry.npmjs.org/:_authToken': 'npm_dummy2',
    npm_config_password: 'dummy',
    HTTPS_PROXY: 'http://dummyuser:dummypass@proxy.invalid:8080',
    VCIDE_PREVIEW_ORIGIN: 'https://pv.example.test',
  };
  const base = {
    ...DUMMY,
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'ja_JP.UTF-8', LC_ALL: 'ja_JP.UTF-8', TZ: 'Asia/Tokyo',
    NODE_OPTIONS: '--use-openssl-ca', NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    HTTP_PROXY: 'http://proxy.invalid:8080', NO_PROXY: 'localhost', npm_config_https_proxy: 'http://proxy.invalid:8080',
    NODE_ENV: 'production', PORT: '3101', __NEXT_PRIVATE_ORIGIN: 'http://127.0.0.1:3101', npm_package_name: 'visual-computing-ide',
    MY_APP_FLAG: 'x', OTHER_SHELL_VAR: 'y',
  };
  const r = CE.childEnvReport(base);
  for (const k of Object.keys(DUMMY)) eq(`${k} は渡さない`, k in r.env, false);
  const blob = JSON.stringify(r.env);
  ok('渡す環境のどの値にも、ダミーの秘密情報が含まれない',
    !['DUMMY', 'dummy', 'sk-ant', 'ghp_', 'ya29'].some((s) => blob.includes(s)), blob);
  for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'NO_PROXY', 'npm_config_https_proxy']) {
    eq(`${k} は渡す`, r.env[k], base[k]);
  }
  eq('資格情報つきのプロキシは渡さない（HTTPS_PROXY）', r.env.HTTPS_PROXY, undefined);
  for (const k of ['NODE_ENV', 'PORT', '__NEXT_PRIVATE_ORIGIN', 'npm_package_name']) eq(`IDE 自身の ${k} は渡さない`, k in r.env, false);
  eq('名前を許可していない変数は渡さない', 'OTHER_SHELL_VAR' in r.env, false);
  eq('テレメトリは切る', r.env.NEXT_TELEMETRY_DISABLED, '1');
  ok('渡した名前の一覧に値は含まない', r.passed.every((n) => !n.includes('=')), r.passed);
  eq('渡さなかった数を数える', r.withheld, Object.keys(base).length - r.passed.length);

  const ex = CE.childEnvReport({ ...base, VCIDE_CHILD_ENV_PASS: 'MY_APP_FLAG, bad-name' });
  eq('VCIDE_CHILD_ENV_PASS で明示した名前は渡す', ex.env.MY_APP_FLAG, 'x');
  eq('明示した名前は一覧に出す', JSON.stringify(ex.explicit), JSON.stringify(['MY_APP_FLAG']));
  eq('VCIDE_CHILD_ENV_PASS 自体は渡さない', 'VCIDE_CHILD_ENV_PASS' in ex.env, false);
}

/* ============================================================== 4. 中継 */
console.log('\n4. プレビューの中継（転送先は1つだけ）');
const UP = await freePort(4710);
const DOWN = await freePort(UP + 1);   // 何も待ち受けていないポート
const upstream = http.createServer((req, res) => {
  if (req.url === '/page') {
    // <head> と日本語を、わざと途中で切って送る（差し込みがバイト列を壊さないこと）
    const html = Buffer.from('<!doctype html><html><he' + 'ad lang="ja"><title>見出し</title></head><body>千葉県と茨城県</body></html>', 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(html.length), 'x-frame-options': 'SAMEORIGIN' });
    res.write(html.subarray(0, 20)); res.write(html.subarray(20, 61)); res.end(html.subarray(61));
    return;
  }
  if (req.url === '/missing') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html><head></head><body>nf</body></html>'); return; }
  if (req.url === '/redir') { res.writeHead(307, { location: `http://127.0.0.1:${UP}/page` }); res.end(); return; }
  if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"a":1}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers }));
});
upstream.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
  socket.write(`ECHO ${req.url} ${req.headers.host} ${req.headers.origin ?? '-'}`);
  socket.end();
});
await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));

let running = false;
let targetPort = UP;
const cfg = A.accessConfig({ VCIDE_ALLOWED_HOSTS: 'ide.example.test', VCIDE_PREVIEW_ORIGIN: 'http://pv.example.test' });
const gwPort = await freePort(4760);
const gw = new GW.PreviewGateway({
  config: cfg, port: gwPort,
  target: () => (running ? { target: { port: targetPort }, reason: '' } : { target: null, reason: '開発サーバーは停止しています。' }),
});
const info = await gw.ensure();
eq('中継は待ち受けを始める', info.state, 'listening');
eq('指定したポートで待ち受ける', info.port, gwPort);
eq('何度呼んでも同じ（二重に待ち受けない）', (await gw.ensure()).port, gwPort);
{
  // 待ち受けはループバックだけ。外向きのアドレスで接続して、届かないことを見る
  const os = await import('node:os');
  const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (ext) {
    const reached = await new Promise((resolve) => {
      const s = net.connect(gwPort, ext, () => { resolve(true); s.destroy(); });
      s.on('error', () => resolve(false));
    });
    eq(`外向きのアドレス（${ext}）からは届かない`, reached, false);
  } else {
    console.log('  ⊘ 外向きのアドレスが無いため、待ち受けの範囲の検査は skip');
  }
}

{
  const r = await get(gwPort, '/page');
  eq('実行中でなければ転送しない（503）', r.status, 503);
  ok('IDE が作った説明のページを返す', r.body.includes('開発サーバーは実行中ではありません') && r.body.includes('data-vcide-from="gateway"'), r.body.slice(0, 200));
  ok('説明のページにも埋め込みの制限を付ける', String(r.headers['content-security-policy']).startsWith('frame-ancestors '), r.headers['content-security-policy']);
}
running = true;
{
  const r = await get(gwPort, '/page', { host: `127.0.0.1:${gwPort}` });
  eq('実行中なら転送する', r.status, 200);
  ok('<head> の直後に場所を知らせるスクリプトを差し込む',
    r.body.includes('<head lang="ja"><script src="/__vcide_preview/agent.js" data-vcide-status="200" data-vcide-from="app"></script><title>'), r.body);
  ok('差し込みは日本語のバイト列を壊さない', r.body.includes('<title>見出し</title>') && r.body.includes('千葉県と茨城県'), r.body);
  eq('長さが変わるので content-length は付けない', r.headers['content-length'], undefined);
  const csp = [].concat(r.headers['content-security-policy'] ?? []).join(' ');
  ok('IDE の画面からだけ埋め込めるよう frame-ancestors を足す', csp.includes('frame-ancestors') && csp.includes('http://127.0.0.1:*') && csp.includes('https://ide.example.test'), csp);
  ok('frame-ancestors に任意の相手（*）を含めない', !/frame-ancestors[^;]*\s\*(\s|;|$)/.test(csp), csp);
  ok('frame-ancestors に CSP が受け付けない書き方（IPv6 の [::1]）を含めない', !csp.includes('[::1]'), csp);
  eq('転送先の X-Frame-Options は書き換えない', r.headers['x-frame-options'], 'SAMEORIGIN');
}
{
  const r = await get(gwPort, '/missing');
  eq('存在しないページは転送先の 404 をそのまま返す', r.status, 404);
  ok('404 を知らせる', r.body.includes('data-vcide-status="404"'), r.body);
}
{
  const r = await get(gwPort, '/json');
  eq('HTML 以外には差し込まない', r.body, '{"a":1}');
}
{
  const r = await get(gwPort, '/redir');
  eq('転送先の絶対 URL へのリダイレクトはパスだけにする', r.headers.location, '/page');
}
{
  const r = await get(gwPort, '/echo?q=1', {
    host: 'pv.example.test',
    origin: 'http://pv.example.test',
    referer: 'http://pv.example.test/listings?x=1',
    'x-forwarded-host': 'pv.example.test', 'x-forwarded-for': '203.0.113.9', forwarded: 'for=203.0.113.9',
    'proxy-authorization': 'Basic ZHVtbXk6ZHVtbXk=', cookie: 'app_session=abc',
    'accept-encoding': 'gzip, br',
  }, 'POST');
  const j = JSON.parse(r.body);
  eq('公開ホストからの要求も転送する', r.status, 200);
  eq('転送先の Host は 127.0.0.1:<転送先のポート>', j.headers.host, `127.0.0.1:${UP}`);
  eq('中継自身の origin から来た Origin は転送先のものにする（Next の dev の検査に合わせる）', j.headers.origin, `http://127.0.0.1:${UP}`);
  eq('Referer も同じ', j.headers.referer, `http://127.0.0.1:${UP}/listings?x=1`);
  for (const k of ['x-forwarded-host', 'x-forwarded-for', 'forwarded', 'proxy-authorization']) eq(`${k} は渡さない`, j.headers[k], undefined);
  eq('アプリの Cookie は渡す（アプリ自身のもの）', j.headers.cookie, 'app_session=abc');
  eq('差し込みのため圧縮を求めない', j.headers['accept-encoding'], 'identity');
  eq('パスと問い合わせはそのまま', j.url, '/echo?q=1');
  eq('メソッドはそのまま', j.method, 'POST');
}
{
  const r = await get(gwPort, '/echo', { host: `127.0.0.1:${gwPort}`, origin: 'http://evil.example' });
  const j = JSON.parse(r.body);
  eq('別の origin から来た Origin は書き換えない（転送先の CSRF の検査を効かせる）', j.headers.origin, 'http://evil.example');
}
{
  const r = await get(gwPort, '//evil.example/x');
  const j = JSON.parse(r.body);
  eq('// で始まるパスも、宛先ではなくパスとして転送先へ送る', j.url, '//evil.example/x');
  eq('宛先は変わらない', j.headers.host, `127.0.0.1:${UP}`);
}
{
  const a = await raw(gwPort, `GET http://127.0.0.1:${UP}/echo HTTP/1.1\r\nHost: 127.0.0.1:${UP}\r\nconnection: close\r\n\r\n`);
  ok('絶対形式の要求（任意の宛先への転送の依頼）は 400', a.startsWith('HTTP/1.1 400'), a.slice(0, 60));
  const b = await raw(gwPort, `CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: 127.0.0.1:22\r\n\r\n`);
  ok('CONNECT（任意のポートへのトンネル）は 405', b.startsWith('HTTP/1.1 405'), b.slice(0, 60));
  const c = await raw(gwPort, 'GET /echo HTTP/1.1\r\nHost: rebind.evil.test\r\nconnection: close\r\n\r\n');
  ok('許可していない Host は 421', c.startsWith('HTTP/1.1 421'), c.slice(0, 60));
  ok('421 では転送先に届けない', !c.includes('"headers"'), c);
  const d = await raw(gwPort, 'GET /echo HTTP/1.1\r\nHost: ide.example.test\r\nconnection: close\r\n\r\n');
  ok('IDE の転送ホストで中継に来ても通さない', d.startsWith('HTTP/1.1 421'), d.slice(0, 60));
}
{
  const ws = await raw(gwPort, `GET /_next/webpack-hmr HTTP/1.1\r\nHost: pv.example.test\r\nOrigin: http://pv.example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  ok('WebSocket（HMR）は転送先へつなぐ', ws.startsWith('HTTP/1.1 101'), ws.slice(0, 80));
  ok('WebSocket でも Host と Origin を転送先のものにする', ws.includes(`ECHO /_next/webpack-hmr 127.0.0.1:${UP} http://127.0.0.1:${UP}`), ws);
  const wsBad = await raw(gwPort, 'GET /_next/webpack-hmr HTTP/1.1\r\nHost: rebind.evil.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  ok('許可していない Host の WebSocket は 421', wsBad.startsWith('HTTP/1.1 421'), wsBad.slice(0, 60));
  running = false;
  const wsOff = await raw(gwPort, `GET /_next/webpack-hmr HTTP/1.1\r\nHost: 127.0.0.1:${gwPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  ok('実行中でなければ WebSocket もつながない', wsOff.startsWith('HTTP/1.1 503'), wsOff.slice(0, 60));
  running = true;
}
{
  const a = await get(gwPort, '/__vcide_preview/ping', { origin: 'http://127.0.0.1:3100' });
  eq('ping: IDE の画面（ループバック）には CORS で答える', a.headers['access-control-allow-origin'], 'http://127.0.0.1:3100');
  eq('ping: 転送しているかを返す', JSON.parse(a.body).forwarding, true);
  const b = await get(gwPort, '/__vcide_preview/ping', { origin: 'https://ide.example.test' });
  eq('ping: 明示した IDE のホストにも答える', b.headers['access-control-allow-origin'], 'https://ide.example.test');
  const c = await get(gwPort, '/__vcide_preview/ping', { origin: 'https://evil.example' });
  eq('ping: 他の origin には CORS を許さない', c.headers['access-control-allow-origin'], undefined);
  const s = await get(gwPort, '/__vcide_preview/agent.js');
  ok('スクリプトは中継の origin から配る', s.status === 200 && s.body.includes("source: 'vcide-preview'"), s.status);
  ok('スクリプトは DOM の中身を送らない（パス・タイトル・状態だけ）', !/innerHTML|outerHTML|textContent|cookie|localStorage/.test(s.body), s.body);
}
{
  targetPort = DOWN;
  const r = await get(gwPort, '/page');
  eq('転送先に接続できなければ 502', r.status, 502);
  ok('通信の失敗を説明するページを返す（中継が作ったと明示）', r.body.includes('開発サーバーに接続できませんでした') && r.body.includes('data-vcide-from="gateway"') && r.body.includes('data-vcide-status="502"'), r.body.slice(0, 300));
  targetPort = UP;
}
{
  const blocker = new GW.PreviewGateway({ config: cfg, port: gwPort, target: () => ({ target: null, reason: '' }) });
  const i = await blocker.ensure();
  eq('ポートが使われていて、ポートを探せないときは「使えない」', i.state, 'unavailable');
  ok('理由を持つ', /待ち受けできませんでした/.test(i.reason ?? ''), i.reason);
  const scanner = new GW.PreviewGateway({ config: { ...cfg, previewPort: gwPort, previewPortFixed: false }, target: () => ({ target: null, reason: '' }) });
  const j = await scanner.ensure();
  ok('探してよいときは次の空きポートで待ち受ける', j.state === 'listening' && j.port > gwPort, j);
  await scanner.close();
}

/* ============================================== 5. ブラウザから見た中継の URL */
console.log('\n5. ブラウザから見た中継の URL（ブラウザの localhost はサーバーの localhost ではない）');
{
  const up = { state: 'listening', port: 3150, reason: null };
  const none = A.accessConfig({});
  eq('ループバックの IDE には、同じホスト名で中継のポート', PV.previewOriginFor('127.0.0.1:3100', up, none).origin, 'http://127.0.0.1:3150');
  eq('localhost で開いたなら localhost', PV.previewOriginFor('localhost:3100', up, none).origin, 'http://localhost:3150');
  const fwd = PV.previewOriginFor('ide.example.test', up, cfg);
  eq('転送された IDE には、明示した公開 URL', fwd.origin, 'http://pv.example.test');
  const unknown = PV.previewOriginFor('ide.example.test', up, A.accessConfig({ VCIDE_ALLOWED_HOSTS: 'ide.example.test' }));
  eq('公開 URL を明示していなければ、推測しない（null）', unknown.origin, null);
  eq('理由を出す', unknown.error?.code, 'preview-origin-unknown');
  ok('「ブラウザの localhost はサーバーの localhost ではない」ことを書く', /localhost/.test(unknown.error?.impact ?? ''), unknown.error);
  eq('許可していないホストには URL を返さない', PV.previewOriginFor('evil.test', up, cfg).origin, null);
  const down = PV.previewOriginFor('127.0.0.1:3100', { state: 'unavailable', port: null, reason: 'EADDRINUSE' }, none);
  eq('中継が使えなければ理由を出す', down.error?.code, 'preview-gateway-unavailable');
}

await gw.close();
await new Promise((r) => upstream.close(r));

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
process.exit(0);
