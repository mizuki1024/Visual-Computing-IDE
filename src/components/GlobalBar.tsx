'use client';
/* =============================================================================
 * N0 グローバルバー。構成は 02b 2.3節で確定している。
 *   プロジェクト / 対応範囲 / 環境（Local 固定）/ 実行状態 / 計装状態
 * 検索は置かない（02b の N0 構成に無い）。
 * モードタブは 探索／データ／実行／編集（準備中）の 3+1。
 *
 * Phase 7A で、実行状態と計装状態を**実際のプロセスの観測結果**に差し替えた。
 * プロジェクトを指定していない間は、描いているデータセットが記録している
 * 実行環境を出す（記録の内容であることが分かるように書く）。ST-26 により
 * 計装の状態は常時出す。
 * ========================================================================== */
import { useExplore } from '@/state/ExploreStore';
import { RUN_STATE_LABEL, useRuntime } from '@/state/RuntimeStore';
import Why from './common/Why';

/** 状態ごとの点の色。緑＝応答を確認できている、だけに使う。 */
const DOT: Record<string, string> = {
  running: 'var(--green)', starting: 'var(--amber)', validating: 'var(--amber)',
  stopping: 'var(--amber)', error: '#c47d6e', stopped: 'var(--tx4)', idle: 'var(--tx4)',
};

