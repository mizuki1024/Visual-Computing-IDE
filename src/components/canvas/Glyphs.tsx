/* 種別の記号。24グリッドで定義し、タイル幅の約47%に収める（gen_physical.py GLYPH）。 */
import type { NodeKind } from '@/lib/trace';
import type { ReactNode } from 'react';

const G: Record<NodeKind, ReactNode> = {
  // 表示された値：画面の枠の中で、ひとつの値だけが選ばれている
  value: (<>
    <rect x="3" y="4.5" width="18" height="15" rx="2.6" />
    <path d="M3 9.4h18" />
    <rect x="6.2" y="12.3" width="7.4" height="3.9" rx="1.3"
      fill="rgba(157,147,224,.34)" strokeWidth="1.2" />
    <path d="M16.6 14.2h2.4" />
  </>),
  // コンポーネント：React を連想させる概念モジュール（別経路で描く）
  component: null,
  // 通信：行って、戻る（往復であることを形で示す）
  http: (<>
    <path d="M4.4 9.3h12.4" /><path d="M14.2 6.8 16.9 9.3l-2.7 2.5" />
    <path d="M19.6 14.9H7.2" /><path d="M9.8 12.4 7.1 14.9l2.7 2.5" />
  </>),
  // サーバー処理：ひとつの区間（Span）のあいだに何かが起きた
  server: (<>
    <path d="M5 7.2v9.6M19 7.2v9.6" /><path d="M5 12h14" />
    <circle cx="12" cy="12" r="2.6" fill="#0c1018" strokeWidth="1.5" />
  </>),
  // 実行SQL：絞り込み。書類ではなく、漏斗
  sql: <path d="M3.9 5.4h16.2l-6.2 7.3v6.1l-3.8 1.8v-7.9z" />,
  // テーブル：格子
  table: (<>
    <rect x="3" y="4.2" width="18" height="15.6" rx="2.2" />
    <path d="M3 9.2h18M9 9.2v10.6M15 9.2v10.6" />
  </>),
  // カラム：同じ格子の、1列だけ
  column: (<>
    <rect x="3" y="4.2" width="18" height="15.6" rx="2.2" />
    <rect x="9" y="9.2" width="6" height="10.6" fill="rgba(157,147,224,.32)" stroke="none" />
    <path d="M3 9.2h18M9 9.2v10.6M15 9.2v10.6" />
  </>),
};

export function Glyph({ kind, cx, cy, w, dim }: {
  kind: NodeKind; cx: number; cy: number; w: number; dim?: boolean;
}) {
  const g = G[kind];
  if (!g) return null;
  const sc = w * 0.0194;
  return (
    <g transform={`translate(${cx - 12 * sc},${cy - 12 * sc}) scale(${sc})`}
      fill="none" stroke={dim ? '#39415a' : '#c6bef5'} strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      {g}
    </g>
  );
}

/** コンポーネント（概念モジュール）の記号 */
export function ReactGlyph({ cx, cy, w }: { cx: number; cy: number; w: number }) {
  const sc = w * 0.0152;
  return (
    <g transform={`translate(${cx},${cy}) scale(${sc})`} fill="none" stroke="#c6bef5"
      strokeWidth="1.6" strokeLinecap="round">
      <circle cx="0" cy="0" r="2.5" fill="#c6bef5" stroke="none" />
      <ellipse cx="0" cy="0" rx="10.6" ry="4.0" />
      <ellipse cx="0" cy="0" rx="10.6" ry="4.0" transform="rotate(60)" />
      <ellipse cx="0" cy="0" rx="10.6" ry="4.0" transform="rotate(-60)" />
    </g>
  );
}
