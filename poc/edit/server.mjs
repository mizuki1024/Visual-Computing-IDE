/* =============================================================================
 * 編集 PoC のハーネス。IDE の製品画面には統合しない（poc/ の中で閉じる）。
 *
 *   127.0.0.1:3262  検証用画面と API（IDE 側の origin の代役）
 *   127.0.0.1:3261  中継（別 origin）。宛先は題材の開発サーバー1つだけ。edit-agent を差し込む
 *   127.0.0.1:3260  題材 poc/fixture-edit の next dev（要素識別子の注入あり）
 *
 * 再利用したもの（.libjs = `npm run build:lib` の出力。製品のコードは変更していない）
 *   - src/server/anchors.ts       anchorSupport / resolveSelection（6段の照合）/ anchorOutDir / readManifest
 *   - src/server/previewGateway.ts forwardHeaders（転送ヘッダの整理・Origin の書き換え規則）
 *   - src/lib/previewProtocol.ts   parseSelection（選択の中身の検査）
 *   - poc/anchor/loader.cjs        要素識別子の注入（題材の next.config が読む）
 *
 * 書き込む先は題材の src/ の中だけ（engine.safePath）。作業ツリーの他の場所には書かない。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
process.chdir(REPO);   // anchors.ts の ideRoot() は cwd から IDE のルートを探す

const LIB = path.join(REPO, '.libjs');
if (!fs.existsSync(path.join(LIB, 'server/anchors.js'))) {
  console.error('.libjs がありません。先に `npm run build:lib` を実行してください。');
  process.exit(2);
}
const anchors = require(path.join(LIB, 'server/anchors.js'));
const { forwardHeaders } = require(path.join(LIB, 'server/previewGateway.js'));
const { parseSelection } = require(path.join(LIB, 'lib/previewProtocol.js'));
const E = require('./engine.cjs');
const TW = require('./tailwind.cjs');

const FIXTURE = path.join(REPO, 'poc/fixture-edit');
const DEV_PORT = Number(process.env.POC_EDIT_DEV_PORT ?? 3260);
const RELAY_PORT = Number(process.env.POC_EDIT_RELAY_PORT ?? 3261);
const UI_PORT = Number(process.env.POC_EDIT_UI_PORT ?? 3262);
const FAULTS = process.env.POC_EDIT_FAULTS === '1';
const UI_ORIGIN = `http://127.0.0.1:${UI_PORT}`;
const RELAY_ORIGIN = `http://127.0.0.1:${RELAY_PORT}`;
const PUB = path.join(HERE, 'public');

/* ------------------------------------------------------------------ 状態 */
const S = {
  instance: crypto.randomBytes(8).toString('hex'),
  session: crypto.randomBytes(24).toString('base64url'),
  startedAt: new Date().toISOString(),
  dev: null,
  devReady: false,
  hmrBlocked: false,
  hmrSockets: new Set(),
  theme: null,
  resolved: new Map(),
  draft: null,
  applied: [],
  writes: [],
  observation: null,
  log: [],
};
const log = (kind, msg, extra = {}) => {
  const e = { t: new Date().toISOString(), kind, msg, ...extra };
  S.log.push(e);
  if (S.log.length > 200) S.log.shift();
  console.log(`[${kind}] ${msg}`);
};
const rev = () => E.revisionOf(FIXTURE);
const support = () => anchors.anchorSupport(FIXTURE);

