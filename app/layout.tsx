/**
 * Root layout — wraps every page.
 *
 * Responsibilities:
 *   - Register the Geist font families as CSS variables.
 *   - Set app-wide metadata (title template, description).
 *   - Apply base font + antialiased rendering on <html>.
 *
 * Any page-specific metadata is set in that page's `metadata` export
 * and merges into the `%s` slot of the title template below.
 */
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeCookieSync } from '@/components/theme-cookie-sync';
import {
  THEME_COOKIE,
  resolveThemeFromCookie,
} from '@/lib/themes-cookie';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Consultway Ops',
    template: '%s · Consultway Ops',
  },
  description:
    'Internal operations portal for Consultway Infotech — company onboarding, tenders, projects.',
  icons: {
    icon: '/favicon.ico',
  },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Read the theme cookie server-side so SSR emits <html data-theme="...">
  // with the user's selected palette already applied — no flash on first
  // paint. Falls back to the default theme when no cookie is present
  // (first visit, cleared storage, etc.).
  const cookieStore = await cookies();
  const initialTheme = resolveThemeFromCookie(
    cookieStore.get(THEME_COOKIE)?.value,
  );

  return (
    <html
      lang="en"
      data-theme={initialTheme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-background font-sans text-foreground">
        {/* ThemeProvider mounts next-themes with our 6-palette catalog.
            `initialTheme` (from the cookie) keeps the server-rendered HTML
            and the first client paint in agreement, eliminating the
            palette flash. */}
        <ThemeProvider initialTheme={initialTheme}>
          {/* Side-effect-only client component — mirrors the active theme
              into the cookie on every change so the next render starts
              from the right palette. */}
          <ThemeCookieSync />
          {children}
          {/* App-wide toast surface. Mounted at the root so any client
              component can call toast() / toast.error() / toast.success()
              without each route remounting its own Toaster. Defaults to
              bottom-right with a 4s autoclose. Visual styling lives in
              `app/globals.css` (Day 26 — toast aesthetic block) so type
              colours track the active palette via CSS vars. Skipping
              sonner's `richColors` prop because our own CSS owns the
              type-specific colouring; `richColors` would emit competing
              inline styles. */}
          <Toaster closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}