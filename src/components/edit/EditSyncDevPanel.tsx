'use client';
/* =============================================================================
 * 視覚編集 E2.1 — 開発用の同期の表示（**読み取り専用**。docs/08d 第11節）。
 *
 * 表示するのは、IDE を VCIDE_EDIT_SYNC_DEV=1 で起動し、かつ画面を `?editSyncDev=1` で開いたときだけ（2つとも明示）。
 * それ以外では何も描かず、要求も出さない（通常の探索の画面は変わらない）。
 *
 * 出すもの: Desktop（1440×900）・Mobile（375×812）の2枚のアートボード（実際の中継のページ。縮小して表示）と、
 * アートボードごとの接続・文書・選択・編集対象（ファイル・行・列・コンポーネント・3つの版）・文書の照合の段・未確認の理由・
 * 再選択が要るか・要確認の復旧の記録。
 * 出さないもの: 編集の入力・スタイルの変更・差分の適用・ファイルへの書き込み・Undo/Redo（E2.1 には道が無い）。
 *
 * 接続はアートボードごとに独立（MessageChannel・nonce・接続の識別子）。古い MessagePort・別のアートボード・
 * 別の起動の知らせは acceptEditPortMessage で捨てる。位置はサーバーが決める（ブラウザから送らない）。
 * ========================================================================== */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRuntime } from '@/state/RuntimeStore';
import { IDE_SOURCE, PROTOCOL_VERSION, isAgentHello, parseAgentMessage } from '@/lib/previewProtocol';
import {
  ARTBOARDS, ARTBOARD_IDS, acceptEditPortMessage, editObserveMessage, observationBodyOf,
  type ArtboardId, type EditConn, type EditObservation,
} from '@/lib/editPreviewProtocol';
import { EDIT_DOC_REASON_TEXT } from '@/lib/editSyncBinding';
import type { SyncView } from '@/server/editSync/session';

const POST_HEADERS = { 'content-type': 'application/json', 'x-vcide-request': '1' } as const;
const RECHECK_MS = 1500;
const OBSERVE_TIMEOUT_MS = 3000;
const SCALE: Record<ArtboardId, number> = { desktop: 0.3, mobile: 0.333 };

type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
type SyncState = 'selected' | 'verifying' | 'stale' | 'unresolved' | 'disconnected';

interface BoardUi {
  conn: ConnState;
  connId: string | null;
  sync: SyncState | null;
  view: SyncView | null;
  note: string | null;
  loads: number;
  rejected: number;
  rect: EditObservation['rect'];
  style: EditObservation['style'];
  /** 選択の結果を受けた回数（画面の試験が「新しい結果」を待つため） */
  selN: number;
}
const emptyBoard = (): BoardUi => ({ conn: 'connecting', connId: null, sync: null, view: null, note: null, loads: 0, rejected: 0, rect: null, style: null, selN: 0 });

interface DevState {
  ideBoot: string; write: { enabled: boolean; reason: string; detail: string };
  recovery: { status: string; needsAttention?: number; entries?: { txId: string; file: string; state: string; plannedAction: string; needsAttention: boolean }[]; mutates?: false; message?: string };
}

function rid(n = 18): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const short = (s: string | null | undefined, n = 8) => (s ? s.slice(0, n) : '—');

export default function EditSyncDevPanel() {
  const [wanted, setWanted] = useState(false);
  const [dev, setDev] = useState<DevState | null>(null);
  useEffect(() => {
    try { setWanted(new URLSearchParams(window.location.search).get('editSyncDev') === '1'); } catch { setWanted(false); }
  }, []);
  /* 状態（書き込みの可否・復旧の点検）。有効でなければ 404 で、何も描かない */
  useEffect(() => {
    if (!wanted) return undefined;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/edit-sync/state', { cache: 'no-store' });
        if (!alive) return;
        if (r.status !== 200) { setDev(null); return; }
        setDev(await r.json() as DevState);
      } catch { if (alive) setDev(null); }
    };
    void load();
    const t = window.setInterval(() => { void load(); }, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, [wanted]);
  if (!wanted || !dev) return null;
  return <Panel dev={dev} />;
}

