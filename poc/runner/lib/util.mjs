/* 共通の小物。PoC のランナーは IDE 本体から独立している。 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** このファイルは poc/runner/lib/util.mjs にある */
const HERE = path.dirname(fileURLToPath(import.meta.url));   // poc/runner/lib
export const RUNNER = path.dirname(HERE);                    // poc/runner
export const POC = path.dirname(RUNNER);                     // poc
export const APP = path.join(POC, 'fixture-app');
export const OUT = path.join(POC, 'out');
export const REPO = path.dirname(POC);

export const PG_CONTAINER = 'poc01-pg';
export const DB_URL =
  'postgresql://poc01:poc01_local_only@127.0.0.1:55432/poc01?schema=poc';
export const APP_PORT = 3200;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** コンテナ内の psql を叩く。ローカルに psql を入れない。 */
export function psql(sql, args = []) {
  return execFileSync(
    'docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'poc01', '-d', 'poc01', '-At', '-F', '\t', ...args, '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

export function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export async function waitFor(fn, { timeout = 60000, interval = 200 } = {}) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeout) throw new Error('waitFor: timeout');
    await sleep(interval);
  }
}
