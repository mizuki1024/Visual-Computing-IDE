# -*- coding: utf-8 -*-
"""Phase 4D — Physical View（立体表示）検討用モック

ユーザー提供の3D地球UI参考画像を視覚の基準にしつつ、`04d-physical-view-design.md`
第2章の D-1〜D-6（既存IA・UXに反する6点）を直した版。

画像生成ツールが使えないため、HTML/CSS/SVG で描いている。**製品の実装ではない。**
"""
import io, os, math, random

OUT = "/Users/mizuki/Visiual Computing IDE/docs/04d-physical-view"
CW, CH = 1240, 952          # キャンバス（右の固定パネル 360px を除いた領域）
DOCKW = 360

# ---------------------------------------------------------------- トークン
CSS = """
:root{
  --bg:#05060a; --panel:#0f1218; --panel2:#131722; --sunken:#0b0e14;
  --line:#1c2130; --line-soft:#161a25;
  --tx:#e4e8f0; --tx2:#98a1b4; --tx3:#646d80; --tx4:#454d5d;
  --lav:#9d93e0; --lav-dim:#6a62a8; --blue:#8aa4cc; --est:#9a8fc4;
  --green:#78b79a; --amber:#c2a06e;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg);height:100%}
body{overflow:hidden;color:var(--tx);
  font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;
  font-feature-settings:"palt" 1;-webkit-font-smoothing:antialiased}
.app{width:1600px;height:1000px;flex:none;display:flex;flex-direction:column;background:var(--bg);
  position:absolute;left:50%;top:50%;
  transform:translate(-50%,-50%) scale(var(--s,1));transform-origin:center;overflow:hidden;
  box-shadow:0 40px 120px rgba(0,0,0,.72)}
.fit{position:fixed;inset:0;overflow:hidden;background:var(--bg)}

/* ---------- 段階1（ホバー）：ノードと右パネルの行が互いに光る ---------- */
.nd{cursor:pointer}
.nd:hover,.nd.on{filter:drop-shadow(0 0 11px rgba(207,198,245,.62))}
.st.on{background:rgba(157,147,224,.10);border-radius:8px}
.hovcard{position:fixed;z-index:60;pointer-events:none;opacity:0;transform:translateY(3px);
  transition:opacity .11s ease,transform .11s ease;border-radius:9px;
  background:rgba(13,16,22,.96);border:1px solid #262e40;padding:8px 11px;max-width:300px;
  box-shadow:0 18px 38px rgba(0,0,0,.7)}
.hovcard.on{opacity:1;transform:translateY(0)}
.hovcard b{display:block;font-size:11.5px;color:var(--tx);font-weight:500;line-height:1.45}
.hovcard s{text-decoration:none;display:block;font-size:10px;color:var(--tx3);
  font-family:ui-monospace,Menlo,monospace;margin-top:3px}
.hovcard i{font-style:normal;display:inline-block;margin-top:7px;font-size:9.5px;padding:2px 7px;
  border-radius:5px}
.hovcard i.m{color:#9fb0c6;border:1px solid rgba(127,160,204,.35);background:rgba(127,160,204,.07)}
.hovcard i.e{color:#bcb2ec;border:1px dashed rgba(157,147,224,.5);background:rgba(157,147,224,.07)}
@media (prefers-reduced-motion:reduce){.hovcard{transition:none}}

/* ---------- N0 グローバルバー（02b 2.3節で構成が確定。位置だけドック） ---------- */
.n0{height:48px;flex:0 0 48px;display:flex;align-items:center;gap:12px;padding:0 14px;
    background:#0a0c12;border-bottom:1px solid #151a24}
.mark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#8f85d8,#6f9fd8);
      display:flex;align-items:center;justify-content:center;font-size:11px;color:#0b0d13;font-weight:800}
.brand{font-size:13.5px;font-weight:700;letter-spacing:.04em}
.tabs{display:flex;align-items:center;gap:2px;margin-left:10px}
.tabs b{font-weight:400;font-size:12.5px;color:var(--tx3);padding:0 15px;height:28px;
  display:flex;align-items:center;border-radius:8px;letter-spacing:.03em}
.tabs b.on{color:var(--tx);background:rgba(157,147,224,.14);box-shadow:inset 0 0 0 1px rgba(157,147,224,.26)}
.tabs b.soon{color:var(--tx4)}
.tabs b.soon s{text-decoration:none;font-size:9.5px;margin-left:6px;border:1px dashed #2b3246;
  border-radius:4px;padding:1px 4px}
.sup{display:flex;align-items:center;gap:7px;height:27px;padding:0 10px;border-radius:7px;
  border:1px solid rgba(194,160,110,.30);background:rgba(194,160,110,.07);font-size:11.5px;color:#d3b887}
.sup b{font-weight:600}
.sp{flex:1}
.chipbar{display:flex;align-items:center;gap:7px;height:27px;padding:0 10px;border:1px solid #1e2533;
  border-radius:7px;background:#0d1016;font-size:11.5px;color:var(--tx2)}
.chipbar code{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--tx)}
.chipbar .lock,.chipbar .port{color:var(--tx4);font-size:10px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--green);display:block}
.ins{border-color:rgba(120,183,154,.26);background:rgba(120,183,154,.07);color:#8fc4a9}

.stage{flex:1;display:flex;min-height:0}

/* ---------- 観測キャンバス ---------- */
.canvas{position:relative;flex:1;min-width:0;overflow:hidden;
  background:radial-gradient(1200px 820px at 38% 26%,#0c0f16 0%,#08090e 62%,#06070a 100%)}
.canvas::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:0;
  background-image:radial-gradient(rgba(255,255,255,.042) 1px,transparent 1px);
  background-size:30px 30px;background-position:12px 12px}
.canvas > svg.scene{position:absolute;inset:0;z-index:1}

/* ---------- 浮かぶパネル ---------- */
.fpnl{position:absolute;z-index:3;border-radius:12px;background:rgba(13,16,22,.88);
  border:1px solid #262e40;
  box-shadow:0 22px 50px rgba(0,0,0,.66),0 2px 10px rgba(0,0,0,.45),
             inset 0 1px 0 rgba(255,255,255,.04);
  overflow:hidden;backdrop-filter:blur(6px)}
.fh{height:30px;display:flex;align-items:center;gap:8px;padding:0 11px;
  border-bottom:1px solid rgba(255,255,255,.05);font-size:11px;color:var(--tx3);letter-spacing:.05em}
.fh i{font-style:normal;color:var(--tx4);font-size:9.5px;letter-spacing:0}
.fh .r{margin-left:auto;display:flex;gap:9px;color:var(--tx4);font-size:11px;line-height:1}

/* ページパネル */
.srch{margin:8px 8px 4px;height:26px;border-radius:7px;background:#090c12;border:1px solid #1b2130;
  display:flex;align-items:center;gap:7px;padding:0 9px;font-size:10.5px;color:var(--tx4)}
.pglist{padding:2px 7px 8px}
.pg{height:34px;display:flex;align-items:center;gap:8px;padding:0 9px;border-radius:7px}
.pg u{text-decoration:none;color:var(--tx4);font-size:11px;line-height:1}
.pg div{min-width:0}
.pg b{display:block;font-size:11.5px;font-weight:500;color:var(--tx2);line-height:1.25}
.pg s{text-decoration:none;display:block;font-size:9.5px;color:var(--tx4);font-family:ui-monospace,Menlo,monospace}
.pg.on{background:rgba(157,147,224,.12);box-shadow:inset 0 0 0 1px rgba(157,147,224,.24)}
.pg.on b{color:var(--tx);font-weight:600}
.pg.on s{color:#9088c0}

/* プレビュー（現物） */
.pvb{position:relative;background:#0a0d13;padding:9px 9px 9px 24px}
.site{background:#fbfcfd;border-radius:7px;overflow:hidden;color:#1b2430;
  box-shadow:0 8px 24px rgba(0,0,0,.5)}
.s-nav{height:32px;display:flex;align-items:center;gap:12px;padding:0 12px;background:#fff;
  border-bottom:1px solid #e9edf2}
.s-logo{font-weight:800;font-size:11.5px;letter-spacing:.05em;color:#20303f}
.s-nav a{font-size:9.5px;color:#55606d;text-decoration:none;white-space:nowrap}
.hero{height:86px;position:relative;overflow:hidden;
  background:linear-gradient(170deg,#9fc2d8 0%,#7fa8c4 38%,#6f8f72 70%,#4e6b52 100%)}
.hero::after{content:"";position:absolute;inset:0;
  background:linear-gradient(90deg,rgba(10,20,28,.55),rgba(10,20,28,.10))}
.hero .t{position:absolute;left:12px;top:11px;z-index:2;color:#fff}
.hero .t b{display:block;font-size:13px;line-height:1.35;font-weight:800;text-shadow:0 1px 10px rgba(0,0,0,.4)}
.search{position:absolute;left:12px;right:12px;bottom:8px;height:22px;background:rgba(255,255,255,.95);
  border-radius:6px;display:flex;align-items:center;padding:0 9px;font-size:9px;color:#8b95a1;z-index:2}
.filters{display:flex;gap:5px;padding:7px 11px;background:#fff;border-bottom:1px solid #eef1f5}
.fl{height:20px;border:1px solid #dfe5ec;border-radius:5px;display:flex;align-items:center;
  padding:0 6px;font-size:8.5px;color:#5c6775;gap:6px;white-space:nowrap}
.cards{display:flex;gap:7px;padding:8px 11px 11px}
.card{flex:1;border:1px solid #e4e9ef;border-radius:8px;overflow:hidden;background:#fff;display:flex}
.card .thumb{width:46px;flex:0 0 46px;background:linear-gradient(160deg,#9db9c9,#6c8f6e)}
.card.b .thumb{background:linear-gradient(160deg,#aebfcb,#8898a3)}
.card .cb{flex:1;padding:6px 8px;min-width:0}
.card .no{font-size:9.5px;font-weight:700;color:#22303d;margin-bottom:4px;white-space:nowrap}
.row{display:flex;align-items:center;gap:4px;font-size:9px;white-space:nowrap;color:#4d5967;margin:2px 0}
.row em{font-style:normal;color:#9aa5b1;font-size:8px}
.sel-el{position:relative;display:inline-block;padding:1px 4px;margin:-1px -4px;border-radius:3px;
  box-shadow:0 0 0 1.5px #7b6fd0,0 0 0 4px rgba(123,111,208,.18);background:rgba(123,111,208,.08)}
.pvbadge{position:absolute;left:2px;width:19px;height:19px;border-radius:50%;background:#6f6aa8;
  color:#efeaff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;
  z-index:5;box-shadow:0 0 0 3px #0a0d13}
.pvfoot{height:26px;display:flex;align-items:center;gap:7px;padding:0 11px;
  border-top:1px solid rgba(255,255,255,.05);font-size:10px;color:var(--tx3)}
.pvfoot b{color:var(--tx2);font-weight:500}

/* 凡例 */
.lgb{padding:9px 11px 11px;display:grid;grid-template-columns:34px 1fr;gap:8px 9px;align-items:center}
.lgb u{text-decoration:none;display:flex;align-items:center;justify-content:center;height:13px}
.lgb t{display:block;font-size:10.5px;color:var(--tx2)}
.lgb t i{font-style:normal;color:var(--tx4);font-size:9.5px}
.lgsep{grid-column:1/3;height:1px;background:rgba(255,255,255,.055);margin:2px 0}
.tg{grid-column:1/3;display:flex;align-items:center;gap:9px;font-size:10.5px;color:var(--tx2)}
.tg span{margin-left:auto;width:30px;height:16px;border-radius:9px;background:rgba(157,147,224,.3);
  box-shadow:inset 0 0 0 1px rgba(157,147,224,.45);position:relative}
.tg span::after{content:"";position:absolute;right:2px;top:2px;width:12px;height:12px;border-radius:50%;
  background:#cfc6f5}

/* 小さな操作チップ */
.ctl{position:absolute;z-index:3;display:flex;align-items:center;gap:4px;padding:4px;border-radius:10px;
  background:rgba(13,16,22,.88);border:1px solid #262e40;box-shadow:0 14px 34px rgba(0,0,0,.6)}
.ctl b{font-weight:400;font-size:11px;color:var(--tx2);height:26px;padding:0 11px;display:flex;
  align-items:center;gap:6px;border-radius:7px}
.ctl b.ic{width:28px;padding:0;justify-content:center;color:var(--tx3);font-size:13px}
.ctl .sep{width:1px;height:16px;background:#232b3c;margin:0 2px}
.ctl b.val{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--tx2)}

/* 注記 */
.note{position:absolute;z-index:3;font-size:10px;line-height:1.6;border-radius:8px;padding:6px 11px;
  letter-spacing:.02em}
.note.concept{color:#8e97ab;border:1px solid #242c3c;background:rgba(10,13,19,.82)}
.note.concept b{color:#aab3c6;font-weight:600}
.note.synth{color:#6d6046;border:1px dashed #3d3626;background:rgba(10,9,6,.6);font-size:9.5px}

/* ---------- 右の固定詳細パネル（ここだけドック） ---------- */
.dock{flex:0 0 360px;width:360px;background:var(--panel);border-left:1px solid #1f2634;
  display:flex;flex-direction:column;min-height:0;overflow:hidden;z-index:4;
  box-shadow:-20px 0 44px rgba(0,0,0,.55)}
.dh{height:36px;flex:0 0 36px;display:flex;align-items:center;gap:9px;padding:0 13px;
  border-bottom:1px solid var(--line-soft);font-size:11px;color:var(--tx3);letter-spacing:.06em}
.dh .r{margin-left:auto;display:flex;align-items:center;gap:9px;color:var(--tx4);font-size:11px}
.dh .pin{font-size:9.5px;border:1px solid #232b3c;border-radius:5px;padding:2px 6px;letter-spacing:.04em}
.sum{padding:11px 14px 12px;border-bottom:1px solid var(--line-soft)}
.sum .k{font-size:10px;color:var(--tx3);letter-spacing:.09em;margin-bottom:9px}
.claim{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.claim .src{font-family:ui-monospace,Menlo,monospace;font-size:17px;font-weight:600;letter-spacing:.01em}
.chip-est{font-size:10.5px;padding:2px 8px;border-radius:5px;color:#c3b9ee;
  border:1px dashed rgba(157,147,224,.5);background:rgba(157,147,224,.07);letter-spacing:.04em}
.sum p{font-size:11.5px;line-height:1.62;color:var(--tx2);margin-top:9px}
.hint{font-size:10px;line-height:1.6;color:var(--tx4);margin-top:7px;padding-top:7px;
  border-top:1px dashed var(--line)}
.dtabs{display:flex;gap:4px;padding:9px 14px 0}
.dtabs span{font-size:11px;padding:5px 13px;border-radius:7px;color:var(--tx3);border:1px solid transparent}
.dtabs span.on{color:var(--tx);background:var(--panel2);border-color:var(--line)}
.weak{margin:9px 14px 0;border:1px solid rgba(157,147,224,.26);border-radius:10px;
  background:linear-gradient(180deg,rgba(157,147,224,.09),rgba(157,147,224,.03));padding:10px 12px}
.weak .wt{display:flex;align-items:center;gap:7px;font-size:11.5px;color:#c7bef0;font-weight:600}
.weak .wh{font-size:12.5px;color:var(--tx);margin-top:8px;font-weight:600;line-height:1.5}
.weak .wh u{text-decoration:none;color:var(--lav);font-family:ui-monospace,Menlo,monospace;margin-right:7px}
.weak p{font-size:11px;line-height:1.62;color:var(--tx2);margin-top:6px}
.weak .ev{font-size:10.5px;line-height:1.6;color:var(--tx3);margin-top:8px;padding-top:8px;
  border-top:1px solid rgba(157,147,224,.16)}
.weak .ev b{color:var(--tx2);font-weight:500}
.btn{margin-top:8px;height:25px;display:inline-flex;align-items:center;padding:0 12px;border-radius:7px;
  border:1px solid rgba(157,147,224,.4);background:rgba(157,147,224,.10);color:#cfc6f5;font-size:11px}
.steps{padding:10px 14px 0}
.steps .k{font-size:10px;color:var(--tx3);letter-spacing:.09em;margin-bottom:7px}
.st{display:flex;gap:9px;padding:2px 0;position:relative}
.st .bd{width:18px;height:18px;flex:0 0 18px;border-radius:50%;background:#20253a;color:#a79fe0;
  font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}
.st.cur .bd{background:#6f6aa8;color:#efeaff}
.st .tx{min-width:0;flex:1}
.st .tt{font-size:11px;color:var(--tx);line-height:1.4;display:block}
.st .ts{font-size:9.5px;color:var(--tx3);margin-top:1px;display:block;
  font-family:ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st .tag{margin-left:auto;font-size:9.5px;color:var(--tx4);padding-top:2px;white-space:nowrap}
.st .conn{position:absolute;left:8.5px;top:24px;bottom:0;width:1px;background:var(--line)}
.st.cur{background:rgba(157,147,224,.06);border-radius:8px;margin:0 -8px;padding:6px 8px}
.st.cur .conn{left:16.5px}
.rel{position:relative;padding:0 0 1px 28px}
.rel .rc{position:absolute;left:8.5px;top:-6px;bottom:-6px;width:1px;background:var(--line)}
.rel.est .rc{background:repeating-linear-gradient(180deg,#453f68 0 3px,transparent 3px 6px)}
.rel .rt{font-size:9.5px;color:#717a8d;line-height:1.5;display:block}
.rel.est .rt{color:#8f86bd}
.rel .rt i{font-style:normal;color:var(--tx4)}
.ovw{margin:6px 0 6px 28px;border:1px solid var(--line);border-radius:8px;background:var(--sunken);
  padding:7px 9px}
.ovw dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:10.5px}
.ovw dt{color:var(--tx4)}
.ovw dd{color:var(--tx2);font-family:ui-monospace,Menlo,monospace;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.ret{margin:5px 0 0;display:flex;align-items:center;gap:7px;padding:5px 9px;border-radius:7px;
  border:1px dashed rgba(157,147,224,.30);background:rgba(157,147,224,.05)}
.ret b{font-size:10.5px;color:#cfc6f5;font-weight:400}
.ret span{font-size:10px;color:#9a90cb;line-height:1.5}
.ret u{text-decoration:none;font-family:ui-monospace,Menlo,monospace}
"""

