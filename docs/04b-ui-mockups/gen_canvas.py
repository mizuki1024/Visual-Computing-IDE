# -*- coding: utf-8 -*-
"""Phase 4B-2 — 観測キャンバス構成

画面全体を1枚の観測キャンバスにし、その上に
  モードタブ／ページパネル／プレビューパネル／状態表示／凡例／下部チップ
が浮かぶ。データフローは**枠を持たず、キャンバスそのものに描かれる**。
固定（ドック）なのは右の詳細パネルと、最上部のグローバルバー（N0・`02b` 2.3節で構成が確定）だけ。

A-1 / A-2 / A-3 の3つの経路レイアウトを、
  初期状態（パネルが既定の配置）／ フロー集中状態（パネルを畳んでフローに面積を譲る）
の2状態で出力する。扱う情報・観測性・選択状態（段階2）は6枚とも同一。
"""
import sys, os, io, math
sys.path.insert(0, "/Users/mizuki/Visiual Computing IDE/docs/04-ui-mockups")
sys.path.insert(0, "/Users/mizuki/Visiual Computing IDE/docs/04b-ui-mockups")
from gen_common import CSS_TOKENS, defs, node, edge, cap, tag_est, cut, n0, preview
from gen_refine import CSS_ADD, rp, plen, forkdot, star_chip, cut_up, PANEL

OUT = "/Users/mizuki/Visiual Computing IDE/docs/04b-ui-mockups"

