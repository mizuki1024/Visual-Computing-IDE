/* =============================================================================
 * プレビューの中の小さなスクリプト（previewGateway.ts の AGENT_JS）と IDE の画面の間の
 * 通信の形（Phase 7B-2）。**受け取る側はすべてここで検査する。**
 *
 * 経路
 *   1. スクリプト → 親（window.postMessage）  `hello` だけ。中身を持たない
 *   2. 親 → スクリプト（window.postMessage、宛先の origin を明示）  `connect` と MessagePort
 *   3. 以後はその MessagePort だけを使う（場所の知らせ・選択・選択モード）
 *
 * 検査の方針
 *   - 型・版・種別・値の範囲を見る。**知らないキーがあれば捨てる**（余計な中身を受け取らない）
 *   - 送ってよいのは「要素識別子・タグ名・何番目か・テキストの文字数と文字種・パス」だけ。
 *     本文・属性・フォームの値・Cookie は形の上で入る場所が無い
 *   - 選択の中のソース位置は**受け取らない**。位置は IDE が自分の対応表から引く（anchors.ts）
 *
 * 純粋な関数だけを置く（画面・サーバーの両方と、素の Node のテストから使う）。
 * ========================================================================== */

export const PROTOCOL_VERSION = 2;
export const AGENT_SOURCE = 'vcide-preview';
export const IDE_SOURCE = 'vcide-ide';

/** 要素識別子の形（poc/anchor/transform.cjs の anchorId: sha1 の先頭10桁） */
export const ANCHOR_ID_RE = /^[0-9a-f]{10}$/;
const TAG_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,63}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const VALUE_CLASSES = ['cjk', 'latin', 'digits', 'mixed', 'other'] as const;
export type ValueClass = typeof VALUE_CLASSES[number];

export const MAX_ANCESTORS = 32;
const MAX_PATH = 2048;
const MAX_TITLE = 300;
const MAX_COUNT = 100_000;

/** 選択された要素について、スクリプトが送ってよいもの（これ以外は持たない） */
export interface ElementSelection {
  tag: string;
  /** **この要素自身に付いていた**識別子。祖先のものではない */
  anchorOnSelf: string | null;
  /** 同一識別子の DOM 要素のうち何番目か（0 始まり） */
  anchorOrdinal: number | null;
  anchorInstanceCount: number;
  /** 祖先の識別子（近い順）。包含関係の文脈であって、この要素の出所ではない */
  ancestorAnchors: string[];
  /** 直下の空でないテキストノードの索引。無ければ null */
  textNodeIndex: number | null;
  /** 値の形だけ。値そのものは送らない */
  valueShape: { chars: number; cls: ValueClass } | null;
  /** フォームの部品・編集可能な要素。値の形も取らない */
  formControl: boolean;
  /** 選択したページのパス（クエリ・ハッシュは含めない） */
  path: string;
}

export type AgentMessage =
  | { kind: 'connected'; nonce: string }
  | {
    kind: 'ready' | 'navigate' | 'replace' | 'load'; nonce: string;
    path: string; title: string; status: number | null; soft: boolean; from: 'app' | 'gateway';
  }
  | { kind: 'mode'; nonce: string; select: boolean }
  | { kind: 'select'; nonce: string; seq: number; selection: ElementSelection };

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).every((k) => keys.includes(k));
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isPath = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_PATH && v.startsWith('/') && !v.startsWith('//')
  // 制御文字を含めない
  && !/[\u0000-\u001f\u007f]/.test(v);

/** 最初の知らせ（window.postMessage）。中身を持たない */
export function isAgentHello(d: unknown): boolean {
  return isObj(d) && onlyKeys(d, ['source', 'v', 'kind'])
    && d.source === AGENT_SOURCE && d.v === PROTOCOL_VERSION && d.kind === 'hello';
}

