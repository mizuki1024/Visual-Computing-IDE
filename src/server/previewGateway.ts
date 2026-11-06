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
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
import {
  ideFrameAncestors, isAllowedPreviewHost, isIdeOrigin, type AccessConfig,
} from './access';
import {
  RELAY_ID_HEADER, RELAY_TRACE_HEADER, classifyRelayRequest, parseTraceparent, type LiveExchange,
} from '../lib/liveObservation';
import { PROTOCOL_VERSION } from '../lib/previewProtocol';
import { EDIT_DOC_HEADER, EDIT_EXT_VERSION, STYLE_PROPS } from '../lib/editPreviewProtocol';

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
  /**
   * Phase 7B-3A: 転送先の起動の鍵（instance:pid:startedAt）。観測の記録をこの起動に紐づける。
   * 省略時は記録しない
   */
  run?: string;
}

/** Phase 7B-3A: 中継が転送した通信1件の記録。**パス・状態・時刻・トレース識別子だけ** */
export type RelayRecord = Omit<LiveExchange, 'seq' | 'relayId' | 'docToken'>;
export interface RelayObserver {
  /**
   * `meta.relayId`（7B-3B-1）は、中継がこの要求のために作って開発サーバーへ載せた識別子。
   * 記録そのもの（`rec`）とは別に渡す（記録の形は 7B-3A のまま）
   *
   * `meta.docToken`（7B-3B-2）は、中継が **HTML の応答1つごと**に作り、その応答に差し込んだ
   * スクリプトの属性に書いた識別子。iframe の文書がこの値を知らせてくるので、
   * 「いま表示している文書は、どの通信の応答か」を照合できる。`relayId` とは別の乱数で、
   * 開発サーバーには送らない（ブラウザには文書の識別子だけが渡り、中継の内部の識別子は渡らない）
   *
   * `meta.initiatorDoc`（E2.1。`editSync` のときだけ）は、RSC の要求に**文書のスクリプトが申告した**、要求を出した文書の識別子
   * （`x-vcide-doc`）。中継が記録したのは「この識別子を名乗る要求が実際に中継を通った」ことで、名乗りそのものはスクリプトの申告
   * （アプリと同じ JavaScript の世界）。探索の記録（observations）はこれを読まない。ヘッダは開発サーバーへ渡さない
   */
  record(run: string, rec: RelayRecord, meta?: { relayId?: string; docToken?: string; initiatorDoc?: string }): void;
  /** 静的資材。通信として数えず、件数だけ */
  excludeStatic(run: string): void;
}

export interface GatewayOptions {
  config: AccessConfig;
  /** 転送先。実行中でなければ null と、その理由 */
  target: () => { target: GatewayTarget | null; reason: string };
  /** テスト用。省略時は config.previewPort から探す */
  port?: number;
  /** Phase 7B-3A: 転送した通信の記録先。省略時は記録しない */
  observer?: RelayObserver;
  /**
   * E2.1: 編集の同期の開発用の画面のための知らせを有効にする（既定は無効。docs/08d 第4節）。
   * 無効なら、差し込むスクリプトは E2 までと**1バイトも違わない**（tests/edit-sync21-unit が確かめる）
   */
  editSync?: boolean;
}

/* --------------------------------------------------------------- 埋め込む部品 */

/** スクリプトが「親（IDE の画面）として受け入れてよい」origin の型。frame-ancestors と同じ範囲 */
export function parentPatterns(cfg: AccessConfig): { s: string; h: string; p: string }[] {
  return ideFrameAncestors(cfg).map((o) => {
    const m = /^(https?:)\/\/([^/:]+)(?::(\*|\d+))?$/.exec(o);
    return m ? { s: m[1], h: m[2].toLowerCase(), p: m[3] ?? '' } : null;
  }).filter((x): x is { s: string; h: string; p: string } => !!x);
}

/**
 * プレビューのページに差し込む小さなスクリプト（Phase 7B-1 で場所の知らせ、7B-2 で要素の選択）。
 * 中継の origin から配る（インラインにしない。対象のアプリの CSP が 'self' を許すなら動く）。
 *
 * 通信（src/lib/previewProtocol.ts）
 *   1. 親へ `hello` だけを送る（中身なし）。宛先は location.ancestorOrigins が使えればその origin、
 *      使えない（Firefox）ときだけ '*'。どちらにせよ中身を持たない
 *   2. 親から `connect` と MessagePort を受け取る。**送り主が親の window で、origin が IDE の画面として
 *      許した範囲**のときだけ受ける。受けた知らせはアプリのリスナーに渡さない（最初に登録した
 *      リスナーで止める）ので、アプリのスクリプトはこの port を手にできない
 *   3. 以後の知らせ（場所・選択）はその port だけで送る
 *
 * 送るもの: パス・タイトル・最初の文書の HTTP 状態・要素識別子・ソースの版（内容のハッシュ。F-01）・タグ名・何番目か・
 * テキストの文字数と文字種。**本文・属性・フォームの値・Cookie は送らない。**
 * 選択は、選択モードのときの利用者の本物のクリック（isTrusted）だけで起こる。
 */
