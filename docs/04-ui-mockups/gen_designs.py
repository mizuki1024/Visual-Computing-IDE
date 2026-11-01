# -*- coding: utf-8 -*-
import sys, io, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_common import *

def page(title, css_extra, body):
    return f"""<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>{title}</title><style>{CSS_TOKENS}{css_extra}</style></head><body>
<div class="app">{n0()}{n1()}{body}{drawer()}</div></body></html>"""

def svgwrap(w,h,uid,inner):
    return (f'<svg width="100%" height="100%" viewBox="0 0 {w} {h}" preserveAspectRatio="xMidYMid meet" '
            f'style="display:block">{defs(uid)}{inner}</svg>')

# =====================================================================
#  A案 — Data Flow First
# =====================================================================
def plan_a():
    W,H,u = 620,820,"a"
    s=[]
    for x,t in ((108,"ブラウザ"),(318,"サーバー"),(520,"データベース")):
        s.append(f'<text x="{x}" y="38" text-anchor="middle" font-size="10" fill="#5b6478" letter-spacing="2.2">{t}</text>')
    s.append('<path d="M213,56 V786 M419,56 V786" stroke="#13171f" stroke-width="1"/>')
    # 選択していない経路（減光して残す・UI-33）
    s.append('<text x="52" y="604" font-size="10" fill="#3f4759">選択していない経路（このページの他の通信）</text>')
    s.append(edge("M127,648 L231,648",u,dim=True))
    s.append(node(108,648,38,"http",0,"","",dim=True))
    s.append('<text x="108" y="684" text-anchor="middle" font-size="9.5" fill="#434b5d" font-family="ui-monospace,Menlo,monospace">GET /api/favorites</text>')
    s.append(node(250,648,38,"sql",0,"","",dim=True))
    s.append('<text x="250" y="684" text-anchor="middle" font-size="9.5" fill="#434b5d">SQL</text>')
    # ホップ（それぞれ独立した線分）
    s.append(edge("M108,154 L108,272",u))
    s.append(edge("M108,326 L108,444",u,est=True))
    s.append(edge("M134,472 L230,472 L230,300 L292,300",u))
    s.append(edge("M318,326 L318,474",u))
    s.append(edge("M344,486 C 404,468 444,430 494,422",u))      # reads  ⑤→⑥
    s.append(edge("M344,514 C 404,532 444,588 494,598",u))      # projects ⑤→⑦
    s.append(edge("M546,600 L580,600 L580,740 L30,740 L30,472 L82,472",u,est=True))  # maps ⑦→③
    # 切断マーカー（未対応の構成・1件）
    s.append('<path d="M344,300 L402,264" fill="none" stroke="#6d5f44" stroke-width="1.4" stroke-dasharray="4 4"/>')
    s.append(cut(408,261,-32))
    s.append('<text x="434" y="252" font-size="10.5" fill="#bfa073">追跡できません</text>')
    s.append('<text x="434" y="266" font-size="10" fill="#7d6a4c">未対応の構成です</text>')
    # 線の説明
    s.append(cap(126,200,["この要素を描いた","コンポーネント"],"start"))
    s.append(cap(126,382,["応答のどの項目が、","この値になったか"],"start",est=True))
    s.append(tag_est(108,420))
    s.append(cap(246,398,["その通信を受けた","サーバーの処理"],"start"))
    s.append(cap(336,388,["その処理が","実行したSQL"],"start"))
    s.append(cap(490,400,["そのSQLが","読んだテーブル"],"end"))
    s.append(cap(490,560,["そのSQLが","取り出した列"],"end"))
    s.append(cap(300,724,["カラムと応答項目の対応づけ"],est=True))
    s.append(tag_est(300,740,star=True))
    # ノード
    s.append(node(108,128,52,"value",1,"表示された値","「千葉県」"))
    s.append(node(108,300,52,"component",2,"コンポーネント","PropertyCard"))
    s.append(node(108,472,52,"http",3,"通信","GET /api/properties"))
    s.append(node(318,300,52,"server",4,"サーバー処理",""))
    s.append(node(318,500,52,"sql",5,"実行SQL",""))
    s.append(node(520,420,52,"table",6,"テーブル","properties"))
    s.append(node(520,600,52,"column",7,"カラム","area"))
    return svgwrap(W,H,u,"".join(s))

