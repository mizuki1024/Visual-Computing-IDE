/* =============================================================================
 * 開発サーバーの起動・停止・状態（Phase 7A 指示 2.B / 2.C / 2.D）。
 *
 * 守っていること
 *   1. **起動コマンドを出しただけで `running` にしない。** HTTP の応答を見て決める
 *   2. **所有を1か所に台帳として持つ。** モジュール変数だけに頼らない
 *      - 同じプロセス内の再評価（HMR）  → globalThis の単一実体
 *      - IDE プロセスの再起動・異常終了 → `.ide-runtime/dev-server.json` から引き継ぐ
 *   3. **対象プロジェクトに書き込まない。** 計装は NODE_OPTIONS の前置だけで行う
 *   4. **任意のコマンドを実行しない。** 起動するのは対象の node_modules の next だけ
 * ========================================================================== */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ideRoot, runtimeDir, spanDirPath, stateFilePath } from './ide';
import { cleanupSpanFiles, type SpanCleanupResult } from './spanFiles';
import {
  groupAlive, httpResponds, isPortFree, pidAlive, pidCommand, sleep, waitPortFree,
} from './net';
import {
  inspectProject, isStartable, START_WAIT_SEC, type Finding, type ProjectInspection,
} from './projectInspect';
import { redactAll } from './redact';
import { childEnvReport } from './childEnv';
import { anchorEnv, anchorSupport, type AnchorSupport } from './anchors';
import { observations } from './observations';

/** 指示 2.D の7状態。これ以外の状態を作らない。 */
export type RunState =
  | 'idle' | 'validating' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

/** INS-08 / ST-25。「適用不可」と「失敗」を混同しない。 */
export type InstrumentationState = 'enabled' | 'disabled' | 'unavailable';

/** FR-31 / INS-08。外部起動のプロセスに計装は適用されない。 */
export type Owner = 'ide' | 'ide-previous-session' | 'external';

export interface DevServerSnapshot {
  state: RunState;
  /** 状態が変わるたびに増える。画面の取り違えを防ぐため */
  seq: number;
  /**
   * この管理実体の識別子。IDE のプロセスが入れ替わると seq は 0 から数え直すため、
   * **seq の大小は同じ instance の間でしか比べられない。**
   */
  instance: string;
  /**
   * 起動中に Next.js が出した、進み具合を表す最後の行（`Compiling` / `Ready` など）。
   * 状態ではない。IDE が解釈せず、出力をそのまま見せるためにある。
   */
  progress: { line: string; at: string } | null;
  /**
   * 開発サーバーの実行中に、対象プロジェクトの中で変化を観測したファイル。
   * IDE は書き込まないため、書き込んだのは IDE の外（主に next dev）である。
   */
  targetChanges: Finding | null;
  project: { root: string; name: string } | null;
  pid: number | null;
  port: number | null;
  url: string | null;
  owner: Owner | null;
  startedAt: string | null;
  readyAt: string | null;
  readyMs: number | null;
  exitCode: number | null;
  signal: string | null;
  instrumentation: { state: InstrumentationState; reason: string | null; spanFile: string | null };
  /** 直近の HTTP 応答の観測。**「起動した」とは別の事実として持つ** */
  lastProbe: { at: string; ok: boolean; status: number | null; detail: string | null } | null;
  /** 異常系の説明（03d の4要素）。正常時は null */
  error: Finding | null;
  /** 標準出力・エラー出力を保持している行数。0 は「持っていない」 */
  logLines: number;
  /** 出力を取得できるか。引き継いだプロセスでは取れない */
  logAvailable: boolean;
  /**
   * 起動先に渡した環境変数（Phase 7B-1）。**名前だけ**を持ち、値は持たない。
   * 渡さなかった変数は数だけを持つ。引き継いだプロセスでは不明（null）
   */
  env: { passed: string[]; withheld: number; explicit: string[] } | null;
  /**
   * 要素識別子の注入（Phase 7B-2。PoC-03 方式1）。起動したときに決まる。
   * 未起動なら null。IDE は対象の next.config を書き換えないので、設定が無ければ unavailable
   */
  anchors: AnchorSupport | null;
  updatedAt: string;
}

export interface StartRequest {
  /** 利用者が入力したプロジェクトのパス */
  project: string;
  /** 省略時は空いているポートを選ぶ */
  port?: number;
  /** 既定は true（使える場合のみ）。false なら計装なしで起動する */
  instrument?: boolean;
}

/** 台帳の中身。IDE の再起動をまたいで所有を引き継ぐための最小情報。 */
interface OwnershipRecord {
  pid: number;
  port: number;
  projectRoot: string;
  projectName: string;
  /** 直接の子のコマンド行に必ず現れる文字列。PID 再利用の判定に使う */
  fingerprint: string;
  startedAt: string;
  readyAt: string | null;
  instrumentation: { state: InstrumentationState; reason: string | null; spanFile: string | null };
  /** 要素識別子の注入（Phase 7B-2）。古い記録には無い */
  anchors?: AnchorSupport;
  /** 記録を書いた IDE プロセス */
  ideOwnerPid: number;
}

