import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
import './globals.css';

/**
 * The design system's named fonts, actually loaded (Phase 12, F-12-07).
 * globals.css named 'Inter var' / 'JetBrains Mono' from the start but nothing
 * ever loaded them, so every client silently fell back to the system stack.
 * next/font self-hosts the files at build time — no runtime request to Google,
 * and CSP `font-src 'self'` already permits them. The `variable` names are the
 * ones @theme in globals.css consumes.
 */
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });
const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: 'PRAVSHI OS',
  description: 'Internal operations platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetBrainsMono.variable}`}
    >
      <body className="bg-ground text-ink antialiased">
        <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
