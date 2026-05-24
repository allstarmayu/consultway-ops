/**
 * Compliance transition panel.
 *
 * Admin/staff-only Card on the company detail page that renders one
 * button per legal next compliance status. Same pattern as the
 * project header's status-action buttons, but lifted out into a
 * dedicated panel because compliance has up to five legal next states
 * for some `from` rows — more than the header could comfortably hold.
 *
 * Per-target UX:
 *
 *   - `compliant`, `non_compliant`, `expired` — single-click buttons.
 *     Routine state moves; no reason captured. Easy to revert by
 *     transitioning back through the table.
 *   - `suspended` — `<ConfirmDialog reasonField="optional">`. A
 *     suspension is meaningful enough to warrant context; the field
 *     is optional because the reason often lives in the parallel
 *     channel (Slack / email) anyway.
 *   - `rejected` — `<ConfirmDialog reasonField="required">` with a
 *     destructive variant. Terminal state, so we require at least
 *     5 trimmed characters of reason (matches the server schema's
 *     min-length gate). The reason populates `companies.rejection_reason`
 *     and renders in the detail-page callout.
 *
 * The panel renders nothing when `legalNextStatuses(company.complianceStatus)`
 * is empty — that's the `rejected` (terminal) row. The detail page
 * additionally role-gates the entire panel to admin/staff.
 *
 * On success, the panel calls `router.refresh()` so the new status
 * (and the rejection callout, when relevant) appears immediately on
 * the page below. Server errors render as an inline `<Alert>`.
 *
 * @module app/dashboard/companies/[id]/_components/compliance-transition-panel
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  PauseCircle,
} from "lucide-react";
import { transitionComplianceStatus } from "@/lib/companies/actions";
import type { ComplianceStatus, Company } from "@/lib/db/schema";
import { legalNextStatuses } from "@/lib/companies/state-machine";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  ConfirmDialog,
  type ReasonFieldMode,
} from "@/components/ui/confirm-dialog";
import { ComplianceBadge } from "../../_components/badges";

// ── Props ─────────────────────────────────────────────────────────────────

export interface ComplianceTransitionPanelProps {
  company: Company;
}

// ── Per-target rendering metadata ─────────────────────────────────────────

interface TargetSpec {
  /** Lucide icon — visually echoes the badge for the same state. */
  Icon: typeof CheckCircle2;
  /** Button + dialog confirm label. */
  label: string;
  /** Past-tense form for the dialog title. */
  dialogTitleVerb: string;
  /** Dialog description sentence. */
  description: string;
  /** Visual weight of the confirm button. */
  variant: "default" | "outline" | "destructive";
  /** ConfirmDialog reasonField setting. Undefined = no textarea. */
  reasonField?: ReasonFieldMode;
  /** Placeholder for the reason textarea when shown. */
  reasonPlaceholder?: string;
  /**
   * Outline button styling override — used by rejected / suspended to
   * paint the trigger button in a status-appropriate accent without
   * jumping to a fully filled variant.
   */
  triggerClassName?: string;
}

const TARGET_SPECS: Record<
  Exclude<ComplianceStatus, "pending">,
  TargetSpec
> & { pending: TargetSpec } = {
  pending: {
    // Pending isn't a legal target from any other state (intake-only),
    // so this entry should never render. Kept for type completeness.
    Icon: Clock,
    label: "Move to pending",
    dialogTitleVerb: "move",
    description: "Return this company to intake review.",
    variant: "outline",
  },
  compliant: {
    Icon: CheckCircle2,
    label: "Mark compliant",
    dialogTitleVerb: "mark compliant",
    description:
      "Mark this company as compliant — they can be considered for tenders.",
    variant: "default",
  },
  non_compliant: {
    Icon: AlertTriangle,
    label: "Mark non-compliant",
    dialogTitleVerb: "mark non-compliant",
    description:
      "Flag an issue with this company's compliance — they remain on the platform but are surfaced as needing follow-up.",
    variant: "outline",
  },
  expired: {
    Icon: Clock,
    label: "Mark expired",
    dialogTitleVerb: "mark expired",
    description:
      "One or more compliance documents have lapsed. The company can return to compliant once they re-upload.",
    variant: "outline",
  },
  suspended: {
    Icon: PauseCircle,
    label: "Suspend",
    dialogTitleVerb: "suspend",
    description:
      "Freeze the relationship without terminating it. Reversible — move back to compliant when the suspension ends.",
    variant: "outline",
    reasonField: "optional",
    reasonPlaceholder:
      "e.g. Commercial dispute under arbitration; awaiting legal review.",
    triggerClassName:
      "border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10",
  },
  rejected: {
    Icon: Ban,
    label: "Reject",
    dialogTitleVerb: "reject",
    description:
      "Rejection is terminal — the company cannot be moved out of this state, and a re-engagement would require a brand-new company record.",
    variant: "destructive",
    reasonField: "required",
    reasonPlaceholder:
      "e.g. Failed background check on key directors; regulatory blocker on operating licence.",
    triggerClassName:
      "border-destructive/40 text-destructive hover:bg-destructive/10",
  },
};

// ── Component ─────────────────────────────────────────────────────────────

export function ComplianceTransitionPanel({
  company,
}: ComplianceTransitionPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const nextStatuses = legalNextStatuses(company.complianceStatus);

  // Terminal state — no panel to render.
  if (nextStatuses.length === 0) return null;

  function runTransition(toStatus: ComplianceStatus, reason?: string) {
    setError(null);
    startTransition(async () => {
      const result = await transitionComplianceStatus({
        id: company.id,
        toStatus,
        ...(reason ? { reason } : {}),
      });
      if (!result.ok) {
        setError(result.error ?? "Could not change compliance status");
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="mb-6 p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-foreground">
            Change compliance status
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Current status:
            <span className="ml-2 inline-block align-middle">
              <ComplianceBadge status={company.complianceStatus} />
            </span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {nextStatuses.map((target) => {
          const spec = TARGET_SPECS[target];
          const { Icon } = spec;
          const trigger = (
            <Button
              variant={spec.variant === "default" ? "default" : "outline"}
              disabled={isPending}
              className={spec.triggerClassName}
              aria-label={`${spec.label} — ${company.name}`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {spec.label}
            </Button>
          );

          return (
            <ConfirmDialog
              key={target}
              trigger={trigger}
              title={`${capitalize(spec.dialogTitleVerb)} "${company.name}"?`}
              description={spec.description}
              confirmLabel={spec.label}
              confirmVariant={spec.variant}
              reasonField={spec.reasonField}
              reasonLabel={
                spec.reasonField === "required" ? "Rejection reason" : "Reason"
              }
              reasonPlaceholder={spec.reasonPlaceholder}
              onConfirm={(reason) => runTransition(target, reason)}
              pending={isPending}
            />
          );
        })}
      </div>

      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>Could not change status</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Card>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
