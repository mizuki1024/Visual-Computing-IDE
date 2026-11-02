/* =============================================================================
 * Phase 7C-3（P1-9）: 実プロジェクトを開いている間の「まだ経路が無い」状態。
 *
 * 7C-0 の S8 で、実プロジェクトの実行中（選択前）・停止後・再起動後に、キャンバスと右ドックが
 * Phase 5 の**合成デモ（別のアプリの /listings）**を描いていた。注記は画面下の小さな1行だけで、
 * 自分のプロジェクトのデータと誤認しうる。
 *
 * ここでは、プロジェクトの状態（開いた・起動中・実行中・停止・失敗）から、合成デモの代わりに出す
 * 空の状態の文面を決める。文面は 03d 1.1節の4要素（何が起きたか／なぜか／わからないこと／次にできること）。
 * 合成デモは、利用者が明示的に選んだとき（［合成デモを見る］・URL の ?data=）だけ描く。
 *
 * 観測・関係モデル・データの取得には触れない。描くデータセットを差し替えるだけである。
 * ========================================================================== */
import type { LaidOutDataset } from './layout';

/** IDE が扱っているプロジェクトの段階。null = プロジェクトを開いていない（合成デモを出してよい） */
export type ProjectPhase = 'opened' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

/**
 * 開発サーバーの状態（RunState）とプロジェクトの検出結果から、段階を決める。
 * 画面は状態を作らない — 入力はすべて /api/runtime/status の観測結果である。
 */
export function projectPhaseOf(
  state: string | null | undefined,
  hasProject: boolean,
): ProjectPhase | null {
  switch (state) {
    case 'validating':
    case 'starting': return 'starting';
    case 'running': return 'running';
    case 'stopping': return 'stopping';
    case 'stopped': return 'stopped';
    case 'error': return 'error';
    default: return hasProject ? 'opened' : null;
  }
}

export interface ProjectContext {
  phase: ProjectPhase;
  /** プロジェクトの名前（検出結果・実行中のもの）。不明なら null */
  name: string | null;
  /** この画面で、前の起動が停止・失敗した後に起動し直したか（「新しい観測を待っています」と言うため） */
  restarted: boolean;
  /** 検出の判定が「対応」「部分対応」以外（起動できない）か */
  blocked: boolean;
}

/** 03d 1.1節の4要素。④ は文で案内する（押せるボタンは右の「プロジェクトと実行」とプレビューにある） */
export interface EmptyCard {
  /** 見出し（① 何が起きたか） */
  head: string;
  /** ② なぜか・いまの状態 */
  why: string;
  /** ③ この結果わからないこと */
  unknown: string;
  /** ④ 次にできること */
  next: string;
}

export function emptyCard(p: ProjectContext): EmptyCard {
  const name = p.name ? `「${p.name}」` : 'プロジェクト';
  switch (p.phase) {
    case 'opened':
      return p.blocked
        ? {
          head: 'このプロジェクトは、まだ起動できません',
          why: `${name}を検出しましたが、起動の前に確認が必要な点があります。`,
          unknown: '開発サーバーを起動していないため、値の経路は描けません。',
          next: '右の「プロジェクトと実行」に出ている理由を確認してください。',
        }
        : {
          head: 'プロジェクトを開きました（まだ起動していません）',
          why: `${name}を検出しました。開発サーバーはまだ起動していません。`,
          unknown: '起動するまでは何も観測していないため、値の経路は描けません。',
          next: '右の「プロジェクトと実行」で［起動］を押してください。',
        };
    case 'starting':
      return {
        head: '開発サーバーを起動しています',
        why: p.restarted
          ? '起動し直しています。前の起動で観測した経路は表示しません。'
          : `${name}の開発サーバーが応答するのを待っています。`,
        unknown: '起動が終わるまでは、ページも経路もまだありません。',
        next: '起動が終わると、左のプレビューにページが表示されます。そこでページを開いて値を選んでください。',
      };
    case 'running':
      return {
        head: 'まだ経路がありません',
        why: p.restarted
          ? 'この起動では、まだ値を選んでいません。前の起動で観測した経路は表示しません（新しい観測を待っています）。'
          : '開発サーバーは実行中です。まだ値を選んでいません。',
        unknown: '値を選ぶまでは、どの値がどこから来たかは描きません。',
        next: 'プレビューで調べたいページを開き、［選択］を押してから画面の値をクリックしてください。',
      };
    case 'stopping':
      return {
        head: '開発サーバーを停止しています',
        why: '停止を待っています。',
        unknown: '停止した後は、実行時の情報は取得できません。',
        next: '停止が終わるまで、そのままお待ちください。',
      };
    case 'stopped':
      return {
        head: '開発サーバーは停止しています',
        why: '停止したため、それまでの起動で観測した経路は表示していません。',
        unknown: '実行していない間は、値の経路（実測）は取得できません。',
        next: '右の「プロジェクトと実行」で［起動］を押すと、新しい観測から描き直します。',
      };
    case 'error':
    default:
      return {
        head: '開発サーバーを起動できていません',
        why: '理由は右の「プロジェクトと実行」に出ています。',
        unknown: '起動できていないため、値の経路は描けません。',
        next: '理由を確認してから、もう一度［起動］を押してください。',
      };
  }
}

/** キャンバスの注記（表示規則11）。合成でも実測でもないことを言う */
export function emptyNotice(p: ProjectContext): string {
  const name = p.name ?? 'プロジェクト';
  return `${name} — 経路なし（合成デモは非表示）`;
}

/**
 * 経路の無いデータセット。描画部品は「ノードが無い」として描く（合成のノードを1つも持たない）。
 * 座標は使われないが、型を満たすために置く。
 */
export function emptyDataset(p: ProjectContext): LaidOutDataset {
  return {
    origin: 'measured',
    project: p.name ?? '—',
    runtime: { command: 'next dev', port: 0, instrumentation: '—' },
    nodes: [],
    hops: [],
    cuts: [],
    offPath: {
      detail: 'unavailable',
      label: 'なし',
      note: 'まだ何も観測していません。',
      nodes: [],
      caption: { text: '', textUnselected: '', x: 0, y: 0 },
    },
    pages: [],
    notice: emptyNotice(p),
    overviewNote: '',
    branchPoint: { x: -9999, y: -9999 },
  } as unknown as LaidOutDataset;
}
