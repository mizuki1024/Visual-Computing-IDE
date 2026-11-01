/* =============================================================================
 * Phase 7A — 開発サーバーの起動・停止・状態の検証。
 *   node tests/devserver.spec.mjs
 *
 * **実際にプロセスを起動して確かめる。** 見るのは次の点である（指示 第5節 4〜10）。
 *   4. 利用者の操作で起動できる
 *   5. 実際に HTTP で応答することを確認できる
 *   6. 二重起動を防げる（IDE 側と Next 側の両方）
 *   7. ポート競合で適切に失敗する
 *   8. 停止でき、子プロセスが残らない
 *   9. 停止後に再起動できる
 *  10. エラー発生後に状態と原因が確認できる
 * あわせて、入口の防御（指示 2.E）と所有の引き継ぎ（指示 第3節）を見る。
 *
 * 題材は poc/fixture-app（実在する Next.js の App Router プロジェクト）。
 * 依存が入っていない環境では、起動を伴う節を skip する — **成功扱いにしない。**
 * ========================================================================== */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const DS = require_('../.libjs/server/devServer.js');
const G = require_('../.libjs/server/guard.js');
const R = require_('../.libjs/server/redact.js');
const IDE = require_('../.libjs/server/ide.js');

let pass = 0;
const fails = [];
const skips = [];
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(`${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`); }
};
const eq = (name, a, b) => ok(name, a === b, a);
const skip = (name, why) => { skips.push(`${name} — ${why}`); console.log(`  ⊘ ${name} — ${why}（skip）`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPO = path.resolve(import.meta.dirname, '..');
const PROJECT = process.env.VCIDE_TEST_PROJECT ?? path.join(REPO, 'poc', 'fixture-app');
const STATE_FILE = IDE.stateFilePath();

/** 指示 2.D の7状態。これ以外が現れてはならない */
const STATES = ['idle', 'validating', 'starting', 'running', 'stopping', 'stopped', 'error'];

/** 同じプロセスグループのプロセスを数える。子が残っていないことの確認に使う */
function groupMembers(pgid) {
  try {
    return execFileSync('ps', ['-ax', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m ? { pid: +m[1], pgid: +m[2], cmd: m[3] } : null; })
      .filter((x) => x && x.pgid === pgid);
  } catch { return []; }
}
const aliveNow = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** ポートを塞ぐ。競合の検出の題材にする */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer(() => {});
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}
async function freePort(from = 3400) {
  for (let p = from; p < from + 60; p++) {
    const got = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (got) return p;
  }
  throw new Error('空きポートが見つかりません');
}

/* ================================================== 1. 入口の防御（指示 2.E） */
console.log('\n1. 入口の防御 — ブラウザから任意の操作をさせない');
{
  const req = (opt = {}) => new Request(opt.url ?? 'http://localhost:3100/api/runtime/start', {
    method: opt.method ?? 'POST',
    headers: {
      host: opt.host ?? 'localhost:3100',
      ...(opt.origin ? { origin: opt.origin } : {}),
      ...(opt.site ? { 'sec-fetch-site': opt.site } : {}),
      ...(opt.ct === null ? {} : { 'content-type': opt.ct ?? 'application/json' }),
      ...(opt.hdr === null ? {} : { [G.REQUEST_HEADER]: '1' }),
    },
    ...(opt.method === 'GET' ? {} : { body: '{}' }),
  });
  const guard = (opt, mutating = true) => G.guardRequest(req(opt), { mutating });

  eq('同一オリジンの POST は通る', guard({ origin: 'http://localhost:3100', site: 'same-origin' }), null);
  eq('Origin が無い POST（curl 等）も通る', guard({}), null);
  eq('別オリジンの POST は拒否する',
    guard({ origin: 'http://evil.example.com', site: 'cross-site' })?.code, 'cross-site');
  eq('Sec-Fetch-Site が cross-site なら拒否する', guard({ site: 'cross-site' })?.code, 'cross-site');
  eq('同じホスト名でもポートが違うオリジンは拒否する',
    guard({ origin: 'http://localhost:4000' })?.code, 'cross-origin');
  eq('ループバック以外の Host は拒否する',
    guard({ host: 'ide.example.com' })?.code, 'non-local-host');
  eq('外部から IP 指定で来ても拒否する',
    guard({ host: '192.168.1.20:3100' })?.code, 'non-local-host');
  eq('127.0.0.1 の Host は通る', guard({ host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3100' }), null);
  eq('変更操作は GET を受け付けない', guard({ method: 'GET' })?.code, 'method-not-allowed');
  eq('JSON 以外の Content-Type は受け付けない',
    guard({ ct: 'application/x-www-form-urlencoded' })?.code, 'unsupported-media-type');
  eq('Content-Type が無ければ受け付けない', guard({ ct: null })?.code, 'unsupported-media-type');
  eq('独自ヘッダが無い要求は受け付けない（フォーム送信を通さない）',
    guard({ hdr: null })?.code, 'missing-request-header');
  eq('読み取りだけなら独自ヘッダは要らない', guard({ method: 'GET', hdr: null }, false), null);
  eq('読み取りでも別オリジンは拒否する', guard({ method: 'GET', site: 'cross-site' }, false)?.code, 'cross-site');
  ok('API は「コマンド」を受け取らない（start の入力は project / port / instrument だけ）',
    !fs.readFileSync(path.join(REPO, 'src/app/api/runtime/start/route.ts'), 'utf8')
      .match(/\b(command|cmd|args|shell|script)\b/));
  ok('どのルートハンドラにも exec / spawn が無い（起動は devServer.ts だけが行う）',
    fs.readdirSync(path.join(REPO, 'src/app/api/runtime'), { recursive: true })
      .filter((f) => String(f).endsWith('.ts'))
      .every((f) => !/exec|spawn/.test(fs.readFileSync(path.join(REPO, 'src/app/api/runtime', String(f)), 'utf8'))));
}

console.log('\n2. ログに秘密情報を出さない（指示 2.E）');
{
  eq('鍵らしい代入を落とす', R.redact('DATABASE_KEY=abc123'), 'DATABASE_KEY=[秘匿]');
  eq('SECRET も落とす', R.redact('MY_SECRET: hunter2'), 'MY_SECRET: [秘匿]');
  eq('TOKEN も落とす', R.redact('token=zzz'), 'token=[秘匿]');
  eq('資格情報つき URL を落とす',
    R.redact('postgresql://poc:pw@127.0.0.1:5432/db'), 'postgresql://[秘匿]@127.0.0.1:5432/db');
  eq('普通の行は変えない', R.redact('✓ Ready in 900ms'), '✓ Ready in 900ms');
  eq('ポート番号は落とさない', R.redact('- Local: http://127.0.0.1:3200'), '- Local: http://127.0.0.1:3200');
  ok('API は環境変数を返さない',
    !fs.readFileSync(path.join(REPO, 'src/server/apiShared.ts'), 'utf8').includes('process.env'));
  ok('状態の写しに環境変数が入っていない',
    !/process\.env/.test(fs.readFileSync(path.join(REPO, 'src/server/devServer.ts'), 'utf8')
      .split('snapshot()')[1].slice(0, 1500)));
}

/* ======================================================= 起動を伴う節の前提 */
const NEXT_BIN = path.join(PROJECT, 'node_modules', 'next', 'dist', 'bin', 'next');
if (!fs.existsSync(NEXT_BIN)) {
  console.log('\n3〜9. 起動を伴う検証');
  skip('実際の起動・停止の検証', `${PROJECT} に next がインストールされていない`);
} else {
  // 起動の前に、対象プロジェクトの姿を記録しておく（第10節で突き合わせる）
  const TOP_BEFORE = fs.readdirSync(PROJECT).filter((f) => f !== '.next').sort().join(',');
  const SRC_BEFORE = fs.readdirSync(path.join(PROJECT, 'src'), { recursive: true }).sort().join(',');

  fs.rmSync(STATE_FILE, { force: true });
  const m1 = new DS.DevServerManager();
  eq('最初は未起動', m1.snapshot().state, 'idle');
  eq('最初は台帳が無い', fs.existsSync(STATE_FILE), false);

  /* ------------------------------------------- 3. ポート競合で適切に失敗する */
  console.log('\n3. ポート競合で適切に失敗する');
  const busyPort = await freePort(3450);
  const blocker = await occupy(busyPort);
  {
    const s = await m1.start({ project: PROJECT, port: busyPort, instrument: false });
    eq('状態は error', s.state, 'error');
    eq('理由コードは port-in-use', s.error?.code, 'port-in-use');
    ok('ポート番号が理由に出る', s.error?.fact.includes(String(busyPort)), s.error?.fact);
    ok('次にできることを書いている', !!s.error?.action, s.error);
    eq('失敗したので PID は持たない', s.pid, null);
    eq('台帳を書き残していない', fs.existsSync(STATE_FILE), false);
  }
  {
    const s = await m1.start({ project: PROJECT, port: 80, instrument: false });
    eq('特権ポートは受け付けない', s.error?.code, 'port-invalid');
  }
  await new Promise((r) => blocker.close(r));

  /* ------------------------- 4 / 5. 利用者の操作で起動し、応答を確認してから running */
  console.log('\n4. 起動できる — 応答を確認してから「実行中」にする');
  const port = await freePort(3460);
  const seen = [];
  const sampler = setInterval(() => {
    const st = m1.snapshot().state;
    if (seen[seen.length - 1] !== st) seen.push(st);
  }, 60);
  const t0 = Date.now();
  const started = await m1.start({ project: PROJECT, port });
  clearInterval(sampler);
  if (seen[seen.length - 1] !== m1.snapshot().state) seen.push(m1.snapshot().state);
  const elapsed = Date.now() - t0;

  eq('状態は running', started.state, 'running');
  if (started.state !== 'running') {
    console.log(`     error: ${JSON.stringify(started.error, null, 2)}`);
    console.log(`     log: ${m1.logs(30).lines.join('\n          ')}`);
  }
  ok('観測した状態はすべて7状態のどれか', seen.every((s) => STATES.includes(s)), seen);
  ok('起動の途中では starting を通る', seen.includes('starting'), seen);
  ok('running は starting より後にしか現れない',
    seen.lastIndexOf('running') > seen.indexOf('starting'), seen);
  ok('running は最後の状態である', seen[seen.length - 1] === 'running', seen);
  eq('要求したポートで起動している', started.port, port);
  ok('PID を持っている', Number.isInteger(started.pid) && started.pid > 1, started.pid);
  ok('そのプロセスは生きている', aliveNow(started.pid), started.pid);
  eq('起動元は IDE', started.owner, 'ide');
  ok('応答までの時間を記録している', started.readyMs > 0 && started.readyMs <= elapsed,
    { readyMs: started.readyMs, elapsed });
  eq('HTTP の応答を観測している', started.lastProbe?.ok, true);
  ok('応答した状態コードを持っている', Number.isInteger(started.lastProbe?.status), started.lastProbe);
  ok('「起動した」と「応答がある」を別に持っている',
    started.startedAt !== null && started.readyAt !== null && started.startedAt <= started.readyAt,
    { startedAt: started.startedAt, readyAt: started.readyAt });
  eq('異常終了の記録は無い', started.exitCode, null);
  eq('失敗の説明は無い', started.error, null);

  console.log('\n5. 実際に HTTP で応答する');
  {
    const r = await fetch(`http://127.0.0.1:${port}/`).catch((e) => e);
    ok('テストからも HTTP で応答が取れる', r instanceof Response, String(r));
    if (r instanceof Response) ok(`状態コード ${r.status}（内容は問わない — 応答があることが証拠）`, true);
    const outside = await fetch(`http://127.0.0.1:${port + 1}/`).catch(() => null);
    eq('隣のポートでは応答しない（ポートを特定している）', outside, null);
  }
  {
    const l = m1.logs(50);
    eq('標準出力・エラー出力を保持している', l.available, true);
    ok('出力が1行以上ある', l.lines.length > 0, l.total);
    ok('Next の起動ログが入っている', l.lines.join('\n').includes('Next.js'), l.lines.slice(0, 3));
    ok('出力に資格情報つき URL が素で出ていない',
      !/:\/\/[^\s/@:]+:[^\s/@]+@/.test(l.lines.join('\n')));
  }
  {
    const ins = started.instrumentation;
    ok('計装の状態は3値のどれか', ['enabled', 'disabled', 'unavailable'].includes(ins.state), ins);
    if (ins.state === 'enabled') {
      ok('収集先は IDE 側（対象プロジェクトの外）',
        ins.spanFile.startsWith(path.join(REPO, '.ide-runtime')), ins.spanFile);
      await sleep(600);
      ok('計装が実際に記録を書いている（PoC-01 方式2 の再利用）',
        fs.existsSync(ins.spanFile) && fs.readFileSync(ins.spanFile, 'utf8').includes('"type"'),
        fs.existsSync(ins.spanFile) ? fs.readFileSync(ins.spanFile, 'utf8').slice(0, 120) : 'ファイル無し');
    } else {
      skip('計装つき起動の検証', ins.reason ?? ins.state);
    }
  }

  /* --------------------------------------------------- 6. 二重起動を防げる */
  console.log('\n6. 二重起動を防げる');
  {
    let caught = null;
    try { await m1.start({ project: PROJECT, port: await freePort(3480) }); }
    catch (e) { caught = e; }
    ok('実行中にもう一度起動しようとすると拒否される', caught instanceof DS.BusyError, String(caught));
    eq('拒否のときの状態は running のまま', caught?.state, 'running');
    ok('理由に PID とポートが出る', /PID \d+/.test(caught?.message ?? ''), caught?.message);
    eq('プロセスは入れ替わっていない', m1.snapshot().pid, started.pid);
  }
  const record = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  {
    // IDE のプロセスが入れ替わった場合。台帳から引き継ぐので、やはり拒否する
    const mDup = new DS.DevServerManager();
    let caught = null;
    try { await mDup.start({ project: PROJECT, port: await freePort(3485) }); }
    catch (e) { caught = e; }
    ok('別の実体でも、台帳から引き継いで二重起動を拒否する', caught instanceof DS.BusyError, String(caught));
    eq('引き継いだ実体も同じプロセスを指している', mDup.snapshot().pid, started.pid);
  }
  {
    // 台帳を失った場合（IDE が異常終了した後など）。Next 16 自身が
    // 同一プロジェクトの二重起動を断ることを、最後の砦として確かめる
    fs.rmSync(STATE_FILE, { force: true });
    const m3 = new DS.DevServerManager();
    eq('台帳が無ければ、その実体は未起動から始まる', m3.snapshot().state, 'idle');
    const s = await m3.start({ project: PROJECT, port: await freePort(3490), instrument: false });
    ok('別の実体から同じプロジェクトを起動しても実行中にならない', s.state !== 'running', s.state);
    ok('理由コードが付いている', typeof s.error?.code === 'string', s.error);
    if (s.error?.code === 'another-dev-server-running') {
      ok('Next の「既に起動している」を理由として受け取っている', true);
      ok('外部起動では計装が適用できないことを書いている',
        /計装/.test(s.error.impact), s.error.impact);
    } else {
      ok(`理由は ${s.error?.code}（Next の世代により報告の形が違う）`, true);
    }
    ok('最初のプロセスは生きたままである', aliveNow(started.pid), started.pid);
    // 台帳を戻す（m3 の失敗で消えている）。引き継ぎの節で使う
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...record, ideOwnerPid: 999999 }, null, 2));
  }

  /* ----------------------------------- 7. 所有の引き継ぎ（指示 第3節の検証点） */
  console.log('\n7. IDE の再起動をまたいで所有を引き継ぐ');
  const m2 = new DS.DevServerManager();
  {
    await sleep(300);                            // PID 再利用の確認が終わるのを待つ
    const s = m2.snapshot();
    eq('台帳から実行中として引き継ぐ', s.state, 'running');
    eq('同じプロセスを指している', s.pid, started.pid);
    eq('同じポートを指している', s.port, port);
    eq('起動元は「前のセッションから引き継ぎ」', s.owner, 'ide-previous-session');
    eq('引き継いだプロセスの出力は持っていない（持っていると言わない）', s.logAvailable, false);
    eq('出力の行数も 0 である', s.logLines, 0);
    await m2.refresh();
    eq('引き継いだ先でも HTTP の応答を確認できる', m2.snapshot().lastProbe?.ok, true);
  }
  {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...record, pid: 999999 }, null, 2));
    const m4 = new DS.DevServerManager();
    eq('死んでいる PID の台帳は引き継がない', m4.snapshot().state, 'idle');
    eq('引き継げない台帳は消す', fs.existsSync(STATE_FILE), false);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...record, ideOwnerPid: 999999 }, null, 2));
  }

  /* ---------------------------- 8. 停止でき、子プロセスが残らない / 再起動できる */
  console.log('\n8. 停止でき、子プロセスが残らない');
  const pgid = started.pid;
  const beforeStop = groupMembers(pgid);
  ok('停止前はプロセスグループに1つ以上いる', beforeStop.length >= 1, beforeStop.map((x) => x.cmd));
  {
    const s = await m2.stop();                   // 引き継いだ側から止める
    eq('状態は stopped', s.state, 'stopped');
    eq('停止したので失敗の説明は無い', s.error, null);
    eq('プロセスは消えた', aliveNow(started.pid), false);
    eq('プロセスグループに誰も残っていない', groupMembers(pgid).length, 0);
    const free = await new Promise((res) => {
      const sv = net.createServer();
      sv.once('error', () => res(false));
      sv.once('listening', () => sv.close(() => res(true)));
      sv.listen(port, '127.0.0.1');
    });
    eq('ポートが解放されている', free, true);
    eq('台帳を消している', fs.existsSync(STATE_FILE), false);
    const r = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
    eq('HTTP も応答しなくなっている', r, null);
  }
  {
    /* 止めたのは引き継いだ側（m2）であり、子を掴んでいるのは m1 である。
     * m1 は終了イベントを受けるので、**聞かれる前に** running を降りている。
     * 「起動を指示したこと」ではなく「プロセスの事実」で状態が決まっている。 */
    const s = m1.snapshot();
    ok('子を掴んでいる実体は、終了を観測して running を降りている', s.state !== 'running', s.state);
    eq('状態は error', s.state, 'error');
    eq('理由コードは crashed（自分が止めたのではない）', s.error?.code, 'crashed');
    ok('終了コードかシグナルを記録している', s.exitCode !== null || s.signal !== null,
      { exitCode: s.exitCode, signal: s.signal });
    ok('最後の出力を理由に添えている', /最後の出力|出力がありません/.test(s.error?.reason ?? ''), s.error?.reason);
    await m1.refresh();
    eq('確認し直しても error のままである', m1.snapshot().state, 'error');
  }

  console.log('\n9. 停止後・エラー後に再起動できる');
  {
    const port2 = await freePort(3500);
    const s = await m2.start({ project: PROJECT, port: port2, instrument: false });
    eq('停止後に再起動できる', s.state, 'running');
    ok('新しい PID である', s.pid !== started.pid, { old: started.pid, now: s.pid });
    eq('新しいポートである', s.port, port2);
    eq('計装なしを選べる', s.instrumentation.state, 'disabled');
    eq('前回の失敗の説明は消えている', s.error, null);
    const stopped = await m2.stop();
    eq('もう一度止められる', stopped.state, 'stopped');
    eq('最後にプロセスが残っていない', aliveNow(s.pid), false);
    eq('プロセスグループも空である', groupMembers(s.pid).length, 0);
  }

  /* ---------------------------------- 10. 対象プロジェクトを書き換えていない */
  console.log('\n10. 対象プロジェクトを書き換えない（指示 2.E）');
  {
    const top = (d) => fs.readdirSync(d).filter((f) => f !== '.next').sort().join(',');
    const srcList = fs.readdirSync(path.join(PROJECT, 'src'), { recursive: true }).sort().join(',');
    eq('トップ階層に新しいものを作っていない', top(PROJECT), TOP_BEFORE);
    eq('src の中身を変えていない', srcList, SRC_BEFORE);
    ok('計装ファイルを対象に置いていない',
      !fs.existsSync(path.join(PROJECT, 'instrumentation.ts.ide'))
      && !fs.readdirSync(PROJECT).some((f) => f.startsWith('.ide-')));
    ok('IDE の作業ディレクトリは IDE 側にある',
      IDE.runtimeDir().startsWith(REPO) && !IDE.runtimeDir().startsWith(PROJECT), IDE.runtimeDir());
  }
}

console.log(`\n${fails.length ? '✗ 失敗あり' : '✓ すべて通過'} — ${pass} 件通過 / ${fails.length} 件失敗${skips.length ? ` / ${skips.length} 件 skip` : ''}`);
if (skips.length) for (const s of skips) console.log(`  ⊘ ${s}`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1); }
