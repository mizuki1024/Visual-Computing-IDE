/* =============================================================================
 * 導出値 — 件数・経路全体の観測性・最弱環は経路から算出する。
 * 定数として埋め込まないこと（02d 2.3節 / 申し送り 5.2節）。
 * ========================================================================== */
import type { LaidOutDataset } from './layout';
import { CUT_STAGE, type Observability, type PathDetail } from './model';
import { byIdIn, type TraceHop, type TraceNode } from './trace';

/**
 * 導出の入力はデータセット1つだけである。合成でも実測でも同じ関数を通る。
 * 定数を読まない — 読んでしまうと実測データに差し替えた瞬間に嘘になる。
 */
type DS = LaidOutDataset;

export interface PathSummaryModel {
  /** 構成要素数 = ノード + ホップ */
  total: number;
  measured: number;
  estimated: number;
  /** 経路全体の観測性。最弱環に合わせる（OBS-10） */
  observability: Observability;
  /** 最弱環。同率なら、より下流のホップ */
  weakest: TraceHop | null;
  /** 主張。たどり着けた終点。到達できていれば「テーブル . カラム」 */
  claim: string;
  /**
   * 起点からホップをたどって終点（テーブル・カラム）へ到達できていないか。
   * **到達していないのに「この値の出所はこのカラムだ」と書いてはいけない。**
   * 観測した塊が複数あって互いにつながっていない場合にこうなる（OBS-05）。
   */
  truncated: boolean;
}

/** 起点からホップをたどって到達できるノード。向きを無視しない。 */
function reachableFrom(ds: DS, start: number): Set<number> {
  const next = new Map<number, number[]>();
  for (const h of ds.hops) {
    const l = next.get(h.from);
    if (l) l.push(h.to);
    else next.set(h.from, [h.to]);
  }
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    for (const to of next.get(queue.shift()!) ?? []) {
      if (!seen.has(to)) { seen.add(to); queue.push(to); }
    }
  }
  return seen;
}

/** 弱い順。A群では L0〜L3 を出さないが、順序関係そのものは必要である。 */
const rank: Record<Observability, number> = { estimated: 0, measured: 1 };

export function summarize(ds: DS): PathSummaryModel {
  const elements: { observability: Observability }[] = [...ds.nodes, ...ds.hops];
  const total = elements.length;
  const estimated = elements.filter((e) => e.observability === 'estimated').length;
  const measured = total - estimated;

  // 最弱環 = いちばん弱く、同率ならいちばん下流のホップ
  const weakest =
    ds.hops.reduce<TraceHop | null>((acc, h) => {
      if (!acc) return h;
      if (rank[h.observability] < rank[acc.observability]) return h;
      if (rank[h.observability] === rank[acc.observability] && h.order > acc.order) return h;
      return acc;
    }, null) ?? null;

  const weakestIsEstimated = weakest?.observability === 'estimated';

  // 経路全体の観測性は最弱環に合わせる
  const observability: Observability = elements.some((e) => e.observability === 'estimated')
    ? 'estimated'
    : 'measured';

  /*
   * 主張 = 起点からたどり着けた終点である。
   * 終点（テーブル・カラム）へ到達していれば「テーブル . カラム」。
   * 到達していなければ、たどれたいちばん先のノードを主張にする。
   * 描かれているだけのノードを主張に使うと、画面が嘘をつく。
   */
  const order = pathOrder(ds);
  const origin = order[0]?.id;
  const reach = origin === undefined ? new Set<number>() : reachableFrom(ds, origin);
  const table = ds.nodes.find((n) => n.kind === 'table' && reach.has(n.id));
  const columns = ds.nodes.filter((n) => n.kind === 'column' && reach.has(n.id));
  const truncated = !table && !columns.length;

  /*
   * 由来の列を**静的解析で推定した**経路（PoC-04 の `supplies`）では、
   * 「経路から到達できる列」と「由来として推定した列」が違う。
   * 1本の SQL が複数の列を取っていても、**この表示値の由来はその一部**である。
   * 到達できる列をそのまま主張にすると、画面が実際より多くを言ってしまう。
   *
   * このホップを持たないデータセット（合成 / PoC-01 / 03 / 05 / 02）では
   * 従来どおりの算出になる。
   */
  const supplies = ds.hops.find((h) => h.relation === 'supplies');
  const supplied = supplies?.candidates ?? [];

  const columnPart = supplies
    ? (supplied.length === 1
      ? supplied[0].identifier.split('.').pop()
      : supplied.length > 1 ? `${supplied.length} 候補のいずれか` : '列は特定できていません')
    : columns.length === 1
      ? columns[0].identifier.replace(/\s*\(.*\)$/, '')
      : columns.length > 1 ? `${columns.length} 列` : undefined;
  const claim = truncated
    ? ([...order].reverse().find((n) => reach.has(n.id))?.identifier ?? '')
    : [table?.identifier.replace(/^public\./, ''), columnPart].filter(Boolean).join(' . ');

  return {
    total,
    measured,
    estimated,
    observability,
    weakest: weakestIsEstimated ? weakest : null,
    claim,
    truncated,
  };
}

