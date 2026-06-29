/**
 * Project overview — the cards that make up the body of the detail
 * page.
 *
 *   1. Identity         — description, owning company, originating tender link
 *   2. Schedule         — start date, end date
 *   3. Budget           — budgetInr formatted in Indian-locale rupees
 *   4. Internal notes   — admin/staff-only; component receives the
 *                         `showInternalNotes` flag and renders nothing
 *                         when false
 *
 * Pure presentation (Server Component).
 *
 * @module app/dashboard/projects/[id]/_components/project-overview
 */
import Link from "next/link";
import { Briefcase, Building2, Calendar, FileText, Info } from "lucide-react";
import type { Project } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";

// ── Props ─────────────────────────────────────────────────────────────────

export interface ProjectOverviewProps {
  project: Project;
  /**
   * Joined owning-company name. Parent page does a single small query
   * and passes the result down to keep this component pure-presentation.
   */
  company: {
    id: string;
    name: string;
  };
  /**
   * Optional linked-tender summary. NULL when `project.tenderId` is
   * null. Parent fetches the tender's title in a single small query.
   */
  linkedTender: {
    id: string;
    title: string;
  } | null;
  /**
   * True when the viewer is admin/staff. Drives whether the Internal
   * Notes card is rendered.
   */
  showInternalNotes: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────

export function ProjectOverview({
  project,
  company,
  linkedTender,
  showInternalNotes,
}: ProjectOverviewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* ── Identity card ─────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <SectionHeading icon={Briefcase} title="Identity" />

        <Field label="Description">
          {project.description ? (
            <p className="select-text whitespace-pre-wrap text-foreground">
              {project.description}
            </p>
          ) : (
            <Empty>No description provided</Empty>
          )}
        </Field>

        <Field label="Company">
          <Link
            href={`/dashboard/companies/${company.id}`}
            className="inline-flex items-center gap-1.5 text-sm text-foreground hover:underline"
          >
            <Building2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <span className="select-text">{company.name}</span>
          </Link>
        </Field>

        {linkedTender && (
          <Field label="Originated from tender">
            <Link
              href={`/dashboard/tenders/${linkedTender.id}`}
              className="inline-flex items-center gap-1.5 text-sm text-foreground hover:underline"
            >
              <FileText
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden
              />
              <span className="select-text">{linkedTender.title}</span>
            </Link>
          </Field>
        )}
      </Card>

      {/* ── Schedule card ─────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <SectionHeading icon={Calendar} title="Schedule" />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Start date">
            {project.startDate ? (
              <p className="select-text text-foreground">{project.startDate}</p>
            ) : (
              <Empty>Not set</Empty>
            )}
          </Field>
          <Field label="End date">
            {project.endDate ? (
              <p className="select-text text-foreground">{project.endDate}</p>
            ) : (
              <Empty>Not set</Empty>
            )}
          </Field>
        </div>
      </Card>

      {/* ── Budget card ───────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <SectionHeading icon={FileText} title="Budget" />

        <Field label="Total budget">
          {project.budgetInr !== null ? (
            <p className="select-text text-foreground">
              ₹{" "}
              {new Intl.NumberFormat("en-IN", {
                maximumFractionDigits: 0,
              }).format(project.budgetInr)}
            </p>
          ) : (
            <Empty>Not set</Empty>
          )}
        </Field>
      </Card>

      {/* ── Internal notes card (admin/staff only) ────────────────── */}
      {showInternalNotes && (
        <Card className="space-y-4 p-6">
          <SectionHeading icon={Info} title="Internal notes" />

          {project.internalNotes ? (
            <p className="select-text whitespace-pre-wrap text-sm text-foreground">
              {project.internalNotes}
            </p>
          ) : (
            <Empty>No internal notes recorded</Empty>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function SectionHeading({
  icon: Icon,
  title,
}: {
  icon: typeof Briefcase;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border pb-3">
      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="italic text-muted-foreground">{children}</p>
  );
}