# ---------------------------------------------------------------- SVG：地球
def globe():
    GX, GY, GR = 620, 1500, 1420
    rnd = random.Random(7)
    s = []
    # 宇宙の微光（星）
    stars = []
    for _ in range(120):
        x, y = rnd.uniform(0, CW), rnd.uniform(0, 260)
        if (x - GX) ** 2 + (y - GY) ** 2 < (GR + 10) ** 2:
            continue
        r = rnd.choice([0.6, 0.7, 0.9, 1.2])
        stars.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="#a9bad6" opacity="{rnd.uniform(.14,.6):.2f}"/>')
    s.append("".join(stars))
    # 大気（外側のにじみ）
    s.append(f'<circle cx="{GX}" cy="{GY}" r="{GR+30}" fill="none" stroke="#5d9fd6" '
             f'stroke-width="58" opacity=".13" filter="url(#blurL)"/>')
    s.append(f'<circle cx="{GX}" cy="{GY}" r="{GR+8}" fill="none" stroke="#9ed2f4" '
             f'stroke-width="12" opacity=".28" filter="url(#blurM)"/>')
    # 球体
    s.append(f'<circle cx="{GX}" cy="{GY}" r="{GR}" fill="url(#gSphere)"/>')
    s.append('<g clip-path="url(#clipSphere)">')
    # 海の濃淡
    s.append(f'<ellipse cx="420" cy="400" rx="800" ry="540" fill="#24456f" opacity=".26" filter="url(#blurL)"/>')
    s.append(f'<ellipse cx="1120" cy="800" rx="640" ry="500" fill="#1d3a5e" opacity=".22" filter="url(#blurL)"/>')
    # 陸塊（抽象形。実在の大陸・国境・地名・緯度経度は描かない — D-3）
    land = [
      "M 60,430 C 160,352 300,344 388,392 C 462,432 430,512 500,536 C 580,564 604,648 536,694 "
      "C 448,752 258,728 170,662 C 88,600 10,486 60,430 Z",
      "M 540,250 C 652,196 812,210 866,272 C 914,328 862,390 786,404 C 698,420 580,386 540,330 Z",
      "M 892,452 C 1006,406 1142,440 1198,516 C 1244,580 1192,652 1098,664 C 996,676 908,620 884,548 Z",
      "M 300,792 C 412,758 526,788 556,850 C 580,904 514,950 424,946 C 332,942 258,884 300,792 Z",
      "M 742,692 C 842,654 954,692 968,760 C 980,818 906,858 828,844 C 752,830 700,742 742,692 Z",
      "M 1086,262 C 1152,234 1216,264 1224,308 C 1232,356 1178,382 1124,368 C 1074,354 1044,286 1086,262 Z",
      "M 596,520 C 648,498 700,516 706,552 C 712,590 664,610 622,598 C 584,586 562,536 596,520 Z",
      "M 1020,862 C 1098,838 1180,862 1192,906 C 1202,944 1148,952 1090,948 C 1038,944 992,886 1020,862 Z",
    ]
    for d in land:
        s.append(f'<path d="{d}" fill="#132442" opacity=".85"/>')
        s.append(f'<path d="{d}" fill="none" stroke="#6ba3d0" stroke-width="1.5" opacity=".42"/>')
        s.append(f'<path d="{d}" fill="none" stroke="#9ed2f4" stroke-width="4" opacity=".10" filter="url(#blurS)"/>')
    # 夜の都市光（控えめ・陸塊の上だけ）
    pts = [(150,500),(205,470),(240,520),(300,440),(345,470),(392,444),(300,540),(250,590),(200,556),
           (355,536),(420,492),(432,572),(362,618),(300,640),(242,648),(470,556),(492,598),(130,560),
           (178,616),(262,682),(330,700),(398,676),(452,628),
           (608,308),(662,274),(716,296),(762,262),(804,304),(686,348),(740,356),(632,364),(820,350),
           (580,290),(700,230),(760,330),(840,292),
           (952,506),(1004,472),(1058,500),(1108,480),(996,552),(1056,572),(1118,542),(950,572),
           (1148,582),(1016,612),(1090,616),(930,520),(1170,520),
           (352,820),(406,796),(452,838),(388,862),(486,868),(324,848),(430,900),(500,820),
           (786,676),(838,700),(884,742),(818,772),(892,784),(762,760),(856,660),(930,728),
           (1128,292),(1172,312),(1148,336),(1100,296),
           (620,540),(660,528),(678,566),(640,580),
           (1052,880),(1104,872),(1152,898),(1086,912)]
    lights = []
    for (x, y) in pts:
        r = rnd.choice([1.0, 1.2, 1.5, 1.9])
        o = rnd.uniform(.50, .95)
        lights.append(f'<circle cx="{x}" cy="{y}" r="{r:.1f}" fill="#ffd9a3" opacity="{o:.2f}"/>')
        lights.append(f'<circle cx="{x}" cy="{y}" r="{r*3.6:.1f}" fill="#f0c488" opacity="{o*0.22:.2f}" filter="url(#blurS)"/>')
    s.append("".join(lights))
    # 昼側のごく弱い照り返し（左上）
    s.append('<ellipse cx="330" cy="200" rx="560" ry="360" fill="#4e86b4" opacity=".07" filter="url(#blurL)"/>')
    # 夜へ落ちる陰り
    s.append(f'<circle cx="{GX}" cy="{GY}" r="{GR}" fill="url(#gTerm)"/>')
    # 内縁のリムライト
    s.append(f'<circle cx="{GX}" cy="{GY}" r="{GR-2}" fill="none" stroke="#8ec6ec" stroke-width="3" opacity=".45"/>')
    s.append(f'<circle cx="{GX}" cy="{GY}" r="{GR-1}" fill="none" stroke="#d8eeff" stroke-width="1.2" opacity=".32"/>')
    s.append("</g>")
    return "".join(s), (GX, GY, GR)

