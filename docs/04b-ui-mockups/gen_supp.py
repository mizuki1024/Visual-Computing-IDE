# -*- coding: utf-8 -*-
"""Phase 4B 補助図
 supp-scale.html     … ノードが数十に増えたときの成立性（検討用スケッチ・未実測）
 supp-disclosure.html … 説明をどの段階に配分するか（段階0〜3）の仕様図
"""
import sys, os, io
sys.path.insert(0, "/Users/mizuki/Visiual Computing IDE/docs/04-ui-mockups")
from gen_common import CSS_TOKENS, defs, node, edge, ICON, HALO, cut, tag_est
sys.path.insert(0, "/Users/mizuki/Visiual Computing IDE/docs/04b-ui-mockups")
from gen_refine import rp, forkdot, star_chip

OUT = "/Users/mizuki/Visiual Computing IDE/docs/04b-ui-mockups"

SHELL = """
*{box-sizing:border-box;margin:0;padding:0}
body{background:#06070a;color:#e4e8f0;font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;
     font-feature-settings:"palt" 1;padding:34px 38px}
h1{font-size:18px;font-weight:700;letter-spacing:.02em}
.sub{font-size:12px;color:#98a1b4;margin-top:8px;line-height:1.8;max-width:1180px}
.warn{margin:14px 0 0;display:inline-block;font-size:11.5px;color:#d3b887;
      border:1px solid rgba(194,160,110,.3);background:rgba(194,160,110,.07);
      border-radius:8px;padding:8px 12px;line-height:1.7}
.grid{display:flex;gap:14px;margin-top:22px}
.card{background:#0f1218;border:1px solid #1c2130;border-radius:12px;overflow:hidden;flex:1}
.ch{height:34px;display:flex;align-items:center;gap:9px;padding:0 13px;border-bottom:1px solid #161a25;
    font-size:11.5px;color:#98a1b4}
.ch em{font-style:normal;font-size:10px;color:#9d93e0;border:1px solid rgba(157,147,224,.32);
       background:rgba(157,147,224,.08);border-radius:5px;padding:2px 7px}
.cb{padding:10px 12px 12px}
.note{font-size:10.5px;color:#646d80;line-height:1.75;padding:0 13px 12px}
.note b{color:#98a1b4;font-weight:500}
"""

