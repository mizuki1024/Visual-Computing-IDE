/* =============================================================================
 * 視覚編集 E2.1 — プレビューの中のスクリプト（previewGateway.ts の agentJs、editSync を有効にしたときだけ）と
 * 開発用の同期の画面の間の、**編集専用**の知らせ（docs/08d 第4節）。
 *
 * 探索の知らせ（previewProtocol.ts の ElementSelection v3・hello / connect / mode / select）は**変えない**。
 * ここに足すのは、同じ MessagePort・同じ版（PROTOCOL_VERSION = 3）・同じ nonce の上に乗る、別の種類の知らせだけ:
 *   IDE → スクリプト  `edit-observe`  { req }                 いま選んでいる要素（編集の同期用）の観測を1回求める
 *   スクリプト → IDE  `edit-observation` { req, state, ... }  その答え（求められたときだけ。自分からは送らない）
 * 探索の画面（LivePreview）は `edit-observe` を送らないので、`edit-observation` を受けることは無い
 * （受けても parseAgentMessage が知らない種類として捨てる）。
 *
 * 送ってよいもの（情報の最小化。previewProtocol と同じ方針）
 *   - 要素の選択（ElementSelection。previewProtocol.parseSelection で検査する。**位置は送らない**）
 *   - 要素の矩形（表示・観測用。書き込み先を決める根拠にしない）
 *   - 計算済みスタイルのうち、下の STYLE_PROPS に挙げた見た目の値だけ（本文・属性・フォームの値・URL は入らない）
 *   - 文書の識別子（中継が応答に付けたもの）・ページ内の遷移の有無・この文書が送った RSC の要求の数・ビューポートの大きさ
 * 送らないもの: 本文・属性の値・フォームの値・Cookie・認証の値・className（E2.1 では使わない）
 *
 * **スクリプトはアプリと同じ JavaScript の世界で動く。** ここで受け取る値はすべて「スクリプトの申告」であり、
 * 悪意のあるアプリに対する強い認証にはならない。IDE は申告を、サーバー側の記録（中継の台帳・対応表・ソースの読み直し）と
 * 照らした範囲でだけ使う（editSyncBinding.ts）。
 * ========================================================================== */
import { AGENT_SOURCE, DOC_TOKEN_RE, IDE_SOURCE, PROTOCOL_VERSION, parseSelection, type ElementSelection } from './previewProtocol';

/** 編集の知らせの拡張の版。探索の PROTOCOL_VERSION とは別に数える */
export const EDIT_EXT_VERSION = 1;

/** 中継が、文書のスクリプトが送った RSC の要求から読む（そして開発サーバーへは渡さない）ヘッダ */
export const EDIT_DOC_HEADER = 'x-vcide-doc';

/** 開発用の同期の画面が開く2枚のアートボード（docs/07d 1.2・04e） */
export const ARTBOARDS = {
  desktop: { width: 1440, height: 900, label: 'Desktop' },
  mobile: { width: 375, height: 812, label: 'Mobile' },
} as const;
export type ArtboardId = keyof typeof ARTBOARDS;
export const ARTBOARD_IDS = Object.keys(ARTBOARDS) as ArtboardId[];
export const isArtboardId = (v: unknown): v is ArtboardId => v === 'desktop' || v === 'mobile';

