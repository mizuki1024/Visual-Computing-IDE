'use client';
/* =============================================================================
 * 実行状態（Phase 7A）。プロジェクトの検出と、開発サーバーの起動・停止を持つ。
 *
 * **画面は状態を作らない。** 表示する状態はすべて `/api/runtime/status` の
 * 観測結果であり、ボタンを押したことを根拠に `running` と書かない（指示 2.D）。
 * ========================================================================== */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import type { DevServerSnapshot, RunState } from '@/server/devServer';
import type { Finding, ProjectInspection } from '@/server/projectInspect';
import { isNewerSnapshot } from '@/lib/snapshotOrder';

export type { DevServerSnapshot, RunState, Finding, ProjectInspection };

/** 最後に開いたプロジェクト（S-01 の「最近開いたプロジェクト」の最小形） */
const LAST_PATH_KEY = 'vcide.lastProjectPath';

/** 状態ごとの表示名。03c 8節の語を使う。 */
export const RUN_STATE_LABEL: Record<RunState, string> = {
  idle: '未起動',
  validating: '構成を検証中',
  starting: '起動中',
  running: '実行中',
  stopping: '停止処理中',
  stopped: '停止しています',
  error: '起動できていません',
};

/** 観測が進む状態では短い間隔で見る。落ち着いたら間隔を広げる。 */
const POLL_MS: Record<RunState, number> = {
  idle: 6000, validating: 1000, starting: 900, running: 3000,
  stopping: 700, stopped: 6000, error: 6000,
};
/** 操作の応答を待っている間の間隔 */
const PENDING_POLL_MS = 500;

interface Ctx {
  /** 入力中のパス */
  pathInput: string;
  setPathInput: (v: string) => void;
  portInput: string;
  setPortInput: (v: string) => void;
  instrument: boolean;
  setInstrument: (v: boolean) => void;

  /** サーバー側の観測結果。未取得なら null */
  runtime: DevServerSnapshot | null;
  inspection: ProjectInspection | null;
  logs: { lines: string[]; available: boolean; total: number } | null;
  /** 操作中（応答を待っている） */
  pending: null | 'inspect' | 'start' | 'stop';
  /** API 自体が失敗したときの説明。状態とは別に持つ */
  apiError: string | null;

  inspect: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refreshLogs: () => Promise<void>;
}

const RuntimeCtx = createContext<Ctx | null>(null);

