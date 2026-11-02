/* =============================================================================
 * 変換アダプタ（層2）— 観測結果 → 共通オブジェクトモデル。
 *
 * 純粋な変換である。UI を知らない。座標を作らない。乱数も時刻も使わない。
 *
 * 守ること（05c 5.2節）:
 *   1. projects の始点は SqlStatement。DbTable → DbColumn の辺を作らない
 *   2. 観測できなかった区間を省略しない。切断として表現する
 *   3. ステップバッジを持たせない（表示順から再計算する揮発値）
 *   4. 件数・経路全体の観測性・最弱環を持たせない（経路から算出する）
 *   5. スパンの開始時刻を保持する
 *   6. 座標は作らない
 *
 * そして: **取得手段は記録の種別から決まる。** 観測性はそこから導出される。
 * 「画面に出したいから実測にする」経路は存在しない。
 * ========================================================================== */
import {
  ATTRIBUTION_SCOPE_NOTE, hop, node, type Convergence, type Cut, type Dataset, type ModelHop,
  type ModelHopInput, type ModelNode, type OffPath, type OverviewRow, type SourceId,
} from './model';
import type {
  ObsBrowserRequest, ObsElementAnchor, ObsElements, ObsServerCallsite, ObsSpan,
  ObsSqlAnalysis, ObservationBundle,
} from './observation';
import {
  DATA_ACCESS_FAILURE_LABEL, DOC_UNBOUND_LABEL, LINEAGE_CUT_LABEL, LINEAGE_STAGE_LABEL, RELAY_ID_ATTR, RELAY_KIND_LABEL,
  type DocBinding, type HandlesBasis, type LiveDataAccess, type LiveExchange, type LiveLineage, type LiveRunObservation,
} from './liveObservation';

/* -------------------------------------------------------------------------- */
/* 記録の種別 → 取得手段。この表が「根拠に従う」の実体である（05c 6章）         */
/* -------------------------------------------------------------------------- */
const SOURCE_OF = {
  /** ブラウザのネットワーク記録 */
  browserRequest: 'browser-network',
  /** 計装が生成したスパン */
  span: 'trace-span',
  /** ORM・ドライバ計装が載せた SQL 文 */
  sqlStatement: 'orm-instrumentation',
  /** 実測SQLの構文解析 */
  sqlParse: 'sql-ast-parse',
  /** 情報スキーマへの照会 */
  introspection: 'db-introspection',
  /** トレースIDの一致による結合 */
  traceContext: 'trace-context',
  /** 結合に失敗し、時間の重なりで推定した場合 */
  timeWindow: 'time-window',
  /** ブラウザの DOM を直接読んだ（PoC-03） */
  domRead: 'dom-read',
  /** ビルド時に注入した要素識別子（PoC-03） */
  elementAnchor: 'element-anchor',
  /** ブラウザが記録した通信開始時の呼び出しスタック（PoC-05） */
  requestInitiator: 'request-initiator',
  /** サーバー側でデータ取得の呼び出し時に記録したスタック（PoC-02） */
  serverCallStack: 'server-call-stack',
  /**
   * ソースコードの静的解析（PoC-04）。**L2 である。**
   * 列の解決に実測の SQL を使っても、参照の連鎖そのものは推定であるため
   * 昇格しない（`observabilityOf` が SOURCE_LEVEL から決めるので、
   * この表を書き換えても格上げできない）。
   */
  staticAnalysis: 'static-analysis',
} as const satisfies Record<string, SourceId>;

/* -------------------------------------------------------------------------- */
/* 射影を解決できなかった理由 → 画面に出す文言                                  */
/*                                                                            */
/* **Phase 6F で表にした。** それまでは `select-star-or-empty` 以外を           */
/* まとめて「修飾が一意に決まらず…」と書いていたため、**理由が違うものに         */
/* 同じ説明を付けていた**（たとえば ORDER BY だけに現れた列）。                  */
/* 観測できていないことの説明を間違えるのは、観測できていないことを隠すのと      */
/* 同じ害がある（OBS-05）。理由ごとに言い分ける。                                */
/* -------------------------------------------------------------------------- */
const UNRESOLVED_PROJECTION_WHY: Record<string, string> = {
  'select-star': 'SELECT * のため、実行されたSQLからも結果列を列挙できなかった',
  'aggregate-or-expression': 'SELECT句のその項目は集計・式・関数であり、1つの列に帰属しない',
  'ambiguous-qualifier': '修飾が書かれておらず、FROM句に表が複数あるため、どの表の列か決まらなかった',
  'unknown-qualifier': '書かれている修飾に対応する表が FROM 句に無かった',
  'derived-table-qualifier': '副問い合わせ・CTE の出力を参照しており、元の表の列まで決まらなかった',
  'no-table-in-scope': 'FROM 句に表が無く、列の帰属先が決まらなかった',
  'schema-not-determined': '表は決まったがスキーマが書かれておらず、定義を一意に指せなかった',
  /* 旧 sqlparse.mjs / PoC-04 の観測結果が持つ理由コード。読めるようにしておく */
  'select-star-or-empty': 'SELECT * のため列を特定できなかった',
  'referenced-outside-select-list':
    'SELECT句の外（ORDER BY 等）で参照された列であり、結果の行には無いため列として出さなかった',
};

/** 理由コードが未知なら、**知らないことを知らないと書く。**推測の説明を当てない */
const whyOfUnresolvedProjection = (why: string): string =>
  UNRESOLVED_PROJECTION_WHY[why] ?? `解決できなかった（理由コード: ${why}）`;

const fmtMs = (ms: number) => Math.round(ms);

/** 通信の呼び出し元を特定できなかった理由の文言（PoC-05） */
const REQUEST_INITIATOR_REASON: Record<string, string> = {
  'no-script-stack': 'ブラウザがこの通信の呼び出しスタックを記録していない（文書の取得など）',
  'no-app-frame': '呼び出しスタックに、注入範囲のソースへ戻せるフレームが無い',
  'source-line-mismatch': '戻した位置のソース行に通信の呼び出しが無い',
  'component-not-agreed': '囲むコンポーネントが、2つの情報源で一致しない',
};

/** 文字種の表示文言。値そのものは出さない（PoC-03 の収集方針） */
const CLS_LABEL: Record<string, string> = {
  cjk: '和文', latin: '英数', digits: '数値', mixed: '和文と英数の混在', other: 'その他',
};

/**
 * 祖先の要素識別子から包含しているコンポーネントの並びを作る。
 * これは**文脈**であって、この要素の出所ではない。
 * 出所は「その要素自身に付いていた識別子」だけである。
 */
function componentChain(el: ObsElements, own: string, ancestorIds: string[]): string[] {
  const byId = new Map(el.anchors.map((a) => [a.id, a]));
  const out = [own];
  for (const id of ancestorIds) {
    const a = byId.get(id);
    if (a && a.component !== out[out.length - 1]) out.push(a.component);
  }
  return out;
}