const LOG_CAP = 400;
/**
 * 起動の待ち時間。`VCIDE_START_TIMEOUT_MS` は **テストだけ** が使う（IDE 自身の環境変数であり、
 * 画面や API からは変えられない）。待ちが切れる経路を180秒待たずに確かめるためにある。
 */
const START_TIMEOUT_MS = (() => {
  const v = Number(process.env.VCIDE_START_TIMEOUT_MS);
  return Number.isInteger(v) && v >= 1000 ? v : START_WAIT_SEC * 1000;
})();
/** 起動中の進み具合として画面に出す行。Next.js の出力の語をそのまま使う */
const PROGRESS_RE = /(Compiling|Compiled|Ready in|Starting|Local:|Network:|Creating an optimized|Installing|reconfigured your)/i;
/** Next.js がワークスペースのルートを推定したことを示す出力 */
const ROOT_INFERENCE_RE = /(inferred your workspace root|multiple lockfiles|Detected additional lockfiles)/i;
/** next dev が書き換えうる対象のファイル（R4）。内容の指紋を起動前後で比べる */
const WATCHED_TARGET_FILES = ['tsconfig.json', 'next-env.d.ts', 'package.json'];

/** 子に渡す環境は childEnv.ts が決める（Phase 7B-1 で許可リスト方式に変えた） */
export { childEnv, childEnvReport } from './childEnv';

type FileFingerprint = string | null;   // 内容の sha1。無ければ null

function fingerprint(file: string): FileFingerprint {
  try { return createHash('sha1').update(fs.readFileSync(/* turbopackIgnore: true */ file)).digest('hex'); } catch { return null; }
}
const PROBE_INTERVAL_MS = 300;
/** 7C-1: 停止・異常終了の後に収集ファイルの整理をやり直す時刻（ワーカーの終了を待つ） */
const SPAN_CLEANUP_RETRY_MS = [3_000, 20_000];
const STOP_TERM_WAIT_MS = 8_000;
const STOP_KILL_WAIT_MS = 3_000;
const PORT_RANGE = { from: 3000, to: 3030 };

/** 起動に失敗したことの説明。03d 1.1節の4要素で書く。 */
const E = {
  portInUse: (port: number): Finding => ({
    code: 'port-in-use', severity: 'blocker',
    fact: `ポート ${port} は既に使われています。`,
    reason: '別のプロセスが同じポートで待ち受けています。',
    impact: '開発サーバーを起動できないため、実行時の情報は取得できません。',
    action: '別のポートを指定するか、そのポートを使っているプロセスを停止してください。',
  }),
  noFreePort: (): Finding => ({
    code: 'no-free-port', severity: 'blocker',
    fact: `${PORT_RANGE.from}〜${PORT_RANGE.to} に空いているポートがありません。`,
    reason: 'いずれのポートも既に使われています。',
    impact: '開発サーバーを起動できません。',
    action: 'ポートを明示して指定してください。',
  }),
  anotherDevServer: (detail: string): Finding => ({
    code: 'another-dev-server-running', severity: 'blocker',
    fact: 'このプロジェクトの開発サーバーが既に起動しているため、起動できませんでした。',
    reason: `Next.js が「別の開発サーバーが起動している」と報告しました。${detail}`,
    impact: '外部で起動されたプロセスには計装が適用されないため、サーバー内部の処理と SQL は観測できません（INS-08）。',
    action: '外部のサーバーを停止してから、IDE から起動し直してください。',
  }),
  spawnFailed: (detail: string): Finding => ({
    code: 'spawn-failed', severity: 'blocker',
    fact: '開発サーバーのプロセスを起動できませんでした。',
    reason: detail,
    impact: '実行時の情報は取得できません。',
    action: 'もう一度試してください。',
  }),
  exitedDuringStart: (code: number | null, signal: string | null, tail: string[]): Finding => ({
    code: 'exited-during-start', severity: 'blocker',
    fact: `開発サーバーが起動の途中で終了しました（${signal ? `シグナル ${signal}` : `終了コード ${code}`}）。`,
    reason: tail.length ? `最後の出力:\n${tail.join('\n')}` : '出力がありません。理由を特定できません。',
    impact: '実行時の情報は取得できません。',
    action: '出力の内容を直してから、もう一度試してください。',
  }),
  startTimeout: (port: number, tail: string[], rootInference: string | null): Finding => ({
    code: 'start-timeout', severity: 'blocker',
    fact: `${Math.round(START_TIMEOUT_MS / 1000)} 秒待っても、ポート ${port} が HTTP に応答しませんでした。`
      + 'IDE は待つのをやめ、プロセスを停止しました。',
    reason: (rootInference ? `${rootInference}\n` : '')
      + (tail.length ? `最後の出力:\n${tail.join('\n')}` : '出力がありません。理由を特定できません。'),
    impact: '時間内に応答を確認できなかったという事実だけがわかっています。'
      + 'プロジェクトのコードが壊れているかどうかは、この結果からはわかりません。',
    action: rootInference
      ? 'next.config に turbopack.root（このプロジェクトの絶対パス）を設定してから、もう一度試してください。'
      : '出力を確認してから、もう一度試してください。',
  }),
  crashed: (code: number | null, signal: string | null, tail: string[]): Finding => ({
    code: 'crashed', severity: 'blocker',
    fact: `実行中の開発サーバーが終了しました（${signal ? `シグナル ${signal}` : `終了コード ${code}`}）。`,
    reason: tail.length ? `最後の出力:\n${tail.join('\n')}` : '出力を保持していません。理由を特定できません。',
    impact: '実行時の情報は取得できません。コードの解析結果は残っています。',
    action: 'もう一度試してください。',
  }),
  lostAdopted: (pid: number): Finding => ({
    code: 'adopted-process-gone', severity: 'blocker',
    fact: `引き継いでいた開発サーバー（PID ${pid}）が終了しました。`,
    reason: 'IDE はこのプロセスの出力を保持していないため、終了の理由は特定できません。',
    impact: '実行時の情報は取得できません。',
    action: 'IDE から起動し直してください。',
  }),
} as const;