/** 選択の中身の検査。サーバー（解決の API）でも同じものを使う */
export function parseSelection(v: unknown): ElementSelection | null {
  if (!isObj(v)) return null;
  const KEYS = ['tag', 'anchorOnSelf', 'anchorOrdinal', 'anchorInstanceCount', 'ancestorAnchors',
    'textNodeIndex', 'valueShape', 'formControl', 'path'] as const;
  if (!onlyKeys(v, KEYS)) return null;
  if (typeof v.tag !== 'string' || !TAG_RE.test(v.tag)) return null;
  const self = v.anchorOnSelf;
  if (self !== null && (typeof self !== 'string' || !ANCHOR_ID_RE.test(self))) return null;
  if (!isInt(v.anchorInstanceCount, 0, MAX_COUNT)) return null;
  const ord = v.anchorOrdinal;
  if (self === null) {
    // 識別子が無いなら、何番目かも数も無い
    if (ord !== null || v.anchorInstanceCount !== 0) return null;
  } else if (!isInt(ord, 0, MAX_COUNT) || v.anchorInstanceCount < 1 || ord >= v.anchorInstanceCount) {
    return null;
  }
  if (!Array.isArray(v.ancestorAnchors) || v.ancestorAnchors.length > MAX_ANCESTORS
    || !v.ancestorAnchors.every((a) => typeof a === 'string' && ANCHOR_ID_RE.test(a))) return null;
  const ti = v.textNodeIndex;
  if (ti !== null && !isInt(ti, 0, MAX_COUNT)) return null;
  if (typeof v.formControl !== 'boolean') return null;
  const vs = v.valueShape;
  let valueShape: ElementSelection['valueShape'] = null;
  if (vs !== null) {
    if (!isObj(vs) || !onlyKeys(vs, ['chars', 'cls']) || !isInt(vs.chars, 1, 1_000_000)
      || !VALUE_CLASSES.includes(vs.cls as ValueClass)) return null;
    // フォームの部品には値の形も持たせない。テキストノードが無いのに形があるのも矛盾
    if (v.formControl || ti === null) return null;
    valueShape = { chars: vs.chars, cls: vs.cls as ValueClass };
  }
  if (!isPath(v.path)) return null;
  return {
    tag: v.tag, anchorOnSelf: self as string | null, anchorOrdinal: ord as number | null,
    anchorInstanceCount: v.anchorInstanceCount, ancestorAnchors: [...v.ancestorAnchors] as string[],
    textNodeIndex: ti as number | null, valueShape, formControl: v.formControl, path: v.path,
  };
}

/**
 * MessagePort で届いた知らせの検査。`nonce` はこの接続で IDE が渡したものと一致しなければならない。
 * 一致しない・形が違う・知らないキーがある → null（捨てる）
 */
export function parseAgentMessage(d: unknown, nonce: string): AgentMessage | null {
  if (!isObj(d) || d.source !== AGENT_SOURCE || d.v !== PROTOCOL_VERSION || d.nonce !== nonce) return null;
  const base = ['source', 'v', 'kind', 'nonce'];
  switch (d.kind) {
    case 'connected':
      return onlyKeys(d, base) ? { kind: 'connected', nonce } : null;
    case 'ready': case 'navigate': case 'replace': case 'load': {
      if (!onlyKeys(d, [...base, 'path', 'title', 'status', 'soft', 'from'])) return null;
      // 場所の知らせはクエリ・ハッシュまで含む（パネルの入力欄に出すため）
      if (!isPath(d.path) || typeof d.title !== 'string' || d.title.length > MAX_TITLE) return null;
      if (d.status !== null && !isInt(d.status, 100, 599)) return null;
      if (typeof d.soft !== 'boolean' || (d.from !== 'app' && d.from !== 'gateway')) return null;
      return {
        kind: d.kind, nonce, path: d.path, title: d.title,
        status: d.status as number | null, soft: d.soft, from: d.from,
      };
    }
    case 'mode':
      return onlyKeys(d, [...base, 'select']) && typeof d.select === 'boolean'
        ? { kind: 'mode', nonce, select: d.select } : null;
    case 'select': {
      if (!onlyKeys(d, [...base, 'seq', 'selection']) || !isInt(d.seq, 1, Number.MAX_SAFE_INTEGER)) return null;
      const selection = parseSelection(d.selection);
      return selection ? { kind: 'select', nonce, seq: d.seq, selection } : null;
    }
    default:
      return null;
  }
}

export const isNonce = (s: unknown): s is string => typeof s === 'string' && NONCE_RE.test(s);

/** 選択を解決する API に渡す「どの開発サーバーのページで選んだか」 */
export interface RunKey { instance: string; pid: number; startedAt: string }

export function parseRunKey(v: unknown): RunKey | null {
  if (!isObj(v) || !onlyKeys(v, ['instance', 'pid', 'startedAt'])) return null;
  if (typeof v.instance !== 'string' || v.instance.length > 64 || !isInt(v.pid, 1, 2 ** 31)
    || typeof v.startedAt !== 'string' || v.startedAt.length > 40) return null;
  return { instance: v.instance, pid: v.pid, startedAt: v.startedAt };
}