/* ------------------------------------------------- 題材の開発サーバー */
function startDev() {
  const out = anchors.anchorOutDir(FIXTURE);
  fs.mkdirSync(out, { recursive: true });
  /* 渡す環境変数は最小限（製品の childEnv と同じ方針: IDE の秘密を渡さない） */
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: '1',
    POC03_ANCHOR: '1', POC03_ANCHOR_OUT: out };
  const bin = path.join(FIXTURE, 'node_modules/next/dist/bin/next');
  /* 自分のプロセスグループで起動する。next dev は next-server を子として起こし、親だけを止めると子が残る */
  S.dev = spawn(process.execPath, [bin, 'dev', '-p', String(DEV_PORT), '-H', '127.0.0.1'], { cwd: FIXTURE, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const devLog = fs.createWriteStream(path.join(REPO, 'poc/out/edit-dev.log'));
  S.dev.stdout.pipe(devLog); S.dev.stderr.pipe(devLog);
  S.dev.on('exit', (c) => { S.devReady = false; log('dev', `開発サーバーが終了しました（${c}）`); });
}
async function waitDev() {
  for (let i = 0; i < 120; i++) {
    const ok = await new Promise((r) => {
      const q = http.get({ host: '127.0.0.1', port: DEV_PORT, path: '/properties' }, (res) => { res.resume(); r(res.statusCode === 200); });
      q.on('error', () => r(false));
    });
    if (ok) { S.devReady = true; return; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('題材の開発サーバーが起動しませんでした（poc/out/edit-dev.log）');
}

/* ------------------------------------------------------------- 中継 */
class Inject extends Transform {
  constructor(tag) { super(); this.tag = tag; this.buf = ''; this.done = false; }

  _transform(chunk, _e, cb) {
    if (this.done) { cb(null, chunk); return; }
    this.buf += chunk.toString('latin1');
    const m = /<head(\s[^>]*)?>/i.exec(this.buf);
    if (m) {
      const at = m.index + m[0].length;
      this.push(Buffer.from(this.buf.slice(0, at), 'latin1'));
      this.push(Buffer.from(this.tag, 'utf8'));
      this.push(Buffer.from(this.buf.slice(at), 'latin1'));
      this.buf = ''; this.done = true; cb(); return;
    }
    if (this.buf.length > 65536) { this.push(Buffer.from(this.buf, 'latin1')); this.buf = ''; this.done = true; }
    cb();
  }

  _flush(cb) { if (this.buf) this.push(Buffer.from(this.buf, 'latin1')); cb(); }
}
const relayHostOk = (h) => h === `127.0.0.1:${RELAY_PORT}` || h === `localhost:${RELAY_PORT}`;
const SEC = { 'content-security-policy': `frame-ancestors ${UI_ORIGIN}`, 'x-content-type-options': 'nosniff' };

const relay = http.createServer((req, res) => {
  const url = req.url ?? '';
  if (!url.startsWith('/')) { res.writeHead(400); res.end('absolute-form は受けません'); return; }
  if (!relayHostOk(req.headers.host)) { res.writeHead(421); res.end('許可していないホスト名です'); return; }
  if (url.split('?')[0] === '/__vcide_edit/agent.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', ...SEC });
    res.end(fs.readFileSync(path.join(PUB, 'edit-agent.js'), 'utf8').replaceAll('__PARENT_ORIGIN__', UI_ORIGIN));
    return;
  }
  if (!S.devReady) { res.writeHead(503, SEC); res.end('開発サーバーは実行中ではありません'); return; }
  const up = http.request({ host: '127.0.0.1', port: DEV_PORT, method: req.method, path: url, headers: forwardHeaders(req.headers, DEV_PORT) }, (u) => {
    const headers = { ...u.headers };
    for (const k of ['connection', 'keep-alive', 'transfer-encoding']) delete headers[k];
    const csp = headers['content-security-policy'];
    headers['content-security-policy'] = csp ? [].concat(csp, SEC['content-security-policy']) : SEC['content-security-policy'];
    headers['x-content-type-options'] = 'nosniff';
    const html = /^text\/html/i.test(String(u.headers['content-type'] ?? '')) && req.method === 'GET' && !u.headers['content-encoding'];
    if (html) {
      delete headers['content-length'];
      /* 文書ごとに: この起動のインスタンス・応答の時点のコードの版・文書の識別子 */
      const tag = `<script src="/__vcide_edit/agent.js" data-instance="${S.instance}" data-rev="${rev().id}" data-doc="${crypto.randomBytes(16).toString('hex')}"></script>`;
      res.writeHead(u.statusCode ?? 502, headers);
      u.pipe(new Inject(tag)).pipe(res);
    } else { res.writeHead(u.statusCode ?? 502, headers); u.pipe(res); }
  });
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('開発サーバーに接続できませんでした'); } else res.destroy(); });
  req.pipe(up);
});
relay.on('upgrade', (req, socket, head) => {
  const refuse = (c, m) => socket.end(`HTTP/1.1 ${c} ${m}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  if (!(req.url ?? '').startsWith('/') || !relayHostOk(req.headers.host)) { refuse(421, 'Misdirected Request'); return; }
  /* 試験用の故障: HMR の WebSocket を通さない（POC_EDIT_FAULTS=1 のときだけ） */
  if (S.hmrBlocked) { refuse(503, 'Service Unavailable'); return; }
  const up = net.connect(DEV_PORT, '127.0.0.1');
  up.once('connect', () => {
    const h = forwardHeaders(req.headers, DEV_PORT, { upgrade: true });
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(h)) for (const one of [].concat(v)) if (one !== undefined) lines.push(`${k}: ${one}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
    S.hmrSockets.add(socket);
  });
  const end = () => { up.destroy(); socket.destroy(); S.hmrSockets.delete(socket); };
  up.on('error', end); socket.on('error', end); socket.on('close', end);
});

