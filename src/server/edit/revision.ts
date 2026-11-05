/* =============================================================================
 * 編集 E1 — 版（内容のハッシュ）。
 *
 *   contentHash: ファイルのバイト列の sha256（書き込みの基準。外部変更の検出 — F-03）
 *   rev        : 探索と同じ「ソースの版」= 内容（UTF-8）の sha1 の先頭16桁（anchors.sourceRevision）。
 *                DOM の data-vcide-rev・対応表の rev と比べる（F-01）
 * 2つは同じバイト列から同時に計算する（片方だけ読み直して取り違えない）。
 * UTF-8 として往復できないバイト列（不正なバイト）は扱わない — 文字列として書き戻すと内容が変わるため。
 * Git の HEAD は使わない（未コミットの変更も別の版になる）。
 * ========================================================================== */
import { createHash } from 'node:crypto';
import { sourceRevision } from '../anchors';

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

export const SHA256_RE = /^[0-9a-f]{64}$/;

export interface ContentIdentity {
  /** バイト列の sha256 */
  contentHash: string;
  /** 探索と同じソースの版（sha1 の先頭16桁） */
  rev: string;
  /** 内容（UTF-8 で復号したもの。バイト列と往復一致することを確かめ済み） */
  text: string;
  bytes: number;
}

/** バイト列の版。UTF-8 として往復しない内容は null（扱わない） */
export function identify(buf: Buffer): ContentIdentity | null {
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) return null;
  return { contentHash: sha256(buf), rev: sourceRevision(text), text, bytes: buf.length };
}

/** 文字列の版（書く前の内容から、書いた後に期待する版を計算する） */
export function identifyText(text: string): { contentHash: string; rev: string } {
  return { contentHash: sha256(Buffer.from(text, 'utf8')), rev: sourceRevision(text) };
}