/* ========================================================================== */
/* Phase 7C-3（P1-10）: 選んだ値の「描画位置」と「値の由来」を分けて言う           */
/*                                                                            */
/* 経路が DB（テーブル・カラム）まで届いていないとき、従来の見出し               */
/* 「この値の出所 <描画位置> 実測」は、値の出所が実測で分かったように読めた。      */
/* 描画位置が実測で分かっていても、値がどのカラムから来たかは別の問いである。      */
/* 届いていないときだけ、この形で出す（届いている経路の表示は変えない）。          */
/* ========================================================================== */

export interface ValueOriginModel {
  /** 選んだ値を画面に描いたコードの位置（renders の先のコンポーネント） */
  render:
    | { status: 'identified'; at: string; component: string; observability: Observability }
    | { status: 'unidentified' };
  /** どの段で切れたか（Cut.stage）。記録が段を持たなければ null */
  stage: string | null;
  /** 切れた理由（段の語を前置きしていれば外した本文） */
  reason: string;
}

/**
 * 値のノードから DB（テーブル・カラム）へ届いていない経路について、描画位置と切断を返す。
 * 値のノードが無い、または DB まで届いている（推定を含む）なら null — 従来の経路サマリを出す。
 */
export function valueOrigin(ds: DS): ValueOriginModel | null {
  const value = ds.nodes.find((n) => n.kind === 'value');
  if (!value) return null;
  const reach = reachableFrom(ds, value.id);
  if (ds.nodes.some((n) => (n.kind === 'table' || n.kind === 'column') && reach.has(n.id))) return null;

  const rendersHop = ds.hops.find((h) => h.relation === 'renders' && h.from === value.id);
  const comp = rendersHop ? byIdIn(ds, rendersHop.to) : undefined;
  const render: ValueOriginModel['render'] = comp && comp.kind === 'component'
    ? {
      status: 'identified',
      at: comp.identifier,
      component: comp.chipSub,
      observability: rendersHop!.observability === 'measured' && comp.observability === 'measured' ? 'measured' : 'estimated',
    }
    : { status: 'unidentified' };

  // 切断は、たどれたいちばん先（コンポーネント）から生えているものを優先する
  const cut = (comp && ds.cuts.find((c) => c.from === comp.id))
    ?? ds.cuts.find((c) => c.from === value.id)
    ?? ds.cuts.find((c) => reach.has(c.from));
  const stage = cut?.stage ?? null;
  const reason = !cut
    ? 'ここから先のつながりを観測していません'
    : stage === CUT_STAGE.pending
      ? 'この値がどこから来たかの評価が、まだ終わっていません（評価中か、評価できませんでした）'
      : stage === CUT_STAGE.notEvaluated
        ? 'この記録データは、値の由来を評価していない段階のものです'
        : stage && cut.sub.startsWith(`${stage}: `) ? cut.sub.slice(stage.length + 2) : cut.sub;
  return { render, stage, reason };
}


export const word = (o: Observability) => (o === 'measured' ? '実測' : '推定');

/** 経路サマリの本文。文言と順序を変えないこと（03 3.5節 / 表示規則8） */
export function summaryLine(s: PathSummaryModel): string {
  return `${s.total} か所のうち ${s.estimated} か所が推定です。経路全体は、いちばん弱いところに合わせて「${word(
    s.observability,
  )}」になります。`;
}

