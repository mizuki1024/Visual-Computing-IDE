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
import { PREVIEW_LEFT, previewWidth } from './previewLayout';
import Why from '../common/Why';
import { RUN_STATE_LABEL, useRuntime, type Finding } from '@/state/RuntimeStore';
import { useExplore } from '@/state/ExploreStore';
import {
  IDE_SOURCE, PROTOCOL_VERSION, isAgentHello, parseAgentMessage,
  type AgentMessage, type ElementSelection, type SelectionDocument,
} from '@/lib/previewProtocol';
import {
  LIVE_UNRESOLVED_LABEL, fromLiveRun, fromLiveSelection, liveExchangeLabel, liveExchangeLinks, lineageCutText,
  type LiveResolution, type LiveSelectionInput,
} from '@/lib/adapter';
import {
  DOC_UNBOUND_LABEL, hasDetail, type DocBinding, type LiveLineage, type LiveRunObservation,
} from '@/lib/liveObservation';
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
/** 7B-3B-2: 由来の評価を取り直す回数と間隔（応答を送り終える前・スパンを書く前の一時的な未観測のため） */
const LINEAGE_RETRIES = 6;
const LINEAGE_RETRY_MS = 1000;
/** 一時的でありうる理由（時間が経てば観測に入る）。それ以外は取り直さない */
const LINEAGE_TRANSIENT = new Set(['no-server-link', 'fetch-not-measured', 'fetch-site-unverified']);
const DOC_TRANSIENT = new Set(['token-not-in-session']);