# ---------------------------------------------------------------- 観測キャンバスのCSS
CSS_STAGE = """
.app{width:1600px;height:1000px;display:flex;flex-direction:column;background:var(--bg);}
/* N0 は最上部にドック（02b 2.3節で構成が確定しているため、位置だけ据え置く） */
.n0{border-bottom:1px solid #141922;background:#0b0d13}
.stage{flex:1;display:flex;min-height:0}

/* ---------- 観測キャンバス本体 ---------- */
.canvas{position:relative;flex:1;min-width:0;overflow:hidden;
  background:
    radial-gradient(1200px 900px at 34% 26%, #0c0f16 0%, #08090e 62%, #06070a 100%),
    #06070a;}
/* キャンバスであることの手がかり：ごく薄い点のグリッド（面でも線でもない） */
.canvas::before{content:"";position:absolute;inset:0;pointer-events:none;
  background-image:radial-gradient(rgba(255,255,255,.042) 1px, transparent 1px);
  background-size:30px 30px;background-position:10px 10px}
.canvas > svg{position:absolute;inset:0;z-index:1}

/* ---------- 浮かぶパネル ---------- */
.fpnl{position:absolute;z-index:3;border-radius:12px;
  background:rgba(14,17,23,.90);
  border:1px solid #252d3e;
  box-shadow:0 20px 44px rgba(0,0,0,.62), 0 2px 10px rgba(0,0,0,.4),
             inset 0 1px 0 rgba(255,255,255,.035);
  overflow:hidden}
.flh{height:28px;display:flex;align-items:center;gap:8px;padding:0 10px;
  border-bottom:1px solid rgba(255,255,255,.045);font-size:10.5px;color:var(--tx3);letter-spacing:.06em}
.flh i{font-style:normal;color:var(--tx4);font-size:9.5px;letter-spacing:0}
.flh .x{margin-left:auto;color:var(--tx4);font-size:11px;line-height:1}

/* モードタブ（浮かぶピル） */
.fpnl.tabs{display:flex;align-items:center;gap:3px;padding:4px;border-radius:11px}
.fpnl.tabs b{font-weight:400;font-size:12.5px;color:var(--tx3);padding:0 15px;height:27px;
  display:flex;align-items:center;border-radius:8px;letter-spacing:.03em}
.fpnl.tabs b.on{color:var(--tx);background:rgba(157,147,224,.13);
  box-shadow:inset 0 0 0 1px rgba(157,147,224,.26)}
.fpnl.tabs b.soon{color:var(--tx4)}
.fpnl.tabs b.soon s{text-decoration:none;font-size:9.5px;margin-left:6px;
  border:1px dashed #2b3246;border-radius:4px;padding:1px 4px}

/* ページパネル */
.fpnl .pglist{padding:6px}
.fpnl .pg{height:32px;display:flex;flex-direction:column;justify-content:center;padding:0 9px;border-radius:7px;gap:0}
.fpnl .pg b{font-size:11.5px;font-weight:500;color:var(--tx2);line-height:1.25}
.fpnl .pg s{text-decoration:none;font-size:9.5px;color:var(--tx4);font-family:ui-monospace,Menlo,monospace}
.fpnl .pg.on{background:rgba(157,147,224,.11);box-shadow:inset 0 0 0 1px rgba(157,147,224,.22)}
.fpnl .pg.on b{color:var(--tx);font-weight:600}
.fpnl .pg.on s{color:#9088c0}

/* 畳んだときのチップ */
.fpnl.chip{display:flex;align-items:center;gap:8px;height:34px;padding:0 11px;border-radius:9px;
  font-size:11.5px;color:var(--tx2)}
.fpnl.chip s{text-decoration:none;font-size:9.5px;color:var(--tx4);font-family:ui-monospace,Menlo,monospace}
.fpnl.chip em{font-style:normal;color:var(--tx);font-weight:600;font-size:11.5px}
.fpnl.chip .x{margin-left:auto;color:var(--tx4);font-size:11px}

/* 状態表示（浮かぶ） */
.fpnl.stat{display:flex;align-items:center;gap:0;height:34px;padding:0 4px;border-radius:9px}
.fpnl.stat span{font-size:11px;color:var(--tx3);padding:0 11px;letter-spacing:.02em}
.fpnl.stat span.p{color:#9fb0c6;font-family:ui-monospace,Menlo,monospace;font-size:11px}
.fpnl.stat span + span{box-shadow:inset 1px 0 0 rgba(255,255,255,.055)}

/* 凡例 */
.lgb{padding:9px 11px 10px;display:grid;grid-template-columns:30px 1fr;gap:7px 9px;align-items:center}
.lgb u{text-decoration:none;display:flex;align-items:center;justify-content:center;height:12px}
.lgb t{display:block;font-size:10.5px;color:var(--tx2)}
.lgb t i{font-style:normal;color:var(--tx4)}

/* 縮小プレビュー（現物のまま切り出す） */
.pvm{position:relative;background:var(--sunken);padding:12px 12px 8px 26px}
.pvm .card{box-shadow:0 2px 10px rgba(0,0,0,.35)}
.pvm .pv-badge{position:absolute;left:3px;top:46px}
.fpnl .pv-foot{border-top:1px solid rgba(255,255,255,.045);background:transparent}

/* 下部チップ群 */
.fpnl.n5c{display:flex;align-items:center;gap:7px;height:30px;padding:0 10px;border-radius:9px;
  font-size:11px;color:var(--tx2)}
.fpnl.n5c i{font-style:normal;color:var(--tx4);font-size:9.5px}
.fpnl.n5c u{text-decoration:none;color:var(--tx4);border-left:1px solid #232b3c;padding-left:10px;margin-left:3px}
.synth{position:absolute;z-index:3;font-size:9.5px;color:#5a4f36;border:1px dashed #40382680;
  border-radius:6px;padding:4px 9px;letter-spacing:.02em;background:rgba(10,9,6,.5)}

/* ---------- 右の詳細パネル：ここだけ固定（ドック） ---------- */
.dock{flex:0 0 auto;background:var(--panel);border-left:1px solid #1f2634;
  display:flex;flex-direction:column;min-height:0;overflow:hidden;z-index:4;
  box-shadow:-18px 0 40px rgba(0,0,0,.5)}
.dock .ph{height:34px;flex:0 0 34px;display:flex;align-items:center;gap:8px;padding:0 12px;
  border-bottom:1px solid var(--line-soft);font-size:11px;color:var(--tx3);letter-spacing:.06em}
.dock .ph .r{margin-left:auto;display:flex;gap:10px;color:var(--tx4);font-size:10px}
.dock .ph .pin{color:#6a7489;font-size:9.5px;border:1px solid #232b3c;border-radius:5px;padding:2px 6px;letter-spacing:.04em}
"""

# ---------------------------------------------------------------- 経路レイアウトの定義
# xf / yf は流域（flow box）に対する比。3案の幾何そのものは Phase 4B 第1版から変えていない。
SHAPES = {
 "a1": dict(
   name="A-1", title="最小改善",
   xf=[.224,.224,.224,.547,.547,.839,.839],
   div=[.390,.703], fills=None, labf=[.224,.547,.839],
   yf=[0,.272,.543,.543,.838,.672,1.0],
   subs=[1,1,1,0,0,1,1], dsz=0, dimx=[.224,.547]),
 "a2": dict(
   name="A-2", title="経路の読みやすさ優先",
   xf=[.182,.182,.182,.429,.641,.853,.853],
   div=[.321,.750], fills=None, labf=[.160,.535,.853],
   yf=[0,.360,.720,.720,.720,.430,1.0],
   subs=[1,1,1,0,0,1,1], dsz=0, dimx=[.182,.429]),
 "a3": dict(
   name="A-3", title="余白と情報密度の最適化",
   xf=[.197,.197,.197,.526,.526,.834,.834],
   div=None, fills=[(.030,.356),(.368,.694),(.706,.985)], labf=[.197,.526,.834],
   yf=[0,.278,.556,.556,.841,.670,1.0],
   subs=[1,0,0,0,0,0,1], dsz=6, dimx=[.197,.526]),
}
NODE_KIND = ["value","component","http","server","sql","table","column"]
NODE_T    = ["表示された値","コンポーネント","通信","サーバー処理","実行SQL","テーブル","カラム"]
NODE_S    = ["「千葉県」","PropertyCard","GET /api/properties","","","properties","area"]