export function agentJs(cfg: AccessConfig, opts: { editSync?: boolean } = {}): string {
  const E = opts.editSync ? editAgentParts() : { vars: '', click: '', fn: '', msg: '' };
  return `(function(){
  if (window.__vcidePreviewAgent) return; window.__vcidePreviewAgent = 1;
  var PARENTS = ${JSON.stringify(parentPatterns(cfg))};
  var W = window, P = W.parent, D = document;
  if (P === W) return;
  var s = D.currentScript, st = s && s.getAttribute('data-vcide-status');
  var status = st ? Number(st) : null, soft = false;
  /* 7B-3B-2: この文書の応答に中継が付けた識別子（応答ごとに別）。アプリのスクリプトより先に読む */
  var doc = s && s.getAttribute('data-vcide-doc');
  if (!doc || !/^[0-9a-f]{32}$/.test(doc)) doc = null;
  var pm = MessagePort.prototype.postMessage;
  var from = (s && s.getAttribute('data-vcide-from')) || 'app';
  /* アプリが後から書き換えても影響を受けないよう、使う関数を先に取っておく */
  var getAttr = Element.prototype.getAttribute, qsa = Document.prototype.querySelectorAll;
  var rect = Element.prototype.getBoundingClientRect, addL = W.addEventListener.bind(W);
  var ID = /^[0-9a-f]{10}$/, REV = /^[0-9a-f]{16}$/, port = null, nonce = null, queue = [], selecting = false, seq = 0;
  var hoverBox = null, selBox = null, hoverEl = null, selEl = null, raf = 0;${E.vars}
  function allowed(o){
    try { var u = new URL(o);
      for (var i = 0; i < PARENTS.length; i++) { var p = PARENTS[i];
        if (u.protocol === p.s && u.hostname === p.h && (p.p === '*' || u.port === p.p)) return true; }
    } catch (e) {}
    return false;
  }
  function post(m){ m.source = 'vcide-preview'; m.v = ${PROTOCOL_VERSION}; m.nonce = nonce; try { pm.call(port, m); } catch (e) {} }
  function send(m){ if (port) post(m); else if (queue.length < 20) queue.push(m); }
  function where(kind){
    send({ kind: kind, path: location.pathname + location.search + location.hash,
      title: String(D.title || '').slice(0, 300), status: soft ? null : status, soft: soft, from: from });
  }
  /* ---------------------------------------------------------- 要素の選択 */
  function anchorOf(el){ var v = getAttr.call(el, 'data-vcide'); return v && ID.test(v) ? v : null; }
  /* F-01: その要素を描いたときのソースの版。識別子と同じ要素の属性だけを読む（無ければ null） */
  function revOf(el){ var v = getAttr.call(el, 'data-vcide-rev'); return v && REV.test(v) ? v : null; }
  function cls(t){
    var j = /[\\u3040-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef]/.test(t), l = /[A-Za-z]/.test(t), d = /[0-9]/.test(t);
    if (j && !l && !d) return 'cjk'; if (j) return 'mixed';
    if (l) return d ? 'mixed' : 'latin'; if (d) return 'digits'; return 'other';
  }
  function describe(t){
    var el = t && t.nodeType === 3 ? t.parentElement : t;
    if (!el || el.nodeType !== 1) return null;
    var self = anchorOf(el), anc = [], ancRev = [], p = el.parentElement;
    while (p && anc.length < 32) { var a = anchorOf(p); if (a) { anc.push(a); ancRev.push(revOf(p)); } p = p.parentElement; }
    var ord = null, cnt = 0;
    if (self) { var all = qsa.call(D, '[data-vcide="' + self + '"]'); cnt = all.length;
      for (var i = 0; i < all.length; i++) if (all[i] === el) ord = i;
      if (ord === null) { self = null; cnt = 0; } }
    var tag = String(el.localName || '').slice(0, 64);
    var form = /^(input|textarea|select|option|button)$/.test(tag) || el.isContentEditable === true;
    var ti = null, shape = null, k = 0, kids = el.childNodes;
    /* 値そのものは送らない。数えるのは文字数と文字種だけ。フォームの部品は数えない */
    if (!form) for (var j = 0; j < kids.length && ti === null; j++) {
      if (kids[j].nodeType !== 3) continue;
      var v = String(kids[j].nodeValue || '').trim();
      if (v.length) { ti = k; shape = { chars: Math.min(v.length, 1000000), cls: cls(v) }; }
      k++;
    }
    return { tag: tag, anchorOnSelf: self, anchorRev: self ? revOf(el) : null, anchorOrdinal: ord, anchorInstanceCount: cnt,
      ancestorAnchors: anc, ancestorRevs: ancRev, textNodeIndex: ti, valueShape: shape, formControl: form, path: location.pathname };
  }
  function box(color){
    var b = D.createElement('div');
    b.setAttribute('data-vcide-overlay', '');
    b.setAttribute('aria-hidden', 'true');
    b.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;'
      + 'border:2px solid ' + color + ';background:' + color + '1a;border-radius:2px;display:none;left:0;top:0';
    D.documentElement.appendChild(b);
    return b;
  }
  function place(b, el){
    if (!b) return;
    if (!el || !el.isConnected) { b.style.display = 'none'; return; }
    var r = rect.call(el);
    b.style.display = 'block'; b.style.left = r.left + 'px'; b.style.top = r.top + 'px';
    b.style.width = r.width + 'px'; b.style.height = r.height + 'px';
  }
  function tick(){ place(hoverBox, hoverEl); place(selBox, selEl); raf = selecting ? requestAnimationFrame(tick) : 0; }
  function setMode(on){
    if (on === selecting) { post({ kind: 'mode', select: selecting }); return; }
    selecting = on;
    if (on) { hoverBox = hoverBox || box('#5a4fb0'); selBox = selBox || box('#1f7a52'); if (!raf) raf = requestAnimationFrame(tick); }
    else {
      hoverEl = null; selEl = null;
      if (hoverBox) hoverBox.remove(); if (selBox) selBox.remove(); hoverBox = selBox = null;
    }
    post({ kind: 'mode', select: selecting });
  }
  function block(e){ if (!selecting) return; e.preventDefault(); e.stopImmediatePropagation(); }
  ['pointerdown','pointerup','mousedown','mouseup','dblclick','auxclick','contextmenu','submit','touchstart','touchend']
    .forEach(function(t){ addL(t, block, { capture: true, passive: false }); });
  addL('click', function(e){
    if (!selecting) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.isTrusted || !port) return;          // 本物のクリックだけ。アプリが作ったクリックでは選ばない
    var d = describe(e.target);
    if (!d) return;
    selEl = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;${E.click}
    seq += 1;
    /* doc: この文書の応答の識別子。soft: この文書の中でクライアント側の遷移（pushState / popstate）があったか。
     * 遷移の後の DOM は文書の取得が描いたものではない（IDE は文書と同一視しない） */
    post({ kind: 'select', seq: seq, selection: d, doc: doc, soft: soft });
  }, true);
  addL('mousemove', function(e){ if (selecting) hoverEl = e.target; }, true);${E.fn}
  /* ------------------------------------------------------- 親との接続 */
  addL('message', function(e){
    var d = e.data;
    if (!d || d.source !== 'vcide-ide' || d.kind !== 'connect') return;
    e.stopImmediatePropagation();               // アプリのリスナーに port を渡さない
    if (port || e.source !== P || !allowed(e.origin) || !e.ports || e.ports.length !== 1) return;
    if (typeof d.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(d.nonce)) return;
    port = e.ports[0]; nonce = d.nonce;
    port.onmessage = function(m){
      var x = m.data;
      if (x && x.source === 'vcide-ide' && x.v === ${PROTOCOL_VERSION} && x.nonce === nonce && x.kind === 'mode' && typeof x.select === 'boolean') setMode(x.select);${E.msg}
    };
    post({ kind: 'connected' });
    for (var i = 0; i < queue.length; i++) post(queue[i]);
    queue = [];
  }, true);
  var ao = location.ancestorOrigins, target = ao && ao.length ? (allowed(ao[0]) ? ao[0] : null) : '*';
  if (target !== null) { try { P.postMessage({ source: 'vcide-preview', v: ${PROTOCOL_VERSION}, kind: 'hello' }, target); } catch (e) {} }
  var ps = history.pushState, rs = history.replaceState;
  history.pushState = function(){ var r = ps.apply(this, arguments); soft = true; where('navigate'); return r; };
  history.replaceState = function(){ var r = rs.apply(this, arguments); where('replace'); return r; };
  addL('popstate', function(){ soft = true; where('navigate'); });
  addL('hashchange', function(){ where('navigate'); });
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function(){ where('ready'); });
  else where('ready');
  addL('load', function(){ where('load'); });
})();
`;
}

