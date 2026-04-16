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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-background font-sans text-foreground">
        {children}
      </body>
    </html>
  );
}