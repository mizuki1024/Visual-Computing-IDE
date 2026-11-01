/* =============================================================================
 * 方式4（PostgreSQL のログ）。これ自体は「どのリクエストが出したか」を紐付けられない
 * ため経路には使えないが、**取得率の分母の独立した基準**として使える。
 * パラメータ値はサーバー設定で出力を止めている（log_parameter_max_length=0）。
 * ========================================================================== */
import { spawnSync } from 'node:child_process';
import { PG_CONTAINER } from './util.mjs';

/** docker logs は PostgreSQL のログを stderr に出す。両方を繋いで読む。 */
const dump = () => {
  const r = spawnSync('docker', ['logs', PG_CONTAINER],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return (r.stdout ?? '') + (r.stderr ?? '');
};

export function snapshot() {
  return dump().length;
}

const DML = /^(select|insert|update|delete|with)\b/i;

/** ログ1件の先頭行（log_line_prefix = '%m [%p] '）。複数行の文は続きの行に跨る */
const HEAD = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ \w+ \[\d+\] /;

/**
 * スナップショット以降に DB が受け取った文を取り出す。
 * statement: / execute <name>: の行だけを見る。DETAIL 行は読まない
 * （パラメータ値はサーバー設定で出力を止めてある）。
 */
export function since(offset) {
  const text = dump().slice(offset);
  /** @type {string[][]} */
  const records = [];
  for (const line of text.split('\n')) {
    if (HEAD.test(line)) records.push([line]);
    else if (records.length) records[records.length - 1].push(line);
  }
  const all = [];
  for (const rec of records) {
    const m = /LOG:\s+(?:statement|execute [^:]*):\s*(.*)$/.exec(rec[0]);
    if (!m) continue;
    // 続きの行（先頭がタブ）を繋いで1つの文に戻す
    const rest = [];
    for (let i = 1; i < rec.length; i++) {
      if (/^\t/.test(rec[i])) rest.push(rec[i].replace(/^\t/, ''));
      else break;
    }
    const sql = [m[1], ...rest].join(' ').replace(/\s+/g, ' ').trim();
    if (sql) all.push(sql);
  }
  const dml = all.filter((s) => DML.test(s));
  const housekeeping = all.filter((s) => !DML.test(s));
  return { all, dml, housekeeping };
}