/** ホップの見出し。「⑦→③ カラムと応答項目の対応づけ」 */
const CIRCLED = ['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
export const circled = (n: number) => CIRCLED[n] ?? String(n);
export const hopArrow = (h: TraceHop) => `${circled(h.from)}→${circled(h.to)}`;
export const hopTitle = (ds: DS, h: TraceHop) =>
  `${byIdIn(ds, h.from).title} → ${byIdIn(ds, h.to).title}`;

/**
 * 「値の一致」を根拠に挙げる際は、必ず併記する（02d 3.3節 / 5.3.2節の禁止事項）。
 * 値の一致は必要条件であって十分条件ではない。
 */
export const VALUE_MATCH = '値の一致';
export const VALUE_MATCH_CAVEAT = '（値の一致だけでは1つに絞れません）';
export const needsCaveat = (evidence: string[]) => evidence.includes(VALUE_MATCH);

/* ========================================================================== */
/* 計測値の文言 — 数値は TraceNode.metrics にだけ置き、表示文はここで組み立てる  */
/* ========================================================================== */

/** 「200 — 124ms」「42ms — 12行」のような、計測値だけの並び */
export function metricsText(n: TraceNode): string {
  const m = n.metrics;
  if (!m) return '';
  const parts: string[] = [];
  if (m.status !== undefined) parts.push(String(m.status));
  if (m.durationMs !== undefined) parts.push(`${m.durationMs}ms`);
  if (m.rows !== undefined) parts.push(`${m.rows}行`);
  return parts.join(' — ');
}

/** 番号付きリストに出す識別子。基底の識別子に計測値を足したもの */
export function identifierOf(n: TraceNode): string {
  const m = metricsText(n);
  return m ? `${n.identifier} — ${m}` : n.identifier;
}

/* ========================================================================== */
/* 段階0（未選択）の俯瞰サマリ                                                 */
/*                                                                            */
/* 03b 4.2節:「通信 N 件 / SQL N 件 / 総 Nms / 推定を含みます」                 */
/* 03a 5節  :「このページの読み込み：通信 N 件 ／ SQL N 件 ／ 総 Nms ／ 推定を含みます」
/* UXR-05   : 俯瞰は、わからないことも含めて全体像である                        */
/*                                                                            */
/* 出さないもの（03b 4.2）: 属性値・所要時間の個別値・L0〜L3・SQL断片・生データ  */
/* ========================================================================== */

export interface PageSummaryModel {
  page: { name: string; path: string };
  /** このページで観測した通信の件数（経路内＋経路外） */
  httpCount: number;
  sqlCount: number;
  /** 時間を計測できた通信の合計。入れ子のスパンは数えない（最上位の通信のみ） */
  measuredMs: number;
  /** そのうち時間を計測できた通信の件数 */
  timedHttpCount: number;
  /** このページの経路の総数と、いま全体を描いている数 */
  pathTotal: number;
  pathShown: number;
  /** 詳細をどこまで持っているかの内訳。合計は pathTotal に一致する */
  pathsByDetail: Record<PathDetail, number>;
  /** 推定の関係の数 */
  estimatedCount: number;
  /** 追跡できなかった箇所の数 */
  untraceableCount: number;
}

export function summarizePage(ds: DS): PageSummaryModel {
  const current = ds.pages.find((p) => p.current) ?? ds.pages[0];

  // 経路外のノードも「このページで起きたこと」である（UXR-05）
  const offKinds = ds.offPath.nodes.map((n) => n.kind);
  const httpNodes = ds.nodes.filter((n) => n.kind === 'http');
  const httpCount = httpNodes.length + offKinds.filter((k) => k === 'http').length;
  const sqlCount =
    ds.nodes.filter((n) => n.kind === 'sql').length + offKinds.filter((k) => k === 'sql').length;

  /*
   * 最上位の通信の所要時間だけを足す。サーバー処理・SQL は通信に入れ子なので
   * 二重に数えない。経路外の通信も、区間を観測できていれば足す — 観測しているのに
   * 「計測できていない」と数えると画面が嘘をつく（合成シナリオでは所要時間を
   * 持たないので、従来どおり数に入らない）。
   */
  const timedOnPath = httpNodes.filter((n) => n.metrics?.durationMs !== undefined);
  const timedOffPath = ds.offPath.nodes.filter(
    (n) => n.kind === 'http' && n.durationMs !== undefined,
  );
  const measuredMs = timedOnPath.reduce((a, n) => a + (n.metrics!.durationMs ?? 0), 0)
    + timedOffPath.reduce((a, n) => a + (n.durationMs ?? 0), 0);
  const timed = [...timedOnPath, ...timedOffPath];

  // 経路外の通信は、それぞれが別の経路である。詳細の持ちぐあいは OFF_PATH が持つ。
  const otherPaths = offKinds.filter((k) => k === 'http').length;
  const pathsByDetail: Record<PathDetail, number> = {
    full: 1, 'not-retrieved': 0, unavailable: 0,
  };
  pathsByDetail[ds.offPath.detail] += otherPaths;

  return {
    page: { name: current.name, path: current.path },
    httpCount,
    sqlCount,
    measuredMs,
    timedHttpCount: timed.length,
    pathTotal: 1 + otherPaths,
    // データセットが全体を描く経路はつねに1本である。
    // 「詳細を持っている経路の数」ではない — 持っていても描いていなければ表示中ではない
    pathShown: 1,
    pathsByDetail,
    estimatedCount: summarize(ds).estimated,
    untraceableCount: ds.cuts.length,
  };
}

/* ========================================================================== */
/* ステップバッジ — 表示順であって識別子ではない                               */
/*                                                                            */
/* 02 5.3節  : 画面に表示される番号は「ステップバッジ」であり識別子ではない。    */
/*             由来は「現在のスコープ内の表示順序」で、スコープが変わると変わる。*/
/* 02a 5章   : 表示バッジは揮発的。スコープ内の順序から再計算される。           */
/* 03c 5.2節 : 経路スコープ = 経路の論理順（上流→下流）                        */
/*             ページスコープ = トレースのスパン開始時刻順                     */
/*                                                                            */
/* TraceNode.id は不変の識別子である。バッジはここで計算する。両者を混ぜない。  */
/* ========================================================================== */

/**
 * 経路の論理順（上流 → 下流）。ホップをたどって作る。配列の並び順には依存しない。
 * 戻るホップ（maps）が指す先は既に訪れているので、順序を乱さない。
 */
export function pathOrder(ds: DS): TraceNode[] {
  const hops = [...ds.hops].sort((a, b) => a.order - b.order);
  const seen = new Set<number>();
  const out: TraceNode[] = [];
  const push = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(byIdIn(ds, id));
  };
  if (hops.length) push(hops[0].from);
  for (const h of hops) { push(h.from); push(h.to); }
  for (const n of ds.nodes) push(n.id);       // どのホップにも現れないノードの保険
  return out;
}

