/* DBの情報スキーマへの照会（02d の source = db-introspection / L0）。
 * 行データは読まない。定義だけを読む。 */
import { psql } from './util.mjs';

export function introspectTables(schema = 'poc') {
  const rows = psql(
    `select table_schema, table_name from information_schema.tables
      where table_schema = '${schema}' order by table_name`,
  );
  return rows ? rows.split('\n').map((l) => {
    const [s, n] = l.split('\t');
    return { schema: s, name: n };
  }) : [];
}

export function introspectColumns(schema = 'poc') {
  const rows = psql(
    `select table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
       from information_schema.columns
      where table_schema = '${schema}' order by table_name, ordinal_position`,
  );
  return rows ? rows.split('\n').map((l) => {
    const [s, t, c, dt, nullable, ord] = l.split('\t');
    return { schema: s, table: t, column: c, dataType: dt, nullable: nullable === 'YES', position: Number(ord) };
  }) : [];
}

/** テーブルの行数推定。行データそのものは取らない。 */
export function introspectRowEstimates(schema = 'poc') {
  const rows = psql(
    `select relname, greatest(reltuples::bigint, 0) from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = '${schema}' and c.relkind = 'r' order by relname`,
  );
  const out = {};
  if (rows) for (const l of rows.split('\n')) { const [t, n] = l.split('\t'); out[t] = Number(n); }
  return out;
}
