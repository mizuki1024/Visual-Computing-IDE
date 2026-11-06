'use client';
/* =============================================================================
 * 探索画面（S-04）。1600×1000 で基準画像と同じ構図になる。
 *   N0 48px / 観測キャンバス（上にパネルが浮かぶ）/ 右の詳細ドック 360px（固定）
 * 左アイコンレールは置かない（02b 決定1）。ページ一覧は固定サイドバーに戻さない。
 * ========================================================================== */
import GlobalBar from './GlobalBar';
import Canvas from './canvas/Canvas';
import HoverCard from './canvas/HoverCard';
import PagesPanel from './panels/PagesPanel';
import PreviewPanel from './panels/PreviewPanel';
import LegendPanel from './panels/LegendPanel';
import MinimapPanel from './panels/MinimapPanel';
import CanvasControls from './panels/CanvasControls';
import RuntimePanel from './panels/RuntimePanel';
import DetailDock from './dock/DetailDock';
import EditSyncDevPanel from './edit/EditSyncDevPanel';
import { useExplore } from '@/state/ExploreStore';
import { RuntimeProvider } from '@/state/RuntimeStore';
import { CanvasEmpty, DemoBanner, ProjectBridge } from './empty/ProjectEmpty';

export default function AppShell() {
  const { data, placeholder, live } = useExplore();
  return (
    <RuntimeProvider>
      {/* 7C-3: プロジェクトの状態を探索の状態へ渡す（合成デモを出すかを決める） */}
      <ProjectBridge />
      <div className="app">
        <GlobalBar />
        <div className="stage">
          <Canvas>
            <PagesPanel />
            <PreviewPanel />
            <LegendPanel />
            <MinimapPanel />
            <CanvasControls />
            {/* Phase 7A。プロジェクトの指定と開発サーバーの起動・停止 */}
            <RuntimePanel />
            {/* 7C-3（P1-9）: プロジェクトを開いている間、合成デモの代わりに出す空の状態 */}
            <CanvasEmpty />
            <DemoBanner />
            {/* E2.1: 編集の同期の開発用の表示（VCIDE_EDIT_SYNC_DEV=1 かつ ?editSyncDev=1 のときだけ。それ以外は何も描かず要求も出さない） */}
            <EditSyncDevPanel />
            {/*
              データの出所を常時表示する（表示規則11）。
              合成なら「合成データ」と言い、実測なら計装方式を言う。文言はデータが持つ。
            */}
            <div className={`note synth${data.origin === 'measured' ? ' measured' : ''}`}
              data-notice={live ? 'live' : placeholder ? 'project-empty' : data.origin}
              style={{ right: 16, bottom: 14 }}
              onPointerDown={(e) => e.stopPropagation()}>
              {data.notice}
            </div>
          </Canvas>
          <DetailDock />
        </div>
        <HoverCard />
      </div>
    </RuntimeProvider>
  );
}
