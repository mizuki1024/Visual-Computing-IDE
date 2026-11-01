import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GRiDDATA — 探索 / Sample Property App',
  description: '探索画面（S-04）。表示されている値の出所をたどる。シナリオは合成データ。',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ja"><body>{children}</body></html>;
}