# ---------------------------------------------------------------- SVG：立体部品
def plinth(cx, cy, w, tone="lav"):
    """ガラスの台座（等角の菱形）。オブジェクトの足元に置く"""
    h = w * 0.30
    col = {"lav": "#6f66a8", "blue": "#4f6f96", "dim": "#2a3142"}[tone]
    op  = {"lav": ".55", "blue": ".5", "dim": ".28"}[tone]
    s = (f'<ellipse cx="{cx}" cy="{cy+6}" rx="{w*0.62:.0f}" ry="{h*0.70:.0f}" '
         f'fill="{col}" opacity=".16" filter="url(#blurM)"/>'
         f'<path d="M{cx-w/2:.0f},{cy} L{cx:.0f},{cy-h:.0f} L{cx+w/2:.0f},{cy} L{cx:.0f},{cy+h:.0f} Z" '
         f'fill="url(#gPlinth)" stroke="{col}" stroke-opacity="{op}" stroke-width="1"/>'
         f'<path d="M{cx-w/2:.0f},{cy} L{cx:.0f},{cy+h:.0f} L{cx+w/2:.0f},{cy} '
         f'L{cx+w/2:.0f},{cy+7} L{cx:.0f},{cy+h+7:.0f} L{cx-w/2:.0f},{cy+7} Z" '
         f'fill="#0a0e16" stroke="{col}" stroke-opacity=".30" stroke-width="1"/>')
    return s