# ------------------------------------------------------------- 俯瞰スケッチ
def mini(kind, uid):
    """ノード数が増えたときの骨格だけを描く（検討用。実測ではない）"""
    W, H = 470, 408
    s = [defs(uid)]
    def box(x, y, w=26, h=26, dim=False, est=False):
        st = "#2b3246" if dim else "#39356a"
        fl = "#0e1119" if dim else "#151b29"
        return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="7" fill="{fl}" stroke="{st}"/>'
    def agg(x, y, w, h, label, lv):
        col = "#6f66a8" if lv == "推定" else "#3c4a60"
        dash = ' stroke-dasharray="5 4"' if lv == "推定" else ""
        return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" fill="#101420" stroke="{col}"{dash}/>'
                f'<text x="{x+w/2}" y="{y+h/2-2}" text-anchor="middle" font-size="10" fill="#b9c2d2">{label}</text>'
                f'<text x="{x+w/2}" y="{y+h/2+12}" text-anchor="middle" font-size="9" fill="#7c8699">{lv}を含む</text>')
    def lab(x, y, t, c="#5b6478", sz=9.5, a="middle"):
        return f'<text x="{x}" y="{y}" text-anchor="{a}" font-size="{sz}" fill="{c}"{HALO}>{t}</text>'
    def ln(d, est=False, dim=False):
        return edge(d, uid, est=est, dim=dim)

    if kind == "a1":
        # 縦帯：帯の内側で縦に伸びる → 先に縦が尽きる
        for x, t in ((78, "ブラウザ"), (235, "サーバー"), (382, "データベース")):
            s.append(lab(x, 26, t, "#6d7689", 10))
        s.append('<path d="M156,38 V382 M312,38 V382" stroke="#232b3c"/>')
        ys = [56, 96, 136, 176, 216, 256]
        for y in ys:
            s.append(box(65, y))
        s.append(lab(78, 300, "…", "#454d5d", 13))
        s.append(agg(40, 312, 76, 40, "通信 ×9", "実測"))
        for y in (56, 116, 176):
            s.append(box(222, y))
        s.append(agg(196, 236, 78, 40, "SQL ×12", "実測"))
        s.append(agg(196, 294, 78, 40, "処理 ×7", "推定"))
        s.append(agg(348, 96, 80, 40, "表 ×6", "実測"))
        s.append(agg(348, 180, 80, 40, "列 ×18", "推定"))
        for d in ("M91,69 H222", "M91,129 H222", "M91,189 H222",
                  "M248,129 H348", "M248,189 H348",
                  "M274,256 H316 V204 H348", "M116,332 H166 V258 H196"):
            s.append(ln(d))
        s.append(ln("M388,220 V368 H40 V354", est=True))
        s.append(lab(235, 396, "縦に伸びる。帯の高さが先に尽き、段1の集約が早く始まる", "#646d80", 9.5))
    elif kind == "a2":
        for x, t in ((78, "ブラウザ"), (235, "サーバー"), (382, "データベース")):
            s.append(lab(x, 26, t, "#6d7689", 10))
        s.append('<path d="M156,38 V382 M312,38 V382" stroke="#232b3c"/>')
        # 往路の行が縦に積み上がる＝1行＝1経路
        rows = [62, 110, 158, 206]
        for i, y in enumerate(rows):
            s.append(box(65, y)); s.append(box(222, y)); s.append(box(348, y))
            s.append(ln(f"M91,{y+13} H222")); s.append(ln(f"M248,{y+13} H348"))
            s.append(lab(30, y + 17, "%d" % (i + 1), "#4b5468", 9))
        s.append(lab(78, 244, "…", "#454d5d", 13))
        s.append(agg(40, 256, 76, 40, "経路 ×23", "推定"))
        s.append(agg(196, 256, 78, 40, "処理 ×23", "実測"))
        s.append(agg(330, 256, 86, 40, "表・列 ×24", "推定"))
        s.append(ln("M116,276 H196")); s.append(ln("M274,276 H330"))
        s.append(ln("M373,296 V330 H52 V296", est=True))
        s.append(lab(206, 348, "戻り（共通レーン）", "#7a6fa8", 9.5))
        s.append(lab(235, 396, "1行＝1経路。行が増えるだけで形は変わらない", "#646d80", 9.5))
    else:
        for x0, x1, t in ((28, 150, "ブラウザ"), (166, 300, "サーバー"), (316, 442, "データベース")):
            s.append(f'<rect x="{x0}" y="38" width="{x1-x0}" height="306" rx="12" fill="rgba(255,255,255,.021)"/>')
            s.append(lab((x0 + x1) / 2, 26, t, "#6d7689", 10))
        for i, y in enumerate((60, 108, 156)):
            s.append(box(76, y, 30, 30))
        s.append(agg(44, 206, 92, 44, "通信 ×12", "実測"))
        s.append(agg(44, 266, 92, 44, "他 ×14", "推定"))
        s.append(agg(182, 86, 100, 44, "処理 ×15", "実測"))
        s.append(agg(182, 206, 100, 44, "SQL ×12", "実測"))
        s.append(agg(332, 140, 96, 44, "表 ×6", "実測"))
        s.append(agg(332, 236, 96, 44, "列 ×18", "推定"))
        s.append('<path d="M106,75 H152 V171 H106" fill="none" stroke="#8aa4cc" stroke-width="1.3" stroke-linecap="round"/>')
        s.append(forkdot(152, 108))
        for d in ("M152,108 H182", "M282,108 H306 V162 H332",
                  "M282,228 H306 V258 H332", "M136,228 H182"):
            s.append(ln(d))
        s.append(ln("M380,280 V312 H56 V310", est=True))
        s.append(lab(235, 396, "ノードが大きいぶん、段2（境界グループ）へ早く移る", "#646d80", 9.5))
    return (f'<svg width="100%" viewBox="0 0 {W} {H}" style="display:block">{"".join(s)}</svg>')

