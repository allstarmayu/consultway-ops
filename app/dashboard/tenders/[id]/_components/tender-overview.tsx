/**
 * Tender overview — the four cards that make up the body of the detail
 * page.
 *
 *   1. Identity        — title (no, that's in the header), description,
 *                        reference number, publisher company
 *   2. Categorisation  — sector + geography (the tender's own metadata,
 *                        not eligibility), plus eligibility chips
 *   3. Dates           — opening / closing / published timestamps with
 *                        relative phrasing
 *   4. Internal notes  — admin/staff-only; component receives `null`
 *                        for company-role viewers and renders nothing
 *
 * Pure presentation (Server Component). All formatting helpers are pure
 * and live at the bottom of the file. The parent page passes a shape
 * that includes the joined publisher company name (so we don't have to
 * fetch it again here).
 *
 * Text-selection policy: the dashboard root disables user-select by
 * default (see app/globals.css). We RE-ENABLE selection on long-form
 * and copy-worthy fields by adding the Tailwind `select-text` utility:
 *   - description prose (copy-paste into proposals)
 *   - reference number (paste into emails)
 *   - internal notes (copy into handoff messages)
 *   - eligibility values like sector / geography (copy into filters)
 *   - publisher company name
 *   - rendered timestamps
 * Headers / labels stay unselectable.
 *
 * @module app/dashboard/tenders/[id]/_components/tender-overview
 */
