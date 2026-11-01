# -*- coding: utf-8 -*-
"""S-04 探索画面 UIモック 共通部品（Phase 4A・検討用）"""

OUT = "/Users/mizuki/Visiual Computing IDE/docs/04-ui-mockups"

# ---------------------------------------------------------------- トークン
CSS_TOKENS = """
:root{
  --bg:#06070a;           /* アプリ最背面（黒に近い） */
  --shell:#0a0c11;        /* シェル */
  --panel:#0f1218;        /* パネル面 */
  --panel-2:#131722;      /* パネル内の面 */
  --sunken:#0b0e14;       /* 沈んだ面 */
  --line:#1c2130;         /* 境界 */
  --line-soft:#161a25;
  --tx:#e4e8f0;           /* 主文字 */
  --tx2:#98a1b4;          /* 副文字 */
  --tx3:#646d80;          /* 第三文字 */
  --tx4:#454d5d;          /* 最弱 */
  --lav:#9d93e0;          /* ラベンダー＝選択 */
  --lav-dim:#6a62a8;
  --lav-bg:rgba(157,147,224,.10);
  --blue:#7fa0cc;         /* ブルー＝実測 */
  --blue-dim:#52657f;
  --green:#78b79a;        /* グリーン＝正常 */
  --amber:#c2a06e;        /* 注意（控えめ） */
  --est:#9a8fc4;          /* 推定の線 */
  --r:10px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);}
body{
  width:1600px;height:1000px;overflow:hidden;
  font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;
  font-feature-settings:"palt" 1;
  color:var(--tx);-webkit-font-smoothing:antialiased;
}
.app{width:1600px;height:1000px;display:flex;flex-direction:column;background:var(--shell);}

/* ---------- N0 グローバルバー ---------- */
.n0{height:48px;flex:0 0 48px;display:flex;align-items:center;gap:14px;
    padding:0 16px;border-bottom:1px solid var(--line);background:var(--panel);}
.proj{display:flex;align-items:center;gap:9px;height:30px;padding:0 11px;border:1px solid var(--line);
      border-radius:8px;background:var(--panel-2);font-size:12.5px;font-weight:600;letter-spacing:.02em}
.proj .mark{width:14px;height:14px;border-radius:4px;background:linear-gradient(135deg,#8f85d8,#6f9fd8)}
.proj .car{color:var(--tx3);font-size:9px}
.sup{display:flex;align-items:center;gap:7px;height:28px;padding:0 10px;border-radius:7px;
     border:1px solid rgba(194,160,110,.30);background:rgba(194,160,110,.07);
     font-size:11.5px;color:#d3b887;cursor:default}
.sup b{font-weight:600}
.n0 .spacer{flex:1}
.env{display:flex;align-items:center;gap:7px;height:28px;padding:0 10px;border:1px solid var(--line);
     border-radius:7px;background:var(--sunken);font-size:11.5px;color:var(--tx2)}
.env .lock{color:var(--tx4);font-size:10px}
.run{display:flex;align-items:center;gap:9px;height:30px;padding:0 10px 0 8px;border:1px solid var(--line);
     border-radius:8px;background:var(--panel-2);font-size:11.5px;color:var(--tx2)}
.run .stop{width:18px;height:18px;border-radius:5px;border:1px solid rgba(120,183,154,.4);
     display:flex;align-items:center;justify-content:center}
.run .stop i{width:7px;height:7px;background:var(--green);border-radius:1.5px;display:block}
.run code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--tx)}
.run .port{color:var(--tx3)}
.ins{display:flex;align-items:center;gap:7px;height:28px;padding:0 10px;border-radius:7px;
     border:1px solid rgba(120,183,154,.26);background:rgba(120,183,154,.07);font-size:11.5px;color:#8fc4a9}
.dot{width:6px;height:6px;border-radius:50%;background:var(--green);display:block}

/* ---------- N1 モードタブ ---------- */
.n1{height:42px;flex:0 0 42px;display:flex;align-items:flex-end;gap:2px;padding:0 14px;
    border-bottom:1px solid var(--line);background:var(--shell)}
.tab{height:33px;padding:0 17px;display:flex;align-items:center;font-size:12.5px;color:var(--tx3);
     border-radius:8px 8px 0 0;border:1px solid transparent;border-bottom:none;letter-spacing:.03em}
.tab.on{color:var(--tx);background:var(--panel);border-color:var(--line);position:relative}
.tab.on::after{content:"";position:absolute;left:12px;right:12px;top:0;height:2px;border-radius:2px;background:var(--lav)}
.tab.soon{color:var(--tx4)}
.tab.soon s{text-decoration:none;font-size:10.5px;color:var(--tx4);
     border:1px dashed var(--line);border-radius:4px;padding:1px 4px;margin-left:6px}

/* ---------- 本体 ---------- */
.body{flex:1;display:flex;gap:10px;padding:10px;min-height:0}
.pane{background:var(--panel);border:1px solid var(--line);border-radius:12px;
      display:flex;flex-direction:column;min-height:0;overflow:hidden}
.ph{height:34px;flex:0 0 34px;display:flex;align-items:center;gap:8px;padding:0 12px;
    border-bottom:1px solid var(--line-soft);font-size:11px;color:var(--tx3);letter-spacing:.06em}
.ph .r{margin-left:auto;display:flex;gap:12px;color:var(--tx4);font-size:10.5px;letter-spacing:.02em}

/* ---------- F-1 ページ一覧 ---------- */
.pages{padding:7px 7px 10px}
.pg{height:38px;display:flex;flex-direction:column;justify-content:center;padding:0 10px;border-radius:8px;gap:1px}
.pg b{font-size:12px;font-weight:500;color:var(--tx2)}
.pg s{text-decoration:none;font-size:10px;color:var(--tx4);font-family:ui-monospace,Menlo,monospace}
.pg.on{background:var(--lav-bg);box-shadow:inset 0 0 0 1px rgba(157,147,224,.22)}
.pg.on b{color:var(--tx);font-weight:600}
.pg.on s{color:#9088c0}
.pgsec{font-size:9.5px;color:var(--tx4);letter-spacing:.1em;padding:12px 10px 6px}

/* ---------- F-2 プレビュー ---------- */
.pv{flex:1;display:flex;flex-direction:column;background:var(--sunken);min-height:0;position:relative;padding-left:24px}
.urlbar{height:30px;flex:0 0 30px;display:flex;align-items:center;gap:8px;padding:0 10px;
        border-bottom:1px solid var(--line-soft);background:var(--panel-2)}
.urlbar .nav{display:flex;gap:6px;color:var(--tx4);font-size:10px}
.urlbar .u{flex:1;height:19px;border-radius:5px;background:var(--sunken);border:1px solid var(--line-soft);
        display:flex;align-items:center;padding:0 8px;font-size:10px;color:var(--tx3);
        font-family:ui-monospace,Menlo,monospace}
.site{flex:1;background:#fbfcfd;overflow:hidden;position:relative;color:#1b2430}
.s-nav{height:38px;display:flex;align-items:center;gap:18px;padding:0 16px;background:#fff;
       border-bottom:1px solid #e9edf2}
.s-logo{font-weight:800;font-size:13px;letter-spacing:.06em;color:#20303f}
.s-nav a{font-size:10.5px;color:#55606d;text-decoration:none}
.s-ava{margin-left:auto;width:19px;height:19px;border-radius:50%;background:#e4e9ef}
.hero{height:126px;position:relative;overflow:hidden;
  background:linear-gradient(170deg,#9fc2d8 0%,#7fa8c4 38%,#6f8f72 70%,#4e6b52 100%)}
.hero::after{content:"";position:absolute;inset:0;
  background:linear-gradient(90deg,rgba(10,20,28,.55),rgba(10,20,28,.10))}
.hero .t{position:absolute;left:16px;top:16px;z-index:2;color:#fff}
.hero .t b{display:block;font-size:17px;line-height:1.35;font-weight:800;letter-spacing:.01em;
  text-shadow:0 1px 10px rgba(0,0,0,.4)}
.hero .t i{display:block;font-style:normal;font-size:10px;opacity:.9;margin-top:6px}
.search{position:absolute;left:16px;right:16px;bottom:9px;height:28px;background:rgba(255,255,255,.95);
  border-radius:7px;display:flex;align-items:center;padding:0 10px;font-size:10px;color:#8b95a1;z-index:2}
.filters{display:flex;gap:6px;padding:9px 14px;background:#fff;border-bottom:1px solid #eef1f5}
.fl{height:23px;border:1px solid #dfe5ec;border-radius:6px;display:flex;align-items:center;
    padding:0 7px;font-size:9.5px;color:#5c6775;gap:7px;white-space:nowrap}
.cards{display:flex;gap:9px;padding:11px 14px 0}
.cards:last-of-type{padding-bottom:12px}
.card{flex:1;border:1px solid #e4e9ef;border-radius:9px;overflow:hidden;background:#fff;display:flex}
.card .thumb{width:58px;flex:0 0 58px;background:linear-gradient(160deg,#9db9c9,#6c8f6e)}
.card.b .thumb{background:linear-gradient(160deg,#aebfcb,#8898a3)}
.card .cb{flex:1;padding:7px 9px;min-width:0}
.card .no{font-size:10.5px;white-space:nowrap;font-weight:700;color:#22303d;margin-bottom:5px}
.row{display:flex;align-items:center;gap:4px;font-size:9.5px;white-space:nowrap;color:#4d5967;margin:3px 0;line-height:1.3}
.row em{font-style:normal;color:#9aa5b1;font-size:8.5px}
.sel-el{position:relative;display:inline-block;padding:1px 4px;margin:-1px -4px;border-radius:3px;
  box-shadow:0 0 0 1.5px #7b6fd0, 0 0 0 4px rgba(123,111,208,.16);background:rgba(123,111,208,.07);color:#1b2430}
.pv-badge{position:absolute;width:19px;height:19px;border-radius:50%;background:#6f6aa8;color:#efeaff;
  font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;z-index:5;
  box-shadow:0 0 0 3px var(--sunken)}
.pv-tick{position:absolute;height:1px;display:none;background:rgba(157,147,224,.5);z-index:4}
.pv-foot{flex:0 0 26px;height:26px;display:flex;align-items:center;gap:8px;padding:0 11px;
  border-top:1px solid var(--line-soft);background:var(--panel-2);font-size:10px;color:var(--tx3)}
.pv-foot b{color:var(--tx2);font-weight:500}

/* ---------- 詳細パネル ---------- */
.dp{overflow:hidden}
.sum{padding:10px 14px 11px;border-bottom:1px solid var(--line-soft)}
.sum .k{font-size:10px;color:var(--tx3);letter-spacing:.09em;margin-bottom:9px}
.claim{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.claim .src{font-family:ui-monospace,Menlo,monospace;font-size:16.5px;font-weight:600;color:var(--tx);letter-spacing:.01em}
.chip-est{font-size:10.5px;padding:2px 8px;border-radius:5px;color:#c3b9ee;
  border:1px dashed rgba(157,147,224,.5);background:rgba(157,147,224,.07);letter-spacing:.04em}
.chip-obs{font-size:10.5px;padding:2px 8px;border-radius:5px;color:#9fb6d4;
  border:1px solid rgba(127,160,204,.35);background:rgba(127,160,204,.07);letter-spacing:.04em}
.sum p{font-size:11.5px;line-height:1.66;color:var(--tx2);margin-top:9px}
.hint{font-size:10px;line-height:1.6;color:var(--tx4);margin-top:7px;padding-top:7px;
  border-top:1px dashed var(--line)}
.weak{margin:9px 14px 0;border:1px solid rgba(157,147,224,.26);border-radius:10px;
  background:linear-gradient(180deg,rgba(157,147,224,.09),rgba(157,147,224,.03));padding:10px 12px}
.weak .wt{display:flex;align-items:center;gap:7px;font-size:11.5px;color:#c7bef0;font-weight:600;letter-spacing:.03em}
.weak .wh{font-size:12.5px;color:var(--tx);margin-top:8px;font-weight:600;line-height:1.5}
.weak .wh u{text-decoration:none;color:var(--lav);font-family:ui-monospace,Menlo,monospace;margin-right:6px}
.weak p{font-size:11px;line-height:1.66;color:var(--tx2);margin-top:6px}
.weak .ev{font-size:10.5px;line-height:1.68;color:var(--tx3);margin-top:8px;padding-top:8px;
  border-top:1px solid rgba(157,147,224,.16)}
.weak .ev b{color:var(--tx2);font-weight:500}
.btn{margin-top:8px;height:25px;display:inline-flex;align-items:center;padding:0 12px;border-radius:7px;
  border:1px solid rgba(157,147,224,.4);background:rgba(157,147,224,.10);color:#cfc6f5;font-size:11px}
.btn.q{border-color:var(--line);background:var(--sunken);color:var(--tx2)}
.steps{flex:1;overflow:hidden;padding:9px 14px 0}
.steps .k{font-size:10px;color:var(--tx3);letter-spacing:.09em;margin-bottom:8px}
.st{display:flex;gap:9px;padding:4px 0;position:relative}
.st .bd{width:18px;height:18px;flex:0 0 18px;border-radius:50%;background:#20253a;color:#a79fe0;
  font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}
.st.cur .bd{background:#6f6aa8;color:#efeaff}
.st .tx{min-width:0;flex:1}
.st .tt{font-size:11px;color:var(--tx);line-height:1.4;display:block}
.st .ts{font-size:9.5px;color:var(--tx3);margin-top:1px;display:block;font-family:ui-monospace,Menlo,monospace;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st .tg{margin-left:auto;font-size:9.5px;color:var(--tx4);padding-top:2px;white-space:nowrap}
.st.est .tg{color:#9a90cb}
.st .conn{position:absolute;left:8.5px;top:24px;bottom:-5px;width:1px;background:var(--line)}
.st.estc .conn{background:repeating-linear-gradient(180deg,#453f68 0 3px,transparent 3px 6px)}
.st.cur{background:rgba(157,147,224,.06);border-radius:8px;margin:0 -8px;padding:7px 8px}
.st.cur .conn{left:16.5px}
.tabs{display:flex;gap:4px;margin:10px 0 0}
.tabs span{font-size:10.5px;padding:4px 10px;border-radius:6px;color:var(--tx3);border:1px solid transparent}
.tabs span.on{color:var(--tx);background:var(--panel-2);border-color:var(--line)}
.ovw{margin-top:7px;border:1px solid var(--line);border-radius:8px;background:var(--sunken);padding:8px 10px}
.ovw dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:10.5px}
.ovw dt{color:var(--tx4)}
.ovw dd{color:var(--tx2);font-family:ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------- N5 ドロワー ---------- */
.n5{height:36px;flex:0 0 36px;display:flex;align-items:center;gap:8px;padding:0 14px;
    border-top:1px solid var(--line);background:var(--panel)}
.n5 .h{display:flex;align-items:center;gap:7px;height:24px;padding:0 10px;border-radius:7px;
    border:1px solid var(--line);background:var(--panel-2);font-size:11px;color:var(--tx2)}
.n5 .h i{font-style:normal;color:var(--tx4);font-size:9px}
.n5 .h.soon{color:var(--tx4);border-style:dashed;background:transparent}
.n5 .note{margin-left:auto;font-size:9.5px;color:#5a4f36;border:1px dashed #443c28;
     border-radius:5px;padding:3px 8px;letter-spacing:.03em}
"""

