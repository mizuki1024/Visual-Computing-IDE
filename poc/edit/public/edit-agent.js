/* =============================================================================
 * 編集 PoC — アートボードの iframe の中で動く小さなスクリプト（中継が <head> の直後に差し込む）。
 * 製品の agentJs（src/server/previewGateway.ts）の接続手順をそのまま写し、次を足した:
 *   - 要素識別子ごとの矩形（iframe の CSS px）と計算済みの padding を測って返す（EP-17 候補）
 *   - 指定した token を各要素が持つかの真偽だけを返す（className の文字列そのものは送らない）
 *   - 適用前プレビュー（方式 A・予測）: 予測の印と、IDE が作った CSS を重ねる／外す
 *   - DOM の変化（HMR による再描画）を知らせる
 * 送らないもの: 本文・属性の値・フォームの値・Cookie。
 * 親の origin（下の PARENT_ORIGIN）は中継が配るときに埋める（IDE の画面の origin。1つだけ）。
 * ========================================================================== */
(function () {
  if (window.__vcideEditAgent) return; window.__vcideEditAgent = 1;
  var PARENT_ORIGIN = '__PARENT_ORIGIN__';
  var W = window, P = W.parent, D = document;
  if (P === W) return;
  var s = D.currentScript;
  var INSTANCE = s && s.getAttribute('data-instance');
  var REV = s && s.getAttribute('data-rev');
  var DOC = s && s.getAttribute('data-doc');
  if (!/^[0-9a-f]{16}$/.test(INSTANCE || '') || !/^[0-9a-f]{12}$/.test(REV || '') || !/^[0-9a-f]{32}$/.test(DOC || '')) return;
  /* アプリが後から書き換えても影響を受けないよう、使う関数を先に取っておく */
  var pm = MessagePort.prototype.postMessage, getAttr = Element.prototype.getAttribute;
  var qsa = Document.prototype.querySelectorAll, rect = Element.prototype.getBoundingClientRect;
  var gcs = W.getComputedStyle.bind(W), addL = W.addEventListener.bind(W);
  var ID = /^[0-9a-f]{10}$/, port = null, nonce = null, selecting = false, seq = 0;
  var PRED_ATTR = 'data-vcide-predict', predStyle = null, predSwap = [];

  function post(m) { m.source = 'vcide-edit-agent'; m.v = 1; m.nonce = nonce; m.instance = INSTANCE; try { pm.call(port, m); } catch (e) {} }
  function anchorOf(el) { var v = getAttr.call(el, 'data-vcide'); return v && ID.test(v) ? v : null; }
  function byAnchor(id) { return qsa.call(D, '[data-vcide="' + id + '"]'); }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    var self = anchorOf(el), anc = [], p = el.parentElement;
    while (p && anc.length < 32) { var a = anchorOf(p); if (a) anc.push(a); p = p.parentElement; }
    var ord = null, cnt = 0;
    if (self) { var all = byAnchor(self); cnt = all.length; for (var i = 0; i < all.length; i++) if (all[i] === el) ord = i; if (ord === null) { self = null; cnt = 0; } }
    var tag = String(el.localName || '').slice(0, 64);
    var form = /^(input|textarea|select|option|button)$/.test(tag) || el.isContentEditable === true;
    var ti = null, k = 0, kids = el.childNodes;
    if (!form) for (var j = 0; j < kids.length && ti === null; j++) { if (kids[j].nodeType !== 3) continue; if (String(kids[j].nodeValue || '').trim()) ti = k; k++; }
    /* 値の形（文字数・文字種）も編集 PoC では使わないので送らない */
    return { tag: tag, anchorOnSelf: self, anchorOrdinal: ord, anchorInstanceCount: cnt, ancestorAnchors: anc,
      textNodeIndex: ti, valueShape: null, formControl: form, path: location.pathname };
  }

  function measure(req, id, tokens) {
    var els = byAnchor(id), items = [];
    for (var i = 0; i < els.length && i < 1000; i++) {
      var r = rect.call(els[i]), cs = gcs(els[i]), has = {};
      for (var t = 0; t < tokens.length; t++) has[tokens[t]] = els[i].classList.contains(tokens[t]);
      items.push({ i: i, x: r.left, y: r.top, w: r.width, h: r.height,
        pad: [parseFloat(cs.paddingTop), parseFloat(cs.paddingRight), parseFloat(cs.paddingBottom), parseFloat(cs.paddingLeft)], has: has });
    }
    post({ kind: 'measure', req: req, anchor: id, items: items, vw: D.documentElement.clientWidth, vh: W.innerHeight, predicted: !!predStyle });
  }

  /* 予測を重ねる: 対象の要素に印を付け、token を差し替え、IDE がこの設定からコンパイルした CSS を足す */
  function predict(req, id, css, from, to) {
    unpredict();
    var els = byAnchor(id);
    for (var i = 0; i < els.length; i++) {
      els[i].setAttribute(PRED_ATTR, '');
      if (els[i].classList.contains(from)) { els[i].classList.remove(from); els[i].classList.add(to); predSwap.push(els[i]); }
    }
    predStyle = D.createElement('style');
    predStyle.setAttribute('data-vcide-overlay', 'predict');
    predStyle.textContent = css;
    D.head.appendChild(predStyle);
    post({ kind: 'predicted', req: req, on: true, n: els.length });
    predFrom = from; predTo = to;
  }
  var predFrom = null, predTo = null;
  function unpredict(req) {
    var marked = qsa.call(D, '[' + PRED_ATTR + ']');
    for (var i = 0; i < marked.length; i++) marked[i].removeAttribute(PRED_ATTR);
    for (var j = 0; j < predSwap.length; j++) { predSwap[j].classList.remove(predTo); predSwap[j].classList.add(predFrom); }
    predSwap = [];
    if (predStyle) { predStyle.remove(); predStyle = null; }
    if (req) post({ kind: 'predicted', req: req, on: false, n: marked.length });
  }

  function block(e) { if (!selecting) return; e.preventDefault(); e.stopImmediatePropagation(); }
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu', 'submit', 'touchstart', 'touchend']
    .forEach(function (t) { addL(t, block, { capture: true, passive: false }); });
  addL('click', function (e) {
    if (!selecting) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.isTrusted || !port) return;   // 本物のクリックだけ
    var el = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
    var d = describe(el);
    if (!d) return;
    seq += 1;
    post({ kind: 'select', seq: seq, selection: d });
  }, true);

  /* HMR などで DOM が変わったことだけを知らせる（中身は送らない） */
  var changes = 0, pending = 0;
  new MutationObserver(function (list) {
    var real = false;
    for (var i = 0; i < list.length; i++) {
      var t = list[i].target;
      if (list[i].attributeName === PRED_ATTR) continue;
      if (t && t.nodeType === 1 && t.getAttribute && t.getAttribute('data-vcide-overlay')) continue;
      real = true;
    }
    if (!real || !port) return;
    changes += 1;
    if (!pending) pending = setTimeout(function () { pending = 0; post({ kind: 'changed', n: changes }); }, 50);
  }).observe(D.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

  addL('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'vcide-edit-ide' || d.kind !== 'connect') return;
    e.stopImmediatePropagation();      // アプリのリスナーに port を渡さない
    if (port || e.source !== P || e.origin !== PARENT_ORIGIN || !e.ports || e.ports.length !== 1) return;
    if (typeof d.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(d.nonce)) return;
    port = e.ports[0]; nonce = d.nonce;
    port.onmessage = function (m) {
      var x = m.data;
      if (!x || x.source !== 'vcide-edit-ide' || x.v !== 1 || x.nonce !== nonce) return;
      var okReq = typeof x.req === 'number' && x.req > 0;
      if (x.kind === 'mode' && typeof x.select === 'boolean') { selecting = x.select; post({ kind: 'mode', select: selecting }); }
      else if (x.kind === 'measure' && okReq && ID.test(x.anchor) && Array.isArray(x.tokens) && x.tokens.length <= 16) measure(x.req, x.anchor, x.tokens.filter(function (t) { return typeof t === 'string' && /^[a-z0-9:.\-\[\]\/%]{1,40}$/.test(t); }));
      else if (x.kind === 'predict' && okReq && ID.test(x.anchor) && typeof x.css === 'string' && x.css.length < 65536) predict(x.req, x.anchor, x.css, x.from, x.to);
      else if (x.kind === 'unpredict' && okReq) unpredict(x.req);
      else if (x.kind === 'describe' && okReq && ID.test(x.anchor) && typeof x.ordinal === 'number') {
        var all = byAnchor(x.anchor);
        post({ kind: 'described', req: x.req, selection: all[x.ordinal] ? describe(all[x.ordinal]) : null });
      }
    };
    post({ kind: 'connected', rev: REV, doc: DOC });
    function ready() { post({ kind: 'ready', path: location.pathname, vw: D.documentElement.clientWidth, vh: W.innerHeight, rootPx: parseFloat(gcs(D.documentElement).fontSize) }); }
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', ready); else ready();
  }, true);

  try { P.postMessage({ source: 'vcide-edit-agent', v: 1, kind: 'hello' }, PARENT_ORIGIN); } catch (e) {}
})();
