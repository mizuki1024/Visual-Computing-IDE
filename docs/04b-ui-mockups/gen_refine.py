# -*- coding: utf-8 -*-
"""Phase 4B — A案「Data Flow First」の改善案 A-1 / A-2 / A-3（検討用モック）

A案の基本コンセプト（データフロー中心・3層の空間表現・線画ノード・ダーク・
実測/推定の区別・段階的開示）は変更していない。レイアウトのみを3通りに振る。
"""
import sys, os, io, math
sys.path.insert(0, "/Users/mizuki/Visiual Computing IDE/docs/04-ui-mockups")
from gen_common import (CSS_TOKENS, defs, node, edge, cap, tag_est, tag_obs, cut,
                        ICON, HALO, n0, n1, pages, preview, drawer, SUMMARY, WEAK, STEPS)

OUT = "/Users/mizuki/Visiual Computing IDE/docs/04b-ui-mockups"

# ------------------------------------------------------------------ 追加CSS
CSS_ADD = """
/* 詳細パネル：ステップ間の関係説明（Phase 4B で追加。キャンバスから移した文） */
.st .conn{bottom:0}
.rel{position:relative;padding:0 0 1px 28px}
.rel .rconn{position:absolute;left:8.5px;top:-6px;bottom:-6px;width:1px;background:var(--line)}
.rel.est .rconn{background:repeating-linear-gradient(180deg,#453f68 0 3px,transparent 3px 6px)}
.rel .rt{font-size:9.5px;color:#717a8d;line-height:1.5;display:block}
.rel.est .rt{color:#8f86bd}
.rel .rt i{font-style:normal;color:var(--tx4)}
.ret{margin:4px 0 0 0;display:flex;align-items:center;gap:7px;padding:4px 9px;border-radius:7px;
     border:1px dashed rgba(157,147,224,.30);background:rgba(157,147,224,.05)}
.ret b{font-size:10.5px;color:#cfc6f5;font-weight:400}
.ret span{font-size:10px;color:#9a90cb;line-height:1.5}
.ret u{text-decoration:none;font-family:ui-monospace,Menlo,monospace}
/* プレビュー：ペイン幅が狭い案でもサイトのナビが折り返さないようにする（モックの見え方の統一） */
.s-nav{gap:12px}
.s-nav a{white-space:nowrap}
/* Phase 4B：説明を1行ずつ足したぶん、既存ブロックの余白を詰めて同じ高さに収める */
.sum{padding:9px 14px 10px}
.sum p{margin-top:7px;line-height:1.6}
.hint{margin-top:6px;padding-top:6px}
.weak{margin-top:8px;padding:9px 11px}
.weak .wh{margin-top:6px}
.weak p{margin-top:5px;line-height:1.6}
.weak .ev{margin-top:6px;padding-top:6px;line-height:1.55}
.btn{margin-top:7px}
.steps{padding:7px 14px 0}
.steps .k{margin-bottom:6px}
.st{padding:1px 0}
.st.cur{padding:6px 8px}
.tabs{margin-top:8px}
.ovw{margin-top:6px;padding:6px 9px}
.ovw dl{gap:3px 12px}
"""

# ------------------------------------------------------------------ 幾何ヘルパ
def rp(pts, r=13):
    """直交折れ線を角丸で描く。pts=[(x,y),...]"""
    if len(pts) < 2:
        return ""
    d = ["M%g,%g" % pts[0]]
    for i in range(1, len(pts) - 1):
        (x0, y0), (x1, y1), (x2, y2) = pts[i - 1], pts[i], pts[i + 1]
        dx1, dy1 = x1 - x0, y1 - y0
        dx2, dy2 = x2 - x1, y2 - y1
        l1, l2 = math.hypot(dx1, dy1), math.hypot(dx2, dy2)
        rr = min(r, l1 / 2.0, l2 / 2.0)
        ax, ay = x1 - dx1 / l1 * rr, y1 - dy1 / l1 * rr
        bx, by = x1 + dx2 / l2 * rr, y1 + dy2 / l2 * rr
        d.append("L%.1f,%.1f" % (ax, ay))
        d.append("Q%g,%g %.1f,%.1f" % (x1, y1, bx, by))
    d.append("L%g,%g" % pts[-1])
    return " ".join(d)

def plen(pts):
    return sum(math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]) for i in range(len(pts)-1))

def groove(pts, w=30, col="rgba(157,147,224,.055)"):
    """戻りレーンの溝（線そのものではなく、線が通る帯）"""
    return (f'<path d="{rp(pts,16)}" fill="none" stroke="{col}" stroke-width="{w}" '
            f'stroke-linecap="round" stroke-linejoin="round"/>')