GLYPH = {
 # 表示された値：画面の枠の中で、ひとつの値だけが選ばれている
 "value":  '<rect x="3" y="4.5" width="18" height="15" rx="2.6"/>'
           '<path d="M3 9.4h18"/>'
           '<rect x="6.2" y="12.3" width="7.4" height="3.9" rx="1.3" '
           'fill="rgba(157,147,224,.34)" stroke-width="1.2"/>'
           '<path d="M16.6 14.2h2.4"/>',
 # 通信：行って、戻る（往復であることを形で示す）
 "http":   '<path d="M4.4 9.3h12.4"/><path d="M14.2 6.8 16.9 9.3l-2.7 2.5"/>'
           '<path d="M19.6 14.9H7.2"/><path d="M9.8 12.4 7.1 14.9l2.7 2.5"/>',
 # サーバー処理：ひとつの区間（Span）のあいだに何かが起きた
 "server": '<path d="M5 7.2v9.6M19 7.2v9.6"/><path d="M5 12h14"/>'
           '<circle cx="12" cy="12" r="2.6" fill="#0c1018" stroke-width="1.5"/>',
 # 実行SQL：絞り込み。書類ではなく、漏斗
 "sql":    '<path d="M3.9 5.4h16.2l-6.2 7.3v6.1l-3.8 1.8v-7.9z"/>',
 # テーブル：格子
 "table":  '<rect x="3" y="4.2" width="18" height="15.6" rx="2.2"/>'
           '<path d="M3 9.2h18M9 9.2v10.6M15 9.2v10.6"/>',
 # カラム：同じ格子の、1列だけ
 "column": '<rect x="3" y="4.2" width="18" height="15.6" rx="2.2"/>'
           '<rect x="9" y="9.2" width="6" height="10.6" fill="rgba(157,147,224,.32)" stroke="none"/>'
           '<path d="M3 9.2h18M9 9.2v10.6M15 9.2v10.6"/>',
}

def react_glyph(cx, cy, w):
    """Reactを連想させる概念モジュール。タイル幅に対する比率を他の記号と揃える"""
    sc = w * 0.0152
    return (f'<g transform="translate({cx},{cy}) scale({sc:.3f})" fill="none" stroke="#c6bef5" '
            f'stroke-width="1.6" stroke-linecap="round">'
            f'<circle cx="0" cy="0" r="2.5" fill="#c6bef5" stroke="none"/>'
            f'<ellipse cx="0" cy="0" rx="10.6" ry="4.0"/>'
            f'<ellipse cx="0" cy="0" rx="10.6" ry="4.0" transform="rotate(60)"/>'
            f'<ellipse cx="0" cy="0" rx="10.6" ry="4.0" transform="rotate(-60)"/></g>')

def glass_tile(cx, cy, w, kind, dim=False, glyph_scale=1.0):
    """概念モジュール：半透明のガラス板（影を落とさない）"""
    h = w * 0.86
    th = 9
    st = "#2a3142" if dim else "#6f66a8"
    fill = "url(#gGlassDim)" if dim else "url(#gGlass)"
    s = (f'<path d="M{cx-w/2:.0f},{cy-h/2+th:.0f} L{cx-w/2:.0f},{cy+h/2:.0f} '
         f'L{cx+w/2:.0f},{cy+h/2:.0f} L{cx+w/2:.0f},{cy-h/2+th:.0f} Z" fill="#090d15" '
         f'stroke="{st}" stroke-opacity=".4" stroke-width="1"/>'
         f'<rect x="{cx-w/2:.0f}" y="{cy-h/2:.0f}" width="{w:.0f}" height="{h:.0f}" rx="{w*0.16:.0f}" '
         f'fill="{fill}" stroke="{st}" stroke-width="1.2"/>'
         f'<rect x="{cx-w/2+3:.0f}" y="{cy-h/2+3:.0f}" width="{w-6:.0f}" height="{h-6:.0f}" '
         f'rx="{w*0.13:.0f}" fill="none" stroke="#b3abe8" stroke-opacity="{.07 if dim else .17}"/>')
    g = GLYPH.get(kind)
    sc = w * 0.0194 * glyph_scale            # 24グリッドを、タイルの約47%に収める
    col = "#39415a" if dim else "#c6bef5"
    if g:
        s += (f'<g transform="translate({cx-12*sc:.1f},{cy-12*sc:.1f}) scale({sc:.3f})" fill="none" '
              f'stroke="{col}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{g}</g>')
    return s

def laptop(cx, cy, w):
    """物理的実体：不透明・接地影あり"""
    sw, sh = w * 0.80, w * 0.52
    s = (f'<ellipse cx="{cx}" cy="{cy+w*0.30:.0f}" rx="{w*0.56:.0f}" ry="{w*0.13:.0f}" '
         f'fill="#000" opacity=".5" filter="url(#blurM)"/>')
    # 画面
    s += (f'<path d="M{cx-sw/2:.0f},{cy-sh-10:.0f} L{cx+sw/2:.0f},{cy-sh-18:.0f} '
          f'L{cx+sw/2:.0f},{cy+2:.0f} L{cx-sw/2:.0f},{cy+8:.0f} Z" fill="#1a2030"/>')
    s += (f'<path d="M{cx-sw/2:.0f},{cy-sh-10:.0f} L{cx+sw/2:.0f},{cy-sh-18:.0f} '
          f'L{cx+sw/2:.0f},{cy+2:.0f} L{cx-sw/2:.0f},{cy+8:.0f} Z" fill="url(#gScreen)" '
          f'stroke="#49527a" stroke-width="1.4"/>')
    # 画面内のプレビュー（簡略）
    s += (f'<clipPath id="lcScreen"><path d="M{cx-sw/2+5:.0f},{cy-sh-6:.0f} L{cx+sw/2-5:.0f},{cy-sh-13:.0f} '
          f'L{cx+sw/2-5:.0f},{cy-2:.0f} L{cx-sw/2+5:.0f},{cy+3:.0f} Z"/></clipPath>'
          f'<g clip-path="url(#lcScreen)">'
          f'<rect x="{cx-sw/2:.0f}" y="{cy-sh-18:.0f}" width="{sw:.0f}" height="{sh+26:.0f}" fill="#eef2f6"/>'
          f'<rect x="{cx-sw/2:.0f}" y="{cy-sh-14:.0f}" width="{sw:.0f}" height="{sh*0.42:.0f}" '
          f'fill="#7ea8c0"/>'
          f'<rect x="{cx-sw/2+8:.0f}" y="{cy-sh*0.36:.0f}" width="{sw*0.40:.0f}" height="{sh*0.40:.0f}" rx="3" fill="#fff"/>'
          f'<rect x="{cx-sw/2+12:.0f}" y="{cy-sh*0.30:.0f}" width="{sw*0.14:.0f}" height="{sh*0.26:.0f}" rx="2" fill="#8fae87"/>'
          f'<rect x="{cx+2:.0f}" y="{cy-sh*0.38:.0f}" width="{sw*0.40:.0f}" height="{sh*0.40:.0f}" rx="3" fill="#fff"/>'
          f'<rect x="{cx+6:.0f}" y="{cy-sh*0.32:.0f}" width="{sw*0.14:.0f}" height="{sh*0.26:.0f}" rx="2" fill="#a8b6bf"/>'
          f'</g>')
    # 選択中の値のハイライト（① の実体）
    hx, hy = cx - sw * 0.16, cy - sh * 0.22
    s += (f'<rect x="{hx:.0f}" y="{hy:.0f}" width="{sw*0.19:.0f}" height="{sh*0.13:.0f}" rx="2.5" '
          f'fill="rgba(157,147,224,.30)" stroke="#cfc6f5" stroke-width="1.4"/>')
    # 本体
    s += (f'<path d="M{cx-sw/2-8:.0f},{cy+8:.0f} L{cx+sw/2+8:.0f},{cy+2:.0f} '
          f'L{cx+sw/2+16:.0f},{cy+15:.0f} L{cx-sw/2-16:.0f},{cy+22:.0f} Z" '
          f'fill="#262c3d" stroke="#454d6b" stroke-width="1.2"/>')
    return s

