/* =============================================================================
 * 自動生成（poc/runner/build-observation.mjs）。手で編集しない。
 *
 * PoC-01 で実際に観測した1回のページ読み込みの記録である。合成データではない。
 * 収集禁止項目（SQLのパラメータ値・接続文字列・Cookie・Authorization・トークン・
 * 個人情報・行データ・本文）は、取得時点で除去されているため含まれない。
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const OBSERVATION: ObservationBundle = {
  "meta": {
    "poc": "PoC-01",
    "collectedAt": "2026-10-31T13:42:49Z",
    "app": {
      "name": "PoC-01 Fixture App",
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
          "path": "/listings",
          "current": true
        },
        {
          "icon": "▢",
          "name": "物件詳細",
          "path": "/listings/[id]"
        }
      ]
    },
    "instrumentation": {
      "method": "方式2 NODE_OPTIONS=--require",
      "detail": "プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した",
      "bundler": "turbopack"
    },
    "droppedAttributeKeys": [
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
      "net.peer.port",
      "net.transport",
      "next.span_category",
      "next.span_name"
    ],
    "notObserved": [
      {
        "what": "表示された値（DOM上の文字列）",
        "why": "ブラウザのDOM読み取りは PoC-01 の範囲外（PoC-03 の検証対象）"
      },
      {
        "what": "コンポーネント定義との対応",
        "why": "要素識別子の注入は PoC-01 の範囲外（PoC-03 の検証対象）"
      },
      {
        "what": "カラムと応答項目の対応づけ（maps）",
        "why": "確認にはレスポンス本文の読み取りが必要で、収集禁止項目にあたるため行わなかった"
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
        "what": "Server Component から DB を直読みする経路",
        "why": "PoC-02 の検証対象。本PoCは Client Component + API ルートに限定した"
      }
    ],
    "excluded": {
      "staticAssetRequests": 16,
      "note": "静的資材（/_next/*・画像・フォント）は「通信」として数えていない"
    }
  },
  "page": {
    "path": "/listings",
    "name": "物件一覧",
    "startMs": 1793454165630.313
  },
  "focus": {
    "method": "GET",
    "path": "/api/listings"
  },
  "browserRequests": [
    {
      "method": "GET",
      "path": "/listings",
      "status": 200,
      "startMs": 1793454165630.313,
      "durationMs": 28.52,
      "server": {
        "traceId": "c8ff25e94f9edd9d002c450e67f07450",
        "spanId": "75b593a949f91718"
      },
      "isDocument": true
    },
    {
      "method": "GET",
      "path": "/api/listings",
      "status": 200,
      "startMs": 1793454165808.386,
      "durationMs": 10.01,
      "server": {
        "traceId": "245e2e0448416f255493f271fa0a65cd",
        "spanId": "d8a6b6dffeceebb3"
      },
      "isDocument": false
    }
  ],
  "spans": [
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "0b77c3e70d08e24c",
      "parentSpanId": "d8dacaa62010cd76",
      "name": "load route module",
      "kind": 0,
      "startMs": 1793454165810,
      "endMs": 1793454165810.1833,
      "durationMs": 0.183375,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "LoadComponents.loadRouteModule"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "d8dacaa62010cd76",
      "parentSpanId": "c8070b8f4388bb2e",
      "name": "LoadComponents.loadComponents",
      "kind": 0,
      "startMs": 1793454165810,
      "endMs": 1793454165810.3765,
      "durationMs": 0.376542,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "LoadComponents.loadComponents"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "c8070b8f4388bb2e",
      "parentSpanId": "1366a3af1cab88d2",
      "name": "resolve page components",
      "kind": 0,
      "startMs": 1793454165810,
      "endMs": 1793454165810.4314,
      "durationMs": 0.431416,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.findPageComponents",
        "next.route": "/api/listings"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "2de22c3d9282e734",
      "parentSpanId": "d1e98632764c52e7",
      "name": "load route manifests",
      "kind": 0,
      "startMs": 1793454165811,
      "endMs": 1793454165811.891,
      "durationMs": 0.891125,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "RouteModule.loadManifests"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "d1e98632764c52e7",
      "parentSpanId": "1cf91a35d41e738b",
      "name": "prepare route module",
      "kind": 0,
      "startMs": 1793454165811,
      "endMs": 1793454165812.1006,
      "durationMs": 1.1005,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "RouteModule.prepare"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "ff3e566cc090cf20",
      "parentSpanId": "66c0b299afa6c075",
      "name": "prisma:client:serialize",
      "kind": 0,
      "startMs": 1793454165813,
      "endMs": 1793454165813.0562,
      "durationMs": 0.056083,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "6d86a7ffae444630",
      "parentSpanId": "499fc4ecdbcb92a5",
      "name": "prisma:engine:connection",
      "kind": 0,
      "startMs": 1793454165813.452,
      "endMs": 1793454165813.4656,
      "durationMs": 0.013625,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {
        "db.system": "postgresql"
      },
      "droppedAttributeKeys": []
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "701b59676355f37a",
      "parentSpanId": "499fc4ecdbcb92a5",
      "name": "prisma:engine:db_query",
      "kind": 2,
      "startMs": 1793454165813.582,
      "endMs": 1793454165816.2517,
      "durationMs": 2.669625,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {
        "db.query.text": "SELECT \"poc\".\"listings\".\"id\", \"poc\".\"listings\".\"code\", \"poc\".\"listings\".\"region\" FROM \"poc\".\"listings\" WHERE $0=$0 ORDER BY \"poc\".\"listings\".\"id\" ASC LIMIT $1 OFFSET $2",
        "db.system": "postgresql"
      },
      "droppedAttributeKeys": []
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "8fd22f39adaae882",
      "parentSpanId": "499fc4ecdbcb92a5",
      "name": "prisma:engine:serialize",
      "kind": 0,
      "startMs": 1793454165816.263,
      "endMs": 1793454165816.2844,
      "durationMs": 0.021375,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "6d046e9e5ad74534",
      "parentSpanId": "499fc4ecdbcb92a5",
      "name": "prisma:engine:response_json_serialization",
      "kind": 0,
      "startMs": 1793454165816.295,
      "endMs": 1793454165816.2998,
      "durationMs": 0.00475,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "499fc4ecdbcb92a5",
      "parentSpanId": "66c0b299afa6c075",
      "name": "prisma:engine:query",
      "kind": 0,
      "startMs": 1793454165813.421,
      "endMs": 1793454165816.3018,
      "durationMs": 2.880667,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "66c0b299afa6c075",
      "parentSpanId": "d9f29acdf3b01971",
      "name": "prisma:client:operation",
      "kind": 0,
      "startMs": 1793454165813,
      "endMs": 1793454165816.768,
      "durationMs": 3.768042,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {
        "method": "findMany",
        "model": "Listing",
        "name": "Listing.findMany"
      },
      "droppedAttributeKeys": []
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "d9f29acdf3b01971",
      "parentSpanId": "1cf91a35d41e738b",
      "name": "executing api route (app) /api/listings",
      "kind": 0,
      "startMs": 1793454165812,
      "endMs": 1793454165816.0562,
      "durationMs": 4.05625,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "AppRouteRouteHandlers.runHandler",
        "next.route": "/api/listings"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "418a96ec71b890d5",
      "parentSpanId": "1cf91a35d41e738b",
      "name": "start response",
      "kind": 0,
      "startMs": 1793454165817,
      "endMs": 1793454165817.0093,
      "durationMs": 0.009167,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextNodeServer.startResponse"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "d8a6b6dffeceebb3",
      "parentSpanId": null,
      "name": "GET",
      "kind": 1,
      "startMs": 1793454165808,
      "endMs": 1793454165817.1526,
      "durationMs": 9.1525,
      "statusCode": 0,
      "scope": "@opentelemetry/instrumentation-http",
      "attrs": {
        "http.method": "GET",
        "http.target": "/api/listings",
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
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "1cf91a35d41e738b",
      "parentSpanId": "1366a3af1cab88d2",
      "name": "BaseServer.renderToResponseWithComponents",
      "kind": 0,
      "startMs": 1793454165811,
      "endMs": 1793454165817.8171,
      "durationMs": 6.817166,
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
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "1366a3af1cab88d2",
      "parentSpanId": "a255e14f66afcba1",
      "name": "rendering page",
      "kind": 0,
      "startMs": 1793454165810,
      "endMs": 1793454165817.4631,
      "durationMs": 7.463167,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.renderToResponse",
        "next.route": "/api/listings"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "a255e14f66afcba1",
      "parentSpanId": "119ae283140daf2f",
      "name": "BaseServer.pipe",
      "kind": 0,
      "startMs": 1793454165810,
      "endMs": 1793454165817.5166,
      "durationMs": 7.516541,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.pipe"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "119ae283140daf2f",
      "parentSpanId": "c23d85a5921759a9",
      "name": "BaseServer.render",
      "kind": 0,
      "startMs": 1793454165810,
      "endMs": 1793454165817.5723,
      "durationMs": 7.572167,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.render"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "c23d85a5921759a9",
      "parentSpanId": "9466005984b2da60",
      "name": "GET",
      "kind": 1,
      "startMs": 1793454165810,
      "endMs": 1793454165817.8618,
      "durationMs": 7.861833,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "BaseServer.handleRequest",
        "http.method": "GET",
        "http.target": "/api/listings",
        "http.status_code": 200,
        "next.rsc": false
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "9466005984b2da60",
      "parentSpanId": "98690c6d20a52e85",
      "name": "NextServer.getServerRequestHandler",
      "kind": 0,
      "startMs": 1793454165810,
      "endMs": 1793454165818.0293,
      "durationMs": 8.029209,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextServer.getServerRequestHandler"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    },
    {
      "traceId": "245e2e0448416f255493f271fa0a65cd",
      "spanId": "98690c6d20a52e85",
      "parentSpanId": "d8a6b6dffeceebb3",
      "name": "NextServer.getRequestHandler",
      "kind": 0,
      "startMs": 1793454165810,
      "endMs": 1793454165818.1685,
      "durationMs": 8.168458,
      "statusCode": 0,
      "scope": "next.js",
      "attrs": {
        "next.span_type": "NextServer.getRequestHandler"
      },
      "droppedAttributeKeys": [
        "next.span_category",
        "next.span_name"
      ]
    }
  ],
  "sqlAnalyses": [
    {
      "spanId": "701b59676355f37a",
      "sql": "SELECT \"poc\".\"listings\".\"id\", \"poc\".\"listings\".\"code\", \"poc\".\"listings\".\"region\" FROM \"poc\".\"listings\" WHERE $0=$0 ORDER BY \"poc\".\"listings\".\"id\" ASC LIMIT $1 OFFSET $2",
      "redacted": {
        "strings": 0,
        "numbers": 2
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
          "column": "id"
        },
        {
          "schema": "poc",
          "table": "listings",
          "column": "code"
        },
        {
          "schema": "poc",
          "table": "listings",
          "column": "region"
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
  }
} as const;
