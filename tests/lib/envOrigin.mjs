/* =============================================================================
 * Phase 7B-3B-2 — 起動先のプロセスが持つ環境変数の「出所」を分ける（試験用の純粋な関数）。
 *
 * 7B-1 の preview-e2e は「秘密情報の**名前**を1つも受け取っていない」を検査していた。
 * ところが `next dev` は対象プロジェクト自身の `.env*` を読み込み（@next/env）、その後に生む作業プロセス
 * （Turbopack のローダ）はそれを受け継ぐ。**名前だけでは、IDE から漏れた値と、対象プロジェクトが
 * 自分で読んだ値を区別できない**（7B-3B-1 第9.3節）。
 *
 * ここでは名前ではなく**値と出所**で分ける。
 *   ide-secret      値が IDE のプロセスに入れたダミーの秘密情報と一致する／目印を含む → 漏えい（必ず失敗）
 *   project-dotenv  値が対象プロジェクトの `.env*` に書かれた同じ名前の値と一致する → 正常（Next.js の動作）
 *   unexplained     秘密情報の名前を持つが、値がどちらとも一致しない → 出所を説明できない（失敗にする）
 *
 * **前提**: IDE に入れるダミーの値は、対象プロジェクトの `.env*` のどの値とも違うこと。
 * 同じ値だと値からは出所を区別できない（`assertDistinguishable` が検査し、成り立たなければ試験を止める）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

/** dotenv の最小の読み取り（KEY=VALUE、引用符、export 前置、# の注釈）。展開（${X}）はしない */
export function parseDotenv(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = /^(['"`])([\s\S]*)\1\s*(?:#.*)?$/.exec(v);
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, '').trim();
    out.set(m[1], v);
  }
  return out;
}

/** Next.js（@next/env）が開発時に読むファイル。どれか1つに書かれた値を「プロジェクト由来」とする */
export const DOTENV_FILES_DEV = ['.env', '.env.development', '.env.local', '.env.development.local'];

/** 対象プロジェクトの `.env*` の値。名前 → 値の集合 */
export function projectDotenv(projectRoot, files = DOTENV_FILES_DEV) {
  const out = new Map();
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(projectRoot, f), 'utf8'); } catch { continue; }
    for (const [k, v] of parseDotenv(text)) {
      if (!out.has(k)) out.set(k, new Set());
      out.get(k).add(v);
    }
  }
  return out;
}

/** /proc/<pid>/environ の中身（\0 区切り）を名前 → 値に */
export function parseEnviron(text) {
  const out = new Map();
  for (const kv of String(text).split('\0')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    out.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return out;
}

/** IDE に入れたダミーの値と、プロジェクトの `.env*` の値が区別できるか */
export function assertDistinguishable(ideSecrets, dotenv) {
  for (const [k, v] of Object.entries(ideSecrets)) {
    if (dotenv.get(k)?.has(v)) {
      throw new Error(`IDE のダミーの ${k} がプロジェクトの .env の値と同じです。値から出所を区別できません`);
    }
  }
}

/**
 * 1つのプロセスの環境を分類する。
 * @param {{environ: Map<string,string>, ideSecrets: Record<string,string>, mark: string, dotenv: Map<string,Set<string>>}} a
 * @returns {{ideSecret: {name:string, why:string}[], projectDotenv: string[], unexplained: string[]}}
 */
export function classifyEnviron({ environ, ideSecrets, mark, dotenv }) {
  const ideValues = new Set(Object.values(ideSecrets));
  const ideSecret = [];
  const projectOwned = [];
  const unexplained = [];
  for (const [k, v] of environ) {
    /* 1. 値が IDE のものなら、名前が何であれ漏えい（名前を変えて渡っても見逃さない） */
    if (v.includes(mark) || ideValues.has(v)) {
      ideSecret.push({ name: k, why: v.includes(mark) ? 'value-has-ide-mark' : 'value-equals-ide-secret' });
      continue;
    }
    if (!(k in ideSecrets)) continue;
    /* 2. 秘密情報の名前。値がプロジェクトの .env* に書かれたものなら、Next.js が自分で読んだもの */
    if (dotenv.get(k)?.has(v)) projectOwned.push(k);
    else unexplained.push(k);
  }
  return { ideSecret, projectDotenv: projectOwned.sort(), unexplained: unexplained.sort() };
}