def rack(cx, cy, w):
    """物理的実体：小型サーバーラック。接地影あり"""
    h = w * 0.98
    dx, dy = w * 0.26, w * 0.17
    s = (f'<ellipse cx="{cx}" cy="{cy+h/2+8:.0f}" rx="{w*0.62:.0f}" ry="{w*0.15:.0f}" '
         f'fill="#000" opacity=".5" filter="url(#blurM)"/>')
    # 上面
    s += (f'<path d="M{cx-w/2:.0f},{cy-h/2:.0f} L{cx-w/2+dx:.0f},{cy-h/2-dy:.0f} '
          f'L{cx+w/2+dx:.0f},{cy-h/2-dy:.0f} L{cx+w/2:.0f},{cy-h/2:.0f} Z" '
          f'fill="#2b3245" stroke="#4e5878" stroke-width="1.1"/>')
    # 側面
    s += (f'<path d="M{cx+w/2:.0f},{cy-h/2:.0f} L{cx+w/2+dx:.0f},{cy-h/2-dy:.0f} '
          f'L{cx+w/2+dx:.0f},{cy+h/2-dy:.0f} L{cx+w/2:.0f},{cy+h/2:.0f} Z" '
          f'fill="#1b2130" stroke="#434c68" stroke-width="1.1"/>')
    # 前面
    s += (f'<rect x="{cx-w/2:.0f}" y="{cy-h/2:.0f}" width="{w:.0f}" height="{h:.0f}" rx="5" '
          f'fill="url(#gRack)" stroke="#525c7e" stroke-width="1.3"/>')
    # ユニット3段 + ステータスライト
    for i in range(3):
        uy = cy - h / 2 + 9 + i * (h - 18) / 3.0
        uh = (h - 22) / 3.0
        s += (f'<rect x="{cx-w/2+7:.0f}" y="{uy:.0f}" width="{w-14:.0f}" height="{uh:.0f}" rx="3" '
              f'fill="#141a27" stroke="#39415c" stroke-width="1"/>')
        for k in range(5):
            s += (f'<rect x="{cx-w/2+13+k*4.6:.1f}" y="{uy+uh*0.55:.0f}" width="2.6" height="{uh*0.22:.0f}" '
                  f'rx="1.2" fill="#2f3850"/>')
        col = "#78b79a" if i != 1 else "#8aa4cc"
        s += (f'<circle cx="{cx+w/2-13:.0f}" cy="{uy+uh*0.5:.0f}" r="2.6" fill="{col}"/>'
              f'<circle cx="{cx+w/2-13:.0f}" cy="{uy+uh*0.5:.0f}" r="6" fill="{col}" opacity=".22" filter="url(#blurS)"/>')
    return s

def dbstack(cx, cy, w, badge_tone="lav"):
    """物理的実体：PostgreSQL の筐体（円柱3段）。接地影あり"""
    rx, ry = w * 0.5, w * 0.17
    lay = w * 0.26
    s = (f'<ellipse cx="{cx}" cy="{cy+lay*1.5+10:.0f}" rx="{w*0.56:.0f}" ry="{w*0.14:.0f}" '
         f'fill="#000" opacity=".5" filter="url(#blurM)"/>')
    for i in (2, 1, 0):
        yy = cy + (i - 1) * lay
        s += (f'<path d="M{cx-rx:.0f},{yy:.0f} L{cx-rx:.0f},{yy+lay:.0f} '
              f'A{rx:.0f},{ry:.0f} 0 0 0 {cx+rx:.0f},{yy+lay:.0f} L{cx+rx:.0f},{yy:.0f} Z" '
              f'fill="url(#gDb)" stroke="#4e5878" stroke-width="1.1"/>')
        s += (f'<ellipse cx="{cx}" cy="{yy:.0f}" rx="{rx:.0f}" ry="{ry:.0f}" fill="#242c45" '
              f'stroke="#5f6a90" stroke-width="1.1"/>')
    # 選択中のテーブル層を明るくする
    yy = cy - lay
    s += (f'<path d="M{cx-rx:.0f},{yy:.0f} L{cx-rx:.0f},{yy+lay:.0f} '
          f'A{rx:.0f},{ry:.0f} 0 0 0 {cx+rx:.0f},{yy+lay:.0f} L{cx+rx:.0f},{yy:.0f} Z" '
          f'fill="rgba(157,147,224,.14)" stroke="#8178c4" stroke-width="1.3"/>')
    s += (f'<ellipse cx="{cx}" cy="{yy:.0f}" rx="{rx:.0f}" ry="{ry:.0f}" fill="#2b3150" '
          f'stroke="#9d93e0" stroke-width="1.3"/>')
    return s

HALO = ' stroke="#05070d" stroke-width="3.4" paint-order="stroke" stroke-linejoin="round"'

def chip(cx, cy, badge, title, sub="", w=None, dim=False, anchor="middle"):
    """ステップのラベル札（丸バッジ + 名称 + 識別子）"""
    tw = max(len(title) * 12.2, len(sub) * 6.9) + 58
    w = w or tw
    h = 44 if sub else 32
    x = cx - w / 2 if anchor == "middle" else (cx if anchor == "start" else cx - w)
    y = cy - h / 2
    bg = "rgba(11,14,21,.90)" if not dim else "rgba(9,11,17,.75)"
    bc = "#39406080" if dim else "#39356a"
    s = (f'<rect x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h}" rx="9" fill="{bg}" '
         f'stroke="{bc}" stroke-width="1"/>')
    if badge:
        s += (f'<circle cx="{x+21:.0f}" cy="{cy:.0f}" r="11" fill="#6f6aa8" stroke="#0f1218" stroke-width="1.6"/>'
              f'<text x="{x+21:.0f}" y="{cy+4:.0f}" text-anchor="middle" font-size="11.5" font-weight="700" '
              f'fill="#f0ecff">{badge}</text>')
    tx = x + (38 if badge else 13)
    tc = "#4b5468" if dim else "#e4e8f0"
    sc = "#3b4254" if dim else "#8d97ab"
    if sub:
        s += (f'<text x="{tx:.0f}" y="{cy-3:.0f}" font-size="12" fill="{tc}">{title}</text>'
              f'<text x="{tx:.0f}" y="{cy+12:.0f}" font-size="9.5" fill="{sc}" '
              f'font-family="ui-monospace,Menlo,monospace">{sub}</text>')
    else:
        s += f'<text x="{tx:.0f}" y="{cy+4:.0f}" font-size="12" fill="{tc}">{title}</text>'
    return s

def plinth_label(cx, cy, t, sub=""):
    s = f'<text x="{cx}" y="{cy}" text-anchor="middle" font-size="10.5" fill="#79839a"{HALO}>{t}</text>'
    if sub:
        s += (f'<text x="{cx}" y="{cy+14}" text-anchor="middle" font-size="9.5" fill="#545d72" '
              f'font-family="ui-monospace,Menlo,monospace"{HALO}>{sub}</text>')
    return s

def beam(d, est=False, dim=False):
    """発光するデータフロー線。実測=連続 / 推定=分節（NFR-30：線種が一次符号）"""
    if dim:
        return (f'<path d="{d}" fill="none" stroke="#283043" stroke-width="1.4" '
                f'stroke-linecap="round" marker-end="url(#arD)"/>')
    col = "#9a8fc4" if est else "#8aa4cc"
    glow = "#7f6fd8" if est else "#5d8fd0"
    dash = ' stroke-dasharray="10 7"' if est else ""
    mk = "arE" if est else "arO"
    return (f'<path d="{d}" fill="none" stroke="{glow}" stroke-width="9" opacity=".16"{dash} '
            f'stroke-linecap="round" filter="url(#blurM)"/>'
            f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2.2"{dash} '
            f'stroke-linecap="round" marker-end="url(#{mk})"/>')

def est_tag(x, y, star=False, label=None):
    w = 58 if star else 40
    s = (f'<rect x="{x-w/2:.0f}" y="{y-10:.0f}" width="{w}" height="20" rx="6" fill="#0d1019" '
         f'stroke="#6f66a8" stroke-dasharray="4 3"/>')
    if star:
        s += (f'<text x="{x-w/2+10:.0f}" y="{y+4.5:.0f}" font-size="11" fill="#cfc6f5">★</text>'
              f'<text x="{x+7:.0f}" y="{y+4:.0f}" text-anchor="middle" font-size="10" fill="#bcb2ec">推定</text>')
    else:
        s += f'<text x="{x:.0f}" y="{y+4:.0f}" text-anchor="middle" font-size="10" fill="#bcb2ec">推定</text>'
    if label:
        s += (f'<text x="{x:.0f}" y="{y-18:.0f}" text-anchor="middle" font-size="10.5" '
              f'fill="#9a90cb"{HALO}>{label}</text>')
    return s

