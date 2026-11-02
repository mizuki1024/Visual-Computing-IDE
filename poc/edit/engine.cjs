/* =============================================================================
 * 編集 PoC — 書き込みの中核（位置の特定・最小差分・版・適用・取り消し・複数ファイルの復旧）。
 *
 * 守ること（破ると PoC の結論が信用できなくなる）
 *   1. **書き換えるのは、構文解析で特定した1つのリテラルの中の1つの token だけ。**
 *      文字列の全体置換・正規表現による置換・再出力（pretty-print）をしない。
 *   2. 位置の根拠は「要素識別子の照合（src/server/anchors.ts の6段）」と、
 *      **この関数自身がソースを読み直して確かめた** (行:列・タグ・囲むコンポーネント)。
 *   3. 対応できない記述（条件付き・合成・重なる指定・同じ token が複数）は書き換えず、理由を返す。
 *   4. 版は**内容のハッシュ**で決める。Git の HEAD を使わない（未コミットの変更も別の版になる）。
 *   5. 書く前に、変更案を作った時点の内容と照合する。違えば書かない（外部変更を上書きしない）。
 *   6. 取り消しも、適用した直後の内容が**そのまま残っているときだけ**戻す。古いファイル全体で上書きしない。
 *   7. 書いたかどうかは「試みたか」ではなく**読み直した内容**で報告する。
 *
 * 対象は Tailwind の余白（p-*）の基本 variant だけ（今回の PoC の範囲）。
 * ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ------------------------------------------------------------------ 版 */

const REV_EXT = /\.(tsx?|jsx?|css|mjs|cjs|json)$/;
const REV_ROOT_FILES = ['next.config.mjs', 'postcss.config.mjs', 'package.json', 'tsconfig.json'];

/** 版の対象のファイル（src/ の下と設定）。node_modules・.next は含めない */
function revisionFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (REV_EXT.test(e.name)) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'src'));
  for (const f of REV_ROOT_FILES) if (fs.existsSync(path.join(root, f))) out.push(f);
  return out.sort();
}

/**
 * コードの版（02e 3.6 `CodeRevision`）。対象ファイルの内容ハッシュの組から決める。
 * 同じ内容なら同じ版、1文字でも違えば別の版。Git のコミットとは独立。
 */
