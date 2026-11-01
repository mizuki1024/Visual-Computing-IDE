/* =============================================================================
 * ブラウザ側で動かす観測コード（PoC-03）。
 *
 * 守ること（指示 第6節）:
 *   * **DOM の全文を集めない。** 選択された要素1つだけを見る
 *   * **表示された値を保存しない。** 文字数と文字種だけを返す
 *   * Cookie / 認証情報 / 個人情報 / ヘッダ / 本文に一切触れない
 *   * 対応付けの鍵は「要素識別子 + 同一識別子内の順番 + テキストノード索引」。
 *     値そのものを鍵に使わない（値照合に頼らない）
 *
 * 判定の核心（誤特定を避ける規則）:
 *   **要素識別子は、その要素自身に付いているものだけを出所として扱う。**
 *   祖先の識別子は「文脈」であって出所ではない。これを混ぜると
 *   ライブラリ由来の要素を自作ファイルへ誤って割り当てる。
 * ========================================================================== */

/** ページに注入する観測関数群。クリックは本物のイベントとして捕まえる。 */
export const INSTALL = `(() => {
  const CJK = /[\\u3000-\\u30ff\\u4e00-\\u9fff]/;
  function shapeOf(s) {
    const hasCjk = CJK.test(s);
    const hasAlnum = /[A-Za-z0-9]/.test(s);
    const cls = hasCjk && hasAlnum ? 'mixed' : hasCjk ? 'cjk'
      : /^[0-9.,:/\\-]+$/.test(s) ? 'digits' : hasAlnum ? 'latin' : 'other';
    return { chars: Array.from(s).length, cls: cls };
  }
  function fiberOf(el) {
    const k = Object.keys(el).find((x) => x.indexOf('__reactFiber$') === 0);
    return k ? el[k] : null;
  }
  function frames(err) {
    if (!err || typeof err.stack !== 'string') return [];
    const out = [];
    for (const raw of err.stack.split('\\n')) {
      // 'at Foo (webpack-internal:///(app-pages-browser)/./src/x.tsx:12:84)' のように
      // パスに括弧が入る。行末から '<url>:<行>:<列>' を取る
      const line = raw.trim().replace(/\\)$/, '');
      const m = /([^\\s(]+):(\\d+):(\\d+)$/.exec(line);
      if (m) out.push({ url: m[1], line: Number(m[2]), col: Number(m[3]) });
      if (out.length >= 6) break;
    }
    return out;
  }
  /** 方式2（React 内部）の比較用の事実。採用方式ではない */
  function reactFacts(el) {
    const hostKeys = Object.keys(el).filter((k) => k.indexOf('__react') === 0)
      .map((k) => k.replace(/\\$.*$/, '$<random>'));
    const f = fiberOf(el);
    if (!f) return { hostKeys: hostKeys, fiber: false };
    let owner = f.return;
    let ownerName = null;
    while (owner) {
      if (typeof owner.type === 'function') { ownerName = owner.type.name || null; break; }
      owner = owner.return;
    }
    return {
      hostKeys: hostKeys,
      fiber: true,
      fiberKeys: Object.keys(f).sort(),
      hasDebugSource: ('_debugSource' in f),
      debugSourceIsNull: ('_debugSource' in f) ? (f._debugSource == null) : null,
      hasDebugStack: ('_debugStack' in f),
      debugStackIsError: ('_debugStack' in f) ? (f._debugStack instanceof Error) : null,
      debugStackFrames: ('_debugStack' in f) ? frames(f._debugStack) : [],
      hasDebugOwner: ('_debugOwner' in f),
      debugOwnerName: (f._debugOwner && typeof f._debugOwner.type === 'function')
        ? (f._debugOwner.type.name || null) : null,
      returnChainOwnerName: ownerName,
      propsHasSource: !!(f.memoizedProps && ('__source' in f.memoizedProps)),
    };
  }
  /** 選択された DOM 要素1つから、対応付けの鍵を作る */
  window.__vcideResolve = function (el) {
    if (!el || el.nodeType !== 1) return { found: false };
    const docHasAnchors = !!document.querySelector('[data-vcide]');
    const own = el.getAttribute('data-vcide');
    const chain = [];
    for (let p = el; p; p = p.parentElement) {
      const id = p.getAttribute('data-vcide');
      if (id) chain.push({ id: id, tag: p.tagName.toLowerCase(), self: p === el });
    }
    let instances = [];
    let ordinal = null;
    if (own) {
      instances = Array.prototype.slice.call(document.querySelectorAll('[data-vcide="' + own + '"]'));
      ordinal = instances.indexOf(el);
    }
    const kids = Array.prototype.slice.call(el.childNodes);
    const textIdx = kids.findIndex((n) => n.nodeType === 3 && n.nodeValue.trim().length > 0);
    const shape = textIdx >= 0 ? shapeOf(kids[textIdx].nodeValue.trim()) : null;
    return {
      found: true,
      tag: el.tagName.toLowerCase(),
      anchorOnSelf: own || null,
      anchorOrdinal: ordinal,
      anchorInstanceCount: own ? instances.length : 0,
      ancestorAnchors: chain,
      textNodeIndex: textIdx >= 0 ? textIdx : null,
      valueShape: shape,
      documentHasAnchors: docHasAnchors,
      react: reactFacts(el),
    };
  };
  /** 本物のクリックを捕まえる経路。製品の選択操作と同じ道を測る */
  window.__vcidePick = null;
  window.__vcidePickCount = 0;
  document.addEventListener('click', function (e) {
    window.__vcidePickCount++;
    window.__vcidePick = window.__vcideResolve(e.target);
  }, true);
  return true;
})()`;

