import './globals.css';

export const metadata = { title: 'GRiDDATA（編集 PoC の題材）' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