# ---------------------------------------------------------------- SVG部品
def defs(uid=""):
    return f"""<defs>
<marker id="ar{uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
  <path d="M0,1 L9,5 L0,9" fill="none" stroke="#8aa4cc" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="are{uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
  <path d="M0,1 L9,5 L0,9" fill="none" stroke="#9a8fc4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="ard{uid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
  <path d="M0,1 L9,5 L0,9" fill="none" stroke="#39405266" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
<filter id="gl{uid}" x="-60%" y="-60%" width="220%" height="220%">
  <feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>"""

# ノード種別アイコン（20x20 座標系・線画）
ICON = {
 "value":  '<rect x="2.5" y="4" width="15" height="12" rx="2.5"/><path d="M6 8.5h8M6 11.5h4.5"/>',
 "component":'<path d="M10 2.6 17 6.6v7.8L10 18.4 3 14.4V6.6z"/><circle cx="10" cy="10.5" r="2.4"/>',
 "http":   '<circle cx="10" cy="10" r="7.2"/><path d="M3 10h14M10 3a13 13 0 0 1 0 14a13 13 0 0 1 0-14"/>',
 "server": '<rect x="2.8" y="4" width="14.4" height="5" rx="1.6"/><rect x="2.8" y="11" width="14.4" height="5" rx="1.6"/><path d="M5.6 6.5h.01M5.6 13.5h.01"/>',
 "sql":    '<rect x="2.8" y="3.4" width="14.4" height="13.2" rx="2"/><path d="M6 7.4h8M6 10.4h8M6 13.4h4.5"/>',
 "table":  '<ellipse cx="10" cy="5.4" rx="6.6" ry="2.6"/><path d="M3.4 5.4v9.2c0 1.44 2.95 2.6 6.6 2.6s6.6-1.16 6.6-2.6V5.4"/><path d="M3.4 10c0 1.44 2.95 2.6 6.6 2.6s6.6-1.16 6.6-2.6"/>',
 "column": '<rect x="2.8" y="3.6" width="14.4" height="12.8" rx="2"/><path d="M7.6 3.6v12.8M12.4 3.6v12.8"/><rect x="7.6" y="3.6" width="4.8" height="12.8" fill="rgba(157,147,224,.22)" stroke="none"/>',
}

