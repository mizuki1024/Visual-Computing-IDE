/* =============================================================================
 * 計装の本体。CJS で書く — 方式2（NODE_OPTIONS=--require）でも読めるようにするため。
 *
 * 取得するもの: スパンの名前・種別・開始/終了時刻・親子関係・許可リストの属性
 * 取得しないもの: ヘッダ・本文・パラメータ値・接続文字列（mask.cjs が落とす）
 * 送信先: ローカルファイルのみ
 * ========================================================================== */
const { maskAttributes } = require('./mask.cjs');
const sink = require('./sink.cjs');

if (globalThis.__poc01_otel_started__) {
  sink.note('duplicate-register', 'このプロセスでは既に計装が初期化されている');
} else {
  globalThis.__poc01_otel_started__ = true;
  start();
}

function start() {
  const {
    trace, context, createContextKey, SpanStatusCode, diag, DiagConsoleLogger, DiagLogLevel,
  } = require('@opentelemetry/api');
  if (process.env.POC01_DIAG === '1') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }
  /* -------------------------------------------------------------- PoC-02
   * 既定では**どちらも無効**である。PoC-01 / PoC-03 / PoC-05 の計測条件を
   * 変えないため、環境変数が立っているときだけ振る舞いを足す。
   *
   *   POC02_UNDICI    サーバー内部の fetch を計装する（Gate A）。
   *                   client スパンを作り、**ループバック宛に限り**
   *                   W3C traceparent を注入する
   *   POC02_CALLSITE  スパン開始時の呼び出しスタックを記録する（Gate B）。
   *                   SQL スパンとサーバー内部 fetch スパンだけが対象
   * ------------------------------------------------------------------- */
  const UNDICI = process.env.POC02_UNDICI === '1';
  const CALLSITE = process.env.POC02_CALLSITE === '1';

  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');

  /* ---------------------------------------------- 書き出し用のエクスポータ */
  /** 親スパンIDの取り出し。SDK の世代で形が違う（プロパティ / 旧 parentSpanId） */
  const parentIdOf = (s) => {
    const p = s.parentSpanContext;
    if (p && typeof p === 'object' && p.spanId) return p.spanId;
    if (typeof p === 'function') { try { return p.call(s)?.spanId ?? null; } catch { return null; } }
    return s.parentSpanId ?? null;
  };

  const exporter = {
    export(spans, done) {
      for (const s of spans) {
        try {
        const masked = maskAttributes(s.attributes);
        sink.write({
          type: 'span',
          traceId: s.spanContext().traceId,
          spanId: s.spanContext().spanId,
          parentSpanId: parentIdOf(s),
          name: s.name,
          kind: s.kind,
          // hrTime [秒, ナノ秒] → エポックからのミリ秒（小数つき）
          startMs: s.startTime[0] * 1e3 + s.startTime[1] / 1e6,
          endMs: s.endTime[0] * 1e3 + s.endTime[1] / 1e6,
          durationMs: s.duration[0] * 1e3 + s.duration[1] / 1e6,
          statusCode: s.status?.code ?? 0,
          scope: s.instrumentationScope?.name ?? s.instrumentationLibrary?.name ?? null,
          attrs: masked.attrs,
          droppedAttributeKeys: masked.droppedKeys,
          sqlRedacted: masked.redacted,
        });
        } catch (e) {
          // 1本の取りこぼしで全部を失わない。取れなかったことを記録する
          sink.note('export-failed', String(e && e.message).slice(0, 200));
        }
      }
      done({ code: 0 });
    },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
  };

  /* --------------------------------------------------------------- PoC-02
   * 呼び出しスタックの記録（Gate B）。
   *
   * **スパンが始まったその瞬間**に、同じ同期スタックの上で `Error.stack` を
   * 取る。これは「誰がこの SQL を実行したか」そのものの記録であり、
   * 時刻の近さや名前の一致による推測ではない。
   *
   * 収集するのは「ファイル・行・列・関数名」だけである。引数も変数も読まない。
   * 絶対パスは出さない（アプリ以下は相対パス、外は分類名に置き換える）。
   *
   * 7C（HMR 安全対策 A1）: フレームは V8 の呼び出し位置の API（CallSite）から作り、**eval されたコード**
   * （Next.js 16 の server fast refresh は、変更したモジュールを Turbopack の実行時が `(0, eval)(code + sourceURL)` で
   * 作り直す）を `CallSite.isEval()` で判定して `scope: 'evaluated'` の印を付ける。そのフレームの行・列は
   * ディスクの生成物の座標ではないので、IDE はその位置より外側のフレームを根拠にしない。
   * sourceURL に付く `?<moduleId>` も、eval のコードの位置も記録しない（file は '<evaluated>'）。
   * 記録には作り方（frameSource: 'v8-callsite'）を書く。CallSite を取れなかったときだけスタックの文字列から作り
   * （'stack-string'。`?`・`eval at` の形で印を推すが、IDE はこの記録を根拠に使わない）。
   * ------------------------------------------------------------------- */
  const APP_DIR = process.cwd();

  /* 7C（実行コードの版）: 生成物を require で読み込んだ（コンパイルした）ときの内容から、モジュールの区画の表を作って覚える。
   * 鍵は内容の SHA-256（V8 の CallSite.getScriptHash() と同じ値になる — 実測）。古い世代のコードが動き続けても、
   * その世代の表が残るので、フレームがどの区画（どの内容）のコードかを記録できる。内容そのものは持たない（ハッシュと行だけ）。
   * 対象はアプリの .next の下の .js だけ。表の数には上限を置く（古いものから捨てる。捨てた世代のフレームは区画を記録しない＝IDE は未観測） */
  const chunkRegionsLib = require('./chunkregions.cjs');
  const loadedScripts = new Map();
  const MAX_LOADED_SCRIPTS = 4000;
  function patchCompileForRegions() {
    if (!CALLSITE) return;
    try {
      const Module = require('node:module');
      const proto = Module.prototype;
      const orig = proto._compile;
      if (typeof orig !== 'function' || orig.__vcide_regions__) return;
      const nextDir = require('node:path').join(APP_DIR, '.next') + require('node:path').sep;
      const wrapped = function (content, filename, ...rest) {
        try {
          if (typeof content === 'string' && typeof filename === 'string' && filename.startsWith(nextDir) && filename.endsWith('.js')) {
            const h = chunkRegionsLib.sha256(content);
            if (!loadedScripts.has(h)) {
              loadedScripts.set(h, chunkRegionsLib.chunkRegions(content));
              if (loadedScripts.size > MAX_LOADED_SCRIPTS) loadedScripts.delete(loadedScripts.keys().next().value);
            }
          }
        } catch { /* 表が作れなければ区画を記録しない（IDE は未観測にする） */ }
        return orig.call(this, content, filename, ...rest);
      };
      wrapped.__vcide_regions__ = true;
      proto._compile = wrapped;
      sink.note('callsite-regions-patched', 'Module.prototype._compile');
    } catch (e) {
      sink.note('callsite-regions-patch-failed', String(e && e.message).slice(0, 120));
    }
  }
  patchCompileForRegions();

  /** スタック1行の解析。`at fn (file:line:col)` と `at file:line:col` の両形 */
  const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

  /** 絶対パスを出さない。アプリ以下は相対化し、外は分類名にする */
  function classifyFile(raw) {
    let f = String(raw);
    if (f.startsWith('file://')) { try { f = require('node:url').fileURLToPath(f); } catch { /* そのまま */ } }
    if (f.startsWith('node:')) return { file: f, scope: 'node-builtin' };
    if (/^(webpack-internal:|turbopack:|rsc:|\[turbopack\])/.test(f)) {
      /* バンドラの仮想URL。**そのまま残す。** この文字列がソースマップを
       * 引くときの鍵になる（行・列は生成物のものなので、後で戻す必要がある）。
       * 絶対パスは含まれない形式である。長すぎるものは切る */
      return { file: f.slice(0, 300), scope: 'bundler-virtual' };
    }
    if (f.startsWith(APP_DIR)) {
      const rel = f.slice(APP_DIR.length).replace(/^[/\\]/, '').split('\\').join('/');
      if (rel.startsWith('node_modules/')) return { file: '<node_modules>', scope: 'node_modules' };
      /* 7C: 生成物として受けるのは .js だけ。形の違う生成物（拡張子が変わった等）は、黙って捨てられて外側のフレームが
       * 採られないよう「認識できない」印にする */
      if (rel.startsWith('.next/')) return /\.js$/.test(rel) ? { file: rel, scope: 'build-output' } : { file: '<unrecognized>', scope: 'unrecognized' };
      return { file: rel, scope: 'app-source' };
    }
    if (f.includes('node_modules')) return { file: '<node_modules>', scope: 'node_modules' };
    return { file: '<outside-app>', scope: 'outside' };
  }

  /** sourceURL・ファイルの URL に ? / # が付いている（eval されたモジュールの sourceURL の形） */
  const QUERIED = /^(?:file:\/\/)?[^?#]*[?#]/;
  const EVALUATED = (fn, line, col) => ({ functionName: fn, file: '<evaluated>', scope: 'evaluated', line: line > 0 ? line : 0, col: col > 0 ? col : 0 });

  /** V8 の既定の書式に近い関数名（表示にだけ使う。照合には使わない） */
  function siteName(cs) {
    try {
      const f = cs.getFunctionName();
      let n = f;
      if (!cs.isToplevel() && !cs.isConstructor()) {
        const t = cs.getTypeName();
        if (t && t !== 'global' && (!f || !f.startsWith(`${t}.`))) n = `${t}.${f ?? '<anonymous>'}`;
      }
      if (!n) return null;
      return `${typeof cs.isAsync === 'function' && cs.isAsync() ? 'async ' : ''}${cs.isConstructor() ? 'new ' : ''}${n}`.slice(0, 80);
    } catch { return null; }
  }

  /** V8 の CallSite を取る。Error.prepareStackTrace をその場だけ差し替える（Next.js の差し替えはすぐ戻す） */
  function callSites(limit) {
    const prevLimit = Error.stackTraceLimit;
    const prevPrep = Error.prepareStackTrace;
    const mine = (_e, cs) => cs;
    let sites = null;
    try {
      Error.stackTraceLimit = limit;
      Error.prepareStackTrace = mine;
      if (Error.prepareStackTrace === mine) {
        const holder = {};
        Error.captureStackTrace(holder, captureStack);
        sites = holder.stack;   // 差し替えている間に読む（書式化はこの読み取りで起きる）
      }
    } catch { sites = null; } finally {
      try { Error.prepareStackTrace = prevPrep; } catch { /* 戻せない形はそもそも差し替えられていない */ }
      Error.stackTraceLimit = prevLimit;
    }
    return Array.isArray(sites) && sites.every((s) => s && typeof s.isEval === 'function') ? sites : null;
  }

  function frameOfSite(cs) {
    const fn = siteName(cs);
    const line = Number(cs.getLineNumber() ?? 0);
    const col = Number(cs.getColumnNumber() ?? 0);
    if (cs.isEval()) return EVALUATED(fn, line, col);
    const raw = cs.getFileName() ?? (typeof cs.getScriptNameOrSourceURL === 'function' ? cs.getScriptNameOrSourceURL() : null);
    if (!raw) {
      /* 位置の無いフレーム（Array.map・new Promise など組み込みの関数）はユーザーのコードではない。位置があるのに名前が無いものは認識できない */
      return line > 0 ? { functionName: fn, file: '<unrecognized>', scope: 'unrecognized', line: 0, col: 0 }
        : { functionName: fn, file: '<native>', scope: 'native', line: 0, col: 0 };
    }
    if (QUERIED.test(String(raw))) return EVALUATED(fn, line, col);
    if (!(line > 0) || !(col > 0)) return { functionName: fn, file: '<unrecognized>', scope: 'unrecognized', line: 0, col: 0 };
    const c = classifyFile(raw);
    /* 7C（実行コードの版）: ディスクの生成物から読んだコードのフレームには、**いま実行しているスクリプトの内容のハッシュ**
     * （V8 の CallSite.getScriptHash() = コンパイルしたソースの SHA-256）を付ける。同じパスの生成物がディスクで書き直されても、
     * 前に require した古い世代のコードはこのハッシュのまま動く（server fast refresh が変えていないモジュール）。IDE は
     * これをディスクの生成物の内容のハッシュと比べ、一致を確かめられたときだけ位置を戻す。取れなければ付けない（IDE は未観測にする） */
    if (c.scope === 'build-output') {
      let scriptHash = null;
      try {
        const h = typeof cs.getScriptHash === 'function' ? cs.getScriptHash() : null;
        scriptHash = typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? h : null;
      } catch { scriptHash = null; }
      /* 実行しているスクリプトの、このフレームが入るモジュールの区画（読み込んだときの内容から作った表。無ければ付けない） */
      let moduleRegion = null;
      try {
        const regions = scriptHash ? loadedScripts.get(scriptHash) : null;
        const r = regions ? chunkRegionsLib.regionOfLine(regions, line) : null;
        if (r) moduleRegion = { hash: r.hash, line: line - r.start };
      } catch { moduleRegion = null; }
      return { functionName: fn, file: c.file, scope: c.scope, line, col, scriptHash, moduleRegion };
    }
    return { functionName: fn, file: c.file, scope: c.scope, line, col };
  }

  /** スタックの文字列から作る（CallSite を取れなかったときだけ）。印は形から推す（`?`・`eval at`）。IDE は根拠に使わない */
  function framesFromString(limit) {
    const prev = Error.stackTraceLimit;
    Error.stackTraceLimit = limit;
    const raw = new Error().stack || '';
    Error.stackTraceLimit = prev;
    const out = [];
    for (const line of raw.split('\n').slice(1)) {
      const m = FRAME_RE.exec(line);
      if (!m) {
        if (/\((?:<anonymous>|native|index \d+)\)\s*$/.test(line)) out.push({ functionName: null, file: '<native>', scope: 'native', line: 0, col: 0 });
        else if (line.trim()) out.push({ functionName: null, file: '<unrecognized>', scope: 'unrecognized', line: 0, col: 0 });
        continue;
      }
      const fn = m[1] ? String(m[1]).slice(0, 80) : null;
      if (/^eval at /.test(m[2]) || /<anonymous>/.test(m[2]) || QUERIED.test(m[2])) { out.push(EVALUATED(fn, Number(m[3]), Number(m[4]))); continue; }
      const c = classifyFile(m[2]);
      out.push({ functionName: fn, file: c.file, scope: c.scope, line: Number(m[3]), col: Number(m[4]) });
    }
    return out;
  }

  /** 呼び出しのスタック。frameSource はフレームの作り方（IDE が A1 の照合に使う） */
  function captureStack(limit) {
    const sites = callSites(limit);
    if (sites) {
      try { return { frameSource: 'v8-callsite', frames: sites.map(frameOfSite) }; } catch { /* 文字列へ */ }
    }
    return { frameSource: 'stack-string', frames: framesFromString(limit) };
  }

  /**
   * この種のスパンだけスタックを取る。全スパンで取ると重く、要らない。
   *
   * 計装によって「属性をいつ付けるか」が違う（pg は startSpan のあとに
   * setAttribute する）ため、属性ではなく**計装の名前**で判定する。
   */
  const wantsCallsite = (span) => {
    const scope = span.instrumentationScope?.name ?? span.instrumentationLibrary?.name ?? '';
    if (/instrumentation-pg|prisma/.test(scope)) return 'sql';
    if (scope.includes('undici')) return 'server-fetch';
    // Next.js 自身が付ける fetch スパン。undici 計装を入れない条件でも
    // 呼び出し元を比べられるようにする（名前は作成時に決まっている）
    if (/^fetch\s/.test(span.name ?? '')) return 'server-fetch';
    const a = span.attributes || {};
    if (a['db.statement'] || a['db.query.text']) return 'sql';
    return null;
  };

  /*
   * **スパンが始まった場所は、呼び出した場所ではない。**
   *
   * 実測で分かったこと: `pool.query()` を呼んだ時点ではスパンは作られない。
   * pg の接続プールが空いた時点のコールバックの中で `Client.query` が走り、
   * そこでスパンが作られる。スパン開始時の同期スタックには、呼び出した
   * Server Component のフレームが**存在しない**。
   *
   * そこで、呼び出しの入口（`Pool.query` / `Client.query`）でスタックを取り、
   * **OpenTelemetry のコンテキストに載せて運ぶ**。親子関係が正しく付くのと
   * まったく同じ仕組み（計装がコールバックを包んでコンテキストを復元する）に
   * 相乗りするので、別の推測を足していない。
   *
   * スパン開始時に、そのスパンの親コンテキストから取り出す。
   */
  const CALLSITE_KEY = createContextKey('vcide.sql.callsite');

  /** 呼び出しの入口でスタックを取り、コンテキストに載せる */
  function patchCallsiteEntry() {
    if (!CALLSITE) return;
    const targets = [];
    /*
     * **包むのは、対象のアプリが使う pg の実体である。**
     *
     * この計装の束は IDE 側に在り（src/server/ide.ts の instrumentationBootPath）、
     * ここで素の `require('pg')` と書くと、束の隣の node_modules（IDE 側）の pg を解決する。
     * 対象のプロジェクトが自分の node_modules に pg を持っていると、アプリはそちらを読み、
     * 別の実体（別のプロトタイプ）なので入口を包めず、すべての SQL で入口のスタックが null になる
     * （7C の lineage-e2e の復旧で実測。題材を IDE の中の poc/fixture-app に置いたときだけ両者が一致していた）。
     *
     * そこで、アプリの起点（process.cwd() = APP_DIR。IDE は開発サーバーを対象の直下で起動する）から
     * pg を解決し、pg-pool はその pg 自身の位置から解決する（pg が内部で読む実体と同じになる）。
     * 解決できなければ包まない（IDE 側の pg を包んでもアプリの SQL には当たらない）。
     * OpenTelemetry の pg 計装は require のフックで実体ごとに当たるので、SQL のスパンはこの解決に依らない。
     */
    const { createRequire } = require('node:module');
    const path = require('node:path');
    let pgPath = null;
    try {
      pgPath = createRequire(path.join(APP_DIR, 'package.json')).resolve('pg');
    } catch (e) { sink.note('callsite-pg-missing', String(e && e.message).split('\n')[0].slice(0, 120)); }
    if (pgPath) {
      try {
        const PgPool = require(createRequire(pgPath).resolve('pg-pool'));
        targets.push(['pg-pool.Pool.query', PgPool.prototype, 'query']);
      } catch (e) { sink.note('callsite-pg-pool-missing', String(e && e.message).split('\n')[0].slice(0, 120)); }
      try {
        const pg = require(pgPath);
        targets.push(['pg.Client.query', pg.Client.prototype, 'query']);
      } catch (e) { sink.note('callsite-pg-missing', String(e && e.message).split('\n')[0].slice(0, 120)); }
    }

    /*
     * サーバー内部の `fetch` も同じ理屈で取る。ただし問題が1つある:
     * **Next.js が自分で `globalThis.fetch` を差し替える。** こちらが先に
     * 包むと Next のラッパが外側になり、ユーザーのコードのフレームは
     * Next の非同期ラッパで切れてしまう（実測）。
     *
     * そこで `globalThis.fetch` を**アクセサにしておく**。Next が代入した
     * 時点で、その関数をこちらが包み直す。こうすると常に外側に来る。
     */
    try {
      const wrapFetch = (fn) => {
        if (typeof fn !== 'function' || fn.__vcide_callsite__) return fn;
        const w = function (...args) {
          let ctx;
          try {
            if (context.active().getValue(CALLSITE_KEY)) return fn.apply(this, args);
            ctx = context.active().setValue(CALLSITE_KEY, {
              at: 'globalThis.fetch', ...captureStack(60),
            });
          } catch { return fn.apply(this, args); }
          return context.with(ctx, () => fn.apply(this, args));
        };
        w.__vcide_callsite__ = true;
        return w;
      };
      let held = wrapFetch(globalThis.fetch);
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        get() { return held; },
        set(v) { held = wrapFetch(v); },
      });
      sink.note('callsite-entry-patched', 'globalThis.fetch');
    } catch (e) {
      sink.note('callsite-fetch-patch-failed', String(e && e.message).slice(0, 120));
    }

    for (const [label, proto, key] of targets) {
      const orig = proto[key];
      if (typeof orig !== 'function' || orig.__vcide_callsite__) continue;
      const wrapped = function (...args) {
        let ctx;
        try {
          // **いちばん外側の呼び出しだけを残す。** Pool.query は内部で
          // Client.query を呼ぶので、内側で上書きすると呼び出し元が消える
          if (context.active().getValue(CALLSITE_KEY)) return orig.apply(this, args);
          ctx = context.active().setValue(CALLSITE_KEY, {
            at: label, ...captureStack(60),
          });
        } catch { return orig.apply(this, args); }
        return context.with(ctx, () => orig.apply(this, args));
      };
      wrapped.__vcide_callsite__ = true;
      proto[key] = wrapped;
      sink.note('callsite-entry-patched', label);
    }
  }

  const callsiteProcessor = {
    onStart(span, parentContext) {
      if (!CALLSITE) return;
      try {
        const kind = wantsCallsite(span);
        if (!kind) return;
        /* 呼び出しの入口で取ったスタック（コンテキスト経由）。
         * 無ければ null を書く。**スパン開始時のスタックで代用しない。** */
        let carried = null;
        try { carried = parentContext ? parentContext.getValue(CALLSITE_KEY) : null; } catch { carried = null; }
        sink.write({
          type: 'callsite',
          spanId: span.spanContext().spanId,
          traceId: span.spanContext().traceId,
          target: kind,
          /** 呼び出しの入口で取れたスタック（これが根拠になる） */
          entry: carried ? { at: carried.at, frameSource: carried.frameSource ?? null, frames: carried.frames } : null,
          /** スパン開始時のスタック。**比較のためだけに持つ**（根拠にしない） */
          atSpanStart: captureStack(60).frames,
        });
      } catch (e) {
        sink.note('callsite-failed', String(e && e.message).slice(0, 200));
      }
    },
    onEnd() { /* noop */ },
    shutdown() { return Promise.resolve(); },
    forceFlush() { return Promise.resolve(); },
  };

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': process.env.POC02_SERVICE_NAME || 'poc01-fixture-app',
    }),
    spanProcessors: [callsiteProcessor, new SimpleSpanProcessor(exporter)],
  });
  provider.register();

  /* --------------------------------------------------------------------------
   * ブラウザとサーバーの関連付け（PoC-01 で成立。PoC-05 で公開範囲を絞った）。
   *
   * 応答にトレースIDを載せ返す。アプリコードには触らない（この計装ファイルの
   * 中だけで完結する）。ブラウザ側はこのヘッダ**だけ**を読む。
   *
   * 2つのヘッダを選べるようにしてある。PoC-05 で公開範囲が違うことを実測した。
   *   Server-Timing  ページ上の**任意のスクリプト**が Resource Timing API 経由で
   *                  同一オリジンの全リソースについて読める。公開範囲が広い
   *   X-Vcide-Trace  専用ヘッダ。Resource Timing API には出ない。
   *                  IDE は CDP で応答ヘッダを直接読めるので、これで足りる
   *
   * さらに、**ループバック以外のホスト宛の応答には一切付けない。** 開発用の
   * 識別子が意図せず外部へ出る経路を、ヘッダを付ける段階で閉じる。
   * ------------------------------------------------------------------------ */
  /** 専用ヘッダ（公開範囲が狭い）。PoC-05 の既定はこちらを使う */
  const TRACE_HEADER = process.env.POC05_TRACE_HEADER === '1';
  /** Server-Timing（PoC-01 からの既定。公開範囲が広いことを PoC-05 で実測した） */
  const SERVER_TIMING = process.env.POC05_SERVER_TIMING !== '0';
  /** 開発機の中だけに閉じる。実ホスト名・外部ドメイン宛には付けない */
  const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;

  /* --------------------------------------------------------- Phase 7B-3B-1
   * **IDE のプレビュー中継が要求ごとに作った識別子**を、受付スパンの属性に写す。
   *
   * 応答のトレース識別子（X-Vcide-Trace）はアプリのプロセスの中で付くので、
   * 同じパスの別の要求のものに付け替えられても中継には見分けがつかない（7B-3A 第9節 #12）。
   * そこで逆向きの証拠を足す: 中継が**自分で**乱数を作って要求に載せ（x-vcide-relay）、
   * 計装はそれを受付スパンに記録する。IDE は「自分が作った値を持つ受付スパン」を探すので、
   * 応答ヘッダが別の要求を指していれば食い違いとして検出できる。
   *
   * 値は 16 進 32 桁だけを受ける（mask.cjs でも同じ形を検査する）。既定では無効。
   * ------------------------------------------------------------------- */
  const RELAY_ID_ON = process.env.POC07_RELAY_ID === '1';
  const RELAY_ID_HEADER = 'x-vcide-relay';
  const RELAY_ID_FORM = /^[0-9a-f]{32}$/;

  const spanOfResponse = new WeakMap();
  patchWriteHead();

  function patchWriteHead() {
    const http = require('node:http');
    const proto = http.ServerResponse.prototype;
    if (proto.__poc01_patched__) return;
    proto.__poc01_patched__ = true;
    const orig = proto.writeHead;
    proto.writeHead = function (...args) {
      try {
        const sc = spanOfResponse.get(this)
          ?? trace.getSpan(context.active())?.spanContext();
        // 宛先がループバックでなければ、識別子を載せない
        const host = this.req && this.req.headers ? String(this.req.headers.host ?? '') : '';
        if (sc && !this.headersSent && LOOPBACK.test(host)) {
          const tp = `00-${sc.traceId}-${sc.spanId}-01`;
          if (SERVER_TIMING) this.setHeader('Server-Timing', `traceparent;desc="${tp}"`);
          if (TRACE_HEADER) this.setHeader('X-Vcide-Trace', tp);
        }
      } catch { /* 応答を壊さない。取れなければ取れないままにする */ }
      return orig.apply(this, args);
    };
  }

  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        /* 受付の要求から読むのは中継の識別子の1つだけ（RELAY_ID_ON のとき）。他のヘッダは読まない */
        requestHook(span, request) {
          if (!RELAY_ID_ON) return;
          try {
            const h = request && request.headers ? request.headers[RELAY_ID_HEADER] : undefined;
            if (typeof h === 'string' && RELAY_ID_FORM.test(h)) span.setAttribute('vcide.relay.id', h);
          } catch { /* 取れなければ取れないままにする */ }
        },
        // 本文もヘッダも読まない。応答オブジェクトとスパンの対応だけを覚える
        responseHook(span, response) {
          try {
            if (response && typeof response.setHeader === 'function') {
              spanOfResponse.set(response, span.spanContext());
            }
          } catch { /* noop */ }
        },
        ignoreIncomingRequestHook(req) {
          const u = String(req.url ?? '');
          return u.startsWith('/_next/') || u === '/favicon.ico';
        },
      }),
      // enhancedDatabaseReporting は既定の false のまま。true にすると
      // db.statement.parameters（＝パラメータ値）が付くため、使ってはならない
      new PgInstrumentation({ requireParentSpan: false }),
      ...prismaInstrumentation(),
      ...undiciInstrumentation(),
    ],
  });

  /* **計装の登録より後**に当てる。先に当てると計装のラッパが外側になり、
   * コンテキストを捕まえる時点がこちらより早くなって値が運ばれない */
  patchCallsiteEntry();

  sink.note('registered', 'NodeTracerProvider と計装を登録した');

  /* --------------------------------------------------------------- PoC-02
   * サーバー内部の fetch の計装（Gate A）。
   *
   * Next.js の `fetch` は `node:http` を通らないため、`instrumentation-http`
   * では client スパンも traceparent の注入も起きない（PoC-05 第3章 #2）。
   * undici の計装は diagnostics_channel を使うので、ここを埋められる。
   *
   * **ループバック以外の宛先は計装しない。** 計装しなければスパンも作られず、
   * traceparent も注入されない。開発用のトレース識別子が外部へ出る経路を、
   * 注入する側で閉じている（指示 第2節・第6節）。
   * ------------------------------------------------------------------- */
  function undiciInstrumentation() {
    if (!UNDICI) return [];
    try {
      const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
      const { isLoopbackOrigin } = require('./loopback.cjs');
      sink.note('undici-instrumentation', 'loaded');
      return [new UndiciInstrumentation({
        // 計装しない = スパンを作らない = traceparent を注入しない
        ignoreRequestHook: (req) => !isLoopbackOrigin(req.origin),
      })];
    } catch (e) {
      sink.note('undici-instrumentation-failed', String(e && e.message).slice(0, 200));
      return [];
    }
  }

  function prismaInstrumentation() {
    try {
      const { PrismaInstrumentation } = require('@prisma/instrumentation');
      sink.note('prisma-instrumentation', 'loaded');
      return [new PrismaInstrumentation()];
    } catch (e) {
      sink.note('prisma-instrumentation-failed', String(e && e.message).slice(0, 200));
      return [];
    }
  }

  void SpanStatusCode;
}