def cutmark(x, y, ang, tx, ty):
    """切断マーカー：追跡しようとしたができなかった（E-07）。線を消さない"""
    return (f'<g transform="translate({x},{y}) rotate({ang})">'
            f'<path d="M0,-11 L0,11" stroke="#c2a06e" stroke-width="1.8" stroke-linecap="round"/>'
            f'<path d="M8,-7 L19,4 M19,-7 L8,4" stroke="#c2a06e" stroke-width="1.6" stroke-linecap="round"/></g>'
            f'<text x="{tx}" y="{ty}" font-size="11" fill="#bfa073"{HALO}>追跡できません</text>'
            f'<text x="{tx}" y="{ty+15}" font-size="10" fill="#7d6a4c"{HALO}>未対応の構成です</text>')

# ---------------------------------------------------------------- シーン
def scene():
    s = []
    # ---- ノードの配置（層：ブラウザ＝左 / サーバー＝右上 / DB＝右下）----
    P = {1:(300,480), 2:(430,650), 3:(640,760), 4:(900,330), 5:(960,530), 6:(1120,680), 7:(960,800)}

    # ---- 経路外（減光して残す・UI-33）----
    s.append(beam("M 492,862 C 534,878 566,886 598,894", dim=True))
    s.append(glass_tile(462, 852, 40, "http", dim=True))
    s.append(glass_tile(628, 900, 40, "sql", dim=True))
    s.append(f'<text x="462" y="892" text-anchor="middle" font-size="9.5" fill="#434b5d" '
             f'font-family="ui-monospace,Menlo,monospace"{HALO}>/api/favorites</text>')
    s.append(f'<text x="664" y="906" font-size="9.5" fill="#434b5d"{HALO}>SQL</text>')
    s.append(f'<text x="408" y="818" font-size="10" fill="#3f4759"{HALO}>選択していない経路（このページの他の通信）</text>')

    # ---- ビーム（オブジェクトの後ろに敷く）----
    s.append(beam("M 352,556 C 376,588 388,606 400,622"))                      # ①→② renders 実測
    s.append(beam("M 462,678 C 510,712 556,736 598,750", est=True))            # ②→③ derives 推定
    s.append(beam("M 668,726 C 740,636 806,470 864,368"))                      # ③→④ handles 実測
    s.append(beam("M 916,380 C 932,424 944,470 952,496"))                      # ④→⑤ executes 実測
    s.append(beam("M 998,556 C 1040,592 1074,630 1094,654"))                   # ⑤→⑥ reads 実測
    s.append(beam("M 960,572 C 960,636 960,700 960,758"))                      # ⑤→⑦ projects 実測
    s.append(f'<circle cx="978" cy="566" r="4" fill="#0b0e14" stroke="#8aa4cc" stroke-width="1.6"/>')  # 分岐点
    s.append(beam("M 916,814 C 840,846 730,824 676,790", est=True))            # ⑦→③ maps 推定・最弱環

    # ---- 切断（④ から層の外へ。DB方向へは向けない）----
    s.append(f'<path d="M 938,296 C 988,262 1032,238 1064,222" fill="none" stroke="#6d5f44" '
             f'stroke-width="1.6" stroke-dasharray="5 5"/>')
    s.append(cutmark(1072, 218, 128, 1004, 170))

    # ---- 物理的実体（不透明・接地影あり）----
    s.append('<g class="nd" data-n="1">')
    s.append(laptop(P[1][0], P[1][1] + 16, 170))
    s.append('</g>')
    s.append(plinth_label(P[1][0], P[1][1] + 92, "ブラウザ", "localhost:3000"))

    s.append('<g class="nd" data-n="4">')
    s.append(rack(P[4][0], P[4][1], 104))
    s.append('</g>')
    s.append(plinth_label(P[4][0], P[4][1] + 104, "開発サーバー", "localhost:3000"))

    s.append('<g class="nd" data-n="6">')
    s.append(dbstack(P[6][0], P[6][1], 128))
    s.append('</g>')
    s.append(plinth_label(P[6][0], P[6][1] + 112, "PostgreSQL"))

    # ---- 概念モジュール（半透明・影を落とさない）----
    s.append('<g class="nd" data-n="2">' + glass_tile(P[2][0], P[2][1], 74, None)
             + react_glyph(P[2][0], P[2][1], 74) + '</g>')
    s.append('<g class="nd" data-n="3">' + glass_tile(P[3][0], P[3][1], 74, "http") + '</g>')
    s.append('<g class="nd" data-n="5">' + glass_tile(P[5][0], P[5][1], 74, "sql") + '</g>')
    s.append('<g class="nd" data-n="7">' + glass_tile(P[7][0], P[7][1], 74, "column")
             + f'<rect x="{P[7][0]-7}" y="{P[7][1]-20}" width="13" height="34" rx="2" '
               f'fill="rgba(157,147,224,.26)"/>' + '</g>')   # 選択中のカラムの帯
    # ①→② renders（実測）— ノートPC の手前を通すため、物体の後に描く
    s.append(beam("M 296,512 C 340,560 378,600 400,624"))

    # ---- 推定ホップの印（語は推定の2本にだけ置く）----
    s.append(est_tag(528, 716, label="応答のどの項目か"))
    s.append(est_tag(792, 836, star=True, label="カラムと応答項目の対応づけ"))

    # ---- ラベル札 ----
    s.append('<g class="nd" data-n="1">' + chip(262, 398, "1", "表示された値", "「千葉県」") + '</g>')
    s.append(f'<path d="M 300,420 L 312,452" stroke="#4a5370" stroke-width="1" stroke-dasharray="3 3"/>')
    s.append('<g class="nd" data-n="2">' + chip(452, 566, "2", "コンポーネント", "PropertyCard") + '</g>')
    s.append('<g class="nd" data-n="3">' + chip(668, 648, "3", "通信", "GET /api/properties") + '</g>')
    s.append('<g class="nd" data-n="4">' + chip(856, 222, "4", "サーバー処理", "Next.js API Route") + '</g>')
    s.append('<g class="nd" data-n="5">' + chip(1086, 470, "5", "実行SQL", "SELECT … FROM properties") + '</g>')
    s.append('<g class="nd" data-n="6">' + chip(1150, 594, "6", "テーブル", "properties") + '</g>')
    s.append('<g class="nd" data-n="7">' + chip(884, 890, "7", "カラム", "area") + '</g>')
    return ('<svg class="scene" width="%d" height="%d" viewBox="0 0 %d %d">%s%s</svg>'
            % (CW, CH, CW, CH, DEFS, "".join(s)))