HALO = ' stroke="#0a0d13" stroke-width="3.2" paint-order="stroke" stroke-linejoin="round"'

def node(cx, cy, size, kind, badge, title, sub, lab="below", dim=False, labw=170, tsize=11.5):
    """ノード1つ。lab: below|right|left"""
    h = size/2.0
    if dim:
        box = (f'<rect x="{cx-h}" y="{cy-h}" width="{size}" height="{size}" rx="{size*0.26:.1f}" '
               f'fill="#0d1017" stroke="#1b2030"/>')
        ic = f'<g transform="translate({cx-10},{cy-10})" fill="none" stroke="#39415a" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">{ICON[kind]}</g>'
        bdg = ""
    else:
        box = (f'<rect x="{cx-h}" y="{cy-h}" width="{size}" height="{size}" rx="{size*0.26:.1f}" '
               f'fill="#151b29" stroke="#39356a" stroke-width="1.1"/>'
               f'<rect x="{cx-h+2}" y="{cy-h+2}" width="{size-4}" height="{size-4}" rx="{size*0.22:.1f}" '
               f'fill="none" stroke="rgba(157,147,224,.10)"/>')
        sc = size/56.0
        ic = (f'<g transform="translate({cx-10*sc:.1f},{cy-10*sc:.1f}) scale({sc:.3f})" fill="none" '
              f'stroke="#b3abe8" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">{ICON[kind]}</g>')
        br = 10.0
        bdg = (f'<circle cx="{cx-h-1}" cy="{cy-h-1}" r="{br}" fill="#6f6aa8" stroke="#0f1218" stroke-width="2"/>'
               f'<text x="{cx-h-1}" y="{cy-h+2.6}" text-anchor="middle" font-size="11" font-weight="700" fill="#f0ecff">{badge}</text>')
    tc  = "#4b5468" if dim else "#e4e8f0"
    sc_ = "#3b4254" if dim else "#8d97ab"
    if lab == "below":
        t = (f'<text x="{cx}" y="{cy+h+16}" text-anchor="middle" font-size="{tsize}" fill="{tc}"{HALO}>{title}</text>'
             f'<text x="{cx}" y="{cy+h+31}" text-anchor="middle" font-size="10" fill="{sc_}" font-family="ui-monospace,Menlo,monospace"{HALO}>{sub}</text>') if sub else \
            (f'<text x="{cx}" y="{cy+h+16}" text-anchor="middle" font-size="{tsize}" fill="{tc}"{HALO}>{title}</text>')
    elif lab == "right":
        x = cx+h+13
        t = (f'<text x="{x}" y="{cy-2}" font-size="{tsize}" fill="{tc}"{HALO}>{title}</text>'
             f'<text x="{x}" y="{cy+13}" font-size="10" fill="{sc_}" font-family="ui-monospace,Menlo,monospace"{HALO}>{sub}</text>') if sub else \
            (f'<text x="{x}" y="{cy+4}" font-size="{tsize}" fill="{tc}"{HALO}>{title}</text>')
    else:
        x = cx-h-13
        t = (f'<text x="{x}" y="{cy-2}" text-anchor="end" font-size="{tsize}" fill="{tc}"{HALO}>{title}</text>'
             f'<text x="{x}" y="{cy+13}" text-anchor="end" font-size="10" fill="{sc_}" font-family="ui-monospace,Menlo,monospace"{HALO}>{sub}</text>') if sub else \
            (f'<text x="{x}" y="{cy+4}" text-anchor="end" font-size="{tsize}" fill="{tc}"{HALO}>{title}</text>')
    return box+ic+bdg+t

