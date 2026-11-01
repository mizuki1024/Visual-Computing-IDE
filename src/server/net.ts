/* =============================================================================
 * ポートとプロセスの観測。**「起動コマンドを出した」ことと「応答がある」ことを
 * 区別する**ために要る（指示 2.D）。ここは観測だけを行い、状態は決めない。
 * ========================================================================== */
import net from 'node:net';
import { execFile } from 'node:child_process';

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => { setTimeout(r, ms); });

/** 待ち受けている相手がいるか。**空いているなら true を返す**（混同しやすいので名前を長くする） */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(() => resolve(true)); });
    s.listen(port, host);
  });
}

/** ポートが空くまで待つ。停止の完了判定に使う（指示 2.C「停止後にポートが解放される」） */
export async function waitPortFree(
  port: number, { timeout = 15000, interval = 200 } = {},
): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await isPortFree(port)) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(interval);
  }
}

/**
 * HTTP で応答が返るか。**状態コードは問わない** — 404 でも「待ち受けて応答している」
 * ことの証拠である。任意のプロジェクトが `/` に 200 を返すとは限らない。
 */
export async function httpResponds(
  url: string, { timeout = 4000 } = {},
): Promise<{ ok: true; status: number } | { ok: false; error: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

/** プロセスが生きているか。シグナル 0 は送らずに存在だけを見る。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    // EPERM = 生きているが自分のものではない
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * プロセスのコマンド行。**PID の再利用を見分けるために要る。**
 * 記録した PID が生きていても、それが同じプロセスだとは限らない。
 */
export function pidCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 },
      (err, stdout) => { resolve(err ? null : stdout.trim() || null); });
  });
}
