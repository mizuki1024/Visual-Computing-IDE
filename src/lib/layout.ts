/* =============================================================================
 * レイアウト（層3）— オブジェクトモデルに座標を与える。
 *
 * モデル側は座標を持たない（05c 5.2節 規約6）。ここだけが幾何を知る。
 * 合成シナリオは手で置いた座標をそのまま使う（基準画像 gen_physical.py の一次情報。
 * キャンバス設計空間 1240 x 952）。実測データは同じ描画部品のために自動で置く。
 * ========================================================================== */
import type {
  Cut, Dataset, ModelHop, ModelNode, NodeKind, OffPath,
} from './model';

export interface Plinth { x: number; y: number; text: string; sub?: string }

export interface LaidOutNode extends ModelNode {
  /** 立体オブジェクト／ガラスタイルの中心と大きさ */
  x: number; y: number; size: number;
  /** ラベル札の中心 */
  chip: { x: number; y: number };
  /** 札とオブジェクトを結ぶ引き出し線（任意） */
  leader?: string;
  /** 物理的実体の足元に置く層のラベル */
  plinth?: Plinth;
}

export interface LaidOutHop extends ModelHop {
  /** ホップ1本 = 独立した線分（03b 3.3節。隣接ホップを1本に繋がない） */
  d: string;
  /** キャンバスに語を残すのは「観測できていないこと」だけ（表示規則10） */
  tag?: { x: number; y: number; label: string; below?: boolean };
}

export interface LaidOutCut extends Cut {
  d: string;
  mark: { x: number; y: number; angle: number };
  text: { x: number; y: number };
}

export interface LaidOutOffPath extends OffPath {
  hop: string;
  nodes: (OffPath['nodes'][number] & {
    x: number; y: number; size: number; lx: number; ly: number;
  })[];
  caption: OffPath['caption'] & { x: number; y: number };
}

export interface LaidOutDataset extends Omit<Dataset, 'nodes' | 'hops' | 'cuts' | 'offPath'> {
  nodes: LaidOutNode[];
  hops: LaidOutHop[];
  cuts: LaidOutCut[];
  offPath: LaidOutOffPath;
  /** ⑤ の分岐点。⑥ と ⑦ は ⑤ から分かれる（⑥→⑦ ではない） */
  branchPoint: { x: number; y: number };
}

/* ========================================================================== */
/* 合成シナリオの座標 — 基準画像の一次情報。数値を変えないこと                   */
/* ========================================================================== */

const SYNTH_NODES: Record<number, Omit<LaidOutNode, keyof ModelNode>> = {
  1: { x: 300, y: 496, size: 170, chip: { x: 262, y: 398 }, leader: 'M 300,420 L 312,452',
    plinth: { x: 300, y: 572, text: 'ブラウザ', sub: 'localhost:3000' } },
  2: { x: 430, y: 650, size: 74, chip: { x: 452, y: 566 } },
  3: { x: 640, y: 760, size: 74, chip: { x: 668, y: 648 } },
  4: { x: 900, y: 330, size: 104, chip: { x: 856, y: 222 },
    plinth: { x: 900, y: 434, text: '開発サーバー', sub: 'localhost:3000' } },
  5: { x: 960, y: 530, size: 74, chip: { x: 1086, y: 470 } },
  6: { x: 1120, y: 680, size: 128, chip: { x: 1150, y: 594 },
    plinth: { x: 1120, y: 792, text: 'PostgreSQL' } },
  7: { x: 960, y: 800, size: 74, chip: { x: 884, y: 890 } },
};

const SYNTH_HOPS: Record<string, { d: string; tag?: { x: number; y: number } }> = {
  renders: { d: 'M 296,512 C 340,560 378,600 400,624' },
  derives: { d: 'M 462,678 C 510,712 556,736 598,750', tag: { x: 528, y: 716 } },
  handles: { d: 'M 668,726 C 740,636 806,470 864,368' },
  executes: { d: 'M 916,380 C 932,424 944,470 952,496' },
  reads: { d: 'M 998,556 C 1040,592 1074,630 1094,654' },
  projects: { d: 'M 960,572 C 960,636 960,700 960,758' },
  maps: { d: 'M 916,814 C 840,846 730,824 676,790', tag: { x: 792, y: 836 } },
};

/* 線を消さず、✕付きの切断マーカーで止める。サーバー帯の外（上方向）へ抜ける。 */
const SYNTH_CUT = {
  d: 'M 938,296 C 988,262 1032,238 1064,222',
  mark: { x: 1072, y: 218, angle: 128 },
  text: { x: 1004, y: 170 },
};

