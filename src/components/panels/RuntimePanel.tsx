'use client';
/* =============================================================================
 * プロジェクトの選択と開発サーバーの起動・停止（Phase 7A）。
 *
 * Phase 5 で確定した浮かぶパネルの枠（FloatingPanel）に載せるだけで、
 * 新しい画面も新しいデザインも作っていない（指示 第4節）。
 *
 * 表示の規則
 *   - 状態は観測結果だけを書く。「起動を指示した」を「実行中」と書かない
 *   - 失敗は 03d 1.1節の4要素（事実 / 理由 / わからないこと / 次の操作）で書く
 *   - 押せないボタンには、押せない理由を添える（IX-23 / IX-24）
 * ========================================================================== */
import { useEffect, useState } from 'react';
import FloatingPanel from './FloatingPanel';
import Why from '../common/Why';
import { RUN_STATE_LABEL, useRuntime, type Finding } from '@/state/RuntimeStore';

const VERDICT_LABEL = {
  supported: '対応',
  partial: '部分対応',
  unsupported: '未対応',
  invalid: '指定が不正',
} as const;

const INS_LABEL = {
  enabled: '有効', disabled: 'なし（選択）', unavailable: '適用不可',
} as const;

/** 03d 1.1節の4要素をそのまま出す。③ は省略しない。 */
function FindingCard({ f }: { f: Finding }) {
  return (
    <div className={`rt-card ${f.severity}`}>
      <b>{f.fact}</b>
      <p>{f.reason}</p>
      <p className="imp">{f.impact}</p>
      {f.action && <p className="act">{f.action}</p>}
    </div>
  );
}

/** 起動を始めてからの経過秒。起動中だけ1秒ごとに進める（IDE の待ちが平坦に見えないように） */
function useElapsedSec(since: string | null, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active || !since) return null;
  return Math.max(0, Math.round((now - Date.parse(since)) / 1000));
}