/** 送ってよい計算済みスタイル（見た目の値だけ。content・background-image など URL や文字を含みうるものは入れない） */
export const STYLE_PROPS = [
  'display', 'position', 'box-sizing', 'width', 'height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'font-size', 'font-weight', 'line-height', 'color', 'background-color',
  'border-top-width', 'border-radius', 'gap', 'flex-direction', 'opacity',
] as const;
const STYLE_VALUE_RE = /^[0-9a-zA-Z.,%()# -]{0,80}$/;

export interface EditRect { x: number; y: number; width: number; height: number }

/** スクリプトの答え。state: ok = 選んだ要素がいまも文書にある / detached = 選んだ DOM ノードが文書から外れた / none = 選んでいない */
export interface EditObservation {
  kind: 'edit-observation';
  nonce: string;
  req: number;
  state: 'ok' | 'detached' | 'none';
  selection: ElementSelection | null;
  rect: EditRect | null;
  style: Record<string, string> | null;
  document: { token: string | null; soft: boolean | null };
  /** この文書のスクリプトが送った RSC の要求の数（started）と、応答の届いた数（settled）。**スクリプトの申告** */
  rsc: { started: number; settled: number };
  viewport: { width: number; height: number };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown, lim: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;

/** IDE → スクリプト: 観測を求める知らせ */
export function editObserveMessage(nonce: string, req: number): Record<string, unknown> {
  return { source: IDE_SOURCE, v: PROTOCOL_VERSION, nonce, kind: 'edit-observe', ev: EDIT_EXT_VERSION, req };
}

/**
 * スクリプト → IDE の `edit-observation` の検査。型・版・拡張の版・nonce・知らないキーを見る。合わなければ null（捨てる）。
 * `expectReq` を渡せば、その求めへの答えだけを受ける（古い求めへの遅れた答えを捨てる）。
 */
export function parseEditObservation(d: unknown, nonce: string, expectReq?: number): EditObservation | null {
  if (!isObj(d) || d.source !== AGENT_SOURCE || d.v !== PROTOCOL_VERSION || d.nonce !== nonce) return null;
  if (d.kind !== 'edit-observation' || d.ev !== EDIT_EXT_VERSION) return null;
  if (!onlyKeys(d, ['source', 'v', 'kind', 'nonce', 'ev', 'req', 'state', 'selection', 'rect', 'style', 'doc', 'soft', 'rsc', 'vw', 'vh'])) return null;
  if (!isInt(d.req, 1, Number.MAX_SAFE_INTEGER) || (expectReq !== undefined && d.req !== expectReq)) return null;
  if (d.state !== 'ok' && d.state !== 'detached' && d.state !== 'none') return null;
  let selection: ElementSelection | null = null;
  if (d.state === 'ok') {
    selection = parseSelection(d.selection);
    if (!selection) return null;
  } else if (d.selection !== null) return null;
  let rect: EditRect | null = null;
  if (d.rect !== null) {
    const r = d.rect;
    if (d.state !== 'ok' || !isObj(r) || !onlyKeys(r, ['x', 'y', 'width', 'height'])
      || !isNum(r.x, 1e6) || !isNum(r.y, 1e7) || !isNum(r.width, 1e6) || !isNum(r.height, 1e7) || r.width < 0 || r.height < 0) return null;
    rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  let style: Record<string, string> | null = null;
  if (d.style !== null) {
    if (d.state !== 'ok' || !isObj(d.style)) return null;
    const e = Object.entries(d.style);
    if (!e.every(([k, v]) => (STYLE_PROPS as readonly string[]).includes(k) && typeof v === 'string' && STYLE_VALUE_RE.test(v))) return null;
    style = Object.fromEntries(e) as Record<string, string>;
  }
  if (d.doc !== null && (typeof d.doc !== 'string' || !DOC_TOKEN_RE.test(d.doc))) return null;
  if (d.soft !== null && typeof d.soft !== 'boolean') return null;
  const rsc = d.rsc;
  if (!isObj(rsc) || !onlyKeys(rsc, ['started', 'settled']) || !isInt(rsc.started, 0, 1_000_000)
    || !isInt(rsc.settled, 0, 1_000_000) || rsc.settled > rsc.started) return null;
  if (!isInt(d.vw, 1, 100_000) || !isInt(d.vh, 1, 100_000)) return null;
  return {
    kind: 'edit-observation', nonce, req: d.req, state: d.state, selection, rect, style,
    document: { token: (d.doc as string | null), soft: (d.soft as boolean | null) },
    rsc: { started: rsc.started, settled: rsc.settled },
    viewport: { width: d.vw, height: d.vh },
  };
}

/* ============================================================================
 * 画面の側の接続の判定（純粋な関数。開発用の同期の画面と、素の Node の試験が同じものを使う）
 * ========================================================================== */

/** アートボード1枚の、中継のスクリプトとの接続1本（iframe の文書ごとに作り直す） */
export interface EditConn {
  artboard: ArtboardId;
  /** この接続の識別子（画面が作る乱数。サーバーの登録と照らす） */
  id: string;
  nonce: string;
  /** どの開発サーバーの起動のページか（instance:pid:startedAt） */
  serverKey: string;
  /** どの IDE の起動の画面か（サーバーが返した ideBoot） */
  ideBoot: string;
}

export type PortRejectReason =
  | 'malformed' | 'nonce-mismatch' | 'not-current-connection' | 'other-artboard' | 'server-changed' | 'ide-restarted';

/**
 * MessagePort に届いた知らせを、このアートボードのいまの接続のものとして受けてよいか。
 * 受けてよいのは、**いまの接続（current）と同じ接続**から来た・nonce が一致する・アートボードが同じ・
 * 開発サーバーと IDE の起動が同じ、のときだけ。古い MessagePort（読み込み直す前の文書）の知らせは捨てる。
 */
export function acceptEditPortMessage(
  from: EditConn, current: EditConn | null, artboard: ArtboardId, now: { serverKey: string | null; ideBoot: string | null }, data: unknown,
  expectReq?: number,
): { ok: true; observation: EditObservation } | { ok: false; reason: PortRejectReason } {
  if (from.artboard !== artboard) return { ok: false, reason: 'other-artboard' };
  if (!current || current.id !== from.id || current.nonce !== from.nonce) return { ok: false, reason: 'not-current-connection' };
  if (from.serverKey !== now.serverKey) return { ok: false, reason: 'server-changed' };
  if (from.ideBoot !== now.ideBoot) return { ok: false, reason: 'ide-restarted' };
  if (isObj(data) && data.nonce !== from.nonce) return { ok: false, reason: 'nonce-mismatch' };
  const o = parseEditObservation(data, from.nonce, expectReq);
  return o ? { ok: true, observation: o } : { ok: false, reason: 'malformed' };
}

/* ============================================================================
 * 画面 → IDE のサーバー: 観測の要約（編集の同期の API が受け取る形）
 * ========================================================================== */

/**
 * サーバーが受け取る観測。**矩形・計算済みスタイルは受け取らない**（表示・観測用であり、書き込み先・照合の根拠にしない）。
 * 選択（ElementSelection）にも位置は無い。位置はサーバーが対応表とソースの読み直しで決める。
 */
export interface ObservationBody {
  state: 'ok' | 'detached' | 'none';
  selection: ElementSelection | null;
  document: { token: string | null; soft: boolean | null };
  rsc: { started: number; settled: number };
  viewport: { width: number; height: number };
}

export function parseObservationBody(v: unknown): ObservationBody | null {
  if (!isObj(v) || !onlyKeys(v, ['state', 'selection', 'document', 'rsc', 'viewport'])) return null;
  if (v.state !== 'ok' && v.state !== 'detached' && v.state !== 'none') return null;
  let selection: ElementSelection | null = null;
  if (v.state === 'ok') { selection = parseSelection(v.selection); if (!selection) return null; } else if (v.selection !== null) return null;
  const d = v.document;
  if (!isObj(d) || !onlyKeys(d, ['token', 'soft'])) return null;
  if (d.token !== null && (typeof d.token !== 'string' || !DOC_TOKEN_RE.test(d.token))) return null;
  if (d.soft !== null && typeof d.soft !== 'boolean') return null;
  const r = v.rsc;
  if (!isObj(r) || !onlyKeys(r, ['started', 'settled']) || !isInt(r.started, 0, 1_000_000) || !isInt(r.settled, 0, 1_000_000) || r.settled > r.started) return null;
  const vp = v.viewport;
  if (!isObj(vp) || !onlyKeys(vp, ['width', 'height']) || !isInt(vp.width, 1, 100_000) || !isInt(vp.height, 1, 100_000)) return null;
  return {
    state: v.state, selection, document: { token: d.token as string | null, soft: d.soft as boolean | null },
    rsc: { started: r.started, settled: r.settled }, viewport: { width: vp.width, height: vp.height },
  };
}

/** 画面が受けた観測から、サーバーへ送る要約を作る（矩形・スタイルを落とす） */
export const observationBodyOf = (o: EditObservation): ObservationBody => ({
  state: o.state, selection: o.selection, document: { ...o.document }, rsc: { ...o.rsc }, viewport: { ...o.viewport },
});
