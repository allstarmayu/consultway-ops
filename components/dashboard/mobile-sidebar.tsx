/**
 * Mobile dashboard navigation.
 *
 * Renders a slim top bar (visible on `< lg` viewports only) with a
 * hamburger trigger. Tapping the hamburger opens a left-side `<Sheet>`
 * containing the same `<SidebarContent>` the desktop aside uses, so the
 * mobile and desktop navs are guaranteed to drift in lockstep — the
 * source of truth (nav items, brand header, user pill) is shared.
 *
 * Auto-close: a `useEffect` on `pathname` closes the sheet whenever the
 * user navigates. This is more reliable than wiring an onClick on every
 * `<Link>` — it covers programmatic navigations too (e.g. a form submit
 * that redirects), and survives any future restructuring of the nav.
 *
 * Why a sibling Sheet instead of refactoring the desktop sidebar into a
 * sheet-everywhere: the desktop sidebar has different semantics — it's
 * always-visible, sticky, contributes to the layout's flex sizing.
 * Forcing it through a Dialog primitive on desktop would add
 * focus-trap + portal indirection for no UX gain.
 *
 * @module components/dashboard/mobile-sidebar
 */
"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Building2, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/db/schema";
import { SidebarContent } from "./sidebar";

export interface MobileSidebarProps {
  /** Logged-in user's email — forwarded to the shared content. */
  userEmail: string;
  /** Logged-in user's role — forwarded to the shared content. */
  userRole: UserRole;
  /** Unread in-app notifications — forwarded to the shared content's badge. */
  unreadCount: number;
}

export function MobileSidebar({
  userEmail,
  userRole,
  unreadCount,
}: MobileSidebarProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Auto-close on navigation. Track the pathname the sheet was last
  // rendered against and reset `open` during render when it changes —
  // React's "adjusting state on a prop/route change" pattern. Covers
  // programmatic navigations too (e.g. a redirecting form submit), and
  // avoids a setState-in-effect cascade (react-hooks/set-state-in-effect).
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  return (
    <>
      {/* Slim top bar — only visible on small viewports. Matches the
          desktop sidebar's brand chrome so the user sees consistent
          branding when collapsing/expanding the viewport. */}
      <div
        className={cn(
          "sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background px-4 lg:hidden",
        )}
      >
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open navigation menu"
            >
              <Menu className="h-5 w-5" aria-hidden />
            </Button>
          </SheetTrigger>

          <SheetContent
            side="left"
            className="flex w-[min(18rem,82vw)] flex-col bg-sidebar p-0 text-sidebar-foreground"
          >
            {/* Visually-hidden title for screen readers — the brand
                header inside `<SidebarContent>` is decorative + not
                announced as a section title. Radix requires a
                SheetTitle for accessibility; we keep it off-screen. */}
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation menu</SheetTitle>
            </SheetHeader>

            <SidebarContent
              userEmail={userEmail}
              userRole={userRole}
              unreadCount={unreadCount}
              variant="mobile"
            />
          </SheetContent>
        </Sheet>

        {/* Compact brand mark on the right so the empty space doesn't
            feel asymmetric with the hamburger on the left. */}
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
            <Building2
              className="h-4 w-4 text-primary-foreground"
              aria-hidden
            />
          </div>
          <span className="text-sm font-semibold tracking-tight">
            Consultway Ops
          </span>
        </div>
      </div>
    </>
  );
}
