'use client';
/* =============================================================================
 * 実プレビュー（Phase 7B-1）。既存のプレビューパネル（同じ FloatingPanel・同じ位置と幅・
 * 同じ .pvb / .site / .pvfoot）の中身を、IDE が起動した開発サーバーのページに差し替える。
 * 新しい画面は作らない。
 *
 * 表示の規則
 *   - 開発サーバーの状態は RuntimeStore の観測結果だけを使う。iframe は `running` のときだけ置く
 *   - iframe の URL は **サーバーが返した中継の origin**（このブラウザから見た URL）と、パスだけで組む。
 *     開発サーバーの URL（127.0.0.1:3000）は使わない — クラウドではブラウザから届かない
 *   - 中継に届くかを先に確かめる（ping）。届かなければ iframe を置かず、理由を出す
 *   - HTTP の状態はページの中の小さなスクリプト（中継が差し込む）が知らせる。
 *     知らせが無いページ（HTML 以外の応答など）では、わからないと書く
 * ========================================================================== */
import { useCallback, useEffect, useRef, useState } from 'react';
import FloatingPanel from './FloatingPanel';
import Why from '../common/Why';
import { RUN_STATE_LABEL, useRuntime, type Finding } from '@/state/RuntimeStore';

/** 中継のスクリプトが送る知らせ（previewGateway.ts の AGENT_JS） */
interface AgentMsg {
  source: 'vcide-preview'; v: 1; kind: string; path: string; title: string;
  status: number | null; soft: boolean; from: 'app' | 'gateway';
}

type View = 'starting' | 'stopping' | 'stopped' | 'error' | 'unavailable' | 'checking' | 'unreachable' | 'live';

const PING_TIMEOUT_MS = 5000;
/** iframe の load から、知らせを待つ時間 */
const AGENT_WAIT_MS = 2500;

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

async function ping(origin: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const ac = new AbortController();
  const t = window.setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
  try {
    const r = await fetch(`${origin}/__vcide_preview/ping`, { mode: 'cors', cache: 'no-store', signal: ac.signal });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    const j = await r.json() as { ok?: boolean };
    return j.ok ? { ok: true } : { ok: false, detail: '応答の形が違います' };
  } catch (e) {
    return { ok: false, detail: ac.signal.aborted ? `${PING_TIMEOUT_MS / 1000} 秒以内に応答がありません` : (e instanceof Error ? e.message : String(e)) };
  } finally {
    window.clearTimeout(t);
  }
}

/** 入力をパスに直す。別の origin への移動は受け付けない（中継の外へ出さない） */
function toPath(input: string): string | null {
  const v = input.trim();
  if (!v) return '/';
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) return null;
  return v.startsWith('/') ? v : `/${v}`;
}

function statusLabel(m: AgentMsg | null): { text: string; bad: boolean } {
  if (!m) return { text: '', bad: false };
  if (m.from === 'gateway') return { text: `IDE の中継が返した説明（HTTP ${m.status}）`, bad: true };
  if (m.soft || m.status === null) return { text: 'ページ内の遷移（HTTP の状態は観測していません）', bad: false };
  if (m.status === 404) return { text: 'HTTP 404 — ページが見つかりません（開発サーバーの応答）', bad: true };
  if (m.status >= 500) return { text: `HTTP ${m.status} — 開発サーバーがエラーを返しました`, bad: true };
  if (m.status >= 400) return { text: `HTTP ${m.status}（開発サーバーの応答）`, bad: true };
  return { text: `HTTP ${m.status}`, bad: false };
}

/**
 * 実プレビューを出すか。起動・実行・停止の最中は常に出す。停止・失敗の後は、
 * この画面で起動を観測したときだけ出す（開き直した画面では、従来の見本に戻る）。
 */
export function wantsLivePreview(
  runtime: { state: string; error: unknown } | null, liveSeen: boolean,
): boolean {
  const s = runtime?.state ?? 'idle';
  if (s === 'starting' || s === 'running' || s === 'stopping') return true;
  return liveSeen && (s !== 'idle' || !!runtime?.error);
}