function revisionOf(root) {
  const t0 = process.hrtime.bigint();
  const files = revisionFiles(root).map((rel) => ({ rel, hash: sha256(fs.readFileSync(path.join(root, rel))) }));
  const full = sha256(files.map((f) => `${f.rel}\0${f.hash}`).join('\n'));
  return { id: full.slice(0, 12), full, files, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

/* ------------------------------------------------------------ 位置の特定 */

const isPascal = (s) => typeof s === 'string' && /^[A-Z]/.test(s);

/** poc/anchor/transform.cjs の declName と同じ規則 */
function declName(node) {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    if (node.name && isPascal(node.name.text)) return node.name.text;
    if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return '(default export)';
    return null;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isPascal(node.name.text)
    && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.name.text;
  }
  return null;
}

/** 拒否の理由（UI に出す語。推測で書き換えない理由を必ず返す） */
const REASON = {
  'source-mismatch': 'その位置に、選んだ要素の JSX がありません（ソースが変わった可能性があります）',
  'no-classname': 'この要素には className がありません',
  'duplicate-classname': 'className が2つ以上あります',
  'spread-after-classname': 'className の後に props の展開（{...props}）があり、実際に効くクラスを決められません',
  'conditional-class': '条件によって変わるクラスです。どの条件の token を書き換えるかを推測しません',
  'computed-class': '関数・変数・テンプレートで組み立てたクラスです。書き換える token を一意に特定できません',
  'literal-has-escape': 'リテラルにエスケープ・文字参照が含まれ、表示と位置が一致しません',
  'token-not-found': '書き換える token がリテラルの中にありません',
  'token-ambiguous': '書き換える token がリテラルの中に2つ以上あり、一意に特定できません',
  'token-already-present': '変更後の token が既にあります',
  'overlapping-utility': '同じ余白に効く別の基本指定（px-・pt- など）があり、変更の結果を推測しません',
  'unsupported-token': 'この PoC が扱うのは基本 variant の余白（p-*）だけです',
};

const PADDING_BASE = /^p-(\d+(\.5)?|px)$/;
const PADDING_FAMILY = /^(p|px|py|pt|pr|pb|pl|ps|pe)-/;

/** 空白で区切った token と、その位置（リテラルの中の相対位置） */
function splitTokens(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * 選んだ要素の className の中で、書き換える token の位置を特定する。
 * @param {string} source 現在のファイルの内容
 * @param {string} rel     プロジェクトからの相対パス
 * @param {{line:number,col:number,tag:string,component:string}} target 照合済みの要素の位置
 * @param {string} from    書き換える token（例 'p-4'）
 * @param {string} to      変更後の token（例 'p-5'）
 */
function inspectClassName(source, rel, target) {
  const fail = (reason, extra = {}) => ({ ok: false, reason, detail: REASON[reason], ...extra });
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const stack = [];
  let found = null;
  const walk = (n) => {
    const nm = declName(n);
    if (nm) stack.push(nm);
    const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (open && !found) {
      const p = sf.getLineAndCharacterOfPosition(ts.skipTrivia(source, n.pos));
      if (p.line + 1 === target.line && p.character + 1 === target.col) {
        found = { open, tag: open.tagName.getText(sf), component: stack.length ? stack[stack.length - 1] : null };
      }
    }
    ts.forEachChild(n, walk);
    if (nm) stack.pop();
  };
  walk(sf);
  if (!found || found.tag !== target.tag || found.component !== target.component) {
    return fail('source-mismatch', { at: `${rel}:${target.line}:${target.col}` });
  }

  const props = found.open.attributes.properties;
  const idx = props.map((p, i) => (ts.isJsxAttribute(p) && p.name.getText(sf) === 'className' ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return fail('no-classname');
  if (idx.length > 1) return fail('duplicate-classname');
  if (props.slice(idx[0] + 1).some((p) => ts.isJsxSpreadAttribute(p))) return fail('spread-after-classname');

  const init = props[idx[0]].initializer;
  let lit = null;
  if (init && ts.isStringLiteral(init)) lit = init;
  else if (init && ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) lit = e;
    else {
      let conditional = false;
      const scan = (x) => {
        if (ts.isConditionalExpression(x) || (ts.isBinaryExpression(x)
          && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
            .includes(x.operatorToken.kind))) conditional = true;
        ts.forEachChild(x, scan);
      };
      scan(e);
      return fail(conditional ? 'conditional-class' : 'computed-class', { expression: e.getText(sf).slice(0, 200) });
    }
  }
  if (!lit) return fail('computed-class');

  /* リテラルの中身の位置（引用符の内側）。表示とソースの文字が一致しないものは扱わない */
  const litStart = lit.getStart(sf) + 1;
  const litEnd = lit.getEnd() - 1;
  const raw = source.slice(litStart, litEnd);
  if (raw !== lit.text || /[\\&]/.test(raw)) return fail('literal-has-escape');

  const tokens = splitTokens(raw);
  return { ok: true, litStart, tokens, sf };
}

function locateClassToken(source, rel, target, from, to) {
  const fail = (reason, extra = {}) => ({ ok: false, reason, detail: REASON[reason], ...extra });
  if (!PADDING_BASE.test(from) || !PADDING_BASE.test(to)) return fail('unsupported-token');
  const ins = inspectClassName(source, rel, target);
  if (!ins.ok) return ins;
  const { litStart, tokens, sf } = ins;
  const hits = tokens.filter((t) => t.text === from);
  if (hits.length === 0) return fail('token-not-found', { tokens: tokens.map((t) => t.text) });
  if (hits.length > 1) return fail('token-ambiguous', { count: hits.length });
  if (tokens.some((t) => t.text === to)) return fail('token-already-present');
  const overlapping = tokens.filter((t) => t.text !== from && !t.text.includes(':') && PADDING_FAMILY.test(t.text));
  if (overlapping.length) return fail('overlapping-utility', { tokens: overlapping.map((t) => t.text) });

  const lc = sf.getLineAndCharacterOfPosition(litStart + hits[0].start);
  return {
    ok: true,
    start: litStart + hits[0].start,
    end: litStart + hits[0].end,
    tokenLine: lc.line + 1,
    tokenCol: lc.character + 1,
    classTokens: tokens.map((t) => t.text),
    /** 同じ余白に効く variant 付きの指定（幅ごとの上書き）。例 ['md:p-6'] */
    overrides: tokens.filter((t) => t.text.includes(':') && PADDING_FAMILY.test(t.text.split(':').pop())).map((t) => t.text),
  };
}

/* ---------------------------------------------------------- 差分（表示用） */

function unifiedDiff(rel, a, b, context = 2) {
  const A = a.split('\n');
  const B = b.split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length - 1;
  let eb = B.length - 1;
  while (ea >= s && eb >= s && A[ea] === B[eb]) { ea--; eb--; }
  if (s > ea && s > eb) return { text: '', changedLines: 0 };
  const cs = Math.max(0, s - context);
  const ceA = Math.min(A.length - 1, ea + context);
  const ceB = Math.min(B.length - 1, eb + context);
  const lines = [`--- a/${rel}`, `+++ b/${rel}`,
    `@@ -${cs + 1},${ceA - cs + 1} +${cs + 1},${ceB - cs + 1} @@`];
  for (let i = cs; i < s; i++) lines.push(` ${A[i]}`);
  for (let i = s; i <= ea; i++) lines.push(`-${A[i]}`);
  for (let i = s; i <= eb; i++) lines.push(`+${B[i]}`);
  for (let i = ea + 1; i <= ceA; i++) lines.push(` ${A[i]}`);
  return { text: lines.join('\n'), changedLines: Math.max(ea - s + 1, eb - s + 1) };
}

/** token 1つだけを差し替えた内容。差し替えた範囲の外は1文字も変えていないことを確かめる */
function patchToken(source, loc, from, to) {
  if (source.slice(loc.start, loc.end) !== from) throw new Error('range-mismatch');
  const next = source.slice(0, loc.start) + to + source.slice(loc.end);
  if (next.slice(0, loc.start) !== source.slice(0, loc.start)
    || next.slice(loc.start + to.length) !== source.slice(loc.end)) throw new Error('patch-invariant');
  return next;
}

/* ------------------------------------------------------------- 変更案 */

/**
 * 未適用の変更案（下書き）。**ファイルには触れない。**
 * Undo / Redo は値の履歴の中だけを動く（02e 6.9: 変更案の中の Undo と、適用の取り消しは別）。
 */
class Draft {
  constructor({ id, rel, anchor, from, baseHash }) {
    Object.assign(this, { id, rel, anchor, from, baseHash });
    this.values = [from];
    this.at = 0;
  }

  get value() { return this.values[this.at]; }

  get isNoop() { return this.value === this.from; }

  set(v) {
    if (v === this.value) return;
    this.values = this.values.slice(0, this.at + 1);
    this.values.push(v);
    this.at += 1;
  }

  undo() { if (this.at > 0) this.at -= 1; return this.value; }

  redo() { if (this.at < this.values.length - 1) this.at += 1; return this.value; }

  get canUndo() { return this.at > 0; }

  get canRedo() { return this.at < this.values.length - 1; }
}

/* ---------------------------------------------------------- ファイル I/O */

/** 既定の I/O。テストは失敗を差し込むためにこれを包む */
const realIo = {
  read: (abs) => fs.readFileSync(abs, 'utf8'),
  /** 同じディレクトリの一時ファイルへ書いてから rename（1ファイル単位で原子的） */
  writeAtomic(abs, content) {
    const dir = path.dirname(abs);
    const tmp = path.join(dir, `.${path.basename(abs)}.vcide-${crypto.randomBytes(6).toString('hex')}.tmp`);
    const mode = fs.statSync(abs).mode & 0o777;
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'wx', mode);
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      fs.renameSync(tmp, abs);
      try { const d = fs.openSync(dir, 'r'); fs.fsyncSync(d); fs.closeSync(d); } catch { /* ディレクトリの fsync が使えない FS */ }
    } catch (e) {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* 閉じている */ }
      try { fs.unlinkSync(tmp); } catch { /* 作られていない */ }
      throw e;
    }
  },
};

