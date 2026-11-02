/* =============================================================================
 * 編集 PoC — 検証用画面（親）と、アートボードの iframe の中のスクリプト（edit-agent）の間の通信の検査。
 * 製品の src/lib/previewProtocol.ts と同じ方針（知らないキーは捨てる・nonce 一致・型と範囲）に、
 * **起動インスタンス**（中継が文書ごとに埋めた値）と**アートボードごとの接続**を足した。
 * 製品のプロトコルは変更していない。ブラウザと Node（テスト）の両方から読む。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EditProtocol = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  var V = 1;
  var AGENT = 'vcide-edit-agent';
  var IDE = 'vcide-edit-ide';
  var ID = /^[0-9a-f]{10}$/;
  var HEX32 = /^[0-9a-f]{32}$/;
  var INST = /^[0-9a-f]{16}$/;
  var REV = /^[0-9a-f]{12}$/;
  var TOKEN = /^[a-z0-9:.\-\[\]/%]{1,40}$/;

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
  function only(o, keys) { return Object.keys(o).every(function (k) { return keys.indexOf(k) >= 0; }); }
  function isInt(v, a, b) { return typeof v === 'number' && Number.isInteger(v) && v >= a && v <= b; }
  function isNum(v, a, b) { return typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b; }
  function isPath(v) { return typeof v === 'string' && v.length <= 2048 && v.charAt(0) === '/' && v.charAt(1) !== '/' && !/[\u0000-\u001f\u007f]/.test(v); }

  function isHello(d) { return isObj(d) && only(d, ['source', 'v', 'kind']) && d.source === AGENT && d.v === V && d.kind === 'hello'; }

  /** 選択の中身。製品の parseSelection と同じ形（要素識別子・タグ・何番目か・数・祖先） */
  function parseSelection(s) {
    if (!isObj(s) || !only(s, ['tag', 'anchorOnSelf', 'anchorOrdinal', 'anchorInstanceCount', 'ancestorAnchors', 'textNodeIndex', 'valueShape', 'formControl', 'path'])) return null;
    if (typeof s.tag !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(s.tag)) return null;
    if (s.anchorOnSelf !== null && (typeof s.anchorOnSelf !== 'string' || !ID.test(s.anchorOnSelf))) return null;
    if (!isInt(s.anchorInstanceCount, 0, 100000)) return null;
    if (s.anchorOnSelf === null ? (s.anchorOrdinal !== null || s.anchorInstanceCount !== 0)
      : (!isInt(s.anchorOrdinal, 0, 100000) || s.anchorOrdinal >= s.anchorInstanceCount)) return null;
    if (!Array.isArray(s.ancestorAnchors) || s.ancestorAnchors.length > 32 || !s.ancestorAnchors.every(function (a) { return typeof a === 'string' && ID.test(a); })) return null;
    if (s.textNodeIndex !== null && !isInt(s.textNodeIndex, 0, 100000)) return null;
    if (typeof s.formControl !== 'boolean') return null;
    if (s.valueShape !== null && (!isObj(s.valueShape) || !only(s.valueShape, ['chars', 'cls']) || !isInt(s.valueShape.chars, 1, 1000000)
      || ['cjk', 'latin', 'digits', 'mixed', 'other'].indexOf(s.valueShape.cls) < 0)) return null;
    if (!isPath(s.path)) return null;
    return s;
  }

  function parseItem(it) {
    if (!isObj(it) || !only(it, ['i', 'x', 'y', 'w', 'h', 'pad', 'has'])) return null;
    if (!isInt(it.i, 0, 100000) || !isNum(it.x, -1e6, 1e6) || !isNum(it.y, -1e6, 1e6) || !isNum(it.w, 0, 1e6) || !isNum(it.h, 0, 1e6)) return null;
    if (!Array.isArray(it.pad) || it.pad.length !== 4 || !it.pad.every(function (p) { return isNum(p, 0, 10000); })) return null;
    if (!isObj(it.has) || !Object.keys(it.has).every(function (k) { return TOKEN.test(k) && typeof it.has[k] === 'boolean'; })) return null;
    return it;
  }

  /**
   * MessagePort で届いた知らせ。nonce（この接続）と instance（この起動の中継が配った文書）が
   * 一致しなければ null。アートボードの取り違えは、接続をアートボードごとに持つことで防ぐ（呼び出し側）。
   */
  function parseAgentMessage(d, nonce, instance) {
    if (!isObj(d) || d.source !== AGENT || d.v !== V || d.nonce !== nonce || d.instance !== instance) return null;
    var base = ['source', 'v', 'kind', 'nonce', 'instance'];
    switch (d.kind) {
      case 'connected':
        if (!only(d, base.concat(['rev', 'doc'])) || !REV.test(d.rev) || !HEX32.test(d.doc)) return null;
        return d;
      case 'ready':
        if (!only(d, base.concat(['path', 'vw', 'vh', 'rootPx'])) || !isPath(d.path) || !isInt(d.vw, 1, 10000) || !isInt(d.vh, 1, 10000) || !isNum(d.rootPx, 1, 200)) return null;
        return d;
      case 'mode':
        return only(d, base.concat(['select'])) && typeof d.select === 'boolean' ? d : null;
      case 'select':
        if (!only(d, base.concat(['seq', 'selection'])) || !isInt(d.seq, 1, Number.MAX_SAFE_INTEGER)) return null;
        return parseSelection(d.selection) ? d : null;
      case 'measure':
        if (!only(d, base.concat(['req', 'anchor', 'items', 'vw', 'vh', 'predicted'])) || !isInt(d.req, 1, Number.MAX_SAFE_INTEGER)
          || !ID.test(d.anchor) || !Array.isArray(d.items) || d.items.length > 1000 || !isInt(d.vw, 1, 10000) || !isInt(d.vh, 1, 10000)
          || typeof d.predicted !== 'boolean') return null;
        return d.items.every(parseItem) ? d : null;
      case 'changed':
        return only(d, base.concat(['n'])) && isInt(d.n, 1, Number.MAX_SAFE_INTEGER) ? d : null;
      case 'predicted':
        return only(d, base.concat(['req', 'on', 'n'])) && isInt(d.req, 1, Number.MAX_SAFE_INTEGER) && typeof d.on === 'boolean' && isInt(d.n, 0, 100000) ? d : null;
      case 'described':
        if (!only(d, base.concat(['req', 'selection'])) || !isInt(d.req, 1, Number.MAX_SAFE_INTEGER)) return null;
        return d.selection === null || parseSelection(d.selection) ? d : null;
      default:
        return null;
    }
  }

  return { V: V, AGENT: AGENT, IDE: IDE, isHello: isHello, parseAgentMessage: parseAgentMessage, parseSelection: parseSelection, TOKEN: TOKEN };
}));
