/**
 * Company overview — the fact-sheet body of the detail page.
 *
 * Renders the row as labelled facts in six sections that mirror the
 * create form structure (Identity / Identifiers / Joint venture /
 * Contact / Address / Internal notes). Each section is a `<dl>` for
 * semantic correctness — these are definition lists, not generic divs.
 *
 * Layout rules:
 *   - Section title (h2) + optional description, then a 2-column grid
 *     of label-value pairs on md+, single column on mobile
 *   - Address section uses a single flow (line 1 / city, state pincode)
 *   - Internal notes is admin/staff-only — section is HIDDEN entirely
 *     when viewerRole === 'company' (we pass viewerRole down from the
 *     page rather than relying on null-check, because internalNotes
 *     could legitimately be null for an admin too)
 *   - JV section shows partner list when isJv; says "Standalone" when not
 *
 * Server-Component-compatible — pure render.
 *
 * @module app/dashboard/companies/[id]/_components/company-overview
 */
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { Company, UserRole } from "@/lib/db/schema";
import { BooleanBadge } from "../../_components/badges";
import { cn } from "@/lib/utils";

// ── Props ───────────────────────────────────────────────────────────────────

export interface CompanyOverviewProps {
  company: Company;
  /** id+name pairs for the JV partners (resolved server-side). */
  partnerLabels: Array<{ id: string; name: string }>;
  /** Used to hide the Internal Notes section from company-role users. */
  viewerRole: UserRole;
}

// ── Component ───────────────────────────────────────────────────────────────

export function CompanyOverview({
  company,
  partnerLabels,
  viewerRole,
}: CompanyOverviewProps) {
  const showInternalNotes =
    viewerRole === "admin" || viewerRole === "staff";

  // Format address as a single block. Each line is optional; we render
  // only the lines that have data so a blank address doesn't show as
  // a column of "—" dashes.
  const addressLines = [
    company.addressLine,
    [company.city, company.state, company.pincode]
      .filter((s) => s && s.trim().length > 0)
      .join(", "),
  ].filter((line) => line && line.trim().length > 0);

  return (
    <div className="divide-y divide-border">
      {/* Identity ─────────────────────────────────────────────────── */}
      <Section
        title="Identity"
        description="Basic information about the company."
      >
        <Fact label="Company name" value={company.name} />
        <Fact label="Sector" value={company.sector} />
        <Fact label="Geography" value={company.geography} />
      </Section>

      {/* Identifiers ──────────────────────────────────────────────── */}
      <Section
        title="Identifiers"
        description="Government registration details."
      >
        <Fact
          label="GSTIN"
          value={company.gstNumber}
          mono
          emptyHint="Not on file"
        />
        <Fact
          label="PAN"
          value={company.panNumber}
          mono
          emptyHint="Not on file"
        />
        <Fact
          label="MSME registered"
          valueNode={<BooleanBadge value={company.isMsme} />}
        />
      </Section>

      {/* Joint venture ────────────────────────────────────────────── */}
      <Section
        title="Joint venture"
        description={
          company.isJv
            ? "This company is a joint venture between the partners below."
            : "Not a joint venture."
        }
      >
        {company.isJv ? (
          <Fact
            label="Partners"
            valueNode={
              partnerLabels.length === 0 ? (
                <span className="text-sm italic text-muted-foreground">
                  No partner records found
                </span>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {partnerLabels.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`/dashboard/companies/${p.id}`}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent",
                          "hover:bg-accent/20",
                        )}
                      >
                        {p.name}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            }
            spanFull
          />
        ) : (
          <Fact label="Type" value="Standalone company" />
        )}
      </Section>

      {/* Contact ──────────────────────────────────────────────────── */}
      <Section
        title="Contact"
        description="Primary point of contact for this company."
      >
        <Fact
          label="Contact person"
          value={company.contactPersonName}
          emptyHint="Not on file"
        />
        <Fact
          label="Email"
          valueNode={
            company.contactEmail ? (
              <a
                href={`mailto:${company.contactEmail}`}
                className="text-sm text-foreground hover:underline"
              >
                {company.contactEmail}
              </a>
            ) : undefined
          }
          emptyHint="Not on file"
        />
        <Fact
          label="Phone"
          valueNode={
            company.contactPhone ? (
              <a
                href={`tel:${company.contactPhone.replace(/\s/g, "")}`}
                className="text-sm text-foreground hover:underline"
              >
                {company.contactPhone}
              </a>
            ) : undefined
          }
          emptyHint="Not on file"
          spanFull
        />
      </Section>

      {/* Address ──────────────────────────────────────────────────── */}
      <Section
        title="Address"
        description="Registered office or primary location."
      >
        <Fact
          label="Address"
          spanFull
          valueNode={
            addressLines.length === 0 ? undefined : (
              <div className="text-sm text-foreground">
                {addressLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )
          }
          emptyHint="No address on file"
        />
      </Section>

      {/* Internal notes — admin/staff only */}
      {showInternalNotes && (
        <Section
          title="Internal notes"
          description="Only visible to Consultway staff."
        >
          <Fact
            label="Notes"
            spanFull
            valueNode={
              company.internalNotes ? (
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {company.internalNotes}
                </p>
              ) : undefined
            }
            emptyHint="No notes recorded"
          />
        </Section>
      )}
    </div>
  );
}

// ── Section primitive ───────────────────────────────────────────────────────

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

// ── Fact primitive — one label/value pair ───────────────────────────────────

interface FactProps {
  /** Left-column label (e.g. "Company name"). */
  label: string;

  /**
   * Plain-string value. Pass either `value` OR `valueNode`, not both.
   * Strings get standard styling; nodes are rendered as-is.
   */
  value?: string | null;

  /** Custom JSX value for cases where plain text isn't enough. */
  valueNode?: React.ReactNode;

  /** When the value is empty, show this muted hint instead of nothing. */
  emptyHint?: string;

  /** Use monospace for the value (GST, PAN, codes). */
  mono?: boolean;

  /** Span both columns of the parent grid (for long content). */
  spanFull?: boolean;
}

function Fact({
  label,
  value,
  valueNode,
  emptyHint,
  mono,
  spanFull,
}: FactProps) {
  const hasValue =
    valueNode !== undefined || (typeof value === "string" && value.length > 0);

  return (
    <div
      className={cn(
        "flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4",
        spanFull && "md:col-span-2",
      )}
    >
      <dt className="shrink-0 text-sm text-muted-foreground sm:w-40">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 flex-1 text-sm text-foreground",
          mono && hasValue && "font-mono text-xs",
        )}
      >
        {hasValue ? (
          valueNode ?? value
        ) : (
          <span className="italic text-muted-foreground">
            {emptyHint ?? "—"}
          </span>
        )}
      </dd>
    </div>
  );
}