def build_a():
    body = f"""<div class="body">
  {pages(160)}
  <div class="pane" style="width:410px;flex:0 0 410px">
    <div class="ph">プレビュー<span class="r"><span>現物</span></span></div>
    {preview(271)}
  </div>
  <div class="pane" style="flex:1;min-width:0">
    <div class="ph">データフロー<span class="r"><span>/properties</span><span>通信 3 ／ SQL 2 ／ 142 ms</span></span></div>
    <div style="flex:1;min-height:0;background:radial-gradient(1100px 700px at 30% 18%,#0d1017 0%,#090b11 70%)">{plan_a()}</div>
  </div>
  <div class="pane dp" style="width:360px;flex:0 0 360px">
    <div class="ph">詳細<span class="r"><span>経路</span></span></div>
    {SUMMARY}{WEAK}{steps_html(1)}
  </div>
</div>"""
    return page("A案 Data Flow First — S-04 探索", "", body)

# =====================================================================
#  B案 — Preview First
# =====================================================================
def plan_b():
    W,H,u = 318,820,"b"
    X=90
    s=[]
    ys={1:58,2:148,3:238,4:328,5:418,6:508,7:598}
    s.append(edge(f"M{X},78 L{X},128",u))
    s.append(edge(f"M{X},168 L{X},218",u,est=True))
    s.append(edge(f"M{X},258 L{X},308",u))
    s.append(edge(f"M{X},348 L{X},398",u))
    s.append(edge(f"M{X},438 L{X},488",u))                       # reads ⑤→⑥
    s.append(edge(f"M70,418 L52,418 L52,598 L70,598",u))         # projects ⑤→⑦
    s.append(edge(f"M{X},618 L{X},648 L22,648 L22,238 L70,238",u,est=True))  # maps ⑦→③
    # 切断マーカー
    s.append(f'<path d="M{X+20},328 L146,354" fill="none" stroke="#6d5f44" stroke-width="1.3" stroke-dasharray="4 4"/>')
    s.append(cut(152,357,-33))
    s.append('<text x="176" y="352" font-size="10" fill="#bfa073">追跡できません</text>')
    s.append('<text x="176" y="366" font-size="9.5" fill="#7d6a4c">未対応の構成です</text>')
    # 推定の符号（説明文は詳細パネル側に置く）
    s.append(tag_est(X,193))
    s.append('<text x="123" y="197" font-size="10" fill="#9a90cb">応答のどの項目か</text>')
    s.append('<circle cx="22" cy="300" r="9.5" fill="#11131d" stroke="#6f66a8" stroke-dasharray="4 3"/>')
    s.append('<text x="22" y="304" text-anchor="middle" font-size="10" fill="#cfc6f5">★</text>')
    s.append('<text x="36" y="304" font-size="9.5" fill="#9a90cb">推定</text>')
    # 減光
    s.append('<text x="36" y="676" font-size="9.5" fill="#3f4759">選択していない経路</text>')
    s.append(node(X,700,32,"http",0,"","",dim=True))
    s.append('<text x="120" y="704" font-size="9.5" fill="#434b5d" font-family="ui-monospace,Menlo,monospace">GET /api/favorites</text>')
    s.append(edge(f"M{X},716 L{X},750",u,dim=True))
    s.append(node(X,766,32,"sql",0,"","",dim=True))
    s.append('<text x="120" y="770" font-size="9.5" fill="#434b5d">SQL</text>')
    # ノード
    s.append(node(X,ys[1],40,"value",1,"表示された値","「千葉県」","right"))
    s.append(node(X,ys[2],40,"component",2,"コンポーネント","PropertyCard","right"))
    s.append(node(X,ys[3],40,"http",3,"通信","GET /api/properties","right"))
    s.append(node(X,ys[4],40,"server",4,"サーバー処理","","right"))
    s.append(node(X,ys[5],40,"sql",5,"実行SQL","","right"))
    s.append(node(X,ys[6],40,"table",6,"テーブル","properties","right"))
    s.append(node(X,ys[7],40,"column",7,"カラム","area","right"))
    return svgwrap(W,H,u,"".join(s))