/* ------------------------------------------------- 対応表の利用箇所 */
function manifestFiles() {
  const dir = anchors.anchorOutDir(FIXTURE);
  return fs.readdirSync(dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).map((n) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}
/**
 * コンポーネントの利用箇所（静的に検出できたもの）。対応表の usages を、**いまのソースの読み直し**で確かめる
 * （古い記述は捨てる）。描画回数とは別の数（ソース上の事実）。
 */
function usagesInManifest(component) {
  const out = [];
  for (const m of manifestFiles()) {
    for (const u of m.usages ?? []) {
      if (u.component !== component) continue;
      const abs = E.safePath(FIXTURE, u.file);
      if (!abs) continue;
      const line = fs.readFileSync(abs, 'utf8').split('\n')[u.line - 1] ?? '';
      if (line.slice(u.col - 1).startsWith(`<${component}`)) out.push({ file: u.file, line: u.line, inComponent: u.inComponent });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
/**
 * 対応表は**コンパイルされたファイルの分しか無い**（Turbopack は開いたページだけをコンパイルする）。
 * 開いていない /favorites の利用箇所が抜けるため、PoC-03 の純粋変換（poc/anchor/transform.cjs）を
 * src/ の全 .tsx に当てて、コンパイルに依らない静的な利用箇所を数える。import の解決・動的な利用・
 * 名前の付け替え（import { PropertyCard as Card }）は見ない — 網羅は保証しない。
 */
const { transform: anchorTransform } = require('../anchor/transform.cjs');
function usagesStatic(component) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.tsx$/.test(e.name)) {
        const rel = path.relative(FIXTURE, abs).split(path.sep).join('/');
        for (const u of anchorTransform(fs.readFileSync(abs, 'utf8'), rel).usages) {
          if (u.component === component) out.push({ file: u.file, line: u.line, inComponent: u.inComponent });
        }
      }
    }
  };
  walk(path.join(FIXTURE, 'src'));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
function usagesOf(component) {
  const st = usagesStatic(component);
  const mf = usagesInManifest(component);
  return Object.assign(st, { manifestCount: mf.length, method: 'static-scan' });
}
/** 同じクラスの並びを持つ別の要素（無関係な要素が変わらないことの確認に使う）。いまのソースで照合したものだけ */
function sameClassElsewhere(anchor, tokens) {
  const out = [];
  for (const [id, a] of anchors.readManifest(anchors.anchorOutDir(FIXTURE))) {
    if (id === anchor.id || anchors.anchorIdOf(a.file, a.line, a.col) !== id) continue;
    const abs = E.safePath(FIXTURE, a.file);
    if (!abs) continue;
    const cs = E.classSummary(fs.readFileSync(abs, 'utf8'), a.file, a);
    if (cs.ok && cs.tokens.join(' ') === tokens.join(' ')) out.push({ id, file: a.file, line: a.line, component: a.component });
  }
  return out;
}

const tokenPx = (tok) => {
  const m = /^(?:[a-z0-9]+:)?p-(\d+(?:\.5)?)$/.exec(tok);
  return m && S.theme?.spacing?.px ? Number(m[1]) * S.theme.spacing.px : null;
};
const overridesWithPx = (overrides) => overrides.map((t) => {
  const v = t.split(':')[0];
  return { token: t, variant: v, minPx: S.theme?.breakpoints?.[v]?.px ?? null, px: tokenPx(t) };
});

/* ---------------------------------------------------------------- API */
function editInfo(anchor) {
  const abs = E.safePath(FIXTURE, anchor.file);
  const src = fs.readFileSync(abs, 'utf8');
  const cs = E.classSummary(src, anchor.file, anchor);
  const usages = usagesOf(anchor.component);
  const usageCount = { staticScan: usages.length, manifestOnly: usages.manifestCount, note: '静的に検出できた数（網羅は保証しない）。manifestOnly は開いたページの対応表だけで数えた場合' };
  if (!cs.ok) return { usageCount, editable: { state: 'not-editable', reason: cs.reason, detail: cs.detail }, usages, class: null };
  if (cs.basePadding.length !== 1) {
    return { usageCount, editable: { state: 'not-editable', reason: cs.basePadding.length ? 'token-ambiguous' : 'token-not-found', detail: cs.basePadding.length ? E.REASON['token-ambiguous'] : 'この要素には基本の余白（p-*）の指定がありません' }, usages, class: cs };
  }
  const shared = usages.length > 1;
  return {
    usageCount,
    editable: shared
      ? { state: 'conditional', reason: 'shared-definition', detail: `部品の定義を変えるため、検出できた利用箇所 ${usages.length} 件すべてに効きます（網羅は保証しません）` }
      : { state: 'editable', reason: null, detail: null },
    usages,
    class: { ...cs, overrides: overridesWithPx(cs.overrides), basePx: tokenPx(cs.basePadding[0]) },
    sameClass: sameClassElsewhere(anchor, cs.tokens),
  };
}

function draftView() {
  const d = S.draft;
  if (!d) return null;
  const abs = E.safePath(FIXTURE, d.rel);
  const cur = fs.readFileSync(abs, 'utf8');
  const curHash = E.sha256(cur);
  let diff = null;
  let diffHash = null;
  let problem = null;
  if (!d.draft.isNoop) {
    if (curHash !== d.draft.baseHash) problem = { reason: 'external-change', detail: '変更案を作った後に、このファイルが変わりました。差分を作り直して確認してください（再確認）。' };
    else {
      const loc = E.locateClassToken(cur, d.rel, d.anchor, d.draft.from, d.draft.value);
      if (!loc.ok) problem = { reason: loc.reason, detail: loc.detail };
      else {
        diff = E.unifiedDiff(d.rel, cur, E.patchToken(cur, loc, d.draft.from, d.draft.value)).text;
        diffHash = E.sha256(`${d.draft.baseHash}\n${diff}`).slice(0, 16);
      }
    }
  }
  const tokens = d.classTokens.map((t) => (t === d.draft.from ? d.draft.value : t));
  return {
    id: d.draft.id, rel: d.rel, anchor: d.anchor, from: d.draft.from, value: d.draft.value, isNoop: d.draft.isNoop,
    canUndo: d.draft.canUndo, canRedo: d.draft.canRedo, baseHash: d.draft.baseHash, currentHash: curHash,
    upToDate: curHash === d.draft.baseHash, diff, diffHash, problem, tokens, valuePx: tokenPx(d.draft.value),
    createdAt: d.createdAt,
  };
}

function appliedView(a) {
  const { before: _b, ...rest } = a;
  return rest;
}

function stateView() {
  const r = rev();
  return {
    instance: S.instance, startedAt: S.startedAt, faults: FAULTS, relayOrigin: RELAY_ORIGIN, devReady: S.devReady,
    revision: { id: r.id, files: r.files.length, ms: r.ms },
    theme: S.theme, anchorSupport: support(),
    draft: draftView(), applied: S.applied.map(appliedView),
    observation: { ...S.observation, freshness: E.observationFreshness(S.observation, r.id, S.writes) },
    hmrBlocked: S.hmrBlocked, log: S.log.slice(-40),
  };
}

/** 検証: 各アートボードで測った値と、設定から求めた期待値を比べる。**予測の表示は受け取らない** */
function verify(a, body) {
  const phase = body.phase === 'revert' ? 'revert' : 'apply';
  const newTok = phase === 'apply' ? a.to : a.from;
  const oldTok = phase === 'apply' ? a.from : a.to;
  const record = { phase, rerender: body.rerender, at: new Date().toISOString(), artboards: [], checks: [] };
  const expectRev = phase === 'apply' ? a.revAfter : a.revert?.revAfter;
  const fail = (m) => record.checks.push({ ok: false, m });
  const pass = (m) => record.checks.push({ ok: true, m });
  if (body.rerender === 'timeout') {
    record.verify = 'not-verified';
    record.reason = '再描画を確認できませんでした（HMR の更新が届かない、または時間切れ）。表示は書き込み前のコードのままの可能性があります。';
    return record;
  }
  for (const ab of body.artboards ?? []) {
    const md = Math.min(...a.overrides.map((o) => o.minPx ?? Infinity));
    const expectPx = ab.vw < md ? tokenPx(newTok) : (a.overrides.find((o) => o.minPx !== null && ab.vw >= o.minPx)?.px ?? tokenPx(newTok));
    const items = ab.items ?? [];
    const allPad = items.every((it) => it.pad.every((p) => Math.abs(p - expectPx) < 0.01));
    const allTok = items.every((it) => it.has[newTok] === true && it.has[oldTok] === false);
    const ctrl = ab.control ?? [];
    const ctrlExpect = ab.vw < md ? tokenPx(a.from) : (a.overrides.find((o) => ab.vw >= o.minPx)?.px ?? tokenPx(a.from));
    const ctrlOk = ctrl.every((it) => it.pad.every((p) => Math.abs(p - ctrlExpect) < 0.01) && it.has[a.from] === true && it.has[a.to] === false);
    const docOk = ab.reloaded ? ab.docRev === expectRev : true;
    record.artboards.push({ name: ab.name, vw: ab.vw, docRev: ab.docRev, count: items.length, expectPx,
      measured: [...new Set(items.map((it) => it.pad.join('/')))], controlCount: ctrl.length, controlExpectPx: ctrlExpect,
      controlMeasured: [...new Set(ctrl.map((it) => it.pad.join('/')))] });
    (items.length > 0 ? pass : fail)(`${ab.name}: 対象の描画 ${items.length} 件を測った`);
    (allTok ? pass : fail)(`${ab.name}: 全描画が ${newTok} を持ち ${oldTok} を持たない（新しいコードの描画）`);
    (allPad ? pass : fail)(`${ab.name}: 計算済み padding = ${expectPx}px（測定 ${record.artboards.at(-1).measured.join(', ')}）`);
    (ctrl.length > 0 && ctrlOk ? pass : fail)(`${ab.name}: 同じクラスの無関係な要素 ${ctrl.length} 件は ${a.from}・${ctrlExpect}px のまま`);
    (docOk ? pass : fail)(ab.reloaded
      ? `${ab.name}: 再読み込みした文書の版 ${ab.docRev} = 期待する版 ${expectRev}`
      : `${ab.name}: HMR（文書は版 ${ab.docRev} のまま DOM が更新された。版の対応は token の有無で確かめた）`);
  }
  record.verify = record.checks.length && record.checks.every((c) => c.ok) ? 'passed' : 'failed';
  record.verifiedRevision = record.verify === 'passed' ? expectRev : null;
  return record;
}

async function api(req, res, url, body) {
  const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(j)); };
  const p = url.pathname;

  if (p === '/api/state') return send(200, stateView());

  if (p === '/api/resolve') {
    if (body.instance !== S.instance) return send(409, { status: 'unresolved', reason: 'stale-instance', detail: '別の起動の文書から来た選択です。' });
    const sel = parseSelection(body.selection);
    if (!sel) return send(400, { status: 'unresolved', reason: 'bad-selection' });
    const r = anchors.resolveSelection(FIXTURE, support(), sel);
    if (r.status !== 'resolved') {
      log('resolve', `特定できません: ${r.reason}`);
      return send(200, { status: 'unresolved', reason: r.reason, detail: r.detail, context: r.context });
    }
    const info = editInfo(r.anchor);
    S.resolved.set(r.anchor.id, { anchor: r.anchor, at: Date.now() });
    log('resolve', `${r.anchor.component} <${r.anchor.tag}> ${r.anchor.file}:${r.anchor.line}:${r.anchor.col}（${sel.anchorOrdinal + 1}/${sel.anchorInstanceCount}）`);
    return send(200, { status: 'resolved', anchor: r.anchor, chain: r.chain, checks: r.checks, ordinal: sel.anchorOrdinal, count: sel.anchorInstanceCount, ...info });
  }

  if (p === '/api/draft') {
    const hit = S.resolved.get(body.anchorId);
    if (!hit) return send(409, { error: 'not-resolved', detail: 'この起動で照合していない要素です。選び直してください。' });
    const a = hit.anchor;
    if (S.draft && S.draft.anchor.id !== a.id) return send(409, { error: 'other-draft', detail: '別の要素の下書きがあります（この PoC は下書き1件まで）。' });
    if (!S.draft) {
      const info = editInfo(a);
      if (info.editable.state === 'not-editable') return send(422, { error: info.editable.reason, detail: info.editable.detail });
      const src = fs.readFileSync(E.safePath(FIXTURE, a.file), 'utf8');
      S.draft = {
        anchor: a, rel: a.file, classTokens: info.class.tokens, overrides: info.class.overrides, createdAt: new Date().toISOString(),
        draft: new E.Draft({ id: `d-${crypto.randomBytes(4).toString('hex')}`, rel: a.file, anchor: a, from: info.class.basePadding[0], baseHash: E.sha256(src) }),
      };
    }
    const d = S.draft;
    if (body.to !== d.draft.from) {
      const src = fs.readFileSync(E.safePath(FIXTURE, a.file), 'utf8');
      const loc = E.locateClassToken(src, a.file, a, d.draft.from, body.to);
      if (!loc.ok) return send(422, { error: loc.reason, detail: loc.detail });
    }
    d.draft.set(body.to);
    log('draft', `下書き: ${d.draft.from} → ${d.draft.value}（ファイルは未変更）`);
    return send(200, { draft: draftView() });
  }
  if (p === '/api/draft/undo' || p === '/api/draft/redo') {
    if (!S.draft) return send(409, { error: 'no-draft' });
    if (p.endsWith('undo')) S.draft.draft.undo(); else S.draft.draft.redo();
    log('draft', `下書きの${p.endsWith('undo') ? '取り消し（Undo）' : 'やり直し（Redo）'}: 値 ${S.draft.draft.value}（ファイルは未変更）`);
    return send(200, { draft: draftView() });
  }
  if (p === '/api/draft/discard') { S.draft = null; log('draft', '下書きを破棄しました（ファイルは未変更）'); return send(200, { draft: null }); }
  if (p === '/api/draft/recheck') {
    const d = S.draft;
    if (!d) return send(409, { error: 'no-draft' });
    const src = fs.readFileSync(E.safePath(FIXTURE, d.rel), 'utf8');
    const cs = E.classSummary(src, d.rel, d.anchor);
    if (!cs.ok || !cs.tokens.includes(d.draft.from)) {
      log('recheck', `再確認できません: ${cs.ok ? 'token-not-found' : cs.reason}`);
      return send(409, { error: 'needs-reselect', reason: cs.ok ? 'token-not-found' : cs.reason, detail: `${cs.ok ? E.REASON['token-not-found'] : cs.detail}。要素を選び直してください。` });
    }
    d.draft.baseHash = E.sha256(src);
    d.classTokens = cs.tokens;
    log('recheck', `いまの内容で差分を作り直しました（基準 ${d.draft.baseHash.slice(0, 8)}）`);
    return send(200, { draft: draftView() });
  }
  if (p === '/api/predict-css') {
    const d = S.draft;
    if (!d) return send(409, { error: 'no-draft' });
    const tokens = d.classTokens.map((t) => (t === d.draft.from ? d.draft.value : t));
    const out = await TW.predictCss(FIXTURE, tokens, 'data-vcide-predict');
    return send(200, { anchor: d.anchor.id, from: d.draft.from, to: d.draft.value, css: out.css, rules: out.rules, revision: rev().id });
  }

  if (p === '/api/apply') {
    const d = S.draft;
    if (!d || d.draft.id !== body.draftId) return send(409, { error: 'no-draft' });
    if (d.draft.isNoop) return send(409, { error: 'noop' });
    const v = draftView();
    if (!v.upToDate) { log('apply', '適用しません: 変更案を作った後にファイルが変わりました'); return send(409, { status: 'conflict', reason: 'external-change', detail: v.problem.detail, written: false }); }
    if (v.problem) return send(409, { status: 'conflict', reason: v.problem.reason, detail: v.problem.detail, written: false });
    if (body.baseHash !== v.baseHash || body.diffHash !== v.diffHash) {
      log('apply', '適用しません: 確認した差分と、いまの差分が一致しません');
      return send(409, { status: 'conflict', reason: 'diff-not-reviewed', detail: '確認した差分と、いまの差分が一致しません。差分を確認し直してください。', written: false });
    }
    const src = fs.readFileSync(E.safePath(FIXTURE, d.rel), 'utf8');
    const loc = E.locateClassToken(src, d.rel, d.anchor, d.draft.from, d.draft.value);
    S.draftControls = sameClassElsewhere(d.anchor, E.classSummary(src, d.rel, d.anchor).tokens);
    const revBefore = rev().id;
    const r = E.applyOne({ root: FIXTURE, rel: d.rel, baseHash: d.draft.baseHash, start: loc.start, end: loc.end, from: d.draft.from, to: d.draft.value });
    if (!r.written) { log('apply', `書き込みませんでした: ${r.reason}`); return send(409, { status: r.status, reason: r.reason, detail: r.detail, written: false }); }
    const revAfter = rev().id;
    const at = Date.now();
    S.writes.push({ at, rev: revAfter, what: 'apply' });
    const a = {
      id: `a-${crypto.randomBytes(4).toString('hex')}`, rel: d.rel, anchor: d.anchor, from: d.draft.from, to: d.draft.value,
      beforeHash: r.beforeHash, afterHash: r.afterHash, before: r.before, range: r.range, revBefore, revAfter,
      appliedAt: new Date(at).toISOString(), overrides: d.overrides, diff: v.diff,
      /* 変わってはならない無関係な要素（適用前のクラスの並びで決める。適用後は並びが変わるので探し直さない） */
      controls: S.draftControls ?? [],
      status: { write: r.status === 'applied' ? 'written-verified' : r.status, rerender: 'waiting', verify: 'not-verified' },
      verifications: [], revert: null,
    };
    S.applied.push(a);
    S.draft = null;
    log('apply', `書き込みました: ${d.rel} ${a.from} → ${a.to}（版 ${revBefore} → ${revAfter}・読み直して一致）`);
    return send(200, { applied: appliedView(a) });
  }

  if (p === '/api/verify') {
    const a = S.applied.find((x) => x.id === body.appliedId);
    if (!a) return send(404, { error: 'no-applied' });
    const v = verify(a, body);
    a.verifications.push(v);
    if (v.phase === 'apply') { a.status.rerender = body.rerender === 'timeout' ? 'not-confirmed' : body.rerender; a.status.verify = v.verify; }
    else if (a.revert) { a.revert.rerender = body.rerender === 'timeout' ? 'not-confirmed' : body.rerender; a.revert.verify = v.verify; }
    log('verify', `${v.phase === 'apply' ? '適用' : '取り消し'}の検証: 再描画=${body.rerender} 検証=${v.verify}`);
    return send(200, { verification: v, applied: appliedView(a) });
  }

  if (p === '/api/revert') {
    const a = S.applied.find((x) => x.id === body.appliedId);
    if (!a) return send(404, { error: 'no-applied' });
    const r = E.revertOne(a, FIXTURE);
    if (!r.written) {
      log('revert', `取り消しませんでした: ${r.status}`);
      return send(409, { status: r.status, detail: r.detail ?? null, diffSinceApply: r.diffSinceApply ?? null, written: false });
    }
    const revAfter = rev().id;
    S.writes.push({ at: Date.now(), rev: revAfter, what: 'revert' });
    a.revert = { status: r.status, at: new Date().toISOString(), revAfter, rerender: 'waiting', verify: 'not-verified' };
    log('revert', `適用を取り消しました: ${a.rel} ${a.to} → ${a.from}（版 → ${revAfter}・読み直して一致）`);
    return send(200, { applied: appliedView(a) });
  }

  if (p === '/api/test/hmr' && FAULTS) {
    S.hmrBlocked = !!body.blocked;
    if (S.hmrBlocked) for (const s of S.hmrSockets) s.destroy();
    log('fault', `試験用: HMR の WebSocket を${S.hmrBlocked ? '遮断' : '再開'}`);
    return send(200, { hmrBlocked: S.hmrBlocked });
  }
  return send(404, { error: 'not-found' });
}