def forkdot(x, y, est=False):
    c = "#9a8fc4" if est else "#8aa4cc"
    return (f'<circle cx="{x}" cy="{y}" r="3.4" fill="#0b0e14" stroke="{c}" stroke-width="1.4"/>')

def band_rules(labels, y0=40, y1=802, lab_y=27):
    """A-1 / A-2：帯見出し＋細い境界線"""
    s = [f'<path d="M0,{y0} H9999" stroke="#11141c" stroke-width="1"/>']
    for (cx, t) in labels:
        s.append(f'<text x="{cx}" y="{lab_y}" text-anchor="middle" font-size="10.5" fill="#6d7689" '
                 f'letter-spacing="2.6">{t}</text>')
    return s

def band_div(xs, y0=40, y1=806):
    return ["".join(f'<path d="M{x},{y0} V{y1}" stroke="#14192300" stroke-width="1"/>' for x in [])] + \
           [f'<path d="M{x},{y0} V{y1}" stroke="#232b3c" stroke-width="1"/>' for x in xs]

def band_fill(x0, x1, y0, y1, label):
    """A-3：罫線をやめて淡い面で層を示す"""
    return (f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" rx="16" '
            f'fill="rgba(255,255,255,.021)"/>'
            f'<text x="{(x0+x1)/2}" y="{y0-13}" text-anchor="middle" font-size="10.5" fill="#6d7689" '
            f'letter-spacing="2.6">{label}</text>')

def star_chip(x, y):
    """★推定チップ（最弱環）"""
    w = 60
    return (f'<rect x="{x-w/2}" y="{y-10}" width="{w}" height="20" rx="6" fill="#0e1019" '
            f'stroke="#6f66a8" stroke-dasharray="4 3"/>'
            f'<text x="{x-w/2+10}" y="{y+4.5}" font-size="11" fill="#cfc6f5">★</text>'
            f'<text x="{x+7}" y="{y+4}" text-anchor="middle" font-size="10" fill="#bcb2ec">推定</text>')

def cut_up(x, y_from, y_to):
    tx_y = y_to - 48
    """サーバーから外へ出る、追跡できない呼び出し（E-07）。層の外＝上へ抜ける"""
    return (f'<path d="M{x},{y_from} V{y_to}" fill="none" stroke="#6d5f44" stroke-width="1.4" '
            f'stroke-dasharray="4 4"/>'
            + cut(x, y_to - 4, -90) +
            f'<text x="{x}" y="{tx_y}" text-anchor="middle" font-size="10.5" fill="#bfa073">追跡できません</text>'
            f'<text x="{x}" y="{tx_y+14}" text-anchor="middle" font-size="10" fill="#7d6a4c">未対応の構成です</text>')

def svgwrap(w, h, uid, inner):
    return (f'<svg width="100%" height="100%" viewBox="0 0 {w} {h}" preserveAspectRatio="xMidYMid meet" '
            f'style="display:block">{defs(uid)}{inner}</svg>')

def page(title, body, css_extra=""):
    return f"""<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>{title}</title><style>{CSS_TOKENS}{CSS_ADD}{css_extra}</style></head><body>
<div class="app">{n0()}{n1()}{body}{drawer().replace("Phase 4A UI検討用モック","Phase 4B UI検討用モック")}</div></body></html>"""

# ------------------------------------------------------------------ 詳細パネル
# Phase 4B：キャンバスから外したホップの説明を、ここに1行ずつ置く。
REL = {
 2: ("この値を描いたコンポーネント", False),
 3: ("応答のどの項目が、この値になったか", True),
 4: ("この通信を受けたサーバーの処理", False),
 5: ("その処理が実行したSQL", False),
 6: ("⑤ から分岐 — そのSQLが読んだテーブル", False),
 7: ("⑤ から分岐 — そのSQLが取り出した列", False),
}

OVW = """<div style="margin:2px 0 6px 28px">
  <div class="tabs"><span class="on">概要</span><span>根拠</span></div>
  <div class="ovw"><dl>
    <dt>取得手段</dt><dd>ブラウザのDOM読み取り</dd>
    <dt>要素</dt><dd>&lt;span&gt; / PropertyCard 内</dd>
    <dt>次の一歩</dt><dd style="font-family:inherit;color:#9a90cb">⑦ のカラムから実際の値を開く</dd>
  </dl></div></div>"""