/**
 * E2.1: 編集の同期のためにスクリプトへ足す部分（editSync のときだけ）。**探索の知らせ・選択の規則は変えない。**
 *   vars  : 編集の同期で選んだ要素（editEl）と、この文書が送った RSC の要求の数。fetch を包む（下記）
 *   click : 選択モードの本物のクリックで選んだ要素を editEl にも覚える（選択モードを抜けても観測できるように。探索の selEl とは別）
 *   fn    : 観測の答えを作る（選んだ要素の選択・矩形・許可した計算済みスタイル・文書の識別子・遷移の有無・RSC の数・ビューポート）
 *   msg   : IDE からの `edit-observe`（同じ port・同じ nonce・拡張の版 1）に答える。**求められたときだけ**送る
 * fetch の包み: 同じ origin への RSC の要求（rsc: 1 のヘッダ）にだけ、この文書の識別子を `x-vcide-doc` に載せ、数える。
 * それ以外の要求・識別子の無い文書では、元の fetch をそのまま呼ぶ。中継はこのヘッダを開発サーバーへ渡さない。
 */
function editAgentParts(): { vars: string; click: string; fn: string; msg: string } {
  const props = JSON.stringify(STYLE_PROPS);
  return {
    vars: `
  var editEl = null, rscS = 0, rscD = 0, gcs = W.getComputedStyle, FX = W.fetch, HP = Object.prototype.hasOwnProperty;
  if (typeof FX === 'function' && doc) {
    W.fetch = function(input, init){
      var a = arguments;
      try {
        var h = init && init.headers, isR = false;
        if (h && typeof h === 'object') {
          if (typeof Headers !== 'undefined' && h instanceof Headers) isR = h.get('rsc') === '1';
          else if (!Array.isArray(h)) { for (var k in h) if (HP.call(h, k) && String(k).toLowerCase() === 'rsc' && String(h[k]) === '1') isR = true; }
        }
        if (isR) {
          var u = new URL(typeof input === 'string' ? input : (input && input.url) ? input.url : String(input), location.href);
          if (u.origin === location.origin) {
            var nh = new Headers(h); nh.set('${EDIT_DOC_HEADER}', doc);
            var ni = {}; for (var j in init) ni[j] = init[j]; ni.headers = nh;
            rscS += 1;
            var pr = FX.call(W, input, ni), fin = function(){ rscD += 1; };
            pr.then(fin, fin);
            return pr;
          }
        }
      } catch (e) {}
      return FX.apply(W, a);
    };
  }`,
    click: `
    editEl = selEl;`,
    fn: `
  var EPROPS = ${props}, EVAL = /^[0-9a-zA-Z.,%()# -]{0,80}$/;
  function rd(v){ return Math.round(v * 100) / 100; }
  function editObserve(req){
    var st = 'none', d = null, r = null, cs = null;
    if (editEl) {
      if (!editEl.isConnected) st = 'detached';
      else {
        d = describe(editEl);
        if (d) {
          st = 'ok';
          var b = rect.call(editEl); r = { x: rd(b.left), y: rd(b.top), width: rd(b.width), height: rd(b.height) };
          cs = {}; var c = gcs.call(W, editEl);
          for (var i = 0; i < EPROPS.length; i++) { var v = String(c.getPropertyValue(EPROPS[i]) || ''); if (EVAL.test(v)) cs[EPROPS[i]] = v; }
        } else st = 'detached';
      }
    }
    post({ kind: 'edit-observation', ev: ${EDIT_EXT_VERSION}, req: req, state: st, selection: d, rect: r, style: cs,
      doc: doc, soft: soft, rsc: { started: rscS, settled: rscD }, vw: Math.round(W.innerWidth), vh: Math.round(W.innerHeight) });
  }`,
    msg: `
      if (x && x.source === 'vcide-ide' && x.v === ${PROTOCOL_VERSION} && x.nonce === nonce && x.kind === 'edit-observe' && x.ev === ${EDIT_EXT_VERSION} && typeof x.req === 'number' && x.req >= 1 && x.req % 1 === 0) editObserve(x.req);`,
  };
}

