/* =============================================================================
 * 取得時点のマスキング。「集めてから消す」ではなく「集めない」。
 *
 * 禁止（05c 3章 / NFR-20）:
 *   SQLのパラメータ値 / 接続文字列 / Cookie / Authorization / アクセストークン /
 *   パスワード / 個人情報 / DBから返った行データ / リクエスト・レスポンス本文
 *
 * 方針: 属性キーの許可リスト（これ以外は値を一切読まずに捨てる）＋
 *       残した文字列に対する秘密情報の走査 ＋ SQL文のリテラル除去。
 * ========================================================================== */

/** 残してよい属性キー。ここに無いキーは「名前だけ」を記録し、値は読まない。 */
const ALLOW = new Set([
  // HTTP（メソッド・経路・ステータス・ルートパターンのみ。ヘッダと本文は無い）
  'http.request.method', 'http.method',
  'http.route',
  'http.response.status_code', 'http.status_code',
  'url.path', 'url.scheme', 'http.target',
  // PoC-02: サーバー内部の通信の宛先。**ループバックのみ**を計装しているので
  // 実ホスト名は入らない。url.full / url.query は許可しない（値が入りうる）
  'server.address', 'server.port',
  // DB（文の構造・対象・件数のみ。パラメータ値と行データは無い）
  'db.system', 'db.system.name',
  'db.namespace', 'db.name',
  'db.operation.name', 'db.operation',
  'db.collection.name', 'db.sql.table',
  'db.statement', 'db.query.text',
  'db.response.returned_rows', 'db.rows_affected',
  // Prisma 計装が付ける構造情報
  'method', 'model', 'name',
  // Next.js 計装
  'next.route', 'next.span_type', 'next.rsc', 'next.page', 'next.segment',
  // Phase 7B-3B-1: IDE のプレビュー中継が要求ごとに作った識別子（16進 32 桁の乱数）。
  // 値の形は RELAY_ID で検査し、形が違えば捨てる
  'vcide.relay.id',
]);

/** 中継の識別子の形。**これ以外の値は記録しない**（任意の文字列をスパンに運ばせない） */
const RELAY_ID = /^[0-9a-f]{32}$/;

/** 値に現れたら、その属性を丸ごと捨てる（キー名が許可リストにあっても捨てる）。 */
const SECRET_VALUE = [
  /postgres(ql)?:\/\//i,
  /\bpassword\s*=/i,
  /\bbearer\s+[\w.-]+/i,
  /\bauthorization\b/i,
  /\bcookie\b/i,
  /\b(access|refresh|id)_token\b/i,
  /\bsecret\b/i,
  /\bapi[_-]?key\b/i,
];

/** キー名そのものが機密を示すもの。許可リストより先に効かせる。 */
const SECRET_KEY = /cookie|authorization|password|secret|token|api[_-]?key|connection[_-]?string|\.env\b|credential/i;

/** 値を消した跡。PostgreSQL のパラメータ記法なので、文として妥当なまま残る */
const REDACTED = '$0';

/** 単一引用符の文字列リテラル（'' による自己エスケープを含む） */
const SQL_STRING = /'(?:[^']|'')*'/g;
/** 数値リテラル。識別子の一部（col1）・プレースホルダ（$1）・修飾名は避ける */
const SQL_NUMBER = /(?<![\w$."])\d+(?:\.\d+)?(?![\w.])/g;

/**
 * SQL文からリテラルを取り除く。構造だけを残す。
 * 置換後も構文として妥当であること（後段の構文解析に掛けるため）。
 */
function redactSql(sql) {
  if (typeof sql !== 'string') return null;
  let strings = 0;
  let numbers = 0;
  // 値を消した跡は、プレースホルダの形で残す。
  // 置換後も構文解析に掛けられる形でなければならない（'?' は PostgreSQL 方言で通らない）
  let out = sql.replace(SQL_STRING, () => { strings++; return REDACTED; });
  out = out.replace(SQL_NUMBER, () => { numbers++; return REDACTED; });
  return { text: out.replace(/\s+/g, ' ').trim(), redacted: { strings, numbers } };
}

/** URL からクエリ文字列を落とす（クエリに値が入るため） */
function stripQuery(v) {
  return typeof v === 'string' ? v.split('?')[0].split('#')[0] : v;
}

/**
 * スパン属性のマスキング。
 * @returns {{attrs: object, droppedKeys: string[], redacted: object|null}}
 */
function maskAttributes(raw) {
  const attrs = {};
  const droppedKeys = [];
  let redacted = null;

  for (const key of Object.keys(raw || {})) {
    if (SECRET_KEY.test(key) || !ALLOW.has(key)) { droppedKeys.push(key); continue; }
    let value = raw[key];

    if (key === 'db.statement' || key === 'db.query.text') {
      const r = redactSql(value);
      if (!r) { droppedKeys.push(key); continue; }
      value = r.text;
      redacted = r.redacted;
    } else if (key === 'http.target' || key === 'url.path') {
      value = stripQuery(value);
    } else if (key === 'vcide.relay.id' && !(typeof value === 'string' && RELAY_ID.test(value))) {
      droppedKeys.push(key);
      continue;
    }

    if (typeof value === 'string' && SECRET_VALUE.some((re) => re.test(value))) {
      droppedKeys.push(key);
      continue;
    }
    if (typeof value === 'object' && value !== null) { droppedKeys.push(key); continue; }
    attrs[key] = value;
  }
  return { attrs, droppedKeys, redacted };
}

module.exports = { maskAttributes, redactSql, ALLOW, SECRET_KEY, SECRET_VALUE, RELAY_ID };
