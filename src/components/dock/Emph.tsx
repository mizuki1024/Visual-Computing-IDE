/* =============================================================================
 * 右ドックの文章の強調（Phase 7C-0）。
 *
 * 変換（src/lib/adapter.ts ほか）は、強調したい語を `**…**` で囲んだ文字列を返す。
 * 右ドックはそれを素の文字列として描いていたため、`**` が記号のまま画面に出ていた
 * （07b3b2 第10節 11）。ここで `**…**` だけを <b> に置き換える。
 * 他の Markdown は解釈しない（文言を変えない・HTML として描かない）。
 * 対にならない `**` は記号のまま残す（意味を推測して消さない）。
 * ========================================================================== */
import { Fragment, type ReactNode } from 'react';

/** `**` を外した文字列（title 属性など、要素を置けない場所に使う） */
export const plainEmph = (s: string): string => s.replace(/\*\*([^*]+?)\*\*/g, '$1');

export default function Emph({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  if (!text.includes('**')) return <>{text}</>;
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={`t${last}`}>{text.slice(last, m.index)}</Fragment>);
    out.push(<b key={`b${m.index}`}>{m[1]}</b>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={`t${last}`}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}