export default function RuntimePanel() {
  const {
    pathInput, setPathInput, portInput, setPortInput, instrument, setInstrument,
    runtime, inspection, logs, pending, apiError, inspect, start, stop, preview,
  } = useRuntime();
  /** このブラウザが IDE に転送 URL で来ているか（中継の URL がループバックでない） */
  const viaForwarding = !!preview?.origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(preview.origin);
  const [showLog, setShowLog] = useState(false);

  const state = runtime?.state ?? 'idle';
  const elapsed = useElapsedSec(runtime?.startedAt ?? null, state === 'starting');
  const busy = pending !== null || state === 'starting' || state === 'stopping' || state === 'validating';
  const startable = !!inspection
    && (inspection.verdict === 'supported' || inspection.verdict === 'partial');
  /** 表示している検出結果が、いま入力されているパスのものか。違えば起動させない */
  const inputMatches = !!inspection && inspection.input.trim() === pathInput.trim();
  const canStart = startable && inputMatches && !busy && state !== 'running';
  const canStop = !!runtime?.pid && !busy && (state === 'running' || state === 'error');

  const startWhy = !inspection ? 'まず［検出］でプロジェクトの構成を確認してください。'
    : !inputMatches ? '入力したパスはまだ検出していません。［検出］を押してください。'
    : !startable ? 'この構成は対応範囲外です。理由は下の所見に出ています。'
      : state === 'running' ? '既に実行中です。二重には起動しません。'
        : busy ? '処理中です。完了するまで待ってください。' : '';

  return (
    <FloatingPanel id="runtime" title="プロジェクトと実行" note="Phase 7A"
      style={{ right: 16, top: 62, width: 330 }}>
      <div className="rt">
        {/* ------------------------------------------------ プロジェクトの指定 */}
        <label className="rt-lbl" htmlFor="rt-path">プロジェクトのパス（絶対パス）</label>
        <div className="rt-row">
          <input id="rt-path" className="rt-in" value={pathInput} spellCheck={false}
            placeholder="/Users/you/your-next-app"
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void inspect(); }} />
          <button type="button" className="rt-b" disabled={busy || !pathInput.trim()}
            onClick={() => void inspect()}>
            {pending === 'inspect' ? '検出中…' : '検出'}
          </button>
        </div>
        <p className="rt-note">
          ブラウザからフォルダ選択ダイアログは開けません。パスを入力する方式です。
        </p>

        {/* ------------------------------------------------------ 検出した構成 */}
        {inspection && (
          <div className="rt-ins" data-input={inspection.input} data-verdict={inspection.verdict}
            data-checked-at={inspection.checkedAt}>
            <div className="rt-head">
              <span className={`rt-vd ${inspection.verdict}`}>{VERDICT_LABEL[inspection.verdict]}</span>
              <b>{inspection.name ?? '—'}</b>
            </div>
            <dl className="rt-dl">
              <dt>ルート</dt><dd>{inspection.root ?? '—'}</dd>
              <dt>Next.js</dt>
              <dd>{inspection.next.installed ?? '—'}
                {inspection.next.declared && <i> （宣言 {inspection.next.declared}）</i>}</dd>
              <dt>ルーター</dt>
              <dd>{inspection.router.appDir ?? '—'}
                {inspection.router.pagesDir && <i> ＋ {inspection.router.pagesDir}</i>}</dd>
              <dt>依存</dt>
              <dd>{inspection.nodeModulesInstalled ? 'インストール済み' : '未インストール'}
                {inspection.packageManager && <i> （{inspection.packageManager}）</i>}</dd>
            </dl>
            {inspection.findings.map((f) => <FindingCard key={f.code} f={f} />)}
          </div>
        )}

        {/* ------------------------------------------------------------ 起動 */}
        <div className="rt-row rt-opt">
          <label className="rt-lbl2" htmlFor="rt-port">ポート</label>
          <input id="rt-port" className="rt-in rt-port" value={portInput} inputMode="numeric"
            placeholder="自動" onChange={(e) => setPortInput(e.target.value.replace(/[^0-9]/g, ''))} />
          <Why reason="PoC-01 方式2（NODE_OPTIONS の前置）で計装します。対象プロジェクトにはファイルを置きません。"
            detail="使えない場合は「適用不可」と表示します。計装なしでも起動と停止は行えます。">
            <label className={`rt-ck${instrument ? ' on' : ''}`}>
              <input type="checkbox" checked={instrument}
                onChange={(e) => setInstrument(e.target.checked)} />
              計装つき
            </label>
          </Why>
        </div>

        <div className="rt-row rt-act">
          {canStart
            ? (
              <button type="button" className="rt-b go" onClick={() => void start()}>
                {pending === 'start' ? '起動中…' : '起動する'}
              </button>
            )
            : (
              <Why reason={startWhy || '起動できません。'}>
                <span className="rt-b go off" aria-disabled="true">起動する</span>
              </Why>
            )}
          {canStop
            ? (
              <button type="button" className="rt-b" onClick={() => void stop()}>
                {pending === 'stop' ? '停止中…' : '停止する'}
              </button>
            )
            : (
              <Why reason={runtime?.pid ? '処理中です。' : 'IDE が起動した開発サーバーはありません。'}>
                <span className="rt-b off" aria-disabled="true">停止する</span>
              </Why>
            )}
        </div>

        {/* -------------------------------------------------------- 実行状態 */}
        <div className={`rt-st ${state}`} aria-live="polite">
          <span className="rt-dot" />
          <b>{RUN_STATE_LABEL[state]}</b>
          {runtime?.pid && <span className="rt-k">PID {runtime.pid}</span>}
          {runtime?.port && <span className="rt-k">:{runtime.port}</span>}
          {runtime?.readyMs !== null && runtime?.readyMs !== undefined && state === 'running'
            && <span className="rt-k">{runtime.readyMs} ms</span>}
          {elapsed !== null && <span className="rt-k">{elapsed} 秒</span>}
        </div>
        {state === 'starting' && (
          <p className="rt-note rt-prog">
            {runtime?.progress
              ? <>Next.js の出力: <code>{runtime.progress.line}</code></>
              : 'Next.js の出力はまだありません。'}
            {' '}HTTP の応答を確認するまで「実行中」にはしません。
          </p>
        )}
        {runtime && (
          <dl className="rt-dl rt-run">
            <dt>起動元</dt>
            <dd>{runtime.owner === 'ide' ? 'IDE'
              : runtime.owner === 'ide-previous-session' ? 'IDE（前のセッションから引き継ぎ）'
                : runtime.owner === 'external' ? '外部' : '—'}</dd>
            <dt>計装</dt>
            <dd>{INS_LABEL[runtime.instrumentation.state]}
              {runtime.instrumentation.reason && <i> — {runtime.instrumentation.reason}</i>}</dd>
            <dt>HTTP</dt>
            <dd>{runtime.lastProbe
              ? (runtime.lastProbe.ok
                ? `応答あり（${runtime.lastProbe.status}） ${runtime.lastProbe.at.slice(11, 19)}`
                : `応答なし — ${runtime.lastProbe.detail ?? '理由を特定できません'}`)
              : '未確認'}</dd>
            {runtime.env && (
              <>
                <dt>環境変数</dt>
                <dd className="rt-env" title={`渡した変数: ${runtime.env.passed.join(', ')}`}>
                  {runtime.env.passed.length} 個を渡しました
                  <i> （他の {runtime.env.withheld} 個は渡していません）</i>
                </dd>
              </>
            )}
            {runtime.url && state === 'running' && (
              <>
                <dt>URL</dt>
                {/* クラウドの転送 URL で開いているとき、サーバー側の 127.0.0.1 はこのブラウザから届かない。押せる見た目にしない */}
                {viaForwarding
                  ? <dd>{runtime.url}<i> （サーバー側。表示はプレビューから）</i></dd>
                  : <dd><a className="rt-a" href={runtime.url} target="_blank" rel="noreferrer">{runtime.url}</a></dd>}
              </>
            )}
          </dl>
        )}

        {runtime?.error && <FindingCard f={runtime.error} />}
        {runtime?.targetChanges && <FindingCard f={runtime.targetChanges} />}
        {apiError && (
          <div className="rt-card blocker">
            <b>IDE の API に届きませんでした。</b>
            <p>{apiError}</p>
            <p className="imp">実行状態を確認できません。表示は最後に取得できた内容です。</p>
          </div>
        )}

        {/* ------------------------------------------------------ 出力の確認 */}
        <button type="button" className="rt-more" aria-expanded={showLog}
          onClick={() => setShowLog(!showLog)}>
          {showLog ? '▾' : '▸'} 標準出力・エラー出力
          {logs && <i>{logs.available ? `${logs.total} 行` : '保持していません'}</i>}
        </button>
        {showLog && (
          <div className="rt-log">
            {logs?.available && logs.lines.length
              ? logs.lines.map((l, i) => <div key={i}>{l}</div>)
              : (
                <div className="rt-log-none">
                  {logs?.available
                    ? '出力はまだありません。'
                    : 'このプロセスの出力は保持していません（IDE の外、または前のセッションで起動されたためです）。'}
                </div>
              )}
          </div>
        )}
      </div>
    </FloatingPanel>
  );
}