const ui = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', UI_ORIGIN);
  if (req.headers.host !== `127.0.0.1:${UI_PORT}`) { res.writeHead(421); res.end(); return; }
  if (url.pathname.startsWith('/api/')) {
    /* API の入口の防御: 同じ origin・この起動のセッション・JSON だけ */
    if (req.headers['x-poc-session'] !== S.session) { res.writeHead(403); res.end('{"error":"session"}'); return; }
    if (req.method === 'POST' && (req.headers.origin !== UI_ORIGIN || !/^application\/json/.test(String(req.headers['content-type'])))) { res.writeHead(403); res.end('{"error":"origin"}'); return; }
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = buf ? JSON.parse(buf) : {}; } catch { res.writeHead(400); res.end(); return; }
      api(req, res, url, body).catch((e) => { log('error', String(e.stack || e)); res.writeHead(500); res.end(JSON.stringify({ error: String(e.message) })); });
    });
    return;
  }
  const files = { '/': 'ui.html', '/ui.js': 'ui.js', '/ui.css': 'ui.css', '/protocol.js': 'protocol.js' };
  const f = files[url.pathname];
  if (!f) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(path.join(PUB, f), 'utf8');
  if (f === 'ui.html') body = body.replace('__CONFIG__', Buffer.from(JSON.stringify({ relayOrigin: RELAY_ORIGIN, session: S.session, instance: S.instance })).toString('base64'));
  res.writeHead(200, {
    'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.css') ? 'text/css' : 'text/javascript',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'self'; frame-src ${RELAY_ORIGIN}; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`,
  });
  res.end(body);
});

/* ------------------------------------------------------------- 起動 */
const listen = (srv, port) => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); });
function killDev(sig) {
  if (!S.dev?.pid) return;
  try { process.kill(-S.dev.pid, sig); } catch { /* 終了済み */ }
}
function shutdown() {
  killDev('SIGTERM');
  relay.close(); ui.close();
}
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });
process.on('exit', () => killDev('SIGKILL'));
process.on('uncaughtException', (e) => { console.error(e); killDev('SIGKILL'); process.exit(1); });

fs.mkdirSync(path.join(REPO, 'poc/out'), { recursive: true });
/* 既に誰かが待ち受けているポートでは始めない（古い開発サーバーと話してしまうのを防ぐ） */
for (const port of [DEV_PORT, RELAY_PORT, UI_PORT]) {
  const busy = await new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
  if (busy) { console.error(`ポート ${port} は既に使われています。古いハーネス・開発サーバーを止めてください。`); process.exit(2); }
}
if (support().state !== 'enabled') { console.error(support().reason); process.exit(2); }
await listen(relay, RELAY_PORT);
await listen(ui, UI_PORT);
startDev();
await waitDev();
S.theme = await TW.readTheme(FIXTURE);
S.observation = { revision: rev().id, at: Date.now(), note: '鮮度の検証用の記録。中身（通信・SQL・由来）は持たない' };
log('ready', `検証用画面 ${UI_ORIGIN} / 中継 ${RELAY_ORIGIN} / 題材 127.0.0.1:${DEV_PORT}（版 ${S.observation.revision}）`);
console.log(`POC_EDIT_READY ${UI_ORIGIN}`);