/** 対象の中のファイルか。`..`・絶対パス・シンボリックリンクで外へ出るものを拒む */
function safePath(root, rel) {
  if (typeof rel !== 'string' || rel.startsWith('/') || !rel.startsWith('src/')
    || rel.split('/').some((s) => s === '..' || s === '.' || s === '' || s === 'node_modules')) return null;
  const abs = path.resolve(root, rel);
  try {
    const real = fs.realpathSync(abs);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) return null;
    return real;
  } catch { return null; }
}

/* --------------------------------------------------------------- 適用 */

/**
 * 1ファイルの適用。`baseHash` は変更案を作った時点（差分を見せた時点）の内容ハッシュ。
 * 戻り値の `written` は**読み直した内容**から決める。
 */
function applyOne({ root, rel, baseHash, start, end, from, to }, io = realIo) {
  const abs = safePath(root, rel);
  if (!abs) return { status: 'refused', written: false, reason: 'outside-scope' };
  const cur = io.read(abs);
  const curHash = sha256(cur);
  if (curHash !== baseHash) {
    return { status: 'conflict', written: false, reason: 'external-change', currentHash: curHash,
      detail: '変更案を作った後に、このファイルが変わりました。上書きせず、差分の確認に戻ります。' };
  }
  let next;
  try { next = patchToken(cur, { start, end }, from, to); } catch (e) {
    return { status: 'conflict', written: false, reason: e.message };
  }
  const afterHash = sha256(next);
  /* 書く直前にもう一度だけ照合する（窓を狭める。0 にはできない — 報告書の限界を参照） */
  if (sha256(io.read(abs)) !== baseHash) {
    return { status: 'conflict', written: false, reason: 'external-change-just-before-write' };
  }
  try { io.writeAtomic(abs, next); } catch (e) {
    const now = sha256(io.read(abs));
    return { status: now === baseHash ? 'write-failed' : 'write-failed-unknown', written: now !== baseHash,
      reason: String(e.message), currentHash: now };
  }
  const back = sha256(io.read(abs));
  return {
    status: back === afterHash ? 'applied' : 'written-unverified',
    written: true, rel, beforeHash: baseHash, afterHash, readBackHash: back,
    before: cur, range: { start, end: start + to.length }, from, to,
  };
}

