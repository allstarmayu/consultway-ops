/**
 * Sidebar navigation for the dashboard area.
 *
 * Client Component because it needs `usePathname()` to derive the active
 * nav item. Everything else is static — the nav items array is hard-coded
 * here (no separate config file) because the list is short, rarely
 * changes, and would be premature abstraction.
 *
 * Active state uses prefix match, not exact equality. Why: when the user
 * navigates from /dashboard/companies → /dashboard/companies/abc-123, we
 * still want "Companies" highlighted. Exact match would lose the active
 * state on detail pages.
 *
 * Role-based visibility is intentionally NOT enforced here. Access control
 * is the page's job (each page reads its own session and decides what to
 * render). The sidebar shows everything so the surface is consistent —
 * if a `company`-role user clicks Reports, they get a 403 page when that
 * module is built, not a missing nav item.
 *
 * @module components/dashboard/sidebar
 */
"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  Building2,
  FileText,
  Briefcase,
  ArrowLeftRight,
  BarChart3,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/db/schema";
import { UserPill } from "./user-pill";

// ── Nav items ───────────────────────────────────────────────────────────────

/**
 * One nav item. `href` doubles as the prefix-match key for active state.
 */
type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/**
 * All seven dashboard sections, in display order. Order matches the
 * figma. Settings is intentionally last; the visual gap before it isn't
 * needed because the user pill at the bottom of the sidebar provides
 * enough separation.
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/companies", label: "Companies", icon: Building2 },
  { href: "/dashboard/tenders", label: "Tenders", icon: FileText },
  { href: "/dashboard/projects", label: "Projects", icon: Briefcase },
  {
    href: "/dashboard/transactions",
    label: "Transactions",
    icon: ArrowLeftRight,
  },
  { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

// ── Props ───────────────────────────────────────────────────────────────────

export interface SidebarProps {
  /** Logged-in user's email — passed straight through to the user pill. */
  userEmail: string;
  /** Logged-in user's role. Used only by the user pill for display. */
  userRole: UserRole;
}

// ── Component ───────────────────────────────────────────────────────────────

export function Sidebar({ userEmail, userRole }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      aria-label="Primary navigation"
      className={cn(
        "sticky top-0 flex h-screen w-64 shrink-0 flex-col",
        "bg-sidebar text-sidebar-foreground",
        "border-r border-sidebar-border",
      )}
    >
      {/* Brand header */}
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-sidebar-primary">
          <Building2
            className="h-5 w-5 text-sidebar-primary-foreground"
            aria-hidden
          />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">
            Consultway Ops
          </p>
          <p className="mt-0.5 text-xs leading-tight text-sidebar-foreground/60">
            Internal portal
          </p>
        </div>
      </div>

      {/* Nav items — scrolls if it ever overflows (it won't at 7 items,
          but defensive). */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = isPathActive(pathname, item.href);
            const Icon = item.icon;

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    // Inactive state — quiet, muted text
                    "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    // Active state — Terracotta accent, full opacity
                    isActive &&
                      "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary hover:text-sidebar-primary-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      isActive
                        ? "text-sidebar-primary-foreground"
                        : "text-sidebar-foreground/60 group-hover:text-sidebar-foreground",
                    )}
                    aria-hidden
                  />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* User pill — bottom of sidebar, includes sign-out */}
      <div className="border-t border-sidebar-border p-3">
        <UserPill email={userEmail} role={userRole} />
      </div>
    </aside>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine whether a nav item is active for the current pathname.
 *
 *   /dashboard          matches only /dashboard exactly — otherwise the
 *                       Dashboard item would light up for EVERY subpage,
 *                       since every dashboard URL starts with /dashboard.
 *   /dashboard/<x>      matches /dashboard/x and any deeper path (e.g.
 *                       /dashboard/x/123 or /dashboard/x/123/edit).
 */
function isPathActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