def edge(d, uid="", est=False, dim=False, w=1.4):
    if dim:
        return f'<path d="{d}" fill="none" stroke="#242a3a" stroke-width="1.1" marker-end="url(#ard{uid})"/>'
    if est:
        return (f'<path d="{d}" fill="none" stroke="#9a8fc4" stroke-width="{w}" stroke-dasharray="5 4.5" '
                f'stroke-linecap="round" marker-end="url(#are{uid})"/>')
    return (f'<path d="{d}" fill="none" stroke="#8aa4cc" stroke-width="{w}" stroke-linecap="round" '
            f'marker-end="url(#ar{uid})"/>')

def cap(x, y, lines, anchor="middle", est=False, size=10.5):
    col = "#9a90cb" if est else "#79839a"
    out = []
    for i, ln in enumerate(lines):
        out.append(f'<text x="{x}" y="{y+i*14}" text-anchor="{anchor}" font-size="{size}" fill="{col}"{HALO}>{ln}</text>')
    return "".join(out)

def tag_est(x, y, star=False):
    """推定タグ（色以外の符号：破線枠＋語）"""
    w = 58 if star else 38
    s = (f'<rect x="{x-w/2}" y="{y-9}" width="{w}" height="18" rx="5" fill="#11131d" '
         f'stroke="#6f66a8" stroke-dasharray="4 3"/>')
    if star:
        s += (f'<text x="{x-w/2+9}" y="{y+4}" font-size="11" fill="#cfc6f5">★</text>'
              f'<text x="{x+6}" y="{y+4}" text-anchor="middle" font-size="10" fill="#bcb2ec">推定</text>')
    else:
        s += f'<text x="{x}" y="{y+3.5}" text-anchor="middle" font-size="10" fill="#bcb2ec">推定</text>'
    return s