def flow_svg(shape, CW, CH, X0, Y0, X1, Y1, uid):
    sp = SHAPES[shape]
    W, H = X1 - X0, Y1 - Y0
    size = max(52, min(72, round(W * .068))) + sp["dsz"]
    ts   = 11.5 if size < 60 else 12.5
    A    = Y0 + 70
    B    = Y1 - size / 2.0 - 164
    S    = B - A
    X  = [X0 + W * f for f in sp["xf"]]
    Yn = [A + S * f for f in sp["yf"]]
    lane  = B + size / 2.0 + 62
    riser = max(X0 + 18, X[0] - size - 32)
    h = size / 2.0
    s = []

    # --- 層（帯）---
    lab_y = Y0 + 22
    if sp["fills"]:
        for (f0, f1), t in zip(sp["fills"], ("ブラウザ", "サーバー", "データベース")):
            x0, x1 = X0 + W * f0, X0 + W * f1
            s.append(f'<rect x="{x0:.0f}" y="{Y0+34:.0f}" width="{x1-x0:.0f}" height="{CH-Y0-42:.0f}" '
                     f'rx="16" fill="rgba(255,255,255,.021)"/>')
    else:
        s.append(f'<path d="M0,{Y0+34} H{X1}" stroke="#11141c" stroke-width="1"/>')
        for f in sp["div"]:
            s.append(f'<path d="M{X0+W*f:.0f},{Y0+34:.0f} V{CH:.0f}" stroke="#232b3c" stroke-width="1"/>')
    for f, t in zip(sp["labf"], ("ブラウザ", "サーバー", "データベース")):
        s.append(f'<text x="{X0+W*f:.0f}" y="{lab_y}" text-anchor="middle" font-size="10.5" '
                 f'fill="#6d7689" letter-spacing="2.6">{t}</text>')

    # --- 往路 ---
    s.append(edge(rp([(X[0], Yn[0] + h), (X[1], Yn[1] - h)]), uid))
    s.append(edge(rp([(X[1], Yn[1] + h), (X[2], Yn[2] - h)]), uid, est=True))
    s.append(tag_est(X[2 - 1], (Yn[1] + Yn[2]) / 2.0))
    s.append(edge(rp([(X[2] + h, Yn[2]), (X[3] - h, Yn[3])]), uid))
    if abs(Yn[4] - Yn[3]) > 1:                      # ④→⑤ が縦（A-1 / A-3）
        s.append(edge(rp([(X[4], Yn[3] + h), (X[4], Yn[4] - h)]), uid))
    else:                                           # ④→⑤ が横（A-2）
        s.append(edge(rp([(X[3] + h, Yn[3]), (X[4] - h, Yn[4])]), uid))
    # --- ⑤ の分岐（共通の枝 → 分岐点 → 2本）---
    fx = X[4] + h + (X[5] - h - X[4] - h) * .34
    s.append(f'<path d="M{X[4]+h:.0f},{Yn[4]:.0f} H{fx:.0f}" fill="none" stroke="#8aa4cc" '
             f'stroke-width="1.4" stroke-linecap="round"/>')
    s.append(edge(rp([(fx, Yn[4]), (fx, Yn[5]), (X[5] - h, Yn[5])]), uid))
    s.append(edge(rp([(fx, Yn[4]), (fx, Yn[6]), (X[6] - h, Yn[6])]), uid))
    s.append(forkdot(fx, Yn[4]))
    # --- 復路（推定・最弱環）---
    ret = [(X[6], Yn[6] + h), (X[6], lane), (riser, lane), (riser, Yn[2]), (X[2] - h, Yn[2])]
    s.append(edge(rp(ret, 16), uid, est=True))
    midx = (riser + X[6]) / 2.0
    s.append(star_chip(midx, lane))
    s.append(cap(midx, lane - 20, ["カラムと応答項目の対応づけ"], est=True))
    # --- 切断（サーバーから層の外へ）---
    s.append(cut_up(X[3], Yn[3] - h, Yn[3] - h - 78))
    # --- 選択していない経路（減光・削除しない）---
    dy = lane + 38
    s.append(f'<text x="{X0+4:.0f}" y="{dy:.0f}" font-size="10" fill="#3f4759">'
             f'選択していない経路（このページの他の通信）</text>')
    dx = [X0 + W * f for f in sp["dimx"]]
    s.append(edge(f"M{dx[0]+16:.0f},{dy+32:.0f} L{dx[1]-16:.0f},{dy+32:.0f}", uid, dim=True))
    for x, t, k in ((dx[0], "GET /api/favorites", "http"), (dx[1], "SQL", "sql")):
        s.append(node(x, dy + 32, 30, k, 0, "", "", dim=True))
        fam = ' font-family="ui-monospace,Menlo,monospace"' if k == "http" else ""
        s.append(f'<text x="{x:.0f}" y="{dy+54:.0f}" text-anchor="middle" font-size="9.5" fill="#434b5d"{fam}>{t}</text>')
    # --- ノード ---
    for i in range(7):
        lab = "right" if (i == 6) else "below"
        sub = NODE_S[i] if sp["subs"][i] else ""
        s.append(node(X[i], Yn[i], size, NODE_KIND[i], i + 1, NODE_T[i], sub, lab, tsize=ts))
    return (f'<svg width="{CW}" height="{CH}" viewBox="0 0 {CW} {CH}">{defs(uid)}{"".join(s)}</svg>',
            plen(ret), size)

