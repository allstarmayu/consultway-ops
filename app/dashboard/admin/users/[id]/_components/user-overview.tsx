/**
 * User overview — the fact-sheet body of the detail page.
 *
 * Renders the user as labelled facts in four sections (Identity /
 * Organisation / Account / Profile). Mirrors the company-overview pattern,
 * including the local Section / Fact primitives.
 *
 * Server-Component-compatible — pure render.
 *
 * @module app/dashboard/admin/users/[id]/_components/user-overview
 */
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/utils/format-relative-time";
import type { UserWithCompany } from "@/lib/users/actions";
import { RoleBadge, AccountStatusBadge } from "../../_components/badges";

export interface UserOverviewProps {
  user: UserWithCompany;
}

export function UserOverview({ user }: UserOverviewProps) {
  const lastLogin = formatRelativeTime(user.lastLoginAt);
  const memberSince = formatRelativeTime(user.createdAt);

  return (
    <div className="divide-y divide-border">
      {/* Identity */}
      <Section title="Identity" description="Basic information about the user.">
        <Fact label="Full name" value={user.name} />
        <Fact
          label="Email"
          valueNode={
            <a
              href={`mailto:${user.email}`}
              className="text-sm text-foreground hover:underline"
            >
              {user.email}
            </a>
          }
        />
        <Fact label="Role" valueNode={<RoleBadge role={user.role} />} />
      </Section>

      {/* Organisation */}
      <Section
        title="Organisation"
        description="Company affiliation. Admin and staff belong to no client company."
      >
        <Fact
          label="Company"
          spanFull
          valueNode={
            user.companyId && user.companyName ? (
              <Link
                href={`/dashboard/companies/${user.companyId}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent",
                  "hover:bg-accent/20",
                )}
              >
                {user.companyName}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </Link>
            ) : undefined
          }
          emptyHint="Internal user (no company)"
        />
      </Section>

      {/* Account */}
      <Section title="Account" description="Sign-in and lifecycle state.">
        <Fact
          label="Status"
          valueNode={<AccountStatusBadge isActive={user.isActive} />}
        />
        <Fact
          label="Email verified"
          value={
            user.emailVerifiedAt ? formatRelativeTime(user.emailVerifiedAt) : null
          }
          emptyHint="Invite pending"
        />
        <Fact label="Last login" value={lastLogin || null} emptyHint="Never" />
        <Fact label="Member since" value={memberSince || null} emptyHint="—" />
      </Section>

      {/* Profile */}
      <Section
        title="Profile"
        description="Optional contact details shown on the user's profile."
      >
        <Fact
          label="Phone"
          valueNode={
            user.phone ? (
              <a
                href={`tel:${user.phone.replace(/\s/g, "")}`}
                className="text-sm text-foreground hover:underline"
              >
                {user.phone}
              </a>
            ) : undefined
          }
          emptyHint="Not on file"
        />
        <Fact label="Job title" value={user.jobTitle} emptyHint="Not on file" />
      </Section>
    </div>
  );
}

// ── Section primitive ─────────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

function Section({ title, description, children }: SectionProps) {
  return (
    <section className="px-6 py-5 sm:px-8 sm:py-6">
      <header className="mb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </header>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
        {children}
      </dl>
    </section>
  );
}

// ── Fact primitive — one label/value pair ─────────────────────────────────────

interface FactProps {
  label: string;
  value?: string | null;
  valueNode?: React.ReactNode;
  emptyHint?: string;
  spanFull?: boolean;
}

function Fact({ label, value, valueNode, emptyHint, spanFull }: FactProps) {
  const hasValue =
    valueNode !== undefined || (typeof value === "string" && value.length > 0);

  return (
    <div
      className={cn(
        "flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4",
        spanFull && "md:col-span-2",
      )}
    >
      <dt className="shrink-0 text-sm text-muted-foreground sm:w-40">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-foreground">
        {hasValue ? (
          (valueNode ?? value)
        ) : (
          <span className="italic text-muted-foreground">{emptyHint ?? "—"}</span>
        )}
      </dd>
    </div>
  );
}
