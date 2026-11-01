/* =============================================================================
 * 自動生成（poc/runner/build-element-observation.mjs）。手で編集しない。
 *
 * PoC-03 で実際に観測した1回のページ読み込みの記録である。合成データではない。
 * **表示された値そのものは含まない**（文字数と文字種だけを持つ）。
 * 収集禁止項目（SQLのパラメータ値・接続文字列・Cookie・Authorization・トークン・
 * 個人情報・行データ・本文・DOM の全文）は、取得時点で除去されているため含まれない。
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const ELEMENT_OBSERVATION: ObservationBundle = {
  "meta": {
    "poc": "PoC-03",
    "collectedAt": "2026-10-31T15:14:31Z",
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
          "icon": "▤",
          "name": "物件カード",
          "path": "/cards",
          "current": true
        },
        {
          "icon": "▥",
          "name": "物件カード（サーバー描画）",
          "path": "/cards-rsc"
        }
      ]
    },
    "instrumentation": {
      "method": "方式2 NODE_OPTIONS=--require ＋ 方式1 ビルド時の要素識別子注入",
      "detail": "プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。要素識別子はバンドラのローダで JSX へ注入した（src/ のみ）",
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
        "what": "props の由来（derives）",
        "why": "コンポーネントが props で受け取った値が、応答のどの項目から来たかは観測できない。02a 3.5.1 により構造的に推定であり、本PoCでは関係を作らない"
      },
      {
        "what": "この通信を起こした箇所（requests）",
        "why": "コンポーネントと通信を結ぶ共通の証拠が得られなかったため、関係を作らない"
      },
      {
        "what": "カラムと応答項目の対応づけ（maps）",
        "why": "確認にはレスポンス本文の読み取りが必要で、収集禁止項目にあたるため行わなかった"
      },
      {
        "what": "表示された値そのもの",
        "why": "方針として保存しない。対応付けは要素識別子・同一識別子内の順番・テキストノード索引で行い、値を鍵に使わない"
      },
      {
        "what": "ライブラリ由来か動的生成かの区別",
        "why": "識別子を持たない要素について、両者を DOM からは区別できなかった。いずれも「特定不能」と返す"
      },
      {
        "what": "どの使用箇所がこのインスタンスを描いたか",
        "why": "同じコンポーネントが複数箇所で使われる場合、DOM からは使用箇所を一意に決められない"
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
        "why": "PoC-02 の検証対象"
      }
    ],
    "excluded": {
      "staticAssetRequests": 16,
      "note": "静的資材（/_next/*・画像・フォント）は「通信」として数えていない"
    }
  },
  "page": {
    "path": "/cards",
    "name": "物件カード",
    "startMs": 1793459667560.781
  },
  "focus": {
    "method": "GET",
    "path": "/api/listings"
  },
  "browserRequests": [
    {
      "method": "GET",
      "path": "/cards",
      "status": 200,
      "startMs": 1793459667560.781,
      "durationMs": 31.49,
      "server": {
        "traceId": "a39d621e434ba49930f13fa0b7298f89",
        "spanId": "00c477dcac76f88b"
      },
      "isDocument": true
    },
    {
      "method": "GET",
      "path": "/api/listings",
      "status": 200,
      "startMs": 1793459667754.982,
      "durationMs": 9.69,
      "server": {
        "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
        "spanId": "3ee4c120c337e9d7"
      },
      "isDocument": false
    }
  ],
  "spans": [
    {
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "221d55940d55ac9e",
      "parentSpanId": "8807672e607f1ecd",
      "name": "load route module",
      "kind": 0,
      "startMs": 1793459667757,
      "endMs": 1793459667757.1711,
      "durationMs": 0.171208,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "8807672e607f1ecd",
      "parentSpanId": "919bd87c8ed596bf",
      "name": "LoadComponents.loadComponents",
      "kind": 0,
      "startMs": 1793459667757,
      "endMs": 1793459667757.3638,
      "durationMs": 0.363708,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "919bd87c8ed596bf",
      "parentSpanId": "ef1eacb74090f66c",
      "name": "resolve page components",
      "kind": 0,
      "startMs": 1793459667757,
      "endMs": 1793459667757.4153,
      "durationMs": 0.41525,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "7ad62225fd139a66",
      "parentSpanId": "e1f87345ceb93274",
      "name": "load route manifests",
      "kind": 0,
      "startMs": 1793459667758,
      "endMs": 1793459667758.898,
      "durationMs": 0.897958,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "e1f87345ceb93274",
      "parentSpanId": "5626eef21529449c",
      "name": "prepare route module",
      "kind": 0,
      "startMs": 1793459667758,
      "endMs": 1793459667759.1216,
      "durationMs": 1.121542,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "095e8c04aaa2bbbf",
      "parentSpanId": "773ac2057c6ca9f8",
      "name": "prisma:client:serialize",
      "kind": 0,
      "startMs": 1793459667759,
      "endMs": 1793459667759.0566,
      "durationMs": 0.056584,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "fd5e1ec193ca9ec6",
      "parentSpanId": "9007ec670d86726e",
      "name": "prisma:engine:connection",
      "kind": 0,
      "startMs": 1793459667760.24,
      "endMs": 1793459667760.258,
      "durationMs": 0.018,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {
        "db.system": "postgresql"
      },
      "droppedAttributeKeys": []
    },
    {
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "089f7acc7116a9d4",
      "parentSpanId": "9007ec670d86726e",
      "name": "prisma:engine:db_query",
      "kind": 2,
      "startMs": 1793459667760.397,
      "endMs": 1793459667762.2583,
      "durationMs": 1.86125,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {
        "db.query.text": "SELECT \"poc\".\"listings\".\"id\", \"poc\".\"listings\".\"code\", \"poc\".\"listings\".\"region\" FROM \"poc\".\"listings\" WHERE $0=$0 ORDER BY \"poc\".\"listings\".\"id\" ASC LIMIT $1 OFFSET $2",
        "db.system": "postgresql"
      },
      "droppedAttributeKeys": []
    },
    {
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "e91b8721efbf48ef",
      "parentSpanId": "9007ec670d86726e",
      "name": "prisma:engine:serialize",
      "kind": 0,
      "startMs": 1793459667762.276,
      "endMs": 1793459667762.301,
      "durationMs": 0.024959,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "410d8e8ff22882b9",
      "parentSpanId": "9007ec670d86726e",
      "name": "prisma:engine:response_json_serialization",
      "kind": 0,
      "startMs": 1793459667762.314,
      "endMs": 1793459667762.3198,
      "durationMs": 0.00575,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "9007ec670d86726e",
      "parentSpanId": "773ac2057c6ca9f8",
      "name": "prisma:engine:query",
      "kind": 0,
      "startMs": 1793459667760.204,
      "endMs": 1793459667762.3218,
      "durationMs": 2.117875,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "773ac2057c6ca9f8",
      "parentSpanId": "82d9b60af7776511",
      "name": "prisma:client:operation",
      "kind": 0,
      "startMs": 1793459667759,
      "endMs": 1793459667762.2034,
      "durationMs": 3.203416,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "82d9b60af7776511",
      "parentSpanId": "5626eef21529449c",
      "name": "executing api route (app) /api/listings",
      "kind": 0,
      "startMs": 1793459667759,
      "endMs": 1793459667762.55,
      "durationMs": 3.550166,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "8015b266a928f3b6",
      "parentSpanId": "5626eef21529449c",
      "name": "start response",
      "kind": 0,
      "startMs": 1793459667763,
      "endMs": 1793459667763.0105,
      "durationMs": 0.010417,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "3ee4c120c337e9d7",
      "parentSpanId": null,
      "name": "GET",
      "kind": 1,
      "startMs": 1793459667755,
      "endMs": 1793459667763.7224,
      "durationMs": 8.722458,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "5626eef21529449c",
      "parentSpanId": "ef1eacb74090f66c",
      "name": "BaseServer.renderToResponseWithComponents",
      "kind": 0,
      "startMs": 1793459667757,
      "endMs": 1793459667763.2405,
      "durationMs": 6.240542,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "ef1eacb74090f66c",
      "parentSpanId": "2d121fc399eb33a2",
      "name": "rendering page",
      "kind": 0,
      "startMs": 1793459667757,
      "endMs": 1793459667763.853,
      "durationMs": 6.853125,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "2d121fc399eb33a2",
      "parentSpanId": "a94f838465ed400b",
      "name": "BaseServer.pipe",
      "kind": 0,
      "startMs": 1793459667757,
      "endMs": 1793459667763.9026,
      "durationMs": 6.902541,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "a94f838465ed400b",
      "parentSpanId": "a259664dc96d2d57",
      "name": "BaseServer.render",
      "kind": 0,
      "startMs": 1793459667757,
      "endMs": 1793459667763.956,
      "durationMs": 6.955958,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "a259664dc96d2d57",
      "parentSpanId": "44706a50c0cdd3db",
      "name": "GET",
      "kind": 1,
      "startMs": 1793459667757,
      "endMs": 1793459667764.2312,
      "durationMs": 7.231125,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "44706a50c0cdd3db",
      "parentSpanId": "05756dee69154af9",
      "name": "NextServer.getServerRequestHandler",
      "kind": 0,
      "startMs": 1793459667756,
      "endMs": 1793459667763.4282,
      "durationMs": 7.428292,
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
      "traceId": "67be2f34b3d6622ee2f8e46d10b97c83",
      "spanId": "05756dee69154af9",
      "parentSpanId": "3ee4c120c337e9d7",
      "name": "NextServer.getRequestHandler",
      "kind": 0,
      "startMs": 1793459667756,
      "endMs": 1793459667763.5183,
      "durationMs": 7.518208,
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
      "spanId": "089f7acc7116a9d4",
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
  },
  "elements": {
    "method": "方式1 ビルド時の要素識別子注入（JSX へ data-vcide を挿入）",
    "bundler": "turbopack",
    "injectedScope": "src/",
    "transform": "挿入のみ。再出力しないため行番号はずれない。ソースマップに依存しない",
    "page": "/cards",
    "anchoredElements": 27,
    "totalElements": 63,
    "primaryKey": "badge-text",
    "selections": [
      {
        "key": "main",
        "selector": "main.cards",
        "ordinal": 0,
        "group": "own-client",
        "primary": false,
        "tag": "main",
        "anchorOnSelf": "2dbe4989ce",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "h1",
        "selector": "main.cards > h1",
        "ordinal": 0,
        "group": "own-client",
        "primary": false,
        "tag": "h1",
        "anchorOnSelf": "f57f43c8ae",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [
          "2dbe4989ce"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 5,
          "cls": "cjk"
        },
        "failure": null
      },
      {
        "key": "static-p",
        "selector": "p.static",
        "ordinal": 0,
        "group": "own-client",
        "primary": false,
        "tag": "p",
        "anchorOnSelf": "2ec716e014",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [
          "2dbe4989ce"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 24,
          "cls": "cjk"
        },
        "failure": null
      },
      {
        "key": "grid",
        "selector": "div.grid",
        "ordinal": 0,
        "group": "own-client",
        "primary": false,
        "tag": "div",
        "anchorOnSelf": "0500ac6da8",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "in-slot",
        "selector": "span.in-slot",
        "ordinal": 0,
        "group": "own-client",
        "primary": false,
        "tag": "span",
        "anchorOnSelf": "48d99ff7db",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [
          "2dbe4989ce"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 20,
          "cls": "mixed"
        },
        "failure": null
      },
      {
        "key": "slot",
        "selector": "div.slot",
        "ordinal": 0,
        "group": "own-client",
        "primary": false,
        "tag": "div",
        "anchorOnSelf": "5d20141eb7",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "card-0",
        "selector": "article.card",
        "ordinal": 0,
        "group": "repeated",
        "primary": false,
        "tag": "article",
        "anchorOnSelf": "91000588c3",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "card-1",
        "selector": "article.card",
        "ordinal": 1,
        "group": "repeated",
        "primary": false,
        "tag": "article",
        "anchorOnSelf": "91000588c3",
        "anchorOrdinal": 1,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "card-2",
        "selector": "article.card",
        "ordinal": 2,
        "group": "repeated",
        "primary": false,
        "tag": "article",
        "anchorOnSelf": "91000588c3",
        "anchorOrdinal": 2,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "card-head",
        "selector": "header.card-head",
        "ordinal": 0,
        "group": "props",
        "primary": false,
        "tag": "header",
        "anchorOnSelf": "a5d48c1380",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "91000588c3",
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "card-code",
        "selector": "article.card span.code",
        "ordinal": 0,
        "group": "props",
        "primary": false,
        "tag": "span",
        "anchorOnSelf": "81f0c034df",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "a5d48c1380",
          "91000588c3",
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 9,
          "cls": "latin"
        },
        "failure": null
      },
      {
        "key": "card-body",
        "selector": "div.card-body",
        "ordinal": 0,
        "group": "props",
        "primary": false,
        "tag": "div",
        "anchorOnSelf": "72cdf7d0b8",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "91000588c3",
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "badge",
        "selector": "span.badge",
        "ordinal": 0,
        "group": "nested",
        "primary": false,
        "tag": "span",
        "anchorOnSelf": "b66777e04e",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "72cdf7d0b8",
          "91000588c3",
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "badge-dot",
        "selector": "span.badge-dot",
        "ordinal": 0,
        "group": "nested",
        "primary": false,
        "tag": "span",
        "anchorOnSelf": "cf8474c96b",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "b66777e04e",
          "72cdf7d0b8",
          "91000588c3",
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": null
      },
      {
        "key": "badge-text",
        "selector": "span.badge-text",
        "ordinal": 0,
        "group": "nested",
        "primary": true,
        "tag": "span",
        "anchorOnSelf": "9d8bc0d72e",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "b66777e04e",
          "72cdf7d0b8",
          "91000588c3",
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 5,
          "cls": "cjk"
        },
        "failure": null
      },
      {
        "key": "badge-text-2",
        "selector": "span.badge-text",
        "ordinal": 2,
        "group": "repeated",
        "primary": false,
        "tag": "span",
        "anchorOnSelf": "9d8bc0d72e",
        "anchorOrdinal": 2,
        "anchorInstanceCount": 3,
        "ancestorAnchors": [
          "b66777e04e",
          "72cdf7d0b8",
          "91000588c3",
          "0500ac6da8",
          "2dbe4989ce"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 4,
          "cls": "cjk"
        },
        "failure": null
      },
      {
        "key": "vendor-root",
        "selector": "section.vendor",
        "ordinal": 0,
        "group": "library",
        "primary": false,
        "tag": "section",
        "anchorOnSelf": null,
        "anchorOrdinal": null,
        "anchorInstanceCount": 0,
        "ancestorAnchors": [
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": {
          "reason": "anchor-missing",
          "detail": "祖先には識別子があるが、この要素自身には無い"
        }
      },
      {
        "key": "vendor-title",
        "selector": "h3.vendor-title",
        "ordinal": 0,
        "group": "library",
        "primary": false,
        "tag": "h3",
        "anchorOnSelf": null,
        "anchorOrdinal": null,
        "anchorInstanceCount": 0,
        "ancestorAnchors": [
          "2dbe4989ce"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 9,
          "cls": "cjk"
        },
        "failure": {
          "reason": "anchor-missing",
          "detail": "祖先には識別子があるが、この要素自身には無い"
        }
      },
      {
        "key": "vendor-slot",
        "selector": "div.vendor-slot",
        "ordinal": 0,
        "group": "library",
        "primary": false,
        "tag": "div",
        "anchorOnSelf": null,
        "anchorOrdinal": null,
        "anchorInstanceCount": 0,
        "ancestorAnchors": [
          "2dbe4989ce"
        ],
        "textNodeIndex": null,
        "valueShape": null,
        "failure": {
          "reason": "anchor-missing",
          "detail": "祖先には識別子があるが、この要素自身には無い"
        }
      },
      {
        "key": "dynamic",
        "selector": "span.injected",
        "ordinal": 0,
        "group": "no-jsx",
        "primary": false,
        "tag": "span",
        "anchorOnSelf": null,
        "anchorOrdinal": null,
        "anchorInstanceCount": 0,
        "ancestorAnchors": [
          "5d20141eb7",
          "2dbe4989ce"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 4,
          "cls": "cjk"
        },
        "failure": {
          "reason": "anchor-missing",
          "detail": "祖先には識別子があるが、この要素自身には無い"
        }
      }
    ],
    "anchors": [
      {
        "id": "2dbe4989ce",
        "tag": "main",
        "file": "src/app/cards/page.tsx",
        "line": 42,
        "col": 5,
        "component": "Cards",
        "componentLine": 17,
        "verified": true,
        "sourceLine": "<main className=\"cards\" onClick={probe}>"
      },
      {
        "id": "f57f43c8ae",
        "tag": "h1",
        "file": "src/app/cards/page.tsx",
        "line": 43,
        "col": 7,
        "component": "Cards",
        "componentLine": 17,
        "verified": true,
        "sourceLine": "<h1>物件カード</h1>"
      },
      {
        "id": "2ec716e014",
        "tag": "p",
        "file": "src/app/cards/page.tsx",
        "line": 44,
        "col": 7,
        "component": "Cards",
        "componentLine": 17,
        "verified": true,
        "sourceLine": "<p className=\"static\">合成データのみ。実在の地名も個人情報も含まない。</p>"
      },
      {
        "id": "0500ac6da8",
        "tag": "div",
        "file": "src/app/cards/page.tsx",
        "line": 45,
        "col": 7,
        "component": "Cards",
        "componentLine": 17,
        "verified": true,
        "sourceLine": "<div className=\"grid\">"
      },
      {
        "id": "48d99ff7db",
        "tag": "span",
        "file": "src/app/cards/page.tsx",
        "line": 49,
        "col": 9,
        "component": "Cards",
        "componentLine": 17,
        "verified": true,
        "sourceLine": "<span className=\"in-slot\">枠の中身はこのファイルの JSX である</span>"
      },
      {
        "id": "5d20141eb7",
        "tag": "div",
        "file": "src/app/cards/page.tsx",
        "line": 51,
        "col": 7,
        "component": "Cards",
        "componentLine": 17,
        "verified": true,
        "sourceLine": "<div className=\"slot\" ref={slot} />"
      },
      {
        "id": "91000588c3",
        "tag": "article",
        "file": "src/components/ListingCard.tsx",
        "line": 12,
        "col": 5,
        "component": "ListingCard",
        "componentLine": 10,
        "verified": true,
        "sourceLine": "<article className=\"card\" data-poc-kind=\"listing-card\">"
      },
      {
        "id": "a5d48c1380",
        "tag": "header",
        "file": "src/components/ListingCard.tsx",
        "line": 13,
        "col": 7,
        "component": "ListingCard",
        "componentLine": 10,
        "verified": true,
        "sourceLine": "<header className=\"card-head\">"
      },
      {
        "id": "81f0c034df",
        "tag": "span",
        "file": "src/components/ListingCard.tsx",
        "line": 14,
        "col": 9,
        "component": "ListingCard",
        "componentLine": 10,
        "verified": true,
        "sourceLine": "<span className=\"code\">{listing.code}</span>"
      },
      {
        "id": "72cdf7d0b8",
        "tag": "div",
        "file": "src/components/ListingCard.tsx",
        "line": 16,
        "col": 7,
        "component": "ListingCard",
        "componentLine": 10,
        "verified": true,
        "sourceLine": "<div className=\"card-body\">"
      },
      {
        "id": "b66777e04e",
        "tag": "span",
        "file": "src/components/RegionBadge.tsx",
        "line": 6,
        "col": 5,
        "component": "RegionBadge",
        "componentLine": 4,
        "verified": true,
        "sourceLine": "<span className=\"badge\">"
      },
      {
        "id": "cf8474c96b",
        "tag": "span",
        "file": "src/components/RegionBadge.tsx",
        "line": 7,
        "col": 7,
        "component": "RegionBadge",
        "componentLine": 4,
        "verified": true,
        "sourceLine": "<span className=\"badge-dot\" aria-hidden=\"true\" />"
      },
      {
        "id": "9d8bc0d72e",
        "tag": "span",
        "file": "src/components/RegionBadge.tsx",
        "line": 8,
        "col": 7,
        "component": "RegionBadge",
        "componentLine": 4,
        "verified": true,
        "sourceLine": "<span className=\"badge-text\">{region}</span>"
      }
    ],
    "files": [
      {
        "file": "src/components/ListingCard.tsx",
        "anchors": 4,
        "usages": 1,
        "skipped": []
      },
      {
        "file": "src/app/cards/page.tsx",
        "anchors": 6,
        "usages": 2,
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
        "file": "src/components/RegionBadge.tsx",
        "anchors": 3,
        "usages": 0,
        "skipped": []
      }
    ]
  }
} as const;