def tag_obs(x, y):
    return (f'<rect x="{x-21}" y="{y-9}" width="42" height="18" rx="5" fill="#11131d" stroke="#3c4a60"/>'
            f'<text x="{x}" y="{y+3.5}" text-anchor="middle" font-size="10" fill="#9fb0c6">実測</text>')

def cut(x, y, ang=0):
    """切断マーカー（追跡しようとしたができなかった）"""
    return (f'<g transform="translate({x},{y}) rotate({ang})">'
            f'<path d="M0,-9 L0,9" stroke="#c2a06e" stroke-width="1.6" stroke-linecap="round"/>'
            f'<path d="M7,-6 L17,4 M17,-6 L7,4" stroke="#c2a06e" stroke-width="1.5" stroke-linecap="round"/></g>')

def zone(x, y, w, h, label):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="rgba(255,255,255,.012)" '
            f'stroke="#191d29"/>'
            f'<text x="{x+16}" y="{y+19}" font-size="10" fill="#5b6478" letter-spacing="1.4">{label}</text>')

# ---------------------------------------------------------------- HTML断片
def n0():
    return """<div class="n0">
  <div class="proj"><span class="mark"></span>GRiDDATA<span class="car">▾</span></div>
  <div class="sup">◬ 対応範囲 <b>部分対応・1件</b></div>
  <div class="spacer"></div>
  <div class="env">環境 <b style="color:#b9c2d2;font-weight:600">Local</b> <span class="lock">固定</span></div>
  <div class="run"><span class="stop"><i></i></span><code>npm run dev</code>
     <span class="dot"></span>実行中<span class="port">:3000</span></div>
  <div class="spacer"></div>
  <div class="ins"><span class="dot"></span>計装 有効</div>
</div>"""

