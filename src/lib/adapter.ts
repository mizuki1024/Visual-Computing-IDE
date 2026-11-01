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
  type ModelHopInput, type ModelNode, type OffPath, type SourceId,
} from './model';
import type {
  ObsBrowserRequest, ObsElementAnchor, ObsElements, ObsServerCallsite, ObsSpan,
  ObsSqlAnalysis, ObservationBundle,
} from './observation';

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
