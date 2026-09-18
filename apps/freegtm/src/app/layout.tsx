import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FreeGTM — $0 GTM Automation',
  description: 'Self-hosted, zero-cost go-to-market automation. Research companies, find prospects, draft personalized emails — all with free-tier APIs.',
  keywords: ['GTM', 'cold email', 'outreach', 'ICP', 'lead generation', 'free'],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
