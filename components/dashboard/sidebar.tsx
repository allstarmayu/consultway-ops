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
 * Day 26 changes:
 *   - Active background swap replaced with a framer-motion `layoutId`
 *     pill that physically slides between nav items (same pattern as
 *     the Settings nav).
 *   - Body extracted into `<SidebarContent>` so the desktop aside and
 *     the mobile drawer ([mobile-sidebar.tsx](./mobile-sidebar.tsx))
 *     share one source of truth for the brand header + nav + user pill.
 *
 * @module components/dashboard/sidebar
 */
"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { motion } from "motion/react";
import {
  LayoutDashboard,
  Building2,
  FileText,
  Briefcase,
  ArrowLeftRight,
  BarChart3,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/db/schema";
import { UserPill } from "./user-pill";

// ── Nav items ───────────────────────────────────────────────────────────────

/**
 * One nav item. `href` doubles as the prefix-match key for active state.
 * `adminOnly` items render only for admin-role users — unlike the rest of
 * the sidebar (which shows everything and lets pages gate themselves), the
 * admin section is hidden from non-admins so they aren't shown a link that
 * would just redirect them away.
 */
type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
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
  {
    href: "/dashboard/admin/users",
    label: "Users",
    icon: Users,
    adminOnly: true,
  },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

// ── Props ───────────────────────────────────────────────────────────────────

export interface SidebarProps {
  /** Logged-in user's email — passed straight through to the user pill. */
  userEmail: string;
  /** Logged-in user's role. Used only by the user pill for display. */
  userRole: UserRole;
}

interface SidebarContentProps extends SidebarProps {
  /**
   * Distinguishes the desktop aside from the mobile sheet. Used purely
   * for the `layoutId` on the active-pill — desktop and mobile each get
   * their own pill identity so framer doesn't try to morph between the
   * two simultaneously-rendered instances of the same active item.
   */
  variant: "desktop" | "mobile";
}

// ── Desktop wrapper ─────────────────────────────────────────────────────────

/**
 * Desktop sidebar. Hidden on `< lg` viewports — the mobile drawer
 * (`<MobileSidebar>`) takes over there.
 */
export function Sidebar({ userEmail, userRole }: SidebarProps) {
  return (
    <aside
      aria-label="Primary navigation"
      className={cn(
        "sticky top-0 hidden h-screen w-64 shrink-0 flex-col lg:flex",
        "bg-sidebar text-sidebar-foreground",
        "border-r border-sidebar-border",
      )}
    >
      <SidebarContent
        userEmail={userEmail}
        userRole={userRole}
        variant="desktop"
      />
    </aside>
  );
}

// ── Shared content ──────────────────────────────────────────────────────────

/**
 * Brand header + nav + user pill — the actual sidebar UI. Rendered
 * inside the desktop `<aside>` AND inside the mobile drawer's
 * `<SheetContent>`. Keeps the two surfaces in lock-step without
 * duplicating markup.
 */
export function SidebarContent({
  userEmail,
  userRole,
  variant,
}: SidebarContentProps) {
  const pathname = usePathname();
  const pillLayoutId =
    variant === "desktop" ? "sidebar-nav-pill" : "mobile-sidebar-nav-pill";

  // Admin-only items (the Users section) are hidden from non-admins so
  // they aren't offered a link that would just redirect them away.
  const navItems = NAV_ITEMS.filter(
    (item) => !item.adminOnly || userRole === "admin",
  );

  return (
    <>
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
          {navItems.map((item) => {
            const isActive = isPathActive(pathname, item.href);
            const Icon = item.icon;

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    // Inactive state — quiet, muted text + hover lift
                    "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    // Active state colour comes from the foreground +
                    // icon classes below; the terracotta background is
                    // a separate motion.span (the layoutId pill) that
                    // physically slides between items rather than
                    // hard-swapping bg classes.
                    isActive &&
                      "text-sidebar-primary-foreground hover:bg-transparent hover:text-sidebar-primary-foreground",
                  )}
                >
                  {/* Active pill — framer-motion shared layout. When the
                      active item changes, motion animates this element
                      from its previous position to the new one (spring
                      physics) instead of an instant bg swap. */}
                  {isActive && (
                    <motion.span
                      layoutId={pillLayoutId}
                      className="absolute inset-0 -z-0 rounded-md bg-sidebar-primary"
                      transition={{
                        type: "spring",
                        stiffness: 380,
                        damping: 30,
                        mass: 0.8,
                      }}
                      aria-hidden
                    />
                  )}

                  <Icon
                    className={cn(
                      "relative z-10 h-4 w-4 shrink-0",
                      isActive
                        ? "text-sidebar-primary-foreground"
                        : "text-sidebar-foreground/60 group-hover:text-sidebar-foreground",
                    )}
                    aria-hidden
                  />
                  <span className="relative z-10">{item.label}</span>
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
    </>
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
