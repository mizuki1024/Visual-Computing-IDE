/* =============================================================================
 * 編集 PoC の検証用画面。製品の画面ではない（採用 UI の配置だけを借りた最小の画面）。
 *
 * 守ること
 *   - アートボードの CSS 上のビューポート（375×812 / 1440×900）と、キャンバス上の倍率を分ける。
 *     iframe は実寸で描かせ、外側の箱だけを transform: scale で縮める。倍率は全アートボード共通
 *   - 選択枠・余白の帯は、iframe の中のスクリプトが測った矩形（iframe の CSS px）× 倍率で描く
 *   - 予測（方式 A）の表示と、現在のコードの実描画を見出しの語と斜線地で区別する
 *   - 書き込み・再描画・検証を別々のチップで出す。再描画を確かめるまで「検証済み」と出さない
 * ========================================================================== */
(function () {
  'use strict';
  const P = window.EditProtocol;
  const CFG = JSON.parse(atob(document.querySelector('meta[name="poc-config"]').content));
  const qs = new URLSearchParams(location.search);
  const RERENDER_TIMEOUT = Number(qs.get('rerenderTimeout') || 12000);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ARTBOARDS = [
    { name: 'Desktop', w: 1440, h: 900, icon: '🖥' },
    { name: 'Mobile', w: 375, h: 812, icon: '📱' },
  ];
  const T = {
    scale: 0.5, mode: 'select', view: 'current', rejected: 0, server: null,
    sel: null,          // { ab, anchorId, ordinal, count, resolved }
    lastKnown: null,    // 最後に確認できた選択（file:line）
    selNote: null,      // 選択の再解決の結果
    review: false, conflict: null, revertRefusal: null,
    measures: {},       // ab.name -> measure
    lastVerify: null, clientLog: [],
  };
  window.__poc = T;    // e2e が読む（書き換えない）
  const clog = (m) => { T.clientLog.push(`${new Date().toISOString().slice(11, 23)} ${m}`); renderLog(); };

  /* -------------------------------------------------------------- API */
  async function api(p, body) {
    const r = await fetch(p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-poc-session': CFG.session, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...j };
  }
  async function refresh() { T.server = await api('/api/state'); render(); return T.server; }

  /* ------------------------------------------------------- アートボード */
  const canvas = $('canvas');
  for (const ab of ARTBOARDS) {
    const el = document.createElement('div');
    el.className = 'artboard';
    el.dataset.testid = `artboard-${ab.name}`;
    el.innerHTML = `<div class="ab-head"><div class="l1"><span>${ab.icon}</span><b>/properties · ${ab.name} ${ab.w} × ${ab.h}</b><span class="selmark"></span></div><div class="l2">—</div></div>
      <div class="viewport" data-testid="viewport-${ab.name}"><div class="scaler"><iframe title="${ab.name}" width="${ab.w}" height="${ab.h}" data-testid="frame-${ab.name}"></iframe></div><div class="ov"></div></div>`;
    canvas.appendChild(el);
    Object.assign(ab, { el, head: el.querySelector('.ab-head'), vp: el.querySelector('.viewport'), scaler: el.querySelector('.scaler'),
      frame: el.querySelector('iframe'), ov: el.querySelector('.ov'), conn: null, pending: [], doc: null, rev: null, ready: null, waiters: new Map() });
  }
  function layout() {
    for (const ab of ARTBOARDS) {
      ab.vp.style.width = `${ab.w * T.scale}px`;
      ab.vp.style.height = `${ab.h * T.scale}px`;
      ab.scaler.style.width = `${ab.w}px`;
      ab.scaler.style.height = `${ab.h}px`;
      ab.scaler.style.transform = `scale(${T.scale})`;
      ab.head.style.width = `${Math.max(ab.w * T.scale, 190)}px`;
    }
    drawOverlays();
  }
  function load(ab) {
    ab.conn = null; ab.ready = null; ab.doc = null; ab.rev = null;
    ab.frame.src = `${CFG.relayOrigin}/properties?ab=${ab.name}&t=${Date.now()}`;
  }

  /* -------------------------------------------- 接続（アートボードごと） */
  let reqSeq = 0;
  window.addEventListener('message', (e) => {
    if (e.origin !== CFG.relayOrigin) return;
    const ab = ARTBOARDS.find((a) => a.frame.contentWindow === e.source);
    if (!ab) { T.rejected += 1; renderConn(); return; }       // どのアートボードの iframe でもない
    if (!P.isHello(e.data)) { T.rejected += 1; renderConn(); return; }
    const ch = new MessageChannel();
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+/=]/g, '_');
    const c = { port: ch.port1, nonce };
    ab.pending.push(c);
    ch.port1.onmessage = (m) => onPort(ab, c, m.data);
    e.source.postMessage({ source: P.IDE, v: P.V, kind: 'connect', nonce }, CFG.relayOrigin, [ch.port2]);
  });
  function send(ab, m) { if (ab.conn) ab.conn.port.postMessage({ source: P.IDE, v: P.V, nonce: ab.conn.nonce, ...m }); }
  function request(ab, m, kind, ms = 3000) {
    return new Promise((resolve) => {
      if (!ab.conn) { resolve(null); return; }
      const req = ++reqSeq;
      const t = setTimeout(() => { ab.waiters.delete(req); resolve(null); }, ms);
      ab.waiters.set(req, (d) => { clearTimeout(t); resolve(d.kind === kind ? d : null); });
      send(ab, { ...m, req });
    });
  }
  function onPort(ab, c, data) {
    /* この起動のインスタンス・この接続の nonce でなければ捨てる */
    const d = P.parseAgentMessage(data, c.nonce, CFG.instance);
    if (!d) { T.rejected += 1; renderConn(); return; }
    if (ab.conn !== c) {
      if (!ab.pending.includes(c) || d.kind !== 'connected') { T.rejected += 1; renderConn(); return; }
      try { ab.conn?.port.close(); } catch { /* 閉じている */ }
      ab.pending = [];
      ab.conn = c; ab.doc = d.doc; ab.rev = d.rev;
      send(ab, { kind: 'mode', select: T.mode === 'select' });
      renderConn();
      return;
    }
    if (d.req && ab.waiters.has(d.req)) { const w = ab.waiters.get(d.req); ab.waiters.delete(d.req); w(d); return; }
    if (d.kind === 'ready') { ab.ready = d; renderHeads(); return; }
    if (d.kind === 'select') { if (T.mode === 'select') void onSelect(ab, d.selection); else { T.rejected += 1; renderConn(); } return; }
    if (d.kind === 'changed') { onChanged(ab); }
  }
  const connected = () => ARTBOARDS.every((ab) => ab.conn && ab.ready);
  async function waitConnected(ms = 30000) {
    const t0 = Date.now();
    while (!connected()) { if (Date.now() - t0 > ms) return false; await sleep(100); }
    return true;
  }

  /* ---------------------------------------------------------- 計測 */
  const trackedTokens = () => {
    const s = T.server;
    const toks = new Set(['p-4', 'p-5', 'p-6', 'md:p-6']);
    if (s?.draft) { toks.add(s.draft.from); toks.add(s.draft.value); }
    for (const a of s?.applied ?? []) { toks.add(a.from); toks.add(a.to); }
    return [...toks].filter((t) => P.TOKEN.test(t)).slice(0, 16);
  };
  async function measure(ab, anchor) { return request(ab, { kind: 'measure', anchor, tokens: trackedTokens() }, 'measure'); }
  /* 書き込み・再読み込みのたびに世代を進める。始めた後に世代が変わった計測は捨てる（古い描画の値を新しいコードの値として出さない） */
  T.epoch = 0;
  async function measureAll() {
    if (!T.sel) return;
    const ep = T.epoch;
    const next = {};
    for (const ab of ARTBOARDS) next[ab.name] = await measure(ab, T.sel.anchorId);
    if (ep !== T.epoch) return;
    T.measures = next;
    drawOverlays(); renderDock();
  }
  function invalidateMeasures() { T.epoch += 1; T.measures = {}; }
  let ticking = false;
  setInterval(async () => { if (ticking || !T.sel || T.busy) return; ticking = true; try { await measureAll(); } finally { ticking = false; } }, 400);

  /* -------------------------------------------------------- 重ね表示 */
  function drawOverlays() {
    for (const ab of ARTBOARDS) {
      ab.ov.innerHTML = '';
      const m = T.measures[ab.name];
      ab.head.querySelector('.selmark').textContent = T.sel && T.sel.ab === ab.name ? '● 選択中' : '';
      if (!T.sel || !m || T.mode !== 'select') continue;
      const s = T.scale;
      for (const it of m.items) {
        const x = it.x * s, y = it.y * s, w = it.w * s, h = it.h * s;
        if (T.sel.ab === ab.name && it.i === T.sel.ordinal) {
          const b = document.createElement('div');
          b.className = 'primary'; b.dataset.testid = `overlay-primary-${ab.name}`;
          Object.assign(b.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
          b.innerHTML = `<span class="tag">div · ${esc(T.sel.resolved?.anchor?.component ?? '')} · ${it.i + 1}/${m.items.length}</span>`;
          ab.ov.appendChild(b);
          /* 余白の帯（主選択の描画にだけ — UI-E09） */
          const [pt, pr, pb, pl] = it.pad.map((p) => p * s);
          for (const [l, t, ww, hh] of [[x, y, w, pt], [x, y + h - pb, w, pb], [x, y + pt, pl, h - pt - pb], [x + w - pr, y + pt, pr, h - pt - pb]]) {
            const band = document.createElement('div'); band.className = 'padband';
            Object.assign(band.style, { left: `${l}px`, top: `${t}px`, width: `${ww}px`, height: `${hh}px` }); ab.ov.appendChild(band);
          }
          const tag = document.createElement('div'); tag.className = 'padtag';
          const tok = T.server?.draft && T.view === 'preview' ? T.server.draft.value : (curToken(it) ?? '');
          tag.textContent = `${tok} · ${it.pad[0]}px${T.server?.draft && !T.server.draft.isNoop ? ' ◆' : ''}${m.predicted ? '（予測）' : ''}`;
          Object.assign(tag.style, { left: `${x + 2}px`, top: `${y + h - 14}px` }); ab.ov.appendChild(tag);
        } else {
          const sec = document.createElement('div'); sec.className = 'sec'; sec.dataset.testid = `overlay-sec-${ab.name}`;
          Object.assign(sec.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
          sec.innerHTML = '<i></i><i></i><i></i><i></i>';
          ab.ov.appendChild(sec);
        }
      }
    }
  }
  const curToken = (it) => Object.keys(it.has).find((k) => it.has[k] && /^p-/.test(k)) ?? null;

  /* -------------------------------------------------------------- 選択 */
  async function onSelect(ab, selection) {
    clog(`${ab.name} で選択: <${selection.tag}> ${selection.anchorOnSelf ?? '識別子なし'} ${selection.anchorOrdinal !== null ? `${selection.anchorOrdinal + 1}/${selection.anchorInstanceCount}` : ''}`);
    if (T.view === 'preview') await setView('current');
    const r = await api('/api/resolve', { instance: CFG.instance, selection });
    T.selNote = null;
    if (r.status !== 'resolved') {
      T.sel = { ab: ab.name, anchorId: selection.anchorOnSelf, ordinal: selection.anchorOrdinal, count: selection.anchorInstanceCount, resolved: r, selection };
      T.measures = {};
      render(); return;
    }
    T.sel = { ab: ab.name, anchorId: r.anchor.id, ordinal: r.ordinal, count: r.count, resolved: r, selection };
    T.lastKnown = { file: r.anchor.file, line: r.anchor.line, component: r.anchor.component };
    await measureAll();
    render();
  }

  /** 適用・取り消し・外部変更の後に、同じ要素を選び直せるか（EP-01）。**別の要素を黙って選ばない** */
  async function reresolve(reason) {
    if (!T.sel?.resolved?.anchor) return;
    const ab = ARTBOARDS.find((a) => a.name === T.sel.ab);
    const d = await request(ab, { kind: 'describe', anchor: T.sel.anchorId, ordinal: T.sel.ordinal }, 'described');
    if (!d || !d.selection) {
      T.selNote = { ok: false, text: `選択を維持できません — 識別子 ${T.sel.anchorId} の ${T.sel.ordinal + 1} 番目が、いまの ${ab.name} の描画にありません（${reason}。コードの位置が変わった可能性があります）。別の要素は自動では選びません。最後に確認できた位置: ${T.lastKnown.file}:${T.lastKnown.line}（${T.lastKnown.component}）` };
      T.sel = null; T.measures = {};
      clog(T.selNote.text); render(); return;
    }
    const r = await api('/api/resolve', { instance: CFG.instance, selection: d.selection });
    if (r.status !== 'resolved' || r.anchor.id !== T.sel.anchorId) {
      T.selNote = { ok: false, text: `選択を維持できません — 照合に失敗しました（${r.reason ?? '別の要素'}）。${r.detail ?? ''}` };
      T.sel = null; T.measures = {};
    } else {
      T.sel.resolved = r; T.sel.count = r.count;
      T.selNote = { ok: true, text: `選択を再解決しました（${reason}）— 同じ識別子・${r.anchor.file}:${r.anchor.line}:${r.anchor.col}・${r.ordinal + 1}/${r.count}・6段の照合を通過` };
    }
    clog(T.selNote.text); render();
  }
  let changedTimer = null;
  function onChanged(ab) {
    if (T.busy || !T.sel) return;
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => { if (!T.busy) void reresolve(`${ab.name} の DOM が変わった`); }, 600);
  }

  /* ------------------------------------------------------- 表示の切替 */
  async function setView(v) {
    const d = T.server?.draft;
    if (v === 'preview' && (!d || d.isNoop)) v = 'current';
    if (v === 'preview') {
      const css = await api('/api/predict-css', {});
      for (const ab of ARTBOARDS) await request(ab, { kind: 'predict', anchor: css.anchor, css: css.css, from: css.from, to: css.to }, 'predicted');
      clog(`適用前プレビュー（予測）: ${css.from} → ${css.to} を DOM に重ねた（規則 ${css.rules} 件。ソースは未変更）`);
    } else if (T.view === 'preview') {
      for (const ab of ARTBOARDS) await request(ab, { kind: 'unpredict' }, 'predicted');
      clog('現在のコードの表示に戻した（予測を外した）');
    }
    T.view = v;
    await measureAll();
    render();
  }

  /* --------------------------------------------------------- 下書き */
  async function setDraft(to) {
    const r = await api('/api/draft', { anchorId: T.sel.anchorId, to });
    if (!r.ok) { T.conflict = { reason: r.error, detail: r.detail }; render(); return; }
    await refresh();
    if (T.view === 'preview') await setView('preview');
    else if (!r.draft.isNoop) await setView('preview');   // 下書きを作った直後は予測を見せる（04e 4.1 の既定案。方式 A）
  }
  async function draftStep(which) {
    await api(`/api/draft/${which}`, {});
    await refresh();
    /* 値を変えたときと同じ既定: 中身のある下書きなら予測を、空なら現在のコードを見せる */
    await setView(T.server.draft && !T.server.draft.isNoop ? 'preview' : 'current');
  }

  /* ------------------------------------------------- 適用・検証・取り消し */
  async function waitRerender(applied, newTok, oldTok) {
    const t0 = Date.now();
    const done = new Set();
    /* 文書が入れ替わった（HMR が全体の再読み込みに落ちた）なら「HMR」とは呼ばない */
    const docs = Object.fromEntries(ARTBOARDS.map((ab) => [ab.name, ab.doc]));
    while (Date.now() - t0 < RERENDER_TIMEOUT) {
      for (const ab of ARTBOARDS) {
        if (done.has(ab.name)) continue;
        const m = await measure(ab, applied.anchor.id);
        if (m && m.items.length && m.items.every((it) => it.has[newTok] && !it.has[oldTok])) done.add(ab.name);
      }
      if (done.size === ARTBOARDS.length) {
        const reloaded = ARTBOARDS.filter((ab) => ab.doc !== docs[ab.name]).map((ab) => ab.name);
        return { ok: true, ms: Date.now() - t0, kind: reloaded.length ? 'reload' : 'hmr', reloaded };
      }
      await sleep(150);
    }
    return { ok: false, ms: Date.now() - t0, done: [...done] };
  }
  async function collect(applied, reloaded = []) {
    const ctrls = (applied.controls ?? []).map((c) => c.id);
    const out = [];
    for (const ab of ARTBOARDS) {
      const m = await measure(ab, applied.anchor.id);
      const control = [];
      for (const id of ctrls) { const cm = await measure(ab, id); if (cm) control.push(...cm.items); }
      out.push({ name: ab.name, vw: m?.vw ?? ab.w, docRev: ab.rev, reloaded: reloaded.includes(ab.name), items: m?.items ?? [], control });
    }
    return out;
  }
  async function verifyAfter(appliedId, phase) {
    const a = T.server.applied.find((x) => x.id === appliedId);
    const [newTok, oldTok] = phase === 'apply' ? [a.to, a.from] : [a.from, a.to];
    for (const ab of ARTBOARDS) ab.el.classList.add('waiting');
    renderHeads('更新を待っています');
    const w = await waitRerender(a, newTok, oldTok);
    clog(w.ok ? `再描画（${w.kind === 'hmr' ? 'HMR' : `文書の再読み込み: ${w.reloaded.join(', ')}`}）を確認: ${w.ms}ms（両方のアートボードで ${newTok} を持つ描画になった）` : `再描画を確認できません: ${w.ms}ms で時間切れ（確認できた幅: ${w.done.join(', ') || 'なし'}）`);
    T.lastRerender = w;
    let v = await api('/api/verify', { appliedId, phase, rerender: w.ok ? w.kind : 'timeout', artboards: w.ok ? await collect(a, w.reloaded) : [] });
    T.lastVerify = v.verification;
    for (const ab of ARTBOARDS) ab.el.classList.remove('waiting');
    await refresh();
    if (w.ok) await reresolve(phase === 'apply' ? '適用後の HMR' : '取り消し後の HMR');
    if (w.ok) v = await reloadVerify(appliedId, phase);
    return v;
  }
  /** 文書を読み直して、中継が付けた「応答時点の版」と適用後の版の対応も確かめる */
  async function reloadVerify(appliedId, phase) {
    const sel = T.sel ? { ...T.sel } : null;
    for (const ab of ARTBOARDS) load(ab);
    renderHeads('再読み込みしています');
    const ok = await waitConnected();
    if (!ok) { clog('再読み込みの後に接続できませんでした'); return null; }
    const a = T.server.applied.find((x) => x.id === appliedId);
    const v = await api('/api/verify', { appliedId, phase, rerender: 'reload', artboards: await collect(a, ARTBOARDS.map((x) => x.name)) });
    T.lastVerify = v.verification;
    clog(`再読み込みの検証: ${v.verification.verify}`);
    if (sel) { T.sel = sel; await reresolve('再読み込みの後'); }
    await refresh();
    return v;
  }
  async function apply() {
    const d = T.server.draft;
    if (T.view === 'preview') await setView('current');   // 予測を外してから書く（予測のまま成功にしない）
    T.busy = true;
    invalidateMeasures();
    try {
      const r = await api('/api/apply', { draftId: d.id, baseHash: d.baseHash, diffHash: d.diffHash });
      if (!r.ok) { T.conflict = { reason: r.reason, detail: r.detail }; clog(`適用しませんでした: ${r.reason}`); await refresh(); return; }
      T.conflict = null; T.review = false; T.lastSameClass = T.sel?.resolved?.sameClass;
      clog(`書き込み: ${r.applied.rel} ${r.applied.from} → ${r.applied.to}（版 ${r.applied.revBefore} → ${r.applied.revAfter}）`);
      await refresh();
      await verifyAfter(r.applied.id, 'apply');
    } finally { T.busy = false; invalidateMeasures(); await measureAll(); render(); }
  }
  async function revert(id) {
    T.busy = true;
    invalidateMeasures();
    try {
      const r = await api('/api/revert', { appliedId: id });
      if (!r.ok) { T.revertRefusal = r; clog(`取り消しませんでした: ${r.status}`); await refresh(); return; }
      T.revertRefusal = null;
      clog(`適用の取り消し: 書き戻し（版 → ${r.applied.revert.revAfter}）`);
      await refresh();
      await verifyAfter(id, 'revert');
    } finally { T.busy = false; invalidateMeasures(); await measureAll(); render(); }
  }
  async function reloadCheck(id) {
    T.busy = true;
    invalidateMeasures();
    try {
      const a = T.server.applied.find((x) => x.id === id);
      const phase = a.revert ? 'revert' : 'apply';
      await reloadVerify(id, phase);
    } finally { T.busy = false; invalidateMeasures(); await measureAll(); render(); }
  }

  /* ------------------------------------------------------------ 描画 */
  function render() { renderTop(); renderHeads(); renderTree(); renderDock(); renderFlow(); drawOverlays(); renderLog(); renderConn(); }
  function chip(id, text, cls) { const c = $(id); c.textContent = text; c.className = `chip ${cls ?? ''}`; }
  const lastApplied = () => T.server?.applied?.at(-1) ?? null;
  function renderTop() {
    const s = T.server; if (!s) return;
    $('rev').textContent = s.revision.id.slice(0, 7);
    const a = lastApplied();
    if (s.draft && !s.draft.isNoop) chip('changeChip', `◆ 下書き 1件 · 1ファイル · コードは未変更`, 'draft');
    else if (a && !a.revert) chip('changeChip', '適用済み（未コミット）', 'wait');
    else if (a && a.revert) chip('changeChip', '適用を取り消し済み', '');
    else chip('changeChip', '変更なし', '');
    const st = a ? (a.revert ? { write: a.revert.status === 'reverted' ? 'written-verified' : a.revert.status, rerender: a.revert.rerender, verify: a.revert.verify } : a.status) : null;
    const pre = a?.revert ? '取り消し · ' : '';
    chip('writeChip', st ? `${pre}書き込み ${st.write === 'written-verified' ? '済み（読み直して一致）' : st.write}` : '書き込み —', st ? (st.write === 'written-verified' ? 'ok' : 'ng') : '');
    const rr = { waiting: '待っています', hmr: 'HMR で確認', reload: '再読み込みで確認', 'not-confirmed': '確認できません' };
    chip('rerenderChip', st ? `再描画 ${rr[st.rerender] ?? st.rerender}` : '再描画 —', st ? (st.rerender === 'not-confirmed' ? 'ng' : st.rerender === 'waiting' ? 'wait' : 'ok') : '');
    const vv = { passed: '通過', failed: '失敗', 'not-verified': '未検証' };
    chip('verifyChip', st ? `検証 ${vv[st.verify] ?? st.verify}` : '検証 —', st ? (st.verify === 'passed' ? 'ok' : st.verify === 'failed' ? 'ng' : 'wait') : '');
    $('viewPreview').disabled = !(s.draft && !s.draft.isNoop);
    $('undo').disabled = !s.draft?.canUndo; $('redo').disabled = !s.draft?.canRedo;
    $('viewCurrent').classList.toggle('on', T.view === 'current'); $('viewPreview').classList.toggle('on', T.view === 'preview');
  }
  function renderHeads(waiting) {
    const s = T.server;
    for (const ab of ARTBOARDS) {
      const l2 = ab.head.querySelector('.l2');
      ab.head.classList.toggle('preview', T.view === 'preview');
      const md = s?.theme?.breakpoints?.md?.px;
      const bp = md ? (ab.w >= md ? 'md 以上が有効' : 'base のみ有効') : '';
      if (waiting) { l2.textContent = `⟳ ${waiting}`; continue; }
      if (T.view === 'preview') {
        const m = T.measures[ab.name];
        const base = T.premeasure?.[ab.name];
        const changed = m && base ? m.items.some((it, i) => base.items[i] && it.pad[0] !== base.items[i].pad[0]) : null;
        l2.textContent = `▨ 適用前プレビュー（予測）· 下書き 1件を反映${changed === false ? ' · この幅は変化なし（予測）' : changed ? ' · この幅は変わる（予測）' : ''}`;
      } else {
        /* 文書の版（応答時点）・コードの版・最後の検証から、この描画が「いまのコード」と言えるかを書き分ける */
        const a = lastApplied();
        const st = a ? (a.revert ?? a.status) : null;
        const code = s?.revision?.id ?? '';
        const docRev = ab.rev ?? '—';
        const vr = a?.verifications?.at(-1);
        let what;
        if (st && st.rerender === 'not-confirmed') what = `⚠ 書き込み前の描画の可能性 · 文書の版 ${docRev.slice(0, 7)} ≠ コードの版 ${code.slice(0, 7)} · 再描画を確認できません`;
        else if (vr && vr.verify === 'passed' && vr.verifiedRevision === code) what = `現在のコード · 版 ${code.slice(0, 7)} の描画を検証済み`;
        else if (docRev !== code.slice(0, docRev.length)) what = `描画の版を確認していません · 文書の版 ${docRev.slice(0, 7)} / コードの版 ${code.slice(0, 7)}`;
        else what = `現在のコード · 版 ${code.slice(0, 7)}`;
        l2.textContent = `${what}${ab.ready ? ` · CSS ${ab.ready.vw}×${ab.ready.vh}` : ''} · ${bp}`;
      }
    }
  }
  function renderTree() {
    const r = T.sel?.resolved;
    if (!r || r.status !== 'resolved') { $('tree').innerHTML = '<p class="muted">要素を選ぶと、照合できた包含関係を表示します</p>'; return; }
    const chain = [...r.chain].reverse();
    $('tree').innerHTML = `<div>page.tsx</div>${chain.map((c, i) => `<div style="padding-left:${(i + 1) * 10}px">⬡ ${esc(c)}${c === 'PropertyCard' ? ` <small class="muted">（利用・描画 ${T.sel.count}）</small>` : ''}</div>`).join('')}<div class="sel" style="padding-left:${(chain.length + 1) * 10}px">▢ ${esc(r.anchor.tag)}</div>`;
  }
  function band(t) {
    const md = T.server.theme.breakpoints.md.px;
    const max = 1600; const pct = (v) => `${(v / max) * 100}%`;
    return `<div class="band" data-testid="width-band"><div class="bar thick" style="left:0;width:${pct(md)}"></div><div class="bar thin" style="left:${pct(md)};width:${pct(max - md)}"></div>
      <span class="mk" style="left:${pct(375)}">▲375</span><span class="mk" style="left:${pct(md)}">${md}</span><span class="mk" style="left:${pct(1440)}">▲1440</span></div>
      <div class="row"><small>375 Mobile: ${t.m}</small><small>1440 Desktop: ${t.d}</small></div>`;
  }
  function renderDock() {
    const dock = $('dock'); const s = T.server;
    if (!s) return;
    if (T.review && s.draft) { dock.innerHTML = reviewHtml(); bindDock(); return; }
    let html = '';
    if (T.selNote) html += `<div class="card ${T.selNote.ok ? 'green' : 'amber'}" data-testid="sel-note">${esc(T.selNote.text)}</div>`;
    if (!T.sel) { dock.innerHTML = `${html}<p class="muted">「選択」でアートボードの要素をクリックしてください</p>${appliedHtml()}`; bindDock(); return; }
    const r = T.sel.resolved;
    if (r.status !== 'resolved') {
      dock.innerHTML = `${html}<h2>要素 / ${esc(T.sel.selection.tag)}</h2><div class="card amber" data-testid="unresolved">ソースを特定できません（${esc(r.reason)}）<br>${esc(r.detail ?? '')}</div>${appliedHtml()}`;
      bindDock(); return;
    }
    const m = T.measures[T.sel.ab]?.items?.[T.sel.ordinal];
    const ed = r.editable;
    const d = s.draft && s.draft.anchor.id === r.anchor.id ? s.draft : null;
    html += `<h2>要素 / ${esc(r.anchor.tag)}</h2><div><b>${esc(r.anchor.component)} の外枠</b></div>
      <div class="muted" data-testid="sel-summary">${esc(T.sel.ab)} ${T.sel.ab === 'Mobile' ? 375 : 1440} で選択 · ${T.sel.ordinal + 1}番目 / この幅で${T.sel.count}回描画</div>`;
    if (ed.state === 'not-editable') html += `<div class="card red" data-testid="editability">編集できません — ${esc(ed.detail)}<br><small class="muted">（理由: ${esc(ed.reason)}。推測で書き換えません）</small></div>`;
    else if (ed.state === 'conditional') html += `<div class="card amber" data-testid="editability">⚠ 共有部品の定義を変更します — ${esc(ed.detail)}</div>`;
    html += `<h5>変更する対象</h5><div class="row"><span>⬡ 部品の定義 <b class="mono">${esc(r.anchor.file.split('/').pop())}</b></span><span data-testid="usages">検出できた利用箇所 ${r.usages.length}件</span></div>
      <div class="muted"><small>静的走査で検出（網羅は保証しません）。開いたページの対応表だけで数えると ${r.usageCount?.manifestOnly ?? '—'} 件</small></div>
      <div class="muted mono">${r.usages.map((u) => `${esc(u.file)}:${u.line}`).join('<br>')}</div>
      ${ed.state === 'conditional' ? '<div class="muted">ⓘ この利用箇所だけの変更は不可（内側の余白は定義の中で決まっています）</div>' : ''}`;
    if (r.class && ed.state !== 'not-editable') {
      const cur = r.class.basePadding[0];
      const opts = ['p-3', 'p-4', 'p-5', 'p-6', 'p-8'];
      const val = d ? d.value : cur;
      const ov = r.class.overrides.map((o) => `${o.token}（${o.minPx}px 以上で ${o.px}px）`).join('、');
      const mobileM = T.measures.Mobile?.items?.[0];
      const deskM = T.measures.Desktop?.items?.[0];
      html += `<h5>余白（内側）</h5>
        <div class="card"><div class="muted">選択した表示幅</div><div class="row" data-testid="selected-width"><span>${esc(T.sel.ab)} ${T.sel.ab === 'Mobile' ? 375 : 1440}</span><span class="mono">効いている指定 ${esc(m ? curToken(m) ?? '' : '')} / 計算済み ${m ? m.pad[0] : '—'}px${T.view === 'preview' ? '（予測）' : ''}</span></div></div>
        <div class="muted">変更が適用される幅</div><div class="bps"><span class="on">基本（全幅）</span><span>sm</span><span>md · 上書きあり</span><span>lg</span><span>xl</span></div>
        <div class="muted"><small>この PoC で書けるのは基本（全幅）だけ。ブレークポイントは題材の Tailwind 設定から読んだ値（md = ${s.theme.breakpoints.md.css} = ${s.theme.breakpoints.md.px}px）</small></div>
        <div class="muted" style="margin-top:6px">見た目が変わる幅 <span class="badge warn">${esc(ov)} が優先</span></div>
        ${band({ m: '変わる（予測）', d: '変わらない（予測）' })}
        <div class="muted" data-testid="band-note"><small>帯は設定からの<b>予測</b>。実際に開いて確かめた幅は 375・1440 だけ（現在の計算済み: Mobile ${mobileM ? mobileM.pad[0] : '—'}px / Desktop ${deskM ? deskM.pad[0] : '—'}px${T.view === 'preview' ? '・予測の表示' : '・現在のコード'}）。376〜767px などの中間の幅は確かめていません</small></div>
        <h5>ソース</h5><div class="mono muted" data-testid="write-target">${esc(r.anchor.file)}:${r.anchor.line} · className の ${esc(cur)}${d && !d.isNoop ? ` → ${esc(d.value)}` : ''}</div>
        <div class="row"><select id="val" data-testid="value">${opts.map((o) => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>
          <span class="mono">${d && !d.isNoop ? `◆ 下書き · 変更前 ${esc(d.from)}` : 'コードのまま'}</span></div>
        <h5>影響範囲</h5><div class="check ok">表示確認: /properties（2つの幅・各 ${T.sel.count} 回描画）</div>
        <div class="check">未確認: /favorites（開いていません）· 動的な利用箇所</div>
        <div class="muted"><small>同じクラスを持つ無関係な要素（変わらないことを検証に使う）: ${(r.sameClass ?? []).map((c) => `${esc(c.component)} ${esc(c.file)}:${c.line}`).join('、') || 'なし'}</small></div>`;
    }
    if (d && !d.isNoop) html += `<div class="card" data-testid="draft-summary">この要素の下書き 1件（余白 ${esc(d.from)} → ${esc(d.value)}）· ファイルは未変更 <button class="btn primary" id="openReview" data-testid="open-review">変更を確認</button></div>`;
    if (T.conflict) html += `<div class="card amber" data-testid="conflict">${esc(T.conflict.detail ?? T.conflict.reason)}</div>`;
    html += appliedHtml();
    dock.innerHTML = html;
    bindDock();
  }
  function reviewHtml() {
    const d = T.server.draft;
    const diff = d.diff ? d.diff.split('\n').map((l) => `<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}">${esc(l)}</span>`).join('\n') : '';
    let html = `<h2>変更の確認（S-14 の最小版）</h2><div class="muted">コードへ書き込む判断はここだけで行います</div>
      <div class="card"><div class="row"><span>変更案</span><span>利用者（下書き）</span></div><div class="row"><span>ファイル</span><span class="mono" data-testid="review-file">${esc(d.rel)}</span></div>
      <div class="row"><span>基準の内容</span><span class="mono">${d.baseHash.slice(0, 12)}</span></div><div class="row"><span>いまの内容</span><span class="mono" data-testid="review-current">${d.currentHash.slice(0, 12)} ${d.upToDate ? '（一致）' : '（違う — 外部変更）'}</span></div></div>`;
    if (d.problem) {
      html += `<div class="card amber" data-testid="review-conflict">${esc(d.problem.detail)}</div><button class="btn" id="recheck" data-testid="recheck">再確認（いまの内容で差分を作り直す）</button>`;
    } else html += `<pre class="diff" data-testid="diff">${diff}</pre>`;
    if (T.conflict && !d.problem) html += `<div class="card amber" data-testid="conflict">${esc(T.conflict.detail ?? T.conflict.reason)}</div>`;
    html += `<div class="row" style="margin-top:8px"><button class="btn" id="back">編集に戻る</button><button class="btn" id="discard" data-testid="discard">下書きを破棄</button><button class="btn primary" id="apply" data-testid="apply" ${d.problem ? 'disabled' : ''}>コードに適用</button></div>`;
    return html + appliedHtml();
  }
  function appliedHtml() {
    const list = T.server?.applied ?? [];
    if (!list.length && !T.revertRefusal) return '';
    let h = '<h5>適用済みの変更（未コミット）</h5>';
    for (const a of list) {
      const v = a.verifications.at(-1);
      h += `<div class="card" data-testid="applied-${a.id}"><div class="row"><span class="mono">${esc(a.rel.split('/').pop())} ${esc(a.from)} → ${esc(a.to)}</span><span class="mono">版 ${a.revBefore.slice(0, 7)} → ${a.revAfter.slice(0, 7)}</span></div>
        <div class="row"><span>書き込み</span><span>${esc(a.status.write)}</span></div><div class="row"><span>再描画</span><span>${esc(a.status.rerender)}</span></div><div class="row"><span>検証</span><span data-testid="applied-verify">${esc(a.status.verify)}</span></div>
        ${a.revert ? `<div class="row"><span>取り消し</span><span data-testid="revert-state">${esc(a.revert.status)} · 再描画 ${esc(a.revert.rerender)} · 検証 ${esc(a.revert.verify)}</span></div>` : ''}
        ${v ? `<details ${v.verify !== 'passed' ? 'open' : ''}><summary>最後の検証（${esc(v.phase)} · ${esc(v.rerender)} · ${esc(v.verify)}）</summary>${v.reason ? `<div class="card amber">${esc(v.reason)}</div>` : ''}${v.checks.map((c) => `<div class="check ${c.ok ? 'ok' : 'ng'}">${esc(c.m)}</div>`).join('')}</details>` : ''}
        <div class="row" style="margin-top:4px">${a.revert ? '' : `<button class="btn" data-revert="${a.id}" data-testid="revert">適用を取り消す</button>`}
        ${(a.revert ? a.revert.verify : a.status.verify) !== 'passed' ? `<button class="btn" data-reload="${a.id}" data-testid="reload-check">再読み込みして確認</button>` : ''}</div></div>`;
    }
    if (T.revertRefusal) h += `<div class="card amber" data-testid="revert-refused">取り消しませんでした — ${esc(T.revertRefusal.detail ?? T.revertRefusal.status)}<pre class="diff">${esc(T.revertRefusal.diffSinceApply ?? '')}</pre></div>`;
    return h;
  }
  function bindDock() {
    const on = (id, f) => { const e = $(id); if (e) e.onclick = f; };
    const v = $('val'); if (v) v.onchange = () => setDraft(v.value);
    on('openReview', async () => { T.review = true; T.conflict = null; await refresh(); });
    on('back', () => { T.review = false; render(); });
    on('discard', async () => { if (T.view === 'preview') await setView('current'); await api('/api/draft/discard', {}); T.review = false; await refresh(); });
    on('apply', () => apply());
    on('recheck', async () => {
      const r = await api('/api/draft/recheck', {});
      T.conflict = r.ok ? null : { reason: r.reason, detail: r.detail };
      await refresh();
    });
    for (const b of document.querySelectorAll('[data-revert]')) b.onclick = () => revert(b.dataset.revert);
    for (const b of document.querySelectorAll('[data-reload]')) b.onclick = () => reloadCheck(b.dataset.reload);
  }
  function renderFlow() {
    const s = T.server; if (!s) return;
    const f = s.observation.freshness;
    $('freshness').innerHTML = `観測の記録 版 ${esc(s.observation.revision.slice(0, 7))} · 現在の版 ${esc(s.revision.id.slice(0, 7))} · <b data-testid="freshness">${esc(f.label)}</b> · 下書きは含みません`;
    const r = T.sel?.resolved;
    if (!r || r.status !== 'resolved') { $('flow').innerHTML = '<p class="muted">要素を選ぶと表示します</p>'; return; }
    const hasValue = T.sel.selection?.textNodeIndex !== null && T.sel.selection?.textNodeIndex !== undefined;
    $('flow').innerHTML = hasValue
      ? '<b>この要素は値を表示しています</b><p class="muted">この PoC では通信・SQL・由来を取得していません（観測の鮮度の状態だけを検証）。</p>'
      : '<b data-testid="flow-container">この要素自体は値を表示していません</b><p class="muted">出所を見る値を選択してください（中の値の経路を代表1本にまとめては表示しません）</p><p class="muted"><small>この PoC では通信・SQL・由来を取得していません。上の見出しは観測の鮮度の状態管理だけを示します。</small></p>';
  }
  function renderConn() {
    const n = ARTBOARDS.filter((a) => a.conn).length;
    $('connChip').innerHTML = `接続 ${n}/2 · 拒否 <b id="rejected">${T.rejected}</b>`;
  }
  function renderLog() {
    const s = T.server;
    $('log').textContent = [...(s?.log ?? []).map((e) => `${e.t.slice(11, 23)} [${e.kind}] ${e.msg}`), '--- 画面', ...T.clientLog.slice(-30)].join('\n');
  }

  /* ------------------------------------------------------------ 操作 */
  $('btnSelect').onclick = () => { T.mode = 'select'; for (const ab of ARTBOARDS) send(ab, { kind: 'mode', select: true }); $('btnSelect').classList.add('on'); $('btnInteract').classList.remove('on'); drawOverlays(); };
  $('btnInteract').onclick = async () => {
    if (T.view === 'preview') { await setView('current'); clog('ページを操作に入ったため、予測の表示を外しました（04e 4.2）'); }
    T.mode = 'interact'; for (const ab of ARTBOARDS) send(ab, { kind: 'mode', select: false });
    $('btnInteract').classList.add('on'); $('btnSelect').classList.remove('on'); drawOverlays();
  };
  $('viewCurrent').onclick = () => setView('current');
  $('viewPreview').onclick = async () => {
    T.premeasure = {}; for (const ab of ARTBOARDS) T.premeasure[ab.name] = T.measures[ab.name];
    await setView('preview');
  };
  $('undo').onclick = () => draftStep('undo');
  $('redo').onclick = () => draftStep('redo');
  $('scale').onchange = () => { T.scale = Number($('scale').value); layout(); };
  T.api = { setDraft, setView, apply, revert, reloadCheck, refresh, measure: (name, anchor) => measure(ARTBOARDS.find((a) => a.name === name), anchor), ARTBOARDS };

  /* 予測の既定に入る前の値を覚えておく（「この幅は変化なし」を出すため） */
  const _setView = setView;
  setView = async function (v) {   // eslint-disable-line no-func-assign
    if (v === 'preview' && T.view !== 'preview') { T.premeasure = {}; for (const ab of ARTBOARDS) T.premeasure[ab.name] = T.sel ? await measure(ab, T.sel.anchorId) : null; }
    return _setView(v);
  };
  T.api.setView = setView;

  layout();
  for (const ab of ARTBOARDS) load(ab);
  refresh();
  setInterval(() => { if (!T.busy) refresh(); }, 2000);
})();