DEFS = """<defs>
<radialGradient id="gSphere" cx="32%" cy="14%" r="88%">
  <stop offset="0" stop-color="#2c4a74"/><stop offset="38%" stop-color="#17294a"/>
  <stop offset="74%" stop-color="#0c1628"/><stop offset="100%" stop-color="#060b15"/></radialGradient>
<radialGradient id="gTerm" cx="28%" cy="8%" r="94%">
  <stop offset="0" stop-color="rgba(0,0,0,0)"/><stop offset="62%" stop-color="rgba(2,5,12,.12)"/>
  <stop offset="100%" stop-color="rgba(2,5,12,.62)"/></radialGradient>
<linearGradient id="gPlinth" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="rgba(157,147,224,.16)"/><stop offset="1" stop-color="rgba(120,150,200,.05)"/></linearGradient>
<linearGradient id="gGlass" x1="0" y1="0" x2="0.3" y2="1">
  <stop offset="0" stop-color="rgba(140,132,210,.26)"/><stop offset="55%" stop-color="rgba(60,66,110,.20)"/>
  <stop offset="100%" stop-color="rgba(20,24,42,.34)"/></linearGradient>
<linearGradient id="gGlassDim" x1="0" y1="0" x2="0.3" y2="1">
  <stop offset="0" stop-color="rgba(60,66,90,.14)"/><stop offset="100%" stop-color="rgba(14,17,26,.3)"/></linearGradient>
<linearGradient id="gRack" x1="0" y1="0" x2="1" y2="0">
  <stop offset="0" stop-color="#262d40"/><stop offset="55%" stop-color="#1d2434"/><stop offset="100%" stop-color="#171d2b"/></linearGradient>
<linearGradient id="gDb" x1="0" y1="0" x2="1" y2="0">
  <stop offset="0" stop-color="#242b42"/><stop offset="50%" stop-color="#1a2134"/><stop offset="100%" stop-color="#151b2a"/></linearGradient>
<linearGradient id="gHero" x1="0" y1="0" x2="0.6" y2="1">
  <stop offset="0" stop-color="#9fc2d8"/><stop offset="40%" stop-color="#7fa8c4"/>
  <stop offset="72%" stop-color="#6f8f72"/><stop offset="100%" stop-color="#4e6b52"/></linearGradient>
<linearGradient id="gScreen" x1="0" y1="0" x2="0.2" y2="1">
  <stop offset="0" stop-color="#20273a"/><stop offset="100%" stop-color="#141a28"/></linearGradient>
<clipPath id="clipSphere"><circle cx="620" cy="1500" r="1420"/></clipPath>
<filter id="blurS" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2.4"/></filter>
<filter id="blurM" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="6"/></filter>
<filter id="blurL" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="26"/></filter>
<marker id="arO" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
  <path d="M0,1 L9,5 L0,9" fill="none" stroke="#a8c0e4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="arE" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
  <path d="M0,1 L9,5 L0,9" fill="none" stroke="#bcb2ec" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="arD" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
  <path d="M0,1 L9,5 L0,9" fill="none" stroke="#39405266" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
</defs>"""

# ---------------------------------------------------------------- 浮かぶパネル
PAGES = """<div class="fpnl" style="left:16px;top:16px;width:200px">
  <div class="fh">ページ<span class="r"><u>⤢</u><u>✕</u></span></div>
  <div class="srch">⌕ ページを検索…</div>
  <div class="pglist">
    <div class="pg"><u>⌂</u><div><b>ホーム</b><s>/</s></div></div>
    <div class="pg on"><u>▣</u><div><b>物件一覧</b><s>/properties</s></div></div>
    <div class="pg"><u>▢</u><div><b>物件詳細</b><s>/properties/[id]</s></div></div>
    <div class="pg"><u>▢</u><div><b>お知らせ</b><s>/news</s></div></div>
    <div class="pg"><u>▢</u><div><b>お問い合わせ</b><s>/contact</s></div></div>
  </div></div>"""

def card(no, area, power, volt, date, sel=False, b=False):
    a = f'<span class="sel-el">{area}</span>' if sel else area
    return (f'<div class="card{" b" if b else ""}"><div class="thumb"></div><div class="cb">'
            f'<div class="no">{no}</div>'
            f'<div class="row"><em>◎</em>{a}</div><div class="row"><em>⚡</em>{power}</div>'
            f'<div class="row"><em>▣</em>{volt}</div><div class="row"><em>▤</em>{date}</div></div></div>')

PREVIEW = f"""<div class="fpnl" style="left:232px;top:16px;width:392px">
  <div class="fh">プレビュー<i>現物</i><span class="r"><u>⤢</u><u>✕</u></span></div>
  <div class="pvb">
    <div class="site">
      <div class="s-nav"><span class="s-logo">GRiDDATA</span><a>物件一覧</a><a>サービス</a><a>お知らせ</a></div>
      <div class="hero"><div class="t"><b>再生可能エネルギーの<br>未来をつくる</b></div>
        <div class="search">エリア・電力会社・条件で検索</div></div>
      <div class="filters"><div class="fl">エリア <span>▾</span></div><div class="fl">電力会社 <span>▾</span></div>
        <div class="fl">電圧区分 <span>▾</span></div><div class="fl">承諾状況 <span>▾</span></div></div>
      <div class="cards">{card("No.900001","千葉県","東京電力","特別高圧","2027年4月",sel=True)}
        {card("No.900002","茨城県","東京電力","高圧","2026年10月",b=True)}</div>
    </div>
    <div class="pvbadge" style="top:196px">1</div>
  </div>
  <div class="pvfoot">選択中 <b>「千葉県」</b><span style="color:var(--tx4)">— プレビューには枠のみを描きます</span></div>
</div>"""

LEG_ROWS = [
 ('<svg width="34" height="13"><path d="M1,7 H25" stroke="#8aa4cc" stroke-width="2"/>'
  '<path d="M24,3.5 L31,7 L24,10.5" fill="none" stroke="#8aa4cc" stroke-width="1.6" '
  'stroke-linecap="round" stroke-linejoin="round"/></svg>', '実測された関係'),
 ('<svg width="34" height="13"><path d="M1,7 H25" stroke="#9a8fc4" stroke-width="2" stroke-dasharray="6 5"/>'
  '<path d="M24,3.5 L31,7 L24,10.5" fill="none" stroke="#9a8fc4" stroke-width="1.6" '
  'stroke-linecap="round" stroke-linejoin="round"/></svg>', '推定の関係'),
 ('<svg width="34" height="15" viewBox="0 0 34 15"><rect x="3" y="1" width="28" height="13" rx="4.5" '
  'fill="#0d1019" stroke="#6f66a8" stroke-dasharray="4 3"/>'
  '<text x="17" y="11" text-anchor="middle" font-size="9.5" fill="#cfc6f5">★</text></svg>',
  'いちばん弱いところ'),
 ('<svg width="34" height="15" viewBox="0 0 34 15"><path d="M10,2 V13" stroke="#c2a06e" stroke-width="1.8" '
  'stroke-linecap="round"/><path d="M16,3 L25,12 M25,3 L16,12" stroke="#c2a06e" stroke-width="1.6" '
  'stroke-linecap="round"/></svg>', '追跡できません'),
 ('<svg width="34" height="15" viewBox="0 0 34 15"><rect x="4" y="2" width="12" height="11" rx="3" '
  'fill="#0b0f18" stroke="#2a3142"/><path d="M19,8 H31" stroke="#283043" stroke-width="1.4"/></svg>',
  '経路外のノード <i>（減光・削除しない）</i>'),
]
LEGEND = ('<div class="fpnl" style="left:16px;top:566px;width:236px">'
          '<div class="fh">表示設定<span class="r"><u>⌃</u></span></div><div class="lgb">'
          + "".join(f'<u>{g}</u><t>{t}</t>' for g, t in LEG_ROWS)
          + '<div class="lgsep"></div>'
          + '<div class="tg">ラベルを表示<span></span></div>'
          + '</div></div>')

MINIMAP = """<div class="fpnl" style="left:16px;top:792px;width:236px;height:124px">
  <div class="fh">全体<span class="r"><i>1 / 1 経路</i></span></div>
  <svg width="234" height="92" viewBox="0 0 234 92" style="display:block">
    <rect x="0" y="0" width="234" height="92" fill="#070a11"/>
    <path d="M38,44 C 54,54 72,62 92,66" stroke="#46527a" stroke-width="1.2" fill="none"/>
    <path d="M92,66 C 112,50 132,36 150,32" stroke="#46527a" stroke-width="1.2" fill="none"/>
    <path d="M150,32 C 162,42 170,52 176,58" stroke="#46527a" stroke-width="1.2" fill="none"/>
    <path d="M176,58 C 186,64 194,68 200,70" stroke="#46527a" stroke-width="1.2" fill="none"/>
    <path d="M176,58 C 172,66 170,72 168,78" stroke="#46527a" stroke-width="1.2" fill="none"/>
    <path d="M168,78 C 140,84 112,76 92,66" stroke="#5d55a0" stroke-width="1.2" fill="none" stroke-dasharray="4 3"/>
    <circle cx="38" cy="44" r="4.5" fill="#1d2536" stroke="#6f66a8"/>
    <circle cx="92" cy="66" r="4" fill="#1d2536" stroke="#6f66a8"/>
    <circle cx="150" cy="32" r="4" fill="#1d2536" stroke="#6f66a8"/>
    <circle cx="176" cy="58" r="4" fill="#1d2536" stroke="#6f66a8"/>
    <circle cx="200" cy="70" r="4" fill="#1d2536" stroke="#6f66a8"/>
    <circle cx="168" cy="78" r="4" fill="#1d2536" stroke="#6f66a8"/>
    <circle cx="62" cy="80" r="3.4" fill="#12161f" stroke="#2a3142"/>
    <circle cx="104" cy="86" r="3.4" fill="#12161f" stroke="#2a3142"/>
    <rect x="18" y="14" width="150" height="64" rx="4" fill="none" stroke="#7e76bd" stroke-width="1.2" opacity=".8"/>
  </svg></div>"""