/**
 * ステップバッジ。ページスコープでは番号を出さない。
 *
 * ページスコープの採番は「トレースのスパン開始時刻順」だが、
 *   (1) 合成データにスパンの開始時刻が無く、時刻順を推測してはならない
 *   (2) そもそも採番の対象が違う — ページスコープが数えるのはトレースのスパンであり、
 *       経路の7ノードではない（⑥テーブル・⑦カラムはスパンではなく定義である）
 * ため、現時点では番号を出さない。これは 03b 4.2節・02c S-04 の段階0
 * （ノードに出すのは種別アイコン・名称・状態・線種）とも一致する。
 * 番号が「現れる」だけで「動かない」ので、振り直しの通知も要らない（02 5.3節）。
 */
export function stepBadge(ds: DS, nodeId: number, scope: 'page' | 'path'): number | null {
  if (scope !== 'path') return null;
  const i = pathOrder(ds).findIndex((n) => n.id === nodeId);
  return i < 0 ? null : i + 1;
}

/** バッジ番号から識別子を引く（キーボードの数字入力はバッジに対する操作である） */
export function nodeIdForBadge(ds: DS, badge: number): number | null {
  const n = pathOrder(ds)[badge - 1];
  return n ? n.id : null;
}

/* ========================================================================== */
/* スパンの時間窓（05c 7章）                                                   */
/*                                                                            */
/* 実測データのノードは span: {startMs, endMs} を持つ。定義ノード（テーブル・    */
/* カラム・コンポーネント）は持たない — スパンではないためである。               */
/* 03c 5.2節のページスコープの採番（スパン開始時刻順）は、これで実装可能になる。  */
/* ただし「採番対象はスパンだけか、俯瞰の全ノードか」は未確定のまま（05c 7章）。 */
/* よってここでは順序を返すだけとし、バッジには使わない。                        */
/* ========================================================================== */

/** スパンを持つノードを開始時刻順に並べる。持たないノードは含めない。 */
export function spanOrder(ds: DS): TraceNode[] {
  return ds.nodes
    .filter((n) => n.span)
    .sort((a, b) => a.span!.startMs - b.span!.startMs);
}

/** そのノードの時間窓を「ページ読み込みから Nms、Nms間」の形で読む */
export function spanWindowText(n: TraceNode): string | null {
  if (!n.span) return null;
  const d = Math.round((n.span.endMs - n.span.startMs) * 10) / 10;
  return `読み込み開始から ${Math.round(n.span.startMs)}ms — ${d}ms 間`;
}
