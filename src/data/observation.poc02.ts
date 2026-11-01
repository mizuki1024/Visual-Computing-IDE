/* =============================================================================
 * 自動生成（poc/runner/build-poc02-observation.mjs）。手で編集しない。
 *
 * PoC-02 で実際に観測した2回の読み込みの記録である。合成データではない。
 *   RSC_OBSERVATION      Gate B — Server Component がサーバー内部で直接 DB を読む
 *   RSC_SVC_OBSERVATION  Gate A — サーバーから別のサーバーへの通信（W3C 伝播）
 *
 * **表示された値そのもの・取得結果の中身・ヘッダ一覧・トレースコンテキストの値は
 * 含まない。** 相関のために読んだ応答ヘッダは2つのキーだけである。
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const RSC_OBSERVATION: ObservationBundle = {
  "meta": {
    "poc": "PoC-02",
    "collectedAt": "2026-10-31T17:14:37Z",
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
          "icon": "◈",
          "name": "通信の経路",
          "path": "/flows"
        },
        {
          "icon": "◆",
          "name": "直読み（1本）",
          "path": "/rsc-db",
          "current": true
        },
        {
          "icon": "◇",
          "name": "並列（3本）",
          "path": "/rsc-parallel"
        },
        {
          "icon": "◎",
          "name": "別サービスへの通信",
          "path": "/rsc-svc"
        }
      ]
    },
    "instrumentation": {
      "method": "方式2 NODE_OPTIONS=--require ＋ undici 計装による W3C 伝播 ＋ 呼び出し入口での呼び出しスタック記録 ＋ ビルド時の要素識別子注入",
      "detail": "プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。サーバー内部の通信は undici の計装で client スパンを作り、ループバック宛にのみ W3C traceparent を注入した。データ取得の実行元は、呼び出しの入口（Pool.query / globalThis.fetch）で取った呼び出しスタックを、ソースマップで元の位置へ戻して照合した",
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
        "what": "props の由来（derives）",
        "why": "取得した結果のどの項目が、画面のどの値になったかは観測できない。02a 3.5.1 により構造的に推定であり、関係を作らない"
      },
      {
        "what": "カラムと応答項目の対応づけ（maps）",
        "why": "確認には取得結果の中身の読み取りが必要で、収集禁止項目にあたるため行わなかった"
      },
      {
        "what": "コンポーネント単位のサーバー処理のスパン",
        "why": "Next.js の描画スパンはルート単位である。コンポーネント単位のスパンは存在しないため、スパンの親子関係だけでは特定のコンポーネントへ帰属できない。帰属は呼び出しスタックという別の証拠で行っている"
      },
      {
        "what": "スパン開始時のスタックによる実行元",
        "why": "SQL スパンは接続プールが空いた時点のコールバックの中で作られるため、スパン開始時のスタックには呼び出した側のフレームが無い（実測）。そのため呼び出しの入口で取ったスタックだけを根拠にしている"
      },
      {
        "what": "文書取得の呼び出し元",
        "why": "ブラウザはナビゲーションの呼び出しスタックを記録しない（initiator.type=other）"
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
        "what": "トレースコンテキストの値",
        "why": "受け側が「付いていたか」の真偽だけを記録した。値そのものは保存していない"
      },
      {
        "what": "本番ビルドでの実行元",
        "why": "ソースマップと要素識別子の注入に依存するため、開発ビルドに限る（01b Q-03 C-5）"
      }
    ],
    "excluded": {
      "staticAssetRequests": 16,
      "note": "静的資材（/_next/*・画像・フォント）は「通信」として数えていない"
    }
  },
  "page": {
    "path": "/rsc-db",
    "name": "直読み（1本）",
    "startMs": 1793466868135.539
  },
  "focus": {
    "method": "GET",
    "path": "/rsc-db"
  },
  "browserRequests": [
    {
      "method": "GET",
      "path": "/rsc-db",
      "status": 200,
      "startMs": 1793466868135.539,
      "durationMs": 37.2,
      "server": {
        "traceId": "2257464cd6db4c98b13d568b695b401d",
        "spanId": "bcfba5a4b8fd1193"
      },
      "isDocument": true,
      "browserRequestId": "60D22477C00CD9CB94C1A3F45A70E35A",
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "bcfba5a4b8fd1193",
      "parentSpanId": null,
      "name": "GET",
      "kind": 1,
      "startMs": 1793466868136,
      "endMs": 1793466868172.0867,
      "durationMs": 36.086583,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-http",
      "attrs": {
        "http.method": "GET",
        "http.target": "/rsc-db",
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "7a5dddc0dbb35b32",
      "parentSpanId": "a2b2bff538c654f7",
      "name": "rendering page",
      "kind": 0,
      "startMs": 1793466868141,
      "endMs": 1793466868172.6301,
      "durationMs": 31.630041,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.renderToResponse",
        "next.route": "/rsc-db"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "a2b2bff538c654f7",
      "parentSpanId": "b9fe65ade185a095",
      "name": "BaseServer.pipe",
      "kind": 0,
      "startMs": 1793466868141,
      "endMs": 1793466868172.7368,
      "durationMs": 31.736791,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "b9fe65ade185a095",
      "parentSpanId": "7d9e2f3d12c2cf6e",
      "name": "BaseServer.render",
      "kind": 0,
      "startMs": 1793466868141,
      "endMs": 1793466868172.8962,
      "durationMs": 31.896209,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "7d9e2f3d12c2cf6e",
      "parentSpanId": "3b2479e6d8640f7b",
      "name": "GET",
      "kind": 1,
      "startMs": 1793466868141,
      "endMs": 1793466868173.6016,
      "durationMs": 32.601458,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.handleRequest",
        "http.method": "GET",
        "http.target": "/rsc-db",
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "3b2479e6d8640f7b",
      "parentSpanId": "96ec729d5ed0fd42",
      "name": "NextServer.getServerRequestHandler",
      "kind": 0,
      "startMs": 1793466868141,
      "endMs": 1793466868173.9648,
      "durationMs": 32.964792,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "96ec729d5ed0fd42",
      "parentSpanId": "bcfba5a4b8fd1193",
      "name": "NextServer.getRequestHandler",
      "kind": 0,
      "startMs": 1793466868141,
      "endMs": 1793466868174.0903,
      "durationMs": 33.090333,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "8313cecf175c6295",
      "parentSpanId": "3a2f95bbded98a51",
      "name": "load route module",
      "kind": 0,
      "startMs": 1793466868142,
      "endMs": 1793466868142.3682,
      "durationMs": 0.368084,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "3a2f95bbded98a51",
      "parentSpanId": "2be33914cc2e2078",
      "name": "LoadComponents.loadComponents",
      "kind": 0,
      "startMs": 1793466868142,
      "endMs": 1793466868142.803,
      "durationMs": 0.803042,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "2be33914cc2e2078",
      "parentSpanId": "7a5dddc0dbb35b32",
      "name": "resolve page components",
      "kind": 0,
      "startMs": 1793466868142,
      "endMs": 1793466868142.928,
      "durationMs": 0.927958,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.findPageComponents",
        "next.route": "/rsc-db"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "4ba5c4ca2f00ddef",
      "parentSpanId": "bda908a6934c3315",
      "name": "load route manifests",
      "kind": 0,
      "startMs": 1793466868143,
      "endMs": 1793466868144.5017,
      "durationMs": 1.501625,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "bda908a6934c3315",
      "parentSpanId": "4ade9fbda40c4ff3",
      "name": "prepare route module",
      "kind": 0,
      "startMs": 1793466868143,
      "endMs": 1793466868144.8882,
      "durationMs": 1.88825,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "4ade9fbda40c4ff3",
      "parentSpanId": "7a5dddc0dbb35b32",
      "name": "BaseServer.renderToResponseWithComponents",
      "kind": 0,
      "startMs": 1793466868143,
      "endMs": 1793466868173.1443,
      "durationMs": 30.144375,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "9e86483a1408269d",
      "parentSpanId": "4790edc3c454853b",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793466868146,
      "endMs": 1793466868146.0464,
      "durationMs": 0.046292,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "54c031bcb6fb39ec",
      "parentSpanId": "4790edc3c454853b",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793466868146,
      "endMs": 1793466868146.0254,
      "durationMs": 0.025458,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "4790edc3c454853b",
      "parentSpanId": "b823c1b91e513912",
      "name": "build component tree",
      "kind": 0,
      "startMs": 1793466868146,
      "endMs": 1793466868147.0276,
      "durationMs": 1.027708,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "b823c1b91e513912",
      "parentSpanId": "4ade9fbda40c4ff3",
      "name": "render route (app) /rsc-db",
      "kind": 0,
      "startMs": 1793466868146,
      "endMs": 1793466868168.7952,
      "durationMs": 22.795209,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.getBodyResult",
        "next.route": "/rsc-db"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "da70e5115e99bcc5",
      "parentSpanId": "b823c1b91e513912",
      "name": "pg-pool.connect",
      "kind": 2,
      "startMs": 1793466868151,
      "endMs": 1793466868157.7866,
      "durationMs": 6.786625,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "3bb9dae06301dfcb",
      "parentSpanId": "f6acad42bd34d68b",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793466868158,
      "endMs": 1793466868158.1238,
      "durationMs": 0.123792,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "59a115ba0e296012",
      "parentSpanId": "b823c1b91e513912",
      "name": "pg.query:SELECT poc01",
      "kind": 2,
      "startMs": 1793466868158,
      "endMs": 1793466868164.5427,
      "durationMs": 6.542833,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-pg",
      "attrs": {
        "db.system": "postgresql",
        "db.name": "poc01",
        "db.statement": "SELECT id, code, plan FROM poc.listings ORDER BY id LIMIT $0"
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "f32e5d5795d9880b",
      "parentSpanId": "f6acad42bd34d68b",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793466868158,
      "endMs": 1793466868168.1724,
      "durationMs": 10.172417,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "f6acad42bd34d68b",
      "parentSpanId": "b823c1b91e513912",
      "name": "AppRender.renderToNodeFizzStream",
      "kind": 0,
      "startMs": 1793466868158,
      "endMs": 1793466868168.6882,
      "durationMs": 10.688292,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "ede0a116661a4a3c",
      "parentSpanId": "4ade9fbda40c4ff3",
      "name": "NextNodeServer.clientComponentLoading",
      "kind": 0,
      "startMs": 1793466868159.089,
      "endMs": 1793466868163.9492,
      "durationMs": 4.860042,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "91544c3541ff6b6d",
      "parentSpanId": "b823c1b91e513912",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793466868170,
      "endMs": 1793466868170.066,
      "durationMs": 0.065958,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "5a025115b0079157",
      "parentSpanId": "b823c1b91e513912",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793466868170,
      "endMs": 1793466868170.1433,
      "durationMs": 0.143416,
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
      "traceId": "2257464cd6db4c98b13d568b695b401d",
      "spanId": "a1756496684572f2",
      "parentSpanId": "b823c1b91e513912",
      "name": "start response",
      "kind": 0,
      "startMs": 1793466868171,
      "endMs": 1793466868171.0076,
      "durationMs": 0.007666,
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
      "spanId": "59a115ba0e296012",
      "sql": "SELECT id, code, plan FROM poc.listings ORDER BY id LIMIT $0",
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
          "column": "plan",
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
        "column": "plan",
        "dataType": "text",
        "nullable": false,
        "position": 4
      }
    ]
  },
  "elements": {
    "method": "方式1 ビルド時の要素識別子注入（JSX へ data-vcide を挿入）",
    "bundler": "turbopack",
    "injectedScope": "src/",
    "transform": "挿入のみ。再出力しないため行番号はずれない。ソースマップに依存しない",
    "page": "/rsc-db",
    "anchoredElements": 10,
    "totalElements": 41,
    "primaryKey": "rsc-code",
    "selections": [
      {
        "key": "rsc-code",
        "selector": "main.rsc-db li[data-poc-field=\"code\"]",
        "ordinal": 0,
        "group": "rsc-direct",
        "primary": true,
        "tag": "li",
        "anchorOnSelf": "0c52ff5b21",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 6,
        "ancestorAnchors": [
          "91c86c2783",
          "bc8bac3bdc"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 9,
          "cls": "latin"
        },
        "failure": null
      },
      {
        "key": "rsc-h1",
        "selector": "main.rsc-db > h1",
        "ordinal": 0,
        "group": "rsc-own",
        "primary": false,
        "tag": "h1",
        "anchorOnSelf": "a2652540ed",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [
          "bc8bac3bdc"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 7,
          "cls": "mixed"
        },
        "failure": null
      }
    ],
    "anchors": [
      {
        "id": "0c52ff5b21",
        "tag": "li",
        "file": "src/app/rsc-db/page.tsx",
        "line": 19,
        "col": 11,
        "component": "RscDb",
        "componentLine": 11,
        "verified": true,
        "sourceLine": "<li key={row.id} data-poc-field=\"code\">{row.code}</li>"
      },
      {
        "id": "a2652540ed",
        "tag": "h1",
        "file": "src/app/rsc-db/page.tsx",
        "line": 15,
        "col": 7,
        "component": "RscDb",
        "componentLine": 11,
        "verified": true,
        "sourceLine": "<h1>直読み（1本）</h1>"
      }
    ],
    "files": [
      {
        "file": "src/app/rsc-svc/page.tsx",
        "anchors": 4,
        "usages": 0,
        "skipped": []
      },
      {
        "file": "src/app/rsc-db/page.tsx",
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
      }
    ]
  },
  "rsc": {
    "documentSpanId": "bcfba5a4b8fd1193",
    "renderSpanId": "b823c1b91e513912",
    "renderRoute": "/rsc-db",
    "renderSpanName": "render route (app) /rsc-db",
    "sql": [
      {
        "spanId": "59a115ba0e296012",
        "depthFromRender": 1,
        "callsite": {
          "at": "pg-pool.Pool.query",
          "frame": {
            "file": "src/app/rsc-db/page.tsx",
            "line": 12,
            "col": 24,
            "functionName": "RscDb"
          },
          "verified": true,
          "sourceLine": "const r = await pool.query('SELECT id, code, plan FROM poc.listings ORDER BY id LIMIT 6');",
          "component": {
            "name": "RscDb",
            "file": "src/app/rsc-db/page.tsx",
            "line": 11,
            "endLine": 24
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
      "mode": "on",
      "method": "undici 計装が W3C Trace Context（traceparent）を注入し、受け側の HTTP 計装がそれを取り出して入口スパンの親にする",
      "scope": "ループバック宛の要求にだけ注入する。それ以外の宛先は計装しないため、スパンも作られず traceparent も付かない"
    },
    "services": [
      {
        "name": "poc01-fixture-app",
        "role": "app",
        "origin": "http://localhost:3200"
      },
      {
        "name": "poc02-fixture-svc",
        "role": "svc",
        "origin": "http://127.0.0.1:3300"
      }
    ]
  }
} as const;

export const RSC_SVC_OBSERVATION: ObservationBundle = {
  "meta": {
    "poc": "PoC-02",
    "collectedAt": "2026-10-31T17:14:38Z",
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
          "icon": "◈",
          "name": "通信の経路",
          "path": "/flows"
        },
        {
          "icon": "◆",
          "name": "直読み（1本）",
          "path": "/rsc-db"
        },
        {
          "icon": "◇",
          "name": "並列（3本）",
          "path": "/rsc-parallel"
        },
        {
          "icon": "◎",
          "name": "別サービスへの通信",
          "path": "/rsc-svc",
          "current": true
        }
      ]
    },
    "instrumentation": {
      "method": "方式2 NODE_OPTIONS=--require ＋ undici 計装による W3C 伝播 ＋ 呼び出し入口での呼び出しスタック記録 ＋ ビルド時の要素識別子注入",
      "detail": "プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。サーバー内部の通信は undici の計装で client スパンを作り、ループバック宛にのみ W3C traceparent を注入した。データ取得の実行元は、呼び出しの入口（Pool.query / globalThis.fetch）で取った呼び出しスタックを、ソースマップで元の位置へ戻して照合した",
      "bundler": "turbopack"
    },
    "droppedAttributeKeys": [
      "db.connection_string",
      "db.postgresql.idle.timeout.millis",
      "db.user",
      "http.flavor",
      "http.host",
      "http.request.method_original",
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
      "network.peer.address",
      "network.peer.port",
      "next.clientComponentLoadCount",
      "next.fetch.cache_reason",
      "next.fetch.cache_status",
      "next.fetch.idx",
      "next.span_category",
      "next.span_name",
      "url.full",
      "url.query",
      "user_agent.original"
    ],
    "notObserved": [
      {
        "what": "props の由来（derives）",
        "why": "取得した結果のどの項目が、画面のどの値になったかは観測できない。02a 3.5.1 により構造的に推定であり、関係を作らない"
      },
      {
        "what": "カラムと応答項目の対応づけ（maps）",
        "why": "確認には取得結果の中身の読み取りが必要で、収集禁止項目にあたるため行わなかった"
      },
      {
        "what": "コンポーネント単位のサーバー処理のスパン",
        "why": "Next.js の描画スパンはルート単位である。コンポーネント単位のスパンは存在しないため、スパンの親子関係だけでは特定のコンポーネントへ帰属できない。帰属は呼び出しスタックという別の証拠で行っている"
      },
      {
        "what": "スパン開始時のスタックによる実行元",
        "why": "SQL スパンは接続プールが空いた時点のコールバックの中で作られるため、スパン開始時のスタックには呼び出した側のフレームが無い（実測）。そのため呼び出しの入口で取ったスタックだけを根拠にしている"
      },
      {
        "what": "文書取得の呼び出し元",
        "why": "ブラウザはナビゲーションの呼び出しスタックを記録しない（initiator.type=other）"
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
        "what": "トレースコンテキストの値",
        "why": "受け側が「付いていたか」の真偽だけを記録した。値そのものは保存していない"
      },
      {
        "what": "本番ビルドでの実行元",
        "why": "ソースマップと要素識別子の注入に依存するため、開発ビルドに限る（01b Q-03 C-5）"
      }
    ],
    "excluded": {
      "staticAssetRequests": 16,
      "note": "静的資材（/_next/*・画像・フォント）は「通信」として数えていない"
    }
  },
  "page": {
    "path": "/rsc-svc",
    "name": "別サービスへの通信",
    "startMs": 1793466871671.514
  },
  "focus": {
    "method": "GET",
    "path": "/rsc-svc"
  },
  "browserRequests": [
    {
      "method": "GET",
      "path": "/rsc-svc",
      "status": 200,
      "startMs": 1793466871671.514,
      "durationMs": 108.8,
      "server": {
        "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
        "spanId": "6df57b491861fc3b"
      },
      "isDocument": true,
      "browserRequestId": "F5963CA72C6E82AA56D5754C38A7D38A",
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "6df57b491861fc3b",
      "parentSpanId": null,
      "name": "GET",
      "kind": 1,
      "startMs": 1793466871672,
      "endMs": 1793466871780.8018,
      "durationMs": 108.801792,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-http",
      "attrs": {
        "http.method": "GET",
        "http.target": "/rsc-svc",
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "3403ef081b3e830e",
      "parentSpanId": "182608caa82fca93",
      "name": "GET",
      "kind": 1,
      "startMs": 1793466871677,
      "endMs": 1793466871781.2812,
      "durationMs": 104.281209,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.handleRequest",
        "http.method": "GET",
        "http.target": "/rsc-svc",
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "182608caa82fca93",
      "parentSpanId": "84ed1533f9d87290",
      "name": "NextServer.getServerRequestHandler",
      "kind": 0,
      "startMs": 1793466871677,
      "endMs": 1793466871781.5278,
      "durationMs": 104.527833,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "84ed1533f9d87290",
      "parentSpanId": "6df57b491861fc3b",
      "name": "NextServer.getRequestHandler",
      "kind": 0,
      "startMs": 1793466871677,
      "endMs": 1793466871781.6194,
      "durationMs": 104.619375,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "deda099fcfc878ac",
      "parentSpanId": "56364dc3473d52ca",
      "name": "load route module",
      "kind": 0,
      "startMs": 1793466871678,
      "endMs": 1793466871678.291,
      "durationMs": 0.291084,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "56364dc3473d52ca",
      "parentSpanId": "c3994b0d747c5a69",
      "name": "LoadComponents.loadComponents",
      "kind": 0,
      "startMs": 1793466871678,
      "endMs": 1793466871678.6562,
      "durationMs": 0.656209,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "c3994b0d747c5a69",
      "parentSpanId": "c60d766083074d00",
      "name": "resolve page components",
      "kind": 0,
      "startMs": 1793466871678,
      "endMs": 1793466871678.7263,
      "durationMs": 0.726208,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.findPageComponents",
        "next.route": "/rsc-svc"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "c60d766083074d00",
      "parentSpanId": "33517d9ec540a1d4",
      "name": "rendering page",
      "kind": 0,
      "startMs": 1793466871678,
      "endMs": 1793466871781.6113,
      "durationMs": 103.611209,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.renderToResponse",
        "next.route": "/rsc-svc"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "33517d9ec540a1d4",
      "parentSpanId": "e06c519e1c1c67ce",
      "name": "BaseServer.pipe",
      "kind": 0,
      "startMs": 1793466871678,
      "endMs": 1793466871781.7559,
      "durationMs": 103.755916,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "e06c519e1c1c67ce",
      "parentSpanId": "3403ef081b3e830e",
      "name": "BaseServer.render",
      "kind": 0,
      "startMs": 1793466871678,
      "endMs": 1793466871781.864,
      "durationMs": 103.864083,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "e012634da70478b6",
      "parentSpanId": "5aaa3f891c335e7c",
      "name": "load route manifests",
      "kind": 0,
      "startMs": 1793466871679,
      "endMs": 1793466871680.2808,
      "durationMs": 1.28075,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "5aaa3f891c335e7c",
      "parentSpanId": "e6c925ef788ae0a3",
      "name": "prepare route module",
      "kind": 0,
      "startMs": 1793466871679,
      "endMs": 1793466871680.6892,
      "durationMs": 1.689291,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "e6c925ef788ae0a3",
      "parentSpanId": "c60d766083074d00",
      "name": "BaseServer.renderToResponseWithComponents",
      "kind": 0,
      "startMs": 1793466871679,
      "endMs": 1793466871781.5693,
      "durationMs": 102.569458,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "743cb6def0d26483",
      "parentSpanId": "de35f958c530c12f",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793466871682,
      "endMs": 1793466871682.0586,
      "durationMs": 0.058542,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "de35f958c530c12f",
      "parentSpanId": "feda3b738cc355aa",
      "name": "build component tree",
      "kind": 0,
      "startMs": 1793466871682,
      "endMs": 1793466871684.0122,
      "durationMs": 2.012208,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "feda3b738cc355aa",
      "parentSpanId": "e6c925ef788ae0a3",
      "name": "render route (app) /rsc-svc",
      "kind": 0,
      "startMs": 1793466871682,
      "endMs": 1793466871773.4468,
      "durationMs": 91.44675,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.getBodyResult",
        "next.route": "/rsc-svc"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "687951d9bafb9c44",
      "parentSpanId": "de35f958c530c12f",
      "name": "resolve segment modules",
      "kind": 0,
      "startMs": 1793466871683,
      "endMs": 1793466871683.1333,
      "durationMs": 0.133375,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "6ca54f7cdb605c1a",
      "parentSpanId": "feda3b738cc355aa",
      "name": "fetch GET http://127.0.0.1:3300/echo",
      "kind": 2,
      "startMs": 1793466871689,
      "endMs": 1793466871760.5127,
      "durationMs": 71.512791,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.fetch",
        "http.method": "GET",
        "http.status_code": 200
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name",
        "http.url",
        "net.peer.name",
        "net.peer.port",
        "next.fetch.idx",
        "next.fetch.cache_status",
        "next.fetch.cache_reason"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "aaea603aa9f5f7b0",
      "parentSpanId": "feda3b738cc355aa",
      "name": "fetch GET http://127.0.0.1:3300/rows",
      "kind": 2,
      "startMs": 1793466871693,
      "endMs": 1793466871767.2207,
      "durationMs": 74.220708,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRender.fetch",
        "http.method": "GET",
        "http.status_code": 200
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name",
        "http.url",
        "net.peer.name",
        "net.peer.port",
        "next.fetch.idx",
        "next.fetch.cache_status",
        "next.fetch.cache_reason"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "76da78ebc2abc63b",
      "parentSpanId": "6ca54f7cdb605c1a",
      "name": "GET",
      "kind": 2,
      "startMs": 1793466871712,
      "endMs": 1793466871755.5205,
      "durationMs": 43.520583,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-undici",
      "attrs": {
        "http.request.method": "GET",
        "url.path": "/echo",
        "url.scheme": "http",
        "server.address": "127.0.0.1",
        "server.port": 3300,
        "http.response.status_code": 200
      },
      "droppedAttributeKeys": [
        "http.request.method_original",
        "url.full",
        "url.query",
        "user_agent.original",
        "network.peer.address",
        "network.peer.port"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "b79e220771d91809",
      "parentSpanId": "aaea603aa9f5f7b0",
      "name": "GET",
      "kind": 2,
      "startMs": 1793466871714,
      "endMs": 1793466871764.9016,
      "durationMs": 50.901625,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-undici",
      "attrs": {
        "http.request.method": "GET",
        "url.path": "/rows",
        "url.scheme": "http",
        "server.address": "127.0.0.1",
        "server.port": 3300,
        "http.response.status_code": 200
      },
      "droppedAttributeKeys": [
        "http.request.method_original",
        "url.full",
        "url.query",
        "user_agent.original",
        "network.peer.address",
        "network.peer.port"
      ],
      "service": "poc01-fixture-app"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "e96fd995dc0ec0c1",
      "parentSpanId": "feda3b738cc355aa",
      "name": "AppRender.renderToNodeFizzStream",
      "kind": 0,
      "startMs": 1793466871720,
      "endMs": 1793466871773.7808,
      "durationMs": 53.780875,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "282d7a3ad214204c",
      "parentSpanId": "e96fd995dc0ec0c1",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793466871721,
      "endMs": 1793466871721.2634,
      "durationMs": 0.263416,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "2f4c2daa86e8ccf7",
      "parentSpanId": "e96fd995dc0ec0c1",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793466871722,
      "endMs": 1793466871774.0222,
      "durationMs": 52.022333,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "dd9472e8036a40b0",
      "parentSpanId": "e6c925ef788ae0a3",
      "name": "NextNodeServer.clientComponentLoading",
      "kind": 0,
      "startMs": 1793466871723.5193,
      "endMs": 1793466871734.6262,
      "durationMs": 11.106875,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "df23f28ec7e8a646",
      "parentSpanId": "76da78ebc2abc63b",
      "name": "GET",
      "kind": 1,
      "startMs": 1793466871749,
      "endMs": 1793466871752.912,
      "durationMs": 3.912,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-http",
      "attrs": {
        "http.method": "GET",
        "http.target": "/echo",
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
      "service": "poc02-fixture-svc"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "acf6bd68f9e9b925",
      "parentSpanId": "b79e220771d91809",
      "name": "GET",
      "kind": 1,
      "startMs": 1793466871753,
      "endMs": 1793466871759.35,
      "durationMs": 6.350041,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-http",
      "attrs": {
        "http.method": "GET",
        "http.target": "/rows",
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
      "service": "poc02-fixture-svc"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "1bf7549d25a3b78f",
      "parentSpanId": "acf6bd68f9e9b925",
      "name": "pg-pool.connect",
      "kind": 2,
      "startMs": 1793466871754,
      "endMs": 1793466871755.4668,
      "durationMs": 1.46675,
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
      "service": "poc02-fixture-svc"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "c65817f05976bf75",
      "parentSpanId": "acf6bd68f9e9b925",
      "name": "pg.query:SELECT poc01",
      "kind": 2,
      "startMs": 1793466871755,
      "endMs": 1793466871758.814,
      "durationMs": 3.813875,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-pg",
      "attrs": {
        "db.system": "postgresql",
        "db.name": "poc01",
        "db.statement": "SELECT code, name FROM poc.regions ORDER BY code LIMIT $0"
      },
      "droppedAttributeKeys": [
        "db.connection_string",
        "db.user",
        "net.peer.name",
        "net.peer.port"
      ],
      "service": "poc02-fixture-svc"
    },
    {
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "812008bf886ccc14",
      "parentSpanId": "feda3b738cc355aa",
      "name": "AppRender.renderToReadableStream",
      "kind": 0,
      "startMs": 1793466871776,
      "endMs": 1793466871776.0952,
      "durationMs": 0.095333,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "6dc7c2c94e78c757",
      "parentSpanId": "feda3b738cc355aa",
      "name": "AppRender.waitShellReady",
      "kind": 0,
      "startMs": 1793466871776,
      "endMs": 1793466871776.5134,
      "durationMs": 0.5135,
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
      "traceId": "d2fbd34ebd1b2aef2879fa8f3542c740",
      "spanId": "fa6d21b39d526252",
      "parentSpanId": "feda3b738cc355aa",
      "name": "start response",
      "kind": 0,
      "startMs": 1793466871778,
      "endMs": 1793466871778.0234,
      "durationMs": 0.023333,
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
      "spanId": "c65817f05976bf75",
      "sql": "SELECT code, name FROM poc.regions ORDER BY code LIMIT $0",
      "redacted": {
        "strings": 0,
        "numbers": 1
      },
      "parseOk": true,
      "parseError": null,
      "tables": [
        {
          "schema": "poc",
          "name": "regions"
        }
      ],
      "projections": [
        {
          "schema": "poc",
          "table": "regions",
          "column": "code",
          "inferredQualifier": true
        },
        {
          "schema": "poc",
          "table": "regions",
          "column": "name",
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
        "name": "regions",
        "rowEstimate": 4
      }
    ],
    "columns": [
      {
        "schema": "poc",
        "table": "regions",
        "column": "code",
        "dataType": "text",
        "nullable": false,
        "position": 2
      },
      {
        "schema": "poc",
        "table": "regions",
        "column": "name",
        "dataType": "text",
        "nullable": false,
        "position": 3
      }
    ]
  },
  "rsc": {
    "documentSpanId": "6df57b491861fc3b",
    "renderSpanId": "feda3b738cc355aa",
    "renderRoute": "/rsc-svc",
    "renderSpanName": "render route (app) /rsc-svc",
    "sql": [
      {
        "spanId": "c65817f05976bf75",
        "depthFromRender": 4,
        "callsite": {
          "at": "pg-pool.Pool.query",
          "frame": null,
          "verified": false,
          "sourceLine": null,
          "component": null,
          "appFrameAtSpanStart": false,
          "failure": {
            "reason": "no-app-frame",
            "detail": "注入範囲（src/）のソース位置へ戻せるフレームが無い"
          }
        }
      }
    ],
    "exchanges": [
      {
        "clientSpanId": "76da78ebc2abc63b",
        "destPath": "/echo",
        "destHost": "127.0.0.1",
        "destPort": 3300,
        "status": 200,
        "entrySpanId": "df23f28ec7e8a646",
        "propagationFailure": null,
        "crossProcess": true,
        "entryService": "poc02-fixture-svc",
        "sqlSpanIds": [],
        "callsite": {
          "at": "globalThis.fetch",
          "frame": {
            "file": "src/app/rsc-svc/page.tsx",
            "line": 15,
            "col": 5,
            "functionName": "RscSvc"
          },
          "verified": true,
          "sourceLine": "fetch(`${SVC}/echo`, { cache: 'no-store' }),",
          "component": {
            "name": "RscSvc",
            "file": "src/app/rsc-svc/page.tsx",
            "line": 13,
            "endLine": 27
          },
          "appFrameAtSpanStart": true,
          "failure": null
        }
      },
      {
        "clientSpanId": "b79e220771d91809",
        "destPath": "/rows",
        "destHost": "127.0.0.1",
        "destPort": 3300,
        "status": 200,
        "entrySpanId": "acf6bd68f9e9b925",
        "propagationFailure": null,
        "crossProcess": true,
        "entryService": "poc02-fixture-svc",
        "sqlSpanIds": [
          "c65817f05976bf75"
        ],
        "callsite": {
          "at": "globalThis.fetch",
          "frame": {
            "file": "src/app/rsc-svc/page.tsx",
            "line": 16,
            "col": 5,
            "functionName": "RscSvc"
          },
          "verified": true,
          "sourceLine": "fetch(`${SVC}/rows`, { cache: 'no-store' }),",
          "component": {
            "name": "RscSvc",
            "file": "src/app/rsc-svc/page.tsx",
            "line": 13,
            "endLine": 27
          },
          "appFrameAtSpanStart": true,
          "failure": null
        }
      }
    ],
    "focusExchange": "/rows",
    "browserApiRequests": 0,
    "overlaps": [],
    "propagation": {
      "mode": "on",
      "method": "undici 計装が W3C Trace Context（traceparent）を注入し、受け側の HTTP 計装がそれを取り出して入口スパンの親にする",
      "scope": "ループバック宛の要求にだけ注入する。それ以外の宛先は計装しないため、スパンも作られず traceparent も付かない"
    },
    "services": [
      {
        "name": "poc01-fixture-app",
        "role": "app",
        "origin": "http://localhost:3200"
      },
      {
        "name": "poc02-fixture-svc",
        "role": "svc",
        "origin": "http://127.0.0.1:3300"
      }
    ]
  }
} as const;
