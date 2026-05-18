/**
 * Apply button — the company-role user's entry point into applying for
 * a tender.
 *
 * Renders four different states depending on eligibility and the
 * caller's existing application:
 *
 *   1. Already applied (submitted)    → muted "Your application:
 *                                       submitted" with a Withdraw
 *                                       button gated by ConfirmDialog.
 *   2. Already applied (decided/        → muted status pill, no actions
 *      withdrawn outside recall)         (shortlisted/rejected/awarded/
 *                                         withdrawn-past-recall-window).
 *   3. Already applied (withdrawn,       → muted "Your application:
 *      within recall window — Day 5)      withdrawn" with a Recall
 *                                         button gated by ConfirmDialog
 *                                         + caption showing days left.
 *   4. Eligible, not yet applied       → "Apply" button. Clicking
 *                                         expands an inline panel with
 *                                         optional cover note + Confirm.
 *   5. Ineligible                       → Disabled button with a
 *                                         human-readable reason in a
 *                                         tooltip / helper text below.
 *
 * The eligibility check here is a friendly *advisory* gate — it tells
 * the user up front if they can't apply, so they don't waste effort
 * filling in a cover note. The Server Action re-checks everything on
 * submit, so this UI gate is purely UX (defence in depth).
 *
 * Inline-collapsible approach for Apply instead of a Dialog — we render
 * the cover note inline because it's a multi-field affirmative action.
 * Withdraw and Recall both go through `<ConfirmDialog>` instead because
 * each is a single-decision action — same component that gates Mark
 * Awarded on the staff side.
 *
 * @module app/dashboard/tenders/[id]/_components/apply-button
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, RotateCcw, Send, X } from "lucide-react";
import {
  applyToTender,
  recallApplication,
  withdrawApplication,
} from "@/lib/tenders/actions";
import type { Tender, TenderApplication } from "@/lib/db/schema";
import {
  daysSince,
  isWithinRecallWindow,
  RECALL_WINDOW_DAYS,
} from "@/lib/tenders/state-machine";
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

  /**
   * Day 5 — Recall handler. Receives optional reason from the
   * ConfirmDialog (reasonField="optional"). Pass-through to the
   * Server Action which gates on ownership + recall window + tender
   * status; UI advisory below also checks the window so the button
   * isn't even rendered when the recall is impossible.
   */
  function handleRecall(reason?: string) {
    if (!existingApplication) return;
    setError(null);
    startTransition(async () => {
      const result = await recallApplication({
        applicationId: existingApplication.id,
        ...(reason ? { reason } : {}),
      });
      if (!result.ok) {
        setError(result.error ?? "Could not recall application");
        return;
      }
      router.refresh();
    });
  }

  // ── Render: already applied ─────────────────────────────────────────
  if (existingApplication) {
    /**
     * Day 5 — Compute recall eligibility for a withdrawn application.
     *
     * Three things must be true client-side for the Recall button to
     * appear:
     *   1. status === "withdrawn"
     *   2. decidedAt is non-null and within the recall window
     *   3. the underlying tender is still accepting applications
     *      (status === "published")
     *
     * The server re-checks all of this; the UI advisory keeps the
     * button from teasing the user with an action that would 100%
     * fail server-side.
     */
    const isWithdrawn = existingApplication.status === "withdrawn";
    const recallWindowOk = isWithinRecallWindow(existingApplication.decidedAt);
    const tenderAcceptsApps = tender.status === "published";
    const canRecall = isWithdrawn && recallWindowOk && tenderAcceptsApps;

    // Caption for the withdrawn state — explains the recall situation
    // regardless of whether the button is shown.
    let recallCaption: string | null = null;
    if (isWithdrawn) {
      if (!tenderAcceptsApps) {
        recallCaption = `Cannot recall — tender is ${tender.status}`;
      } else if (!recallWindowOk) {
        recallCaption = `Recall window of ${RECALL_WINDOW_DAYS} days has passed`;
      } else if (existingApplication.decidedAt) {
        // `daysSince` returns null when the timestamp is malformed.
        // If that happens we leave the caption empty rather than
        // surfacing a nonsensical "NaN days left". The recall button
        // itself is gated separately by `isWithinRecallWindow`, which
        // also fails closed on malformed timestamps.
        const elapsed = daysSince(existingApplication.decidedAt);
        if (elapsed !== null) {
          const remaining = Math.max(0, RECALL_WINDOW_DAYS - elapsed);
          recallCaption =
            remaining === 0
              ? "Last day to recall this application"
              : remaining === 1
                ? "1 day left to recall this application"
                : `${remaining} days left to recall this application`;
        }
      }
    }

    return (
      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Your application:
          </span>
          <ApplicationStatusBadge status={existingApplication.status} />
        </div>

        {/* Withdraw — available only while still submitted */}
        {existingApplication.status === "submitted" && (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm" disabled={isPending}>
                Withdraw application
              </Button>
            }
            title="Withdraw your application?"
            description={`Staff will see your application marked as withdrawn in their pipeline. You can recall it within ${RECALL_WINDOW_DAYS} days while the tender is still open for applications.`}
            confirmLabel="Withdraw"
            confirmVariant="destructive"
            onConfirm={handleWithdraw}
            pending={isPending}
          />
        )}

        {/* Day 5 — Recall, available only on a withdrawn application
            within the recall window AND while the tender still accepts
            applications. Caption renders below regardless. */}
        {canRecall && existingApplication.decidedAt && (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm" disabled={isPending}>
                <RotateCcw className="h-4 w-4" aria-hidden />
                Recall application
              </Button>
            }
            title="Recall your withdrawn application?"
            description="This moves your application back to submitted so staff can review it again. Your original cover note stays attached."
            confirmLabel="Recall application"
            confirmVariant="default"
            reasonField="optional"
            reasonLabel="Reason (optional)"
            reasonPlaceholder="e.g. Withdrew in error — still interested in this tender"
            onConfirm={handleRecall}
            pending={isPending}
          />
        )}

        {/* Caption — days remaining, or why recall is unavailable. */}
        {recallCaption && (
          <p className="text-right text-xs text-muted-foreground">
            {recallCaption}
          </p>
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