def build_scale():
    cards = []
    for k, t, badge, note in (
        ("a1", "A-1 の骨格", "縦帯 + 縦積み",
         "帯の内側でノードが<b>縦に積み上がる</b>。1帯あたり約6ノードで縦が尽きるため、"
         "<b>段1（同種連続の集約）が最も早く発動する</b>。戻りレーンは下辺に1本のまま。"),
        ("a2", "A-2 の骨格", "行 = 1経路",
         "往路が水平1行のため、<b>経路が増えても行が増えるだけ</b>で形は変わらない。"
         "戻りは共通レーンに束ねられる。横幅（3層ぶん）が先に制約になる。"),
        ("a3", "A-3 の骨格", "面 + 大きいノード",
         "ノードが大きく余白も広いため、<b>1画面に置ける個数が3案で最も少ない</b>。"
         "段1を飛ばして<b>段2（境界グループ単位）へ移る</b>想定になる。"),
    ):
        cards.append(f'<div class="card"><div class="ch">{t}<em>{badge}</em></div>'
                     f'<div class="cb">{mini(k, k + "s")}</div><div class="note">{note}</div></div>')
    return f"""<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>ノードが増えたときの成立性 — Phase 4B 検討用スケッチ</title><style>{SHELL}</style></head><body>
<h1>ノード数が増えたときに、3案の骨格がどう変わるか</h1>
<p class="sub">S-04 を開いた直後の既定スコープは <b>T2（主トレース・選択前）</b>であり、ページによっては数十ノードが並ぶ
（<code>02b</code> 3.1節 / <code>03</code> P3-03）。本図は 3案の<b>幾何がどう伸びるか</b>だけを描いた骨格スケッチである。
集約の段は <code>03</code> 5.3節（段0〜段3）に従い、<b>削除・非描画は行わない</b>。</p>
<div class="warn">これは<b>検討用スケッチ</b>であり、描画性能・可読性を実測したものではない。
段の発動条件（B-03 / B-04）は <code>03</code> 5.5節の UR-07 検証が済むまで確定しない。ノード数・件数は仮置きである。</div>
<div class="grid">{"".join(cards)}</div>
</body></html>"""

