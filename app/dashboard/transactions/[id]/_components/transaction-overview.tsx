/**
 * Transaction overview — three cards on the detail page.
 *
 *   1. Identity     — type badge, formatted amount, currency, business date
 *   2. Counterparty — linked company + optional linked project
 *   3. Reference & notes — reference number (mono), notes, internal notes
 *
 * Pure presentation (Server Component).
 *
 * @module app/dashboard/transactions/[id]/_components/transaction-overview
 */
import Link from "next/link";
import {
  Building2,
  Calendar,
  FileText,
  Info,
  Receipt,
  type LucideIcon,
} from "lucide-react";
import type { Transaction } from "@/lib/db/schema";
import { Card } from "@/components/ui/card";
import { formatRupeesFromPaise } from "@/lib/format/inr";
import { TransactionTypeBadge } from "../../_components/badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface TransactionOverviewProps {
  transaction: Transaction;
  /** Joined counterparty company name + id. Always present (FK NOT NULL). */
  company: { id: string; name: string };
  /** Joined linked-project, NULL when transaction.projectId is null. */
  linkedProject: { id: string; name: string } | null;
}

// ── Component ─────────────────────────────────────────────────────────────

export function TransactionOverview({
  transaction,
  company,
  linkedProject,
}: TransactionOverviewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* ── Identity card ─────────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <SectionHeading icon={Receipt} title="Identity" />

        <Field label="Type">
          <TransactionTypeBadge type={transaction.type} />
        </Field>

        <Field label="Amount">
          <p className="select-text font-mono text-2xl tabular-nums text-foreground">
            {formatRupeesFromPaise(transaction.amountPaise)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {transaction.currency}
          </p>
        </Field>

        <Field label="Business date">
          <p className="select-text inline-flex items-center gap-1.5 text-sm text-foreground">
            <Calendar
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden
            />
            {transaction.occurredOn}
          </p>
        </Field>
      </Card>

      {/* ── Counterparty card ─────────────────────────────────────── */}
      <Card className="space-y-4 p-6">
        <SectionHeading icon={Building2} title="Counterparty" />

        <Field label="Company">
          <Link
            href={`/dashboard/companies/${company.id}`}
            className="inline-flex items-center gap-1.5 text-sm text-foreground hover:underline"
          >
            <Building2
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-hidden
            />
            <span className="select-text">{company.name}</span>
          </Link>
        </Field>

        <Field label="Project">
          {linkedProject ? (
            <Link
              href={`/dashboard/projects/${linkedProject.id}`}
              className="inline-flex items-center gap-1.5 text-sm text-foreground hover:underline"
            >
              <FileText
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden
              />
              <span className="select-text">{linkedProject.name}</span>
            </Link>
          ) : (
            <Empty>
              Company-level entry (not tied to a specific project)
            </Empty>
          )}
        </Field>
      </Card>

      {/* ── Reference & notes card ────────────────────────────────── */}
      <Card className="space-y-4 p-6 lg:col-span-2">
        <SectionHeading icon={Info} title="Reference & notes" />

        <Field label="Reference number">
          {transaction.referenceNumber ? (
            <p className="select-text font-mono text-sm text-foreground">
              {transaction.referenceNumber}
            </p>
          ) : (
            <Empty>None recorded</Empty>
          )}
        </Field>

        <Field label="Notes">
          {transaction.notes ? (
            <p className="select-text whitespace-pre-wrap text-sm text-foreground">
              {transaction.notes}
            </p>
          ) : (
            <Empty>No notes provided</Empty>
          )}
        </Field>

        <Field label="Internal notes">
          {transaction.internalNotes ? (
            <p className="select-text whitespace-pre-wrap text-sm text-foreground">
              {transaction.internalNotes}
            </p>
          ) : (
            <Empty>No internal notes</Empty>
          )}
        </Field>
      </Card>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function SectionHeading({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
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
  return <p className="italic text-muted-foreground">{children}</p>;
}
