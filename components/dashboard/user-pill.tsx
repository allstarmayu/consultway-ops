/**
 * User pill — bottom-of-sidebar identity widget.
 *
 * Shows the user's display label (email by default) and role, plus a
 * sign-out button. Sign-out posts to the `logout` Server Action which
 * clears the session cookie and redirects to /login.
 *
 * Client Component so the form's submit handler can be wired up without
 * a page-level form action. The logout action is imported from the
 * "use server" file and called via a form action prop — this is the
 * cleanest pattern for triggering Server Actions from buttons that
 * don't need progressive-enhancement fallbacks.
 *
 * @module components/dashboard/user-pill
 */
"use client";

import { LogOut, UserCircle2 } from "lucide-react";
import { logout } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/db/schema";

export interface UserPillProps {
  /** Email shown as the primary identity label. */
  email: string;
  /** Role badge text below the email. */
  role: UserRole;
}

export function UserPill({ email, role }: UserPillProps) {
  return (
    <div className="flex items-center gap-3">
      {/* Avatar circle. No image upload yet; renders a generic icon. */}
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          "bg-sidebar-accent text-sidebar-accent-foreground",
        )}
        aria-hidden
      >
        <UserCircle2 className="h-5 w-5" />
      </div>

      {/* Identity labels. `min-w-0` allows the truncate to actually
          take effect — without it, the flex item refuses to shrink. */}
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium text-sidebar-foreground"
          title={email}
        >
          {email}
        </p>
        <p className="mt-0.5 text-xs capitalize text-sidebar-foreground/60">
          {role}
        </p>
      </div>

      {/* Sign-out trigger. Form-action pattern: clicking the button
          submits a tiny form that invokes the `logout` Server Action.
          No JS required for the action itself; the form is the
          progressive-enhancement contract. */}
      <form action={logout}>
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          aria-label="Sign out"
          className={cn(
            "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground",
          )}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