const SYNTH_OFF = {
  hop: 'M 492,862 C 534,878 566,886 598,894',
  nodes: [
    { x: 462, y: 852, size: 40, lx: 462, ly: 892 },
    { x: 628, y: 900, size: 40, lx: 664, ly: 906 },
  ],
  caption: { x: 408, y: 818 },
};

const SYNTH_BRANCH = { x: 978, y: 566 };

/* ========================================================================== */
/* 実測データの自動配置 — 合成シナリオと同じ描画部品を使える座標を作る            */
/* ========================================================================== */

interface Lane {
  x: number; y0: number; dy: number; size: number;
  /** 札の位置をノード中心からの差分で与える */
  chip: [number, number];
}

/*
 * 浮かぶパネル（ページ 16..216 / プレビュー 232..624 / 表示設定・全体 16..252）の
 * 下に主要なノードが隠れないように帯を決めている。
 */
const LANES: Record<NodeKind, Lane> = {
  value: { x: 300, y0: 496, dy: 0, size: 170, chip: [-38, -98] },
  /*
   * コンポーネントは1つの経路に複数現れることがある（PoC-05）。
   *   ② この値を描いたコンポーネント
   *   ②' この通信を開始したコンポーネント
   * **両者は別のノードである。** 同じコンポーネントだったとしても束ねない。
   * 束ねると「描いた」と「通信を始めた」の間に、観測していない因果が生まれる。
   */
  component: { x: 430, y0: 650, dy: 156, size: 74, chip: [22, -84] },
  http: { x: 390, y0: 430, dy: 150, size: 74, chip: [6, -92] },
  server: { x: 690, y0: 300, dy: 180, size: 104, chip: [70, -104] },
  sql: { x: 900, y0: 390, dy: 150, size: 74, chip: [122, -58] },
  table: { x: 1140, y0: 640, dy: 190, size: 128, chip: [30, -86] },
  column: { x: 860, y0: 690, dy: 100, size: 74, chip: [-112, 4] },
};

/** 2点をつなぐ緩い曲線。ノードの輪郭から出て輪郭へ入る。 */
function curve(
  a: { x: number; y: number; size: number },
  b: { x: number; y: number; size: number },
): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const p0 = { x: a.x + ux * a.size * 0.52, y: a.y + uy * a.size * 0.52 };
  const p1 = { x: b.x - ux * b.size * 0.56, y: b.y - uy * b.size * 0.56 };
  const c1 = { x: p0.x + (p1.x - p0.x) * 0.42, y: p0.y + (p1.y - p0.y) * 0.14 };
  const c2 = { x: p0.x + (p1.x - p0.x) * 0.72, y: p0.y + (p1.y - p0.y) * 0.72 };
  const r = (v: number) => Math.round(v * 10) / 10;
  return `M ${r(p0.x)},${r(p0.y)} C ${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(p1.x)},${r(p1.y)}`;
}

/**
 * 2つ目以降のノードを、帯の並びではなく個別の位置に置く場合の表。
 * ②' 通信を開始したコンポーネントを帯の下へ伸ばすと、線が ② の上を通って
 * 「② と ③ が繋がっている」ように見える。繋がっていないので、そう見せない。
 */
const LANE_ALT: Partial<Record<NodeKind, [number, number][]>> = {
  component: [[560, 566]],
  /*
   * 2つ目のサーバー（PoC-02 Gate A の相手側サービス）。
   * 帯の既定の間隔（180）だと、1つ目の足元のラベルに2つ目の箱が重なる。
   * **ラベルは「どのサービスか」を示す情報である**ため、隠してはならない。
   */
  server: [[690, 572]],
};

