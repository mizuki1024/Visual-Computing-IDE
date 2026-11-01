/* =============================================================================
 * 自動生成（poc/runner/build-poc04-observation.mjs）。手で編集しない。
 *
 * PoC-04 で実際に観測した3回の読み込みの記録である。合成データではない。
 *   LIN_A_OBSERVATION  由来を1列に絞れた場合（推定のホップが1本増える）
 *   LIN_C_OBSERVATION  候補が複数のままの場合（1つに断定しない）
 *   LIN_G_OBSERVATION  由来を作らない場合（**切断のまま。線を引かない**）
 *
 * 由来の関係は **static-analysis（L2・推定）** である。
 * 列の解決に実測の SQL を使っているが、参照の連鎖そのものは推定であり、
 * 昇格しない（02a 3.5.1 / observabilityOf）。
 *
 * **表示された値そのもの・取得結果の中身・ヘッダ一覧は含まない。**
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const LIN_A_OBSERVATION: ObservationBundle = {
  "meta": {
    "poc": "PoC-04",
    "collectedAt": "2026-10-31T18:11:55Z",
    "app": {
      "name": "PoC Fixture App",
      "port": 3200,
      "framework": "Next.js 16.4.3 (App Router)",
      "orm": [
        "Prisma 6.19.3",
        "pg 8.23.1"
      ],
      "pages": [
        {
          "icon": "⌂",
          "name": "ホーム",
          "path": "/"
        },
        {
          "icon": "▣",
          "name": "物件一覧",
          "path": "/listings"
        },
        {
          "icon": "◆",
          "name": "直読み（1本）",
          "path": "/rsc-db"
        },
        {
          "icon": "①",
          "name": "ケースA 直接対応",
          "path": "/lin-a",
          "current": true
        },
        {
          "icon": "③",
          "name": "ケースC 値の加工",
          "path": "/lin-c"
        },
        {
          "icon": "✕",
          "name": "ケースG 否定例",
          "path": "/lin-g"
        }
      ]
    },
    "instrumentation": {
      "method": "方式2 NODE_OPTIONS=--require ＋ 呼び出し入口での呼び出しスタック記録 ＋ ビルド時の要素識別子注入 ＋ **ソースの静的解析による由来の推定**",
      "detail": "プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。表示値の由来は、TypeScript の AST と記号解決で参照の連鎖をたどり、**実行された SQL の SELECT 句**で列を解決した。参照の連鎖そのものは実行時に観測していないため、この関係は推定である",
      "bundler": "turbopack"
    },
    "droppedAttributeKeys": [
      "db.connection_string",
      "db.postgresql.idle.timeout.millis",
      "db.user",
      "http.flavor",
      "http.host",
      "http.scheme",
      "http.status_text",
      "http.url",
      "http.user_agent",
      "net.host.ip",
      "net.host.name",
      "net.host.port",
      "net.peer.ip",
      "net.peer.name",
      "net.peer.port",
      "net.transport",
      "next.clientComponentLoadCount",
      "next.span_category",
      "next.span_name"
    ],
    "notObserved": [
      {
        "what": "表示値と由来の列の値が一致すること",
        "why": "表示された値も取得した行も読んでいない（NFR-20）。一致の確認はできないし、一致は十分条件でもない（01b Q-04.0 #3）"
      },
      {
        "what": "参照の連鎖が実行時に本当にその通り通ったこと",
        "why": "ソースの形から推定している。条件分岐のどちらを通ったかは観測していない。この関係は構造的に L2 であり、いかなる実装でも昇格しない（02a 3.5.1）"
      },
      {
        "what": "カラムと応答項目の対応づけ（maps）",
        "why": "rsc-direct には応答（JSON）そのものが存在しない。対応づける相手のノードが無いため、関係を作らない"
      },
      {
        "what": "props の由来（derives）",
        "why": "derives はレスポンスのキーを始点とする関係である（02a 3.5.1）。rsc-direct にはレスポンスが無いため、この関係は構成できない。代わりに `supplies`（描いたコンポーネント → 取得を実行したコンポーネント）を静的解析の推定として提案している"
      },
      {
        "what": "解析範囲（src/）の外で作られる値の由来",
        "why": "ライブラリの内部まで追わない。追えないものは候補を出さない"
      },
      {
        "what": "コンポーネント単位のサーバー処理のスパン",
        "why": "Next.js の描画スパンはルート単位である（PoC-02 の実測）"
      },
      {
        "what": "SQL の取得件数（行数）",
        "why": "使用した計装が行数の属性を付けないため、取得できなかった"
      },
      {
        "what": "SQL のパラメータ値",
        "why": "方針として収集しない（NFR-20）。取得時点で除去している"
      },
      {
        "what": "本番ビルドでの由来の推定",
        "why": "ソースマップと要素識別子の注入に依存するため、開発ビルドに限る（01b Q-03 C-5）"
      }
    ],
    "excluded": {
      "staticAssetRequests": 16,
      "note": "静的資材（/_next/*・画像・フォント）は「通信」として数えていない"
    }
  },
  "page": {
    "path": "/lin-a",
    "name": "ケースA 由来を1列に絞れた",
    "startMs": 1793470303662.907
  },
  "focus": {
    "method": "GET",
    "path": "/lin-a"
  },
  "browserRequests": [
    {
      "method": "GET",
      "path": "/lin-a",
      "status": 200,
      "startMs": 1793470303662.907,
      "durationMs": 25.41,
      "server": {
        "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
        "spanId": "292b2d42844d1592"
      },
      "isDocument": true,
      "browserRequestId": "7C41045E469ECB2080BF2E906CDF35CF",
      "via": "dedicated-header",
      "headersAgree": true,
      "readHeaderKeys": [
        "server-timing",
        "x-vcide-trace"
      ],
      "failure": null,
      "hasQuery": false,
      "crossOrigin": null,
      "initiator": {
        "type": "other",
        "frameCount": 0,
        "frame": null,
        "verified": false,
        "sourceLine": null,
        "component": null,
        "failure": {
          "reason": "no-script-stack",
          "detail": "initiator.type=other"
        }
      }
    }
  ],
  "spans": [
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "292b2d42844d1592",
      "parentSpanId": null,
      "name": "GET",
      "kind": 1,
      "startMs": 1793470303664,
      "endMs": 1793470303688.2227,
      "durationMs": 24.222667,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-http",
      "attrs": {
        "http.method": "GET",
        "http.target": "/lin-a",
        "http.status_code": 200
      },
      "droppedAttributeKeys": [
        "http.url",
        "http.host",
        "net.host.name",
        "http.scheme",
        "http.user_agent",
        "http.flavor",
        "net.transport",
        "net.host.ip",
        "net.host.port",
        "net.peer.ip",
        "net.peer.port",
        "http.status_text"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "92b21a7bfbcb3fb3",
      "parentSpanId": "1f8691f6b0a8c60b",
      "name": "load route module",
      "kind": 0,
      "startMs": 1793470303666,
      "endMs": 1793470303666.4346,
      "durationMs": 0.434667,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "LoadComponents.loadRouteModule"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "1f8691f6b0a8c60b",
      "parentSpanId": "4e673d87aa81b08a",
      "name": "LoadComponents.loadComponents",
      "kind": 0,
      "startMs": 1793470303666,
      "endMs": 1793470303666.846,
      "durationMs": 0.846042,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "LoadComponents.loadComponents"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "4e673d87aa81b08a",
      "parentSpanId": "2c150c06a1d98596",
      "name": "resolve page components",
      "kind": 0,
      "startMs": 1793470303666,
      "endMs": 1793470303666.9607,
      "durationMs": 0.960625,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.findPageComponents",
        "next.route": "/lin-a"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "2c150c06a1d98596",
      "parentSpanId": "69fb328546c1e1a3",
      "name": "rendering page",
      "kind": 0,
      "startMs": 1793470303666,
      "endMs": 1793470303688.0286,
      "durationMs": 22.0285,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.renderToResponse",
        "next.route": "/lin-a"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "69fb328546c1e1a3",
      "parentSpanId": "d58621b7fed15def",
      "name": "BaseServer.pipe",
      "kind": 0,
      "startMs": 1793470303666,
      "endMs": 1793470303688.0728,
      "durationMs": 22.07275,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.pipe"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "d58621b7fed15def",
      "parentSpanId": "d2dd5db2dc98b9d7",
      "name": "BaseServer.render",
      "kind": 0,
      "startMs": 1793470303666,
      "endMs": 1793470303688.1204,
      "durationMs": 22.120375,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.render"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "d2dd5db2dc98b9d7",
      "parentSpanId": "ee456e70e5e4ceb3",
      "name": "GET",
      "kind": 1,
      "startMs": 1793470303666,
      "endMs": 1793470303688.4058,
      "durationMs": 22.405667,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.handleRequest",
        "http.method": "GET",
        "http.target": "/lin-a",
        "http.status_code": 200,
        "next.rsc": false
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "ee456e70e5e4ceb3",
      "parentSpanId": "843b90685232b6f8",
      "name": "NextServer.getServerRequestHandler",
      "kind": 0,
      "startMs": 1793470303666,
      "endMs": 1793470303688.536,
      "durationMs": 22.535959,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextServer.getServerRequestHandler"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "843b90685232b6f8",
      "parentSpanId": "292b2d42844d1592",
      "name": "NextServer.getRequestHandler",
      "kind": 0,
      "startMs": 1793470303666,
      "endMs": 1793470303688.5962,
      "durationMs": 22.596084,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextServer.getRequestHandler"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "00c50cd305a979fd",
      "parentSpanId": "2c150c06a1d98596",
      "name": "BaseServer.renderToResponseWithComponents",
      "kind": 0,
      "startMs": 1793470303667,
      "endMs": 1793470303687.7478,
      "durationMs": 20.747917,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.renderToResponseWithComponents",
        "http.status_code": 200,
        "next.rsc": false
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "95f8d6a7d4b7f778",
      "parentSpanId": "3b7e947cfd7c0d87",
      "name": "load route manifests",
      "kind": 0,
      "startMs": 1793470303668,
      "endMs": 1793470303669.5059,
      "durationMs": 1.505958,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "RouteModule.loadManifests"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "3b7e947cfd7c0d87",
      "parentSpanId": "00c50cd305a979fd",
      "name": "prepare route module",
      "kind": 0,
      "startMs": 1793470303668,
      "endMs": 1793470303669.9622,
      "durationMs": 1.962209,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "RouteModule.prepare"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "12445482411052bd",
      "parentSpanId": "5ee2c91a0db57933",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793470303671,
      "endMs": 1793470303671.0442,
      "durationMs": 0.044125,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.getLayoutOrPageModule",
        "next.segment": ""
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "f556b94c32ca7b0d",
      "parentSpanId": "5ee2c91a0db57933",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793470303671,
      "endMs": 1793470303671.0208,
      "durationMs": 0.02075,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.getLayoutOrPageModule",
        "next.segment": "__PAGE__"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "5ee2c91a0db57933",
      "parentSpanId": "190498b0ca87de0e",
      "name": "build component tree",
      "kind": 0,
      "startMs": 1793470303671,
      "endMs": 1793470303671.8464,
      "durationMs": 0.846375,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.createComponentTree"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "190498b0ca87de0e",
      "parentSpanId": "00c50cd305a979fd",
      "name": "render route (app) /lin-a",
      "kind": 0,
      "startMs": 1793470303671,
      "endMs": 1793470303685.7441,
      "durationMs": 14.744083,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.getBodyResult",
        "next.route": "/lin-a"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "dcded236bd727ca6",
      "parentSpanId": "190498b0ca87de0e",
      "name": "pg-pool.connect",
      "kind": 2,
      "startMs": 1793470303674,
      "endMs": 1793470303678.231,
      "durationMs": 4.230916,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-pg",
      "attrs": {
        "db.system": "postgresql",
        "db.name": "poc01"
      },
      "droppedAttributeKeys": [
        "db.postgresql.idle.timeout.millis",
        "db.connection_string",
        "net.peer.name",
        "net.peer.port",
        "db.user"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "3e951abe70cb9be6",
      "parentSpanId": "190498b0ca87de0e",
      "name": "pg.query:SELECT poc01",
      "kind": 2,
      "startMs": 1793470303678,
      "endMs": 1793470303682.4578,
      "durationMs": 4.457875,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-pg",
      "attrs": {
        "db.system": "postgresql",
        "db.name": "poc01",
        "db.statement": "SELECT id, region FROM poc.listings ORDER BY id LIMIT $0"
      },
      "droppedAttributeKeys": [
        "db.connection_string",
        "db.user",
        "net.peer.name",
        "net.peer.port"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "6d4b127c1aff51c5",
      "parentSpanId": "c616f710954cee47",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793470303679,
      "endMs": 1793470303679.0442,
      "durationMs": 0.044125,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.renderToReadableStream"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "519f384c823b3192",
      "parentSpanId": "c616f710954cee47",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793470303679,
      "endMs": 1793470303685.774,
      "durationMs": 6.773833,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.waitShellReady"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "c616f710954cee47",
      "parentSpanId": "190498b0ca87de0e",
      "name": "AppRender.renderToNodeFizzStream",
      "kind": 0,
      "startMs": 1793470303679,
      "endMs": 1793470303686.072,
      "durationMs": 7.072125,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.renderToNodeFizzStream"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "9c5f309f97dc4313",
      "parentSpanId": "00c50cd305a979fd",
      "name": "NextNodeServer.clientComponentLoading",
      "kind": 0,
      "startMs": 1793470303679.4905,
      "endMs": 1793470303682.8188,
      "durationMs": 3.328416,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.clientComponentLoading"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.clientComponentLoadCount"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "cbd6b9806f1de866",
      "parentSpanId": "190498b0ca87de0e",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793470303686,
      "endMs": 1793470303686.0276,
      "durationMs": 0.027542,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.renderToReadableStream"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "63a7eb8eab71474f",
      "parentSpanId": "190498b0ca87de0e",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793470303686,
      "endMs": 1793470303686.1006,
      "durationMs": 0.100667,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.waitShellReady"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "0c9003437fed55ee1a236cd2aa5dd59f",
      "spanId": "739e89dc79f44298",
      "parentSpanId": "190498b0ca87de0e",
      "name": "start response",
      "kind": 0,
      "startMs": 1793470303687,
      "endMs": 1793470303687.0059,
      "durationMs": 0.005875,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.startResponse"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    }
  ],
  "sqlAnalyses": [
    {
      "spanId": "3e951abe70cb9be6",
      "sql": "SELECT id, region FROM poc.listings ORDER BY id LIMIT $0",
      "redacted": {
        "strings": 0,
        "numbers": 1
      },
      "parseOk": true,
      "parseError": null,
      "tables": [
        {
          "schema": "poc",
          "name": "listings"
        }
      ],
      "projections": [
        {
          "schema": "poc",
          "table": "listings",
          "column": "id",
          "inferredQualifier": true
        },
        {
          "schema": "poc",
          "table": "listings",
          "column": "region",
          "inferredQualifier": true
        }
      ],
      "unresolved": [],
      "selectStar": false
    }
  ],
  "dbObjects": {
    "tables": [
      {
        "schema": "poc",
        "name": "listings",
        "rowEstimate": 12
      }
    ],
    "columns": [
      {
        "schema": "poc",
        "table": "listings",
        "column": "id",
        "dataType": "integer",
        "nullable": false,
        "position": 1
      },
      {
        "schema": "poc",
        "table": "listings",
        "column": "region",
        "dataType": "text",
        "nullable": false,
        "position": 3
      }
    ]
  },
  "elements": {
    "method": "方式1 ビルド時の要素識別子注入（JSX へ data-vcide を挿入）",
    "bundler": "turbopack",
    "injectedScope": "src/",
    "transform": "挿入のみ。再出力しないため行番号はずれない。ソースマップに依存しない",
    "page": "/lin-a",
    "anchoredElements": 6,
    "totalElements": 37,
    "primaryKey": "a-region",
    "selections": [
      {
        "key": "a-region",
        "selector": "[data-poc-field=\"a-region\"]",
        "ordinal": 0,
        "group": "poc04",
        "primary": true,
        "tag": "li",
        "anchorOnSelf": "338818c651",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "2020d1f931",
          "41d7792a01"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 5,
          "cls": "cjk"
        },
        "failure": null
      }
    ],
    "anchors": [
      {
        "id": "338818c651",
        "tag": "li",
        "file": "src/app/lin-a/page.tsx",
        "line": 18,
        "col": 11,
        "component": "LinA",
        "componentLine": 11,
        "verified": true,
        "sourceLine": "<li key={row.id} data-poc-field=\"a-region\">{row.region}</li>"
      }
    ],
    "files": [
      {
        "file": "src/app/lin-c/page.tsx",
        "anchors": 5,
        "usages": 0,
        "skipped": []
      },
      {
        "file": "src/app/layout.tsx",
        "anchors": 0,
        "usages": 0,
        "skipped": [
          {
            "tag": "html",
            "file": "src/app/layout.tsx",
            "line": 5,
            "why": "framework-owned-element"
          },
          {
            "tag": "body",
            "file": "src/app/layout.tsx",
            "line": 6,
            "why": "framework-owned-element"
          }
        ]
      },
      {
        "file": "src/app/lin-g/page.tsx",
        "anchors": 6,
        "usages": 0,
        "skipped": []
      },
      {
        "file": "src/app/lin-a/page.tsx",
        "anchors": 4,
        "usages": 0,
        "skipped": []
      }
    ]
  },
  "rsc": {
    "documentSpanId": "292b2d42844d1592",
    "renderSpanId": "190498b0ca87de0e",
    "renderRoute": "/lin-a",
    "renderSpanName": "render route (app) /lin-a",
    "sql": [
      {
        "spanId": "3e951abe70cb9be6",
        "depthFromRender": 1,
        "callsite": {
          "at": "pg-pool.Pool.query",
          "frame": {
            "file": "src/app/lin-a/page.tsx",
            "line": 12,
            "col": 24,
            "functionName": "LinA"
          },
          "verified": true,
          "sourceLine": "const r = await pool.query('SELECT id, region FROM poc.listings ORDER BY id LIMIT 3');",
          "component": {
            "name": "LinA",
            "file": "src/app/lin-a/page.tsx",
            "line": 11,
            "endLine": 23
          },
          "appFrameAtSpanStart": false,
          "failure": null
        }
      }
    ],
    "exchanges": [],
    "browserApiRequests": 0,
    "overlaps": [],
    "propagation": {
      "mode": "off",
      "method": "サーバー内部の通信はこの題材に無い（DB アクセスは HTTP を経由しない）",
      "scope": "—"
    },
    "services": [
      {
        "name": "poc01-fixture-app",
        "role": "app",
        "origin": "http://localhost:3200"
      }
    ]
  },
  "lineage": {
    "method": "TypeScript Compiler API（AST ＋ 記号解決によるスコープ解決）。参照の連鎖（分解束縛・別名・props の受け渡し・反復）を前向きにたどる。値の一致・実行時刻・SQL 文の一致・ソース上の SQL リテラルは使わない",
    "scope": "src/",
    "site": {
      "file": "src/app/lin-a/page.tsx",
      "line": 18,
      "col": 54,
      "component": "LinA",
      "field": "a-region",
      "expr": "row.region"
    },
    "outcome": "confirmed",
    "candidates": [
      {
        "schema": "poc",
        "table": "listings",
        "column": "region",
        "via": "field",
        "note": null,
        "query": {
          "file": "src/app/lin-a/page.tsx",
          "line": 12
        },
        "trail": [
          "pool.query(…) の結果（src/app/lin-a/page.tsx:12）",
          ".rows を参照",
          "r.rows.map の要素（src/app/lin-a/page.tsx:17）",
          ".region を参照"
        ]
      }
    ],
    "tableCandidates": [],
    "transformed": false,
    "literalPaths": 0,
    "untracked": [],
    "unresolved": [],
    "reasons": [
      "参照の連鎖が1列に決まり、加工も分岐も無い"
    ],
    "sqlSpanIds": [
      "3e951abe70cb9be6"
    ]
  }
} as const;

export const LIN_C_OBSERVATION: ObservationBundle = {
  "meta": {
    "poc": "PoC-04",
    "collectedAt": "2026-10-31T18:11:56Z",
    "app": {
      "name": "PoC Fixture App",
      "port": 3200,
      "framework": "Next.js 16.4.3 (App Router)",
      "orm": [
        "Prisma 6.19.3",
        "pg 8.23.1"
      ],
      "pages": [
        {
          "icon": "⌂",
          "name": "ホーム",
          "path": "/"
        },
        {
          "icon": "▣",
          "name": "物件一覧",
          "path": "/listings"
        },
        {
          "icon": "◆",
          "name": "直読み（1本）",
          "path": "/rsc-db"
        },
        {
          "icon": "①",
          "name": "ケースA 直接対応",
          "path": "/lin-a"
        },
        {
          "icon": "③",
          "name": "ケースC 値の加工",
          "path": "/lin-c",
          "current": true
        },
        {
          "icon": "✕",
          "name": "ケースG 否定例",
          "path": "/lin-g"
        }
      ]
    },
    "instrumentation": {
      "method": "方式2 NODE_OPTIONS=--require ＋ 呼び出し入口での呼び出しスタック記録 ＋ ビルド時の要素識別子注入 ＋ **ソースの静的解析による由来の推定**",
      "detail": "プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。表示値の由来は、TypeScript の AST と記号解決で参照の連鎖をたどり、**実行された SQL の SELECT 句**で列を解決した。参照の連鎖そのものは実行時に観測していないため、この関係は推定である",
      "bundler": "turbopack"
    },
    "droppedAttributeKeys": [
      "db.connection_string",
      "db.postgresql.idle.timeout.millis",
      "db.user",
      "http.flavor",
      "http.host",
      "http.scheme",
      "http.status_text",
      "http.url",
      "http.user_agent",
      "net.host.ip",
      "net.host.name",
      "net.host.port",
      "net.peer.ip",
      "net.peer.name",
      "net.peer.port",
      "net.transport",
      "next.clientComponentLoadCount",
      "next.span_category",
      "next.span_name"
    ],
    "notObserved": [
      {
        "what": "表示値と由来の列の値が一致すること",
        "why": "表示された値も取得した行も読んでいない（NFR-20）。一致の確認はできないし、一致は十分条件でもない（01b Q-04.0 #3）"
      },
      {
        "what": "参照の連鎖が実行時に本当にその通り通ったこと",
        "why": "ソースの形から推定している。条件分岐のどちらを通ったかは観測していない。この関係は構造的に L2 であり、いかなる実装でも昇格しない（02a 3.5.1）"
      },
      {
        "what": "カラムと応答項目の対応づけ（maps）",
        "why": "rsc-direct には応答（JSON）そのものが存在しない。対応づける相手のノードが無いため、関係を作らない"
      },
      {
        "what": "props の由来（derives）",
        "why": "derives はレスポンスのキーを始点とする関係である（02a 3.5.1）。rsc-direct にはレスポンスが無いため、この関係は構成できない。代わりに `supplies`（描いたコンポーネント → 取得を実行したコンポーネント）を静的解析の推定として提案している"
      },
      {
        "what": "解析範囲（src/）の外で作られる値の由来",
        "why": "ライブラリの内部まで追わない。追えないものは候補を出さない"
      },
      {
        "what": "コンポーネント単位のサーバー処理のスパン",
        "why": "Next.js の描画スパンはルート単位である（PoC-02 の実測）"
      },
      {
        "what": "SQL の取得件数（行数）",
        "why": "使用した計装が行数の属性を付けないため、取得できなかった"
      },
      {
        "what": "SQL のパラメータ値",
        "why": "方針として収集しない（NFR-20）。取得時点で除去している"
      },
      {
        "what": "本番ビルドでの由来の推定",
        "why": "ソースマップと要素識別子の注入に依存するため、開発ビルドに限る（01b Q-03 C-5）"
      }
    ],
    "excluded": {
      "staticAssetRequests": 16,
      "note": "静的資材（/_next/*・画像・フォント）は「通信」として数えていない"
    }
  },
  "page": {
    "path": "/lin-c",
    "name": "ケースC 候補が複数のまま",
    "startMs": 1793470306541.3188
  },
  "focus": {
    "method": "GET",
    "path": "/lin-c"
  },
  "browserRequests": [
    {
      "method": "GET",
      "path": "/lin-c",
      "status": 200,
      "startMs": 1793470306541.3188,
      "durationMs": 47.12,
      "server": {
        "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
        "spanId": "696c78c67e24e2dd"
      },
      "isDocument": true,
      "browserRequestId": "E2F6BFFC389E7D8F998D6396181C3435",
      "via": "dedicated-header",
      "headersAgree": true,
      "readHeaderKeys": [
        "server-timing",
        "x-vcide-trace"
      ],
      "failure": null,
      "hasQuery": false,
      "crossOrigin": null,
      "initiator": {
        "type": "other",
        "frameCount": 0,
        "frame": null,
        "verified": false,
        "sourceLine": null,
        "component": null,
        "failure": {
          "reason": "no-script-stack",
          "detail": "initiator.type=other"
        }
      }
    }
  ],
  "spans": [
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "696c78c67e24e2dd",
      "parentSpanId": null,
      "name": "GET",
      "kind": 1,
      "startMs": 1793470306542,
      "endMs": 1793470306587.919,
      "durationMs": 45.918833,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-http",
      "attrs": {
        "http.method": "GET",
        "http.target": "/lin-c",
        "http.status_code": 200
      },
      "droppedAttributeKeys": [
        "http.url",
        "http.host",
        "net.host.name",
        "http.scheme",
        "http.user_agent",
        "http.flavor",
        "net.transport",
        "net.host.ip",
        "net.host.port",
        "net.peer.ip",
        "net.peer.port",
        "http.status_text"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "a2993705f508ae2a",
      "parentSpanId": "62c35dae42d14630",
      "name": "NextServer.getServerRequestHandler",
      "kind": 0,
      "startMs": 1793470306564,
      "endMs": 1793470306588.7593,
      "durationMs": 24.759375,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextServer.getServerRequestHandler"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "62c35dae42d14630",
      "parentSpanId": "696c78c67e24e2dd",
      "name": "NextServer.getRequestHandler",
      "kind": 0,
      "startMs": 1793470306564,
      "endMs": 1793470306588.937,
      "durationMs": 24.937,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextServer.getRequestHandler"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "1088f411a7d49854",
      "parentSpanId": "857212799d410f7a",
      "name": "load route module",
      "kind": 0,
      "startMs": 1793470306565,
      "endMs": 1793470306565.1838,
      "durationMs": 0.183792,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "LoadComponents.loadRouteModule"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "857212799d410f7a",
      "parentSpanId": "1c96481ea56c3191",
      "name": "LoadComponents.loadComponents",
      "kind": 0,
      "startMs": 1793470306565,
      "endMs": 1793470306565.4102,
      "durationMs": 0.410208,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "LoadComponents.loadComponents"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "1c96481ea56c3191",
      "parentSpanId": "628be9757136f73a",
      "name": "resolve page components",
      "kind": 0,
      "startMs": 1793470306565,
      "endMs": 1793470306565.4744,
      "durationMs": 0.47425,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.findPageComponents",
        "next.route": "/lin-c"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "628be9757136f73a",
      "parentSpanId": "568dcf1a8e863a73",
      "name": "rendering page",
      "kind": 0,
      "startMs": 1793470306565,
      "endMs": 1793470306588.6833,
      "durationMs": 23.683375,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.renderToResponse",
        "next.route": "/lin-c"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "568dcf1a8e863a73",
      "parentSpanId": "3a3728b4e1dcb7d5",
      "name": "BaseServer.pipe",
      "kind": 0,
      "startMs": 1793470306565,
      "endMs": 1793470306588.7524,
      "durationMs": 23.752541,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.pipe"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "3a3728b4e1dcb7d5",
      "parentSpanId": "517bc20d31149b2a",
      "name": "BaseServer.render",
      "kind": 0,
      "startMs": 1793470306565,
      "endMs": 1793470306588.8794,
      "durationMs": 23.879458,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.render"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "517bc20d31149b2a",
      "parentSpanId": "a2993705f508ae2a",
      "name": "GET",
      "kind": 1,
      "startMs": 1793470306565,
      "endMs": 1793470306589.3777,
      "durationMs": 24.377583,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.handleRequest",
        "http.method": "GET",
        "http.target": "/lin-c",
        "http.status_code": 200,
        "next.rsc": false
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "d434f48e4da7568d",
      "parentSpanId": "4c66c93fdf62237c",
      "name": "load route manifests",
      "kind": 0,
      "startMs": 1793470306566,
      "endMs": 1793470306567.099,
      "durationMs": 1.099166,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "RouteModule.loadManifests"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "4c66c93fdf62237c",
      "parentSpanId": "fea1d4932d36cce8",
      "name": "prepare route module",
      "kind": 0,
      "startMs": 1793470306566,
      "endMs": 1793470306567.5337,
      "durationMs": 1.53375,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "RouteModule.prepare"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "fea1d4932d36cce8",
      "parentSpanId": "628be9757136f73a",
      "name": "BaseServer.renderToResponseWithComponents",
      "kind": 0,
      "startMs": 1793470306566,
      "endMs": 1793470306588.908,
      "durationMs": 22.908042,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.renderToResponseWithComponents",
        "http.status_code": 200,
        "next.rsc": false
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "729621d645c9d0f5",
      "parentSpanId": "fea1d4932d36cce8",
      "name": "render route (app) /lin-c",
      "kind": 0,
      "startMs": 1793470306568,
      "endMs": 1793470306584.1353,
      "durationMs": 16.135333,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.getBodyResult",
        "next.route": "/lin-c"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "0705de078713d59e",
      "parentSpanId": "4b8bc0f94f673282",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793470306569,
      "endMs": 1793470306569.0356,
      "durationMs": 0.035708,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.getLayoutOrPageModule",
        "next.segment": ""
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "e31eeec6c234b54c",
      "parentSpanId": "4b8bc0f94f673282",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793470306569,
      "endMs": 1793470306569.0164,
      "durationMs": 0.016459,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.getLayoutOrPageModule",
        "next.segment": "__PAGE__"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "4b8bc0f94f673282",
      "parentSpanId": "729621d645c9d0f5",
      "name": "build component tree",
      "kind": 0,
      "startMs": 1793470306569,
      "endMs": 1793470306570.445,
      "durationMs": 1.445,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.createComponentTree"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "b4d88f2b997de7df",
      "parentSpanId": "729621d645c9d0f5",
      "name": "pg-pool.connect",
      "kind": 2,
      "startMs": 1793470306573,
      "endMs": 1793470306577.8643,
      "durationMs": 4.864209,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-pg",
      "attrs": {
        "db.system": "postgresql",
        "db.name": "poc01"
      },
      "droppedAttributeKeys": [
        "db.postgresql.idle.timeout.millis",
        "db.connection_string",
        "net.peer.name",
        "net.peer.port",
        "db.user"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "269b5e59a0922c74",
      "parentSpanId": "b6132bbbbc5ebc8d",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793470306578,
      "endMs": 1793470306578.0715,
      "durationMs": 0.071541,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.renderToReadableStream"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "2755a0154cb7e1e5",
      "parentSpanId": "729621d645c9d0f5",
      "name": "pg.query:SELECT poc01",
      "kind": 2,
      "startMs": 1793470306578,
      "endMs": 1793470306582.5269,
      "durationMs": 4.526916,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-pg",
      "attrs": {
        "db.system": "postgresql",
        "db.name": "poc01",
        "db.statement": "SELECT id, code, region FROM poc.listings ORDER BY id LIMIT $0"
      },
      "droppedAttributeKeys": [
        "db.connection_string",
        "db.user",
        "net.peer.name",
        "net.peer.port"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "20bf3b4d8c1b7018",
      "parentSpanId": "b6132bbbbc5ebc8d",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793470306578,
      "endMs": 1793470306584.3274,
      "durationMs": 6.327375,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.waitShellReady"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "b6132bbbbc5ebc8d",
      "parentSpanId": "729621d645c9d0f5",
      "name": "AppRender.renderToNodeFizzStream",
      "kind": 0,
      "startMs": 1793470306578,
      "endMs": 1793470306585.0813,
      "durationMs": 7.081291,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.renderToNodeFizzStream"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "07d89756d95d36a5",
      "parentSpanId": "fea1d4932d36cce8",
      "name": "NextNodeServer.clientComponentLoading",
      "kind": 0,
      "startMs": 1793470306578.8435,
      "endMs": 1793470306582.342,
      "durationMs": 3.498667,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.clientComponentLoading"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.clientComponentLoadCount"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "255557f769e06f2b",
      "parentSpanId": "729621d645c9d0f5",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793470306586,
      "endMs": 1793470306586.036,
      "durationMs": 0.035917,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.renderToReadableStream"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "e2fa1d5c38d17767",
      "parentSpanId": "729621d645c9d0f5",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793470306586,
      "endMs": 1793470306586.116,
      "durationMs": 0.116,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.waitShellReady"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "c22a83aa4c4bbde08ddf4407381f0df3",
      "spanId": "9956628619532d71",
      "parentSpanId": "729621d645c9d0f5",
      "name": "start response",
      "kind": 0,
      "startMs": 1793470306587,
      "endMs": 1793470306587.0059,
      "durationMs": 0.005834,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.startResponse"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    }
  ],
  "sqlAnalyses": [
    {
      "spanId": "2755a0154cb7e1e5",
      "sql": "SELECT id, code, region FROM poc.listings ORDER BY id LIMIT $0",
      "redacted": {
        "strings": 0,
        "numbers": 1
      },
      "parseOk": true,
      "parseError": null,
      "tables": [
        {
          "schema": "poc",
          "name": "listings"
        }
      ],
      "projections": [
        {
          "schema": "poc",
          "table": "listings",
          "column": "id",
          "inferredQualifier": true
        },
        {
          "schema": "poc",
          "table": "listings",
          "column": "code",
          "inferredQualifier": true
        },
        {
          "schema": "poc",
          "table": "listings",
          "column": "region",
          "inferredQualifier": true
        }
      ],
      "unresolved": [],
      "selectStar": false
    }
  ],
  "dbObjects": {
    "tables": [
      {
        "schema": "poc",
        "name": "listings",
        "rowEstimate": 12
      }
    ],
    "columns": [
      {
        "schema": "poc",
        "table": "listings",
        "column": "id",
        "dataType": "integer",
        "nullable": false,
        "position": 1
      },
      {
        "schema": "poc",
        "table": "listings",
        "column": "code",
        "dataType": "text",
        "nullable": false,
        "position": 2
      },
      {
        "schema": "poc",
        "table": "listings",
        "column": "region",
        "dataType": "text",
        "nullable": false,
        "position": 3
      }
    ]
  },
  "elements": {
    "method": "方式1 ビルド時の要素識別子注入（JSX へ data-vcide を挿入）",
    "bundler": "turbopack",
    "injectedScope": "src/",
    "transform": "挿入のみ。再出力しないため行番号はずれない。ソースマップに依存しない",
    "page": "/lin-c",
    "anchoredElements": 5,
    "totalElements": 36,
    "primaryKey": "c-title",
    "selections": [
      {
        "key": "c-title",
        "selector": "[data-poc-field=\"c-title\"]",
        "ordinal": 0,
        "group": "poc04",
        "primary": true,
        "tag": "p",
        "anchorOnSelf": "40accde92e",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [
          "b925c395c9"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 17,
          "cls": "mixed"
        },
        "failure": null
      }
    ],
    "anchors": [
      {
        "id": "40accde92e",
        "tag": "p",
        "file": "src/app/lin-c/page.tsx",
        "line": 20,
        "col": 7,
        "component": "LinC",
        "componentLine": 12,
        "verified": true,
        "sourceLine": "<p data-poc-field=\"c-title\">{title}</p>"
      }
    ],
    "files": [
      {
        "file": "src/app/lin-c/page.tsx",
        "anchors": 5,
        "usages": 0,
        "skipped": []
      },
      {
        "file": "src/app/layout.tsx",
        "anchors": 0,
        "usages": 0,
        "skipped": [
          {
            "tag": "html",
            "file": "src/app/layout.tsx",
            "line": 5,
            "why": "framework-owned-element"
          },
          {
            "tag": "body",
            "file": "src/app/layout.tsx",
            "line": 6,
            "why": "framework-owned-element"
          }
        ]
      },
      {
        "file": "src/app/lin-g/page.tsx",
        "anchors": 6,
        "usages": 0,
        "skipped": []
      },
      {
        "file": "src/app/lin-a/page.tsx",
        "anchors": 4,
        "usages": 0,
        "skipped": []
      }
    ]
  },
  "rsc": {
    "documentSpanId": "696c78c67e24e2dd",
    "renderSpanId": "729621d645c9d0f5",
    "renderRoute": "/lin-c",
    "renderSpanName": "render route (app) /lin-c",
    "sql": [
      {
        "spanId": "2755a0154cb7e1e5",
        "depthFromRender": 1,
        "callsite": {
          "at": "pg-pool.Pool.query",
          "frame": {
            "file": "src/app/lin-c/page.tsx",
            "line": 13,
            "col": 24,
            "functionName": "LinC"
          },
          "verified": true,
          "sourceLine": "const r = await pool.query('SELECT id, code, region FROM poc.listings ORDER BY id LIMIT 2');",
          "component": {
            "name": "LinC",
            "file": "src/app/lin-c/page.tsx",
            "line": 12,
            "endLine": 25
          },
          "appFrameAtSpanStart": false,
          "failure": null
        }
      }
    ],
    "exchanges": [],
    "browserApiRequests": 0,
    "overlaps": [],
    "propagation": {
      "mode": "off",
      "method": "サーバー内部の通信はこの題材に無い（DB アクセスは HTTP を経由しない）",
      "scope": "—"
    },
    "services": [
      {
        "name": "poc01-fixture-app",
        "role": "app",
        "origin": "http://localhost:3200"
      }
    ]
  },
  "lineage": {
    "method": "TypeScript Compiler API（AST ＋ 記号解決によるスコープ解決）。参照の連鎖（分解束縛・別名・props の受け渡し・反復）を前向きにたどる。値の一致・実行時刻・SQL 文の一致・ソース上の SQL リテラルは使わない",
    "scope": "src/",
    "site": {
      "file": "src/app/lin-c/page.tsx",
      "line": 20,
      "col": 35,
      "component": "LinC",
      "field": "c-title",
      "expr": "title"
    },
    "outcome": "candidates",
    "candidates": [
      {
        "schema": "poc",
        "table": "listings",
        "column": "region",
        "via": "field",
        "note": null,
        "query": {
          "file": "src/app/lin-c/page.tsx",
          "line": 13
        },
        "trail": [
          "pool.query(…) の結果（src/app/lin-c/page.tsx:13）",
          ".rows を参照",
          "[0] を参照",
          ".region を参照"
        ]
      },
      {
        "schema": "poc",
        "table": "listings",
        "column": "code",
        "via": "field",
        "note": null,
        "query": {
          "file": "src/app/lin-c/page.tsx",
          "line": 13
        },
        "trail": [
          "pool.query(…) の結果（src/app/lin-c/page.tsx:13）",
          ".rows を参照",
          "[0] を参照",
          ".code を参照"
        ]
      }
    ],
    "tableCandidates": [],
    "transformed": true,
    "literalPaths": 0,
    "untracked": [],
    "unresolved": [],
    "reasons": [
      "候補が 2 件ある",
      "加工（連結・変換）を通っている"
    ],
    "sqlSpanIds": [
      "2755a0154cb7e1e5"
    ]
  }
} as const;

export const LIN_G_OBSERVATION: ObservationBundle = {
  "meta": {
    "poc": "PoC-04",
    "collectedAt": "2026-10-31T18:11:56Z",
    "app": {
      "name": "PoC Fixture App",
      "port": 3200,
      "framework": "Next.js 16.4.3 (App Router)",
      "orm": [
        "Prisma 6.19.3",
        "pg 8.23.1"
      ],
      "pages": [
        {
          "icon": "⌂",
          "name": "ホーム",
          "path": "/"
        },
        {
          "icon": "▣",
          "name": "物件一覧",
          "path": "/listings"
        },
        {
          "icon": "◆",
          "name": "直読み（1本）",
          "path": "/rsc-db"
        },
        {
          "icon": "①",
          "name": "ケースA 直接対応",
          "path": "/lin-a"
        },
        {
          "icon": "③",
          "name": "ケースC 値の加工",
          "path": "/lin-c"
        },
        {
          "icon": "✕",
          "name": "ケースG 否定例",
          "path": "/lin-g",
          "current": true
        }
      ]
    },
    "instrumentation": {
      "method": "方式2 NODE_OPTIONS=--require ＋ 呼び出し入口での呼び出しスタック記録 ＋ ビルド時の要素識別子注入 ＋ **ソースの静的解析による由来の推定**",
      "detail": "プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。表示値の由来は、TypeScript の AST と記号解決で参照の連鎖をたどり、**実行された SQL の SELECT 句**で列を解決した。参照の連鎖そのものは実行時に観測していないため、この関係は推定である",
      "bundler": "turbopack"
    },
    "droppedAttributeKeys": [
      "db.connection_string",
      "db.postgresql.idle.timeout.millis",
      "db.user",
      "http.flavor",
      "http.host",
      "http.scheme",
      "http.status_text",
      "http.url",
      "http.user_agent",
      "net.host.ip",
      "net.host.name",
      "net.host.port",
      "net.peer.ip",
      "net.peer.name",
      "net.peer.port",
      "net.transport",
      "next.clientComponentLoadCount",
      "next.span_category",
      "next.span_name"
    ],
    "notObserved": [
      {
        "what": "表示値と由来の列の値が一致すること",
        "why": "表示された値も取得した行も読んでいない（NFR-20）。一致の確認はできないし、一致は十分条件でもない（01b Q-04.0 #3）"
      },
      {
        "what": "参照の連鎖が実行時に本当にその通り通ったこと",
        "why": "ソースの形から推定している。条件分岐のどちらを通ったかは観測していない。この関係は構造的に L2 であり、いかなる実装でも昇格しない（02a 3.5.1）"
      },
      {
        "what": "カラムと応答項目の対応づけ（maps）",
        "why": "rsc-direct には応答（JSON）そのものが存在しない。対応づける相手のノードが無いため、関係を作らない"
      },
      {
        "what": "props の由来（derives）",
        "why": "derives はレスポンスのキーを始点とする関係である（02a 3.5.1）。rsc-direct にはレスポンスが無いため、この関係は構成できない。代わりに `supplies`（描いたコンポーネント → 取得を実行したコンポーネント）を静的解析の推定として提案している"
      },
      {
        "what": "解析範囲（src/）の外で作られる値の由来",
        "why": "ライブラリの内部まで追わない。追えないものは候補を出さない"
      },
      {
        "what": "コンポーネント単位のサーバー処理のスパン",
        "why": "Next.js の描画スパンはルート単位である（PoC-02 の実測）"
      },
      {
        "what": "SQL の取得件数（行数）",
        "why": "使用した計装が行数の属性を付けないため、取得できなかった"
      },
      {
        "what": "SQL のパラメータ値",
        "why": "方針として収集しない（NFR-20）。取得時点で除去している"
      },
      {
        "what": "本番ビルドでの由来の推定",
        "why": "ソースマップと要素識別子の注入に依存するため、開発ビルドに限る（01b Q-03 C-5）"
      }
    ],
    "excluded": {
      "staticAssetRequests": 16,
      "note": "静的資材（/_next/*・画像・フォント）は「通信」として数えていない"
    }
  },
  "page": {
    "path": "/lin-g",
    "name": "ケースG 由来を作らない",
    "startMs": 1793470309435.046
  },
  "focus": {
    "method": "GET",
    "path": "/lin-g"
  },
  "browserRequests": [
    {
      "method": "GET",
      "path": "/lin-g",
      "status": 200,
      "startMs": 1793470309435.046,
      "durationMs": 32.68,
      "server": {
        "traceId": "bd83052fa99bec1236632a443e62cd43",
        "spanId": "37411b6e1d11b866"
      },
      "isDocument": true,
      "browserRequestId": "15BA352ED7DE3D3E9FA5D2A63D4BE691",
      "via": "dedicated-header",
      "headersAgree": true,
      "readHeaderKeys": [
        "server-timing",
        "x-vcide-trace"
      ],
      "failure": null,
      "hasQuery": false,
      "crossOrigin": null,
      "initiator": {
        "type": "other",
        "frameCount": 0,
        "frame": null,
        "verified": false,
        "sourceLine": null,
        "component": null,
        "failure": {
          "reason": "no-script-stack",
          "detail": "initiator.type=other"
        }
      }
    }
  ],
  "spans": [
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "37411b6e1d11b866",
      "parentSpanId": null,
      "name": "GET",
      "kind": 1,
      "startMs": 1793470309435,
      "endMs": 1793470309467.0168,
      "durationMs": 32.016834,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-http",
      "attrs": {
        "http.method": "GET",
        "http.target": "/lin-g",
        "http.status_code": 200
      },
      "droppedAttributeKeys": [
        "http.url",
        "http.host",
        "net.host.name",
        "http.scheme",
        "http.user_agent",
        "http.flavor",
        "net.transport",
        "net.host.ip",
        "net.host.port",
        "net.peer.ip",
        "net.peer.port",
        "http.status_text"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "e799c2880de40d7c",
      "parentSpanId": "37411b6e1d11b866",
      "name": "NextServer.getRequestHandler",
      "kind": 0,
      "startMs": 1793470309446,
      "endMs": 1793470309467.8064,
      "durationMs": 21.806375,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextServer.getRequestHandler"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "a46d910a0ded5b83",
      "parentSpanId": "493c2bed6868c75b",
      "name": "rendering page",
      "kind": 0,
      "startMs": 1793470309447,
      "endMs": 1793470309467.6125,
      "durationMs": 20.6125,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.renderToResponse",
        "next.route": "/lin-g"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "493c2bed6868c75b",
      "parentSpanId": "33054e3e8cfbe438",
      "name": "BaseServer.pipe",
      "kind": 0,
      "startMs": 1793470309447,
      "endMs": 1793470309467.721,
      "durationMs": 20.720834,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.pipe"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "33054e3e8cfbe438",
      "parentSpanId": "8fb7ee42a3cb5a45",
      "name": "BaseServer.render",
      "kind": 0,
      "startMs": 1793470309447,
      "endMs": 1793470309467.8667,
      "durationMs": 20.866792,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.render"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "8fb7ee42a3cb5a45",
      "parentSpanId": "a0544e940ecd8d46",
      "name": "GET",
      "kind": 1,
      "startMs": 1793470309447,
      "endMs": 1793470309468.4011,
      "durationMs": 21.401083,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.handleRequest",
        "http.method": "GET",
        "http.target": "/lin-g",
        "http.status_code": 200,
        "next.rsc": false
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "a0544e940ecd8d46",
      "parentSpanId": "e799c2880de40d7c",
      "name": "NextServer.getServerRequestHandler",
      "kind": 0,
      "startMs": 1793470309447,
      "endMs": 1793470309468.6921,
      "durationMs": 21.692083,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextServer.getServerRequestHandler"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "0252153ea31ae59a",
      "parentSpanId": "f103b3496c131fa8",
      "name": "load route module",
      "kind": 0,
      "startMs": 1793470309448,
      "endMs": 1793470309448.2463,
      "durationMs": 0.246333,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "LoadComponents.loadRouteModule"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "f103b3496c131fa8",
      "parentSpanId": "1ce0616a496db0b0",
      "name": "LoadComponents.loadComponents",
      "kind": 0,
      "startMs": 1793470309448,
      "endMs": 1793470309448.4956,
      "durationMs": 0.495667,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "LoadComponents.loadComponents"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "1ce0616a496db0b0",
      "parentSpanId": "a46d910a0ded5b83",
      "name": "resolve page components",
      "kind": 0,
      "startMs": 1793470309448,
      "endMs": 1793470309448.5654,
      "durationMs": 0.565458,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.findPageComponents",
        "next.route": "/lin-g"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "69f2539f87ef1bf7",
      "parentSpanId": "b3c8be76159ffccd",
      "name": "load route manifests",
      "kind": 0,
      "startMs": 1793470309448,
      "endMs": 1793470309448.9043,
      "durationMs": 0.90425,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "RouteModule.loadManifests"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "b3c8be76159ffccd",
      "parentSpanId": "484599d2c0d76657",
      "name": "prepare route module",
      "kind": 0,
      "startMs": 1793470309448,
      "endMs": 1793470309449.1409,
      "durationMs": 1.140958,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "RouteModule.prepare"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "484599d2c0d76657",
      "parentSpanId": "a46d910a0ded5b83",
      "name": "BaseServer.renderToResponseWithComponents",
      "kind": 0,
      "startMs": 1793470309448,
      "endMs": 1793470309467.5854,
      "durationMs": 19.585458,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.renderToResponseWithComponents",
        "http.status_code": 200,
        "next.rsc": false
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "110953c14c723929",
      "parentSpanId": "383eb62cc9a8f713",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793470309450,
      "endMs": 1793470309450.0264,
      "durationMs": 0.026292,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.getLayoutOrPageModule",
        "next.segment": ""
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "fc0e894203a49f67",
      "parentSpanId": "383eb62cc9a8f713",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793470309450,
      "endMs": 1793470309450.0154,
      "durationMs": 0.015333,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.getLayoutOrPageModule",
        "next.segment": "__PAGE__"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "383eb62cc9a8f713",
      "parentSpanId": "5673057078793153",
      "name": "build component tree",
      "kind": 0,
      "startMs": 1793470309450,
      "endMs": 1793470309450.6921,
      "durationMs": 0.692167,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.createComponentTree"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "5673057078793153",
      "parentSpanId": "484599d2c0d76657",
      "name": "render route (app) /lin-g",
      "kind": 0,
      "startMs": 1793470309450,
      "endMs": 1793470309464.6614,
      "durationMs": 14.661334,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.getBodyResult",
        "next.route": "/lin-g"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "e5e4fc342f743f92",
      "parentSpanId": "5673057078793153",
      "name": "pg-pool.connect",
      "kind": 2,
      "startMs": 1793470309453,
      "endMs": 1793470309457.079,
      "durationMs": 4.079208,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-pg",
      "attrs": {
        "db.system": "postgresql",
        "db.name": "poc01"
      },
      "droppedAttributeKeys": [
        "db.postgresql.idle.timeout.millis",
        "db.connection_string",
        "net.peer.name",
        "net.peer.port",
        "db.user"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "e07d225501b26b9d",
      "parentSpanId": "5673057078793153",
      "name": "pg.query:SELECT poc01",
      "kind": 2,
      "startMs": 1793470309457,
      "endMs": 1793470309462.4944,
      "durationMs": 5.494417,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-pg",
      "attrs": {
        "db.system": "postgresql",
        "db.name": "poc01",
        "db.statement": "SELECT code, region FROM poc.listings ORDER BY id LIMIT $0"
      },
      "droppedAttributeKeys": [
        "db.connection_string",
        "db.user",
        "net.peer.name",
        "net.peer.port"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "ea91301eea6fb6d4",
      "parentSpanId": "8f71aadd6ab031c8",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793470309459,
      "endMs": 1793470309459.0469,
      "durationMs": 0.046792,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.renderToReadableStream"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "ba05bd756c4b3678",
      "parentSpanId": "8f71aadd6ab031c8",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793470309459,
      "endMs": 1793470309465.0432,
      "durationMs": 6.043166,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.waitShellReady"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "8f71aadd6ab031c8",
      "parentSpanId": "5673057078793153",
      "name": "AppRender.renderToNodeFizzStream",
      "kind": 0,
      "startMs": 1793470309459,
      "endMs": 1793470309465.3088,
      "durationMs": 6.30875,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.renderToNodeFizzStream"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "8fa564b36a875912",
      "parentSpanId": "484599d2c0d76657",
      "name": "NextNodeServer.clientComponentLoading",
      "kind": 0,
      "startMs": 1793470309459.1316,
      "endMs": 1793470309462.4583,
      "durationMs": 3.326834,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.clientComponentLoading"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.clientComponentLoadCount"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "f6e610278e79ee24",
      "parentSpanId": "5673057078793153",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793470309465,
      "endMs": 1793470309465.022,
      "durationMs": 0.022,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.renderToReadableStream"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "5d56924b73ae8541",
      "parentSpanId": "5673057078793153",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793470309466,
      "endMs": 1793470309466.093,
      "durationMs": 0.093125,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.waitShellReady"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "bd83052fa99bec1236632a443e62cd43",
      "spanId": "45824ad6c5e823e7",
      "parentSpanId": "5673057078793153",
      "name": "start response",
      "kind": 0,
      "startMs": 1793470309466,
      "endMs": 1793470309466.006,
      "durationMs": 0.006208,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.startResponse"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    }
  ],
  "sqlAnalyses": [
    {
      "spanId": "e07d225501b26b9d",
      "sql": "SELECT code, region FROM poc.listings ORDER BY id LIMIT $0",
      "redacted": {
        "strings": 0,
        "numbers": 1
      },
      "parseOk": true,
      "parseError": null,
      "tables": [
        {
          "schema": "poc",
          "name": "listings"
        }
      ],
      "projections": [
        {
          "schema": "poc",
          "table": "listings",
          "column": "code",
          "inferredQualifier": true
        },
        {
          "schema": "poc",
          "table": "listings",
          "column": "region",
          "inferredQualifier": true
        }
      ],
      "unresolved": [
        {
          "column": "id",
          "why": "referenced-outside-select-list"
        }
      ],
      "selectStar": false
    }
  ],
  "dbObjects": {
    "tables": [
      {
        "schema": "poc",
        "name": "listings",
        "rowEstimate": 12
      }
    ],
    "columns": [
      {
        "schema": "poc",
        "table": "listings",
        "column": "code",
        "dataType": "text",
        "nullable": false,
        "position": 2
      },
      {
        "schema": "poc",
        "table": "listings",
        "column": "region",
        "dataType": "text",
        "nullable": false,
        "position": 3
      }
    ]
  },
  "elements": {
    "method": "方式1 ビルド時の要素識別子注入（JSX へ data-vcide を挿入）",
    "bundler": "turbopack",
    "injectedScope": "src/",
    "transform": "挿入のみ。再出力しないため行番号はずれない。ソースマップに依存しない",
    "page": "/lin-g",
    "anchoredElements": 6,
    "totalElements": 37,
    "primaryKey": "g-shadow",
    "selections": [
      {
        "key": "g-shadow",
        "selector": "[data-poc-field=\"g-shadow\"]",
        "ordinal": 0,
        "group": "poc04",
        "primary": true,
        "tag": "p",
        "anchorOnSelf": "35e8ddf4c6",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [
          "45bc75e937"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 9,
          "cls": "cjk"
        },
        "failure": null
      }
    ],
    "anchors": [
      {
        "id": "35e8ddf4c6",
        "tag": "p",
        "file": "src/app/lin-g/page.tsx",
        "line": 28,
        "col": 7,
        "component": "LinG",
        "componentLine": 18,
        "verified": true,
        "sourceLine": "<p data-poc-field=\"g-shadow\">{region}</p>"
      }
    ],
    "files": [
      {
        "file": "src/app/lin-c/page.tsx",
        "anchors": 5,
        "usages": 0,
        "skipped": []
      },
      {
        "file": "src/app/layout.tsx",
        "anchors": 0,
        "usages": 0,
        "skipped": [
          {
            "tag": "html",
            "file": "src/app/layout.tsx",
            "line": 5,
            "why": "framework-owned-element"
          },
          {
            "tag": "body",
            "file": "src/app/layout.tsx",
            "line": 6,
            "why": "framework-owned-element"
          }
        ]
      },
      {
        "file": "src/app/lin-g/page.tsx",
        "anchors": 6,
        "usages": 0,
        "skipped": []
      },
      {
        "file": "src/app/lin-a/page.tsx",
        "anchors": 4,
        "usages": 0,
        "skipped": []
      }
    ]
  },
  "rsc": {
    "documentSpanId": "37411b6e1d11b866",
    "renderSpanId": "5673057078793153",
    "renderRoute": "/lin-g",
    "renderSpanName": "render route (app) /lin-g",
    "sql": [
      {
        "spanId": "e07d225501b26b9d",
        "depthFromRender": 1,
        "callsite": {
          "at": "pg-pool.Pool.query",
          "frame": {
            "file": "src/app/lin-g/page.tsx",
            "line": 19,
            "col": 14,
            "functionName": "LinG"
          },
          "verified": true,
          "sourceLine": "await pool.query('SELECT code, region FROM poc.listings ORDER BY id LIMIT 1');",
          "component": {
            "name": "LinG",
            "file": "src/app/lin-g/page.tsx",
            "line": 18,
            "endLine": 31
          },
          "appFrameAtSpanStart": false,
          "failure": null
        }
      }
    ],
    "exchanges": [],
    "browserApiRequests": 0,
    "overlaps": [],
    "propagation": {
      "mode": "off",
      "method": "サーバー内部の通信はこの題材に無い（DB アクセスは HTTP を経由しない）",
      "scope": "—"
    },
    "services": [
      {
        "name": "poc01-fixture-app",
        "role": "app",
        "origin": "http://localhost:3200"
      }
    ]
  },
  "lineage": {
    "method": "TypeScript Compiler API（AST ＋ 記号解決によるスコープ解決）。参照の連鎖（分解束縛・別名・props の受け渡し・反復）を前向きにたどる。値の一致・実行時刻・SQL 文の一致・ソース上の SQL リテラルは使わない",
    "scope": "src/",
    "site": {
      "file": "src/app/lin-g/page.tsx",
      "line": 28,
      "col": 36,
      "component": "LinG",
      "field": "g-shadow",
      "expr": "region"
    },
    "outcome": "none",
    "candidates": [],
    "tableCandidates": [],
    "transformed": false,
    "literalPaths": 1,
    "untracked": [],
    "unresolved": [],
    "reasons": [
      "候補なし"
    ],
    "sqlSpanIds": []
  }
} as const;