/** SQL 文を札や一覧に出す長さに切る。全文は概要に置く（UI-15） */
function shortSql(sql: string, max = 58): string {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** 祖先をたどる。親子が直結でなくても、同一トレース内の連鎖は実測の事実である。 */
function ancestry(spans: Map<string, ObsSpan>, from: ObsSpan, targetId: string) {
  let cur: ObsSpan | undefined = from;
  let depth = 0;
  while (cur?.parentSpanId) {
    const parent: ObsSpan | undefined = spans.get(cur.parentSpanId);
    depth++;
    if (!parent) return null;
    if (parent.spanId === targetId) return { depth };
    cur = parent;
  }
  return null;
}

/** 要素識別子の注入範囲についての注記。PoC-03 の観測がある記録だけに付く */
function elementsNote(obs: ObservationBundle): string {
  const el = obs.elements;
  if (!el) return '';
  return `画面の要素は ${el.anchoredElements} / ${el.totalElements} 個に`
    + `要素識別子が付いています（${el.injectedScope} に注入範囲を限っているため）。`
    + '表示された値そのものは保存していません。';
}

/* -------------------------------------------------------------------------- */
/* ① 表示された値 と ② コンポーネント — PoC-03 の観測がある場合だけ作る        */
/*                                                                            */
/* PoC-01（elements 無し）/ PoC-03 / PoC-05 / PoC-02 の4つの変換が同じこれを    */
/* 使う。**条件も文言も1箇所にしか無い。** 片方だけ緩めることができない。        */
/* -------------------------------------------------------------------------- */
function buildValueAndComponent(
  obs: ObservationBundle,
  startId: number,
  nodes: ModelNode[],
  hops: ModelHop[],
  skipped: { what: string; why: string }[],
): {
  valueId?: number; componentId?: number; nextId: number;
  /**
   * ② のノードが指しているソース位置（要素識別子が指す JSX の位置）。
   * **`supplies` の端点（props 束縛位置）が同じ行に在ることの照合に使う。**
   * 位置が食い違うなら、② のノードは束縛位置を担えない（02a 3.5.1 の
   * `ENDPOINT_CARRIER`）ので、由来のホップを作らない。
   */
  anchorSite?: { file: string; line: number; component: string };
} {
  let nextId = startId;

  /* ------------------------------------------- ① 表示された値 ② コンポーネント
   * PoC-03 の観測がある場合だけ作る。無い記録（PoC-01）では作らない。
   * 作れるのは「要素自身に識別子が付いていて、その識別子が表に載っていて、
   * 報告位置をソースの読み直しで確認できた」場合に限る。 */
  const el = obs.elements;
  const primary = el?.selections.find((s) => s.key === el.primaryKey);
  let primaryAnchor: ObsElementAnchor | undefined;
  if (el && primary?.anchorOnSelf) {
    primaryAnchor = el.anchors.find((a) => a.id === primary.anchorOnSelf);
    if (!primaryAnchor) {
      skipped.push({ what: '表示された値とコンポーネント', why: '要素識別子が対応表に無かった' });
    } else if (!primaryAnchor.verified) {
      // 照合できていないものを実測として出さない
      skipped.push({
        what: '表示された値とコンポーネント',
        why: '識別子が指すソース位置に、その要素があることを確認できなかった',
      });
      primaryAnchor = undefined;
    }
  } else if (el) {
    skipped.push({
      what: '表示された値とコンポーネント',
      why: `主対象の要素に識別子が付いていなかった（${primary?.failure?.reason ?? '理由不明'}）`,
    });
  }

  let valueId: number | undefined;
  let componentId: number | undefined;
  let anchorSite: { file: string; line: number; component: string } | undefined;
  if (el && primary && primaryAnchor) {
    valueId = nextId++;
    componentId = nextId++;
    const chain = componentChain(el, primaryAnchor.component, primary.ancestorAnchors);
    const shape = primary.valueShape;
    anchorSite = {
      file: primaryAnchor.file, line: primaryAnchor.line, component: primaryAnchor.component,
    };

    nodes.push(node({
      id: valueId, kind: 'value', form: 'physical',
      title: '表示された値',
      // 値そのものは識別子にしない。位置で指す
      identifier: `<${primary.tag}> のテキスト #${primary.textNodeIndex ?? 0}`,
      chipSub: `<${primary.tag}>`,
      hover: 'この値が画面に描かれています',
      overview: [
        { k: '取得手段', v: 'ブラウザのDOM直接読み取り' },
        { k: '要素', v: `<${primary.tag}> — ${primaryAnchor.component} 内` },
        {
          k: '値の形',
          v: shape ? `${shape.chars} 文字・${CLS_LABEL[shape.cls] ?? shape.cls}` : '取得できていません',
        },
        {
          k: '値の保存',
          v: '表示された値そのものは保存していません。対応付けは要素識別子と'
            + 'テキストノードの位置で行っています',
        },
        { k: '次の一歩', v: 'この値を描いたコンポーネントを見る', go: { type: 'node', id: componentId } },
      ],
      source: SOURCE_OF.domRead,
      evidence: [
        'この要素自身に付いていた要素識別子',
        `同一識別子の DOM 要素 ${primary.anchorInstanceCount} 個のうち`
          + ` ${(primary.anchorOrdinal ?? 0) + 1} 番目`,
      ],
    }));

    nodes.push(node({
      id: componentId, kind: 'component', form: 'module',
      title: 'コンポーネント',
      identifier: `${primaryAnchor.file}:${primaryAnchor.line}`,
      chipSub: primaryAnchor.component,
      hover: 'この値を描いたコンポーネント',
      overview: [
        { k: '取得手段', v: 'ビルド時に注入した要素識別子' },
        { k: '定義', v: `${primaryAnchor.file}:${primaryAnchor.line}` },
        ...(primaryAnchor.sourceLine ? [{ k: 'JSX', v: primaryAnchor.sourceLine }] : []),
        {
          k: 'コンポーネント',
          v: `${primaryAnchor.component}（${primaryAnchor.file}:${primaryAnchor.componentLine} で定義）`,
        },
        { k: '包含関係', v: chain.join(' ← ') },
        {
          k: 'この JSX が生んだ要素',
          v: `${primary.anchorInstanceCount} 個（${ATTRIBUTION_SCOPE_NOTE.instanceUnknown}）`,
        },
        { k: '注入範囲', v: `${el.injectedScope} のみ。範囲外の要素は特定不能と返します` },
      ],
      source: SOURCE_OF.elementAnchor,
      evidence: [
        'ビルド時に生成した「要素識別子 → ソース位置」の対応表',
        '報告位置のソースを読み直し、同じ要素・同じコンポーネントであることを確認',
      ],
    }));

    hops.push(hop({
      id: 'renders', order: hops.length + 1, from: valueId, to: componentId, relation: 'renders',
      label: 'この値を描いたコンポーネント',
      /* データは「コンポーネント → 要素」に流れる。画面の経路は逆向きに進む */
      orientation: 'against-data',
      source: SOURCE_OF.elementAnchor,
      evidence: [
        '要素自身に付いていた識別子の一致',
        '識別子が指すソース位置にその要素があることの確認',
      ],
    }));
  }

  /* 特定できなかった選択は、隠さずに記録する（FR-11b） */
  for (const s of el?.selections ?? []) {
    if (s.failure) {
      skipped.push({
        what: `選択 ${s.key}（${s.tag ? `<${s.tag}>` : '不明'}）`,
        why: `特定不能: ${s.failure.reason}${s.failure.detail ? ` — ${s.failure.detail}` : ''}`,
      });
    }
  }

  return { valueId, componentId, nextId, ...(anchorSite ? { anchorSite } : {}) };
}

export interface AdapterResult {
  dataset: Dataset;
  /** 変換の過程で「作らなかったもの」。捏造していないことの記録 */
  skipped: { what: string; why: string }[];
}

/**
 * 観測結果を経路1本のオブジェクトモデルへ変換する。
 * 変換できない部分は作らずに skipped へ落とす。合成データで埋めない。
 */
export function fromObservation(obs: ObservationBundle): AdapterResult {
  const skipped: { what: string; why: string }[] = [];
  const spanById = new Map(obs.spans.map((s) => [s.spanId, s]));
  const t0 = obs.page.startMs;
  const rel = (ms: number) => +(ms - t0).toFixed(1);

  /* ---------------------------------------------- ③ 通信（主経路にする1件） */
  const focus = obs.browserRequests.find(
    (r) => r.method === obs.focus.method && r.path === obs.focus.path,
  );
  if (!focus) throw new Error(`focus request not observed: ${obs.focus.method} ${obs.focus.path}`);

  const nodes: ModelNode[] = [];
  const hops: ModelHop[] = [];
  let nextId = 1;
  /* ------------------------------------------- ① 表示された値 ② コンポーネント */
  const vc = buildValueAndComponent(obs, nextId, nodes, hops, skipped);
  nextId = vc.nextId;
  const valueId = vc.valueId;
  const componentId = vc.componentId;
  /* ------------------------------------------------------------ 識別子の割り当て
   * ノードの番号は「次の一歩」の導線にそのまま出る。先に確定させる。
   * ④ サーバー処理が観測できていなければ、ここで止まる（代わりの値で埋めない）。 */
  // 応答に載って返ってきたトレースIDから、サーバー側の HTTP スパンを引く
  const httpSpan = focus.server ? spanById.get(focus.server.spanId) : undefined;
  // サーバー処理として描くのは、ルートハンドラの実行スパンである
  const handlerSpans = obs.spans.filter(
    (s) => s.attrs['next.span_type'] === 'AppRouteRouteHandlers.runHandler'
      && (!httpSpan || s.traceId === httpSpan.traceId),
  );
  const handler = handlerSpans[0];
  if (!handler) {
    throw new Error('route handler span not observed');
  }

  /*
   * ②' この通信を開始したコンポーネント（PoC-05）。
   * **4つの条件がすべて揃ったときだけ**ノードと関係を作る。
   *   フレームが解決できた / ソース行に通信の呼び出しがあった /
   *   囲むコンポーネントが2つの独立した情報源で一致した
   * 揃わなければノードも関係も作らず、切断として示す。
   */
  const initiator = focus.initiator ?? null;
  const hasInitiator = !!(initiator && initiator.frame && initiator.verified && initiator.component);
  if (initiator && !hasInitiator) {
    skipped.push({
      what: 'この通信を開始した箇所（requests）',
      why: initiator.failure
        ? REQUEST_INITIATOR_REASON[initiator.failure.reason] ?? initiator.failure.reason
        : '成立の条件が揃わなかった',
    });
  }

  /*
   * 番号は経路の順に振る。②' → ③ → ④ の順である。
   * キャンバスのバッジは表示順から計算され、番号付きリストは識別子を出す。
   * 両者が食い違わないように、識別子を経路の順で割り当てる。
   */
  const initiatorId = hasInitiator ? nextId++ : undefined;
  const httpId = nextId++;
  const handlerId = nextId++;

  /* -------------------------------------- ②' この通信を開始したコンポーネント */
  if (hasInitiator && initiatorId !== undefined) {
    const f = initiator!.frame!;
    const c = initiator!.component!;
    nodes.push(node({
      id: initiatorId, kind: 'component', form: 'module',
      title: 'コンポーネント',
      identifier: `${f.file}:${f.line}`,
      chipSub: c.name,
      hover: 'この通信を開始したコンポーネント',
      overview: [
        { k: '取得手段', v: 'ブラウザが記録した通信開始時の呼び出しスタック' },
        { k: '呼び出し位置', v: `${f.file}:${f.line}:${f.col}` },
        ...(initiator!.sourceLine ? [{ k: 'ソース', v: initiator!.sourceLine }] : []),
        ...(f.functionName ? [{ k: '関数', v: f.functionName }] : []),
        { k: 'コンポーネント', v: `${c.name}（${c.file}:${c.line}〜${c.endLine}）` },
        /* 帰属はソース位置まで。描画インスタンスには及ばない（決定 G） */
        { k: '帰属の範囲', v: ATTRIBUTION_SCOPE_NOTE.definitionOnly },
        {
          k: '主張の範囲',
          v: 'この通信を始めたのはこの位置のコードである、までです。'
            + '応答のどの項目が画面のどの値になったかは観測していません',
        },
        { k: '次の一歩', v: 'この通信を見る', go: { type: 'node', id: httpId } },
      ],
      source: SOURCE_OF.requestInitiator,
      evidence: [
        'ブラウザが要求を送る時点で記録した呼び出しスタック',
        'ソースマップで戻した位置のソース行に通信の呼び出しがあることの確認',
        'ソースの読み直しとビルド時のマニフェストで、囲むコンポーネントが一致',
      ],
    }));
    hops.push(hop({
      id: 'requests', order: hops.length + 1, from: initiatorId, to: httpId, relation: 'requests',
      label: 'そのコンポーネントが始めた通信',
      /*
       * **始点は通信を呼び出した位置であって、コンポーネント定義ではない**
       * （02a 3.5.1 / 06f I-5）。囲むコンポーネントは文脈として持つ。
       */
      endpoints: {
        from: {
          type: 'DataAccessSite', file: f.file, line: f.line, col: f.col, inComponent: c.name,
        },
      },
      source: SOURCE_OF.requestInitiator,
      evidence: [
        `呼び出し位置 ${f.file}:${f.line}`,
        'ブラウザが記録した呼び出しスタックの最上位のアプリ側フレーム',
      ],
    }));
  }

  nodes.push(node({
    id: httpId, kind: 'http', form: 'module',
    /* ブラウザのネットワーク記録に現れた通信（02a 3.2 の観測位置） */
    exchangeScope: 'browser',
    title: '通信', identifier: `${focus.method} ${focus.path}`,
    chipSub: `${focus.method} ${focus.path}`,
    metrics: {
      status: focus.status,
      ...(focus.durationMs !== null ? { durationMs: fmtMs(focus.durationMs) } : {}),
    },
    span: { startMs: rel(focus.startMs), endMs: rel(focus.startMs + (focus.durationMs ?? 0)) },
    hover: 'ブラウザが実際に行った通信',
    overview: [
      { k: '取得手段', v: 'ブラウザのネットワーク計測' },
      { k: '応答', v: '', fromMetrics: true },
      ...(focus.readHeaderKeys
        ? [{ k: '読んだ応答ヘッダ', v: `${focus.readHeaderKeys.join(' / ')} の ${focus.readHeaderKeys.length} 件だけ。他のヘッダも本文も読んでいません` }]
        : []),
      ...(focus.redirects?.length
        ? [{ k: 'リダイレクト', v: `${focus.redirects.length} 段。段ごとに別のサーバー処理である` }]
        : []),
      { k: '次の一歩', v: 'サーバー処理を見る', go: { type: 'node', id: handlerId } },
    ],
    source: SOURCE_OF.browserRequest,
    evidence: [
      focus.via === 'dedicated-header'
        ? '応答の専用ヘッダに載ったトレースID'
        : '応答の Server-Timing に載ったトレースID',
      ...(focus.durationMs !== null ? ['ブラウザの通信タイミング計測'] : []),
    ],
  }));

  /* -------------------------------------------------------- ④ サーバー処理 */
  const linkedByTraceId = !!focus.server && !!httpSpan && httpSpan.traceId === handler.traceId;
  nodes.push(node({
    id: handlerId, kind: 'server', form: 'physical',
    title: 'サーバー処理', identifier: handler.name,
    chipSub: String(handler.attrs['next.route'] ?? handler.name),
    metrics: { durationMs: fmtMs(handler.durationMs) },
    span: { startMs: rel(handler.startMs), endMs: rel(handler.endMs) },
    hover: 'この通信を受けたサーバーの処理',
    overview: [
      { k: '取得手段', v: '計装が生成したスパン' },
      { k: '区間', v: '', fromMetrics: true },
      { k: 'ルート', v: String(handler.attrs['next.route'] ?? '—') },
      { k: '次の一歩', v: '実行SQLを見る', go: { type: 'node', id: handlerId + 1 } },
    ],
    source: SOURCE_OF.span,
    evidence: ['スパンの名前と区間', `トレースID ${handler.traceId.slice(0, 8)}…`],
  }));

  hops.push(hop({
    id: 'handles', order: hops.length + 1, from: httpId, to: handlerId, relation: 'handles',
    label: 'この通信を受けたサーバーの処理',
    source: linkedByTraceId ? SOURCE_OF.traceContext : SOURCE_OF.timeWindow,
    evidence: linkedByTraceId
      ? [
        '応答に載って返ったトレース識別子と、サーバー側スパンの識別子の一致',
        'HTTPスパンからハンドラスパンへの親子の連鎖',
        ...(focus.browserRequestId ? ['ブラウザ内の要求識別子ごとに1件ずつ対応している'] : []),
      ]
      : ['時間の重なり'],
    ...(linkedByTraceId ? {} : {
      tagLabel: '時間の重なりで推定',
      weakness: 'トレースIDを応答から受け取れなかったため、時間の重なりで紐付けています。並行リクエストがあると成立しません。',
    }),
  }));

  /* ------------------------------------------------------------ ⑤ 実行SQL */
  // ハンドラスパンの子孫のうち、SQL 文を持つスパンだけを採る
  const sqlSpans = obs.spans
    .filter((s) => obs.sqlAnalyses.some((a) => a.spanId === s.spanId))
    .filter((s) => s.traceId === handler.traceId)
    .map((s) => ({ span: s, chain: ancestry(spanById, s, handler.spanId) }))
    .filter((x) => x.chain !== null)
    .sort((a, b) => a.span.startMs - b.span.startMs);

  if (!sqlSpans.length) {
    skipped.push({ what: '実行SQL', why: 'ハンドラスパンの子孫に SQL 文を持つスパンが無かった' });
  }

  const sqlNodeIds: number[] = [];
  for (const { span: s, chain } of sqlSpans) {
    const a = obs.sqlAnalyses.find((x) => x.spanId === s.spanId)!;
    const id = nextId++;
    sqlNodeIds.push(id);
    nodes.push(node({
      id, kind: 'sql', form: 'module',
      title: '実行SQL', identifier: shortSql(a.sql),
      // SQL断片は札に置かない（表示規則3）
      chipSub: '',
      metrics: { durationMs: fmtMs(s.durationMs) },
      span: { startMs: rel(s.startMs), endMs: rel(s.endMs) },
      hover: 'その処理が実行したSQL',
      overview: [
        { k: '取得手段', v: s.scope.includes('prisma') ? 'ORM計装のスパン属性' : 'DBドライバ計装のスパン属性' },
        { k: '区間', v: '', fromMetrics: true },
        { k: 'SQL', v: a.sql },
        {
          k: 'パラメータ',
          v: a.redacted
            ? `収集しません（文字列 ${a.redacted.strings} 件・数値 ${a.redacted.numbers} 件を取得時点で除去）`
            : '収集しません',
        },
        { k: '取得件数', v: '計装から取得できていません' },
      ],
      source: SOURCE_OF.sqlStatement,
      evidence: [
        `計装 ${s.scope} のスパン属性`,
        chain!.depth === 1
          ? 'ハンドラスパンの直接の子'
          : `ハンドラスパンからの親子の連鎖（${chain!.depth} 段）`,
      ],
    }));

    hops.push(hop({
      id: `executes-${id}`, order: hops.length + 1, from: handlerId, to: id, relation: 'executes',
      label: 'その処理が実行したSQL',
      source: SOURCE_OF.span,
      evidence: ['スパンの親子関係', `同一トレース ${s.traceId.slice(0, 8)}…`],
    }));
  }

  /* ------------------------------------------------------ ⑥ テーブル ⑦ カラム */
  const tableNodeId = new Map<string, number>();

  for (const sqlId of sqlNodeIds) {
    const sqlNode = nodes.find((n) => n.id === sqlId)!;
    const a = obs.sqlAnalyses.find((x) => shortSql(x.sql) === sqlNode.identifier)!;

    for (const t of a.tables) {
      const known = obs.dbObjects.tables.find(
        (x) => x.name === t.name && (!t.schema || x.schema === t.schema),
      );
      if (!known) {
        skipped.push({
          what: `テーブル ${t.schema ?? '?'}.${t.name}`,
          why: '情報スキーマに見つからなかったため、ノードを作らなかった',
        });
        continue;
      }
      const key = `${known.schema}.${known.name}`;
      let id = tableNodeId.get(key);
      if (id === undefined) {
        id = nextId++;
        tableNodeId.set(key, id);
        nodes.push(node({
          id, kind: 'table', form: 'physical',
          title: 'テーブル', identifier: key, chipSub: known.name,
          hover: 'そのSQLが読んだテーブル',
          overview: [
            { k: '取得手段', v: 'DBの情報スキーマへの照会' },
            { k: '定義', v: key },
            ...(known.rowEstimate !== null ? [{ k: '行数（推定）', v: `約 ${known.rowEstimate} 行` }] : []),
          ],
          source: SOURCE_OF.introspection,
          evidence: ['実行されたSQL文の FROM 句', 'DBの情報スキーマとの一致'],
        }));
      }
      hops.push(hop({
        id: `reads-${sqlId}-${id}`, order: hops.length + 1, from: sqlId, to: id, relation: 'reads',
        label: 'そのSQLが読んだテーブル',
        source: SOURCE_OF.sqlParse,
        evidence: ['SQL文の FROM 句'],
      }));
    }

    /* 規約1: projects の始点は SqlStatement。テーブルからカラムへの辺は作らない */
    for (const p of a.projections) {
      const def = obs.dbObjects.columns.find(
        (c) => c.schema === p.schema && c.table === p.table && c.column === p.column,
      );
      if (!def) {
        skipped.push({
          what: `カラム ${p.schema}.${p.table}.${p.column}`,
          why: '情報スキーマに見つからなかったため、ノードを作らなかった',
        });
        continue;
      }
      const id = nextId++;
      nodes.push(node({
        id, kind: 'column', form: 'module',
        title: 'カラム', identifier: `${def.column} (${def.dataType})`, chipSub: def.column,
        hover: 'そのSQLが取り出した列',
        overview: [
          { k: '取得手段', v: '実行されたSQL文の構文解析' },
          { k: '型', v: def.dataType },
          { k: 'NULL', v: def.nullable ? '可' : '不可' },
          { k: '定義', v: `${def.schema}.${def.table}.${def.column}` },
        ],
        source: SOURCE_OF.sqlParse,
        evidence: ['SQL文の SELECT 句', 'DBの情報スキーマとの一致'],
      }));
      hops.push(hop({
        id: `projects-${sqlId}-${id}`, order: hops.length + 1, from: sqlId, to: id,
        relation: 'projects',
        label: 'そのSQLが取り出した列',
        source: SOURCE_OF.sqlParse,
        evidence: ['SQL文の SELECT 句'],
      }));
    }
    for (const u of a.unresolved) {
      skipped.push({
        what: `射影 ${u.column ?? '(不明)'}`,
        why: whyOfUnresolvedProjection(u.why),
      });
    }
  }

  /* ---------------------------------------------- 規約2: 観測できない区間は切断 */
  /*
   * PoC-03 の観測があると、ブラウザ側（①②）とサーバー側（③〜⑦）の
   * **2つの実測の塊**ができる。両者を結ぶ共通の証拠は得られていないので、
   * 関係を作らずに、どちらの側からも切断として示す（OBS-05 / 指示 第7節）。
   */
  const derivesCut: Cut = {
    from: componentId ?? httpId,
    head: 'ここから先は観測していません',
    sub: 'props の由来（応答のどの項目がこの値になったか）',
    where: 'コンポーネントの props / 応答の項目',
    kind: 'derives は構造的に推定（02a 3.5.1）。本PoCでは関係を作らない',
  };
  /*
   * この通信を開始した箇所の証拠が無いときだけ、通信から切断を生やす。
   * 証拠があるときは `requests` を作るので、切断は作らない（二重に言わない）。
   */
  const initiatorCut: Cut = {
    from: httpId,
    head: 'この通信を起こした箇所は特定していません',
    sub: initiator?.failure
      ? REQUEST_INITIATOR_REASON[initiator.failure.reason] ?? initiator.failure.reason
      : 'コンポーネントと通信を結ぶ共通の証拠が無い',
    where: 'ブラウザの通信の呼び出し元',
    kind: '証拠が無いため関係を作らない',
  };
  const cuts: Cut[] = componentId !== undefined
    ? (hasInitiator ? [derivesCut] : [derivesCut, initiatorCut])
    : hasInitiator ? [{
      from: initiatorId!,
      head: 'ここより上流は観測していません',
      sub: '表示された値（この通信の応答がどの値になったか）',
      where: 'ブラウザのDOM / props の由来',
      kind: 'PoC-05 の範囲外（derives は構造的に推定）',
    }] : [{
      from: httpId,
      head: 'ここより上流は観測していません',
      sub: '表示された値とコンポーネント',
      where: 'ブラウザのDOM / Reactコンポーネント',
      kind: 'PoC-01 の範囲外（PoC-03 の検証対象）',
    }];

  /* -------------------------------------------------------------- 経路外 */
  const others = obs.browserRequests.filter((r) => r !== focus);

  const dataset: Dataset = {
    origin: 'measured',
    project: obs.meta.app.name,
    runtime: {
      command: 'npm run dev',
      port: obs.meta.app.port,
      instrumentation: obs.meta.instrumentation.method,
    },
    nodes, hops, cuts,
    offPath: {
      // 存在も区間も観測したが、いま描いているのは主経路の1本である
      detail: 'full',
      label: others.map((r) => `${r.method} ${r.path}`).join(' / ') || 'なし',
      note: others.length
        ? 'このページで観測した、いま描いていない通信です。区間は観測しています。'
        : 'このページで観測した他の通信はありません。',
      nodes: others.map((r) => ({
        kind: 'http' as const,
        label: r.path,
        ...(r.durationMs !== null ? { durationMs: fmtMs(r.durationMs) } : {}),
      })),
      caption: {
        text: '選択していない経路（このページの他の通信）',
        textUnselected: 'このページの他の通信',
      },
    },
    pages: obs.meta.app.pages,
    notice: `${obs.meta.poc} 実測データ／${obs.meta.instrumentation.method}`
      + `・${obs.meta.instrumentation.bundler}`,
    overviewNote:
      `表示している数値は ${obs.meta.collectedAt} に実際の計装から取得したものです。`
      + `静的資材の通信 ${obs.meta.excluded.staticAssetRequests} 件は件数に含めていません。`
      + elementsNote(obs),
    provenance: {
      instrumentation: `${obs.meta.instrumentation.method}（${obs.meta.instrumentation.detail}）`,
      bundler: obs.meta.instrumentation.bundler,
      traceId: handler.traceId,
      collectedAt: obs.meta.collectedAt,
      notObserved: obs.meta.notObserved,
    },
  };

  return { dataset, skipped };
}

/* ========================================================================== */
/* PoC-02 — RSC がサーバー内部で直接データを取得する経路の変換                   */
/*                                                                            */
/* fromObservation（client-fetch 経路）とは経路の形が違う（02a 3.5.2節）。      */
/*   client-fetch : renders → … → requests → handles → invokes → executes → … */
/*   rsc-direct   : renders → …（derives なし）→ invokes → executes → …        */
/*                                                                            */
/* **ブラウザ側の API 通信は存在しない。** 文書の取得1件だけが見え、その内部に   */
/* SQL とサーバー内部通信が入れ子になっている（01b Q-02 C-1）。                  */
/* したがってここでは `/api/...` のノードを作らない。作る材料も無い。           */
/*                                                                            */
/* 守ること:                                                                   */
/*   1. 観測したスパンしかノードにしない。Next 内部のスパンがあることを          */
/*      「特定のコンポーネントの処理」と読み替えない                             */
/*   2. コンポーネントへの帰属は、呼び出しスタックの証拠があるときだけ作る        */
/*   3. 伝播が成立しなかったサーバー内部通信は、相手側のノードを作らない          */
/*   4. 描いた値（②）と実行したコンポーネント（②''）の間に線を引かない          */
/* ========================================================================== */

/** 帰属が成立したか。4つの条件が揃ったときだけ真 */
const attributed = (c: ObsServerCallsite | null | undefined): boolean =>
  !!(c && c.frame && c.verified && c.component);

/** 帰属を作らなかった理由の文言 */
const CALLSITE_REASON: Record<string, string> = {
  'no-entry-callsite': '呼び出しの入口でスタックを記録できていない',
  'no-app-frame': 'スタックに、注入範囲のソースへ戻せるフレームが無い',
  'source-line-mismatch': '戻した位置のソース行にデータ取得の呼び出しが無い',
  'component-not-agreed': '囲むコンポーネントが、2つの情報源で一致しない（コンポーネントではない関数の中など）',
  'no-callsite-record': 'このスパンには呼び出しスタックの記録が無い',
};

/** 伝播が成立しなかった理由の文言 */
const PROPAGATION_REASON: Record<string, string> = {
  'no-client-span': 'サーバー内部の通信にスパンが無い（計装していない）',
  'no-child-entry-span': '相手側の入口スパンが、この通信の子として観測できていない',
  'multiple-child-entry-spans': '子の入口スパンが2本以上あり、1本に決まらない',
  'trace-id-mismatch': '相手側の入口スパンが別のトレースに属している',
  'corroboration-failed': '宛先のパスが食い違っている',
};

/** コンポーネントのノード1つ。帰属の証拠が揃っているときだけ呼ぶ */
function componentNode(
  id: number, c: ObsServerCallsite, toId: number, toLabel: string, claim: string,
): ModelNode {
  const f = c.frame!;
  const comp = c.component!;
  return node({
    id, kind: 'component', form: 'module',
    title: 'コンポーネント',
    identifier: `${f.file}:${f.line}`,
    chipSub: comp.name,
    hover: 'この取得を実行した Server Component',
    overview: [
      { k: '取得手段', v: 'サーバー側でデータ取得の呼び出し時に記録したスタック' },
      { k: '呼び出し位置', v: `${f.file}:${f.line}:${f.col}` },
      ...(c.sourceLine ? [{ k: 'ソース', v: c.sourceLine }] : []),
      ...(f.functionName ? [{ k: '関数', v: f.functionName }] : []),
      { k: 'コンポーネント', v: `${comp.name}（${comp.file}:${comp.line}〜${comp.endLine}）` },
      { k: '実行の種別', v: 'サーバーで描画中の実行です。ブラウザからの API 通信ではありません' },
      /* 帰属はソース位置まで。描画インスタンスには及ばない（決定 G） */
      { k: '帰属の範囲', v: ATTRIBUTION_SCOPE_NOTE.definitionOnly },
      { k: '主張の範囲', v: claim },
      { k: '次の一歩', v: toLabel, go: { type: 'node', id: toId } },
    ],
    source: SOURCE_OF.serverCallStack,
    evidence: [
      `呼び出しの入口（${c.at ?? '不明'}）で記録した呼び出しスタック`,
      'ソースマップで戻した位置のソース行に、データ取得の呼び出しがあることの確認',
      'ソースの読み直しとビルド時のマニフェストで、囲むコンポーネントが一致',
    ],
  });
}

/**
 * RSC 直読み経路の変換。`obs.rsc` を持つ記録にだけ使う。
 *
 * 作れないものは作らずに skipped と cuts へ落とす。合成データで埋めない。
 */
export function fromRscObservation(obs: ObservationBundle): AdapterResult {
  const rsc = obs.rsc;
  if (!rsc) throw new Error('rsc observation not present');
  const skipped: { what: string; why: string }[] = [];
  const spanById = new Map(obs.spans.map((s) => [s.spanId, s]));
  const t0 = obs.page.startMs;
  const rel = (ms: number) => +(ms - t0).toFixed(1);

  const nodes: ModelNode[] = [];
  const hops: ModelHop[] = [];
  let nextId = 1;

  /* --------------------------------------- ① 表示された値 ② コンポーネント */
  const vc = buildValueAndComponent(obs, nextId, nodes, hops, skipped);
  nextId = vc.nextId;

  /* ------------------------------------------------- ③ 文書の取得（通信1件） */
  const doc = obs.browserRequests.find((r) => r.isDocument && r.path === obs.page.path);
  if (!doc) throw new Error(`document request not observed: ${obs.page.path}`);
  const docSpan = rsc.documentSpanId ? spanById.get(rsc.documentSpanId) : undefined;
  const render = rsc.renderSpanId ? spanById.get(rsc.renderSpanId) : undefined;
  if (!render) throw new Error('render span not observed');

  /* ブラウザから見えた API 通信が無いことを、変換の前提として確かめる。
   * あるなら rsc-direct ではない（この関数を使ってはいけない） */
  if (rsc.browserApiRequests > 0) {
    throw new Error(`rsc-direct path must not have browser API requests: ${rsc.browserApiRequests}`);
  }

  /* --------------------------------- 主経路に描くサーバー内部通信を1本決める */
  const focusExchange = rsc.focusExchange
    ? rsc.exchanges.find((e) => e.destPath === rsc.focusExchange) ?? null
    : null;
  const otherExchanges = rsc.exchanges.filter((e) => e !== focusExchange);

  /* ------------------------------------------------------ 識別子の割り当て
   * 経路の順に振る（PoC-05 5.2節 #2 と同じ規約）。
   * ① ② ③ ④ → ②''（帰属） → ⑤（SQL）→ ⑥ ⑦ の順である。 */
  const docId = nextId++;
  const renderId = nextId++;

  /* 主経路の SQL。**描画スパンの子孫であるものだけ**を採る */
  const mainSql = focusExchange
    ? []                                     // 焦点がサーバー内部通信のときは、その先の SQL を描く
    : rsc.sql.filter((x) => spanById.has(x.spanId));
  if (!focusExchange && !mainSql.length) {
    skipped.push({ what: '実行SQL', why: '描画スパンの子孫に SQL 文を持つスパンが無かった' });
  }

  /* 帰属が取れたものだけコンポーネントのノードを作る。番号は経路の順 */
  const focusCallsite = focusExchange ? focusExchange.callsite : (mainSql[0]?.callsite ?? null);
  const hasAttribution = attributed(focusCallsite);
  const attrId = hasAttribution ? nextId++ : undefined;
  if (focusCallsite && !hasAttribution) {
    skipped.push({
      what: 'この取得を実行したコンポーネント',
      why: focusCallsite.failure
        ? CALLSITE_REASON[focusCallsite.failure.reason] ?? focusCallsite.failure.reason
        : '成立の条件が揃わなかった',
    });
  }

  /* ---------------------------------------------------------- ③ 文書の取得 */
  nodes.push(node({
    id: docId, kind: 'http', form: 'module',
    /* ブラウザのネットワーク記録に現れた文書取得 */
    exchangeScope: 'browser',
    title: '通信', identifier: `${doc.method} ${doc.path}`,
    chipSub: `${doc.method} ${doc.path}`,
    metrics: {
      status: doc.status,
      ...(doc.durationMs !== null ? { durationMs: fmtMs(doc.durationMs) } : {}),
    },
    span: { startMs: rel(doc.startMs), endMs: rel(doc.startMs + (doc.durationMs ?? 0)) },
    hover: 'ブラウザが行った文書の取得',
    overview: [
      { k: '取得手段', v: 'ブラウザのネットワーク計測' },
      { k: '応答', v: '', fromMetrics: true },
      {
        k: '通信の種別',
        v: 'ページの文書取得（ナビゲーション）です。**API 通信ではありません。**'
          + 'このページでブラウザが行った API 通信は 0 件でした',
      },
      ...(doc.readHeaderKeys
        ? [{
          k: '読んだ応答ヘッダ',
          v: `${doc.readHeaderKeys.join(' / ')} の ${doc.readHeaderKeys.length} 件だけ。`
            + '他のヘッダも本文も読んでいません',
        }]
        : []),
      { k: '次の一歩', v: 'サーバーの処理を見る', go: { type: 'node', id: renderId } },
    ],
    source: SOURCE_OF.browserRequest,
    evidence: [
      doc.via === 'dedicated-header'
        ? '応答の専用ヘッダに載ったトレースID'
        : '応答の Server-Timing に載ったトレースID',
      ...(doc.durationMs !== null ? ['ブラウザの通信タイミング計測'] : []),
    ],
  }));

  /* ------------------------------------------------- ④ サーバー処理（描画） */
  const appService = rsc.services.find((x) => x.role === 'app');
  nodes.push(node({
    id: renderId, kind: 'server', form: 'physical',
    title: 'サーバー処理', identifier: render.name,
    chipSub: String(render.attrs['next.route'] ?? render.name),
    metrics: { durationMs: fmtMs(render.durationMs) },
    span: { startMs: rel(render.startMs), endMs: rel(render.endMs) },
    ...(appService ? { locus: { text: '開発サーバー', sub: appService.origin.replace(/^https?:\/\//, '') } } : {}),
    hover: 'この文書取得を受けたサーバーの描画処理',
    overview: [
      { k: '取得手段', v: '計装が生成したスパン' },
      { k: '区間', v: '', fromMetrics: true },
      { k: 'ルート', v: String(render.attrs['next.route'] ?? '—') },
      {
        k: '粒度',
        v: 'このスパンは**ルート単位**です。コンポーネント単位のスパンは存在しないため、'
          + 'このスパンだけでは特定のコンポーネントの処理とは言えません',
      },
      { k: 'このスパンの子孫のSQL', v: `${rsc.sql.length} 本` },
      ...(rsc.overlaps.length
        ? [{
          k: '並行実行',
          v: `子のスパンのうち ${rsc.overlaps.length} 組が区間として重なっています`,
        }]
        : []),
    ],
    source: SOURCE_OF.span,
    evidence: [
      `スパンの名前（${render.name}）と区間`,
      `トレースID ${render.traceId.slice(0, 8)}…`,
      ...(docSpan ? ['文書取得の入口スパンからの親子の連鎖'] : []),
    ],
  }));

  hops.push(hop({
    id: 'handles', order: hops.length + 1, from: docId, to: renderId, relation: 'handles',
    label: 'この文書取得を受けたサーバーの処理',
    source: docSpan ? SOURCE_OF.traceContext : SOURCE_OF.timeWindow,
    evidence: docSpan
      ? [
        '応答に載って返ったトレース識別子と、サーバー側スパンの識別子の一致',
        '入口スパンから描画スパンへの親子の連鎖',
      ]
      : ['時間の重なり'],
    ...(docSpan ? {} : {
      tagLabel: '時間の重なりで推定',
      weakness: 'トレースIDを応答から受け取れなかったため、時間の重なりで紐付けています。',
    }),
  }));

  /* ============================== 主経路: サーバー内部通信がある場合（Gate A） */
  const sqlNodeIds: number[] = [];
  const sqlAnalysisOf = (spanId: string) => obs.sqlAnalyses.find((a) => a.spanId === spanId);
  const cuts: Cut[] = [];

  /** ⑤ 実行SQL のノードを1本作る。親（④ または ④'）から executes を張る */
  const pushSqlNode = (spanId: string, parentId: number, depth: number) => {
    const s = spanById.get(spanId);
    const a = sqlAnalysisOf(spanId);
    if (!s || !a) {
      skipped.push({ what: `実行SQL ${spanId.slice(0, 8)}`, why: 'スパンまたは構文解析の結果が無い' });
      return undefined;
    }
    const id = nextId++;
    sqlNodeIds.push(id);
    nodes.push(node({
      id, kind: 'sql', form: 'module',
      title: '実行SQL', identifier: shortSql(a.sql),
      chipSub: '',
      metrics: { durationMs: fmtMs(s.durationMs) },
      span: { startMs: rel(s.startMs), endMs: rel(s.endMs) },
      hover: 'その処理が実行したSQL',
      overview: [
        { k: '取得手段', v: s.scope.includes('prisma') ? 'ORM計装のスパン属性' : 'DBドライバ計装のスパン属性' },
        { k: '区間', v: '', fromMetrics: true },
        { k: 'SQL', v: a.sql },
        {
          k: 'パラメータ',
          v: a.redacted
            ? `収集しません（文字列 ${a.redacted.strings} 件・数値 ${a.redacted.numbers} 件を取得時点で除去）`
            : '収集しません',
        },
        ...(s.statusCode === 2 ? [{ k: '結果', v: 'このSQLは失敗しました（スパンの状態が異常）' }] : []),
        { k: '取得件数', v: '計装から取得できていません' },
      ],
      source: SOURCE_OF.sqlStatement,
      evidence: [
        `計装 ${s.scope} のスパン属性`,
        depth === 1 ? '親スパンの直接の子' : `親スパンからの親子の連鎖（${depth} 段）`,
      ],
    }));
    hops.push(hop({
      id: `executes-${id}`, order: hops.length + 1, from: parentId, to: id, relation: 'executes',
      label: 'その処理が実行したSQL',
      source: SOURCE_OF.span,
      evidence: ['スパンの親子関係', `同一トレース ${s.traceId.slice(0, 8)}…`],
    }));
    return id;
  };

  if (focusExchange) {
    const client = spanById.get(focusExchange.clientSpanId);
    if (!client) throw new Error('internal exchange client span not observed');
    const exId = nextId++;
    const entry = focusExchange.entrySpanId ? spanById.get(focusExchange.entrySpanId) : undefined;
    const entryId = entry ? nextId++ : undefined;

    /* ---------------------------- ②'' この通信を始めたコンポーネント（任意） */
    if (hasAttribution && attrId !== undefined) {
      nodes.push(componentNode(
        attrId, focusCallsite!, exId, 'サーバー内部の通信を見る',
        'この通信を始めたのはこの位置のコードである、までです。'
        + '応答のどの項目が画面のどの値になったかは観測していません',
      ));
      hops.push(hop({
        id: 'requests', order: hops.length + 1, from: attrId, to: exId, relation: 'requests',
        label: 'そのコンポーネントが始めたサーバー内部の通信',
        endpoints: {
          from: {
            type: 'DataAccessSite',
            file: focusCallsite!.frame!.file,
            line: focusCallsite!.frame!.line,
            col: focusCallsite!.frame!.col,
            ...(focusCallsite!.component ? { inComponent: focusCallsite!.component.name } : {}),
          },
        },
        /*
         * ③' には `invokes`（どのスパンの下で起きたか）も入る。
         * **2本の線は2つの入力ではない。** 同じ1件の通信への2つの観測である。
         */
        convergence: 'shared-object',
        source: SOURCE_OF.serverCallStack,
        evidence: [
          `呼び出し位置 ${focusCallsite!.frame!.file}:${focusCallsite!.frame!.line}`,
          '呼び出しの入口で記録したスタックの、最も内側のアプリ側フレーム',
        ],
      }));
    }

    /* -------------------------------------------- ③' サーバー内部の通信1件 */
    nodes.push(node({
      id: exId, kind: 'http', form: 'module',
      /*
       * **サーバーの中から出た通信。ブラウザには現れない**（02a 3.2 / 06f I-6）。
       * 文言だけでなくモデルで区別する。ブラウザの通信と同じ数え方をすると、
       * 「ブラウザから観測できる通信が1件ある」と読める表示になる。
       */
      exchangeScope: 'server-internal',
      title: '通信', identifier: `GET ${focusExchange.destPath}`,
      chipSub: `GET ${focusExchange.destPath}`,
      metrics: {
        ...(focusExchange.status !== null ? { status: focusExchange.status } : {}),
        durationMs: fmtMs(client.durationMs),
      },
      span: { startMs: rel(client.startMs), endMs: rel(client.endMs) },
      hover: 'サーバーの中で起きた通信',
      overview: [
        { k: '取得手段', v: '計装が生成したスパン' },
        { k: '応答', v: '', fromMetrics: true },
        {
          k: '通信の種別',
          v: 'サーバーの中から出た通信です。**ブラウザには現れません。**'
            + 'ブラウザのネットワーク記録には存在しないため、ブラウザ側からは観測できません',
        },
        {
          k: '宛先',
          v: focusExchange.destHost !== null
            ? `${focusExchange.destHost}:${focusExchange.destPort ?? '?'}（ループバック）`
            : '取得できていません',
        },
        ...(entryId !== undefined
          ? [{ k: '次の一歩', v: '相手側の処理を見る', go: { type: 'node' as const, id: entryId } }]
          : []),
      ],
      source: SOURCE_OF.span,
      evidence: [
        `計装 ${client.scope} のスパン属性`,
        '描画スパンからの親子の連鎖',
      ],
    }));
    hops.push(hop({
      id: 'invokes', order: hops.length + 1, from: renderId, to: exId, relation: 'invokes',
      label: 'その処理が行ったサーバー内部の通信',
      /* ②'' からの `requests` と同じ ③' に入る（データの合流ではない） */
      convergence: 'shared-object',
      source: SOURCE_OF.span,
      evidence: ['スパンの親子関係', `同一トレース ${client.traceId.slice(0, 8)}…`],
    }));

    /* --------------------------------- ④' 相手側の処理（伝播が成立した場合） */
    if (entry && entryId !== undefined) {
      const svc = rsc.services.find((x) => x.name === focusExchange.entryService)
        ?? rsc.services.find((x) => x.role === 'svc');
      nodes.push(node({
        id: entryId, kind: 'server', form: 'physical',
        title: 'サーバー処理', identifier: `${svc?.name ?? '相手側'} ${focusExchange.destPath}`,
        chipSub: focusExchange.destPath,
        metrics: { durationMs: fmtMs(entry.durationMs) },
        span: { startMs: rel(entry.startMs), endMs: rel(entry.endMs) },
        ...(svc ? { locus: { text: svc.name, sub: svc.origin.replace(/^https?:\/\//, '') } } : {}),
        hover: 'サーバー内部の通信を受けた相手側の処理',
        overview: [
          { k: '取得手段', v: 'トレースコンテキストの伝播' },
          { k: '区間', v: '', fromMetrics: true },
          { k: 'サービス', v: svc ? `${svc.name}（${svc.origin}）` : '取得できていません' },
          {
            k: 'プロセス',
            v: focusExchange.crossProcess
              ? '送信側とは別のプロセスです'
              : '送信側と同じプロセスです',
          },
          {
            k: '伝播の方式',
            v: `${rsc.propagation.method}。${rsc.propagation.scope}`,
          },
        ],
        source: SOURCE_OF.traceContext,
        evidence: [
          'W3C トレースコンテキストの伝播による親子関係',
          `送信側スパン ${client.spanId.slice(0, 8)}… の子である`,
          `トレースIDの一致 ${entry.traceId.slice(0, 8)}…`,
        ],
      }));
      hops.push(hop({
        id: 'handles-internal', order: hops.length + 1, from: exId, to: entryId,
        relation: 'handles',
        label: 'そのサーバー内部通信を受けた相手側の処理',
        source: SOURCE_OF.traceContext,
        evidence: [
          '受け側の入口スパンが、送信側スパンの子であること',
          'トレースIDの一致',
          '宛先のパスが食い違わないこと（補強）',
        ],
      }));

      /* ⑤' 相手側で実行された SQL */
      for (const sid of focusExchange.sqlSpanIds) pushSqlNode(sid, entryId, 1);
      if (!focusExchange.sqlSpanIds.length) {
        skipped.push({
          what: '相手側の実行SQL',
          why: '相手側の入口スパンの子孫に SQL 文を持つスパンが無かった',
        });
      }
    } else {
      /* 伝播が成立しなかった。**相手側のノードを作らない。** */
      cuts.push({
        from: exId,
        head: '相手側の処理は特定していません',
        sub: focusExchange.propagationFailure
          ? PROPAGATION_REASON[focusExchange.propagationFailure] ?? focusExchange.propagationFailure
          : '伝播の条件が揃わなかった',
        where: 'サーバー内部通信の相手側',
        kind: '別トレースを同一経路として扱わない（OBS-05）',
      });
      skipped.push({
        what: `サーバー内部通信 ${focusExchange.destPath} の相手側`,
        why: focusExchange.propagationFailure
          ? PROPAGATION_REASON[focusExchange.propagationFailure] ?? focusExchange.propagationFailure
          : '伝播の条件が揃わなかった',
      });
    }
  } else {
    /* ======================= 主経路: 描画スパンの直下の SQL（Gate B） */
    for (const x of mainSql) {
      const id = pushSqlNode(x.spanId, renderId, x.depthFromRender);
      if (id === undefined) continue;
      /* ②'' その SQL を実行したコンポーネント（証拠があるときだけ） */
      if (x === mainSql[0] && hasAttribution && attrId !== undefined) {
        /*
         * 経路の順は ②''（実行した）→ ⑤（実行されたSQL）である。
         * `executes` は pushSqlNode が先に積んでしまうので、順序を入れ替える。
         * **番号付きリストの番号とキャンバスのバッジを食い違わせないため**
         * （PoC-05 5.2節 #2 と同じ理由）。
         */
        const executesHop = hops[hops.length - 1];
        /* 番号付きリストはノードの並び順に出る。経路の順（②'' → ⑤）に合わせて、
         * SQL のノードの**前**へ差し込む */
        const sqlIndex = nodes.length - 1;
        nodes.splice(sqlIndex, 0, componentNode(
          attrId, focusCallsite!, id, 'この実行SQLを見る',
          'この SQL を実行したのはこの位置のコードである、までです。'
          + 'この SQL の結果が画面のどの値になったかは観測していません',
        ));
        hops.push(hop({
          /*
           * **02a 3.5.1節に無い関係である。** PoC-02 で追加を提案している。
           *   queries | ComponentDef → SqlStatement | L1相当 | server-call-stack
           * `executes`（Span → SqlStatement）とは始点の種別が違う。混同しない。
           */
          id: 'queries', order: hops.length + 1, from: attrId, to: id, relation: 'queries',
          label: 'そのコンポーネントが実行したSQL',
          /*
           * **始点はデータ取得の呼び出し位置である**（02a 3.5.1）。
           * 囲むコンポーネントは文脈として持つだけで、
           * **どの描画インスタンスが実行したかは同定していない**（決定 G）。
           */
          endpoints: {
            from: {
              type: 'DataAccessSite',
              file: focusCallsite!.frame!.file,
              line: focusCallsite!.frame!.line,
              col: focusCallsite!.frame!.col,
              ...(focusCallsite!.component ? { inComponent: focusCallsite!.component.name } : {}),
            },
          },
          /*
           * ⑤ には `executes`（どのスパンの下で走ったか）も入る。
           * 根拠が別々なので別のホップであり、**データの合流ではない**
           * （02a 3.5.3 / 06f I-2）。
           */
          convergence: 'shared-object',
          source: SOURCE_OF.serverCallStack,
          evidence: [
            `呼び出し位置 ${focusCallsite!.frame!.file}:${focusCallsite!.frame!.line}`,
            '呼び出しの入口で記録したスタックの、最も内側のアプリ側フレーム',
            'そのスパンの OpenTelemetry コンテキストが運んできた記録である（別のスパンのものではない）',
          ],
        }));
        const queriesHop = hops[hops.length - 1];
        const a = executesHop.order;
        const b = queriesHop.order;
        (executesHop as { order: number }).order = b;
        (queriesHop as { order: number }).order = a;
        /* ⑤ への流入が2本になった。両方が流入の意味を宣言する（02a 3.5.3） */
        (executesHop as { convergence?: Convergence }).convergence = 'shared-object';
      }
      /* 2本目以降は、帰属が取れていても線を増やさない。
       * 主経路は1本であり、残りは経路外として残す（UI-33） */
      if (x !== mainSql[0]) {
        skipped.push({
          what: `実行SQL ${shortSql(sqlAnalysisOf(x.spanId)?.sql ?? '', 30)} の実行元`,
          why: '主経路に描くのは1本である。この SQL の実行元は経路外として残している',
        });
      }
    }
  }

  /* ---------------------------------------------------- ⑥ テーブル ⑦ カラム */
  const tableNodeId = new Map<string, number>();
  for (const sqlId of sqlNodeIds) {
    const sqlNode = nodes.find((n) => n.id === sqlId)!;
    const a = obs.sqlAnalyses.find((x) => shortSql(x.sql) === sqlNode.identifier);
    if (!a) continue;

    for (const t of a.tables) {
      const known = obs.dbObjects.tables.find(
        (x) => x.name === t.name && (!t.schema || x.schema === t.schema),
      );
      if (!known) {
        skipped.push({
          what: `テーブル ${t.schema ?? '?'}.${t.name}`,
          why: '情報スキーマに見つからなかったため、ノードを作らなかった',
        });
        continue;
      }
      const key = `${known.schema}.${known.name}`;
      let id = tableNodeId.get(key);
      if (id === undefined) {
        id = nextId++;
        tableNodeId.set(key, id);
        nodes.push(node({
          id, kind: 'table', form: 'physical',
          title: 'テーブル', identifier: key, chipSub: known.name,
          hover: 'そのSQLが読んだテーブル',
          overview: [
            { k: '取得手段', v: 'DBの情報スキーマへの照会' },
            { k: '定義', v: key },
            ...(known.rowEstimate !== null ? [{ k: '行数（推定）', v: `約 ${known.rowEstimate} 行` }] : []),
          ],
          source: SOURCE_OF.introspection,
          evidence: ['実行されたSQL文の FROM 句', 'DBの情報スキーマとの一致'],
        }));
      }
      hops.push(hop({
        id: `reads-${sqlId}-${id}`, order: hops.length + 1, from: sqlId, to: id, relation: 'reads',
        label: 'そのSQLが読んだテーブル',
        source: SOURCE_OF.sqlParse,
        evidence: ['SQL文の FROM 句'],
      }));
    }

    /* 規約1: projects の始点は SqlStatement。テーブルからカラムへの辺は作らない */
    for (const p of a.projections) {
      const def = obs.dbObjects.columns.find(
        (c) => c.schema === p.schema && c.table === p.table && c.column === p.column,
      );
      if (!def) {
        skipped.push({
          what: `カラム ${p.schema}.${p.table}.${p.column}`,
          why: '情報スキーマに見つからなかったため、ノードを作らなかった',
        });
        continue;
      }
      const id = nextId++;
      nodes.push(node({
        id, kind: 'column', form: 'module',
        title: 'カラム', identifier: `${def.column} (${def.dataType})`, chipSub: def.column,
        hover: 'そのSQLが取り出した列',
        overview: [
          { k: '取得手段', v: '実行されたSQL文の構文解析' },
          { k: '型', v: def.dataType },
          { k: 'NULL', v: def.nullable ? '可' : '不可' },
          { k: '定義', v: `${def.schema}.${def.table}.${def.column}` },
        ],
        source: SOURCE_OF.sqlParse,
        evidence: ['SQL文の SELECT 句', 'DBの情報スキーマとの一致'],
      }));
      hops.push(hop({
        id: `projects-${sqlId}-${id}`, order: hops.length + 1, from: sqlId, to: id,
        relation: 'projects',
        label: 'そのSQLが取り出した列',
        source: SOURCE_OF.sqlParse,
        evidence: ['SQL文の SELECT 句'],
      }));
    }
    for (const u of a.unresolved) {
      skipped.push({
        what: `射影 ${u.column ?? '(不明)'}`,
        why: whyOfUnresolvedProjection(u.why),
      });
    }
  }

  /* ============================== 表示値の由来（PoC-04）— 静的解析による推定 */
  /*
   * ① を描いたコンポーネント（②）と、データ取得を実行したコンポーネント（②''）は
   * **同じソースファイルの同じコンポーネントであっても、別のノードである。**
   * PoC-02 まで、両者を結ぶ証拠は無かったので線を引かなかった（06d 5.1節）。
   *
   * PoC-04 で、**ソースの静的解析による推定（L2）**として結べるようになった。
   * ただし結ぶのは、次が全部そろったときだけである。
   *   1. ② が在る（表示値とそれを描いたコンポーネントを観測できている）
   *   2. ②'' が在る（その取得を実行したコンポーネントに帰属できている）
   *   3. 静的解析が、その表示値からその取得の結果への**参照の連鎖**を解けている
   *   4. その解析が結びついた SQL が、②'' が実行した SQL と**同じスパン**である
   * 1つでも欠けたら線を引かず、従来どおり切断として残す。
   */
  const lin = obs.lineage;
  /*
   * 条件5（M1 で追加）: **② のノードが props 束縛位置を担えること。**
   * `supplies` の端点は「値を描いた位置（props 束縛位置）」であり、
   * ② のノードはそれを含むコンポーネントとして担っているに過ぎない
   * （02a 3.5.1 `ENDPOINT_CARRIER`）。静的解析が見た位置と、要素識別子が
   * 指す位置が**同じファイルの同じ行**でなければ、担えていない。
   * 担えないまま線を引くと「コンポーネントからコンポーネントへ」になる。
   */
  const siteCarried = !!lin && !!vc.anchorSite
    && lin.site.file === vc.anchorSite.file && lin.site.line === vc.anchorSite.line;
  /*
   * 条件6（M1 で追加）: **静的解析が見た取得の呼び出し位置が、
   * 計装が実測した呼び出し位置と一致すること。**
   * 一致しなければ、静的解析は別の取得について語っている。
   * その場合、観測した SQL とこの表示値を結ぶ根拠は無い。
   */
  const fetchSiteAgrees = !!lin && !!focusCallsite?.frame
    && lin.candidates.every((c) => c.query.file === focusCallsite.frame!.file
      && c.query.line === focusCallsite.frame!.line);
  const linkable = !!lin && lin.outcome !== 'none'
    && vc.componentId !== undefined && attrId !== undefined
    && siteCarried && fetchSiteAgrees
    && (!mainSql.length || lin.sqlSpanIds.includes(mainSql[0].spanId));

  if (linkable && lin) {
    const cands = lin.candidates.map((c) => ({
      identifier: `${c.schema}.${c.table}.${c.column}`,
      label: `${c.table} の ${c.column} 列`,
      evidence: [
        `実行された SQL の SELECT 句にこの列がある${c.note ? `（${c.note}）` : ''}`,
        `参照の連鎖 ${c.trail.length} 段（${c.query.file}:${c.query.line} の取得結果）`,
        ...(c.via === 'anyfield' ? ['参照のキーが動的なため、この SQL の全列が候補になる'] : []),
      ],
      ...(c.note ? { note: c.note } : {}),
    }));
    const linkStatus: NonNullable<ModelHopInput['linkStatus']> = cands.length === 1
      ? 'resolved' : cands.length > 1 ? 'multiple-candidates' : 'untraceable';
    const trail = lin.candidates[0]?.trail ?? [];

    hops.push(hop({
      /*
       * **02a 3.5.1節に無い関係である。** PoC-04 で追加を提案している。
       *   supplies | ComponentDef(描いた) → ComponentDef(取得を実行した) | L2 | static-analysis
       *
       * `derives`（レスポンスのキー → PropBindingSite）とは始点も終点も違う。
       * `rsc-direct` には「レスポンスのキー」というノードが**存在しない**ため、
       * `derives` をそのまま流用できない（第2節の設計矛盾への結論）。
       */
      id: 'supplies', order: hops.length + 1,
      from: vc.componentId!, to: attrId!, relation: 'supplies',
      label: 'この表示値の由来（取得結果のどの項目か）',
      /*
       * データは「取得位置 → 描画位置」に供給される。画面の経路は
       * 利用者の逆向き探索（描画位置 → 取得位置）に進むので、
       * **向きが逆であることを宣言する**（02a 3.5.1 / 決定 B）。
       */
      orientation: 'against-data',
      /*
       * **端点は2つのソース位置である。** コンポーネント定義どうしではない
       * （06f I-3）。`from` は値を描いた位置（props 束縛位置）、
       * `to` は取得を呼んだ位置である。
       */
      endpoints: {
        from: {
          type: 'PropBindingSite',
          file: lin.site.file, line: lin.site.line, col: lin.site.col,
          ...(lin.site.component ? { inComponent: lin.site.component } : {}),
        },
        to: {
          /* 実測した呼び出し位置を使う（静的解析の位置と一致していることは条件6） */
          type: 'DataAccessSite',
          file: focusCallsite!.frame!.file,
          line: focusCallsite!.frame!.line,
          col: focusCallsite!.frame!.col,
          ...(focusCallsite!.component ? { inComponent: focusCallsite!.component.name } : {}),
        },
      },
      source: SOURCE_OF.staticAnalysis,
      linkStatus,
      ...(cands.length ? { candidates: cands } : {}),
      evidence: [
        'ソースの静的解析（TypeScript の AST と記号解決）による参照の連鎖',
        ...(cands.length
          ? [`実行された SQL の SELECT 句で解決した列 ${cands.length} 件`
            + `（${cands.map((c) => c.identifier).join(' / ')}）`]
          : ['列は特定できていません'
            + `（テーブルまで: ${lin.tableCandidates.map((t) => `${t.schema}.${t.name}`).join(' / ')}）`]),
        `その取得を実行したコンポーネントへの帰属（${lin.site.file}:${lin.site.line} の表示箇所から）`,
      ],
      tagLabel: '由来は静的解析による推定',
      weakness: [
        '取得結果のどの項目がこの表示値になったかは、**ソースの静的解析による推定**です。',
        '実行時に観測したものではありません（表示された値も、取得した行も読んでいません）。',
        lin.reasons.length ? `推定の状態: ${lin.reasons.join('／')}。` : '',
        trail.length ? `参照の連鎖: ${trail.join(' ← ')}。` : '',
        lin.transformed
          ? '表示までに加工（連結・型変換など）を通っています。'
            + '由来の列は推定できても、表示値がその列の値そのままとは限りません。'
          : '',
        lin.literalPaths
          ? `条件分岐で固定値になる経路が ${lin.literalPaths} 本あります。`
          : '',
        lin.untracked.length
          ? `追えなかった経路 ${lin.untracked.length} 件: ${lin.untracked.map((u) => u.why).join('／')}。`
          : '',
        lin.unresolved.length
          ? `解決できなかった参照: ${lin.unresolved.map((u) => u.text).join('／')}。`
          : '',
        '途中で計算・連結・条件分岐・名前の付け替えが増えると成立しません。',
      ].filter(Boolean).join(''),
    }));

    /* 列まで決まらなかった場合。**ホップは引くが、列は主張しない。**
     * 「この取得の結果から来ている」までが推定の範囲である */
    if (lin.outcome === 'table-only') {
      cuts.unshift({
        from: attrId!,
        head: '由来の列は特定していません',
        sub: lin.unresolved.map((u) => u.text).join('／') || '列を解決できなかった',
        where: '実行SQLの SELECT 句 / 由来のカラム',
        kind: 'テーブルまでに粒度を落としている（01b Q-04.5 代替1）',
      });
    }
  } else {
    /* -------------------------------------------- 規約2: 観測できない区間は切断 */
    cuts.unshift({
      /*
       * 切断を生やす元は、コンポーネントのノードを優先する。
       * props の由来はコンポーネントの持ち物であり、通信の持ち物ではない。
       */
      from: vc.componentId ?? attrId ?? docId,
      head: 'ここから先は観測していません',
      sub: lin && lin.outcome === 'none'
        ? `props の由来（静的解析でも候補を出せませんでした: ${
          [...lin.reasons, ...lin.untracked.map((u) => u.why)].join('／') || '理由なし'}）`
        : 'props の由来（取得した結果のどの項目がこの値になったか）',
      where: 'コンポーネントの props / 取得結果の項目',
      kind: lin
        ? '静的解析で参照の連鎖を解けなかったため、関係を作らない（OBS-05）'
        : 'derives は構造的に推定（02a 3.5.1）。本PoCでは関係を作らない',
    });
  }
  if (vc.componentId === undefined && !hasAttribution) {
    cuts.push({
      from: docId,
      head: 'ここより上流は観測していません',
      sub: '表示された値とコンポーネント',
      where: 'ブラウザのDOM / Server Component',
      kind: '証拠が無いため関係を作らない',
    });
  }

  /* -------------------------------------------------------------- 経路外
   * いま描いていない取得を、減光して残す（UI-33）。
   * **主経路に描いたものを二重に数えない。** 描いたスパンを控えておく。 */
  const drawnSpanIds = new Set<string>([
    ...(focusExchange ? [focusExchange.clientSpanId, ...focusExchange.sqlSpanIds] : []),
    ...(focusExchange ? [] : mainSql.map((x) => x.spanId)),
  ]);
  const offNodes: OffPath['nodes'] = [
    ...otherExchanges.map((e) => ({
      kind: 'http' as const,
      label: `内部 ${e.destPath}`,
      ...(spanById.has(e.clientSpanId)
        ? { durationMs: fmtMs(spanById.get(e.clientSpanId)!.durationMs) }
        : {}),
    })),
    ...rsc.sql.filter((x) => !drawnSpanIds.has(x.spanId)).flatMap((x) => {
      const s = spanById.get(x.spanId);
      if (!s) return [];
      const a = sqlAnalysisOf(x.spanId);
      return [{
        kind: 'sql' as const,
        label: shortSql(a?.sql ?? s.name, 26),
        durationMs: fmtMs(s.durationMs),
      }];
    }),
  ];

  const dataset: Dataset = {
    origin: 'measured',
    project: obs.meta.app.name,
    runtime: {
      command: 'npm run dev',
      port: obs.meta.app.port,
      instrumentation: obs.meta.instrumentation.method,
    },
    nodes, hops, cuts,
    offPath: {
      detail: 'full',
      label: offNodes.map((n) => n.label).join(' / ') || 'なし',
      note: offNodes.length
        ? 'このページで観測した、いま描いていない取得です。区間は観測しています。'
        : 'このページで観測した他の取得はありません。',
      nodes: offNodes,
      caption: {
        text: '選択していない経路（このページの他の取得）',
        textUnselected: 'このページの他の取得',
      },
    },
    pages: obs.meta.app.pages,
    notice: `${obs.meta.poc} 実測データ／${obs.meta.instrumentation.method}`
      + `・${obs.meta.instrumentation.bundler}`,
    overviewNote:
      `表示している数値は ${obs.meta.collectedAt} に実際の計装から取得したものです。`
      + 'このページでブラウザが行った API 通信は 0 件です（Server Component が'
      + 'サーバー内部で取得しているため）。'
      + `静的資材の通信 ${obs.meta.excluded.staticAssetRequests} 件は件数に含めていません。`
      + elementsNote(obs),
    provenance: {
      instrumentation: `${obs.meta.instrumentation.method}（${obs.meta.instrumentation.detail}）`,
      bundler: obs.meta.instrumentation.bundler,
      traceId: render.traceId,
      collectedAt: obs.meta.collectedAt,
      notObserved: obs.meta.notObserved,
    },
  };

  return { dataset, skipped };
}

/** 変換に使った記録の内訳。報告と検証に使う。 */
export function countObservation(obs: ObservationBundle) {
  const sql = (s: ObsSpan) => obs.sqlAnalyses.some((a) => a.spanId === s.spanId);
  return {
    spans: obs.spans.length,
    sqlSpans: obs.spans.filter(sql).length,
    browserRequests: obs.browserRequests.length,
    withServerTraceId: obs.browserRequests.filter((r: ObsBrowserRequest) => r.server).length,
    analyses: obs.sqlAnalyses.length,
    parsedOk: obs.sqlAnalyses.filter((a: ObsSqlAnalysis) => a.parseOk).length,
    tables: obs.dbObjects.tables.length,
    columns: obs.dbObjects.columns.length,
  };
}

/* ========================================================================== */
/* Phase 7B-2 — 開発サーバーの実ページで選択した要素                            */
/*                                                                            */
/* PoC-03 の ①② と同じ部品（buildValueAndComponent）を通す。**条件も文言も      */
/* PoC-03 の記録と同じ1か所にある。** 違いは、観測を記録から読むのではなく、     */
/* いま実行中の開発サーバーのページで利用者が選んだ1要素であることだけである。   */
/*                                                                            */
/* 作るもの: ① 選択した要素（dom-read）② コンポーネント（element-anchor）renders */
/* 作らないもの: 通信・サーバー処理・SQL・テーブル（7B-2 では結ばない）、derives  */
/* 特定できなかった場合: ① だけを作り、理由を概要と切断に書く                    */
/* ========================================================================== */

/** 解決の結果（src/server/anchors.ts の AnchorResolution と同じ形。層2はサーバーを import しない） */
type LiveAnchor = Omit<ObsElementAnchor, 'verified' | 'sourceLine'> & { sourceLine: string };
export type LiveResolution =
  | {
    status: 'resolved';
    anchor: LiveAnchor;
    /** 祖先の識別子のうち、照合に通ったもの（近い順。包含関係の文脈） */
    ancestors: LiveAnchor[];
    directive: 'use-client' | 'none';
    checks: string[];
  }
  | {
    status: 'unresolved'; reason: string; detail: string;
    context: { tag: string; component: string; file: string; line: number } | null;
  };

export interface LiveSelectionInput {
  project: string;
  port: number;
  page: { path: string; title: string };
  selection: {
    tag: string; anchorOnSelf: string | null; anchorOrdinal: number | null; anchorInstanceCount: number;
    ancestorAnchors: string[]; textNodeIndex: number | null;
    valueShape: { chars: number; cls: string } | null; formControl: boolean; path: string;
  };
  resolution: LiveResolution;
  /** 選択した時刻（ISO）。画面に出すだけ */
  selectedAt: string;
  /** 7B-3B-2: 選択が起きた文書について、プレビューのスクリプトが知らせたもの（文書の識別子・遷移の有無） */
  document?: { token: string | null; soft: boolean | null };
  /**
   * 7B-3B-2: 値の由来の評価。選択だけを描くとき（文書を同定できなかったときなど）に、
   * 切断の理由として出す。**選択だけの描画では supplies を作らない**（SQL の側を描かないため）
   */
  lineage?: LiveLineage;
}

/** 特定できなかった理由の見出し（anchors.ts の UnresolvedReason） */
export const LIVE_UNRESOLVED_LABEL: Record<string, string> = {
  'anchor-missing': 'この要素自身に要素識別子がありません',
  'injection-unavailable': 'このプロジェクトでは要素識別子を注入していません',
  'anchor-not-in-manifest': '識別子がいまのビルドの対応表にありません',
  'outside-scope': '対応表のファイルが注入範囲の外です',
  'id-mismatch': '対応表の位置と識別子が一致しません',
  'tag-mismatch': 'DOM の要素と対応表の要素が一致しません',
  'source-mismatch': 'ソースを読み直した結果が対応表と一致しません',
  'verifier-unavailable': 'ソースを読み直せません',
};

const LIVE_METHOD = '方式1 ビルド時の要素識別子注入（JSX へ data-vcide を挿入）';
const LIVE_NOT_OBSERVED: { what: string; why: string }[] = [
  { what: 'props の由来（derives）', why: 'コンポーネントが props で受け取った値が、どこから来たかは観測していない（02a 3.5.1。構造的に推定）' },
  { what: '通信・サーバー処理・SQL への経路', why: 'Phase 7B-2 の範囲外。この選択からは結んでいない' },
  { what: 'どの使用箇所がこのインスタンスを描いたか', why: '同じコンポーネントが複数箇所で使われる場合、DOM からは使用箇所を一意に決められない' },
  { what: '表示された値そのもの・DOM の本文・フォームの値', why: '方針として収集しない。持つのはタグ名・識別子・何番目か・文字数と文字種だけ' },
  { what: 'ライブラリ由来か動的生成かの区別', why: '識別子を持たない要素について、DOM からは区別できない（PoC-03 と同じ）' },
];

export function fromLiveSelection(input: LiveSelectionInput): AdapterResult {
  const { selection: sel, resolution: res } = input;
  const skipped: { what: string; why: string }[] = [];
  const nodes: ModelNode[] = [];
  const hops: ModelHop[] = [];
  const cuts: Cut[] = [];

  const resolved = res.status === 'resolved';
  const anchors: ObsElementAnchor[] = resolved
    ? [res.anchor, ...res.ancestors].map((a) => ({ ...a, verified: true }))
    : [];
  const el: ObsElements = {
    method: LIVE_METHOD,
    bundler: '開発サーバーの既定',
    injectedScope: 'src/',
    transform: '挿入のみ。再出力しないため行番号はずれない。ソースマップに依存しない',
    page: input.page.path,
    // ページ全体の要素は数えていない（選んだ1要素だけを見る）
    anchoredElements: 0,
    totalElements: 0,
    primaryKey: 'live',
    selections: [{
      key: 'live', selector: `<${sel.tag}>`, ordinal: 0, group: 'live', primary: true, tag: sel.tag,
      // 照合に通ったときだけ「この要素自身の識別子」として渡す
      anchorOnSelf: resolved ? res.anchor.id : null,
      anchorOrdinal: sel.anchorOrdinal,
      anchorInstanceCount: sel.anchorInstanceCount,
      // 祖先も照合に通ったものだけ（包含関係の文脈）
      ancestorAnchors: resolved ? sel.ancestorAnchors.filter((id) => res.ancestors.some((a) => a.id === id)) : [],
      textNodeIndex: sel.textNodeIndex,
      valueShape: sel.valueShape,
      failure: resolved ? null : { reason: res.reason, detail: res.detail },
    }],
    anchors,
    files: [],
  };
  const obs = { elements: el } as unknown as ObservationBundle;

  const shapeText = sel.formControl
    ? '収集していません（フォームの部品・編集できる要素のため）'
    : sel.valueShape
      ? `${sel.valueShape.chars} 文字・${CLS_LABEL[sel.valueShape.cls] ?? sel.valueShape.cls}`
      : 'この要素は直下にテキストを持っていません';

  if (resolved) {
    const vc = buildValueAndComponent(obs, 1, nodes, hops, skipped);
    const comp = nodes.find((n) => n.id === vc.componentId);
    const value = nodes.find((n) => n.id === vc.valueId);
    if (value) {
      const row = value.overview.find((r) => r.k === '値の形');
      if (row) row.v = shapeText;
      value.overview.splice(1, 0, { k: 'ページ', v: input.page.path });
      if (input.lineage) {
        const b = input.lineage.binding;
        value.overview.push({
          k: '文書の同定',
          v: b.status === 'identified'
            ? `この要素を描いた文書は、いまの起動の通信 #${b.seq} の応答です（中継が応答ごとに付けた識別子で照合）`
            : `同定できません — ${DOC_UNBOUND_LABEL[b.reason]}${b.detail ? `（${b.detail}）` : ''}`,
        });
      }
    }
    if (comp) {
      const a = res.anchor;
      const at = comp.overview.findIndex((r) => r.k === '定義');
      // 右ドックの行は1行で省略される。行・列を先に置いて、切れても読めるようにする
      comp.overview.splice(at + 1, 0, { k: '位置（行・列）', v: `${a.line} 行 ${a.col} 列 — ${a.file}:${a.line}:${a.col}` });
      comp.overview.push(
        {
          k: 'ファイルの指定',
          v: res.directive === 'use-client'
            ? "先頭に 'use client' があります（Client Component の境界）"
            : "'use client' はありません。サーバーで描かれたかブラウザで描かれたかは、"
              + 'このファイルだけでは決まりません（読み込み元による）',
        },
        { k: '帰属の範囲', v: ATTRIBUTION_SCOPE_NOTE.definitionOnly },
        { k: '特定方法', v: '要素自身の識別子 → いまのビルドの対応表 → ソースの読み直しで照合' },
        { k: '照合', v: res.checks.join(' / ') },
        { k: '主張の範囲', v: 'この要素を描いた JSX の位置とコンポーネントまでです。表示された値がどこから来たかは観測していません' },
      );
      cuts.push({
        from: comp.id,
        head: 'ここから先は観測していません',
        sub: input.lineage?.cut ? lineageCutText(input.lineage) : 'props の由来（この値がどこから来たか）',
        where: 'コンポーネントの props / 通信の応答',
        kind: 'derives は構造的に推定（02a 3.5.1）。7B-2 では関係を作らない',
      });
    }
  }

  if (!nodes.length) {
    /* 特定できなかった。選んだ要素だけを置き、理由を書く。**祖先へは対応付けない** */
    const why = res.status === 'unresolved' ? res : { reason: 'unknown', detail: '', context: null };
    const label = LIVE_UNRESOLVED_LABEL[why.reason] ?? `特定できません（理由コード: ${why.reason}）`;
    nodes.push(node({
      id: 1, kind: 'value', form: 'physical',
      title: '選択した要素',
      identifier: `<${sel.tag}>${sel.textNodeIndex !== null ? ` のテキスト #${sel.textNodeIndex}` : ''}`,
      chipSub: `<${sel.tag}>`,
      hover: 'この要素のソースは特定できていません',
      overview: [
        { k: '取得手段', v: 'ブラウザのDOM直接読み取り' },
        { k: 'ページ', v: input.page.path },
        { k: '要素', v: `<${sel.tag}>` },
        { k: '特定できなかった理由', v: label },
        { k: '詳しく', v: why.detail || '—' },
        ...(why.context ? [{
          k: '祖先の文脈',
          v: `<${why.context.tag}>（${why.context.component} — ${why.context.file}:${why.context.line}）の中にあります。`
            + '祖先は文脈であって、この要素の出所ではありません',
        }] : []),
        { k: '値の形', v: shapeText },
        { k: '値の保存', v: '表示された値そのものは保存していません' },
      ],
      source: SOURCE_OF.domRead,
      evidence: ['この要素自身の属性（要素識別子の有無）だけを読んだ'],
    }));
    cuts.push({
      from: 1,
      head: 'この要素のソースは特定できません',
      sub: label,
      where: 'React コンポーネント / ソース位置',
      kind: '根拠が無いため、コンポーネントを作らない（推測で埋めない）',
    });
    skipped.push({ what: `選択 <${sel.tag}>`, why: `特定不能: ${why.reason}${why.detail ? ` — ${why.detail}` : ''}` });
  }

  const dataset: Dataset = {
    origin: 'measured',
    project: input.project,
    runtime: { command: 'next dev', port: input.port, instrumentation: LIVE_METHOD },
    nodes, hops, cuts,
    offPath: {
      detail: 'unavailable',
      label: 'なし',
      note: '通信・SQL への経路は、この選択からは結んでいません（Phase 7B-2 の範囲外）。',
      nodes: [],
      caption: { text: '選択していない経路', textUnselected: 'このページの他の通信' },
    },
    pages: [{ icon: '▤', name: input.page.title || input.page.path, path: input.page.path, current: true }],
    notice: `開発サーバーの実ページで選択した要素／${LIVE_METHOD}`,
    overviewNote:
      `${input.selectedAt} にプレビューで選択した要素です。通信・SQL は観測していないため件数は 0 と出ます`
      + '（このページで通信が無かったという意味ではありません）。表示された値そのものは保存していません。',
    provenance: {
      instrumentation: LIVE_METHOD,
      bundler: '開発サーバーの既定',
      traceId: '—',
      collectedAt: input.selectedAt,
      notObserved: LIVE_NOT_OBSERVED,
    },
  };
  return { dataset, skipped };
}

/* ========================================================================== */
/* Phase 7B-3A — いまの起動で観測した通信・サーバー処理・SQL                      */
/*                                                                            */
/* PoC-01（`fromObservation`）と同じ形の経路（③通信 → ④サーバー処理 → ⑤SQL →    */
/* ⑥テーブル／⑦カラム）を、**記録済みデータではなく、いまの起動の観測**から作る。  */
/*                                                                            */
/* PoC-01 との違い（すべて「観測していないものを作らない」ための違い）:          */
/*   1. 通信は中継の記録（preview-relay）。ブラウザ自身の記録ではない             */
/*   2. 通信とサーバー処理は **トレース識別子の一致だけ** で結ぶ。取れなければ     */
/*      時間の重なりに降格せず、結ばない（PoC-01 は time-window に降格していた）   */
/*   3. テーブル・カラムは **実行された SQL の構文解析だけ** で決める。            */
/*      情報スキーマに照会していないので、型・NULL 可否は「未取得」と書く          */
/*   4. 書き込み先のテーブル（INSERT / UPDATE / DELETE）は reads にしない         */
/*   5. 表示された値・コンポーネントとは結ばない（7B-3B で証拠を評価する）         */
/* ========================================================================== */

/** 同じトレースの中で「サーバー処理」として描くスパンの種類（Next.js の計装の名前） */
const ROUTE_SPAN_TYPES = ['AppRouteRouteHandlers.runHandler', 'AppRender.getBodyResult'];
/** キャンバスに描く SQL・カラムの上限（02a M4 の配置の制約。超えた分は数と理由を出す） */
const LIVE_MAX_SQL = 2;
const LIVE_MAX_COLUMNS = 5;

export const LIVE_RUN_METHOD = '方式2 NODE_OPTIONS=--require（PoC-01）＋ プレビュー中継の記録';
/** 7B-3B-1: 呼び出しの入口のスタック（PoC-02 Gate B）を併せて取った起動 */
export const LIVE_RUN_METHOD_CALLSITE = `${LIVE_RUN_METHOD} ＋ 呼び出しの入口のスタック（PoC-02）`;

/** 一覧の1行。通信を選ぶための見出し */
export function liveExchangeLabel(e: LiveExchange): string {
  return `#${e.seq} ${e.method} ${e.path}${e.hasQuery ? '?…' : ''} — ${e.status ?? (e.failure ? '応答なし' : '—')}`;
}

/** 通信ごとに、サーバー処理と SQL がどこまで結べるか（一覧と変換が同じ判定を使う） */
export function liveExchangeLinks(obs: LiveRunObservation, e: LiveExchange): {
  root: ObsSpan | null; server: ObsSpan | null; sql: ObsSpan[]; reason: string | null;
  /** 7B-3B-1: 何を根拠に通信と受付スパンを結んだか（結べなければ null） */
  basis: HandlesBasis | null;
} {
  const none = (reason: string) => ({ root: null, server: null, sql: [], reason, basis: null });
  if (obs.instrumentation.state !== 'enabled') {
    return none(`計装が有効ではありません（${obs.instrumentation.reason ?? obs.instrumentation.state}）`);
  }
  let root: ObsSpan | null;
  let basis: HandlesBasis;
  if (e.relayId) {
    /*
     * 7B-3B-1: **中継が自分で作った識別子**を受け取った受付スパンを探す（応答のヘッダはアプリの
     * プロセスの中で付くので、それだけを信じない）。
     *   0 本 → まだ書かれていない／記録されていない。結ばない
     *   2 本以上 → 1つに決まらない。結ばない
     *   応答のトレース識別子があり、その受付スパンと食い違う → 付け替えを疑う。結ばない
     */
    const cands = obs.spans.filter((s) => s.attrs[RELAY_ID_ATTR] === e.relayId
      && s.kind === 1 && s.scope.includes('instrumentation-http'));
    if (!cands.length) {
      return none(e.failure
        ? '開発サーバーから応答が返らなかったため、受付スパンを確かめられません'
        : '中継がこの要求に付けた識別子を受け取った受付スパンが、まだ収集ファイルに書かれていません');
    }
    if (cands.length > 1) {
      return none(`中継がこの要求に付けた識別子を受け取った受付スパンが ${cands.length} 本あり、1つに決まりません`);
    }
    root = cands[0];
    if (e.trace && (e.trace.traceId !== root.traceId || e.trace.spanId !== root.spanId)) {
      return none('応答のトレース識別子が、中継の識別子を受け取った受付スパンと食い違います'
        + '（同じパスの別の要求に付け替えられた可能性があります）。どちらも信じずに結びません');
    }
    basis = 'relay-id';
  } else {
    /* 7B-3A の規則（中継の識別子を持たない記録） */
    if (!e.trace) {
      return none(e.failure
        ? '開発サーバーから応答が返らなかったため、トレース識別子がありません'
        : '応答にトレース識別子の専用ヘッダがありませんでした');
    }
    root = obs.spans.find((s) => s.traceId === e.trace!.traceId && s.spanId === e.trace!.spanId) ?? null;
    if (!root) return none('応答のトレース識別子が指すスパンが、まだ収集ファイルに書かれていません');
    basis = 'trace-header';
  }
  const inTrace = obs.spans.filter((s) => s.traceId === root!.traceId);
  const byId = new Map(inTrace.map((s) => [s.spanId, s]));
  /* 照合（断るだけ。結ぶ根拠を足さない）: 識別子はアプリのプロセスの中で付くので、
   * アプリのコードが書き換えうる。指した受付スパンのパスが、中継が転送したパスと違えば結ばない */
  const target = root.attrs['http.target'] ?? root.attrs['url.path'];
  if (typeof target === 'string' && target.split('?')[0] !== e.path) {
    return none('トレース識別子が指す受付スパンのパスが、この通信のパスと一致しません');
  }
  const descends = (s: ObsSpan, targetId: string) => s.spanId === targetId || ancestry(byId, s, targetId) !== null;
  const route = inTrace
    .filter((s) => ROUTE_SPAN_TYPES.includes(String(s.attrs['next.span_type'] ?? '')) && descends(s, root!.spanId))
    .sort((a, b) => a.startMs - b.startMs)[0];
  const server = route ?? root;
  const sqlIds = new Set(obs.sqlAnalyses.map((a) => a.spanId));
  const sqlTextual = inTrace.filter((s) => typeof (s.attrs['db.statement'] ?? s.attrs['db.query.text']) === 'string');
  const sql = sqlTextual
    .filter((s) => s.spanId !== server.spanId && descends(s, server.spanId))
    .filter((s) => sqlIds.has(s.spanId) || !obs.parser.available)
    .sort((a, b) => a.startMs - b.startMs);
  return { root, server, sql, reason: null, basis };
}

/** キャンバスに置くコンポーネントのノードの上限（layout.ts の帯は2つまで重ならない — 7B-3A 第9節 #8） */
const LIVE_MAX_COMPONENTS = 2;

/** 7B-3B-1: SQL を実行した呼び出し位置（DataAccessSite）を担うコンポーネントのノード */
function liveSiteNode(id: number, d: LiveDataAccess, server: ObsSpan, firstSqlId: number): ModelNode {
  const site = d.site!;
  const rendering = String(server.attrs['next.span_type'] ?? '') === 'AppRender.getBodyResult';
  return node({
    id, kind: 'component', form: 'module',
    title: 'コンポーネント',
    identifier: `${site.file}:${site.line}`,
    chipSub: site.component.name,
    hover: 'この SQL を実行したデータ取得の呼び出し位置（いまの起動で観測）',
    overview: [
      { k: '取得手段', v: 'サーバー側でデータ取得の呼び出し時に記録したスタック' },
      { k: '呼び出し位置', v: `${site.line} 行 ${site.col} 列 — ${site.file}:${site.line}:${site.col}` },
      { k: 'ソース', v: site.sourceLine },
      ...(site.functionName ? [{ k: '関数', v: site.functionName }] : []),
      { k: 'コンポーネント', v: `${site.component.name}（${site.component.file}:${site.component.line}〜${site.component.endLine}）。囲む定義は文脈であって、関係の端点ではありません` },
      {
        k: '実行の種別',
        v: rendering
          ? 'サーバーでページを描画している間の実行です（Server Component の直接の取得）。ブラウザからの API 通信ではありません'
          : `サーバー処理 ${server.name} の間の実行です`,
      },
      { k: '帰属の範囲', v: ATTRIBUTION_SCOPE_NOTE.definitionOnly },
      { k: '照合', v: d.checks.join(' / ') },
      {
        k: '主張の範囲',
        v: 'この SQL を実行したのはこの位置のコードである、までです。この SQL の結果が画面のどの値になったかは確認していません',
      },
      { k: '次の一歩', v: 'この実行SQLを見る', go: { type: 'node', id: firstSqlId } },
    ],
    source: SOURCE_OF.serverCallStack,
    evidence: [
      `呼び出しの入口（${d.at ?? '不明'}）で記録した呼び出しスタック（同じ起動の収集ファイル・同じスパン ID の記録1件）`,
      'ソースマップで戻した位置のソース行に、データ取得の呼び出しがあることの確認（実行の後に生成物もソースも書き換わっていない）',
      'ソースの読み直しとビルド時の対応表で、囲むコンポーネントが一致',
    ],
  });
}

/** 7B-3B-1: 選択した要素（7B-2）を同じキャンバスに並べるときの入力 */
export interface LiveRunOptions {
  /**
   * いまプレビューで選択している要素。`lineage` が無ければ**関係は作らない。** 同じ画面に並べるだけで、
   * 選択した値と SQL の間には線を引かず、値の由来は未確認と書く
   */
  selection?: LiveSelectionInput;
  /** 7B-3B-2: 選択した要素を描いた文書の同定（bindDocument） */
  binding?: DocBinding;
  /**
   * 7B-3B-2: 値の由来の評価（evaluateLineage）。`status: 'linked'` で、**この通信が同定した文書のもの**であり、
   * その SQL の呼び出し位置のノードを描けたときだけ `supplies` を作る。それ以外は理由つきの切断にする
   */
  lineage?: LiveLineage;
}

/** 7B-3B-2: 由来の評価を、この通信の描画に使えるか */
function lineageFor(opts: LiveRunOptions, seq: number): LiveLineage | null {
  const l = opts.lineage;
  if (!l || !opts.selection) return null;
  return l.binding.status === 'identified' && l.binding.seq === seq && l.exchangeSeq === seq ? l : null;
}

/** 7B-3B-2: 由来を結ばなかった理由の1行（段と理由） */
export function lineageCutText(l: LiveLineage): string {
  if (!l.cut) return '';
  const c = LINEAGE_CUT_LABEL[l.cut.reason];
  return `${LINEAGE_STAGE_LABEL[c.stage]}: ${c.text}${l.cut.detail ? `（${l.cut.detail}）` : ''}`;
}

/** 7B-3B-2: 文書の同定の1行 */
export function docBindingText(b: DocBinding | undefined, ex: LiveExchange): string {
  if (!b) {
    return `この要素を描いた文書の取得が、通信 #${ex.seq}（${ex.method} ${ex.path}）かどうかは特定していません。同じパスのページであることだけで並べています`;
  }
  if (b.status === 'identified') {
    return b.seq === ex.seq
      ? `この要素を描いた文書は、通信 #${ex.seq}（${ex.method} ${ex.path}）の応答です（中継が応答ごとに付けた文書の識別子で照合）。`
        + '**通信と文書の対応であって、表示された値と SQL の結果の対応ではありません**'
      : `この要素を描いた文書は通信 #${b.seq} の応答です。いま表示している通信 #${ex.seq} ではありません（同じパスでも別の文書です）`;
  }
  return `この要素を描いた文書を同定できません — ${DOC_UNBOUND_LABEL[b.reason]}${b.detail ? `（${b.detail}）` : ''}`;
}

export function fromLiveRun(obs: LiveRunObservation, seq: number, opts: LiveRunOptions = {}): AdapterResult {
  const ex = obs.exchanges.find((e) => e.seq === seq);
  if (!ex) throw new Error(`exchange #${seq} not observed in this session`);
  /* 7C-1: 要約の観測で、証拠（スパン・SQL）を入れていない通信を描かない（「未接続」と誤って描くため） */
  if (obs.detailSeqs && !obs.detailSeqs.includes(seq)) throw new Error(`exchange #${seq} has no detail in this view`);
  const skipped: { what: string; why: string }[] = [];
  const nodes: ModelNode[] = [];
  const hops: ModelHop[] = [];
  const cuts: Cut[] = [];
  const t0 = ex.startMs;
  const rel = (ms: number) => +(ms - t0).toFixed(1);
  const links = liveExchangeLinks(obs, ex);
  const { root, server } = links;

  let nextId = 1;
  /* 7B-3B-2: この通信について使える由来の評価（同定した文書の通信で、結べたもの） */
  const linFor = lineageFor(opts, seq)?.status === 'linked' ? lineageFor(opts, seq) : null;
  /* ------------------------------------------- 7B-3B-1: 選択した要素（① ②。7B-2 の変換をそのまま使う） */
  let selComp: ModelNode | undefined;
  if (opts.selection) {
    const sd = fromLiveSelection(opts.selection);
    nodes.push(...sd.dataset.nodes);
    hops.push(...sd.dataset.hops);
    skipped.push(...sd.skipped);
    selComp = sd.dataset.nodes.find((n) => n.kind === 'component');
    for (const c of sd.dataset.cuts) {
      if (c.from === selComp?.id && linFor) continue;    // 由来を結べたら、7B-2 の「props の由来」の切断は付けない（下で必要なら付け直す）
      /* 7B-2 の切断（props の由来）を、SQL と並べたときの言い方にする。**結ばないことは同じ** */
      cuts.push(c.from === selComp?.id
        ? {
          ...c,
          head: 'この値の由来は未確認です',
          sub: opts.lineage?.cut
            ? lineageCutText(opts.lineage)
            : opts.lineage && opts.lineage.status === 'linked'
              ? '由来の評価は別の通信（この要素を描いた文書）について行いました。この通信の SQL とは結びません'
              : 'この値が右の SQL の結果から来たかは確認していません（props の由来）',
          kind: 'supplies / derives を作らない。同じコンポーネントの中にあることを根拠にしない',
        }
        : c);
    }
    const value = sd.dataset.nodes.find((n) => n.kind === 'value');
    value?.overview.push({ k: '通信との関係', v: docBindingText(opts.binding ?? opts.lineage?.binding, ex) });
    nextId = Math.max(0, ...nodes.map((n) => n.id)) + 1;
  }
  const httpId = nextId++;
  const serverId = server ? nextId++ : undefined;

  /* ------------------------------------------------------------- ③ 通信 */
  nodes.push(node({
    id: httpId, kind: 'http', form: 'module',
    // ブラウザが送った通信（中継を通った）。サーバーの中から出た通信ではない
    exchangeScope: 'browser',
    title: '通信', identifier: `${ex.method} ${ex.path}`,
    chipSub: `${ex.method} ${ex.path}`,
    metrics: {
      ...(ex.status !== null ? { status: ex.status } : {}),
      ...(ex.durationMs !== null ? { durationMs: fmtMs(ex.durationMs) } : {}),
    },
    span: { startMs: 0, endMs: ex.durationMs ?? 0 },
    hover: 'プレビューから開発サーバーへ実際に送られた通信（いまの起動で観測）',
    overview: [
      { k: '取得手段', v: 'IDE のプレビュー中継が転送した通信の記録（ブラウザ自身の記録ではありません）' },
      { k: '応答', v: ex.status !== null ? '' : `応答なし（${ex.failure?.detail ?? '理由不明'}）`, ...(ex.status !== null ? { fromMetrics: true } : {}) },
      { k: '種類', v: RELAY_KIND_LABEL[ex.kind] },
      { k: 'クエリ文字列', v: ex.hasQuery ? '付いていました（値は保存していません）' : 'ありません' },
      { k: '所要時間の意味', v: '中継が要求を受けてから応答を送り終えるまで。ブラウザが測った値ではありません' },
      { k: '読んだヘッダ', v: `要求 ${obs.session.readRequestHeaders.join(' / ')}・応答 ${obs.session.readResponseHeaders.join(' / ')} だけ。本文・Cookie は読んでいません` },
      ...(ex.trace ? [{ k: 'トレース識別子', v: `${ex.trace.traceId}（応答の専用ヘッダ。ブラウザには渡していません）` }] : []),
      { k: '観測した起動', v: `いまの起動（${obs.session.startedAt} から）の #${ex.seq}` },
      {
        k: '開始元',
        v: 'この通信を起こしたコード・この応答で描かれた値とは結んでいません（証拠の評価は 7B-3B）',
      },
      ...(serverId !== undefined
        ? [{ k: '次の一歩', v: 'サーバー処理を見る', go: { type: 'node' as const, id: serverId } }]
        : [{ k: 'サーバー処理', v: `結んでいません — ${links.reason}` }]),
    ],
    source: 'preview-relay',
    evidence: [
      'IDE のプレビュー中継が転送したその場で記録した方法・パス・状態・時刻',
      ...(ex.trace ? ['開発サーバーの応答の専用ヘッダに載ったトレース識別子'] : []),
    ],
  }));

  cuts.push({
    from: httpId,
    head: 'ここより上流は結んでいません',
    sub: 'この通信を起こしたコード・表示された値',
    where: 'ブラウザの呼び出し元 / コンポーネント',
    kind: '証拠が無いため関係を作らない（requests / derives）。選択した要素との関係は 7B-3B で評価',
  });

  /* ------------------------------------------ ⑤ 実行SQL と ②'' 呼び出し位置の割り当て（7B-3B-1）
   * 番号は経路の順に振る: ②''（実行した位置）→ ⑤（実行されたSQL）。PoC-02 と同じ規約。
   * `queries` を作るのは、照合（dataAccess.ts）が通った SQL だけ。同じ位置から2本の SQL が出たら、
   * 位置のノードは1つで線が2本（どの描画インスタンスかは同定しない — 決定 G） */
  /* 7B-3B-2: 由来を結べた SQL は、配置の上限があっても必ず描く（先頭に置く） */
  const linSql = new Set(linFor?.sqlSpanIds ?? []);
  const drawnSql = [...links.sql.filter((x) => linSql.has(x.spanId)), ...links.sql.filter((x) => !linSql.has(x.spanId))]
    .slice(0, LIVE_MAX_SQL);
  const siteBudget = LIVE_MAX_COMPONENTS - (selComp ? 1 : 0);
  const siteIdOf = new Map<string, number>();
  const plan = drawnSql.map((sp) => {
    const d = obs.dataAccess?.find((x) => x.spanId === sp.spanId) ?? null;
    /* 同じスパン ID・同じトレースの照合結果だけを使う（別のトレースの記録を当てない） */
    const usable = d && d.traceId === sp.traceId ? d : null;
    let siteId: number | undefined;
    let siteNew = false;
    let siteCapped = false;
    if (usable?.site) {
      const key = `${usable.site.file}:${usable.site.line}:${usable.site.col}`;
      const have = siteIdOf.get(key);
      if (have !== undefined) siteId = have;
      else if (siteIdOf.size < siteBudget) { siteId = nextId++; siteIdOf.set(key, siteId); siteNew = true; } else siteCapped = true;
    }
    return { span: sp, d: usable, siteId, siteNew, siteCapped, sqlId: nextId++ };
  });
  const siteSqlCount = plan.filter((p) => p.siteId !== undefined).length;
  const firstSqlNodeId = plan[0]?.sqlId ?? 0;

  /* ------------------------------------------------------- ④ サーバー処理 */
  if (!server || serverId === undefined) {
    skipped.push({ what: 'サーバー処理', why: links.reason ?? '観測していない' });
  } else {
    const isRoute = server !== root;
    const route = String(server.attrs['next.route'] ?? server.attrs['http.target'] ?? '—');
    const chain = isRoute ? ancestry(new Map(obs.spans.filter((s) => s.traceId === server.traceId).map((s) => [s.spanId, s])), server, root!.spanId) : null;
    nodes.push(node({
      id: serverId, kind: 'server', form: 'physical',
      title: 'サーバー処理', identifier: server.name,
      chipSub: route,
      metrics: { durationMs: fmtMs(server.durationMs) },
      span: { startMs: rel(server.startMs), endMs: rel(server.endMs) },
      hover: 'この通信を受けたサーバーの処理（いまの起動で観測）',
      overview: [
        { k: '取得手段', v: '計装が生成したスパン' },
        { k: '区間', v: '', fromMetrics: true },
        { k: 'ルート', v: route },
        {
          k: 'スパン',
          v: isRoute
            ? `${server.name}（HTTP の受付スパンから ${chain?.depth ?? '?'} 段下の、Next.js のルート単位の処理）`
            : `${server.name}（HTTP の受付スパン。ルート単位の処理のスパンは見つかりませんでした）`,
        },
        { k: 'SQL', v: links.sql.length ? `${links.sql.length} 本（このスパンの子孫）` : 'このスパンの子孫に SQL のスパンはありません' },
        ...(links.sql.length > LIVE_MAX_SQL
          ? [{ k: '描いていない SQL', v: `${links.sql.length - LIVE_MAX_SQL} 本。キャンバスの配置の上限のため（観測はしています）` }]
          : []),
        {
          k: '主張の範囲',
          v: siteSqlCount
            ? 'ルート単位の処理です。このスパンだけではどのコードが SQL を実行したかは言えません。'
              + 'SQL を実行した呼び出し位置は、別の根拠（呼び出しの入口のスタック）で「コンポーネント」のノードに出しています'
            : 'ルート単位の処理です。どのコンポーネント・どの行が SQL を実行したかは観測していません'
              + (obs.dataAccess && links.sql.length ? '（各 SQL の「実行した呼び出し位置」に理由を書いています）' : ''),
        },
        ...(links.sql.length
          ? [{ k: '次の一歩', v: '実行SQLを見る', go: { type: 'node' as const, id: firstSqlNodeId } }]
          : []),
      ],
      source: 'trace-span',
      evidence: ['スパンの名前と区間', `トレースID ${server.traceId.slice(0, 8)}…`],
    }));
    hops.push(hop({
      id: 'handles', order: hops.length + 1, from: httpId, to: serverId, relation: 'handles',
      label: 'この通信を受けたサーバーの処理',
      source: 'trace-context',
      evidence: [
        ...(links.basis === 'relay-id'
          ? [
            '中継がこの要求のために作って開発サーバーへ載せた識別子を、受付スパンが受け取っていたこと（その受付スパンは1本だけ）',
            ...(ex.trace ? ['中継が応答の専用ヘッダから読んだトレース識別子も、同じ受付スパンを指していること'] : []),
          ]
          : ['中継が応答の専用ヘッダから読んだトレース識別子と、サーバー側スパンの識別子の一致']),
        ...(isRoute ? ['HTTP の受付スパンからこの処理のスパンへの親子の連鎖'] : []),
      ],
    }));
    if (!links.sql.length) {
      cuts.push({
        from: serverId,
        head: 'この処理の下で SQL は観測されませんでした',
        sub: 'SQL を実行していないか、計装の対象外のドライバです',
        where: 'DB への問い合わせ',
        kind: '観測していないものは描かない（OBS-05）',
      });
    }
  }

  /* ------------------------------------------------------------ ⑤ 実行SQL */
  for (const s of links.sql.filter((x) => !drawnSql.includes(x))) {
    skipped.push({ what: `実行SQL ${s.spanId}`, why: 'キャンバスの配置の上限のため描いていない（観測はしている）' });
  }
  const sqlNodes: { id: number; a: ObsSqlAnalysis | null; span: ObsSpan }[] = [];
  for (const p of plan) {
    const s = p.span;
    const id = p.sqlId;
    const d = p.d;
    const a = obs.sqlAnalyses.find((x) => x.spanId === s.spanId) ?? null;
    const text = String(s.attrs['db.statement'] ?? s.attrs['db.query.text']);
    const chain = ancestry(new Map(obs.spans.filter((x) => x.traceId === s.traceId).map((x) => [x.spanId, x])), s, server!.spanId);
    sqlNodes.push({ id, a, span: s });
    /* ②'' この SQL を実行した呼び出し位置（照合が通ったときだけ。SQL のノードの前に置く） */
    if (p.siteId !== undefined && p.siteNew && d?.site) nodes.push(liveSiteNode(p.siteId, d, server!, id));
    if (p.siteCapped) {
      skipped.push({ what: `実行SQL ${s.spanId} の呼び出し位置のノード`, why: 'キャンバスの配置の上限のため描いていない（位置は SQL の詳細に書いている）' });
    }
    if (d && !d.site) {
      skipped.push({ what: `実行SQL ${s.spanId} の呼び出し位置`, why: `${d.failure?.reason ?? '不明'}: ${d.failure?.detail ?? ''}` });
    }
    const accessRow: OverviewRow[] = !obs.dataAccess ? [] : d?.site
      ? [{
        k: '実行した呼び出し位置',
        v: `${d.site.file}:${d.site.line}:${d.site.col}（${d.site.component.name} の中）`
          + (p.siteCapped ? '。キャンバスの配置の上限のため、ノードと線は描いていません' : ''),
        ...(p.siteId !== undefined ? { go: { type: 'node' as const, id: p.siteId } } : {}),
      }]
      : [{
        k: '実行した呼び出し位置',
        v: `特定していません — ${d?.failure ? DATA_ACCESS_FAILURE_LABEL[d.failure.reason] ?? d.failure.reason : 'この SQL の照合結果がありません'}`
          + (d?.located && (d.failure?.reason === 'component-not-agreed' || d.failure?.reason === 'manifest-unavailable')
            ? `（参考: ソースマップで戻した位置は ${d.located.file}:${d.located.line}:${d.located.col}。関係は作っていません）`
            : ''),
      }];
    nodes.push(node({
      id, kind: 'sql', form: 'module',
      title: '実行SQL', identifier: shortSql(text),
      chipSub: '',
      metrics: { durationMs: fmtMs(s.durationMs) },
      span: { startMs: rel(s.startMs), endMs: rel(s.endMs) },
      hover: 'その処理が実行したSQL（いまの起動で観測）',
      overview: [
        { k: '取得手段', v: s.scope.includes('prisma') ? 'ORM計装のスパン属性' : 'DBドライバ計装のスパン属性' },
        { k: '区間', v: '', fromMetrics: true },
        { k: 'SQL', v: text },
        {
          k: 'パラメータ',
          v: a?.redacted
            ? `収集しません（文字列 ${a.redacted.strings} 件・数値 ${a.redacted.numbers} 件を取得時点で除去）`
            : '収集しません',
        },
        {
          k: '構文解析',
          v: !obs.parser.available ? (obs.parser.reason ?? '解析器を使えません')
            : a?.parseOk ? `成功（${a.statementType ?? '種別不明'}）。Phase 6F の解析器（SELECT 句の結果列だけを射影にする）`
              : `できませんでした（${a?.parseError ?? '理由不明'}）`,
        },
        { k: '取得件数', v: '計装から取得できていません' },
        ...accessRow,
        ...(p.siteId !== undefined
          ? [{
            k: '表示された値との関係',
            v: linFor && linSql.has(s.spanId)
              ? '選択した要素の値は、この SQL を実行した呼び出しの結果から来ていると**静的解析で推定**しました（supplies・推定）。実行時に値を観測したものではありません'
              : 'この SQL の結果が画面のどの値になったかは確認していません（supplies / derives を作っていません）',
          }]
          : []),
      ],
      source: 'orm-instrumentation',
      evidence: [
        `計装 ${s.scope} のスパン属性`,
        chain?.depth === 1 ? 'サーバー処理のスパンの直接の子' : `サーバー処理のスパンからの親子の連鎖（${chain?.depth ?? '?'} 段）`,
      ],
    }));
    if (p.siteId !== undefined && d?.site) {
      hops.push(hop({
        /*
         * queries | DataAccessSite → SqlStatement | L1相当 | server-call-stack（M1 決定 A）。
         * `executes`（Span → SqlStatement）とは**始点の型が違う**。同じ SQL への別々の観測であり、
         * データの合流ではない（shared-object）
         */
        id: `queries-${id}`, order: hops.length + 1, from: p.siteId, to: id, relation: 'queries',
        label: 'この位置のコードが実行したSQL',
        endpoints: {
          from: {
            type: 'DataAccessSite', file: d.site.file, line: d.site.line, col: d.site.col,
            inComponent: d.site.component.name,
          },
        },
        convergence: 'shared-object',
        source: SOURCE_OF.serverCallStack,
        evidence: [
          `呼び出し位置 ${d.site.file}:${d.site.line}:${d.site.col}`,
          '呼び出しの入口で記録したスタックの、最も内側のアプリ側フレーム',
          'その SQL のスパンの OpenTelemetry コンテキストが運んできた記録である（同じスパン ID・同じトレース・同じプロセス）',
        ],
      }));
    }
    hops.push(hop({
      id: `executes-${id}`, order: hops.length + 1, from: serverId!, to: id, relation: 'executes',
      label: 'その処理が実行したSQL',
      ...(p.siteId !== undefined ? { convergence: 'shared-object' as Convergence } : {}),
      source: 'trace-span',
      evidence: ['スパンの親子関係', `同一トレース ${s.traceId.slice(0, 8)}…`],
    }));
  }

  /* 呼び出し位置のノードに、結果の行き先が未確認であることの切断を付ける（選択した要素が無いとき） */
  if (!selComp) {
    const firstSite = plan.find((p) => p.siteNew)?.siteId;
    if (firstSite !== undefined) {
      cuts.push({
        from: firstSite,
        head: 'この SQL の結果の行き先は未確認です',
        sub: '画面のどの値になったか（supplies / derives）',
        where: 'コンポーネントの中の値の受け渡し',
        kind: '証拠が無いため関係を作らない。同じコンポーネントの中にあることを根拠にしない',
      });
    }
  }
  /* ------------------------------------------------ 7B-3B-2: 値の由来（supplies）
   * 作るのは evaluateLineage が全条件を通し（linFor）、その SQL の呼び出し位置のノードを描けたときだけ。
   * 向きはデータの供給方向（取得位置 → 描画位置）で定義し、画面は逆向きに探索する（against-data）。 */
  let suppliesMade = false;
  if (selComp && linFor && linFor.site && linFor.fetch) {
    const target = plan.find((p) => linSql.has(p.span.spanId) && p.siteId !== undefined && p.d?.site
      && p.d.site.file === linFor.fetch!.file && p.d.site.line === linFor.fetch!.line && p.d.site.col === linFor.fetch!.col);
    if (!target) {
      skipped.push({ what: '値の由来（supplies）', why: '由来の取得位置のノードを、キャンバスの配置の上限のため描けませんでした（評価は通っています）' });
    } else {
      suppliesMade = true;
      const l = linFor;
      const cands = l.candidates.map((c) => ({
        identifier: `${c.schema}.${c.table}.${c.column}`,
        label: `${c.table} の ${c.column} 列`,
        evidence: [
          `実行された SQL の SELECT 句にこの列がある${c.note ? `（${c.note}）` : ''}`,
          `参照の連鎖 ${c.trail.length} 段（${c.query.file}:${c.query.line}:${c.query.col} の取得結果）`,
          ...(c.via === 'anyfield' ? ['参照のキーが動的なため、この SQL の全列が候補になる'] : []),
        ],
        ...(c.note ? { note: c.note } : {}),
      }));
      const linkStatus: NonNullable<ModelHopInput['linkStatus']> = cands.length === 1
        ? 'resolved' : cands.length > 1 ? 'multiple-candidates' : 'untraceable';
      const trail = l.candidates[0]?.trail ?? [];
      hops.push(hop({
        /* supplies | DataAccessSite → PropBindingSite | L2 | static-analysis（M1 決定 B） */
        id: 'supplies', order: hops.length + 1,
        from: selComp.id, to: target.siteId!, relation: 'supplies',
        label: 'この表示値の由来（取得結果のどの項目か）',
        orientation: 'against-data',
        endpoints: {
          from: {
            type: 'PropBindingSite', file: l.site!.file, line: l.site!.line, col: l.site!.col,
            ...(l.site!.component ? { inComponent: l.site!.component } : {}),
          },
          to: {
            /* 実測した呼び出し位置（静的解析の位置と列まで一致していることは評価の条件） */
            type: 'DataAccessSite', file: l.fetch!.file, line: l.fetch!.line, col: l.fetch!.col,
            inComponent: l.fetch!.component,
          },
        },
        source: SOURCE_OF.staticAnalysis,
        linkStatus,
        ...(cands.length ? { candidates: cands } : {}),
        evidence: [
          'ソースの静的解析（PoC-04。TypeScript の AST と記号解決）による参照の連鎖',
          ...(cands.length
            ? [`実行された SQL の SELECT 句で解決した列 ${cands.length} 件（${cands.map((c) => c.identifier).join(' / ')}）`]
            : [`列は特定できていません（テーブルまで: ${l.tableCandidates.map((t) => `${t.schema}.${t.name}`).join(' / ')}）`]),
          `静的解析が見た取得の呼び出し位置と、実測した呼び出し位置（${l.fetch!.file}:${l.fetch!.line}:${l.fetch!.col}）が列まで一致`,
          `選択した要素を描いた文書は通信 #${seq}（中継が応答ごとに付けた識別子で同定）`,
        ],
        tagLabel: '由来は静的解析による推定',
        weakness: [
          '取得結果のどの項目がこの表示値になったかは、**ソースの静的解析による推定**です。',
          '実行時に観測したものではありません（表示された値も、取得した行も読んでいません）。',
          '文書・呼び出し位置・SQL は実測ですが、それで推定が実測に変わることはありません。',
          l.reasons.length ? `推定の状態: ${l.reasons.join('／')}。` : '',
          trail.length ? `参照の連鎖: ${trail.join(' ← ')}。` : '',
          l.transformed ? '表示までに加工（連結・型変換など）を通っています。由来の列は推定できても、表示値がその列の値そのままとは限りません。' : '',
          l.literalPaths ? `条件分岐で固定値になる経路が ${l.literalPaths} 本あります。` : '',
          l.untracked.length ? `追えなかった経路 ${l.untracked.length} 件: ${l.untracked.map((u) => u.why).join('／')}。` : '',
          l.unresolved.length ? `解決できなかった参照: ${l.unresolved.map((u) => u.text).join('／')}。` : '',
          '同じ定義が複数回描かれている場合、どの行の値かは同定していません。',
        ].filter(Boolean).join(''),
      }));
      if (l.outcome === 'table-only') {
        cuts.push({
          from: target.siteId!,
          head: '由来の列は特定していません',
          sub: l.unresolved.map((u) => u.text).join('／') || '列を解決できなかった',
          where: '実行SQLの SELECT 句 / 由来のカラム',
          kind: 'テーブルまでに粒度を落としている（01b Q-04.5 代替1）',
        });
      }
    }
  }
  if (selComp && linFor && !suppliesMade) {
    cuts.push({
      from: selComp.id,
      head: 'この値の由来は未確認です',
      sub: '由来の取得位置のノードを描けなかったため、線を引いていません',
      where: 'コンポーネントの props / 取得結果の項目',
      kind: '描けない端点に線を引かない',
    });
  }
  /* 選択した要素のコンポーネントに、SQL の位置との関係を書く */
  if (selComp) {
    const sites = plan.filter((p) => p.d?.site).map((p) => p.d!.site!);
    const same = sites.find((x) => x.component.file === selComp!.identifier.split(':')[0]
      && selComp!.chipSub === x.component.name);
    selComp.overview.push({
      k: 'SQL との関係',
      v: suppliesMade && linFor
        ? `静的解析で、この値（${linFor.site!.expr} — ${linFor.site!.file}:${linFor.site!.line}:${linFor.site!.col}）は `
          + `${linFor.fetch!.file}:${linFor.fetch!.line}:${linFor.fetch!.col} の取得結果から来ていると**推定**しました（supplies・L2）`
        : opts.lineage?.cut
          ? `由来を結んでいません — ${lineageCutText(opts.lineage)}`
          : same
            ? `同じコンポーネント定義（${same.component.name}）の中に、SQL の呼び出し位置（${same.file}:${same.line}）があります。`
              + '**同じ定義の中にあることは根拠にしていません。** この値がその SQL の結果から来たかは未確認です'
            : 'この選択と SQL の呼び出し位置は結んでいません。この値の由来は未確認です',
    });
    if (opts.lineage) {
      selComp.overview.push({
        k: '由来の評価',
        v: opts.lineage.checks.length ? `通った条件: ${opts.lineage.checks.join(' / ')}` : '通った条件はありません',
      });
    }
  }

  /* --------------------------------------------- ⑥ テーブル ⑦ カラム（構文解析だけ） */
  const tableNodeId = new Map<string, number>();
  const readsInto = new Map<number, ModelHop[]>();
  let columnsDrawn = 0;
  for (const { id: sqlId, a } of sqlNodes) {
    if (!a) {
      skipped.push({ what: 'テーブル・カラム', why: obs.parser.reason ?? '構文解析の結果がありません' });
      continue;
    }
    if (!a.parseOk) {
      skipped.push({ what: 'テーブル・カラム', why: `SQL を構文解析できなかった（${a.parseError ?? '理由不明'}）。推測で埋めない` });
      continue;
    }
    for (const t of a.tables) {
      /* reads は「読んだ」。書き込み先（INSERT / UPDATE / DELETE の対象）を reads にしない */
      if (t.op && t.op !== 'select') {
        skipped.push({ what: `テーブル ${t.schema ?? '?'}.${t.name}`, why: `書き込み先（${t.op}）であり、reads（読み取り）の関係にはしない` });
        continue;
      }
      const key = `${t.schema ?? ''}.${t.name}`;
      let tid = tableNodeId.get(key);
      if (tid === undefined) {
        tid = nextId++;
        tableNodeId.set(key, tid);
        nodes.push(node({
          id: tid, kind: 'table', form: 'physical',
          title: 'テーブル', identifier: t.schema ? `${t.schema}.${t.name}` : t.name, chipSub: t.name,
          hover: 'そのSQLが読んだテーブル（実行された SQL の構文解析）',
          overview: [
            { k: '取得手段', v: '実行されたSQL文の構文解析' },
            { k: '名前', v: t.schema ? `${t.schema}.${t.name}` : `${t.name}（スキーマは SQL に書かれておらず、決まっていません）` },
            { k: '定義', v: 'DB の情報スキーマには照会していません（行数・列の一覧は未取得）' },
          ],
          source: 'sql-ast-parse',
          evidence: ['実行されたSQL文の FROM 句'],
        }));
      }
      const h = hop({
        id: `reads-${sqlId}-${tid}`, order: hops.length + 1, from: sqlId, to: tid, relation: 'reads',
        label: 'そのSQLが読んだテーブル',
        source: 'sql-ast-parse',
        evidence: ['SQL文の FROM 句'],
      });
      hops.push(h);
      readsInto.set(tid, [...(readsInto.get(tid) ?? []), h]);
    }

    /* projects の始点は SqlStatement。テーブルからカラムへの辺は作らない（規約1） */
    for (const p of a.projections) {
      if (columnsDrawn >= LIVE_MAX_COLUMNS) {
        skipped.push({ what: `カラム ${p.schema}.${p.table}.${p.column}`, why: 'キャンバスの配置の上限のため描いていない（解析はしている）' });
        continue;
      }
      columnsDrawn += 1;
      const cid = nextId++;
      nodes.push(node({
        id: cid, kind: 'column', form: 'module',
        title: 'カラム', identifier: `${p.schema}.${p.table}.${p.column}`, chipSub: p.column,
        hover: 'そのSQLが取り出した列（SELECT 句の結果列）',
        overview: [
          { k: '取得手段', v: '実行されたSQL文の構文解析' },
          { k: '定義', v: `${p.schema}.${p.table}.${p.column}` },
          { k: '型・NULL', v: '未取得（DB の情報スキーマには照会していません）' },
          { k: '主張の範囲', v: 'この SQL の結果の行に含まれる列であることまでです。画面のどの値になったかは観測していません' },
        ],
        source: 'sql-ast-parse',
        evidence: ['SQL文の SELECT 句（結果列）'],
      }));
      hops.push(hop({
        id: `projects-${sqlId}-${cid}`, order: hops.length + 1, from: sqlId, to: cid, relation: 'projects',
        label: 'そのSQLが取り出した列',
        source: 'sql-ast-parse',
        evidence: ['SQL文の SELECT 句'],
      }));
    }
    for (const u of a.unresolved) {
      skipped.push({ what: `射影 ${u.column ?? '(不明)'}`, why: whyOfUnresolvedProjection(u.why) });
    }
  }
  /* 同じテーブルに2本以上の reads が入るとき、それは同じ対象への別々の観測である（合流ではない） */
  for (const list of readsInto.values()) {
    if (list.length < 2) continue;
    for (const h of list) {
      const i = hops.indexOf(h);
      hops[i] = { ...h, convergence: 'shared-object' as Convergence };
    }
  }

  /* -------------------------------------------------------------- 経路外 */
  const others = obs.exchanges.filter((e) => e !== ex).slice(-4);
  const dataset: Dataset = {
    origin: 'measured',
    project: obs.project,
    runtime: { command: 'next dev', port: obs.port, instrumentation: LIVE_RUN_METHOD },
    nodes, hops, cuts,
    offPath: {
      detail: 'not-retrieved',
      label: others.map((e) => `${e.method} ${e.path}`).join(' / ') || 'なし',
      note: others.length
        ? 'いまの起動で観測した、いま描いていない通信です。プレビューパネルの一覧から選べます。'
        : 'いまの起動で観測した他の通信はありません。',
      nodes: others.map((e) => ({
        kind: 'http' as const, label: e.path,
        ...(e.durationMs !== null ? { durationMs: fmtMs(e.durationMs) } : {}),
      })),
      caption: { text: '選択していない経路（いまの起動の他の通信）', textUnselected: 'いまの起動の他の通信' },
    },
    pages: [{ icon: '▤', name: ex.path, path: ex.path, current: true }],
    notice: `いまの起動の実測（${obs.session.startedAt} 以降）／${obs.dataAccess ? LIVE_RUN_METHOD_CALLSITE : LIVE_RUN_METHOD}`,
    overviewNote:
      `${obs.collectedAt} に取得した、いまの起動の観測です（記録済みデータではありません）。`
      + `静的資材の通信 ${obs.session.excludedStatic} 件は数えていません。`
      + (suppliesMade
        ? 'SQL を実行した呼び出し位置は呼び出しスタックで特定しました。選択した値とその取得の結果は、静的解析で推定して結んでいます（推定）。'
        : siteSqlCount
          ? 'SQL を実行した呼び出し位置は呼び出しスタックで特定しました。表示された値とその SQL は結んでいません（値の由来は未確認）。'
          : '表示された値・コンポーネントとは結んでいません。')
      + (opts.selection ? ` ${docBindingText(opts.binding ?? opts.lineage?.binding, ex).replace(/\*\*/g, '')}。` : ''),
    provenance: {
      instrumentation: obs.dataAccess ? LIVE_RUN_METHOD_CALLSITE : LIVE_RUN_METHOD,
      bundler: '開発サーバーの既定',
      traceId: ex.trace?.traceId ?? '—',
      collectedAt: obs.collectedAt,
      notObserved: [
        { what: 'この通信を起こしたコード（requests）', why: '中継の記録は開始元を語らない。ブラウザの呼び出しスタック（request-initiator）を IDE は持たない' },
        suppliesMade
          ? { what: '表示された値と SQL の結果の対応（実測）', why: 'supplies は静的解析による推定（L2）。取得結果・表示値を読まないため、実行時の値の受け渡しは観測していない' }
          : { what: '表示された値と SQL の対応（supplies / derives / maps）', why: '取得結果・応答本文・表示値を読まない。同じコンポーネントの中にあることは根拠にしない' },
        ...(opts.selection && !((opts.binding ?? opts.lineage?.binding)?.status === 'identified')
          ? [{ what: '選択した要素を描いた文書取得の同定', why: (opts.binding ?? opts.lineage?.binding)?.status === 'unidentified'
            ? DOC_UNBOUND_LABEL[((opts.binding ?? opts.lineage?.binding) as Extract<DocBinding, { status: 'unidentified' }>).reason]
            : '同じパスの通信のどれがこの DOM を描いたかを示す証拠を取っていない' }]
          : []),
        { what: 'どの描画インスタンス（どの行）の値か', why: '同じ定義が複数回描かれるとき、DOM の何番目かと取得結果の何行目かを結ぶ観測手段が無い（決定 G）' },
        ...(obs.dataAccess ? [{ what: 'Prisma など、入口を包んでいないドライバの SQL の呼び出し位置', why: '計装が呼び出しの入口でスタックを取るのは pg の Pool.query / Client.query だけ（PoC-02）' }] : []),
        { what: '中継を通らない通信', why: 'ブラウザのキャッシュで済んだもの・別 origin への通信は中継に現れない' },
        { what: 'カラムの型・テーブルの行数', why: 'DB の情報スキーマに照会していない' },
        { what: 'SQL のパラメータ値・取得件数', why: '方針として収集しない／計装が付けない' },
      ],
    },
  };
  return { dataset, skipped };
}