CAMERA = """<div class="ctl" style="left:268px;top:876px">
  <b class="ic" title="回転">⟳</b><b class="ic" title="移動">✥</b>
  <div class="sep"></div><b class="ic" title="視点を戻す">⌂</b></div>"""

VIEWCTL = """<div class="ctl" style="right:16px;top:16px">
  <b class="ic">⌕</b><div class="sep"></div>
  <b>全体表示</b><div class="sep"></div>
  <b class="ic">−</b><b class="val">100%</b><b class="ic">＋</b>
  <div class="sep"></div><b>表示 立体</b></div>"""

CONCEPT = ('<div class="note concept" style="right:16px;top:64px">'
           '<b>この配置は概念図です</b> — 地球上の位置は地理的な所在地を表していません</div>')
SYNTH = ('<div class="note synth" style="right:16px;bottom:14px">'
         'Phase 4D UI検討用モック／シナリオは合成データ（実測ではありません）</div>')

# ---------------------------------------------------------------- 右の固定パネル
STEPS = [
 ("1","表示された値","「千葉県」","実測"),
 ("2","コンポーネント","src/components/PropertyCard.tsx:42","実測"),
 ("3","通信","GET /api/properties — 200 — 124ms","実測"),
 ("4","サーバー処理","Next.js API Route — 98ms","実測"),
 ("5","実行SQL","SELECT id, title, area … — 42ms — 12行","実測"),
 ("6","テーブル","public.properties","実測"),
 ("7","カラム","area (text)","実測"),       # D-1：⑦ は実測。推定なのはホップ ⑦→③
]
REL = {2:("この値を描いたコンポーネント",False), 3:("応答のどの項目が、この値になったか",True),
       4:("この通信を受けたサーバーの処理",False), 5:("その処理が実行したSQL",False),
       6:("⑤ から分岐 — そのSQLが読んだテーブル",False),
       7:("⑤ から分岐 — そのSQLが取り出した列",False)}
OVW = """<div class="ovw"><dl>
  <dt>取得手段</dt><dd>ブラウザのDOM読み取り</dd>
  <dt>要素</dt><dd>&lt;span&gt; / PropertyCard 内</dd>
  <dt>次の一歩</dt><dd style="font-family:inherit;color:#9a90cb">⑦ のカラムから実際の値を開く</dd>
</dl></div>"""

def dock():
    rows = []
    for i, (n, t, sb, tag) in enumerate(STEPS):
        num = int(n)
        if num in REL:
            tx, est = REL[num]
            rows.append(f'<div class="rel{" est" if est else ""}"><span class="rc"></span>'
                        f'<span class="rt">{tx}{" <i>（推定）</i>" if est else ""}</span></div>')
        cls = "st cur" if num == 1 else "st"
        conn = '<span class="conn"></span>' if i < len(STEPS) - 1 else ""
        rows.append(f'<div class="{cls}" data-n="{n}">{conn}<span class="bd">{n}</span>'
                    f'<span class="tx"><span class="tt">{t}</span><span class="ts">{sb}</span></span>'
                    f'<span class="tag">{tag}</span></div>')
        if num == 1:
            rows.append(OVW)
    rows.append('<div class="ret"><b>★</b><span><u>⑦ → ③</u> ここから ③ の応答へ戻ります'
                '（いちばん弱いところ）</span></div>')
    return f"""<div class="dock">
  <div class="dh">詳細<span class="r"><span>経路</span><span>‹</span><span>›</span>
    <span class="pin">固定</span></span></div>
  <div class="sum">
    <div class="k">この値の出所</div>
    <div class="claim"><span class="src">properties . area</span><span class="chip-est">推定</span></div>
    <p>14 か所のうち 2 か所が推定です。経路全体は、いちばん弱いところに合わせて「推定」になります。</p>
    <div class="hint">実測＝実際に起きたことを観測できた箇所。推定＝コードの形から推測した箇所。</div>
  </div>
  <div class="dtabs"><span class="on">概要</span><span>根拠</span></div>
  <div class="weak">
    <div class="wt">★ いちばん弱いところ</div>
    <div class="wh"><u>⑦→③</u>カラムと応答項目の対応づけ</div>
    <p>ORMの内部変換は観測できません。別名や加工があると成立しません。</p>
    <div class="ev">根拠 2 件：<b>実行されたSQLの解析</b> ／ <b>値の一致</b><br>（値の一致だけでは1つに絞れません）</div>
    <span class="btn">ここを見る</span>
  </div>
  <div class="steps"><div class="k">経路のステップ（7）</div>{"".join(rows)}</div>
</div>"""

N0 = """<div class="n0">
  <div class="mark">◧</div><div class="brand">GRiDDATA</div>
  <div class="tabs"><b class="on">探索</b><b>データ</b><b>実行</b><b class="soon">編集<s>準備中</s></b></div>
  <div class="sup">◬ 対応範囲 <b>部分対応・1件</b></div>
  <div class="sp"></div>
  <div class="chipbar">環境 <b style="color:#b9c2d2;font-weight:600">Local</b> <span class="lock">固定</span></div>
  <div class="chipbar"><span class="dot"></span><code>npm run dev</code> 実行中<span class="port">:3000</span></div>
  <div class="chipbar ins"><span class="dot"></span>計装 有効</div>
</div>"""

HOVER_JS = """
<script>
"use strict";
/* 1600x1000 の設計寸法を、ウィンドウに合わせて等倍で縮小する */
function fit(){
  var s = Math.min(innerWidth/1600, innerHeight/1000);
  document.documentElement.style.setProperty('--s', s);
}
addEventListener('resize', fit); fit();

/* 段階1（ホバー）— キャンバスから外したホップの説明はここで初めて出る（03b 4.1節） */
var HOP = {
  1:["この値が画面に描かれています","\u300c千葉県\u300d",false],
  2:["この値を描いたコンポーネント","src/components/PropertyCard.tsx:42",false],
  3:["応答のどの項目が、この値になったか","GET /api/properties \u2014 200 \u2014 124ms",true],
  4:["この通信を受けたサーバーの処理","Next.js API Route \u2014 98ms",false],
  5:["その処理が実行したSQL","SELECT id, title, area \u2026 \u2014 42ms \u2014 12\u884c",false],
  6:["\u2464 から分岐 \u2014 そのSQLが読んだテーブル","public.properties",false],
  7:["\u2464 から分岐 \u2014 そのSQLが取り出した列","area (text)",false]
};
var card = document.createElement('div');
card.className = 'hovcard'; card.setAttribute('role','status');
document.body.appendChild(card);

function mark(n, on){
  document.querySelectorAll('.nd[data-n="'+n+'"]').forEach(function(g){ g.classList.toggle('on', on); });
  document.querySelectorAll('.st[data-n="'+n+'"]').forEach(function(r){ r.classList.toggle('on', on); });
}
var cur = null;
function show(n, x, y){
  if (cur !== n){ if (cur) mark(cur,false); cur = n; mark(n,true); }
  var h = HOP[n];
  card.innerHTML = '<b>'+h[0]+'</b><s>'+h[1]+'</s><i class="'+(h[2]?'e':'m')+'">'+(h[2]?'推定':'実測')+'</i>';
  card.classList.add('on');
  card.style.left = Math.min(innerWidth-320, x+16)+'px';
  card.style.top  = Math.min(innerHeight-110, y+14)+'px';
}
function hide(){ if (cur) mark(cur,false); cur = null; card.classList.remove('on'); }

addEventListener('pointermove', function(e){
  var g = e.target.closest ? e.target.closest('.nd,.st') : null;
  if (!g){ hide(); return; }
  show(+g.dataset.n, e.clientX, e.clientY);
});
addEventListener('pointerleave', hide);
</script>"""

def build():
    return f"""<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>GRiDDATA Physical View</title>
<style>{CSS}</style></head><body><div class="fit"><div class="app">{N0}
<div class="stage">
  <div class="canvas">{scene()}{PAGES}{PREVIEW}{LEGEND}{MINIMAP}{VIEWCTL}{SYNTH}</div>
  {dock()}
</div></div></div>{HOVER_JS}</body></html>"""

if __name__ == "__main__":
    io.open(os.path.join(OUT, "physical-view-v1.html"), "w", encoding="utf-8").write(build())
    print("wrote physical-view-v1.html")