def steps_html_b(cur=1):
    rows = []
    for i, (n, t, s, tag, _estc) in enumerate(STEPS):
        num = int(n)
        if num in REL:
            txt, est = REL[num]
            rows.append(f'<div class="rel{" est" if est else ""}"><span class="rconn"></span>'
                        f'<span class="rt">{txt}{" <i>（推定）</i>" if est else ""}</span></div>')
        cls = "st" + (" cur" if num == cur else "")
        conn = '<span class="conn"></span>' if i < len(STEPS) - 1 else ""
        rows.append(f'<div class="{cls}">{conn}<span class="bd">{n}</span>'
                    f'<span class="tx"><span class="tt">{t}</span><span class="ts">{s}</span></span>'
                    f'<span class="tg">{tag}</span></div>')
        if num == cur:
            rows.append(OVW)
    rows.append('<div class="ret"><b>★</b><span><u>⑦ → ③</u> ここから ③ の応答へ戻ります'
                '（いちばん弱いところ）</span></div>')
    return '<div class="steps"><div class="k">経路のステップ（7）</div>' + "".join(rows) + '</div>'

PANEL = SUMMARY + WEAK + steps_html_b(1)

# ==================================================================== A-1
def plan_a1():
    W, H, u = 620, 818, "a1"
    BX, SX, DX = 139, 339, 520          # 帯の中心
    s = []
    s += band_rules([(BX, "ブラウザ"), (SX, "サーバー"), (DX, "データベース")])
    s += band_div([242, 436])
    ret = [(DX, 652), (DX, 714), (56, 714), (56, 384), (113, 384)]
    # 往路
    s.append(edge(rp([(BX, 122), (BX, 214)]), u))
    s.append(edge(rp([(BX, 266), (BX, 358)]), u, est=True))
    s.append(tag_est(BX, 312))
    s.append(edge(rp([(165, 384), (313, 384)]), u))
    s.append(edge(rp([(SX, 410), (SX, 514)]), u))
    # ⑤ の分岐（共通の枝 → 分岐点 → 2本）
    s.append('<path d="M365,540 H404" fill="none" stroke="#8aa4cc" stroke-width="1.4" stroke-linecap="round"/>')
    s.append(edge(rp([(404, 540), (404, 452), (494, 452)]), u))
    s.append(edge(rp([(404, 540), (404, 626), (494, 626)]), u))
    s.append(forkdot(404, 540))
    # 戻り（推定・最弱環）
    s.append(edge(rp(ret, 16), u, est=True))
    s.append(star_chip(300, 714))
    s.append(cap(300, 694, ["カラムと応答項目の対応づけ"], est=True))
    # 切断（サーバーから層の外へ）
    s.append(cut_up(SX, 358, 280))
    # 選択していない経路（減光・UI-33）
    s.append('<text x="36" y="752" font-size="10" fill="#3f4759">選択していない経路（このページの他の通信）</text>')
    s.append(edge("M155,784 L323,784", u, dim=True))
    s.append(node(BX, 784, 30, "http", 0, "", "", dim=True))
    s.append(f'<text x="{BX}" y="806" text-anchor="middle" font-size="9.5" fill="#434b5d" font-family="ui-monospace,Menlo,monospace">GET /api/favorites</text>')
    s.append(node(SX, 784, 30, "sql", 0, "", "", dim=True))
    s.append(f'<text x="{SX}" y="806" text-anchor="middle" font-size="9.5" fill="#434b5d">SQL</text>')
    # ノード
    s.append(node(BX, 96, 52, "value", 1, "表示された値", "「千葉県」"))
    s.append(node(BX, 240, 52, "component", 2, "コンポーネント", "PropertyCard"))
    s.append(node(BX, 384, 52, "http", 3, "通信", "GET /api/properties"))
    s.append(node(SX, 384, 52, "server", 4, "サーバー処理", ""))
    s.append(node(SX, 540, 52, "sql", 5, "実行SQL", ""))
    s.append(node(DX, 452, 52, "table", 6, "テーブル", "properties"))
    s.append(node(DX, 626, 52, "column", 7, "カラム", "area", "right"))
    return svgwrap(W, H, u, "".join(s)), plen(ret)

