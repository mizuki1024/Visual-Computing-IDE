/* =============================================================================
 * 浮かぶパネルとキャンバスの重なりを、**実際の DOM の矩形**で測る（Phase 7C-0 の計測を共通化）。
 *   scripts/acceptance-7c0.mjs と scripts/acceptance-7c2.mjs が使う。パネルは隠さずに測る。
 *
 * overlap(page)          … 7C-0 と同じ定義。経路のノード（g.nd）のうち、浮かぶパネル（.fpnl）に
 *                          面積の 5% を超えて覆われているもの
 * measureCanvas(page)    … 7C-2 で足した計測。ノードの図形に加えて、ラベル札・「推定」の印・切断の印・
 *                          接続線（g.hp。線上の 24 点）について、
 *                          ① 浮かぶパネル・操作バー・注記に覆われているか
 *                          ② キャンバスの見えている範囲（右ドックの左・上端のバーの下）から外れているか
 *                          を数える。倍率（k）と、ラベル札の文字の実寸（12px × k）も残す
 * ========================================================================== */

/** 7C-0 と同じ定義（比較のため変えない） */
export async function overlap(page) {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll('.fpnl')].map((p) => ({ name: p.getAttribute('aria-label'), r: p.getBoundingClientRect() }));
    const dock = document.querySelector('aside.dock')?.getBoundingClientRect() ?? null;
    const nodes = [...document.querySelectorAll('g.nd')].map((g) => ({ label: g.getAttribute('aria-label'), r: g.getBoundingClientRect() }));
    const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const vw = innerWidth, vh = innerHeight;
    return {
      panels: panels.map((p) => ({ name: p.name, x: Math.round(p.r.left), y: Math.round(p.r.top), w: Math.round(p.r.width), h: Math.round(p.r.height) })),
      nodes: nodes.map((n) => {
        const area = n.r.width * n.r.height || 1;
        const by = panels.map((p) => ({ name: p.name, frac: inter(n.r, p.r) / area })).filter((x) => x.frac > 0.05);
        const off = n.r.right < 0 || n.r.left > (dock ? dock.left : vw) || n.r.bottom < 0 || n.r.top > vh;
        const underDock = dock ? inter(n.r, dock) / area > 0.05 : false;
        return { label: n.label, coveredBy: by.map((b) => `${b.name}:${Math.round(b.frac * 100)}%`), offscreen: off, underDock };
      }),
    };
  });
}

export const summarizeOverlap = (o) => {
  const covered = o.nodes.filter((n) => n.coveredBy.length);
  return { nodes: o.nodes.length, covered: covered.length, offscreen: o.nodes.filter((n) => n.offscreen).length, coveredList: covered.map((n) => `${n.label} ← ${n.coveredBy.join(',')}`) };
};