# ---------------------------------------------------------------- 浮かぶ部品
TABS = """<div class="fpnl tabs" style="left:16px;top:14px">
  <b class="on">探索</b><b>データ</b><b>実行</b><b class="soon">編集<s>準備中</s></b></div>"""

def pages_panel(x, y, w):
    rows = "".join(f'<div class="pg{" on" if o else ""}"><b>{t}</b><s>{p}</s></div>'
                   for t, p, o in (("ホーム", "/", 0), ("物件一覧", "/properties", 1),
                                   ("物件詳細", "/properties/[id]", 0), ("お知らせ", "/news", 0),
                                   ("お問い合わせ", "/contact", 0)))
    return (f'<div class="fpnl" style="left:{x}px;top:{y}px;width:{w}px">'
            f'<div class="flh">ページ<span class="x">⌃</span></div>'
            f'<div class="pglist">{rows}</div></div>')

def pages_chip(x, y, w):
    return (f'<div class="fpnl chip" style="left:{x}px;top:{y}px;width:{w}px">'
            f'ページ <em>物件一覧</em> <s>/properties</s><span class="x">⌄</span></div>')

def preview_panel(x, y, w, h):
    return (f'<div class="fpnl" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px">'
            f'<div class="flh">プレビュー<i>現物</i><span class="x">⌃</span></div>'
            f'<div style="flex:1;min-height:0;display:flex;flex-direction:column;height:{h-28}px">'
            f'{preview(271)}</div></div>')

CARD = """<div class="card"><div class="thumb"></div><div class="cb">
  <div class="no">No.900001</div>
  <div class="row"><em>◎</em><span class="sel-el">千葉県</span></div>
  <div class="row"><em>⚡</em>東京電力</div>
  <div class="row"><em>▣</em>特別高圧</div>
  <div class="row"><em>▤</em>2027年4月</div></div></div>"""

def preview_mini(x, y, w):
    return (f'<div class="fpnl" style="left:{x}px;top:{y}px;width:{w}px">'
            f'<div class="flh">プレビュー<i>現物・選択中</i><span class="x">⌄</span></div>'
            f'<div class="pvm"><div style="display:flex">{CARD}</div>'
            f'<div class="pv-badge">1</div></div>'
            f'<div class="pv-foot">選択中 <b>「千葉県」</b></div></div>')

def status_chip(right, y):
    return (f'<div class="fpnl stat" style="right:{right}px;top:{y}px">'
            f'<span>データフロー</span><span class="p">/properties</span>'
            f'<span>通信 3 ／ SQL 2</span><span>142 ms</span></div>')

