/* =============================================================================
 * 編集 E1 — 変更内容の検証。E1 で扱う変更は1種類だけ:
 *
 *   { kind: 'class-token', from: 'p-4', to: 'p-5' }
 *   静的な className のリテラルの中の Tailwind の token 1つを、同じ variant（`md:` などの前置き）の別の token に置き換える
 *
 * 拒否するもの（推測で書き換えない）: 知らないキー・別の種類・同じ値・variant を変える・任意値（`p-[13px]`）・
 * 引用符や空白などを含む文字・変更前の token が無い/2つ以上ある・変更後の token が既にある・
 * 条件付き/組み立てた className（target.ts の ClassInfo）。
 * ========================================================================== */
import type { ClassInfo, ClassRefusal } from './target';

export interface ClassTokenChange { kind: 'class-token'; from: string; to: string }

/** Tailwind の token の形（E1: 英小文字・数字・-・.・/ と、`variant:` の前置き・`!`・負の値の `-`）。任意値 `[...]` は扱わない */
export const CLASS_TOKEN_RE = /^(?:[a-z][a-z0-9-]*:)*!?-?[a-z][a-z0-9]*(?:-(?:[a-z0-9]+(?:\.[0-9]+)?|[0-9]+\/[0-9]+))*$/;
const MAX_TOKEN = 100;

export type ChangeRefusal =
  | 'invalid-change' | 'variant-mismatch' | 'unsupported-class' | 'token-not-found' | 'token-ambiguous' | 'token-already-present';

export const CHANGE_REFUSAL_TEXT: Record<ChangeRefusal, string> = {
  'invalid-change': 'E1 が扱う変更（静的な className の Tailwind の token 1つの置き換え）の形ではありません',
  'variant-mismatch': '変更の前後で variant（md: などの前置き）が違います。どの幅に効く指定を変えるかは E1 では変えません',
  'unsupported-class': 'この要素の className は、書き換える token を一意に決められる形ではありません',
  'token-not-found': '書き換える token が className の中にありません',
  'token-ambiguous': '書き換える token が className の中に2つ以上あり、一意に決められません',
  'token-already-present': '変更後の token が既に className にあります',
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export const variantOf = (t: string): string => (t.includes(':') ? t.slice(0, t.lastIndexOf(':') + 1) : '');

export function parseChange(v: unknown): { ok: true; change: ClassTokenChange } | { ok: false; reason: ChangeRefusal; detail: string } {
  const bad = (reason: ChangeRefusal, extra = '') => ({ ok: false as const, reason, detail: `${CHANGE_REFUSAL_TEXT[reason]}${extra ? `（${extra}）` : ''}` });
  if (!isObj(v) || !Object.keys(v).every((k) => ['kind', 'from', 'to'].includes(k)) || v.kind !== 'class-token') return bad('invalid-change');
  const { from, to } = v;
  if (typeof from !== 'string' || typeof to !== 'string' || from.length > MAX_TOKEN || to.length > MAX_TOKEN) return bad('invalid-change');
  if (!CLASS_TOKEN_RE.test(from) || !CLASS_TOKEN_RE.test(to)) return bad('invalid-change', 'token の形');
  if (from === to) return bad('invalid-change', '同じ値');
  if (variantOf(from) !== variantOf(to)) return bad('variant-mismatch', `${from} → ${to}`);
  return { ok: true, change: { kind: 'class-token', from, to } };
}

/** className のリテラルの中で、書き換える token の範囲（ファイルの中のオフセット）を1つに決める */
export function locateToken(cls: ClassInfo, change: ClassTokenChange):
  { ok: true; start: number; end: number; tokens: string[] } | { ok: false; reason: ChangeRefusal; detail: string; classReason?: ClassRefusal } {
  if (cls.kind !== 'literal') return { ok: false, reason: 'unsupported-class', detail: CHANGE_REFUSAL_TEXT['unsupported-class'], classReason: cls.reason };
  const hits = cls.tokens.filter((t) => t.text === change.from);
  if (hits.length === 0) return { ok: false, reason: 'token-not-found', detail: `${CHANGE_REFUSAL_TEXT['token-not-found']}（${change.from}）` };
  if (hits.length > 1) return { ok: false, reason: 'token-ambiguous', detail: `${CHANGE_REFUSAL_TEXT['token-ambiguous']}（${hits.length} 個）` };
  if (cls.tokens.some((t) => t.text === change.to)) return { ok: false, reason: 'token-already-present', detail: CHANGE_REFUSAL_TEXT['token-already-present'] };
  return { ok: true, start: hits[0].start, end: hits[0].end, tokens: cls.tokens.map((t) => t.text) };
}