/** 7C-2 の計測。覆う側は「浮かぶパネル・操作バー・注記」、見える範囲はキャンバスの矩形 */
export async function measureCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.canvas');
    const cv = canvas.getBoundingClientRect();
    const covers = [...canvas.querySelectorAll(':scope > .fpnl, :scope > .ctl, :scope > .note')].map((p) => ({
      name: p.getAttribute('aria-label') ?? (p.classList.contains('ctl') ? '操作バー' : '注記'),
      r: p.getBoundingClientRect(),
      folded: p.getAttribute('data-folded'),
    })).filter((p) => p.r.width > 0 && p.r.height > 0);
    const inter = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const rnd = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    const judge = (r) => {
      const area = r.width * r.height || 1;
      const by = covers.map((p) => ({ name: p.name, frac: inter(r, p.r) / area })).filter((x) => x.frac > 0.05);
      const outside = 1 - inter(r, cv) / area;
      return { coveredBy: by.map((b) => `${b.name}:${Math.round(b.frac * 100)}%`), outside: outside > 0.05 ? Math.round(outside * 100) : 0 };
    };
    const items = (sel, labelOf) => [...document.querySelectorAll(sel)].map((g) => {
      const r = g.getBoundingClientRect();
      return { label: labelOf(g), rect: rnd(r), ...judge(r) };
    });
    const nodes = items('g.nd', (g) => g.getAttribute('aria-label'));
    const chips = items('g[data-mark="chip"]', (g) => `札 ${g.getAttribute('data-node')}: ${g.textContent.slice(0, 60)}`);
    const tags = items('g[data-mark^="estimate"]', (g) => `${g.getAttribute('data-mark')}: ${g.textContent}`);
    const cuts = items('g[data-mark="cut"]', (g) => `切断: ${g.textContent.slice(0, 60)}`);
    // 接続線: 見えている線（最後の path）上の 24 点が、覆われていないか・見える範囲にあるか
    const inside = (x, y, r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    const hops = [...document.querySelectorAll('g.hp')].map((g) => {
      const paths = g.querySelectorAll('path');
      const p = paths[paths.length - 1];
      const L = p.getTotalLength();
      const m = p.getScreenCTM();
      let hidden = 0; let out = 0; const N = 24;
      const who = new Set();
      for (let i = 0; i <= N; i++) {
        const q = p.getPointAtLength((L * i) / N);
        const x = m.a * q.x + m.c * q.y + m.e; const y = m.b * q.x + m.d * q.y + m.f;
        if (!inside(x, y, cv)) { out++; continue; }
        const c = covers.find((o) => inside(x, y, o.r));
        if (c) { hidden++; who.add(c.name); }
      }
      return { label: g.getAttribute('aria-label'), estimated: /（推定）$/.test(g.getAttribute('aria-label') ?? ''), dashed: !!p.getAttribute('stroke-dasharray'), hiddenPct: Math.round((hidden / (N + 1)) * 100), outsidePct: Math.round((out / (N + 1)) * 100), by: [...who] };
    });
    const scene = document.querySelector('.scene > g')?.getAttribute('transform') ?? '';
    const k = Number(/scale\(([\d.]+)\)/.exec(scene)?.[1] ?? NaN);
    return {
      canvas: rnd(cv), k: Math.round(k * 1000) / 1000, chipFontPx: Math.round(12 * k * 10) / 10,
      zoomLabel: document.querySelector('.ctl .val')?.textContent ?? null,
      panels: covers.map((p) => ({ name: p.name, ...rnd(p.r), folded: p.folded })),
      nodes, chips, tags, cuts, hops,
    };
  });
}

/** 合否の材料だけを短く */
export function summarizeCanvas(m) {
  const bad = (xs) => xs.filter((x) => x.coveredBy.length || x.outside);
  const hopBad = m.hops.filter((h) => h.hiddenPct > 0 || h.outsidePct > 0);
  return {
    k: m.k, chipFontPx: m.chipFontPx,
    nodes: m.nodes.length, nodesHidden: bad(m.nodes).length,
    chips: m.chips.length, chipsHidden: bad(m.chips).length,
    tags: m.tags.length, tagsHidden: bad(m.tags).length,
    cuts: m.cuts.length, cutsHidden: bad(m.cuts).length,
    hops: m.hops.length, hopsHidden: hopBad.length,
    estimatedHops: m.hops.filter((h) => h.estimated).map((h) => `${h.label} 隠れ${h.hiddenPct}%・外${h.outsidePct}%・破線${h.dashed ? 'あり' : 'なし'}`),
    hiddenList: [
      ...bad(m.nodes).map((n) => `${n.label} ← ${n.coveredBy.join(',')}${n.outside ? ` 外${n.outside}%` : ''}`),
      ...bad(m.chips).map((n) => `${n.label} ← ${n.coveredBy.join(',')}${n.outside ? ` 外${n.outside}%` : ''}`),
      ...bad(m.tags).map((n) => `${n.label} ← ${n.coveredBy.join(',')}${n.outside ? ` 外${n.outside}%` : ''}`),
      ...bad(m.cuts).map((n) => `${n.label} ← ${n.coveredBy.join(',')}${n.outside ? ` 外${n.outside}%` : ''}`),
      ...hopBad.map((h) => `線 ${h.label} 隠れ${h.hiddenPct}% 外${h.outsidePct}% ← ${h.by.join(',')}`),
    ],
    panels: m.panels.map((p) => `${p.name} ${p.x},${p.y} ${p.w}×${p.h}${p.folded ? ` 畳み:${p.folded}` : ''}`),
  };
}