/** from: そのページを作ったのが開発サーバー（app）か、この中継（gateway）か */
const agentTag = (status: number, from: 'app' | 'gateway' = 'app', doc: string | null = null): string =>
  `<script src="${AGENT_PREFIX}agent.js" data-vcide-status="${status}" data-vcide-from="${from}"${doc ? ` data-vcide-doc="${doc}"` : ''}></script>`;

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
  /* 7B-3B-1: 中継の識別子はブラウザから受けない（ページのスクリプトが偽れないように、中継だけが付ける） */
  RELAY_ID_HEADER,
  /* E2.1: 文書のスクリプトが RSC の要求に載せる文書の識別子。中継が読むだけで、開発サーバーへは渡さない（editSync でなくても落とす） */
  EDIT_DOC_HEADER,
]);
const DROP_RES = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'trailer', 'upgrade',
]);

const headerOne = (v: string | string[] | undefined): string | undefined =>
  (Array.isArray(v) ? v[0] : v);

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
        res.end(agentJs(this.#opts.config, { editSync: this.#opts.editSync === true }));
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

    /* ------------------------------------------- Phase 7B-3A: 転送した通信の記録
     * 読む要求ヘッダは sec-fetch-dest と rsc の2つだけ（分類に使い、保存しない）。
     * URL はパスとクエリの有無だけにして、値は持たない */
    const observer = this.#opts.observer;
    const run = target.run;
    const cls = observer && run ? classifyRelayRequest(
      url, headerOne(req.headers['sec-fetch-dest']), headerOne(req.headers.rsc),
    ) : null;
    if (cls?.static && observer && run) observer.excludeStatic(run);
    const t0 = Date.now();
    let traced: RelayRecord['trace'] = null;
    let status: number | null = null;
    let recorded = false;
    /* 7B-3B-2: HTML を差し込んだ応答にだけ作る文書の識別子（下の応答の処理で決める） */
    let docToken: string | null = null;
    /* 7B-3B-1: 記録する通信には、中継が自分で作った識別子を載せる（要求ごとに新しい乱数）。
     * 計装が受付スパンに写すので、応答のトレース識別子が別の要求を指していても見分けられる */
    const relayId = observer && run && cls && !cls.static ? randomBytes(16).toString('hex') : null;
    /* E2.1: RSC の要求に文書のスクリプトが申告した、要求を出した文書の識別子（editSync のときだけ読む。形が違えば無いものとする） */
    const declaredDoc = this.#opts.editSync && cls && !cls.static && cls.kind === 'rsc' ? headerOne(req.headers[EDIT_DOC_HEADER]) : undefined;
    const initiatorDoc = typeof declaredDoc === 'string' && /^[0-9a-f]{32}$/.test(declaredDoc) ? declaredDoc : null;
    const finish = (failure: RelayRecord['failure']) => {
      if (recorded || !observer || !run || !cls || cls.static) return;
      recorded = true;
      observer.record(run, {
        method: String(req.method ?? 'GET').toUpperCase().slice(0, 10),
        path: cls.path, hasQuery: cls.hasQuery, kind: cls.kind,
        status, startMs: t0, durationMs: failure ? null : Date.now() - t0,
        trace: traced, failure,
      }, relayId || docToken || initiatorDoc
        ? { ...(relayId ? { relayId } : {}), ...(docToken ? { docToken } : {}), ...(initiatorDoc ? { initiatorDoc } : {}) } : undefined);
    };
    res.once('finish', () => finish(null));
    res.once('close', () => { if (!res.writableFinished) finish({ kind: 'aborted', detail: '応答を送り終える前に接続が閉じられました' }); });

    const fwdHeaders = forwardHeaders(req.headers, target.port);
    if (relayId) fwdHeaders[RELAY_ID_HEADER] = relayId;
    const upstream = http.request({
      host: '127.0.0.1', port: target.port, method: req.method, path: url,
      headers: fwdHeaders,
    }, (up) => {
      status = up.statusCode ?? null;
      const headers: Record<string, string | string[] | number> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v === undefined || DROP_RES.has(k)) continue;
        /* 計装が付けたトレース識別子の専用ヘッダは、中継が読んで**ブラウザへは渡さない**。
         * ページの中のスクリプトからは見えない（PoC-05 で Server-Timing の公開範囲が広いと実測した） */
        if (k === RELAY_TRACE_HEADER) { traced = parseTraceparent(headerOne(v)); continue; }
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
      /* 記録する通信の HTML にだけ、文書の識別子を付ける（要求ごとの relayId とは別の乱数） */
      if (html && relayId) docToken = randomBytes(16).toString('hex');
      if (html) up.pipe(new InjectAgent(agentTag(up.statusCode ?? 0, 'app', docToken))).pipe(res);
      else up.pipe(res);
    });
    upstream.on('error', (e) => {
      // 開発サーバーから応答が無かった。中継の説明（502）は開発サーバーの応答ではないので状態は持たない
      finish({ kind: 'upstream-error', detail: (e as NodeJS.ErrnoException).code ?? 'connect-failed' });
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
