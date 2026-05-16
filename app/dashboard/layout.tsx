/**
 * Dashboard layout — wraps every page under /dashboard/*.
 *
 * Renders the persistent Espresso sidebar on the left and a Parchment
 * content area on the right. The session is read once here so the sidebar
 * (Client Component) gets typed props instead of fetching from its own
 * effect — keeps the layout SSR-only and the client bundle smaller.
 *
 * Auth guard: middleware.ts also redirects unauthenticated visitors to
 * /login, but we re-check here as a belt-and-suspenders measure. If the
 * cookie was deleted between middleware and render, we still bounce.
 *
 * Each child page is responsible for its own `<PageHeader>` and content
 * card — the layout intentionally does not add a top bar, because the
 * figma puts the page title flush against the top of the content area
 * (no separate header strip between sidebar and content).
 *
 * @module app/dashboard/layout
 */
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { Sidebar } from "@/components/dashboard/sidebar";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await readSession();
  if (!session) redirect("/login");

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar — fixed width, Espresso bg, full-height. Client Component
          for usePathname() active-state. Props are plain serializable
          values passed from the server. */}
      <Sidebar
        userEmail={session.email}
        userRole={session.role}
      />

      {/* Main content area. Scrolls independently of the sidebar.
          Pages render inside an outer max-width wrapper so dense pages
          (companies list, transactions) don't sprawl on ultra-wide
          monitors. */}
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto w-full max-w-screen-2xl px-6 py-8 lg:px-10 lg:py-10">
          {children}
        </div>
      </main>
    </div>
  );
}