/**
 * 正解表（Q-03.3 手順1 の「人手で照合」の実体）。
 * ソースを読んで手で書いた。観測側はこの表を一切参照しない。
 */
export const TARGETS = [
  /* ---- /cards: 自作・Client Component ---- */
  { key: 'main', page: '/cards', sel: 'main.cards', ord: 0,
    expect: { file: 'src/app/cards/page.tsx', line: 42, tag: 'main', component: 'Cards' },
    group: 'own-client' },
  { key: 'h1', page: '/cards', sel: 'main.cards > h1', ord: 0,
    expect: { file: 'src/app/cards/page.tsx', line: 43, tag: 'h1', component: 'Cards' },
    group: 'own-client' },
  { key: 'static-p', page: '/cards', sel: 'p.static', ord: 0,
    expect: { file: 'src/app/cards/page.tsx', line: 44, tag: 'p', component: 'Cards' },
    group: 'own-client' },
  { key: 'grid', page: '/cards', sel: 'div.grid', ord: 0,
    expect: { file: 'src/app/cards/page.tsx', line: 45, tag: 'div', component: 'Cards' },
    group: 'own-client' },
  { key: 'in-slot', page: '/cards', sel: 'span.in-slot', ord: 0,
    expect: { file: 'src/app/cards/page.tsx', line: 49, tag: 'span', component: 'Cards' },
    group: 'own-client', note: 'ライブラリ製の枠の中に置いた自作 JSX' },
  { key: 'slot', page: '/cards', sel: 'div.slot', ord: 0,
    expect: { file: 'src/app/cards/page.tsx', line: 51, tag: 'div', component: 'Cards' },
    group: 'own-client' },

  /* ---- /cards: props で受け取る・複数回描かれる ---- */
  { key: 'card-0', page: '/cards', sel: 'article.card', ord: 0,
    expect: { file: 'src/components/ListingCard.tsx', line: 12, tag: 'article', component: 'ListingCard' },
    group: 'repeated' },
  { key: 'card-1', page: '/cards', sel: 'article.card', ord: 1,
    expect: { file: 'src/components/ListingCard.tsx', line: 12, tag: 'article', component: 'ListingCard' },
    group: 'repeated' },
  { key: 'card-2', page: '/cards', sel: 'article.card', ord: 2,
    expect: { file: 'src/components/ListingCard.tsx', line: 12, tag: 'article', component: 'ListingCard' },
    group: 'repeated' },
  { key: 'card-head', page: '/cards', sel: 'header.card-head', ord: 0,
    expect: { file: 'src/components/ListingCard.tsx', line: 13, tag: 'header', component: 'ListingCard' },
    group: 'props' },
  { key: 'card-code', page: '/cards', sel: 'article.card span.code', ord: 0,
    expect: { file: 'src/components/ListingCard.tsx', line: 14, tag: 'span', component: 'ListingCard' },
    group: 'props' },
  { key: 'card-body', page: '/cards', sel: 'div.card-body', ord: 0,
    expect: { file: 'src/components/ListingCard.tsx', line: 16, tag: 'div', component: 'ListingCard' },
    group: 'props' },

  /* ---- /cards: ネストしたコンポーネント ---- */
  { key: 'badge', page: '/cards', sel: 'span.badge', ord: 0,
    expect: { file: 'src/components/RegionBadge.tsx', line: 6, tag: 'span', component: 'RegionBadge' },
    group: 'nested' },
  { key: 'badge-dot', page: '/cards', sel: 'span.badge-dot', ord: 0,
    expect: { file: 'src/components/RegionBadge.tsx', line: 7, tag: 'span', component: 'RegionBadge' },
    group: 'nested' },
  { key: 'badge-text', page: '/cards', sel: 'span.badge-text', ord: 0,
    expect: { file: 'src/components/RegionBadge.tsx', line: 8, tag: 'span', component: 'RegionBadge' },
    group: 'nested', primary: true, note: '主対象。表示された所在地の値' },
  { key: 'badge-text-2', page: '/cards', sel: 'span.badge-text', ord: 2,
    expect: { file: 'src/components/RegionBadge.tsx', line: 8, tag: 'span', component: 'RegionBadge' },
    group: 'repeated', note: '3枚目のカードの同じ要素' },

  /* ---- /cards: 特定できないはずのもの ---- */
  { key: 'vendor-root', page: '/cards', sel: 'section.vendor', ord: 0,
    expect: null, group: 'library',
    mustNotResolveTo: 'src/app/cards/page.tsx' },
  { key: 'vendor-title', page: '/cards', sel: 'h3.vendor-title', ord: 0,
    expect: null, group: 'library',
    mustNotResolveTo: 'src/app/cards/page.tsx' },
  { key: 'vendor-slot', page: '/cards', sel: 'div.vendor-slot', ord: 0,
    expect: null, group: 'library',
    mustNotResolveTo: 'src/app/cards/page.tsx' },
  { key: 'dynamic', page: '/cards', sel: 'span.injected', ord: 0,
    expect: null, group: 'no-jsx',
    mustNotResolveTo: 'src/app/cards/page.tsx' },

  /* ---- /cards-rsc: Server Component ---- */
  { key: 'rsc-main', page: '/cards-rsc', sel: 'main.cards-rsc', ord: 0,
    expect: { file: 'src/app/cards-rsc/page.tsx', line: 17, tag: 'main', component: 'CardsRsc' },
    group: 'own-server' },
  { key: 'rsc-h1', page: '/cards-rsc', sel: 'main.cards-rsc > h1', ord: 0,
    expect: { file: 'src/app/cards-rsc/page.tsx', line: 18, tag: 'h1', component: 'CardsRsc' },
    group: 'own-server' },
  { key: 'rsc-ul', page: '/cards-rsc', sel: 'main.cards-rsc > ul', ord: 0,
    expect: { file: 'src/app/cards-rsc/page.tsx', line: 19, tag: 'ul', component: 'CardsRsc' },
    group: 'own-server' },
  { key: 'rsc-li', page: '/cards-rsc', sel: 'main.cards-rsc li', ord: 1,
    expect: { file: 'src/app/cards-rsc/page.tsx', line: 21, tag: 'li', component: 'CardsRsc' },
    group: 'own-server' },
  { key: 'rsc-code', page: '/cards-rsc', sel: 'main.cards-rsc span.code', ord: 0,
    expect: { file: 'src/app/cards-rsc/page.tsx', line: 22, tag: 'span', component: 'CardsRsc' },
    group: 'own-server' },
  { key: 'rsc-badge-text', page: '/cards-rsc', sel: 'span.badge-text', ord: 1,
    expect: { file: 'src/components/RegionBadge.tsx', line: 8, tag: 'span', component: 'RegionBadge' },
    group: 'own-server', note: 'サーバーで描かれた、ネストしたコンポーネントの値' },
];
