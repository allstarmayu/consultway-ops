/**
 * Apply button — the company-role user's entry point into applying for
 * a tender.
 *
 * Renders three different states depending on eligibility:
 *
 *   1. Already applied                → muted state with "Applied"
 *                                       chip + status; clicking opens
 *                                       a small panel showing the
 *                                       current application status
 *                                       and a "Withdraw" button when
 *                                       still `submitted`.
 *   2. Eligible, not yet applied      → "Apply" button. Clicking
 *                                       expands an inline panel with
 *                                       optional cover note + Confirm.
 *   3. Ineligible                      → Disabled button with a
 *                                       human-readable reason in a
 *                                       tooltip / helper text below.
 *
 * The eligibility check here is a friendly *advisory* gate — it tells
 * the user up front if they can't apply, so they don't waste effort
 * filling in a cover note. The Server Action re-checks everything on
 * submit, so this UI gate is purely UX (defence in depth).
 *
 * Inline-collapsible approach for Apply instead of a Dialog — we render
 * the cover note inline because it's a multi-field affirmative action.
 * Withdraw goes through a `<ConfirmDialog>` instead because it's a
 * single-decision destructive action — same component that gates
 * Mark Awarded on the staff side.
 *
 * @module app/dashboard/tenders/[id]/_components/apply-button
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Send, X } from "lucide-react";
import {
  applyToTender,
  withdrawApplication,
} from "@/lib/tenders/actions";
import type { Tender, TenderApplication } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ApplicationStatusBadge } from "../../_components/badges";

// ── Eligibility check ─────────────────────────────────────────────────────

/**
 * Result of the client-side eligibility advisory. `ok: true` means the
 * Apply button is enabled; `ok: false` means we display the reason and
 * disable the button. Mirrors the Server-side check in
 * `applyToTender` so the messages stay aligned.
 */
type EligibilityCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Run the eligibility advisory. Same logic as the action's gate (sector
 * / geography / MSME / closing date), minus the turnover gate which is
 * deferred company-side too.
 */
function checkEligibility(
  tender: Tender,
  company: { sector: string; geography: string; isMsme: boolean },
): EligibilityCheck {
  if (tender.status !== "published") {
    return {
      ok: false,
      reason: `This tender is ${tender.status} — applications aren't accepted`,
    };
  }
  if (tender.closingDate) {
    const today = new Date().toISOString().slice(0, 10);
    if (today > tender.closingDate) {
      return { ok: false, reason: "Applications for this tender have closed" };
    }
  }
  if (tender.eligibleSector && company.sector !== tender.eligibleSector) {
    return {
      ok: false,
      reason: `Requires sector "${tender.eligibleSector}" — your company is "${company.sector}"`,
    };
  }
  if (
    tender.eligibleGeography &&
    company.geography !== tender.eligibleGeography
  ) {
    return {
      ok: false,
      reason: `Requires geography "${tender.eligibleGeography}" — your company is "${company.geography}"`,
    };
  }
  if (tender.msmeOnly && !company.isMsme) {
    return { ok: false, reason: "Restricted to MSME-registered companies" };
  }
  return { ok: true };
}

// ── Props ─────────────────────────────────────────────────────────────────

export interface ApplyButtonProps {
  tender: Tender;
  /**
   * The viewing company's metadata, needed for the advisory eligibility
   * check. Passed from the page Server Component, not fetched here.
   */
  company: {
    id: string;
    sector: string;
    geography: string;
    isMsme: boolean;
  };
  /**
   * The viewing company's existing application on this tender, if any.
   * NULL when not yet applied. The parent page fetches this once.
   */
  existingApplication: TenderApplication | null;
}

// ── Component ─────────────────────────────────────────────────────────────

export function ApplyButton({
  tender,
  company,
  existingApplication,
}: ApplyButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Apply-form panel state. Closed by default; opens on "Apply" click.
  const [panelOpen, setPanelOpen] = useState(false);
  const [coverNote, setCoverNote] = useState("");

  const eligibility = existingApplication
    ? null // Not relevant when already applied
    : checkEligibility(tender, company);

  // ── Submit handlers ─────────────────────────────────────────────────

  function handleSubmitApplication() {
    setError(null);
    startTransition(async () => {
      const result = await applyToTender({
        tenderId: tender.id,
        coverNote: coverNote.trim() || null,
      });
      if (!result.ok) {
        setError(result.error ?? "Could not submit application");
        return;
      }
      // Success — close the panel, clear local state, refresh the
      // Server Component so the page re-renders with the new
      // application appearing in the applications table below.
      setPanelOpen(false);
      setCoverNote("");
      router.refresh();
    });
  }

  function handleWithdraw() {
    if (!existingApplication) return;
    // No window.confirm — the ConfirmDialog wrapping the Withdraw
    // button below handles the prompt. By the time we reach this
    // handler the user has already confirmed.
    setError(null);
    startTransition(async () => {
      const result = await withdrawApplication({
        applicationId: existingApplication.id,
      });
      if (!result.ok) {
        setError(result.error ?? "Could not withdraw application");
        return;
      }
      router.refresh();
    });
  }

  // ── Render: already applied ─────────────────────────────────────────
  if (existingApplication) {
    return (
      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Your application:
          </span>
          <ApplicationStatusBadge status={existingApplication.status} />
        </div>

        {existingApplication.status === "submitted" && (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm" disabled={isPending}>
                Withdraw application
              </Button>
            }
            title="Withdraw your application?"
            description="Once withdrawn, you cannot re-apply to this tender. Staff will see your application marked as withdrawn in their reviewing pipeline."
            confirmLabel="Withdraw"
            confirmVariant="destructive"
            onConfirm={handleWithdraw}
            pending={isPending}
          />
        )}

        {error && (
          <Alert variant="destructive" className="w-full max-w-md">
            <AlertCircle className="h-4 w-4" aria-hidden />
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  // ── Render: ineligible ───────────────────────────────────────────────
  if (eligibility && !eligibility.ok) {
    return (
      <div className="flex max-w-md flex-col items-end gap-1.5">
        <Button disabled aria-disabled>
          <Send className="h-4 w-4" aria-hidden />
          Apply
        </Button>
        <p className="text-right text-xs text-muted-foreground">
          {eligibility.reason}
        </p>
      </div>
    );
  }

  // ── Render: eligible, not yet applied ────────────────────────────────
  return (
    <div className="flex w-full max-w-md flex-col items-end gap-3">
      {!panelOpen ? (
        <Button onClick={() => setPanelOpen(true)} disabled={isPending}>
          <Send className="h-4 w-4" aria-hidden />
          Apply
        </Button>
      ) : (
        <div className="w-full space-y-3 rounded-md border border-border bg-card p-4 text-left">
          <div>
            <label
              htmlFor="apply-cover-note"
              className="text-sm font-medium text-foreground"
            >
              Cover note <span className="text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="apply-cover-note"
              rows={4}
              placeholder="Anything specific you'd like the publisher to know about your application?"
              value={coverNote}
              onChange={(e) => setCoverNote(e.target.value)}
              disabled={isPending}
              maxLength={5000}
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {coverNote.length} / 5000 characters
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" aria-hidden />
              <AlertTitle>Could not submit application</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setPanelOpen(false);
                setCoverNote("");
                setError(null);
              }}
              disabled={isPending}
            >
              <X className="h-4 w-4" aria-hidden />
              Cancel
            </Button>
            <Button onClick={handleSubmitApplication} disabled={isPending}>
              <Send className="h-4 w-4" aria-hidden />
              {isPending ? "Submitting…" : "Submit application"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
