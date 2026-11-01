'use client';
/* 無効なものに、無効である理由を読ませるための小さな吹き出し（IX-23 / IX-24）。 */
import type { ReactNode } from 'react';

export default function Why({ children, reason, detail, align = 'l' }: {
  children: ReactNode; reason: string; detail?: string; align?: 'l' | 'r';
}) {
  return (
    <span className={`why${align === 'r' ? ' r' : ''}`} tabIndex={0} role="note">
      {children}
      <span className="bub">{reason}{detail && <em>{detail}</em>}</span>
    </span>
  );
}