def build_a1():
    svg, _ = plan_a1()
    body = f"""<div class="body">
  {pages(160)}
  <div class="pane" style="width:410px;flex:0 0 410px">
    <div class="ph">プレビュー<span class="r"><span>現物</span></span></div>
    {preview(271)}
  </div>
  <div class="pane" style="flex:1;min-width:0">
    <div class="ph">データフロー<span class="r"><span>/properties</span><span>通信 3 ／ SQL 2 ／ 142 ms</span></span></div>
    <div style="flex:1;min-height:0;background:radial-gradient(1100px 700px at 30% 18%,#0d1017 0%,#090b11 70%)">{svg}</div>
  </div>
  <div class="pane dp" style="width:360px;flex:0 0 360px">
    <div class="ph">詳細<span class="r"><span>経路</span></span></div>
    {PANEL}
  </div>
</div>"""
    return page("A-1 最小改善 — S-04 探索（Phase 4B）", body)

# ==================================================================== A-2
def plan_a2():
    W, H, u = 680, 818, "a2"
    BX, X4, X5, DX = 124, 292, 436, 580
    ROW = 436
    s = []
    s += band_rules([(BX, "ブラウザ"), (364, "サーバー"), (DX, "データベース")])
    s += band_div([218, 510])
    ret = [(DX, 574), (DX, 646), (46, 646), (46, ROW), (98, ROW)]
    # 入口の縦ステム
    s.append(edge(rp([(BX, 174), (BX, 266)]), u))
    s.append(edge(rp([(BX, 318), (BX, 410)]), u, est=True))
    s.append(tag_est(BX, 370))
    # 往路：③→④→⑤ を1本の水平線にそろえる
    s.append(edge(rp([(150, ROW), (266, ROW)]), u))
    s.append(edge(rp([(318, ROW), (410, ROW)]), u))
    # ⑤ の分岐
    s.append('<path d="M462,436 H496" fill="none" stroke="#8aa4cc" stroke-width="1.4" stroke-linecap="round"/>')
    s.append(edge(rp([(496, ROW), (496, 320), (554, 320)]), u))
    s.append(edge(rp([(496, ROW), (496, 548), (554, 548)]), u))
    s.append(forkdot(496, ROW))
    # 復路
    s.append(edge(rp(ret, 16), u, est=True))
    s.append(star_chip(310, 646))
    s.append(cap(310, 626, ["カラムと応答項目の対応づけ"], est=True))
    # 切断
    s.append(cut_up(X4, 410, 330))
    # 選択していない経路
    s.append('<text x="32" y="712" font-size="10" fill="#3f4759">選択していない経路（このページの他の通信）</text>')
    s.append(edge("M140,748 L276,748", u, dim=True))
    s.append(node(BX, 748, 30, "http", 0, "", "", dim=True))
    s.append(f'<text x="{BX}" y="770" text-anchor="middle" font-size="9.5" fill="#434b5d" font-family="ui-monospace,Menlo,monospace">GET /api/favorites</text>')
    s.append(node(X4, 748, 30, "sql", 0, "", "", dim=True))
    s.append(f'<text x="{X4}" y="770" text-anchor="middle" font-size="9.5" fill="#434b5d">SQL</text>')
    # ノード
    s.append(node(BX, 148, 52, "value", 1, "表示された値", "「千葉県」"))
    s.append(node(BX, 292, 52, "component", 2, "コンポーネント", "PropertyCard"))
    s.append(node(BX, ROW, 52, "http", 3, "通信", "GET /api/properties"))
    s.append(node(X4, ROW, 52, "server", 4, "サーバー処理", ""))
    s.append(node(X5, ROW, 52, "sql", 5, "実行SQL", ""))
    s.append(node(DX, 320, 52, "table", 6, "テーブル", "properties"))
    s.append(node(DX, 548, 52, "column", 7, "カラム", "area", "right"))
    return svgwrap(W, H, u, "".join(s)), plen(ret)

def build_a2():
    svg, _ = plan_a2()
    body = f"""<div class="body">
  {pages(140)}
  <div class="pane" style="width:370px;flex:0 0 370px">
    <div class="ph">プレビュー<span class="r"><span>現物</span></span></div>
    {preview(271)}
  </div>
  <div class="pane" style="flex:1;min-width:0">
    <div class="ph">データフロー<span class="r"><span>/properties</span><span>通信 3 ／ SQL 2 ／ 142 ms</span></span></div>
    <div style="flex:1;min-height:0;background:radial-gradient(1100px 700px at 32% 22%,#0d1017 0%,#090b11 70%)">{svg}</div>
  </div>
  <div class="pane dp" style="width:360px;flex:0 0 360px">
    <div class="ph">詳細<span class="r"><span>経路</span></span></div>
    {PANEL}
  </div>
</div>"""
    return page("A-2 経路の読みやすさ優先 — S-04 探索（Phase 4B）", body)

