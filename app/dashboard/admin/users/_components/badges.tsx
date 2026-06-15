/**
 * Tiny presentational badges for the users module.
 *
 *   - <RoleBadge role="admin" />        — colored pill for the Role column
 *   - <AccountStatusBadge isActive />   — Active / Disabled pill
 *   - <InvitePendingBadge />            — shown when a user hasn't accepted
 *                                         their invite yet (emailVerifiedAt null)
 *
 * Pure presentation — no hooks, Server-Component-compatible. Same shape +
 * palette conventions as the companies module's badges.
 *
 * @module app/dashboard/admin/users/_components/badges
 */
import {
  ShieldCheck,
  Briefcase,
  Building2,
  CheckCircle2,
  Ban,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UserRole } from "@/lib/db/schema";

// ── RoleBadge ────────────────────────────────────────────────────────────────

interface RoleStyle {
  label: string;
  classes: string;
  icon: LucideIcon;
}

const ROLE_STYLES: Record<UserRole, RoleStyle> = {
  admin: {
    label: "Admin",
    classes: "bg-primary text-primary-foreground border-transparent",
    icon: ShieldCheck,
  },
  staff: {
    label: "Staff",
    classes: "bg-accent/10 text-accent border-accent/20",
    icon: Briefcase,
  },
  company: {
    label: "Company",
    classes: "bg-muted text-muted-foreground border-border",
    icon: Building2,
  },
};

export interface RoleBadgeProps {
  role: UserRole;
}

export function RoleBadge({ role }: RoleBadgeProps) {
  const style = ROLE_STYLES[role];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        style.classes,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {style.label}
    </span>
  );
}

// ── AccountStatusBadge ───────────────────────────────────────────────────────

export interface AccountStatusBadgeProps {
  isActive: boolean;
}

export function AccountStatusBadge({ isActive }: AccountStatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        isActive
          ? "bg-primary/10 text-primary border-primary/20"
          : "bg-destructive/10 text-destructive border-destructive/20",
      )}
    >
      {isActive ? (
        <CheckCircle2 className="h-3 w-3" aria-hidden />
      ) : (
        <Ban className="h-3 w-3" aria-hidden />
      )}
      {isActive ? "Active" : "Disabled"}
    </span>
  );
}

// ── InvitePendingBadge ───────────────────────────────────────────────────────

/**
 * Shown next to the status when a user was invited but hasn't accepted yet
 * (`emailVerifiedAt` is NULL). Amber to read as "awaiting action".
 */
export function InvitePendingBadge() {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        "bg-amber-100 text-amber-900 border-amber-200",
      )}
      title="Invite sent — awaiting password setup"
    >
      <Clock className="h-3 w-3" aria-hidden />
      Invite pending
    </span>
  );
}