def n1():
    return """<div class="n1">
  <div class="tab on">探索</div><div class="tab">データ</div><div class="tab">実行</div>
  <div class="tab soon">編集<s>準備中</s></div>
</div>"""

def pages(w=176):
    return f"""<div class="pane" style="width:{w}px;flex:0 0 {w}px">
  <div class="ph">ページ</div>
  <div class="pages">
    <div class="pg"><b>ホーム</b><s>/</s></div>
    <div class="pg on"><b>物件一覧</b><s>/properties</s></div>
    <div class="pg"><b>物件詳細</b><s>/properties/[id]</s></div>
    <div class="pg"><b>お知らせ</b><s>/news</s></div>
    <div class="pg"><b>お問い合わせ</b><s>/contact</s></div>
  </div>
</div>"""

def preview(badge_top=None, tickw=52):
    """F-2 プレビュー。badge_top: ①バッジの上端px（プレビュー外縁に出す）"""
    bt = badge_top if badge_top is not None else 300
    return f"""<div class="pv">
  <div class="urlbar"><span class="nav">←　→　⟳</span>
    <div class="u">http://localhost:3000/properties</div></div>
  <div class="site">
    <div class="s-nav"><span class="s-logo">GRiDDATA</span><a>物件一覧</a><a>サービス</a><a>お知らせ</a><span class="s-ava"></span></div>
    <div class="hero"><div class="t"><b>再生可能エネルギーの<br>未来をつくる</b><i>全国の蓄電池用地を、最適なパートナーへ</i></div>
      <div class="search">エリア・電力会社・条件で検索</div></div>
    <div class="filters"><div class="fl">エリア <span>▾</span></div><div class="fl">電力会社 <span>▾</span></div>
      <div class="fl">電圧区分 <span>▾</span></div><div class="fl">承諾状況 <span>▾</span></div></div>
    <div class="cards">
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900001</div><div class="row"><em>◎</em><span class="sel-el">千葉県</span></div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>特別高圧</div><div class="row"><em>▤</em>2027年4月</div></div></div>
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900002</div><div class="row"><em>◎</em>茨城県</div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>高圧</div><div class="row"><em>▤</em>2026年10月</div></div></div>
    </div>
    <div class="cards">
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900003</div><div class="row"><em>◎</em>群馬県</div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>高圧</div><div class="row"><em>▤</em>2027年1月</div></div></div>
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900004</div><div class="row"><em>◎</em>栃木県</div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>低圧</div><div class="row"><em>▤</em>2026年12月</div></div></div>
    </div>
    <div class="cards">
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900005</div><div class="row"><em>◎</em>埼玉県</div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>特別高圧</div><div class="row"><em>▤</em>2027年7月</div></div></div>
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900006</div><div class="row"><em>◎</em>神奈川県</div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>高圧</div><div class="row"><em>▤</em>2027年3月</div></div></div>
    </div>
    <div class="cards">
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900007</div><div class="row"><em>◎</em>静岡県</div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>高圧</div><div class="row"><em>▤</em>2026年11月</div></div></div>
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900008</div><div class="row"><em>◎</em>長野県</div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>低圧</div><div class="row"><em>▤</em>2027年2月</div></div></div>
    </div>
    <div class="cards">
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900009</div><div class="row"><em>◎</em>新潟県</div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>高圧</div><div class="row"><em>▤</em>2027年5月</div></div></div>
      <div class="card"><div class="thumb"></div><div class="cb"><div class="no">No.900010</div><div class="row"><em>◎</em>山梨県</div><div class="row"><em>⚡</em>東京電力</div><div class="row"><em>▣</em>高圧</div><div class="row"><em>▤</em>2026年9月</div></div></div>
    </div>
  </div>
  <div class="pv-badge" style="left:1px;top:{bt}px">1</div>
  <div class="pv-tick" style="left:21px;width:{tickw}px;top:{bt+9}px"></div>
  <div class="pv-foot">選択中 <b>「千葉県」</b> <span style="color:var(--tx4)">— プレビューには枠のみを描きます</span></div>
</div>"""