# ==================================================================== A-3
def plan_a3():
    W, H, u = 700, 818, "a3"
    BX, SX, DX = 138, 368, 584
    s = []
    s.append(band_fill(28, 248, 46, 806, "ブラウザ"))
    s.append(band_fill(258, 478, 46, 806, "サーバー"))
    s.append(band_fill(488, 680, 46, 806, "データベース"))
    ret = [(DX, 681), (DX, 718), (48, 718), (48, 412), (109, 412)]
    s.append(edge(rp([(BX, 141), (BX, 233)]), u))
    s.append(edge(rp([(BX, 291), (BX, 383)]), u, est=True))
    s.append(tag_est(BX, 340))
    s.append(edge(rp([(167, 412), (339, 412)]), u))
    s.append(edge(rp([(SX, 441), (SX, 537)]), u))
    s.append('<path d="M397,566 H440" fill="none" stroke="#8aa4cc" stroke-width="1.4" stroke-linecap="round"/>')
    s.append(edge(rp([(440, 566), (440, 474), (555, 474)]), u))
    s.append(edge(rp([(440, 566), (440, 652), (555, 652)]), u))
    s.append(forkdot(440, 566))
    s.append(edge(rp(ret, 18), u, est=True))
    s.append(star_chip(300, 718))
    s.append(cap(300, 698, ["カラムと応答項目の対応づけ"], est=True))
    s.append(cut_up(SX, 383, 300))
    s.append('<text x="30" y="752" font-size="10" fill="#3f4759">選択していない経路（このページの他の通信）</text>')
    s.append(edge("M154,784 L352,784", u, dim=True))
    s.append(node(BX, 784, 30, "http", 0, "", "", dim=True))
    s.append(f'<text x="{BX}" y="806" text-anchor="middle" font-size="9.5" fill="#434b5d" font-family="ui-monospace,Menlo,monospace">GET /api/favorites</text>')
    s.append(node(SX, 784, 30, "sql", 0, "", "", dim=True))
    s.append(f'<text x="{SX}" y="806" text-anchor="middle" font-size="9.5" fill="#434b5d">SQL</text>')
    # ノード：識別子は起点 ① と終点 ⑦ のみ。中間は種別名だけ（識別子は詳細パネルへ）
    s.append(node(BX, 112, 58, "value", 1, "表示された値", "「千葉県」", tsize=12.5))
    s.append(node(BX, 262, 58, "component", 2, "コンポーネント", "", tsize=12.5))
    s.append(node(BX, 412, 58, "http", 3, "通信", "", tsize=12.5))
    s.append(node(SX, 412, 58, "server", 4, "サーバー処理", "", tsize=12.5))
    s.append(node(SX, 566, 58, "sql", 5, "実行SQL", "", tsize=12.5))
    s.append(node(DX, 474, 58, "table", 6, "テーブル", "", tsize=12.5))
    s.append(node(DX, 652, 58, "column", 7, "カラム", "area", "right", tsize=12.5))
    return svgwrap(W, H, u, "".join(s)), plen(ret)

def build_a3():
    svg, _ = plan_a3()
    body = f"""<div class="body">
  {pages(128)}
  <div class="pane" style="width:348px;flex:0 0 348px">
    <div class="ph">プレビュー<span class="r"><span>現物</span></span></div>
    {preview(271)}
  </div>
  <div class="pane" style="flex:1;min-width:0">
    <div class="ph">データフロー<span class="r"><span>/properties</span><span>通信 3 ／ SQL 2 ／ 142 ms</span></span></div>
    <div style="flex:1;min-height:0;background:radial-gradient(1200px 800px at 34% 20%,#0d1017 0%,#090b11 72%)">{svg}</div>
  </div>
  <div class="pane dp" style="width:374px;flex:0 0 374px">
    <div class="ph">詳細<span class="r"><span>経路</span></span></div>
    {PANEL}
  </div>
</div>"""
    return page("A-3 余白と情報密度の最適化 — S-04 探索（Phase 4B）", body)

# ==================================================================== 出力
if __name__ == "__main__":
    for fn, fb in (("a1-minimal-fix.html", build_a1),
                   ("a2-path-clarity.html", build_a2),
                   ("a3-density-balance.html", build_a3)):
        with io.open(os.path.join(OUT, fn), "w", encoding="utf-8") as f:
            f.write(fb())
        print("wrote", fn)
    for nm, fn in (("A-1", plan_a1), ("A-2", plan_a2), ("A-3", plan_a3)):
        print(nm, "戻り経路長 = %.0f px" % fn()[1])