function autoPlace(ds: Dataset): Map<number, Omit<LaidOutNode, keyof ModelNode>> {
  const used: Partial<Record<NodeKind, number>> = {};
  const out = new Map<number, Omit<LaidOutNode, keyof ModelNode>>();
  const port = ds.runtime.port;

  for (const n of ds.nodes) {
    const lane = LANES[n.kind];
    const i = used[n.kind] ?? 0;
    used[n.kind] = i + 1;
    const alt = i > 0 ? LANE_ALT[n.kind]?.[i - 1] : undefined;
    const x = alt ? alt[0] : lane.x;
    const y = alt ? alt[1] : lane.y0 + lane.dy * i;
    const place: Omit<LaidOutNode, keyof ModelNode> = {
      x, y, size: lane.size,
      chip: { x: x + lane.chip[0], y: y + lane.chip[1] },
    };
    // 層のラベルは物理的実体の足元にだけ置く。
    // モデルが locus を持っていればそれを使う（観測したサービス名。PoC-02）
    if (n.kind === 'value') {
      place.plinth = n.locus
        ? { x, y: y + 76, ...n.locus }
        : { x, y: y + 76, text: 'ブラウザ', sub: `localhost:${port}` };
    }
    if (n.kind === 'server') {
      place.plinth = n.locus
        ? { x, y: y + 104, ...n.locus }
        : { x, y: y + 104, text: '開発サーバー', sub: `localhost:${port}` };
    }
    if (n.kind === 'table') {
      place.plinth = n.locus ? { x, y: y + 110, ...n.locus } : { x, y: y + 110, text: 'PostgreSQL' };
    }
    out.set(n.id, place);
  }
  return out;
}

/* ========================================================================== */

/** モデル＋座標。合成も実測も、ここから先は同じ構造になる。 */
export function layout(ds: Dataset): LaidOutDataset {
  const synthetic = ds.origin === 'synthetic';
  const places = synthetic
    ? new Map(ds.nodes.map((n) => [n.id, SYNTH_NODES[n.id]]))
    : autoPlace(ds);

  const nodes: LaidOutNode[] = ds.nodes.map((n) => ({ ...n, ...places.get(n.id)! }));
  const at = (id: number) => nodes.find((n) => n.id === id)!;

  const hops: LaidOutHop[] = ds.hops.map((h) => {
    const g = synthetic ? SYNTH_HOPS[h.id] : undefined;
    const a = at(h.from);
    const b = at(h.to);
    const d = g?.d ?? curve(a, b);
    // 語を置く位置は線の中点。推定のホップにだけ付く（表示規則10）
    /*
     * 7C-2: 実測データの自動配置では、語（例「由来は静的解析による推定」）を印の**下**に左揃えで置く。
     * 印の上に置くと、短いホップ（② → ②'）では ② の札と ②' の図形の下に語が隠れていた
     */
    const tag = h.tagLabel
      ? { label: h.tagLabel, ...(g?.tag ?? { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2), below: true }) }
      : undefined;
    return { ...h, d, tag };
  });

  const cuts: LaidOutCut[] = ds.cuts.map((c) => {
    if (synthetic) return { ...c, ...SYNTH_CUT };
    // 切断は元のノードから左上へ抜ける。線を消さずに止める（OBS-05）
    const a = at(c.from);
    const sx = a.x - a.size * 0.5;
    const sy = a.y - a.size * 0.2;
    const ex = sx - 110;
    const ey = sy - 70;
    return {
      ...c,
      d: `M ${sx},${sy} C ${sx - 48},${sy - 20} ${ex + 34},${ey + 24} ${ex},${ey}`,
      mark: { x: ex - 6, y: ey - 4, angle: 212 },
      text: { x: ex - 102, y: ey - 40 },
    };
  });

  const offPath: LaidOutOffPath = {
    ...ds.offPath,
    // ノードが1つしか無いときは、結ぶ線が存在しない。描かない
    hop: synthetic ? SYNTH_OFF.hop
      : ds.offPath.nodes.length > 1 ? 'M 452,898 C 496,910 530,916 562,920' : '',
    nodes: ds.offPath.nodes.map((o, i) => {
      const g = synthetic ? SYNTH_OFF.nodes[i] : null;
      const x = g?.x ?? 420 + i * 170;
      const y = g?.y ?? 890 + i * 40;
      return {
        ...o, x, y, size: g?.size ?? 40,
        lx: g?.lx ?? x, ly: g?.ly ?? y + 40,
      };
    }),
    caption: {
      ...ds.offPath.caption,
      x: synthetic ? SYNTH_OFF.caption.x : 300,
      y: synthetic ? SYNTH_OFF.caption.y : 846,
    },
  };

  // ⑤ の分岐点。SQL ノードの輪郭のすぐ外に置く
  const sql = nodes.find((n) => n.kind === 'sql');
  const branchPoint = synthetic
    ? SYNTH_BRANCH
    : sql ? { x: sql.x + 30, y: sql.y + 36 } : { x: 0, y: 0 };

  const { nodes: _n, hops: _h, cuts: _c, offPath: _o, ...rest } = ds;
  void _n; void _h; void _c; void _o;
  return { ...rest, nodes, hops, cuts, offPath, branchPoint };
}