const POST_HEADERS = {
  'content-type': 'application/json',
  // 変更操作に必要（guard.ts）。単純要求にしないための独自ヘッダ
  'x-vcide-request': '1',
} as const;

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [pathInput, setPathInput] = useState('');
  const [portInput, setPortInput] = useState('');
  const [instrument, setInstrument] = useState(true);
  const [runtime, setRuntime] = useState<DevServerSnapshot | null>(null);
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [logs, setLogs] = useState<Ctx['logs']>(null);
  const [pending, setPending] = useState<Ctx['pending']>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  const restoredRef = useRef(false);

  const acceptRuntime = useCallback((incoming: DevServerSnapshot) => {
    setRuntime((prev) => (isNewerSnapshot(prev, incoming) ? incoming : prev));
  }, []);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(LAST_PATH_KEY);
      if (v) setPathInput(v);
    } catch { /* 使えない環境では覚えない */ }
  }, []);

  const remember = useCallback((p: string) => {
    try { window.localStorage.setItem(LAST_PATH_KEY, p); } catch { /* 覚えないだけ */ }
  }, []);

  /** 状態の取得。操作中も止めない。新旧は `isNewerSnapshot` が決める */
  const poll = useCallback(async () => {
    try {
      const r = await fetch('/api/runtime/status', { headers: { accept: 'application/json' } });
      const j = await r.json() as { runtime?: DevServerSnapshot; inspection?: ProjectInspection | null; error?: { message: string } };
      if (j.error) { setApiError(j.error.message); return; }
      setApiError(null);
      if (j.runtime) acceptRuntime(j.runtime);
      if (j.inspection) {
        // 画面を開き直したとき、サーバーが持つ直近の検出結果を戻す。
        // その結果がどのパスのものかを入力欄にも戻す（入力が空なのに検出結果だけが
        // 出ている状態を作らない）。利用者が入力を消した後に何度も戻さないよう、一度だけ行う
        const restored = j.inspection;
        setInspection((prev) => prev ?? restored);
        if (!restoredRef.current) {
          restoredRef.current = true;
          setPathInput((p) => (p.trim() ? p : restored.input));
        }
      }
    } catch (e) {
      setApiError(e instanceof Error ? e.message : String(e));
    }
  }, [acceptRuntime]);

  const refreshLogs = useCallback(async () => {
    try {
      const r = await fetch('/api/runtime/logs?limit=120', { headers: { accept: 'application/json' } });
      const j = await r.json() as { lines?: string[]; available?: boolean; total?: number; error?: unknown };
      if (Array.isArray(j.lines)) {
        setLogs({ lines: j.lines, available: !!j.available, total: j.total ?? j.lines.length });
      }
    } catch { /* 出力が取れないことは状態に影響しない */ }
  }, []);

  /* 初回と、状態に応じた間隔での取得。
   * 操作の応答を待っている間は、状態が変わり始めるのを見逃さないよう短い間隔で見る
   * （クリック直後の状態は idle のままなので、idle の間隔では最長 6 秒遅れる） */
  const state = runtime?.state ?? 'idle';
  const interval = pending ? PENDING_POLL_MS : POLL_MS[state];
  useEffect(() => {
    void poll();
    const id = window.setInterval(() => { void poll(); }, interval);
    return () => window.clearInterval(id);
  }, [poll, interval]);

  /* 起動中・失敗後は出力を見たい。起動中は進み具合が変わるたびに取り直す */
  useEffect(() => {
    if (state === 'starting' || state === 'error' || state === 'running') void refreshLogs();
  }, [state, refreshLogs, runtime?.seq, runtime?.progress?.at]);

  const call = useCallback(async (
    kind: NonNullable<Ctx['pending']>, url: string, payload: unknown,
  ) => {
    setPending(kind);
    setApiError(null);
    try {
      const r = await fetch(url, {
        method: 'POST', headers: POST_HEADERS, body: JSON.stringify(payload ?? {}),
      });
      const j = await r.json() as {
        runtime?: DevServerSnapshot; inspection?: ProjectInspection | null;
        error?: { message: string };
      };
      if (j.runtime) acceptRuntime(j.runtime);
      if (j.inspection !== undefined) setInspection(j.inspection ?? null);
      if (j.error) setApiError(j.error.message);
    } catch (e) {
      setApiError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
      void refreshLogs();
    }
  }, [acceptRuntime, refreshLogs]);

  const inspect = useCallback(async () => {
    remember(pathInput);
    await call('inspect', '/api/runtime/project', { path: pathInput });
  }, [call, pathInput, remember]);

  const start = useCallback(async () => {
    remember(pathInput);
    const port = portInput.trim();
    await call('start', '/api/runtime/start', {
      project: pathInput,
      port: port ? Number(port) : undefined,
      instrument,
    });
  }, [call, pathInput, portInput, instrument, remember]);

  const stop = useCallback(async () => {
    await call('stop', '/api/runtime/stop', {});
  }, [call]);

  const value = useMemo<Ctx>(() => ({
    pathInput, setPathInput, portInput, setPortInput, instrument, setInstrument,
    runtime, inspection, logs, pending, apiError,
    inspect, start, stop, refreshLogs,
  }), [pathInput, portInput, instrument, runtime, inspection, logs, pending, apiError,
    inspect, start, stop, refreshLogs]);

  return <RuntimeCtx.Provider value={value}>{children}</RuntimeCtx.Provider>;
}

export function useRuntime(): Ctx {
  const v = useContext(RuntimeCtx);
  if (!v) throw new Error('RuntimeProvider の外で useRuntime を呼んでいます');
  return v;
}
