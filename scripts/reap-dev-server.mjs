/* =============================================================================
 * 孤立した開発サーバーの掃除。
 *   node scripts/reap-dev-server.mjs          # 台帳を見るだけ
 *   node scripts/reap-dev-server.mjs --kill   # 台帳のプロセスを止める
 *
 * IDE が SIGKILL などで死んだ場合、起動した開発サーバーは残る。通常は次に
 * IDE を開いたときに台帳（.ide-runtime/dev-server.json）から**引き継ぐ**ので
 * 孤立しない。IDE を開かずに掃除したいときだけ、このコマンドを使う。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), '.ide-runtime', 'dev-server.json');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(FILE)) { console.log('台帳はありません（起動した開発サーバーの記録なし）。'); process.exit(0); }

let rec;
try { rec = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch (e) { console.error(`台帳を読めません: ${e.message}`); process.exit(1); }

const live = alive(rec.pid);
console.log(`記録: PID ${rec.pid} / ポート ${rec.port} / ${rec.projectRoot}`);
console.log(`起動時刻: ${rec.startedAt} / 記録した IDE の PID: ${rec.ideOwnerPid}`);
console.log(`プロセスの生存: ${live ? '生きています' : 'もういません'}`);

if (!live) {
  fs.rmSync(FILE, { force: true });
  console.log('→ 台帳を消しました。');
  process.exit(0);
}
if (!process.argv.includes('--kill')) {
  console.log('→ 止めるには --kill を付けてください。');
  process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGKILL']) {
  if (!alive(rec.pid)) break;
  try { process.kill(-rec.pid, sig); } catch { try { process.kill(rec.pid, sig); } catch { /* 既に落ちている */ } }
  for (let i = 0; i < 40 && alive(rec.pid); i++) await sleep(150);
}
if (alive(rec.pid)) { console.error('→ 止められませんでした。'); process.exit(1); }
fs.rmSync(FILE, { force: true });
console.log('→ 停止し、台帳を消しました。');