HOPCAP = {2:"この要素を描いたコンポーネント（実測）",
          3:"応答のどの項目が、この値になったか（推定）",
          4:"その通信を受けたサーバーの処理（実測）",
          5:"その処理が実行したSQL（実測）",
          6:"⑤ そのSQLが読んだテーブル（実測）",
          7:"⑤ そのSQLが取り出した列（実測）"}

def steps_b():
    rows=['<div class="steps"><div class="k">経路のステップ（7）</div>']
    for i,(n,t,s,tag,estc) in enumerate(STEPS):
        c = HOPCAP.get(int(n))
        lead = ""
        if c:
            col = "#9a90cb" if "推定" in c else "#5e6778"
            lead = f'<span style="display:block;font-size:9.5px;color:{col};line-height:1.4;margin-bottom:2px">{c}</span>'
        cls="st"+(" cur" if int(n)==1 else "")
        rows.append(f'<div class="{cls}"><span class="bd">{n}</span>'
                    f'<span class="tx">{lead}<span class="tt">{t}</span><span class="ts">{s}</span></span>'
                    f'<span class="tg">{tag}</span></div>')
        if int(n)==1:
            rows.append("""<div style="margin:2px 0 4px 27px">
              <div class="tabs"><span class="on">概要</span><span>根拠</span></div>
              <div class="ovw"><dl>
                <dt>取得手段</dt><dd>ブラウザのDOM読み取り</dd>
                <dt>要素</dt><dd>&lt;span&gt; / PropertyCard 内</dd>
              </dl></div></div>""")
    rows.append('</div>')
    return "".join(rows)

def build_b():
    body = f"""<div class="body">
  {pages(150)}
  <div class="pane" style="width:680px;flex:0 0 680px">
    <div class="ph">プレビュー<span class="r"><span>現物</span><span>クリックした要素から追跡します</span></span></div>
    {preview(271)}
  </div>
  <div class="pane" style="width:320px;flex:0 0 320px">
    <div class="ph">経路<span class="r"><span>7 ステップ</span></span></div>
    <div style="flex:1;min-height:0;background:radial-gradient(500px 700px at 20% 15%,#0d1017 0%,#090b11 70%)">{plan_b()}</div>
  </div>
  <div class="pane dp" style="width:400px;flex:0 0 400px">
    <div class="ph">詳細<span class="r"><span>経路</span></span></div>
    {SUMMARY}{WEAK}{steps_b()}
  </div>
</div>"""
    return page("B案 Preview First — S-04 探索", "", body)