function Panel({ dev }: { dev: DevState }) {
  const { runtime, preview } = useRuntime();
  const running = runtime?.state === 'running' && !!runtime.pid && !!runtime.startedAt;
  const origin = preview?.origin ?? null;
  const serverKey = running ? `${runtime!.instance}:${runtime!.pid}:${runtime!.startedAt}` : null;
  const [boards, setBoards] = useState<Record<ArtboardId, BoardUi>>({ desktop: emptyBoard(), mobile: emptyBoard() });
  const [keys, setKeys] = useState<Record<ArtboardId, number>>({ desktop: 0, mobile: 0 });
  const [selectMode, setSelectMode] = useState(false);
  /** 2枚が表示するパス（利用者が入力する。既定は /。別の origin へは出さない） */
  const [path, setPath] = useState('/');
  const [addr, setAddr] = useState('/');
  const frames = useRef<Record<ArtboardId, HTMLIFrameElement | null>>({ desktop: null, mobile: null });
  const conns = useRef<Record<ArtboardId, { current: EditConn | null; port: MessagePort | null; pending: { c: EditConn; port: MessagePort }[] }>>({
    desktop: { current: null, port: null, pending: [] }, mobile: { current: null, port: null, pending: [] },
  });
  const waiters = useRef(new Map<string, (o: EditObservation | null) => void>());
  const reqSeq = useRef(0);
  const nowRef = useRef({ serverKey, ideBoot: dev.ideBoot as string | null });
  nowRef.current = { serverKey, ideBoot: dev.ideBoot };
  const runRef = useRef(runtime);
  runRef.current = runtime;
  const selectRef = useRef(selectMode);
  selectRef.current = selectMode;
  const boardsRef = useRef(boards);
  boardsRef.current = boards;

  const patch = useCallback((a: ArtboardId, p: Partial<BoardUi> | ((b: BoardUi) => Partial<BoardUi>)) => {
    setBoards((all) => ({ ...all, [a]: { ...all[a], ...(typeof p === 'function' ? p(all[a]) : p) } }));
  }, []);

  const runKey = () => {
    const rt = runRef.current;
    return rt?.pid && rt.startedAt ? { instance: rt.instance, pid: rt.pid, startedAt: rt.startedAt } : null;
  };
  const post = async (op: string, payload: Record<string, unknown>): Promise<SyncView | null> => {
    try {
      const r = await fetch(`/api/edit-sync/${op}`, { method: 'POST', headers: POST_HEADERS, body: JSON.stringify(payload) });
      if (r.status !== 200) return null;
      return await r.json() as SyncView;
    } catch { return null; }
  };

  /** そのアートボードのいまの接続に観測を1回求める（答えはいまの接続・同じ nonce・同じ求めの番号からだけ受ける） */
  const observe = useCallback((a: ArtboardId): Promise<{ conn: EditConn; o: EditObservation } | null> => {
    const st = conns.current[a];
    const c = st.current;
    if (!c || !st.port) return Promise.resolve(null);
    const req = ++reqSeq.current;
    return new Promise((resolve) => {
      const key = `${c.id}:${req}`;
      const t = window.setTimeout(() => { waiters.current.delete(key); resolve(null); }, OBSERVE_TIMEOUT_MS);
      waiters.current.set(key, (o) => { window.clearTimeout(t); waiters.current.delete(key); resolve(o ? { conn: c, o } : null); });
      st.port!.postMessage(editObserveMessage(c.nonce, req));
    });
  }, []);

  const applyView = useCallback((a: ArtboardId, connId: string, v: SyncView | null, o: EditObservation | null) => {
    if (conns.current[a].current?.id !== connId) return;      // 待つ間に接続が替わった（古い答え）
    if (!v) { patch(a, { sync: 'disconnected', note: 'IDE のサーバーから答えがありません' }); return; }
    patch(a, {
      view: v, sync: v.status, note: null,
      ...(o ? { rect: o.rect, style: o.style } : {}),
      ...(v.status === 'disconnected' ? { conn: 'disconnected' as const } : {}),
    });
  }, [patch]);

  /* ---------------------------------------------------- 接続（アートボードごと） */
  const onPortMessage = useCallback((a: ArtboardId, c: EditConn, port: MessagePort, data: unknown) => {
    const st = conns.current[a];
    const d = data as { kind?: unknown; req?: unknown } | null;
    if (d && d.kind === 'edit-observation') {
      const r = acceptEditPortMessage(c, st.current, a, nowRef.current, data);
      const key = `${c.id}:${typeof d.req === 'number' ? d.req : ''}`;
      if (!r.ok) { patch(a, (b) => ({ rejected: b.rejected + 1 })); waiters.current.get(key)?.(null); return; }
      waiters.current.get(key)?.(r.observation);
      return;
    }
    const m = parseAgentMessage(data, c.nonce);
    if (!m || c.serverKey !== nowRef.current.serverKey || c.ideBoot !== nowRef.current.ideBoot) { patch(a, (b) => ({ rejected: b.rejected + 1 })); return; }
    if (st.current?.id !== c.id) {
      const i = st.pending.findIndex((p) => p.c.id === c.id);
      if (i < 0) { patch(a, (b) => ({ rejected: b.rejected + 1 })); return; }
      try { st.port?.close(); } catch { /* 閉じている */ }
      st.pending.slice(0, i).forEach((p) => { try { p.port.close(); } catch { /* 閉じている */ } });
      st.pending = st.pending.slice(i + 1);
      st.current = c; st.port = port;
      /* 新しい文書。前の文書で選んだ要素は引き継がない（サーバーの登録も置き換わる） */
      /* スクリプトと port がつながっただけでは connected と言わない（サーバーが接続を登録してから） */
      patch(a, (b) => ({
        conn: b.conn === 'reconnecting' ? 'reconnecting' : 'connecting', connId: c.id, view: null, rect: null, style: null,
        sync: b.view && b.view.status === 'selected' ? 'stale' : null,
        note: b.view && b.view.status === 'selected' ? '文書が読み込み直されました。前の文書で選んだ要素は引き継ぎません（再選択が必要）' : null,
      }));
      port.postMessage({ source: IDE_SOURCE, v: PROTOCOL_VERSION, nonce: c.nonce, kind: 'mode', select: selectRef.current });
      void (async () => {
        const got = await observe(a);
        const run = runKey();
        if (!got || !run) {
          if (conns.current[a].current?.id === c.id) patch(a, { conn: 'disconnected', note: 'プレビューのスクリプトから観測の答えがありません（接続を登録していません）' });
          return;
        }
        const v = await post('connect', { ideBoot: c.ideBoot, run, artboard: a, conn: c.id, observation: observationBodyOf(got.o), path: got.o.selection?.path ?? null });
        if (conns.current[a].current?.id !== c.id) return;
        if (!v) { patch(a, { conn: 'disconnected', note: 'IDE のサーバーが接続を登録しませんでした' }); return; }
        const ident = v.connection.status === 'identified';
        /* 新しい文書の接続。前の文書で選んでいたなら stale（再選択が必要）のまま、表示は新しい接続の結果にする */
        patch(a, (b) => ({ conn: ident ? 'connected' : 'disconnected', view: v, sync: !ident ? 'disconnected' : b.sync === 'stale' ? 'stale' : null }));
      })();
    }
    if (m.kind === 'ready') patch(a, (b) => ({ loads: b.loads + 1 }));
    if (m.kind === 'select') {
      if (!selectRef.current) { patch(a, (b) => ({ rejected: b.rejected + 1 })); return; }
      patch(a, { sync: 'verifying', note: null });
      void (async () => {
        const got = await observe(a);
        const run = runKey();
        if (!got || !run) { applyView(a, c.id, null, null); patch(a, (b) => ({ selN: b.selN + 1 })); return; }
        const v = await post('select', { ideBoot: c.ideBoot, run, artboard: a, conn: c.id, observation: observationBodyOf(got.o) });
        applyView(a, c.id, v, got.o);
        patch(a, (b) => ({ selN: b.selN + 1 }));
      })();
    }
  }, [patch, observe, applyView]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!origin || e.origin !== origin || !serverKey) return;
      const a = ARTBOARD_IDS.find((x) => frames.current[x]?.contentWindow === e.source);
      if (!a) return;                                   // このパネルの iframe ではない（探索のプレビューなど）
      const win = frames.current[a]!.contentWindow!;
      if (!isAgentHello(e.data)) { patch(a, (b) => ({ rejected: b.rejected + 1 })); return; }
      const ch = new MessageChannel();
      const c: EditConn = { artboard: a, id: rid(), nonce: rid(), serverKey, ideBoot: dev.ideBoot };
      ch.port1.onmessage = (ev) => onPortMessage(a, c, ch.port1, ev.data);
      const st = conns.current[a];
      st.pending = [...st.pending.slice(-3), { c, port: ch.port1 }];
      win.postMessage({ source: IDE_SOURCE, v: PROTOCOL_VERSION, kind: 'connect', nonce: c.nonce }, origin, [ch.port2]);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [origin, serverKey, dev.ideBoot, onPortMessage, patch]);

  /* 開発サーバーが入れ替わった・止まった: すべての接続を閉じ、選択を外す（前の起動の要素を引き継がない） */
  const closeBoard = useCallback((a: ArtboardId) => {
    const st = conns.current[a];
    const c = st.current;
    if (c) void post('disconnect', { ideBoot: c.ideBoot, artboard: a, conn: c.id });
    [st.port, ...st.pending.map((p) => p.port)].forEach((p) => { try { p?.close(); } catch { /* 閉じている */ } });
    conns.current[a] = { current: null, port: null, pending: [] };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    for (const a of ARTBOARD_IDS) closeBoard(a);
    setBoards({ desktop: emptyBoard(), mobile: emptyBoard() });
    setKeys((k) => ({ desktop: k.desktop + 1, mobile: k.mobile + 1 }));
  }, [serverKey, dev.ideBoot, closeBoard]);
  useEffect(() => () => { for (const a of ARTBOARD_IDS) closeBoard(a); }, [closeBoard]);

  /* 選択モードを両方のアートボードへ */
  useEffect(() => {
    for (const a of ARTBOARD_IDS) {
      const st = conns.current[a];
      if (st.current && st.port) st.port.postMessage({ source: IDE_SOURCE, v: PROTOCOL_VERSION, nonce: st.current.nonce, kind: 'mode', select: selectMode });
    }
  }, [selectMode]);

  /* 選んでいる要素の再照合（HMR・再描画の後）。失効したら戻さない */
  useEffect(() => {
    let alive = true;
    const t = window.setInterval(() => {
      for (const a of ARTBOARD_IDS) {
        const b = boardsRef.current[a];
        const c = conns.current[a].current;
        if (!alive || !c || b.sync !== 'selected' || !b.view?.source) continue;
        const targetId = b.view.source.targetId;
        void (async () => {
          const got = await observe(a);
          const run = runKey();
          if (!alive || !run) return;
          if (!got) { applyView(a, c.id, { ...b.view!, status: 'stale', reason: 'dom-detached', detail: 'プレビューのスクリプトから答えがありません', reselect: true }, null); return; }
          const v = await post('recheck', { ideBoot: c.ideBoot, run, artboard: a, conn: c.id, targetId, observation: observationBodyOf(got.o) });
          if (boardsRef.current[a].view?.source?.targetId !== targetId) return;   // その間に選び直した
          applyView(a, c.id, v, got.o);
        })();
      }
    }, RECHECK_MS);
    return () => { alive = false; window.clearInterval(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observe, applyView]);

  const reload = (a: ArtboardId) => {
    closeBoard(a);
    patch(a, (b) => ({
      conn: 'reconnecting', connId: null, rect: null, style: null,
      sync: b.view && b.view.status === 'selected' ? 'stale' : b.sync,
      note: b.view && b.view.status === 'selected' ? '文書を読み込み直します。前の文書で選んだ要素は引き継ぎません（再選択が必要）' : b.note,
    }));
    setKeys((k) => ({ ...k, [a]: k[a] + 1 }));
  };

  const go = () => {
    const v = addr.trim() || '/';
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//')) return;
    const p = v.startsWith('/') ? v : `/${v}`;
    for (const a of ARTBOARD_IDS) reload(a);
    setPath(p); setAddr(p);
  };

  if (!running || !origin) {
    return (
      <section className="fpnl" aria-label="編集の同期（開発用）" data-edit-sync-dev="waiting"
        style={{ left: 16, bottom: 48, width: 420, padding: '8px 12px', fontSize: 11.5 }} onPointerDown={(e) => e.stopPropagation()}>
        <header className="fh">編集の同期<i>開発用・読み取り専用</i></header>
        <p style={{ color: 'var(--tx3)', margin: '6px 0' }}>開発サーバーを起動すると、Desktop・Mobile の2枚のプレビューを表示します。</p>
        <Recovery dev={dev} />
      </section>
    );
  }

  return (
    <section className="fpnl" aria-label="編集の同期（開発用）" data-edit-sync-dev="on" data-ide-boot={dev.ideBoot}
      data-write-enabled={dev.write.enabled ? 'on' : 'off'} data-select-mode={selectMode ? 'on' : 'off'}
      style={{ left: 16, bottom: 48, width: 760, maxHeight: '78%', overflow: 'auto', padding: '0 0 8px', fontSize: 11 }}
      onPointerDown={(e) => e.stopPropagation()}>
      <header className="fh">
        編集の同期<i>開発用・読み取り専用（編集・書き込みはできません）</i>
        <span className="r">
          <button type="button" className={`rt-b${selectMode ? ' go' : ''}`} aria-pressed={selectMode} data-edit-select
            onClick={() => setSelectMode((s) => !s)}>選択</button>
        </span>
      </header>
      <p style={{ color: 'var(--tx3)', margin: '4px 12px' }}>
        書き込み: <b data-write-gate>{dev.write.enabled ? '有効（この画面からは使えません）' : `無効（${dev.write.reason}）`}</b>。
        位置はプレビューの申告ではなく、IDE が対応表とソースの読み直しで決めます。描画（DOM が応答どおりか）は確かめていません。
      </p>
      <div className="rt-row" style={{ padding: '0 12px', gap: 6 }}>
        <input className="rt-in" aria-label="編集の同期のパス" data-edit-path value={addr} spellCheck={false}
          onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
        <button type="button" className="rt-b" data-edit-go onClick={go}>移動</button>
      </div>
      <div style={{ display: 'flex', gap: 12, padding: '4px 12px', alignItems: 'flex-start' }}>
        {ARTBOARD_IDS.map((a) => {
          const spec = ARTBOARDS[a];
          const s = SCALE[a];
          const b = boards[a];
          return (
            <div key={a} style={{ flex: 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--tx2)' }}>
                <span>{spec.label} {spec.width}×{spec.height}</span>
                <button type="button" className="rt-b" data-edit-reload={a} onClick={() => reload(a)}>↻</button>
              </div>
              <div style={{ width: spec.width * s, height: spec.height * s, overflow: 'hidden', border: '1px solid var(--edge)', borderRadius: 6, background: '#fff' }}>
                <iframe key={`${a}:${keys[a]}`} ref={(el) => { frames.current[a] = el; }} title={`編集の同期 ${spec.label}`}
                  data-edit-frame={a} src={`${origin}${path}`} width={spec.width} height={spec.height}
                  style={{ width: spec.width, height: spec.height, border: 0, transform: `scale(${s})`, transformOrigin: '0 0' }}
                  sandbox="allow-scripts allow-same-origin allow-forms" />
              </div>
            </div>
          );
        })}
      </div>
      {ARTBOARD_IDS.map((a) => <BoardRow key={a} a={a} b={boards[a]} />)}
      <div style={{ padding: '0 12px' }}><Recovery dev={dev} /></div>
    </section>
  );
}

function BoardRow({ a, b }: { a: ArtboardId; b: BoardUi }) {
  const v = b.view;
  const src = v?.source ?? null;
  const doc = v?.document ?? null;
  const reasons = [
    ...(v?.reason && v.status !== 'selected' ? [`${v.reason}: ${v.detail}`] : []),
    ...(doc?.reasons ?? []).map((r) => `${r}: ${EDIT_DOC_REASON_TEXT[r]}`),
    ...(b.note ? [b.note] : []),
  ];
  const refetch = doc?.refetch.status === 'self' ? `自分の取り直し ${doc.refetch.count} 件` : doc?.refetch.status === 'none' ? 'なし' : doc?.refetch.status ?? '—';
  const reselect = b.sync === 'stale' || b.sync === 'disconnected' || (!!v && v.reselect && v.status !== 'selected' && v.reason !== 'not-selected');
  return (
    <div data-edit-board={a} data-conn-state={b.conn} data-conn-id={b.connId ?? ''} data-sync={b.sync ?? ''}
      data-sync-reason={b.sync === 'selected' ? '' : (v?.reason ?? '')} data-at={src ? `${src.file}:${src.line}:${src.col}` : ''}
      data-component={src?.component ?? ''} data-tag={src?.tag ?? ''} data-dom-rev={src?.domRev ?? ''} data-source-rev={src?.sourceRev ?? ''}
      data-manifest-rev={src?.manifestRev ?? ''} data-fingerprint={src?.fingerprint ?? ''} data-target-id={src?.targetId ?? ''}
      data-doc-level={doc?.level ?? ''} data-doc-reasons={(doc?.reasons ?? []).join(',')} data-refetch={doc?.refetch.status ?? ''}
      data-refetch-count={doc?.refetch.status === 'self' ? doc.refetch.count : ''} data-render={doc?.render ?? ''}
      data-doc-token={v?.instance?.docToken ?? ''} data-ordinal={v?.instance?.ordinal ?? ''} data-count={v?.instance?.count ?? ''}
      data-instance-anchor={v?.instance?.anchorId ?? ''} data-reselect={reselect ? 'yes' : 'no'} data-loads={b.loads} data-rejected={b.rejected} data-sel-n={b.selN}
      data-connection={v?.connection.status ?? ''}
      style={{ margin: '6px 12px 0', padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 6, lineHeight: 1.6 }}>
      <b style={{ color: 'var(--tx)' }}>{ARTBOARDS[a].label}</b>{' '}
      <span>接続: {b.conn}{b.connId ? `（${short(b.connId)}）` : ''}・選択: <b>{b.sync ?? '—'}</b>{reselect ? '・再選択が必要' : ''}</span>
      {src && (
        <div>
          <b>{src.component ?? '—'}</b> <code>{src.file}:{src.line}:{src.col}</code> &lt;{src.tag}&gt;
          {v?.instance && v.instance.count > 1 && <> — 同じ JSX の要素 {v.instance.count} 個のうち {(v.instance.ordinal ?? 0) + 1} 番目（どの利用箇所かは区別していません）</>}
        </div>
      )}
      <div style={{ color: 'var(--tx2)' }}>
        DOM の版 <code>{short(src?.domRev, 16)}</code>・ソースの版 <code>{short(src?.sourceRev, 16)}</code>・対応表の版 <code>{short(src?.manifestRev, 16)}</code>
      </div>
      <div style={{ color: 'var(--tx2)' }}>
        文書: {doc ? (doc.level === 'document-identified' ? '中継の応答と照合済み' : '未確認') : '—'}（文書 {short(v?.instance?.docToken ?? null)}）・取り直し: {refetch}・描画: 未検証
        {b.rect && <>・矩形 {Math.round(b.rect.width)}×{Math.round(b.rect.height)}（表示用）</>}
      </div>
      {reasons.length > 0 && <ul style={{ margin: '2px 0 0 16px', color: 'var(--amber)' }}>{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
    </div>
  );
}

function Recovery({ dev }: { dev: DevState }) {
  const r = dev.recovery;
  const n = r.needsAttention ?? 0;
  return (
    <p data-edit-recovery={r.status} data-recovery-attention={n} style={{ color: n ? 'var(--amber)' : 'var(--tx3)', margin: '6px 0 0' }}>
      復旧の点検（読むだけ。自動で書き戻し・削除はしません）: {r.status === 'inspected'
        ? (n ? `要確認の記録 ${n} 件（${(r.entries ?? []).filter((e) => e.needsAttention || e.plannedAction !== 'none').map((e) => `${e.file} ${e.state} → ${e.plannedAction}`).join(' / ')}）` : '要確認の記録はありません')
        : r.status === 'no-project' ? 'プロジェクトを選ぶと点検します' : `点検できません（${r.message ?? r.status}）`}
    </p>
  );
}
