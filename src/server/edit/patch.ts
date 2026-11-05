/* =============================================================================
 * 編集 E1 — 差分の生成。**書き換えるのは、特定した範囲の1つの token だけ。**
 * 文字列全体の置換・正規表現による置換・再出力（整形）をしない。範囲の外は1文字も変えていないことを確かめる。
 * ========================================================================== */
import { sha256 } from './revision';

export interface TokenRange { start: number; end: number }

/** range の中身が from であることを確かめ、to に差し替えた内容を返す。前後が1文字でも変われば例外 */
export function patchToken(text: string, range: TokenRange, from: string, to: string): string {
  if (range.start < 0 || range.end > text.length || range.end - range.start !== from.length || text.slice(range.start, range.end) !== from) {
    throw new Error('range-mismatch');
  }
  const next = text.slice(0, range.start) + to + text.slice(range.end);
  if (next.slice(0, range.start) !== text.slice(0, range.start) || next.slice(range.start + to.length) !== text.slice(range.end)
    || next.length !== text.length - from.length + to.length) {
    throw new Error('patch-invariant');
  }
  return next;
}

/** 書いた内容（after）から、書く前の内容を作り直す（取り消し・復旧。ジャーナルに本文を写さないため） */
export function unpatchToken(after: string, start: number, from: string, to: string): string {
  return patchToken(after, { start, end: start + to.length }, to, from);
}

/** 表示用の unified diff（1か所の変更） */
export function unifiedDiff(rel: string, a: string, b: string, context = 2): string {
  const A = a.split('\n');
  const B = b.split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length - 1;
  let eb = B.length - 1;
  while (ea >= s && eb >= s && A[ea] === B[eb]) { ea--; eb--; }
  if (s > ea && s > eb) return '';
  const cs = Math.max(0, s - context);
  const ceA = Math.min(A.length - 1, ea + context);
  const ceB = Math.min(B.length - 1, eb + context);
  const lines = [`--- a/${rel}`, `+++ b/${rel}`, `@@ -${cs + 1},${ceA - cs + 1} +${cs + 1},${ceB - cs + 1} @@`];
  for (let i = cs; i < s; i++) lines.push(` ${A[i]}`);
  for (let i = s; i <= ea; i++) lines.push(`-${A[i]}`);
  for (let i = s; i <= eb; i++) lines.push(`+${B[i]}`);
  for (let i = ea + 1; i <= ceA; i++) lines.push(` ${A[i]}`);
  return lines.join('\n');
}

/** 確認した差分の同定（差分の本文・基準の内容・書いた後の内容の3つに結び付ける） */
export const diffHashOf = (diff: string, baseHash: string, afterHash: string): string => sha256(`${baseHash}\n${afterHash}\n${diff}`);