def drawer():
    return """<div class="n5">
  <div class="h">▲ ネットワーク <i>3 件</i></div>
  <div class="h soon">タイムライン <i>準備中</i></div>
  <div class="note">Phase 4A UI検討用モック／シナリオは合成データ（実測ではありません）</div>
</div>"""

# ---- 詳細パネル部品 ----
SUMMARY = """<div class="sum">
  <div class="k">この値の出所</div>
  <div class="claim"><span class="src">properties . area</span><span class="chip-est">推定</span></div>
  <p>14 か所のうち 2 か所が推定です。経路全体は、いちばん弱いところに合わせて「推定」になります。</p>
  <div class="hint">実測＝実際に起きたことを観測できた箇所。推定＝コードの形から推測した箇所。</div>
</div>"""

WEAK = """<div class="weak">
  <div class="wt">★ いちばん弱いところ</div>
  <div class="wh"><u>⑦→③</u>カラムと応答項目の対応づけ</div>
  <p>ORMの内部変換は観測できません。別名や加工があると成立しません。</p>
  <div class="ev">根拠 2 件：<b>実行されたSQLの解析</b> ／ <b>値の一致</b><br>（値の一致だけでは1つに絞れません）</div>
  <span class="btn">ここを見る</span>
</div>"""

STEPS = [
 ("1","表示された値","「千葉県」","実測",False),
 ("2","コンポーネント","src/components/PropertyCard.tsx:42","実測",True),
 ("3","通信","GET /api/properties — 200 — 124ms","実測",False),
 ("4","サーバー処理","Next.js API Route — 98ms","実測",False),
 ("5","実行SQL","SELECT id, title, area … — 42ms — 12行","実測",False),
 ("6","テーブル","public.properties","実測",False),
 ("7","カラム","area (text)","実測",False),
]

def steps_html(cur=1, show_ovw=True):
    rows=[]
    for i,(n,t,s,tag,estc) in enumerate(STEPS):
        cls="st"+(" cur" if int(n)==cur else "")+(" estc" if estc else "")
        conn='<span class="conn"></span>' if i<len(STEPS)-1 else ""
        rows.append(f'<div class="{cls}">{conn}<span class="bd">{n}</span>'
                    f'<span class="tx"><span class="tt">{t}</span><span class="ts">{s}</span></span>'
                    f'<span class="tg">{tag}</span></div>')
        if int(n)==cur and show_ovw:
            rows.append("""<div style="margin:2px 0 6px 28px">
              <div class="tabs"><span class="on">概要</span><span>根拠</span></div>
              <div class="ovw"><dl>
                <dt>取得手段</dt><dd>ブラウザのDOM読み取り</dd>
                <dt>要素</dt><dd>&lt;span&gt; / PropertyCard 内</dd>
                <dt>次の一歩</dt><dd style="font-family:inherit;color:#9a90cb">⑦ のカラムから実際の値を開く</dd>
              </dl></div></div>""")
    return '<div class="steps"><div class="k">経路のステップ（7）</div>' + "".join(rows) + '</div>'
