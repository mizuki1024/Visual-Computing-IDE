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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FloatingPanel from './FloatingPanel';
import Why from '../common/Why';
import { RUN_STATE_LABEL, useRuntime, type Finding } from '@/state/RuntimeStore';
import { useExplore } from '@/state/ExploreStore';
import {
  IDE_SOURCE, PROTOCOL_VERSION, isAgentHello, parseAgentMessage,
  type AgentMessage, type ElementSelection,
} from '@/lib/previewProtocol';
import {
  LIVE_UNRESOLVED_LABEL, fromLiveRun, fromLiveSelection, liveExchangeLabel, liveExchangeLinks,
  type LiveResolution,
} from '@/lib/adapter';
import type { LiveRunObservation } from '@/lib/liveObservation';
import { layout } from '@/lib/layout';

/** 場所の知らせ（previewGateway.ts の agentJs。形は previewProtocol.ts） */
type AgentMsg = Extract<AgentMessage, { path: string }>;

/** 中継のスクリプトとの接続1本。iframe の文書ごとに作り直す */
interface Conn { port: MessagePort; nonce: string; serverKey: string }

/** 選択の状態（パネルの1行と、右ドックへの反映） */
type LiveSel =
  | { status: 'resolving'; tag: string; path: string }
  | { status: 'resolved'; tag: string; path: string; component: string; at: string; ordinal: number; count: number }
  | { status: 'unresolved'; tag: string; path: string; reason: string; label: string }
  | { status: 'error'; tag: string; path: string; message: string }
  | { status: 'cleared'; message: string };

const POST_HEADERS = { 'content-type': 'application/json', 'x-vcide-request': '1' } as const;