/**
 * 適用済みの変更の取り消し。**適用した直後の内容がそのまま残っているときだけ**元へ戻す。
 * その後に誰かが変えていたら、何も書かずに理由を返す（古いファイル全体で上書きしない）。
 */
function revertOne(applied, root, io = realIo) {
  const abs = safePath(root, applied.rel);
  if (!abs) return { status: 'refused', written: false, reason: 'outside-scope' };
  const cur = io.read(abs);
  const h = sha256(cur);
  if (h === applied.beforeHash) return { status: 'already-at-before', written: false };
  if (h !== applied.afterHash) {
    return {
      status: 'refused-changed-after-apply', written: false, currentHash: h,
      detail: '適用の後にこのファイルが変わっています。適用前の内容で上書きすると、その変更が失われるため取り消しません。',
      diffSinceApply: unifiedDiff(applied.rel, reconstructAfter(applied), cur).text,
    };
  }
  try { io.writeAtomic(abs, applied.before); } catch (e) {
    const now = sha256(io.read(abs));
    return { status: 'revert-failed', written: now !== h, reason: String(e.message), currentHash: now };
  }
  const back = sha256(io.read(abs));
  return { status: back === applied.beforeHash ? 'reverted' : 'revert-unverified', written: true, readBackHash: back };
}

function reconstructAfter(a) {
  return a.before.slice(0, a.range.start) + a.to + a.before.slice(a.range.start + a.from.length);
}

/* ------------------------------------------------ 複数ファイル（EP-06） */

const FILE_STATE_LABEL = {
  'not-written': '書いていない',
  written: '書いた',
  'rolled-back': '書き戻した',
  'rollback-failed': '書き戻せなかった',
  'rollback-refused': '書き戻さなかった（書いた後に別の変更が入った）',
};

function writeJournal(file, j) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, JSON.stringify(j, null, 1));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

/**
 * 複数ファイルの適用。**全ファイルの同時更新は保証しない**（1ファイルずつ rename する）。
 * 代わりに: 書く前に全ファイルを照合し、書く前の内容をジャーナルに残し、途中で失敗したら
 * 書いたファイルを（書いた直後の内容が残っているものだけ）書き戻し、最後に**全ファイルを読み直して**
 * ファイルごとの状態を報告する。
 *
 * faults（テスト用）: { failWriteAt, crashAfterWrite, failRollbackAt, externalEditBeforeRollback: {index, content} }
 */
