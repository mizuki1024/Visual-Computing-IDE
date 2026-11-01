/* =============================================================================
 * データセットの組み立て。層1（入力）→ 層2（変換）→ 層3（座標）を繋ぐだけの場所。
 *
 * かつてこのファイルは合成データと図の座標を同居させていた。いまは分かれている:
 *   synthetic.ts / observation.measured.ts   層1 入力
 *   adapter.ts                               層2 共通オブジェクトモデルへの変換
 *   layout.ts                                層3 座標
 *   components/                              層4 描画
 *
 * 描画部品は合成でも実測でも同じ型（LaidOutNode / LaidOutHop）を受け取る。
 * ========================================================================== */
import { fromObservation, fromRscObservation } from './adapter';
import { layout, type LaidOutCut, type LaidOutDataset, type LaidOutHop, type LaidOutNode } from './layout';
import { OBSERVATION } from '../data/observation.measured';
import { ELEMENT_OBSERVATION } from '../data/observation.poc03';
import { FLOW_OBSERVATION } from '../data/observation.poc05';
import { RSC_OBSERVATION, RSC_SVC_OBSERVATION } from '../data/observation.poc02';
import { LIN_A_OBSERVATION, LIN_C_OBSERVATION, LIN_G_OBSERVATION } from '../data/observation.poc04';
import { SYNTHETIC } from './synthetic';
import type { DataOrigin } from './model';

export {
  CANVAS, PATH_DETAIL_LABEL, SOURCE_LABEL, SOURCE_LEVEL, observabilityOf,
  nodeById as nodeOf, hopById as hopOf,
} from './model';
export type {
  DataOrigin, Form, Level, Metrics, NodeKind, Observability, OverviewRow,
  PageRef, PathDetail, Provenance, SelectionRef, SourceId, SpanWindow,
} from './model';
export type { LaidOutDataset } from './layout';

/** 描画が受け取るノード／ホップ／切断。座標まで付いている。 */
export type TraceNode = LaidOutNode;
export type TraceHop = LaidOutHop;
export type Cut = LaidOutCut;

/** 実測データの変換結果。変換で作らなかったものも持つ（捏造していない記録） */
export const MEASURED = fromObservation(OBSERVATION);

/**
 * PoC-03 の実測データ。**同じ adapter / layout / 描画部品**を通る。
 * ①② と `renders` が加わるだけで、UI の実装は増えていない。
 */
export const MEASURED_ELEMENTS = fromObservation(ELEMENT_OBSERVATION);

/**
 * PoC-05 の実測データ。**同じ adapter / layout / 描画部品**を通る。
 * ②' 通信を開始したコンポーネント と `requests` が加わるだけで、
 * UI の実装は増えていない。
 */
export const MEASURED_FLOW = fromObservation(FLOW_OBSERVATION);

/**
 * PoC-02 の実測データ。**同じ共通モデル / layout / 描画部品**を通る。
 * 経路の形が違うだけで（`rsc-direct`）、UI の実装は増えていない。
 *   MEASURED_RSC      Server Component → サーバー描画 → SQL → テーブル・カラム
 *   MEASURED_RSC_SVC  さらにサーバー内部の通信が1段入る（W3C 伝播）
 */
export const MEASURED_RSC = fromRscObservation(RSC_OBSERVATION);
export const MEASURED_RSC_SVC = fromRscObservation(RSC_SVC_OBSERVATION);

/**
 * PoC-04 の実測＋推定データ。**同じ共通モデル / layout / 描画部品**を通る。
 * 増えたのは「由来」の関係1本（`supplies`・static-analysis・**推定**）だけで、
 * UI の実装は増えていない。
 *   MEASURED_LIN_A  由来を1列に絞れた   → 推定のホップを1本引く
 *   MEASURED_LIN_C  候補が複数のまま     → ホップは引くが1つに断定しない
 *   MEASURED_LIN_G  由来を作らない       → **切断のまま。線を引かない**
 */
export const MEASURED_LIN_A = fromRscObservation(LIN_A_OBSERVATION);
export const MEASURED_LIN_C = fromRscObservation(LIN_C_OBSERVATION);
export const MEASURED_LIN_G = fromRscObservation(LIN_G_OBSERVATION);

/** 描くデータの選択肢。`origin` は 02a の区分、`elements` は PoC-03 の実測である。 */
export type DatasetKey = DataOrigin | 'elements' | 'flows' | 'rsc' | 'rsc-svc'
  | 'lin-a' | 'lin-c' | 'lin-g';

/** 画面に流し込むデータセット。合成と実測で同じ形になる。 */
export function buildDataset(key: DatasetKey): LaidOutDataset {
  if (key === 'elements') return layout(MEASURED_ELEMENTS.dataset);
  if (key === 'flows') return layout(MEASURED_FLOW.dataset);
  if (key === 'rsc') return layout(MEASURED_RSC.dataset);
  if (key === 'rsc-svc') return layout(MEASURED_RSC_SVC.dataset);
  if (key === 'lin-a') return layout(MEASURED_LIN_A.dataset);
  if (key === 'lin-c') return layout(MEASURED_LIN_C.dataset);
  if (key === 'lin-g') return layout(MEASURED_LIN_G.dataset);
  return layout(key === 'measured' ? MEASURED.dataset : SYNTHETIC);
}

export const byIdIn = (ds: LaidOutDataset, id: number) => ds.nodes.find((n) => n.id === id)!;
export const hopByIdIn = (ds: LaidOutDataset, id: string) => ds.hops.find((h) => h.id === id)!;