LEG_ROWS = [
 ('<svg width="30" height="12"><path d="M1,6 H23" stroke="#8aa4cc" stroke-width="1.6" stroke-linecap="round"/>'
  '<path d="M22,2.5 L28,6 L22,9.5" fill="none" stroke="#8aa4cc" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', "実測"),
 ('<svg width="30" height="12"><path d="M1,6 H23" stroke="#9a8fc4" stroke-width="1.6" stroke-dasharray="5 4.5" stroke-linecap="round"/>'
  '<path d="M22,2.5 L28,6 L22,9.5" fill="none" stroke="#9a8fc4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>', "推定"),
 ('<svg width="30" height="14" viewBox="0 0 30 14"><rect x="2" y="1" width="26" height="12" rx="4" fill="#11131d" stroke="#6f66a8" stroke-dasharray="4 3"/>'
  '<text x="15" y="10" text-anchor="middle" font-size="9" fill="#cfc6f5">★</text></svg>', "いちばん弱いところ"),
 ('<svg width="30" height="14" viewBox="0 0 30 14"><path d="M8,2 V12" stroke="#c2a06e" stroke-width="1.6" stroke-linecap="round"/>'
  '<path d="M14,3 L22,11 M22,3 L14,11" stroke="#c2a06e" stroke-width="1.5" stroke-linecap="round"/></svg>', "追跡できません"),
 ('<svg width="30" height="14" viewBox="0 0 30 14"><rect x="5" y="1" width="12" height="12" rx="3.5" fill="#0d1017" stroke="#1b2030"/>'
  '<path d="M19,7 H28" stroke="#242a3a" stroke-width="1.1"/></svg>', "選択していない経路 <i>（減光・削除しない）</i>"),
]

def legend_panel(x, y, w):
    rows = "".join(f'<u>{g}</u><t>{t}</t>' for g, t in LEG_ROWS)
    return (f'<div class="fpnl" style="left:{x}px;top:{y}px;width:{w}px">'
            f'<div class="flh">凡例<span class="x">⌃</span></div>'
            f'<div class="lgb">{rows}</div></div>')

def legend_chip(x, y, w):
    return (f'<div class="fpnl chip" style="left:{x}px;top:{y}px;width:{w}px">'
            f'凡例<span class="x">⌄</span></div>')

def n5_chip(x, bottom):
    return (f'<div class="fpnl n5c" style="left:{x}px;bottom:{bottom}px">'
            f'▲ ネットワーク <i>3 件</i><u>タイムライン <i>準備中</i></u></div>')

SYNTH = ('<div class="synth" style="right:14px;bottom:12px">'
         'Phase 4B UI検討用モック／シナリオは合成データ（実測ではありません）</div>')

# ---------------------------------------------------------------- 画面の組み立て
def screen(shape, state, dockw):
    CW, CH = 1600 - dockw, 952
    uid = shape + state[0]
    if state == "rest":
        X0, Y0, X1, Y1 = 396, 58, CW - 16, 920
        panels = (TABS + pages_panel(16, 62, 206)
                  + preview_panel(16, 274, 356, 414)
                  + legend_panel(30, 704, 262)
                  + n5_chip(16, 20) + status_chip(16, 14) + SYNTH)
    else:
        X0, Y0, X1, Y1 = 248, 58, CW - 16, 920
        panels = (TABS + pages_chip(16, 62, 212)
                  + preview_mini(16, 110, 212)
                  + legend_chip(16, 334, 212)
                  + n5_chip(16, 20) + status_chip(16, 14) + SYNTH)
    svg, L, size = flow_svg(shape, CW, CH, X0, Y0, X1, Y1, uid)
    sp = SHAPES[shape]
    ttl = f'{sp["name"]} {sp["title"]} — {"初期状態" if state=="rest" else "フロー集中状態"}'
    body = f"""<div class="app">{n0()}
<div class="stage">
  <div class="canvas">{svg}{panels}</div>
  <div class="dock dp" style="width:{dockw}px">
    <div class="ph">詳細<span class="r"><span>経路</span><span class="pin">固定</span></span></div>
    {PANEL}
  </div>
</div></div>"""
    return (f"""<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>{ttl}（Phase 4B 観測キャンバス）</title>
<style>{CSS_TOKENS}{CSS_ADD}{CSS_STAGE}</style></head><body>{body}</body></html>""", L, size)

DOCKW = {"a1": 360, "a2": 360, "a3": 376}

if __name__ == "__main__":
    for shape in ("a1", "a2", "a3"):
        for state in ("rest", "focus"):
            html, L, size = screen(shape, state, DOCKW[shape])
            fn = f"{shape}-canvas-{state}.html"
            io.open(os.path.join(OUT, fn), "w", encoding="utf-8").write(html)
            print("wrote %-24s 戻り %4.0fpx  ノード %dpx" % (fn, L, size))