function newNonce(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type View = 'starting' | 'stopping' | 'stopped' | 'error' | 'unavailable' | 'checking' | 'unreachable' | 'live';

const PING_TIMEOUT_MS = 5000;
/** Phase 7B-3A: いまの起動の観測を取り直す間隔 */
const OBS_POLL_MS = 1500;
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
  const { showLive, clearLive } = useExplore();
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

  /* ------------------------------------------------ 中継のスクリプトとの接続
   * 1. iframe から `hello`（中身なし）が来る。**送り主を確かめる**（中継の origin で、この iframe の window から）
   * 2. MessageChannel を作り、片方を `connect` で渡す。宛先の origin を明示する（'*' にしない）
   * 3. 以後はその port だけを信じる。**この起動の開発サーバーで、いまの文書の port** からの知らせだけを受ける
   * アプリのスクリプトが `hello` を偽っても、スクリプトが先に port を受け取って握りつぶすので、
   * 新しい port は答えない（＝昇格しない）。いまの接続は切れない */
  const connRef = useRef<Conn | null>(null);
  const pendingRef = useRef<Conn[]>([]);
  const serverKeyRef = useRef<string | null>(serverKey);
  serverKeyRef.current = serverKey;
  const [rejected, setRejected] = useState(0);
  const [connN, setConnN] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  const [agentMode, setAgentMode] = useState(false);
  const [liveSel, setLiveSel] = useState<LiveSel | null>(null);
  const selSeqRef = useRef(0);
  const runRef = useRef(runtime);
  runRef.current = runtime;

  /* ----------------------------------------- Phase 7B-3A: いまの起動の観測（HTTP・SQL）
   * 起動の鍵（instance・PID・開始時刻）を付けて取りに行く。いまの起動と違えば 409 が返り、
   * 前の起動の観測は出さない。停止・再起動で消す（下の serverKey の効果） */
  const [obs, setObs] = useState<LiveRunObservation | null>(null);
  const [obsError, setObsError] = useState<string | null>(null);
  const [obsPick, setObsPick] = useState<number | null>(null);
  const [obsShown, setObsShown] = useState<{ seq: number; sig: string } | null>(null);
  const [obsNote, setObsNote] = useState<string | null>(null);
  useEffect(() => {
    setObs(null); setObsError(null); setObsPick(null); setObsShown(null);
    if (!serverKey) return undefined;
    const key = serverKey;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      const rt = runRef.current;
      if (!alive || !rt?.pid || !rt.startedAt) return;
      try {
        const r = await fetch('/api/runtime/observations', {
          method: 'POST', headers: POST_HEADERS,
          body: JSON.stringify({ run: { instance: rt.instance, pid: rt.pid, startedAt: rt.startedAt } }),
        });
        const j = await r.json() as {
          observation?: LiveRunObservation | null;
          stale?: { message: string }; error?: { message: string };
        };
        if (!alive || serverKeyRef.current !== key) return;
        if (j.observation) { setObs(j.observation); setObsError(null); }
        else { setObs(null); setObsError(j.stale?.message ?? j.error?.message ?? `HTTP ${r.status}`); }
      } catch (e) {
        if (alive) setObsError(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer = window.setTimeout(() => { void tick(); }, OBS_POLL_MS);
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [serverKey]);

  /** 通信ごとに、サーバー処理・SQL まで結べたか（一覧と変換が同じ判定を使う） */
  const obsRows = useMemo(() => (obs ? [...obs.exchanges].reverse().map((e) => ({
    e, links: liveExchangeLinks(obs, e),
  })) : []), [obs]);
  const obsSqlCount = obsRows.reduce((n, r) => n + r.links.sql.length, 0);
  /** 利用者が選ぶまでは、SQL まで結べた最新の通信（無ければ最新）を既定にする */
  const obsDefault = (obsRows.find((r) => r.links.sql.length) ?? obsRows[0])?.e.seq ?? null;
  const obsSel = obsPick !== null && obsRows.some((r) => r.e.seq === obsPick) ? obsPick : obsDefault;

  const showObs = useCallback((seq: number, data: LiveRunObservation, key: string) => {
    const { dataset } = fromLiveRun(data, seq);
    const ds = layout(dataset);
    const focus = ds.nodes.find((n) => n.kind === 'server')?.id ?? ds.nodes[0].id;
    selSeqRef.current += 1;             // 待っている要素の解決は捨てる（後から上書きさせない）
    setLiveSel(null);
    setObsNote(null);
    showLive(ds, `${key}#obs${seq}`, focus);
    setObsShown({ seq, sig: `${ds.nodes.length}/${ds.hops.length}` });
    setObsPick(seq);                    // 一覧の選択を、描いている通信に固定する（新しい通信で動かさない）
  }, [showLive]);

  /* 表示中の通信のスパンが後から書かれたら（応答の後に閉じるスパンがある）、描き直す */
  useEffect(() => {
    if (!obsShown || !obs || !serverKey) return;
    if (!obs.exchanges.some((e) => e.seq === obsShown.seq)) return;
    const { dataset } = fromLiveRun(obs, obsShown.seq);
    if (`${dataset.nodes.length}/${dataset.hops.length}` !== obsShown.sig) showObs(obsShown.seq, obs, serverKey);
  }, [obs, obsShown, serverKey, showObs]);

  const clearObs = () => { setObsShown(null); clearLive(); };

  const closeAll = useCallback(() => {
    for (const c of [connRef.current, ...pendingRef.current]) { try { c?.port.close(); } catch { /* 閉じている */ } }
    connRef.current = null;
    pendingRef.current = [];
    setAgentMode(false);
  }, []);

  const sendMode = useCallback((c: Conn | null, on: boolean) => {
    c?.port.postMessage({ source: IDE_SOURCE, v: PROTOCOL_VERSION, nonce: c.nonce, kind: 'mode', select: on });
  }, []);

  /** 選択を IDE の対応表で解決する。位置は受け取らない（送ってくるのは識別子だけ） */
  const resolve = useCallback(async (sel: ElementSelection, key: string) => {
    const rt = runRef.current;
    if (!rt?.pid || !rt.startedAt) return;
    const mySeq = ++selSeqRef.current;
    setLiveSel({ status: 'resolving', tag: sel.tag, path: sel.path });
    let j: { resolution?: LiveResolution; error?: { code: string; message: string } };
    try {
      const r = await fetch('/api/runtime/anchor', {
        method: 'POST', headers: POST_HEADERS,
        body: JSON.stringify({ run: { instance: rt.instance, pid: rt.pid, startedAt: rt.startedAt }, selection: sel }),
      });
      j = await r.json() as typeof j;
    } catch (e) {
      j = { error: { code: 'fetch', message: e instanceof Error ? e.message : String(e) } };
    }
    // 返事を待つ間に、別の選択・停止・再起動があったら捨てる
    if (mySeq !== selSeqRef.current || serverKeyRef.current !== key) return;
    if (!j.resolution) {
      setLiveSel({ status: 'error', tag: sel.tag, path: sel.path, message: j.error?.message ?? '解決できませんでした。' });
      return;
    }
    const res = j.resolution;
    setObsShown(null);                    // 観測の表示は、この選択の表示で置き換わる
    const { dataset } = fromLiveSelection({
      project: rt.project?.name ?? '—', port: rt.port ?? 0,
      page: { path: sel.path, title: msg?.title ?? '' },
      selection: sel, resolution: res, selectedAt: new Date().toISOString(),
    });
    const ds = layout(dataset);
    const focus = ds.nodes.find((n) => n.kind === 'component')?.id ?? ds.nodes[0].id;
    showLive(ds, `${key}#${mySeq}`, focus);
    if (res.status === 'resolved') {
      setLiveSel({
        status: 'resolved', tag: sel.tag, path: sel.path, component: res.anchor.component,
        at: `${res.anchor.file}:${res.anchor.line}:${res.anchor.col}`,
        ordinal: sel.anchorOrdinal ?? 0, count: sel.anchorInstanceCount,
      });
    } else {
      setLiveSel({
        status: 'unresolved', tag: sel.tag, path: sel.path, reason: res.reason,
        label: LIVE_UNRESOLVED_LABEL[res.reason] ?? res.reason,
      });
    }
  // msg の title は表示用。古くても判定には使わない
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLive]);

  const onPortMessage = useCallback((c: Conn, data: unknown) => {
    const m = parseAgentMessage(data, c.nonce);
    if (!m) { setRejected((n) => n + 1); return; }
    // 別の起動（停止・再起動の前）の文書からの知らせは受けない
    if (c.serverKey !== serverKeyRef.current) { setRejected((n) => n + 1); return; }
    if (connRef.current !== c) {
      const i = pendingRef.current.indexOf(c);
      if (i < 0) { setRejected((n) => n + 1); return; }
      // 新しい文書のスクリプトが答えた。古い接続を閉じて入れ替える
      try { connRef.current?.port.close(); } catch { /* 閉じている */ }
      for (const p of pendingRef.current.slice(0, i)) { try { p.port.close(); } catch { /* 閉じている */ } }
      pendingRef.current = pendingRef.current.slice(i + 1);
      connRef.current = c;
      setAgentMode(false);
      setConnN((n) => n + 1);
      sendMode(c, selectModeRef.current);
    }
    if (m.kind === 'connected') return;
    if (m.kind === 'mode') { setAgentMode(m.select); return; }
    if (m.kind === 'select') {
      // 選択モードでないときの選択は受けない（利用者が選ぶと決めたときだけ）
      if (!selectModeRef.current) { setRejected((n) => n + 1); return; }
      void resolve(m.selection, c.serverKey);
      return;
    }
    setSilent(false);
    setMsg(m);
    if (m.kind === 'ready') { readyRef.current = true; setLoads((n) => n + 1); }
    if (!editingRef.current) setAddr(m.path);
  }, [resolve, sendMode]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!origin || e.origin !== origin) return;
      const win = frameRef.current?.contentWindow;
      if (!win || e.source !== win) return;
      if (!isAgentHello(e.data)) { setRejected((n) => n + 1); return; }
      const key = serverKeyRef.current;
      if (!key) return;
      const ch = new MessageChannel();
      const c: Conn = { port: ch.port1, nonce: newNonce(), serverKey: key };
      ch.port1.onmessage = (ev) => onPortMessage(c, ev.data);
      pendingRef.current = [...pendingRef.current.slice(-3), c];
      // 宛先の origin を明示する。iframe の中が別の origin に移っていれば届かない
      win.postMessage({ source: IDE_SOURCE, v: PROTOCOL_VERSION, kind: 'connect', nonce: c.nonce }, origin, [ch.port2]);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [origin, onPortMessage]);

  /* 選択モードの切り替えをスクリプトへ伝える */
  useEffect(() => { sendMode(connRef.current, selectMode); }, [selectMode, sendMode]);

  /* 開発サーバーが入れ替わった・止まった: 接続を閉じ、**選択も解除する**（実態と矛盾させない） */
  const hadServerRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = hadServerRef.current;
    hadServerRef.current = serverKey;
    if (prev === serverKey) return;
    closeAll();
    selSeqRef.current += 1;              // 返事を待っている解決も捨てる
    setSelectMode(false);
    if (prev !== null) {
      setObsNote(serverKey ? '開発サーバーが起動し直されたため、前の起動の観測を消しました。' : '開発サーバーが実行中ではなくなったため、観測の表示を消しました（実測中ではありません）。');
      clearLive();
      setLiveSel((cur) => (cur && cur.status !== 'cleared'
        ? { status: 'cleared', message: serverKey ? '開発サーバーが起動し直されたため、前の選択を解除しました。' : '開発サーバーが実行中ではなくなったため、選択を解除しました。' }
        : cur));
    }
  }, [serverKey, closeAll, clearLive]);
  useEffect(() => () => { closeAll(); clearLive(); }, [closeAll, clearLive]);

  const clearSel = () => { selSeqRef.current += 1; clearLive(); setLiveSel(null); };

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
        data-path={msg?.path ?? ''} data-loads={loads}
        data-conn={connN} data-rejected={rejected} data-select-mode={selectMode ? 'on' : 'off'}
        data-agent-mode={agentMode ? 'on' : 'off'} data-selection={liveSel?.status ?? ''}
        data-sel-at={liveSel?.status === 'resolved' ? liveSel.at : ''}
        data-sel-component={liveSel?.status === 'resolved' ? liveSel.component : ''}
        data-sel-reason={liveSel?.status === 'unresolved' ? liveSel.reason : ''}>
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
          {canNav
            ? <button type="button" className={`rt-b${selectMode ? ' go' : ''}`} aria-pressed={selectMode}
              title={selectMode ? '選択モード中: プレビューの中のクリックは要素の選択になります（ページは操作されません）' : 'プレビューの中の要素をクリックで選び、React のソース位置を調べます'}
              onClick={() => setSelectMode((v) => !v)}>選択</button>
            : <Why reason="開発サーバーのページを表示しているときだけ使えます。"><span className="rt-b off" aria-disabled="true">選択</span></Why>}
        </div>
        {addrError && <p className="rt-note pvwarn">{addrError}</p>}
        {liveSel && (
          <div className="rt-row pvselrow">
            <p className={`rt-note pvsel${liveSel.status === 'unresolved' || liveSel.status === 'error' ? ' pvwarn' : ''}`}>
              {liveSel.status === 'resolving' && <>選択: &lt;{liveSel.tag}&gt; — 対応表で調べています…</>}
              {liveSel.status === 'resolved' && <>選択: &lt;{liveSel.tag}&gt; → <b>{liveSel.component}</b> <code>{liveSel.at}</code>
                {liveSel.count > 1 && <> （同じ JSX の要素 {liveSel.count} 個のうち {liveSel.ordinal + 1} 番目。どの使用箇所かは区別していません）</>}</>}
              {liveSel.status === 'unresolved' && <>選択: &lt;{liveSel.tag}&gt; — 特定できません（{liveSel.label}）。理由は右の詳細に出しています</>}
              {liveSel.status === 'error' && <>選択: &lt;{liveSel.tag}&gt; — {liveSel.message}</>}
              {liveSel.status === 'cleared' && <>{liveSel.message}</>}
            </p>
            {liveSel.status !== 'cleared' && <button type="button" className="rt-b" onClick={clearSel}>解除</button>}
          </div>
        )}
        {selectMode && !liveSel && view === 'live' && (
          <p className="rt-note pvsel">選択モード: プレビューの中の要素をクリックしてください（ページは操作されません）。</p>
        )}

        {view === 'live' && (
          <div className="rt-row pvselrow pvobsrow" data-obs-state={obs ? (obs.exchanges.length ? 'some' : 'none') : obsError ? 'error' : 'loading'}
            data-obs-count={obs?.exchanges.length ?? ''} data-obs-sql={obs ? obsSqlCount : ''}
            data-obs-shown={obsShown?.seq ?? ''} data-obs-session={obs?.session.startedAt ?? ''}>
            <p className="rt-note pvsel pvobs">
              {!obs && !obsError && <>観測（いまの起動）: 取得しています…</>}
              {!obs && obsError && <>観測（いまの起動）: 取得できません — {obsError}</>}
              {obs && !obs.exchanges.length && <>観測（いまの起動）: まだ通信はありません（未観測）。</>}
              {obs && obs.exchanges.length > 0 && <>観測（いまの起動）: 通信 <b>{obs.exchanges.length}</b> 件・SQL <b>{obsSqlCount}</b> 本{obs.session.overflow ? `（上限を超えた ${obs.session.overflow} 件は記録していません）` : ''}</>}
              {obs && obs.instrumentation.state !== 'enabled' && <> サーバー処理・SQL は観測していません（{obs.instrumentation.reason ?? '計装なし'}）。</>}
            </p>
            {obs && obs.exchanges.length > 0 && (
              <>
                <select className="rt-in pvobssel" aria-label="観測した通信" value={obsSel ?? ''}
                  onChange={(e) => setObsPick(Number(e.target.value))}>
                  {obsRows.map(({ e, links }) => (
                    <option key={e.seq} value={e.seq}>
                      {liveExchangeLabel(e)}{links.server ? ` / SQL ${links.sql.length}` : ' / 処理と未接続'}
                    </option>
                  ))}
                </select>
                <button type="button" className="rt-b" disabled={obsSel === null}
                  title="選んだ通信と、そのサーバー処理・SQL・テーブル・カラムをキャンバスと右の詳細に出します"
                  onClick={() => { if (obsSel !== null && obs && serverKey) showObs(obsSel, obs, serverKey); }}>表示</button>
                {obsShown && <button type="button" className="rt-b" onClick={clearObs}>解除</button>}
              </>
            )}
          </div>
        )}
        {obsNote && view !== 'live' && <p className="rt-note pvsel">{obsNote}</p>}
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