/** 他の操作が走っている間の拒否。状態そのものではない（409 で返す） */
export class BusyError extends Error {
  constructor(public readonly state: RunState, message: string) { super(message); }
}

export class DevServerManager {
  #state: RunState = 'idle';
  #seq = 0;
  #child: ChildProcess | null = null;
  #record: OwnershipRecord | null = null;
  #log: string[] = [];
  #logAvailable = false;
  #owner: Owner | null = null;
  #exit: { code: number | null; signal: string | null } = { code: null, signal: null };
  #readyMs: number | null = null;
  #error: Finding | null = null;
  #lastProbe: DevServerSnapshot['lastProbe'] = null;
  #inspection: ProjectInspection | null = null;
  readonly #instance = randomUUID();
  #progress: DevServerSnapshot['progress'] = null;
  /**
   * このプロジェクトを **この IDE のセッションで最初に起動する直前** の対象ファイルの指紋と、
   * 書き込みの主体を示す Next.js の出力（起動をまたいで残す）。
   * 起動のたびに取り直すと、再起動した時点で前の起動中の変化が画面から消えるため、
   * 別のプロジェクトを起動するまで取り直さない。引き継いだプロセスでは持たない。
   */
  #baseline: {
    root: string;
    files: Record<string, FileFingerprint>;
    saidTs: boolean;
    saidInstall: boolean;
  } | null = null;
  #targetChanges: Finding | null = null;
  #env: DevServerSnapshot['env'] = null;
  /** 停止を自分で始めたか。異常終了と区別するために要る */
  #stopping = false;
  #updatedAt = new Date().toISOString();
  /** 7C-1: 収集ファイルの整理の直近の結果 */
  #spanCleanup: SpanCleanupResult | null = null;

  constructor() {
    this.#adopt();
    /* 7C-1: IDE が強制終了した後の残骸を整理する（引き継いだ起動のファイルは守る） */
    this.#cleanupSpans('ide-start');
    this.#installExitHooks();
  }

  /* ------------------------------------------------------------- 状態の読み */

  snapshot(): DevServerSnapshot {
    const r = this.#record;
    return {
      state: this.#state,
      seq: this.#seq,
      instance: this.#instance,
      progress: this.#progress,
      targetChanges: this.#targetChanges,
      project: r ? { root: r.projectRoot, name: r.projectName } : null,
      pid: r?.pid ?? null,
      port: r?.port ?? null,
      url: r ? `http://127.0.0.1:${r.port}` : null,
      owner: this.#owner,
      startedAt: r?.startedAt ?? null,
      readyAt: r?.readyAt ?? null,
      readyMs: this.#readyMs,
      exitCode: this.#exit.code,
      signal: this.#exit.signal,
      instrumentation: r?.instrumentation
        ?? { state: 'disabled', reason: null, spanFile: null },
      lastProbe: this.#lastProbe,
      error: this.#error,
      logLines: this.#log.length,
      logAvailable: this.#logAvailable,
      env: this.#env,
      anchors: r?.anchors ?? null,
      updatedAt: this.#updatedAt,
    };
  }

  /** 画面に出す出力。秘密情報らしきものを落としてから返す。 */
  logs(limit = 200): { lines: string[]; available: boolean; total: number } {
    const n = Math.max(1, Math.min(LOG_CAP, limit));
    return {
      lines: redactAll(this.#log.slice(-n)),
      available: this.#logAvailable,
      total: this.#log.length,
    };
  }

  lastInspection(): ProjectInspection | null { return this.#inspection; }

  /**
   * 実際のプロセスの状態に合わせる。**画面と矛盾させないための唯一の同期点。**
   * 引き継いだプロセスには終了イベントが無いため、ここで生存を確かめる。
   */
  async refresh(): Promise<void> {
    this.#observeTargetChanges();
    if (this.#state !== 'running' || !this.#record) return;
    if (!pidAlive(this.#record.pid)) {
      if (this.#owner === 'ide-previous-session') {
        this.#fail(E.lostAdopted(this.#record.pid));
      } else {
        this.#fail(E.crashed(this.#exit.code, this.#exit.signal, this.#tail()));
      }
      this.#clearRecordFile();
      return;
    }
    const probe = await httpResponds(`http://127.0.0.1:${this.#record.port}/`);
    this.#lastProbe = {
      at: new Date().toISOString(),
      ok: probe.ok,
      status: probe.ok ? probe.status : null,
      detail: probe.ok ? null : probe.error,
    };
  }

  /* ------------------------------------------------------------ 検出だけ行う */

  async inspect(input: string): Promise<ProjectInspection> {
    const resume = this.#state;
    // 検証中であることを画面に出す。起動中・停止中の状態は上書きしない
    if (resume === 'idle' || resume === 'stopped' || resume === 'error') this.#set('validating');
    try {
      const result = await inspectProject(input);
      this.#inspection = result;
      return result;
    } finally {
      if (this.#state === 'validating') this.#set(resume);
    }
  }

  /* -------------------------------------------------------------------- 起動 */

  async start(req: StartRequest): Promise<DevServerSnapshot> {
    if (this.#state === 'starting' || this.#state === 'stopping' || this.#state === 'validating') {
      throw new BusyError(this.#state, `いま ${this.#state} の処理中です。完了してから操作してください。`);
    }
    if (this.#state === 'running') {
      throw new BusyError('running',
        `開発サーバーは既に実行中です（PID ${this.#record?.pid} / ポート ${this.#record?.port}）。`);
    }

    this.#set('validating');
    const ins = await inspectProject(req.project);
    this.#inspection = ins;
    if (!isStartable(ins) || !ins.root || !ins.next.binPath) {
      // 構成が対応外であることは「プロセスの異常」ではない。状態は戻す
      this.#set(this.#record ? 'stopped' : 'idle');
      const blocker = ins.findings.find((f) => f.severity === 'blocker') ?? null;
      this.#error = blocker;
      this.#bump();
      return this.snapshot();
    }

    const port = await this.#resolvePort(req.port);
    if (typeof port !== 'number') { this.#fail(port); return this.snapshot(); }

    /* ------------------------------------------------------------ 計装の決定 */
    const wants = req.instrument !== false;
    const insAvail = ins.instrumentation;
    let instrumentation: OwnershipRecord['instrumentation'];
    const runId = `${path.basename(ins.root)}-${Date.now()}`;
    /* 7C-1: 停止済みの起動の収集ファイルを、新しい起動の前に整理する（実行中のものは消さない） */
    this.#cleanupSpans('before-start');
    if (!wants) {
      instrumentation = { state: 'disabled', reason: '利用者が計装なしを選びました。', spanFile: null };
    } else if (!insAvail.available || !insAvail.boot) {
      instrumentation = { state: 'unavailable', reason: insAvail.reason, spanFile: null };
    } else {
      instrumentation = {
        state: 'enabled', reason: null,
        spanFile: path.join(spanDirPath(), `${runId}.jsonl`),
      };
    }

    /* ---------------------------------------------------------------- 環境 */
    const envReport = childEnvReport(process.env);
    const env = envReport.env;
    if (instrumentation.state === 'enabled' && insAvail.boot && instrumentation.spanFile) {
      fs.mkdirSync(path.dirname(instrumentation.spanFile), { recursive: true });
      // 空白を含むパスがあるため二重引用符で囲む（PoC-01 と同じ）
      env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require "${insAvail.boot}"`.trim();
      env.POC01_MODE = 'method2';
      env.POC01_RUN = runId;
      env.POC01_SPAN_FILE = instrumentation.spanFile;
      env.NEXT_OTEL_VERBOSE = '1';
      /* Phase 7B-3A: トレース識別子は **専用ヘッダ**（X-Vcide-Trace）だけで返させる。
       * Server-Timing はページ上の任意のスクリプトが読める（PoC-05 の実測）ので止める。
       * 専用ヘッダは中継が読み、ブラウザへは渡さない（previewGateway.ts）。
       * どちらもループバック宛の応答にしか付かない（ide-instrumentation/otel.cjs） */
      env.POC05_TRACE_HEADER = '1';
      env.POC05_SERVER_TIMING = '0';
      /* Phase 7B-3B-1: SQL を実行したデータ取得の呼び出し位置（PoC-02 Gate B）。
       * 呼び出しの入口（pg の Pool.query / Client.query）でスタックを取り、同じ収集ファイルに書かせる。
       * 記録するのはファイル・行・列・関数名だけ（引数・変数・行データは読まない — PoC-02 第8.1節）。
       * サーバー内部の fetch の計装（POC02_UNDICI）は今回の範囲外なので渡さない */
      env.POC02_CALLSITE = '1';
      /* 中継が要求ごとに作る識別子（x-vcide-relay）を受付スパンに写させる（previewGateway.ts） */
      env.POC07_RELAY_ID = '1';
    }
    /* 要素識別子の注入（Phase 7B-2）。対象の next.config がローダを読む設定のときだけ。
     * 対応表は IDE 側に書かせる（対象プロジェクトには書かない） */
    const anchors = anchorSupport(ins.root);
    Object.assign(env, anchorEnv(ins.root, anchors));

    /* ---------------------------------------------------------------- 起動 */
    const args = [ins.next.binPath, 'dev', '-p', String(port), '-H', '127.0.0.1'];
    this.#log = [];
    this.#logAvailable = true;
    this.#exit = { code: null, signal: null };
    this.#error = null;
    this.#lastProbe = null;
    this.#readyMs = null;
    this.#stopping = false;
    this.#progress = null;
    this.#env = { passed: envReport.passed, withheld: envReport.withheld, explicit: envReport.explicit };
    if (this.#baseline?.root !== ins.root) {
      this.#targetChanges = null;
      this.#baseline = {
        root: ins.root,
        files: Object.fromEntries(WATCHED_TARGET_FILES.map((f) => [f, fingerprint(path.join(/* turbopackIgnore: true */ ins.root!, f))])),
        saidTs: false,
        saidInstall: false,
      };
    }
    this.#set('starting');

    let child: ChildProcess;
    const t0 = Date.now();
    try {
      child = spawn(process.execPath, args, {
        cwd: ins.root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 自分のプロセスグループを持たせる。next が分けた子まで確実に止めるため
        detached: true,
        shell: false,
      });
    } catch (e) {
      this.#fail(E.spawnFailed(e instanceof Error ? e.message : String(e)));
      return this.snapshot();
    }
    if (!child.pid) {
      this.#fail(E.spawnFailed('PID を取得できませんでした。'));
      return this.snapshot();
    }

    this.#child = child;
    this.#owner = 'ide';
    this.#record = {
      pid: child.pid,
      port,
      projectRoot: ins.root,
      projectName: ins.name ?? path.basename(ins.root),
      fingerprint: ins.next.binPath,
      startedAt: new Date(t0).toISOString(),
      readyAt: null,
      instrumentation,
      anchors,
      ideOwnerPid: process.pid,
    };
    this.#writeRecordFile();

    /* 子のイベントは別の実行文脈で起きる。`let` の束縛では型の絞り込みが
     * 追従しないため、観測結果はオブジェクトに入れて読む */
    const obs: {
      fatal: Finding | null;
      exited: { code: number | null; signal: string | null } | null;
    } = { fatal: null, exited: null };

    const onChunk = (b: Buffer | string) => {
      for (const line of String(b).split('\n')) {
        if (!line.trim()) continue;
        this.#log.push(line);
        if (this.#log.length > LOG_CAP) this.#log.shift();
        if (PROGRESS_RE.test(line)) {
          this.#progress = { line: redactAll([line.trim()])[0], at: new Date().toISOString() };
        }
        // Next 16 は同一プロジェクトの二重起動をここで断る。待たずに失敗にする
        if (/Another next dev server is already running/i.test(line)) {
          const m = /PID:\s*(\d+)/.exec(this.#log.join('\n'));
          obs.fatal = E.anotherDevServer(m ? `既存の PID は ${m[1]} です。` : '');
        }
        if (/EADDRINUSE/.test(line)) obs.fatal = E.portInUse(port);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.once('exit', (code, signal) => {
      obs.exited = { code: code ?? null, signal: signal ?? null };
      this.#exit = obs.exited;
      this.#child = null;
      // 実行中に落ちた場合だけ、ここで状態を倒す。停止操作中は stop() が決める
      if (!this.#stopping && this.#state === 'running') {
        this.#fail(E.crashed(code ?? null, signal ?? null, this.#tail()));
        this.#clearRecordFile();
      }
    });
    child.once('error', (e) => { obs.fatal = E.spawnFailed(e.message); });

    /* -------------------------------- 応答を確認してから running にする（指示 2.D）*/
    const url = `http://127.0.0.1:${port}/`;
    for (;;) {
      if (obs.fatal) {
        await this.#killOwned();
        this.#fail(obs.fatal);
        this.#clearRecordFile();
        return this.snapshot();
      }
      if (obs.exited) {
        this.#fail(E.exitedDuringStart(obs.exited.code, obs.exited.signal, this.#tail()));
        this.#clearRecordFile();
        return this.snapshot();
      }
      const probe = await httpResponds(url, { timeout: 2500 });
      if (probe.ok) {
        this.#readyMs = Date.now() - t0;
        this.#lastProbe = {
          at: new Date().toISOString(), ok: true, status: probe.status, detail: null,
        };
        this.#record.readyAt = new Date().toISOString();
        this.#writeRecordFile();
        this.#observeTargetChanges();
        this.#set('running');
        return this.snapshot();
      }
      if (Date.now() - t0 > START_TIMEOUT_MS) {
        await this.#killOwned();
        this.#observeTargetChanges();
        this.#fail(E.startTimeout(port, this.#tail(), this.#rootInferenceNote()));
        this.#clearRecordFile();
        return this.snapshot();
      }
      await sleep(PROBE_INTERVAL_MS);
    }
  }

  /* -------------------------------------------------------------------- 停止 */

  async stop(): Promise<DevServerSnapshot> {
    if (this.#state === 'starting' || this.#state === 'stopping' || this.#state === 'validating') {
      throw new BusyError(this.#state, `いま ${this.#state} の処理中です。完了してから操作してください。`);
    }
    if (!this.#record) {
      throw new BusyError(this.#state, 'IDE が起動した開発サーバーはありません。');
    }
    const { pid, port } = this.#record;
    this.#stopping = true;
    this.#set('stopping');

    await this.#killOwned();
    this.#observeTargetChanges();

    // ポートが解放されたことを確認してから stopped にする（ST-07）
    const freed = await waitPortFree(port, { timeout: 10_000 });
    this.#clearRecordFile();
    this.#child = null;
    this.#stopping = false;
    this.#lastProbe = {
      at: new Date().toISOString(), ok: false, status: null,
      detail: freed ? `ポート ${port} は解放されています。` : `ポート ${port} がまだ使われています。`,
    };
    if (!pidAlive(pid) && freed) {
      this.#error = null;
      this.#set('stopped');
    } else {
      this.#fail({
        code: 'stop-incomplete', severity: 'blocker',
        fact: `停止を指示しましたが、${pidAlive(pid) ? `プロセス（PID ${pid}）がまだ生きています` : `ポート ${port} がまだ使われています`}。`,
        reason: 'SIGTERM と SIGKILL を送った後も解放を確認できませんでした。',
        impact: '停止を確認できていないため「停止しました」とは言えません。同じポートでの再起動は失敗します。',
        action: 'しばらく待ってからもう一度試してください。',
      });
    }
    return this.snapshot();
  }

  /* ------------------------------------------------------------------ 内部 */

  #tail(n = 8): string[] { return redactAll(this.#log.slice(-n)); }

  /**
   * 起動の待ちが切れたとき、ルートの推定が関わっている証拠があれば説明を返す。
   * 証拠は2つだけ — Next.js の出力と、起動前の検出の所見。どちらも無ければ null。
   */
  #rootInferenceNote(): string | null {
    const fromLog = this.#log.some((l) => ROOT_INFERENCE_RE.test(l));
    const fromInspection = this.#inspection?.findings.some((f) => f.code === 'ancestor-root-marker') ?? false;
    if (!fromLog && !fromInspection) return null;
    const markers = this.#inspection?.ancestorRootMarkers ?? [];
    return [
      fromLog ? 'Next.js の出力に、ワークスペースのルートを推定したことを示す行があります。' : null,
      fromInspection && markers.length
        ? `起動前の検出で、プロジェクトより上の階層に ${markers.join(' / ')} を見つけています。` : null,
      'ルートが広く推定されると、初回のコンパイルがそのディレクトリ全体を走査して終わらないことがあります。',
    ].filter(Boolean).join('');
  }

  /**
   * 対象プロジェクトのファイルが、起動前から変わったかを見る（R4）。
   * IDE は対象に書き込まないので、変化があれば書いたのは IDE の外である。
   * 誰が書いたかは、Next.js の出力に証拠がある場合だけ名指しする。
   */
  #observeTargetChanges(): void {
    const b = this.#baseline;
    if (!b) return;
    const changed: string[] = [];
    for (const [f, before] of Object.entries(b.files)) {
      const now = fingerprint(path.join(/* turbopackIgnore: true */ b.root, f));
      if (now === before) continue;
      changed.push(`${f}（${before === null ? '作成' : now === null ? '削除' : '変更'}）`);
    }
    // 出力の証拠は起動をまたいで残す（再起動で出力の保持は入れ替わる）
    if (this.#logAvailable) {
      b.saidTs ||= this.#log.some((l) => /reconfigured your .*tsconfig\.json|created a tsconfig\.json/i.test(l));
      b.saidInstall ||= this.#log.some((l) => /Installing dependencies/i.test(l));
    }
    if (!changed.length) { this.#targetChanges = null; return; }
    const evidence = [
      b.saidTs ? 'next dev の出力に「We detected TypeScript in your project and reconfigured your tsconfig.json」があります。' : null,
      b.saidInstall ? 'next dev の出力に「Installing dependencies」があります。' : null,
    ].filter(Boolean).join('');
    this.#targetChanges = {
      code: 'target-files-changed', severity: 'limit',
      fact: `この IDE がこのプロジェクトの開発サーバーを最初に起動してから、対象プロジェクトの ${changed.join(' / ')} が変わりました。`,
      reason: (evidence || '書き込んだプロセスを特定する出力はありません。')
        + 'IDE は対象プロジェクトに書き込みません。変化は IDE の外（開発サーバーとして起動した next dev を含む）で起きたものです。',
      impact: '変更の中身は IDE では元に戻していません。Next.js の既定の振る舞いによる書き換えは、起動のたびに起こりえます。',
      action: '差分はプロジェクトのバージョン管理（git diff など）で確認できます。',
    };
  }

  /**
   * 7C-1: 収集ファイルの整理（spanFiles.ts）。守るのは、いまの起動の記録が指すファイルのうち
   * プロセスがまだ生きているもの。失敗しても起動・停止は止めない（結果に残す）
   */
  #cleanupSpans(trigger: string): void {
    const r = this.#record;
    const live = r && (pidAlive(r.pid) || groupAlive(r.pid)) ? r.instrumentation.spanFile : null;
    try {
      this.#spanCleanup = cleanupSpanFiles({ ideRoot: ideRoot(), protect: [live], trigger });
      const c = this.#spanCleanup;
      if (c.removed.length || c.failed.length) {
        console.info(`[vcide] 収集ファイルの整理（${trigger}）: 削除 ${c.removed.length} 件・${c.removed.reduce((n, x) => n + x.bytes, 0)} バイト／残す ${c.kept.length} 件／失敗 ${c.failed.length} 件`);
      }
    } catch (e) {
      this.#spanCleanup = {
        at: new Date().toISOString(), trigger, dir: '', skipped: e instanceof Error ? e.message : String(e),
        removed: [], kept: [], failed: [],
      };
    }
  }

  /** 7C-1: 収集ファイルの整理の直近の結果（ファイル名・件数・理由だけ） */
  lastSpanCleanup(): Omit<SpanCleanupResult, 'dir'> | null {
    if (!this.#spanCleanup) return null;
    const { dir: _d, ...rest } = this.#spanCleanup;
    void _d;
    return rest;
  }

  #set(s: RunState): void {
    const was = this.#state;
    this.#state = s;
    this.#bump();
    /* Phase 7B-3A: 観測セッションは起動ごとに1つ。running で作り、それ以外の状態で閉じる
     * （停止後に実測中であるかのように見せない。起動をまたいで混ぜない） */
    const r = this.#record;
    if (s === 'running' && r) observations().begin(`${this.#instance}:${r.pid}:${r.startedAt}`);
    else if (s !== 'running') observations().end();
    /* 7C-1: 停止・異常終了した起動の収集ファイルを整理する（書き手が生きていれば残す）。
     * 異常終了の直後はワーカーが終わりきっていないことがあるので、少し後にもう一度見る
     * （その間に次の起動があっても、いまの起動のファイルは守る・書き手の生きているファイルは消さない） */
    if ((s === 'stopped' || s === 'error') && was !== s) {
      this.#cleanupSpans(`after-${s}`);
      for (const ms of SPAN_CLEANUP_RETRY_MS) {
        setTimeout(() => {
          const kept = this.#spanCleanup?.kept.some((k) => k.why === 'writer-alive' || k.why === 'protected');
          if (kept && this.#state !== 'starting' && this.#state !== 'validating') this.#cleanupSpans(`after-${s}-retry`);
        }, ms).unref();
      }
    }
  }

  #bump(): void { this.#seq += 1; this.#updatedAt = new Date().toISOString(); }

  #fail(f: Finding): void { this.#error = f; this.#set('error'); }

  /** 要求されたポートを確かめる。省略時は空きを選ぶ。 */
  async #resolvePort(requested?: number): Promise<number | Finding> {
    if (typeof requested === 'number') {
      if (!Number.isInteger(requested) || requested < 1024 || requested > 65535) {
        return {
          code: 'port-invalid', severity: 'blocker',
          fact: `ポート番号 ${requested} は使えません。`,
          reason: '1024〜65535 の整数だけを受け付けます。',
          impact: '開発サーバーを起動できません。',
          action: '別のポート番号を入力してください。',
        };
      }
      return (await isPortFree(requested)) ? requested : E.portInUse(requested);
    }
    for (let p = PORT_RANGE.from; p <= PORT_RANGE.to; p++) {
      if (await isPortFree(p)) return p;
    }
    return E.noFreePort();
  }

  /**
   * プロセスグループごと止める。SIGTERM → 待つ → SIGKILL の順で、待ち時間を固定しない。
   * **先頭のプロセスだけでなく、グループが空になるまで待つ**（Phase 7B-2）。要素識別子のローダは
   * Turbopack のワーカー（別プロセス）で走り、先頭より後に終わる。先頭だけを見て「停止した」と言わない。
   */
  async #killOwned(): Promise<void> {
    const rec = this.#record;
    if (!rec) return;
    const pid = rec.pid;
    const anyAlive = () => pidAlive(pid) || groupAlive(pid);
    if (!anyAlive()) return;
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 既に落ちている */ } }
    const t0 = Date.now();
    while (anyAlive() && Date.now() - t0 < STOP_TERM_WAIT_MS) await sleep(150);
    if (!anyAlive()) return;
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 既に落ちている */ } }
    const t1 = Date.now();
    while (anyAlive() && Date.now() - t1 < STOP_KILL_WAIT_MS) await sleep(100);
  }

  /** 同期で止める。プロセス終了フックからはこれしか呼べない。 */
  #killOwnedSync(): void {
    const rec = this.#record;
    if (!rec || this.#owner !== 'ide') return;
    try { process.kill(-rec.pid, 'SIGTERM'); } catch { /* 既に落ちている */ }
    try { process.kill(-rec.pid, 'SIGKILL'); } catch { /* 既に落ちている */ }
  }

  /* ------------------------------------------------------- 台帳の読み書き */

  #writeRecordFile(): void {
    if (!this.#record) return;
    const file = stateFilePath();
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(this.#record, null, 2)}\n`);
    fs.renameSync(tmp, file);           // 途中の状態を読ませない
  }

  #clearRecordFile(): void {
    try { fs.rmSync(stateFilePath(), { force: true }); } catch { /* 無ければよい */ }
  }

  /**
   * 前のセッションが起動した開発サーバーを引き継ぐ。
   *
   * **殺さずに引き継ぐ。** IDE のプロセスが入れ替わったことは、利用者が動かしている
   * サーバーを止めてよい理由にならない。引き継げば孤立しないし、[停止] も効く。
   * 引き継げない記録（死んでいる / PID が再利用されている）は捨てる。
   */
  #adopt(): void {
    let rec: OwnershipRecord;
    try {
      const raw = fs.readFileSync(stateFilePath(), 'utf8');
      rec = JSON.parse(raw) as OwnershipRecord;
    } catch { return; }
    if (typeof rec?.pid !== 'number' || !pidAlive(rec.pid)) { this.#clearRecordFile(); return; }
    this.#record = rec;
    this.#owner = rec.ideOwnerPid === process.pid ? 'ide' : 'ide-previous-session';
    this.#logAvailable = false;         // 出力は引き継げない
    this.#state = 'running';
    this.#bump();
    // 引き継いだ起動にも新しい観測セッションを作る。前の IDE プロセスの中継の記録は持っていない
    observations().begin(`${this.#instance}:${rec.pid}:${rec.startedAt}`);
    // PID 再利用の確認は非同期になるため、ここでは待たずに行う
    void pidCommand(rec.pid).then((cmd) => {
      if (cmd && !cmd.includes(rec.fingerprint) && !/next/i.test(cmd)) {
        // 記録と違うプロセスだった。所有を主張しない（**殺さない**）
        this.#record = null;
        this.#owner = null;
        this.#state = 'idle';
        this.#bump();
        observations().end();
        this.#clearRecordFile();
      }
    });
  }

  #installExitHooks(): void {
    const g = globalThis as unknown as { __vcideExitHooks__?: boolean };
    if (g.__vcideExitHooks__) return;
    g.__vcideExitHooks__ = true;
    process.on('exit', () => { this.#killOwnedSync(); });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(sig, () => {
        this.#killOwnedSync();
        process.removeAllListeners(sig);
        process.kill(process.pid, sig);   // 既定の振る舞いに戻す
      });
    }
  }
}

/**
 * 単一実体。**モジュール変数ではなく globalThis に置く。**
 * Next の dev はルートハンドラのモジュールを作り直すため、モジュール変数では
 * 子プロセスの所有が失われる（指示 第3節）。
 */
export function devServer(): DevServerManager {
  const g = globalThis as unknown as { __vcideDevServer__?: DevServerManager };
  g.__vcideDevServer__ ??= new DevServerManager();
  return g.__vcideDevServer__;
}

/** 台帳の生の内容。起動していなければ null。孤立プロセスの掃除で使う。 */
export function readOwnershipRecord(): OwnershipRecord | null {
  try { return JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')) as OwnershipRecord; }
  catch { return null; }
}

export const runtimeDirPath = runtimeDir;