/** 選択の行に出す、文書の同定と由来の1行 */
function lineageLine(l: LiveLineage): string {
  const b = l.binding;
  /* 7C-1: 保持対象外のときは、どの通信がなぜ外れたかも出す */
  const evictedDetail = b.status === 'unidentified' && (b.reason === 'exchange-evicted' || b.reason === 'history-evicted') && b.detail
    ? ` — ${b.detail}` : '';
  const doc = b.status === 'identified' ? `文書: 通信 #${b.seq} の応答と同定` : `文書: 同定できません（${DOC_UNBOUND_LABEL[b.reason]}${evictedDetail}）`;
  if (l.status === 'linked') {
    const what = l.candidates.length === 1
      ? `${l.candidates[0].schema}.${l.candidates[0].table}.${l.candidates[0].column}`
      : l.candidates.length > 1
        ? `${l.candidates.length} 候補のいずれか（${l.candidates.map((c) => `${c.table}.${c.column}`).join(' / ')}）。1つに決めていません`
        : `テーブル ${l.tableCandidates.map((t) => `${t.schema}.${t.name}`).join(' / ')} まで（列は決まりません）`;
    return `${doc}。由来（静的解析による推定）: ${what}`;
  }
  return b.status === 'identified' ? `${doc}。由来は結んでいません — ${lineageCutText(l)}` : `${doc}。由来は結んでいません`;
}

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
  const { showLive, clearLive, compact, setCompact, viewport } = useExplore();
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
  const [obsShown, setObsShown] = useState<{ seq: number; sig: string; withSel: boolean } | null>(null);
  const [obsNote, setObsNote] = useState<string | null>(null);
  /** 7C-1: 証拠（詳細）がまだ届いていない通信の［表示］。届いたら描く */
  const [pendingShow, setPendingShow] = useState<number | null>(null);
  /** 7C-1: 取得に添えるもの（証拠を求める通信・保持を頼む通信・持っている観測の指紋） */
  const wantRef = useRef<{ detail: number[]; pin: number[] }>({ detail: [], pin: [] });
  const etagRef = useRef<string | null>(null);
  /** 7C-1: 待たずに取り直す（詳細が足りないとき） */
  const pollNowRef = useRef<() => void>(() => {});
  /** 7B-3B-1: いま選択している要素（7B-2 の解決の入力）。観測と同じキャンバスに**並べるだけ**に使う */
  const lastSelRef = useRef<LiveSelectionInput | null>(null);
  /** 7B-3B-2: いまの選択の、文書の同定と値の由来の評価 */
  const [lin, setLin] = useState<LiveLineage | null>(null);
  const linRef = useRef<LiveLineage | null>(null);
  linRef.current = lin;
  useEffect(() => {
    setObs(null); setObsError(null); setObsPick(null); setObsShown(null); setPendingShow(null);
    etagRef.current = null;
    if (!serverKey) return undefined;
    const key = serverKey;
    let alive = true;
    let timer = 0;
    let inflight = false;
    let again = false;
    const tick = async () => {
      const rt = runRef.current;
      if (!alive || !rt?.pid || !rt.startedAt) return;
      if (inflight) { again = true; return; }
      inflight = true;
      window.clearTimeout(timer);
      try {
        /* 7C-1: 一覧の要約と、表示中・選択中の通信の証拠だけを求める。指紋が同じなら中身は返らない */
        const r = await fetch('/api/runtime/observations', {
          method: 'POST', headers: POST_HEADERS,
          body: JSON.stringify({
            run: { instance: rt.instance, pid: rt.pid, startedAt: rt.startedAt },
            detail: wantRef.current.detail, pin: wantRef.current.pin, etag: etagRef.current,
          }),
        });
        const j = await r.json() as {
          observation?: LiveRunObservation | null; unchanged?: boolean;
          stale?: { message: string }; error?: { message: string };
        };
        if (!alive || serverKeyRef.current !== key) return;
        if (j.unchanged) setObsError(null);
        else if (j.observation) { etagRef.current = j.observation.etag ?? null; setObs(j.observation); setObsError(null); }
        else { etagRef.current = null; setObs(null); setObsError(j.stale?.message ?? j.error?.message ?? `HTTP ${r.status}`); }
      } catch (e) {
        if (alive) setObsError(e instanceof Error ? e.message : String(e));
      } finally {
        inflight = false;
      }
      if (!alive) return;
      if (again) { again = false; void tick(); return; }
      timer = window.setTimeout(() => { void tick(); }, OBS_POLL_MS);
    };
    pollNowRef.current = () => { void tick(); };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); pollNowRef.current = () => {}; };
  }, [serverKey]);

  /** 通信ごとに、サーバー処理・SQL まで結べたか。7C-1: サーバーが全件の証拠で判定した要約を使う
   * （要約の無い観測では、変換と同じ判定をこの画面で行う） */
  const obsRows = useMemo(() => {
    if (!obs) return [];
    const sum = new Map((obs.summaries ?? []).map((x) => [x.seq, x]));
    return [...obs.exchanges].reverse().map((e) => {
      const x = sum.get(e.seq);
      if (x) return { e, links: { server: x.server, sql: x.sql, sited: x.sited } };
      if (!hasDetail(obs, e.seq)) return { e, links: { server: false, sql: 0, sited: null } };
      const l = liveExchangeLinks(obs, e);
      const sited = obs.dataAccess
        ? l.sql.filter((sp) => obs.dataAccess!.some((d) => d.spanId === sp.spanId && d.traceId === sp.traceId && d.site)).length
        : null;
      return { e, links: { server: !!l.server, sql: l.sql.length, sited } };
    });
  }, [obs]);
  const obsSqlCount = obsRows.reduce((n, r) => n + r.links.sql, 0);
  const obsSiteCount = obs?.dataAccess ? obsRows.reduce((n, r) => n + (r.links.sited ?? 0), 0) : null;
  /** 利用者が選ぶまでは、SQL まで結べた最新の通信（無ければ最新）を既定にする。
   * 要素を選んでいれば、そのページと同じパスの通信を優先する（**並べるだけ。結ばない**） */
  const selPath = liveSel && liveSel.status !== 'cleared' ? liveSel.path : null;
  const boundSeq = lin?.binding.status === 'identified' ? lin.binding.seq : null;
  const obsDefault = ((boundSeq !== null ? obsRows.find((r) => r.e.seq === boundSeq) : undefined)
    ?? (selPath ? obsRows.find((r) => r.e.path === selPath && r.links.sql) : undefined)
    ?? obsRows.find((r) => r.links.sql) ?? obsRows[0])?.e.seq ?? null;
  const obsSel = obsPick !== null && obsRows.some((r) => r.e.seq === obsPick) ? obsPick : obsDefault;
  /* 7C-1: 次の取得で証拠を求める通信（表示中・表示待ち・同定した文書の通信・利用者が一覧で選んだもの）と、
   * 保持を頼む通信（表示中・同定した文書の通信・表示待ち）。**既定の選択（最新）は求めない** —
   * 通信が続く間は毎回変わり、取得が増えるため。［表示］で証拠が無ければ、そのとき待たずに取り直す（showObs） */
  {
    const uniq = (xs: (number | null | undefined)[]) => [...new Set(xs.filter((x): x is number => typeof x === 'number'))];
    wantRef.current = {
      detail: uniq([obsShown?.seq, pendingShow, boundSeq, obsPick]).slice(0, 4),
      pin: uniq([obsShown?.seq, boundSeq, pendingShow]).slice(0, 4),
    };
  }
  /** 7C-1: 表示中の通信が保持範囲から外れたか（保持を頼んでいるので通常は起きない。頼む前に外れた場合だけ） */
  const shownEvicted = !!obs && !!obsShown && !obs.exchanges.some((e) => e.seq === obsShown.seq);

  /** 選択した要素を並べるか。**同じパスのページの選択のときだけ**（別のページの要素と並べない） */
  const selectionFor = (data: LiveRunObservation, seq: number): LiveSelectionInput | undefined => {
    const sel = lastSelRef.current;
    const ex = data.exchanges.find((e) => e.seq === seq);
    return sel && ex && sel.page.path === ex.path ? sel : undefined;
  };

  /** 7B-3B-2: 並べる選択に、文書の同定と由来の評価を添える（使えるかは変換が通信の番号で判定する） */
  const runOpts = (selection: LiveSelectionInput | undefined) => {
    const l = linRef.current;
    if (!selection) return {};
    const { lineage: _l, ...sel } = selection;
    void _l;
    return { selection: sel, ...(l ? { binding: l.binding as DocBinding, lineage: l } : {}) };
  };

  const showObs = useCallback((seq: number, data: LiveRunObservation, key: string) => {
    /* 7C-1: 証拠がまだ届いていなければ、届いてから描く（「未接続」と誤って描かない） */
    if (!hasDetail(data, seq)) { setPendingShow(seq); pollNowRef.current(); return; }
    setPendingShow(null);
    const selection = selectionFor(data, seq);
    const { dataset } = fromLiveRun(data, seq, runOpts(selection));
    const ds = layout(dataset);
    const focus = ds.nodes.find((n) => n.kind === 'server')?.id ?? ds.nodes[0].id;
    selSeqRef.current += 1;             // 待っている要素の解決は捨てる（後から上書きさせない）
    if (!selection) { setLiveSel(null); lastSelRef.current = null; setLin(null); }
    setObsNote(null);
    showLive(ds, `${key}#obs${seq}`, focus);
    setObsShown({ seq, sig: `${ds.nodes.length}/${ds.hops.length}`, withSel: !!selection });
    setObsPick(seq);                    // 一覧の選択を、描いている通信に固定する（新しい通信で動かさない）
  // selectionFor は ref だけを読む
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLive]);

  /* 7C-1: 表示を待っている通信の証拠が届いたら描く */
  useEffect(() => {
    if (pendingShow === null || !obs || !serverKey) return;
    if (!obs.exchanges.some((e) => e.seq === pendingShow)) { setPendingShow(null); return; }
    if (hasDetail(obs, pendingShow)) showObs(pendingShow, obs, serverKey);
  }, [obs, pendingShow, serverKey, showObs]);

  /* 表示中の通信のスパンが後から書かれたら（応答の後に閉じるスパンがある）、描き直す */
  useEffect(() => {
    if (!obsShown || !obs || !serverKey) return;
    if (!hasDetail(obs, obsShown.seq)) return;
    const { dataset } = fromLiveRun(obs, obsShown.seq, runOpts(obsShown.withSel ? selectionFor(obs, obsShown.seq) : undefined));
    if (`${dataset.nodes.length}/${dataset.hops.length}` !== obsShown.sig) showObs(obsShown.seq, obs, serverKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obs, obsShown, serverKey, showObs]);

  const clearObs = () => { setObsShown(null); setPendingShow(null); clearLive(); };

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
  /**
   * 7B-3B-2: 文書の同定と値の由来を評価する（IDE のサーバーが要素の位置を照合し直し、静的解析と実測を突き合わせる）。
   * 文書を同定できたら、その通信の観測と選択を**同じ1回の取得から**並べて描く。
   * 一時的な未観測（応答を送り終える前・スパンを書く前）なら、少し待って取り直す
   */
  const evaluate = useCallback(async (input: LiveSelectionInput, key: string, mySeq: number, attempt = 0): Promise<void> => {
    const rt = runRef.current;
    if (!rt?.pid || !rt.startedAt) return;
    /* 7C-1: 取り直しを待つ間に別の選択・停止・再起動があったら、要求そのものを出さない（結果は従来も捨てていた） */
    if (mySeq !== selSeqRef.current || serverKeyRef.current !== key) return;
    let j: { observation?: LiveRunObservation; lineage?: LiveLineage; error?: { message: string } };
    try {
      const r = await fetch('/api/runtime/lineage', {
        method: 'POST', headers: POST_HEADERS,
        body: JSON.stringify({
          run: { instance: rt.instance, pid: rt.pid, startedAt: rt.startedAt },
          selection: input.selection, document: input.document ?? null,
        }),
      });
      j = await r.json() as typeof j;
    } catch (e) {
      j = { error: { message: e instanceof Error ? e.message : String(e) } };
    }
    if (mySeq !== selSeqRef.current || serverKeyRef.current !== key) return;
    if (!j.lineage || !j.observation) return;
    const l = j.lineage;
    setLin(l);
    linRef.current = l;
    const withLin: LiveSelectionInput = { ...input, lineage: l };
    lastSelRef.current = withLin;
    /* 自動で並べるのは、由来を結べたときだけ（結べないときは選択の表示のまま、切断に理由を出す。
     * 文書を同定できていれば、利用者が［表示］でその通信を並べられる） */
    if (l.binding.status === 'identified' && l.status === 'linked') {
      const seq = l.binding.seq;
      const { lineage: _x, ...sel } = withLin;
      void _x;
      const { dataset } = fromLiveRun(j.observation, seq, { selection: sel, binding: l.binding, lineage: l });
      const ds = layout(dataset);
      const focus = ds.nodes.find((n) => n.kind === 'component')?.id ?? ds.nodes[0].id;
      etagRef.current = null;          // 由来の評価の観測は、一覧の取得とは求めた詳細が違う
      setObs(j.observation);
      showLive(ds, `${key}#${mySeq}#lin${attempt}`, focus);
      setObsShown({ seq, sig: `${ds.nodes.length}/${ds.hops.length}`, withSel: true });
      setObsPick(seq);
    } else {
      /* 7C-0: 結べなかったときも、文書を同定できていれば一覧の既定はその通信である（上の obsDefault）。
       * 一覧は 1.5 秒ごとの取得なので、同定した通信がまだ一覧に無いことがある。そのあいだ既定が
       * **別のページの通信**に落ちないよう、由来の評価と同時に取った観測（同じ起動）を一覧にも使う。
       * 一覧の取得のほうが新しければ（件数が多ければ）そちらを残す */
      if (l.binding.status === 'identified') {
        const fresh = j.observation;
        /* 7C-1: 件数は保持範囲で頭打ちになるので、新しさは記録した通しの数で比べる */
        setObs((prev) => {
          if (prev && fresh.session.recorded < prev.session.recorded) return prev;
          etagRef.current = null;
          return fresh;
        });
      }
      const { dataset } = fromLiveSelection(withLin);
      const ds = layout(dataset);
      showLive(ds, `${key}#${mySeq}#lin${attempt}`, ds.nodes.find((n) => n.kind === 'component')?.id ?? ds.nodes[0].id);
    }
    const transient = l.binding.status === 'unidentified'
      ? DOC_TRANSIENT.has(l.binding.reason)
      : l.status === 'cut' && !!l.cut && LINEAGE_TRANSIENT.has(l.cut.reason);
    if (transient && attempt < LINEAGE_RETRIES) {
      window.setTimeout(() => { void evaluate(input, key, mySeq, attempt + 1); }, LINEAGE_RETRY_MS);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLive]);

  const resolve = useCallback(async (sel: ElementSelection, key: string, document: SelectionDocument | null = null) => {
    const rt = runRef.current;
    if (!rt?.pid || !rt.startedAt) return;
    const mySeq = ++selSeqRef.current;
    setLin(null);
    setObsPick(null);                     // 一覧の既定を、この選択の文書の通信（同定できれば）に戻す
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
    const input: LiveSelectionInput = {
      project: rt.project?.name ?? '—', port: rt.port ?? 0,
      page: { path: sel.path, title: msg?.title ?? '' },
      selection: sel, resolution: res, selectedAt: new Date().toISOString(),
      ...(document ? { document } : {}),
    };
    lastSelRef.current = input;
    const { dataset } = fromLiveSelection(input);
    const ds = layout(dataset);
    const focus = ds.nodes.find((n) => n.kind === 'component')?.id ?? ds.nodes[0].id;
    showLive(ds, `${key}#${mySeq}`, focus);
    if (res.status === 'resolved') {
      setLiveSel({
        status: 'resolved', tag: sel.tag, path: sel.path, component: res.anchor.component,
        at: `${res.anchor.file}:${res.anchor.line}:${res.anchor.col}`,
        ordinal: sel.anchorOrdinal ?? 0, count: sel.anchorInstanceCount,
      });
      void evaluate(input, key, mySeq);
    } else {
      setLiveSel({
        status: 'unresolved', tag: sel.tag, path: sel.path, reason: res.reason,
        label: LIVE_UNRESOLVED_LABEL[res.reason] ?? res.reason,
      });
    }
  // msg の title は表示用。古くても判定には使わない
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLive, evaluate]);

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
      void resolve(m.selection, c.serverKey, m.document);
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
    lastSelRef.current = null;
    setLin(null);
    setSelectMode(false);
    setCompact('preview', false);         // 7C-2: 前の起動の選択が無くなったので、ページの表示に戻す
    if (prev !== null) {
      setObsNote(serverKey ? '開発サーバーが起動し直されたため、前の起動の観測を消しました。' : '開発サーバーが実行中ではなくなったため、観測の表示を消しました（実測中ではありません）。');
      clearLive();
      setLiveSel((cur) => (cur && cur.status !== 'cleared'
        ? { status: 'cleared', message: serverKey ? '開発サーバーが起動し直されたため、前の選択を解除しました。' : '開発サーバーが実行中ではなくなったため、選択を解除しました。' }
        : cur));
    }
  }, [serverKey, closeAll, clearLive, setCompact]);
  useEffect(() => () => { closeAll(); clearLive(); }, [closeAll, clearLive]);

  /*
   * 7C-2: 「画面を見る → 選ぶ → 理解する」。
   *   選ぶ    … 選択モードに入ると、ページの表示を広げる（選び直せる）
   *   理解する … 選択モードを抜けた（選んだ要素が残っている）・観測の通信を［表示］したら、
   *             ページの表示を畳んで経路図を優先する。畳んでも iframe の文書・選択・観測は残る
   *   戻る    … ヘッダの［ページを表示］・［選択］・移動・再読み込み・解除で、いつでも広げる
   */
  const toggleSelect = () => {
    const next = !selectMode;
    setSelectMode(next);
    if (next) setCompact('preview', false);
    else if (liveSel && (liveSel.status === 'resolved' || liveSel.status === 'unresolved')) setCompact('preview', true);
  };
  /* 全体表示などで畳まれたら、選択モードを抜ける（畳んだ表示では要素を選べないため） */
  const prevCompact = useRef(compact.preview);
  useEffect(() => {
    if (compact.preview && !prevCompact.current) setSelectMode(false);
    prevCompact.current = compact.preview;
  }, [compact.preview]);

  const clearSel = () => { selSeqRef.current += 1; lastSelRef.current = null; setLin(null); clearLive(); setLiveSel(null); setObsShown(null); setCompact('preview', false); };

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
    setCompact('preview', false);        // 7C-2: 移動・再読み込みはページを見るための操作
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
  /** 7C-2: ページの表示を畳んでいるか（実ページを表示していて、選択モードでないときだけ畳める） */
  const folded = compact.preview && view === 'live' && !selectMode;

  return (
    <FloatingPanel id="preview" title="プレビュー" note="開発サーバー"
      style={{ left: PREVIEW_LEFT, top: 16, width: previewWidth(viewport.w) }}
      fold={view === 'live' ? {
        expanded: !folded,
        onToggle: () => { if (folded) setCompact('preview', false); else { setSelectMode(false); setCompact('preview', true); } },
        showLabel: 'ページを表示', hideLabel: '畳む',
        hint: folded
          ? 'ページの表示を広げます（同じ文書のまま。別の要素を選ぶときは［選択］）'
          : 'ページの表示を畳み、経路図を広く見ます（選択・観測・表示中の文書は残ります）',
      } : undefined}>
      <div className={`pvb pvlive${folded ? ' pvfold' : ''}`} data-preview-state={view} data-folded={folded ? 'on' : 'off'}
        data-http-status={msg?.status ?? ''} data-from={msg?.from ?? ''}
        data-path={msg?.path ?? ''} data-loads={loads}
        data-conn={connN} data-rejected={rejected} data-select-mode={selectMode ? 'on' : 'off'}
        data-agent-mode={agentMode ? 'on' : 'off'} data-selection={liveSel?.status ?? ''}
        data-sel-at={liveSel?.status === 'resolved' ? liveSel.at : ''}
        data-sel-component={liveSel?.status === 'resolved' ? liveSel.component : ''}
        data-sel-reason={liveSel?.status === 'unresolved' ? liveSel.reason : ''}
        data-doc-binding={lin ? (lin.binding.status === 'identified' ? 'identified' : lin.binding.reason) : ''}
        data-doc-seq={lin?.binding.status === 'identified' ? lin.binding.seq : ''}
        data-lineage={lin?.status ?? ''} data-lineage-reason={lin?.cut?.reason ?? ''}
        data-lineage-stage={lin?.cut?.stage ?? ''} data-lineage-outcome={lin?.status === 'linked' ? lin.outcome : ''}
        data-lineage-cands={lin?.status === 'linked' ? lin.candidates.map((c) => `${c.schema}.${c.table}.${c.column}`).join(',') : ''}>
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
              title={selectMode ? '選択モード中: プレビューの中のクリックは要素の選択になります（ページは操作されません）。抜けると、ページの表示を畳んで経路図を広く表示します' : 'プレビューの中の要素をクリックで選び、React のソース位置を調べます'}
              onClick={toggleSelect}>選択</button>
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
        {liveSel?.status === 'resolved' && lin && (
          <p className={`rt-note pvlin${lin.status === 'cut' ? ' pvwarn' : ''}`} title={folded ? lineageLine(lin) : undefined}>{lineageLine(lin)}</p>
        )}
        {selectMode && !liveSel && view === 'live' && (
          <p className="rt-note pvsel">選択モード: プレビューの中の要素をクリックしてください（ページは操作されません）。</p>
        )}

        {view === 'live' && (
          <div className="rt-row pvobsrow" data-obs-state={obs ? (obs.exchanges.length ? 'some' : 'none') : obsError ? 'error' : 'loading'}
            data-obs-count={obs?.exchanges.length ?? ''} data-obs-sql={obs ? obsSqlCount : ''}
            data-obs-shown={obsShown?.seq ?? ''} data-obs-session={obs?.session.startedAt ?? ''}
            data-obs-sites={obsSiteCount ?? ''} data-obs-with-sel={obsShown?.withSel ? 'on' : ''}
            data-obs-recorded={obs?.session.recorded ?? ''} data-obs-evicted={obs?.session.retention.evicted ?? ''}
            data-obs-shown-evicted={shownEvicted ? 'on' : ''} data-obs-pending={pendingShow ?? ''}>
            <p className="rt-note pvobs">
              {!obs && !obsError && <>観測（いまの起動）: 取得しています…</>}
              {!obs && obsError && <>観測（いまの起動）: 取得できません — {obsError}</>}
              {obs && !obs.exchanges.length && <>観測（いまの起動）: まだ通信はありません（未観測）。</>}
              {obs && obs.exchanges.length > 0 && <>観測（いまの起動）: 通信 <b>{obs.exchanges.length}</b> 件・SQL <b>{obsSqlCount}</b> 本{obsSiteCount !== null && obsSqlCount > 0 ? <>（実行した呼び出し位置を特定 <b>{obsSiteCount}</b> 本）</> : ''}{obs.session.retention.evicted ? `（直近 ${obs.session.retention.window} 件と最近の文書を保持。古い ${obs.session.retention.evicted} 件は保持対象外）` : ''}</>}
              {obs && obs.instrumentation.state !== 'enabled' && <> サーバー処理・SQL は観測していません（{obs.instrumentation.reason ?? '計装なし'}）。</>}
            </p>
            {obs && obs.exchanges.length > 0 && (
              <>
                <select className="rt-in pvobssel" aria-label="観測した通信" value={obsSel ?? ''}
                  onChange={(e) => setObsPick(Number(e.target.value))}>
                  {obsRows.map(({ e, links }) => (
                    <option key={e.seq} value={e.seq}>
                      {liveExchangeLabel(e)}{links.server ? ` / SQL ${links.sql}` : ' / 処理と未接続'}{links.server && links.sql && links.sited !== null ? ` / 位置 ${links.sited}` : ''}
                    </option>
                  ))}
                </select>
                <button type="button" className="rt-b" disabled={obsSel === null}
                  title="選んだ通信と、そのサーバー処理・SQL・テーブル・カラムをキャンバスと右の詳細に出します"
                  onClick={() => {
                    if (obsSel === null || !obs || !serverKey) return;
                    showObs(obsSel, obs, serverKey);
                    if (!selectMode) setCompact('preview', true);   // 7C-2: 経路を見る操作なので、経路図を優先する
                  }}>表示</button>
                {obsShown && <button type="button" className="rt-b" onClick={() => { clearObs(); if (!liveSel || liveSel.status === 'cleared') setCompact('preview', false); }}>解除</button>}
              </>
            )}
          </div>
        )}
        {view === 'live' && shownEvicted && obsShown && (
          <p className="rt-note pvobs pvwarn pvobsevicted">表示中の通信 #{obsShown.seq} は、観測の保持範囲から外れました（保持対象外）。図は外れる前の証拠のままです。新しい通信を選んで［表示］し直してください。</p>
        )}
        {view === 'live' && obsShown?.withSel && (
          lin?.status === 'linked' && boundSeq === obsShown.seq
            ? <p className="rt-note pvobs pvobspair">選択した要素と、それを描いた文書の通信 #{obsShown.seq} を並べています。値の由来は<b>静的解析による推定</b>で結んでいます（実行時に値を観測したものではありません）。</p>
            : boundSeq === obsShown.seq
              ? <p className="rt-note pvobs pvobspair">選択した要素と、それを描いた文書の通信 #{obsShown.seq} を並べています。<b>値の由来は結んでいません</b>（理由は上の行と右の詳細）。</p>
              : <p className="rt-note pvobs pvobspair">選択した要素と、この通信の SQL を並べています。<b>両者は結んでいません</b>（{boundSeq !== null ? `この要素を描いた文書は通信 #${boundSeq} です` : 'この要素を描いた文書取得がこの通信かは特定していません'}）。</p>
        )}
        {obsNote && view !== 'live' && <p className="rt-note pvobs pvobsnote">{obsNote}</p>}
        {view === 'live' && origin && (
          <div className={`site pvsite${folded ? ' pvstash' : ''}`} aria-hidden={folded || undefined}>
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