export default function LivePreview() {
  const { runtime, preview } = useRuntime();
  const state = runtime?.state ?? 'idle';
  const origin = preview?.origin ?? null;
  const running = state === 'running';

  /* ------------------------------------------------- 中継に届くかを確かめる */
  const [reach, setReach] = useState<{ origin: string; ok: boolean; detail: string | null } | null>(null);
  const [checkN, setCheckN] = useState(0);
  useEffect(() => {
    if (!running || !origin) return undefined;
    let alive = true;
    void ping(origin).then((r) => {
      if (alive) setReach({ origin, ok: r.ok, detail: r.ok ? null : r.detail });
    });
    return () => { alive = false; };
  }, [running, origin, checkN, runtime?.instance, runtime?.pid]);

  /* --------------------------------------------------------- 表示する場所 */
  const [nav, setNav] = useState<{ path: string; n: number }>({ path: '/', n: 0 });
  const [addr, setAddr] = useState('/');
  const [addrError, setAddrError] = useState<string | null>(null);
  const [msg, setMsg] = useState<AgentMsg | null>(null);
  const [loads, setLoads] = useState(0);
  const [silent, setSilent] = useState(false);
  const editingRef = useRef(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** いまの文書から「準備できた」の知らせが来たか。iframe の load ごとに見て戻す */
  const readyRef = useRef(false);

  // 開発サーバーが入れ替わったら（再起動・別のプロジェクト）、最初のページから始める
  const serverKey = running ? `${runtime?.instance}:${runtime?.pid}:${runtime?.port}` : null;
  useEffect(() => {
    if (!serverKey) return;
    setNav((v) => ({ path: '/', n: v.n + 1 }));
    setAddr('/'); setMsg(null); setSilent(false); setAddrError(null);
  }, [serverKey]);

  /* 中継のスクリプトからの知らせ。**送り主を確かめる**（中継の origin で、この iframe から） */
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!origin || e.origin !== origin) return;
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as Partial<AgentMsg> | null;
      if (!d || d.source !== 'vcide-preview' || typeof d.path !== 'string') return;
      const m = d as AgentMsg;
      setSilent(false);
      setMsg(m);
      if (m.kind === 'ready') { readyRef.current = true; setLoads((n) => n + 1); }
      if (!editingRef.current) setAddr(m.path);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [origin]);

  const onFrameLoad = useCallback(() => {
    // 知らせは文書の DOMContentLoaded で来るので、load より先に届いている。
    // 来ていなければ、HTML 以外の応答か、中継に届いていない（ブラウザのエラーページ）
    if (readyRef.current) { readyRef.current = false; return; }
    window.setTimeout(() => {
      if (readyRef.current) return;
      setMsg(null);
      setSilent(true);
      setCheckN((n) => n + 1);         // 中継に届くかを確かめ直す
    }, AGENT_WAIT_MS);
  }, []);

  const go = (path: string) => {
    readyRef.current = false;
    setSilent(false);
    setMsg(null);
    setNav((v) => ({ path, n: v.n + 1 }));
  };
  const submit = () => {
    const p = toPath(addr);
    if (p === null) { setAddrError('パス（/ で始まる）を入力してください。プレビューは開発サーバーのページだけを表示します。'); return; }
    setAddrError(null);
    setAddr(p);
    go(p);
  };
  const reload = () => go(msg?.path ?? nav.path);

  /* ------------------------------------------------------------ 表示の種類 */
  let view: View;
  if (state === 'validating' || state === 'starting') view = 'starting';
  else if (state === 'stopping') view = 'stopping';
  else if (state === 'error' || (state !== 'running' && runtime?.error)) view = 'error';
  else if (state === 'stopped' || state === 'idle') view = 'stopped';
  else if (!origin || preview?.error) view = 'unavailable';
  else if (!reach || reach.origin !== origin) view = 'checking';
  else if (!reach.ok) view = 'unreachable';
  else view = 'live';

  const st = statusLabel(msg);
  const canNav = view === 'live';

  return (
    <FloatingPanel id="preview" title="プレビュー" note="開発サーバー"
      style={{ left: 232, top: 16, width: 392 }}>
      <div className="pvb pvlive" data-preview-state={view}
        data-http-status={msg?.status ?? ''} data-from={msg?.from ?? ''}
        data-path={msg?.path ?? ''} data-loads={loads}>
        <div className="rt-row pvbar">
          {canNav
            ? <button type="button" className="rt-b" title="再読み込み" aria-label="再読み込み" onClick={reload}>↻</button>
            : <Why reason="開発サーバーのページを表示しているときだけ使えます。"><span className="rt-b off" aria-disabled="true">↻</span></Why>}
          <input className="rt-in" aria-label="プレビューのパス" value={addr} spellCheck={false}
            disabled={!canNav}
            onFocus={() => { editingRef.current = true; }}
            onBlur={() => { editingRef.current = false; }}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canNav) submit(); }} />
          {canNav
            ? <button type="button" className="rt-b" onClick={submit}>移動</button>
            : <Why reason="開発サーバーのページを表示しているときだけ使えます。"><span className="rt-b off" aria-disabled="true">移動</span></Why>}
        </div>
        {addrError && <p className="rt-note pvwarn">{addrError}</p>}

        {view === 'live' && origin && (
          <div className="site pvsite">
            <iframe key={nav.n} ref={frameRef} className="pvframe" title="開発サーバーのプレビュー"
              src={`${origin}${nav.path}`} onLoad={onFrameLoad}
              // 別 origin なので IDE の画面には触れない。上の階層の移動（IDE の画面の差し替え）は許さない
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads" />
          </div>
        )}
        {(view === 'starting' || view === 'stopping' || view === 'stopped' || view === 'checking') && (
          <div className="site pvsite">
            <p className="pgnone pvmsg">
              {view === 'starting' && <>開発サーバーを起動しています（{RUN_STATE_LABEL[state]}）。HTTP の応答を確認してから表示します。</>}
              {view === 'stopping' && <>開発サーバーを停止しています。プレビューは表示していません。</>}
              {view === 'stopped' && <>開発サーバーは停止しています。プレビューは表示していません。</>}
              {view === 'checking' && <>ブラウザからプレビューの中継に届くかを確かめています…</>}
            </p>
          </div>
        )}
        {view === 'error' && (
          runtime?.error
            ? <FindingCard f={runtime.error} />
            : <div className="rt-card blocker"><b>開発サーバーは起動できていません。</b><p>理由は「プロジェクトと実行」に出ています。</p></div>
        )}
        {view === 'unavailable' && preview?.error && <FindingCard f={preview.error} />}
        {view === 'unreachable' && reach && (
          <>
            <FindingCard f={{
              code: 'preview-unreachable', severity: 'blocker',
              fact: `このブラウザからプレビューの中継（${reach.origin}）に届きませんでした。`,
              reason: `確認の要求が失敗しました（${reach.detail}）。開発サーバーは実行中です（サーバー側で HTTP の応答を確認しています）。`,
              impact: '開発サーバーのページを表示できません。ブラウザとサーバーの間の転送（ポート転送など）が途切れている可能性がありますが、どこで途切れたかはわかりません。',
              action: 'ポートの転送の設定を確認してから、もう一度確かめてください。',
            }} />
            <button type="button" className="rt-b pvretry" onClick={() => setCheckN((n) => n + 1)}>もう一度確かめる</button>
          </>
        )}
      </div>
      <div className="pvfoot">
        {view === 'live'
          ? (msg
            ? <><b className={st.bad ? 'pvbad' : undefined}>{st.text}</b><em className="pvpath">{msg.path}</em></>
            : silent
              ? <em>このページから IDE への知らせがありません（HTML 以外の応答か、読み込みに失敗しました）。HTTP の状態はわかりません</em>
              : <em>読み込み中… {nav.path}</em>)
          : <em>{runtime?.project?.name ?? '—'} — {RUN_STATE_LABEL[state]}</em>}
      </div>
    </FloatingPanel>
  );
}
