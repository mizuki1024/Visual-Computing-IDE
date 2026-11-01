/* =============================================================================
 * 自動生成（poc/runner/build-poc05-observation.mjs）。手で編集しない。
 *
 * PoC-05 で実際に観測した1回の操作の記録である。合成データではない。
 * **表示された値そのもの・レスポンス本文・ヘッダ一覧は含まない。**
 * 相関のために読んだ応答ヘッダは2つのキーだけである。
 * ========================================================================== */
import type { ObservationBundle } from '../lib/observation';

export const FLOW_OBSERVATION: ObservationBundle = {
  "meta": {
    "poc": "PoC-05",
    "collectedAt": "2026-10-31T16:08:22Z",
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
          "path": "/cards"
        },
        {
          "icon": "◈",
          "name": "通信の経路",
          "path": "/flows",
          "current": true
        },
        {
          "icon": "◇",
          "name": "通信の経路（サーバー描画）",
          "path": "/flows-rsc"
        }
      ]
    },
    "instrumentation": {
      "method": "方式2 NODE_OPTIONS=--require ＋ 応答ヘッダへの識別子 ＋ ビルド時の要素識別子注入",
      "detail": "プロジェクトへファイルを追加せず、環境変数で計装モジュールを前置した。ブラウザとサーバーの対応付けは応答の専用ヘッダに載せた識別子の一致で行い、通信を開始したコードはブラウザが記録した呼び出しスタックから解いた",
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
        "why": "この通信の応答のどの項目が、画面のどの値になったかは観測できない。02a 3.5.1 により構造的に推定であり、関係を作らない"
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
        "what": "ブラウザからサーバーへのトレース伝播",
        "why": "ブラウザ側に計装を入れないため、要求に traceparent を載せていない。サーバー側の入口スパンはすべて根であり、対応付けは応答側で行っている"
      },
      {
        "what": "サーバーの中で起きる通信の相手（Server Component の fetch）",
        "why": "Next.js の fetch は node:http を通らず、要求にトレースコンテキストが載らない。呼び出し側のスパンは観測できるが、相手のハンドラは別トレースになる"
      },
      {
        "what": "応答が返らなかった通信のサーバー側",
        "why": "識別子は応答ヘッダから読む。応答が無い通信は対応付けられない。時間の重なりで推定することはしない"
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
        "what": "どの使用箇所がこのインスタンスを描いたか",
        "why": "同じコンポーネントが複数箇所で使われる場合、DOM からは使用箇所を一意に決められない"
      }
    ],
    "excluded": {
      "staticAssetRequests": 17,
      "note": "静的資材（/_next/*・画像・フォント）は「通信」として数えていない"
    }
  },
  "page": {
    "path": "/flows",
    "name": "通信の経路",
    "startMs": 1793462896386.036
  },
  "focus": {
    "method": "GET",
    "path": "/api/listings"
  },
  "browserRequests": [
    {
      "method": "GET",
      "path": "/flows",
      "status": 200,
      "startMs": 1793462896386.036,
      "durationMs": 31.74,
      "server": {
        "traceId": "ccb811299a9712055fa76a130126cb88",
        "spanId": "0cb7d53654d61734"
      },
      "isDocument": true,
      "browserRequestId": "8C490037133FB1DA920B31518FA73508",
      "via": "dedicated-header",
      "headersAgree": true,
      "readHeaderKeys": [
        "server-timing",
        "x-vcide-trace"
      ],
      "redirects": [],
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
    },
    {
      "method": "GET",
      "path": "/api/listings",
      "status": 200,
      "startMs": 1793462897085.603,
      "durationMs": 12.02,
      "server": {
        "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
        "spanId": "c204af5d834727d3"
      },
      "isDocument": false,
      "browserRequestId": "10400.41",
      "via": "dedicated-header",
      "headersAgree": true,
      "readHeaderKeys": [
        "server-timing",
        "x-vcide-trace"
      ],
      "redirects": [],
      "failure": null,
      "hasQuery": false,
      "crossOrigin": null,
      "initiator": {
        "type": "script",
        "frameCount": 8,
        "frame": {
          "file": "src/app/flows/page.tsx",
          "line": 30,
          "col": 23,
          "functionName": "one"
        },
        "verified": true,
        "sourceLine": "const res = await fetch('/api/listings', NO_STORE);",
        "component": {
          "name": "Flows",
          "file": "src/app/flows/page.tsx",
          "line": 23,
          "endLine": 109
        },
        "failure": null
      }
    },
    {
      "method": "GET",
      "path": "/api/cors",
      "status": 200,
      "startMs": 1793462897531.807,
      "durationMs": 94.01,
      "server": {
        "traceId": "f9e7a54c6044d9f95c30598b374f8216",
        "spanId": "3a8e15a5657f1bbf"
      },
      "isDocument": false,
      "browserRequestId": "10400.42",
      "via": "dedicated-header",
      "headersAgree": true,
      "readHeaderKeys": [
        "server-timing",
        "x-vcide-trace"
      ],
      "redirects": [],
      "failure": null,
      "hasQuery": false,
      "crossOrigin": "http://127.0.0.1:3200",
      "initiator": {
        "type": "script",
        "frameCount": 4,
        "frame": null,
        "verified": false,
        "sourceLine": null,
        "component": null,
        "failure": {
          "reason": "no-app-frame",
          "detail": "注入範囲（src/）のソース位置へ解決できるフレームが無い"
        }
      }
    }
  ],
  "spans": [
    {
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "5eddb158ac787fd9",
      "parentSpanId": "ec8a57a21e5fc6f2",
      "name": "load route module",
      "kind": 0,
      "startMs": 1793462897089,
      "endMs": 1793462897089.1785,
      "durationMs": 0.178375,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "ec8a57a21e5fc6f2",
      "parentSpanId": "b65305628be95a8c",
      "name": "LoadComponents.loadComponents",
      "kind": 0,
      "startMs": 1793462897089,
      "endMs": 1793462897089.3892,
      "durationMs": 0.389083,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "b65305628be95a8c",
      "parentSpanId": "7cee46767be6b411",
      "name": "resolve page components",
      "kind": 0,
      "startMs": 1793462897089,
      "endMs": 1793462897089.4407,
      "durationMs": 0.440584,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "30e5cee6aa0c3f89",
      "parentSpanId": "b6391e5258f23c4d",
      "name": "load route manifests",
      "kind": 0,
      "startMs": 1793462897090,
      "endMs": 1793462897090.9553,
      "durationMs": 0.955333,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "b6391e5258f23c4d",
      "parentSpanId": "573ff74bc833aa66",
      "name": "prepare route module",
      "kind": 0,
      "startMs": 1793462897090,
      "endMs": 1793462897091.1973,
      "durationMs": 1.197208,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "d3ff2aea93fc2474",
      "parentSpanId": "dc91102a7a0eccfa",
      "name": "prisma:client:serialize",
      "kind": 0,
      "startMs": 1793462897092,
      "endMs": 1793462897092.058,
      "durationMs": 0.058166,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "7196077f939ee5c2",
      "parentSpanId": "cd2d371a036098bb",
      "name": "prisma:engine:connection",
      "kind": 0,
      "startMs": 1793462897092.617,
      "endMs": 1793462897092.6414,
      "durationMs": 0.024417,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {
        "db.system": "postgresql"
      },
      "droppedAttributeKeys": []
    },
    {
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "852fe4ced3b25f8a",
      "parentSpanId": "cd2d371a036098bb",
      "name": "prisma:engine:db_query",
      "kind": 2,
      "startMs": 1793462897092.799,
      "endMs": 1793462897095.8372,
      "durationMs": 3.038208,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {
        "db.system": "postgresql",
        "db.query.text": "SELECT \"poc\".\"listings\".\"id\", \"poc\".\"listings\".\"code\", \"poc\".\"listings\".\"region\" FROM \"poc\".\"listings\" WHERE $0=$0 ORDER BY \"poc\".\"listings\".\"id\" ASC LIMIT $1 OFFSET $2"
      },
      "droppedAttributeKeys": []
    },
    {
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "2afaf6f867b68f3d",
      "parentSpanId": "cd2d371a036098bb",
      "name": "prisma:engine:serialize",
      "kind": 0,
      "startMs": 1793462897095.852,
      "endMs": 1793462897095.8787,
      "durationMs": 0.02675,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "4e462c06cb44efc5",
      "parentSpanId": "cd2d371a036098bb",
      "name": "prisma:engine:response_json_serialization",
      "kind": 0,
      "startMs": 1793462897095.893,
      "endMs": 1793462897095.899,
      "durationMs": 0.005875,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "cd2d371a036098bb",
      "parentSpanId": "dc91102a7a0eccfa",
      "name": "prisma:engine:query",
      "kind": 0,
      "startMs": 1793462897092.568,
      "endMs": 1793462897095.901,
      "durationMs": 3.332791,
      "statusCode": 0,
      "scope": "prisma",
      "attrs": {},
      "droppedAttributeKeys": []
    },
    {
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "dc91102a7a0eccfa",
      "parentSpanId": "125fb711db82fec7",
      "name": "prisma:client:operation",
      "kind": 0,
      "startMs": 1793462897092,
      "endMs": 1793462897096.1892,
      "durationMs": 4.18925,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "125fb711db82fec7",
      "parentSpanId": "573ff74bc833aa66",
      "name": "executing api route (app) /api/listings",
      "kind": 0,
      "startMs": 1793462897092,
      "endMs": 1793462897096.5107,
      "durationMs": 4.510708,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "684f6bda8076ea46",
      "parentSpanId": "573ff74bc833aa66",
      "name": "start response",
      "kind": 0,
      "startMs": 1793462897097,
      "endMs": 1793462897097.0088,
      "durationMs": 0.00875,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "c204af5d834727d3",
      "parentSpanId": null,
      "name": "GET",
      "kind": 1,
      "startMs": 1793462897086,
      "endMs": 1793462897096.7295,
      "durationMs": 10.729417,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "573ff74bc833aa66",
      "parentSpanId": "7cee46767be6b411",
      "name": "BaseServer.renderToResponseWithComponents",
      "kind": 0,
      "startMs": 1793462897090,
      "endMs": 1793462897097.8125,
      "durationMs": 7.812458,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "7cee46767be6b411",
      "parentSpanId": "480573340fdcb3c2",
      "name": "rendering page",
      "kind": 0,
      "startMs": 1793462897089,
      "endMs": 1793462897097.496,
      "durationMs": 8.496166,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "480573340fdcb3c2",
      "parentSpanId": "74eb58c3a6a8ae84",
      "name": "BaseServer.pipe",
      "kind": 0,
      "startMs": 1793462897089,
      "endMs": 1793462897097.558,
      "durationMs": 8.558,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "74eb58c3a6a8ae84",
      "parentSpanId": "851f7c2e9059a233",
      "name": "BaseServer.render",
      "kind": 0,
      "startMs": 1793462897089,
      "endMs": 1793462897097.618,
      "durationMs": 8.617875,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "851f7c2e9059a233",
      "parentSpanId": "9eeb31720cb4b6a8",
      "name": "GET",
      "kind": 1,
      "startMs": 1793462897089,
      "endMs": 1793462897097.9302,
      "durationMs": 8.930083,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "9eeb31720cb4b6a8",
      "parentSpanId": "e1fa90aec67a863b",
      "name": "NextServer.getServerRequestHandler",
      "kind": 0,
      "startMs": 1793462897089,
      "endMs": 1793462897098.112,
      "durationMs": 9.112042,
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
      "traceId": "20db5ec31196a3648cd34d7b3a5a8d4e",
      "spanId": "e1fa90aec67a863b",
      "parentSpanId": "c204af5d834727d3",
      "name": "NextServer.getRequestHandler",
      "kind": 0,
      "startMs": 1793462897088,
      "endMs": 1793462897097.1907,
      "durationMs": 9.190708,
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
      "spanId": "852fe4ced3b25f8a",
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
    "page": "/flows",
    "anchoredElements": 29,
    "totalElements": 61,
    "primaryKey": "badge-text",
    "selections": [
      {
        "key": "badge-text",
        "selector": "span.badge-text",
        "ordinal": 0,
        "group": "nested",
        "primary": true,
        "tag": "span",
        "anchorOnSelf": "9d8bc0d72e",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 2,
        "ancestorAnchors": [
          "b66777e04e",
          "72cdf7d0b8",
          "91000588c3",
          "91d41cb38d",
          "36f41055df"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 5,
          "cls": "cjk"
        },
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
        "anchorInstanceCount": 2,
        "ancestorAnchors": [
          "a5d48c1380",
          "91000588c3",
          "91d41cb38d",
          "36f41055df"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 9,
          "cls": "latin"
        },
        "failure": null
      },
      {
        "key": "h1",
        "selector": "main.flows > h1",
        "ordinal": 0,
        "group": "own-client",
        "primary": false,
        "tag": "h1",
        "anchorOnSelf": "1055bb5c57",
        "anchorOrdinal": 0,
        "anchorInstanceCount": 1,
        "ancestorAnchors": [
          "36f41055df"
        ],
        "textNodeIndex": 0,
        "valueShape": {
          "chars": 13,
          "cls": "mixed"
        },
        "failure": null
      }
    ],
    "anchors": [
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
        "id": "1055bb5c57",
        "tag": "h1",
        "file": "src/app/flows/page.tsx",
        "line": 90,
        "col": 7,
        "component": "Flows",
        "componentLine": 23,
        "verified": true,
        "sourceLine": "<h1>通信の経路（PoC-05）</h1>"
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
        "file": "src/components/FetchButton.tsx",
        "anchors": 1,
        "usages": 0,
        "skipped": []
      },
      {
        "file": "src/app/flows/page.tsx",
        "anchors": 14,
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
  },
  "exposure": {
    "serverTimingVisibleToPageScript": 1,
    "resourceEntries": 19,
    "dedicatedHeaderVisibleToPageScript": false,
    "crossOrigin": {
      "origin": "http://127.0.0.1:3200",
      "serverTimingReadable": false,
      "dedicatedReadable": false
    },
    "readableViaCdp": true
  }
} as const;
