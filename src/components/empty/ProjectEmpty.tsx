'use client';
/* =============================================================================
 * Phase 7C-3（P1-9）: 実プロジェクトを開いている間の「まだ経路が無い」状態。
 *
 *   ProjectBridge    RuntimeStore の観測結果（状態・検出結果）を ExploreStore に渡す
 *   CanvasEmpty      キャンバスの空の状態（短い見出しと次の操作）
 *   DockEmpty        右ドックの空の状態（03d 1.1節の4要素）
 *   DemoBanner       プロジェクトを開いたまま合成デモを明示的に選んだときの、はっきりした注記
 *
 * 合成デモ（別のアプリの見本）は、利用者が［合成デモを見る］を押したとき・URL の ?data= で
 * 選んだときだけ描く。観測・関係モデルには触れない。
 * ========================================================================== */
import { useEffect, useRef } from 'react';
import { useExplore } from '@/state/ExploreStore';
import { useRuntime } from '@/state/RuntimeStore';
import { emptyCard, projectPhaseOf, type ProjectContext, type ProjectPhase } from '@/lib/projectPhase';

export function ProjectBridge() {
  const { runtime, inspection } = useRuntime();
  const { setProject } = useExplore();
  const hasProject = !!inspection || !!runtime?.project;
  const phase = projectPhaseOf(runtime?.state, hasProject);
  const name = runtime?.project?.name ?? inspection?.name ?? null;
  const blocked = !!inspection && (inspection.verdict === 'unsupported' || inspection.verdict === 'invalid');

  /* 停止・失敗を見た後の起動を「起動し直し」と呼ぶ（前の起動の経路を出さないことを言うため） */
  const prevPhase = useRef<ProjectPhase | null>(null);
  const restartedRef = useRef(false);
  if (phase !== prevPhase.current) {
    const prev = prevPhase.current;
    if (phase === 'starting' && (prev === 'stopped' || prev === 'error' || prev === 'stopping')) restartedRef.current = true;
    if (phase === 'opened' || phase === null) restartedRef.current = false;
    prevPhase.current = phase;
  }
  const restarted = restartedRef.current;

  useEffect(() => {
    setProject(phase ? { phase, name, restarted, blocked } : null);
  }, [phase, name, restarted, blocked, setProject]);
  return null;
}

function DemoButton({ label = '合成デモを見る' }: { label?: string }) {
  const { setDemoChosen } = useExplore();
  return (
    <button type="button" className="rt-b ghost pe-demo" onClick={() => setDemoChosen(true)}
      title="別のアプリ（架空の物件一覧）の合成データで、画面の見方を確かめられます。あなたのプロジェクトのデータではありません">
      {label}
    </button>
  );
}

export function CanvasEmpty() {
  const { placeholder, live } = useExplore();
  if (!placeholder || live) return null;
  const c = emptyCard(placeholder);
  return (
    <div className="cv-empty" role="status" aria-live="polite" data-project-phase={placeholder.phase}
      onPointerDown={(e) => e.stopPropagation()}>
      <b>{c.head}</b>
      <p>{c.next}</p>
      <p className="pe-demo-line">
        画面の見方だけを先に確かめたいときは <DemoButton />（別のアプリの見本です）
      </p>
    </div>
  );
}

export function DockEmpty({ p }: { p: ProjectContext }) {
  const c = emptyCard(p);
  return (
    <section className="sum ov pe" aria-label="プロジェクトの状態" data-project-phase={p.phase}>
      <div className="k">プロジェクトの状態</div>
      <div className="claim"><span className="pe-head">{c.head}</span></div>
      <dl className="pe-rows">
        <dt>いまの状態</dt><dd>{c.why}</dd>
        <dt>まだ分からないこと</dt><dd>{c.unknown}</dd>
        <dt>次にすること</dt><dd className="pe-next">{c.next}</dd>
      </dl>
      <p className="hint">
        ここには、あなたのプロジェクトで観測した経路だけを描きます。別のアプリの見本（合成デモ）は、
        選んだときだけ表示します。<DemoButton />
      </p>
    </section>
  );
}

/** プロジェクトを開いたまま合成デモを見ているとき。見本であることと、戻る操作をはっきり出す */
export function DemoBanner() {
  const { project, demoChosen, setDemoChosen, live } = useExplore();
  if (!project || !demoChosen || live) return null;
  return (
    <div className="note demo-banner" role="status" style={{ right: 16, bottom: 46 }}
      onPointerDown={(e) => e.stopPropagation()}>
      <b>合成デモを表示中</b> — 別のアプリの見本です。{project.name ? `「${project.name}」` : 'あなたのプロジェクト'}のデータではありません。
      <button type="button" className="rt-b" onClick={() => setDemoChosen(false)}>デモを閉じる</button>
    </div>
  );
}