function applyTransaction({ root, changes, journalDir, faults = {} }, io = realIo) {
  const txId = `tx-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const items = changes.map((c) => ({ ...c, abs: safePath(root, c.rel) }));
  const result = (outcome, files, extra = {}) => ({ txId, outcome, files, ...extra });

  /* 1. 書く前の照合。1件でも合わなければ1件も書かない */
  for (const it of items) {
    if (!it.abs) {
      return result('refused-nothing-written', items.map((x) => ({ rel: x.rel, state: 'not-written' })), { reason: `outside-scope: ${it.rel}` });
    }
  }
  const pre = items.map((it) => sha256(io.read(it.abs)));
  const mismatch = items.filter((it, i) => pre[i] !== it.baseHash).map((it) => it.rel);
  if (mismatch.length) {
    return result('conflict-nothing-written', items.map((x) => ({ rel: x.rel, state: 'not-written' })),
      { reason: 'external-change', mismatch });
  }

  /* 2. ジャーナル（書く前の内容とハッシュ）。これが無いと、プロセスが落ちたときに何を書いたか分からない */
  fs.mkdirSync(journalDir, { recursive: true });
  const journalFile = path.join(journalDir, `${txId}.json`);
  const journal = {
    txId, root, state: 'applying', startedAt: new Date().toISOString(),
    files: items.map((it) => ({
      rel: it.rel, beforeHash: it.baseHash, afterHash: sha256(it.next),
      before: Buffer.from(io.read(it.abs)).toString('base64'), state: 'not-written',
    })),
  };
  writeJournal(journalFile, journal);

  /* 3. 1ファイルずつ書く */
  let failure = null;
  for (let i = 0; i < items.length; i++) {
    try {
      if (faults.failWriteAt === i) throw new Error(`injected write failure at ${items[i].rel}`);
      io.writeAtomic(items[i].abs, items[i].next);
      journal.files[i].state = 'written';
      writeJournal(journalFile, journal);
      if (faults.crashAfterWrite === i) process.exit(70);   // 子プロセスでの「途中で落ちた」の再現
    } catch (e) {
      failure = { at: items[i].rel, message: String(e.message) };
      /* 書けなかったと思っても、実際の内容で決める */
      if (sha256(io.read(items[i].abs)) !== items[i].baseHash) journal.files[i].state = 'written';
      break;
    }
  }

  if (!failure) {
    journal.state = 'committed';
    journal.finishedAt = new Date().toISOString();
    writeJournal(journalFile, journal);
    return result('committed', finalStates(items, journal, io), { journalFile });
  }

  /* 4. 書き戻し（逆順）。書いた直後の内容が残っているファイルだけ */
  for (let i = items.length - 1; i >= 0; i--) {
    const f = journal.files[i];
    if (f.state !== 'written') continue;
    if (faults.externalEditBeforeRollback?.index === i) fs.writeFileSync(items[i].abs, faults.externalEditBeforeRollback.content);
    try {
      if (faults.failRollbackAt === i) throw new Error(`injected rollback failure at ${f.rel}`);
      const cur = sha256(io.read(items[i].abs));
      if (cur !== f.afterHash) { f.state = 'rollback-refused'; f.note = '書いた後に別の変更が入ったため、書き戻していません'; continue; }
      io.writeAtomic(items[i].abs, Buffer.from(f.before, 'base64').toString('utf8'));
      f.state = sha256(io.read(items[i].abs)) === f.beforeHash ? 'rolled-back' : 'rollback-failed';
    } catch (e) {
      f.state = 'rollback-failed';
      f.note = String(e.message);
    }
    writeJournal(journalFile, journal);
  }

  const files = finalStates(items, journal, io);
  const wroteAny = journal.files.some((f) => f.state !== 'not-written');
  const allBack = files.every((f) => f.content === 'at-before');
  journal.state = allBack ? 'rolled-back' : 'partial';
  journal.finishedAt = new Date().toISOString();
  writeJournal(journalFile, journal);
  return result(allBack ? (wroteAny ? 'failed-rolled-back' : 'failed-nothing-written') : 'failed-partial', files,
    { failure, journalFile, message: summaryMessage(allBack, wroteAny, files) });
}

/** 最後に全ファイルを読み直して決めた状態 */
function finalStates(items, journal, io) {
  return items.map((it, i) => {
    const h = sha256(io.read(it.abs));
    const f = journal.files[i];
    return {
      rel: it.rel, state: f.state, label: FILE_STATE_LABEL[f.state], note: f.note ?? null,
      content: h === f.beforeHash ? 'at-before' : h === f.afterHash ? 'at-after' : 'other',
      currentHash: h,
    };
  });
}

/** 利用者へ出す1文。**書いていないことを確かめたときだけ**「何も書き込んでいません」と言う */
function summaryMessage(allBack, wroteAny, files) {
  if (allBack && !wroteAny) return '途中で失敗しました。どのファイルにも書き込んでいません（読み直して確認済み）。';
  if (allBack) return `途中で失敗しました。書き込んだ ${files.filter((f) => f.state === 'rolled-back').length} 件は元の内容に戻しました（読み直して確認済み）。`;
  const left = files.filter((f) => f.content !== 'at-before').map((f) => `${f.rel}（${f.label}・${f.content === 'at-after' ? '変更後の内容' : '別の内容'}）`);
  return `途中で失敗し、元に戻せていないファイルがあります: ${left.join('、')}。Git の差分で確認してください。`;
}

/** プロセスが途中で落ちた後に、ジャーナルから各ファイルの状態を調べる（書き換えない） */
function inspectJournal(journalFile) {
  const j = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  return {
    txId: j.txId, state: j.state,
    files: j.files.map((f) => {
      const abs = safePath(j.root, f.rel);
      const h = abs ? sha256(fs.readFileSync(abs, 'utf8')) : null;
      return { rel: f.rel, recorded: f.state, content: h === f.beforeHash ? 'at-before' : h === f.afterHash ? 'at-after' : 'other' };
    }),
  };
}

/** 落ちた後の復旧。変更後の内容がそのまま残っているファイルだけを戻す */
function recoverJournal(journalFile, io = realIo) {
  const j = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const out = [];
  for (const f of j.files) {
    const abs = safePath(j.root, f.rel);
    const h = sha256(io.read(abs));
    if (h === f.beforeHash) { out.push({ rel: f.rel, action: 'none', content: 'at-before' }); continue; }
    if (h !== f.afterHash) { out.push({ rel: f.rel, action: 'refused', content: 'other' }); continue; }
    io.writeAtomic(abs, Buffer.from(f.before, 'base64').toString('utf8'));
    out.push({ rel: f.rel, action: 'restored', content: sha256(io.read(abs)) === f.beforeHash ? 'at-before' : 'other' });
  }
  j.state = out.every((o) => o.content === 'at-before') ? 'recovered' : 'partial-after-recovery';
  writeJournal(journalFile, j);
  return { state: j.state, files: out };
}

/* ---------------------------------------------------------- 観測の鮮度 */

/**
 * 記録済みの観測が、いまのコードの版の実測と言えるか（02e 6.6 F 軸）。
 * 版が一致し、**観測の後に IDE が書き込んでいない**ときだけ current。
 * 書いた後に内容が元へ戻った場合も current にしない（同じ内容でも、観測の後に描画が変わっている）。
 */
function observationFreshness(obs, current, writes) {
  if (!obs || !obs.revision) return { state: 'unknown', label: '対応不明' };
  if (obs.revision !== current) return { state: 'stale', label: `古い（観測の版 ${obs.revision.slice(0, 7)} ≠ 現在 ${current.slice(0, 7)}）` };
  if (writes.some((w) => w.at > obs.at)) return { state: 'stale', label: '古い（観測の後にコードへ書き込みました）' };
  return { state: 'current', label: '現在のコードと一致' };
}

/* -------------------------------------------------- 幅の帯（予測の範囲） */

/**
 * 基本 variant の token を変えたとき、どの幅で見た目が変わるか（**予測**）。
 * overrides: [{ variant: 'md', minPx: 768 }]（プロジェクトの Tailwind から読んだ値）
 */
function widthBand(overrides, opened) {
  const firstOverride = overrides.length ? Math.min(...overrides.map((o) => o.minPx)) : Infinity;
  return {
    changes: { from: 0, to: firstOverride === Infinity ? null : firstOverride - 1 },
    unchanged: firstOverride === Infinity ? null : { from: firstOverride, to: null, by: overrides.map((o) => o.token) },
    opened: opened.map((w) => ({ width: w, expectChange: w < firstOverride })),
  };
}

/** className の token と、基本 variant の余白の token（今回の編集対象の候補） */
function classSummary(source, rel, target) {
  const ins = inspectClassName(source, rel, target);
  if (!ins.ok) return ins;
  const tokens = ins.tokens.map((t) => t.text);
  return { ok: true, tokens, basePadding: tokens.filter((t) => PADDING_BASE.test(t)),
    overrides: tokens.filter((t) => t.includes(':') && PADDING_FAMILY.test(t.split(':').pop())) };
}

module.exports = {
  sha256, classSummary, PADDING_BASE, revisionOf, revisionFiles, locateClassToken, unifiedDiff, patchToken, Draft, realIo, safePath,
  applyOne, revertOne, applyTransaction, inspectJournal, recoverJournal, observationFreshness, widthBand,
  REASON, FILE_STATE_LABEL,
};