export default function GlobalBar() {
  const { data, placeholder, live: liveSel } = useExplore();
  /* 7C-3: プロジェクトの空の状態では、経路が無い。「切断なし」と言わない */
  const noPath = !!placeholder && !liveSel;
  const { runtime, inspection } = useRuntime();
  const cuts = data.cuts;
  // 実測の状態を出すのは、IDE が実際に何かを掴んでいるときだけ
  const live = runtime && runtime.state !== 'idle' ? runtime : null;
  const projectName = live?.project?.name ?? inspection?.name ?? null;

  return (
    <header className="n0">
      <div className="mark" aria-hidden>◧</div>
      <div className="brand">GRiDDATA</div>
      <Why reason={projectName
        ? `指定されたプロジェクト: ${live?.project?.root ?? inspection?.root ?? ''}`
        : 'プロジェクトは未指定です。右の「プロジェクトと実行」から指定します。'}
        detail={projectName ? undefined : '指定しない間は、描いているデータセットの名前を出しています。'}>
        <div className="proj" title="プロジェクト">{projectName ?? data.project}</div>
      </Why>

      <nav className="tabs" aria-label="モード">
        <span className="tab on" aria-current="page">探索</span>
        <Why reason="Phase 5A では探索モードだけを実装しています。"
          detail="データモードは別の画面（S-05 / S-06）として設計済みです。">
          <span className="tab off" aria-disabled="true">データ</span>
        </Why>
        <Why reason="Phase 5A では探索モードだけを実装しています。"
          detail="実行モードは別の画面として設計済みです。">
          <span className="tab off" aria-disabled="true">実行</span>
        </Why>
        <Why reason="編集モードは未実装です（B群）。押してもモードは変わりません。"
          detail="席だけを置いているのは、編集という概念そのものが無いと誤解されないためです。">
          <span className="tab off" aria-disabled="true">編集<s className="soon">準備中</s></span>
        </Why>
      </nav>

      {/*
        * 件数は追跡できなかった箇所の一覧から算出する（定数を持たない）。
        *
        * **切断が 0 件の経路がありうる**（PoC-04 で初めて出た。由来を推定で
        * 結べた場合である）。そのとき「部分対応・0件」は意味を成さないし、
        * 「全対応」と書くのは嘘である — 切断が無いことは「全部実測できた」を
        * 意味しない。推定の関係が残っていれば、確からしさは最弱環が決める
        * （OBS-10）。文言はそこに踏み込まない。
        */}
      <Why reason={noPath
        ? 'まだ経路がありません。値を選ぶと、その経路の対応範囲をここに出します。'
        : cuts.length
        ? `追跡できなかった箇所が ${cuts.length} 件あります：${cuts[0].kind}`
        : 'この経路には、追跡できなかった箇所がありません。'}
        detail={noPath ? undefined : cuts.length
          ? cuts.map((c) => c.where).join(' / ')
          : '切断が無いことは「全部実測できた」ことを意味しません。'
            + '推定の関係が残っている場合、経路全体の確からしさはいちばん弱いところが決めます。'}>
        <div className="sup">
          <span aria-hidden>◬</span> 対応範囲{' '}
          <b>{noPath ? '経路なし' : cuts.length ? `部分対応・${cuts.length}件` : '切断なし'}</b>
        </div>
      </Why>

      <div className="sp" />

      <Why align="r" reason="ローカル環境のみ対応しています。環境は選択できません。"
        detail="リモート環境への接続は A群の対象外です（02b 3.1節）。">
        <div className="chipbar" aria-disabled="true">環境 <b>Local</b> <span className="lock">固定</span></div>
      </Why>

      {live
        ? (
          <>
            <Why align="r"
              reason={`開発サーバーの状態: ${RUN_STATE_LABEL[live.state]}`}
              detail={live.lastProbe
                ? (live.lastProbe.ok
                  ? `HTTP の応答を確認しています（${live.lastProbe.status}）。`
                  : `HTTP の応答はありません（${live.lastProbe.detail ?? '理由を特定できません'}）。`)
                : 'HTTP の応答はまだ確認していません。'}>
              <div className="chipbar">
                <span className="dot" style={{ background: DOT[live.state] ?? 'var(--tx4)' }} />
                {RUN_STATE_LABEL[live.state]}
                {live.pid && <code>PID {live.pid}</code>}
                {live.port && <span className="port">:{live.port}</span>}
              </div>
            </Why>
            <Why align="r" reason={live.instrumentation.state === 'enabled'
              ? '計装が有効です（PoC-01 方式2）。対象プロジェクトにはファイルを置いていません。'
              : live.instrumentation.state === 'unavailable'
                ? '計装を適用できません。「失敗」とは別の状態です（ST-25）。'
                : '計装なしで起動しています。'}
              detail={live.instrumentation.reason ?? undefined}>
              <div className={`chipbar ins${live.instrumentation.state === 'enabled' ? '' : ' na'}`}>
                <span className="dot"
                  style={{ background: live.instrumentation.state === 'enabled' ? 'var(--green)' : 'var(--tx4)' }} />
                計装 {live.instrumentation.state === 'enabled' ? '有効'
                  : live.instrumentation.state === 'unavailable' ? '適用不可' : 'なし'}
              </div>
            </Why>
          </>
        )
        : placeholder
        ? (
          /* 7C-3: プロジェクトを開いて、まだ起動していない。データセットの記録（合成デモの実行環境）を出さない */
          <Why align="r" reason="開発サーバーはまだ起動していません。"
            detail="右の「プロジェクトと実行」で［起動］を押すと、ここに状態が出ます。">
            <div className="chipbar" aria-disabled="true" data-runtime-chip="not-started">
              <span className="dot" style={{ background: 'var(--tx4)' }} />
              開発サーバー 未起動
            </div>
          </Why>
        )
        : (
          <>
            <Why align="r" reason="これは描いているデータセットが記録している実行環境です。"
              detail="いま IDE が起動している開発サーバーはありません。右の「プロジェクトと実行」から指定します。">
              <div className="chipbar" aria-disabled="true">
                <span className="dot" style={{ background: 'var(--tx4)' }} />
                記録 <code>{data.runtime.command}</code>
                <span className="port">:{data.runtime.port}</span>
              </div>
            </Why>
            <Why align="r" reason="これは描いているデータセットが記録している計装の状態です。"
              detail="いま IDE が起動している開発サーバーはありません。">
              <div className="chipbar ins na">
                <span className="dot" style={{ background: 'var(--tx4)' }} />
                計装 {data.runtime.instrumentation}<span className="lock">記録</span>
              </div>
            </Why>
          </>
        )}
    </header>
  );
}