import Link from "next/link";
import { Building2, Calendar, FileText, Info, Tag } from "lucide-react";
import type { Tender } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { EligibilityChip } from "../../_components/badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface TenderOverviewProps {
  tender: Tender;
  /**
   * The joined publisher company. The parent page does a single extra
   * query to fetch this once and passes it down — saves the overview
   * component from re-doing the lookup. Always present (FK is NOT NULL).
   */
  publisher: {
    id: string;
    name: string;
  };
  /**
   * True when the viewer is admin/staff. Drives whether the Internal
   * Notes card is rendered. Company-role users never see the section
   * (the action strips internalNotes on their reads anyway, but we
   * hide the empty card too).
   */
  showInternalNotes: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export function TenderOverview({
  tender,
  publisher,
  showInternalNotes,
}: TenderOverviewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* ── Identity card ─────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <SectionHeading icon={FileText} title="Identity" />

        <Field label="Description">
          {tender.description ? (
            <p className="select-text whitespace-pre-wrap text-foreground">
              {tender.description}
            </p>
          ) : (
            <Empty>No description provided</Empty>
          )}
        </Field>

        <Field label="Reference number">
          {tender.referenceNumber ? (
            <p className="select-text font-mono text-sm text-foreground">
              {tender.referenceNumber}
            </p>
          ) : (
            <Empty>Not assigned</Empty>
          )}
        </Field>

        <Field label="Published by">
          <Link
            href={`/dashboard/companies/${publisher.id}`}
            className="inline-flex select-text items-center gap-1.5 text-foreground hover:underline"
          >
            <Building2
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden
            />
            {publisher.name}
          </Link>
        </Field>
      </Card>

      {/* ── Categorisation + Eligibility card ─────────────────────── */}
      <Card className="space-y-4 p-6">
        <SectionHeading icon={Tag} title="Categorisation & eligibility" />

        <div className="grid grid-cols-2 gap-4">
          <Field label="Sector">
            <p className="select-text text-foreground">{tender.sector}</p>
          </Field>
          <Field label="Geography">
            <p className="select-text text-foreground">{tender.geography}</p>
          </Field>
        </div>

        <Field label="Eligibility filters">
          <EligibilityChips tender={tender} />
        </Field>
      </Card>

      {/* ── Dates card ────────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <SectionHeading icon={Calendar} title="Application window" />

        <div className="grid grid-cols-2 gap-4">
          <Field label="Opening date">
            {tender.openingDate ? (
              <p className="select-text text-foreground">{tender.openingDate}</p>
            ) : (
              <Empty>Immediate</Empty>
            )}
          </Field>
          <Field label="Closing date">
            {tender.closingDate ? (
              <div className="space-y-0.5">
                <p className="select-text text-foreground">{tender.closingDate}</p>
                <p className="text-xs text-muted-foreground">
                  {relativeClosing(tender.closingDate, tender.status)}
                </p>
              </div>
            ) : (
              <Empty>No closing date</Empty>
            )}
          </Field>
        </div>

        <Field label="Published at">
          {tender.publishedAt ? (
            <p className="select-text text-foreground">
              {formatTimestamp(tender.publishedAt)}
            </p>
          ) : (
            <Empty>Not yet published</Empty>
          )}
        </Field>
      </Card>

      {/* ── Internal notes card (admin/staff only) ────────────────── */}
      {showInternalNotes && (
        <Card className="space-y-4 p-6">
          <SectionHeading icon={Info} title="Internal notes" />

          {tender.internalNotes ? (
            <p className="select-text whitespace-pre-wrap text-sm text-foreground">
              {tender.internalNotes}
            </p>
          ) : (
            <Empty>No internal notes</Empty>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Small primitives ──────────────────────────────────────────────────────

/**
 * Card section heading. Icon + title, consistently sized across the
 * four overview cards.
 */
function SectionHeading({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
    </div>
  );
}

/**
 * Labelled field: muted label above the value. Used inside cards for
 * each datum.
 */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * Italicised muted placeholder for missing fields.
 */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="italic text-muted-foreground">{children}</p>;
}

/**
 * Render the tender's eligibility filters as a wrapping list of chips.
 * When no filters are set, surfaces "Open to all" as a single chip so
 * the card never looks broken / empty.
 */
function EligibilityChips({ tender }: { tender: Tender }) {
  const chips: Array<{ label: string; emphasis: "muted" | "strong" }> = [];

  if (tender.eligibleSector) {
    chips.push({
      label: `Sector: ${tender.eligibleSector}`,
      emphasis: "muted",
    });
  }
  if (tender.eligibleGeography) {
    chips.push({
      label: `Geography: ${tender.eligibleGeography}`,
      emphasis: "muted",
    });
  }
  if (tender.minAnnualTurnoverInr !== null) {
    chips.push({
      label: `Min turnover: ${formatInr(tender.minAnnualTurnoverInr)}`,
      emphasis: "muted",
    });
  }
  if (tender.msmeOnly) {
    chips.push({ label: "MSME only", emphasis: "strong" });
  }

  if (chips.length === 0) {
    return <Empty>Open to all eligible companies</Empty>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <EligibilityChip key={c.label} label={c.label} emphasis={c.emphasis} />
      ))}
    </div>
  );
}

// ── Formatters ────────────────────────────────────────────────────────────

/**
 * Indian-locale formatter for the min-turnover chip. Same locale group
 * as the create form's live echo.
 */
function formatInr(rupees: number): string {
  return `₹ ${new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(rupees)}`;
}

/**
 * Compact ISO timestamp → "2026-05-16 04:23 UTC". We don't localise to
 * the viewer's timezone because the audit / publish event lives at a
 * universal moment and we'd rather show that consistently than risk
 * confusion across sessions. Day-3 logged a related debt around mixing
 * `datetime('now')` (space-separated) and `toISOString()` (T-separated);
 * this formatter accepts both for now.
 */
function formatTimestamp(iso: string): string {
  // Normalise to ISO with a T separator before slicing.
  const normalised = iso.includes("T") ? iso : iso.replace(" ", "T");
  // Slice off seconds + milliseconds + Z for compactness — show
  // minute-precision UTC which is plenty for a publish-time stamp.
  const trimmed = normalised.slice(0, 16).replace("T", " ");
  return `${trimmed} UTC`;
}

/**
 * Same relative-closing logic as the table column, but expressed as a
 * single phrase for the detail page. Status-aware: a closed tender
 * with a future "closing date" should still read "Closed" not
 * "Closes in N days."
 */
function relativeClosing(
  closingDate: string,
  status: Tender["status"],
): string {
  const today = new Date().toISOString().slice(0, 10);
  const diff = daysBetweenIso(today, closingDate);

  if (status === "awarded") return "Awarded";
  if (status === "closed") {
    if (diff < 0) return `Closed ${Math.abs(diff)} ${dayWord(diff)} ago`;
    if (diff === 0) return "Closed today";
    return "Closed";
  }
  if (diff < 0) return `${Math.abs(diff)} ${dayWord(diff)} overdue`;
  if (diff === 0) return "Closes today";
  if (diff === 1) return "Closes tomorrow";
  return `Closes in ${diff} ${dayWord(diff)}`;
}

function dayWord(n: number): string {
  return Math.abs(n) === 1 ? "day" : "days";
}

function daysBetweenIso(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / (1000 * 60 * 60 * 24));
}