# ------------------------------------------------------------- 説明の配分
def build_disclosure():
    def nd(cx, cy, kind, badge, title, sub="", state=None):
        s = node(cx, cy, 52, kind, badge, title, sub)
        if state:
            col = {"警告": "#c2a06e", "エラー": "#c08080", "不明": "#6b7488"}[state]
            gl = {"警告": "◬", "エラー": "✕", "不明": "?"}[state]
            dash = ' stroke-dasharray="3 2.6"' if state == "不明" else ""
            s += (f'<circle cx="{cx+21}" cy="{cy-21}" r="9" fill="#0e1119" stroke="{col}"{dash}/>'
                  f'<text x="{cx+21}" y="{cy-17.5}" text-anchor="middle" font-size="10" fill="{col}">{gl}</text>')
        return s

    # 段階1（ホバー）の1行要約カード
    hov = ('<g transform="translate(120,150)">'
           '<rect x="0" y="0" width="290" height="54" rx="9" fill="#11141d" stroke="#2b3246"/>'
           '<text x="14" y="21" font-size="11" fill="#e4e8f0">この通信を受けたサーバーの処理</text>'
           '<text x="14" y="40" font-size="10" fill="#8d97ab">GET /api/properties — 200 — 124ms</text>'
           '<rect x="228" y="29" width="42" height="17" rx="5" fill="#11131d" stroke="#3c4a60"/>'
           '<text x="249" y="41.5" text-anchor="middle" font-size="9.5" fill="#9fb0c6">実測</text>'
           '</g>')
    s1 = [defs("d1")]
    s1.append(nd(60, 72, "http", 3, "通信", "GET /api/properties"))
    s1.append('<path d="M60,150 V120" stroke="#2b3246" stroke-width="1" stroke-dasharray="3 3"/>')
    s1.append(hov)
    svg1 = f'<svg viewBox="0 0 440 220" style="display:block;width:100%;max-width:450px;margin:4px auto">{"".join(s1)}</svg>'

    s2 = [defs("d2")]
    for i, (st, t) in enumerate(((None, "正常"), ("警告", "警告"), ("エラー", "エラー"), ("不明", "不明"))):
        x = 60 + i * 104
        s2.append(nd(x, 62, "server", 4, "", "", st))
        s2.append(f'<text x="{x}" y="112" text-anchor="middle" font-size="10.5" fill="#98a1b4">{t}</text>')
        if st is None:
            s2.append(f'<text x="{x}" y="128" text-anchor="middle" font-size="9.5" fill="#646d80">記号なし</text>')
    svg2 = f'<svg viewBox="0 0 440 150" style="display:block;width:100%;max-width:450px;margin:4px auto">{"".join(s2)}</svg>'

    rows = [
        ("0 未選択（俯瞰）", "キャンバス",
         "種別アイコン・名称・状態・線種。俯瞰サマリ（件数・総時間・推定を含む旨）",
         "属性値 / 所要時間の個別値 / L0〜L3 / 説明文"),
        ("1 ホバー", "ノードの脇に1行カード",
         "1行要約 + 観測性の語（実測／推定）+ ★。<b>ホップの説明文はここが初出</b>",
         "構造化された詳細 / 生データ"),
        ("2 クリック（本モック）", "右の詳細パネル",
         "経路サマリ → ★いちばん弱いところ → 番号付きリスト。"
         "<b>各ステップの間に関係の説明を1行</b>（Phase 4B で追加）",
         "生データ / 根拠の全件 / 実データ値"),
        ("3 タブ切替", "詳細パネル内",
         "ヘッダ / パラメータ / 根拠 / 生データ。マスク解除と実データ開示はここだけ",
         "—"),
    ]
    tr = "".join(
        f'<tr><td class="g">{a}</td><td class="h">{b}</td><td>{c}</td><td class="x">{d}</td></tr>'
        for a, b, c, d in rows)

    return f"""<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>説明をどの段階に置くか — Phase 4B</title><style>{SHELL}
table{{border-collapse:collapse;width:100%;margin-top:14px;font-size:11.5px}}
th{{text-align:left;font-size:10px;color:#646d80;letter-spacing:.08em;font-weight:600;
   padding:0 14px 8px 0;border-bottom:1px solid #1c2130}}
td{{padding:9px 14px 9px 0;color:#98a1b4;line-height:1.75;vertical-align:top;border-bottom:1px solid #141822}}
td.g{{color:#e4e8f0;white-space:nowrap;width:150px}}
td.h{{color:#b9a9e8;white-space:nowrap;width:170px}}
td.x{{color:#5b6478;width:260px}}
td b{{color:#cfc6f5;font-weight:500}}
</style></head><body>
<h1>説明をどの段階に置くか — 3案に共通の規則</h1>
<p class="sub">A案の改善3案は<b>キャンバス上の説明文を減らし、同じ説明をホバー・詳細パネルへ移した</b>。
文章の総量は減らしていない。置き場所を変えただけである（<code>03b</code> 4.1節の5段階に対応）。</p>
<div class="warn"><b>キャンバスに語を残すのは「観測できていないこと」だけ</b>：推定の2ホップ（「推定」チップ・★）と、
切断1件の理由（UI-07 によりキャンバスのみ）。実測の5ホップには語を置かない。</div>
<table>
<tr><th>段階</th><th>説明が出る場所</th><th>出すもの</th><th>出さないもの</th></tr>
{tr}
</table>
<div class="grid">
  <div class="card"><div class="ch">段階1（ホバー）の1行カード<em>静止画では未検証</em></div>
    <div class="cb">{svg1}</div>
    <div class="note">キャンバスから外した「この通信を受けたサーバーの処理」は、<b>ホバーで初めて出る</b>。
    観測性の語（実測／推定）を必ず同じカードに載せる。<b>表示の遅延・消え方は静止画では検証できない</b>（<code>04</code> 8章 未決定5）。</div></div>
  <div class="card"><div class="ch">ノードの状態の記号<em>正常は無表記</em></div>
    <div class="cb">{svg2}</div>
    <div class="note">ノード上に置くのは<b>種別アイコン・ステップバッジ・短いラベル・状態</b>のみ。
    <b>正常には記号を置かない</b>（経路に対する肯定記号を使わない・UXR-12）。色に頼らず形で区別する（NFR-30）。
    本モックの7ノードはすべて正常のため、記号は出ていない。</div></div>
</div>
</body></html>"""

if __name__ == "__main__":
    for fn, b in (("supp-scale.html", build_scale), ("supp-disclosure.html", build_disclosure)):
        io.open(os.path.join(OUT, fn), "w", encoding="utf-8").write(b())
        print("wrote", fn)
