import type { Metadata } from 'next';
import { ThemeProvider } from 'next-themes';
import { AppShell } from '@/components/shell/app-shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'PRAVSHI OS',
  description: 'Internal operations platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-ground text-ink antialiased">
        <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
