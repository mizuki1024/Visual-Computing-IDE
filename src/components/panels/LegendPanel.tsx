'use client';
/* 表示設定（凡例）。線の形だけで判別できること。色は補助である（NFR-30）。 */
import { useExplore } from '@/state/ExploreStore';
import FloatingPanel from './FloatingPanel';
import { LEFT_COLUMN_BOTTOM } from './MinimapPanel';

const ROWS: [React.ReactNode, React.ReactNode][] = [
  [<svg key="a" width="34" height="13" aria-hidden>
    <path d="M1,7 H25" stroke="#8aa4cc" strokeWidth="2" />
    <path d="M24,3.5 L31,7 L24,10.5" fill="none" stroke="#8aa4cc" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>, '実測された関係'],
  [<svg key="b" width="34" height="13" aria-hidden>
    <path d="M1,7 H25" stroke="#9a8fc4" strokeWidth="2" strokeDasharray="6 5" />
    <path d="M24,3.5 L31,7 L24,10.5" fill="none" stroke="#9a8fc4" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>, '推定の関係'],
  [<svg key="c" width="34" height="15" viewBox="0 0 34 15" aria-hidden>
    <rect x="3" y="1" width="28" height="13" rx="4.5" fill="#0d1019" stroke="#6f66a8" strokeDasharray="4 3" />
    <text x="17" y="11" textAnchor="middle" fontSize="9.5" fill="#cfc6f5">★</text>
  </svg>, 'いちばん弱いところ'],
  [<svg key="d" width="34" height="15" viewBox="0 0 34 15" aria-hidden>
    <path d="M10,2 V13" stroke="#c2a06e" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M16,3 L25,12 M25,3 L16,12" stroke="#c2a06e" strokeWidth="1.6" strokeLinecap="round" />
  </svg>, '追跡できません'],
  [<svg key="e" width="34" height="15" viewBox="0 0 34 15" aria-hidden>
    <rect x="4" y="2" width="12" height="11" rx="3" fill="#0b0f18" stroke="#2a3142" />
    <path d="M19,8 H31" stroke="#283043" strokeWidth="1.4" />
  // 「経路外」は選択がある前提の言い方。減光の理由そのもの（詳細を持っていない）で書く
  </svg>, <>詳細が未取得の通信 <i>（減光して残す）</i></>],
];

export default function LegendPanel() {
  const { showLabels, setShowLabels, viewport } = useExplore();
  // 7C-2: 設計寸法（キャンバスの高さ 952）より低い窓では、下端から積む（1440×900 で「全体」が画面外に出ていた）
  const pos = viewport.h >= 952 ? { top: 566 } : { bottom: LEFT_COLUMN_BOTTOM.legend };
  return (
    <FloatingPanel id="legend" title="表示設定" style={{ left: 16, width: 236, ...pos }}>
      <div className="lgb">
        {ROWS.map(([icon, text], i) => (
          <div key={i} style={{ display: 'contents' }}>
            <u>{icon}</u><span className="lt">{text}</span>
          </div>
        ))}
        <div className="lgsep" />
        <button type="button" className={`tg${showLabels ? '' : ' off'}`}
          aria-pressed={showLabels} onClick={() => setShowLabels(!showLabels)}>
          ラベルを表示<span aria-hidden />
        </button>
      </div>
    </FloatingPanel>
  );
}