# =====================================================================
#  C案 — Comprehension First
# =====================================================================
def plan_c():
    W,H,u = 628,820,"c"
    X=270; CAP=316; LEG=590
    s=[]
    s.append(zone(16,62,524,268,"ブラウザ で 起きたこと"))
    s.append(zone(16,342,524,184,"サーバー で 起きたこと"))
    s.append(zone(16,538,524,184,"データベース で 分かったこと"))
    ys={1:108,2:200,3:292,4:388,5:480,6:576,7:668}
    s.append(edge(f"M{X},138 L{X},170",u))
    s.append(edge(f"M{X},230 L{X},262",u,est=True))
    s.append(edge(f"M{X},322 L{X},358",u))
    s.append(edge(f"M{X},418 L{X},450",u))
    s.append(edge(f"M{X},510 L{X},546",u))                                  # reads ⑤→⑥
    s.append(edge("M248,506 C 176,548 140,590 140,650 L140,712 L270,712 L270,700",u))# projects ⑤→⑦
    s.append(edge(f"M300,668 L{LEG},668 L{LEG},292 L300,292",u,est=True))   # maps ⑦→③
    # 切断マーカー
    s.append(f'<path d="M{X-30},388 L204,420" fill="none" stroke="#6d5f44" stroke-width="1.4" stroke-dasharray="4 4"/>')
    s.append(cut(198,424,148))
    s.append('<text x="176" y="420" text-anchor="end" font-size="10.5" fill="#bfa073">追跡できません</text>')
    s.append('<text x="176" y="435" text-anchor="end" font-size="10" fill="#7d6a4c">未対応の構成です</text>')
    # 線の説明（常時・平易な日本語）
    s.append(cap(CAP,158,["この文字を画面に描いたコンポーネント"],"start",size=11))
    s.append(cap(CAP,242,["応答のどの項目が、この値になったか"],"start",est=True,size=11))
    s.append(tag_est(X,240))
    s.append(cap(CAP,344,["この通信を受けたサーバーの処理"],"start",size=11))
    s.append(cap(CAP,438,["その処理が実行したSQL"],"start",size=11))
    s.append(cap(CAP,532,["そのSQLが読んだテーブル"],"start",size=11))
    s.append(cap(128,620,["そのSQLが取り出した列"],"end",size=11))
    s.append(tag_est(LEG,480,star=True))
    s.append(cap(420,702,["カラムと応答項目の対応づけ（推定）"],"middle",est=True,size=10.5))
    # 選択していない経路（減光）
    s.append('<text x="22" y="752" font-size="10" fill="#3f4759">選択していない経路（このページの他の通信）</text>')
    s.append(node(44,784,30,"http",0,"","",dim=True))
    s.append('<text x="68" y="788" font-size="9.5" fill="#434b5d" font-family="ui-monospace,Menlo,monospace">GET /api/favorites</text>')
    s.append(edge("M196,784 L236,784",u,dim=True))
    s.append(node(256,784,30,"sql",0,"","",dim=True))
    s.append('<text x="280" y="788" font-size="9.5" fill="#434b5d">SQL</text>')
    # ノード
    s.append(node(X,ys[1],60,"value",1,"表示された値","「千葉県」","left",tsize=12.5))
    s.append(node(X,ys[2],60,"component",2,"コンポーネント","PropertyCard","left",tsize=12.5))
    s.append(node(X,ys[3],60,"http",3,"通信","GET /api/properties","left",tsize=12.5))
    s.append(node(X,ys[4],60,"server",4,"サーバー処理","","left",tsize=12.5))
    s.append(node(X,ys[5],60,"sql",5,"実行SQL","","left",tsize=12.5))
    s.append(node(X,ys[6],60,"table",6,"テーブル","properties","left",tsize=12.5))
    s.append(node(X,ys[7],60,"column",7,"カラム","area","left",tsize=12.5))
    return svgwrap(W,H,u,"".join(s))

def build_c():
    body = f"""<div class="body">
  {pages(140)}
  <div class="pane" style="width:360px;flex:0 0 360px">
    <div class="ph">プレビュー<span class="r"><span>現物</span></span></div>
    {preview(271)}
  </div>
  <div class="pane" style="flex:1;min-width:0">
    <div class="ph">この値がどこから来たか<span class="r"><span>上から順に読みます</span><span>/properties</span></span></div>
    <div style="flex:1;min-height:0;background:radial-gradient(900px 800px at 40% 10%,#0d1017 0%,#090b11 72%)">{plan_c()}</div>
  </div>
  <div class="pane dp" style="width:420px;flex:0 0 420px">
    <div class="ph">詳細<span class="r"><span>経路</span></span></div>
    {SUMMARY}{WEAK}{steps_html(1)}
  </div>
</div>"""
    return page("C案 Comprehension First — S-04 探索", "", body)

for fn, fn_build in (("a-data-flow-first.html",build_a),
                     ("b-preview-first.html",build_b),
                     ("c-comprehension-first.html",build_c)):
    with io.open(os.path.join(OUT,fn),"w",encoding="utf-8") as f:
        f.write(fn_build())
    print("wrote", fn)
