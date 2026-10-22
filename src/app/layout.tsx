import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Autonomous E-Commerce Support & Fraud-Guard Agent',
  description:
    'A Strands Decider 2B gatekeeper that screens every customer turn before an expensive Bedrock Claude 3.5 Sonnet agent or a money-moving tool is ever invoked.',
};

export const viewport: Viewport = {
  themeColor: '#020617',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
