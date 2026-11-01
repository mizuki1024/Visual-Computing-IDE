/* 使い捨てのローカル PostgreSQL への接続。接続文字列は環境変数から読む。
 * 値をログにもトレースにも出さない（計装側の許可リストで落としている）。 */
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const g = globalThis as unknown as { __prisma?: PrismaClient; __pool?: Pool };

export const prisma = g.__prisma ?? (g.__prisma = new PrismaClient());
export const pool = g.__pool ?? (g.__pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
}));
