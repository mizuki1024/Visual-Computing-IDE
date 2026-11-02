'use client';
/* =============================================================================
 * <DetailDock> 右の詳細パネル。固定・開閉しない。
 * 浮かぶパネルとは視覚的に区別する（角丸なし・影は左向きのみ）。
 * 初期表示は常に「概要」（IX-17）。タブの数と並びは選択対象で変えない（IX-16）。
 * ========================================================================== */
import { useMemo } from 'react';
import { summarize, valueOrigin } from '@/lib/derive';
import { useExplore } from '@/state/ExploreStore';
import PageOverview from './PageOverview';
import PathSummary from './PathSummary';
import WeakestLink from './WeakestLink';
import StepList from './StepList';
import EvidencePanel from './EvidencePanel';
import { DockEmpty } from '../empty/ProjectEmpty';

export default function DetailDock() {
  const { data, tab, setTab, selection, scope, placeholder, live, project, demoChosen, setDemoChosen } = useExplore();
  const s = useMemo(() => summarize(data), [data]);
  const vo = useMemo(() => valueOrigin(data), [data]);

  /* 段階0。空パネルを出すのではなく、このページの概要を出す（ST-16） */
  if (!selection) {
    return (
      <aside className="dock" aria-label="詳細">
        <div className="dh">
          詳細
          <span className="r"><span>ページ</span><span className="pin">固定</span></span>
        </div>
        <div className="dbody">
          {/* 7C-3（P1-9）: プロジェクトを開いている間は、合成デモの概要ではなくプロジェクトの状態を出す */}
          {placeholder && !live ? <DockEmpty p={placeholder} /> : (
            <>
              {project && demoChosen && !live && (
                <p className="dock-demo" role="status">
                  <b>合成デモを表示中です。</b>別のアプリの見本で、{project.name ? `「${project.name}」` : 'あなたのプロジェクト'}のデータではありません。
                  <button type="button" className="rt-b" onClick={() => setDemoChosen(false)}>デモを閉じる</button>
                </p>
              )}
              <PageOverview />
            </>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="dock" aria-label="詳細">
      <div className="dh">
        詳細
        <span className="r">
          <span>{scope === 'path' ? '経路' : 'ページ'}</span>
          <span className="pin">固定</span>
        </span>
      </div>
      <div className="dbody">
        {project && demoChosen && !live && (
          <p className="dock-demo" role="status">
            <b>合成デモを表示中です。</b>別のアプリの見本で、あなたのプロジェクトのデータではありません。
            <button type="button" className="rt-b" onClick={() => setDemoChosen(false)}>デモを閉じる</button>
          </p>
        )}
        <PathSummary s={s} vo={vo} />
        {/* タブは選択したステップのためのもの。選択が無いときは並べない（IX-16） */}
        <div className="dtabs" role="tablist" aria-label="詳細の表示">
          <button type="button" role="tab" aria-selected={tab === 'overview'}
            className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>概要</button>
          <button type="button" role="tab" aria-selected={tab === 'evidence'}
            className={tab === 'evidence' ? 'on' : ''} onClick={() => setTab('evidence')}>根拠</button>
        </div>
        {/*
          ★ブロックは経路サマリの一部であり、タブでは消えない（OBS-11）。
          独立した塊なので、最弱環が無い経路では丸ごと出ない（03 10.4 申し送り1）。
          タブが入れ替えるのは、その下（番号付きリスト ／ 選択した箇所の根拠）だけである。
        */}
        {s.weakest && <WeakestLink hop={s.weakest} />}
        {tab === 'overview' ? <StepList /> : <EvidencePanel selection={selection} />}
      </div>
    </aside>
  );
}
