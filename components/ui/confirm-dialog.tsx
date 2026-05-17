/**
 * ConfirmDialog — reusable wrapper around shadcn `<AlertDialog>` for
 * "are you sure?" prompts.
 *
 * Replaces the lazy `window.confirm()` calls that were peppered into
 * Day-4 destructive / terminal actions (Mark awarded, Withdraw
 * application). Uses the Warm Ambient palette via the same CSS
 * variables every other surface does, so it feels in-app rather than
 * like an OS dialog.
 *
 * Basic usage (no reason capture):
 *
 *   <ConfirmDialog
 *     trigger={<Button>Delete</Button>}
 *     title="Delete this record?"
 *     description="This action cannot be undone."
 *     confirmLabel="Delete"
 *     confirmVariant="destructive"
 *     onConfirm={() => deleteRecord(id)}
 *     pending={isPending}
 *   />
 *
 * Reason-capture usage (Day 5 — reversal actions):
 *
 *   <ConfirmDialog
 *     trigger={<Button>Retract award</Button>}
 *     title="Retract this award?"
 *     description="The tender will return to the closed state."
 *     confirmLabel="Retract award"
 *     confirmVariant="destructive"
 *     reasonField="required"
 *     reasonLabel="Why are you retracting this award?"
 *     reasonPlaceholder="Awarded company declined the contract…"
 *     onConfirm={(reason) => retractAward(tenderId, reason!)}
 *     pending={isPending}
 *   />
 *
 * Design notes:
 *   - The `trigger` is wrapped in `<AlertDialogTrigger asChild>` so the
 *     caller can pass any clickable element (typically a `<Button>`).
 *     The dialog opens when the trigger is clicked.
 *   - `onConfirm` is async-friendly. Callers usually wrap their Server
 *     Action call in a `useTransition` and pass `pending` to disable the
 *     Confirm button during the call. The dialog stays open until the
 *     transition settles — the caller is responsible for closing it via
 *     the `open`/`onOpenChange` pair if needed.
 *   - By default the dialog manages its own open/close state. Callers
 *     that need to control it externally (e.g. close after a success
 *     redirect) pass `open` + `onOpenChange` props.
 *   - `confirmVariant` lets the caller pick the visual weight: default
 *     for "irreversible-but-not-dangerous" (markAwarded), destructive
 *     for delete-style actions.
 *
 * ── Day 5: reason capture ──────────────────────────────────────────────
 *
 *   - `reasonField` opt-in adds a textarea between the description and
 *     the buttons. Three modes:
 *       - omitted          → no textarea (existing behaviour)
 *       - "optional"       → textarea shown; empty submission allowed,
 *                            Confirm enabled regardless. `onConfirm`
 *                            receives the trimmed reason or `undefined`
 *                            when empty.
 *       - "required"       → textarea shown; Confirm disabled until the
 *                            input has at least 5 trimmed characters
 *                            (matches `requiredReasonSchema` in
 *                            `lib/tenders/schemas.ts`). `onConfirm`
 *                            receives the trimmed reason.
 *   - The reason input state is reset every time the dialog closes so
 *     stale text doesn't persist between opens.
 *   - `onConfirm` signature widened to `(reason?: string) => void |
 *     Promise<void>`. Existing call sites that declared a no-arg
 *     handler remain compatible — TypeScript permits ignoring
 *     positional args at the call site.
 *
 * @module components/ui/confirm-dialog
 */
"use client";

import * as React from "react";
import { type VariantProps } from "class-variance-authority";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * The variant slot of `<Button>` ("default" | "outline" | "destructive"
 * | ...). Derived from the same `buttonVariants` CVA the Button file
 * exports so we never drift if a new variant lands.
 */
type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;

/**
 * Reason-capture mode. Mirrors the two reason-schema variants in
 * `lib/tenders/schemas.ts` (`optionalReasonSchema`, `requiredReasonSchema`).
 * Omit the prop entirely when no reason is needed.
 */
export type ReasonFieldMode = "optional" | "required";

/**
 * Minimum trimmed length when `reasonField === "required"`. Kept in
 * sync with `requiredReasonSchema.min(5, …)` in tenders/schemas.ts so
 * the client-side gate matches the server-side gate. If the schema
 * minimum ever changes, update this constant too.
 */
const REQUIRED_REASON_MIN_LENGTH = 5;

// ── Props ─────────────────────────────────────────────────────────────────

export interface ConfirmDialogProps {
  /**
   * Element that opens the dialog. Typically a `<Button>`. Cloned via
   * `asChild` so its onClick is intercepted by AlertDialogTrigger.
   */
  trigger: React.ReactNode;

  /** Dialog heading. Question form reads best: "Mark X as awarded?" */
  title: string;

  /**
   * Body text explaining the consequence. Plain string or arbitrary
   * ReactNode (for e.g. inline `<strong>`). One short paragraph is the
   * sweet spot; anything longer means the action deserves a dedicated
   * page (cf. the delete-form's type-to-confirm flow).
   */
  description: React.ReactNode;

  /** Confirm button label. Verb form: "Delete", "Mark awarded". */
  confirmLabel: string;

  /** Cancel button label. Default: "Cancel". */
  cancelLabel?: string;

  /**
   * Visual weight of the confirm button. Use `"destructive"` for
   * delete-style actions, `"default"` for irreversible-but-not-dangerous
   * (e.g. marking a tender awarded). Maps to the Button variant.
   */
  confirmVariant?: ButtonVariant;

  /**
   * Called when the user clicks Confirm. Can be sync or async; callers
   * typically wrap their Server Action call in `useTransition` and
   * pass `pending` to disable the button during the call.
   *
   * The `reason` argument is:
   *   - `undefined` when `reasonField` is omitted
   *   - the trimmed reason string, or `undefined` if the user left the
   *     textarea empty and `reasonField === "optional"`
   *   - the trimmed reason string (guaranteed non-empty) when
   *     `reasonField === "required"`
   */
  onConfirm: (reason?: string) => void | Promise<void>;

  /**
   * True while the action is in flight. Disables both buttons and
   * surfaces a "…" suffix on the confirm label.
   */
  pending?: boolean;

  /**
   * Externally controlled open state. Pair with `onOpenChange`.
   * Most callers omit this — uncontrolled mode is the default.
   */
  open?: boolean;

  /** Open-state change handler for controlled usage. */
  onOpenChange?: (open: boolean) => void;

  // ── Day 5: reason capture (all optional) ────────────────────────────

  /**
   * Add a reason textarea to the dialog. Omit entirely for no textarea
   * (default — preserves existing behaviour for every Day-4 call site).
   */
  reasonField?: ReasonFieldMode;

  /** Label above the reason textarea. Default: "Reason". */
  reasonLabel?: string;

  /** Placeholder inside the reason textarea. Default: a generic prompt. */
  reasonPlaceholder?: string;

  /**
   * Hint shown below the textarea when `reasonField === "required"`.
   * Default explains the minimum length. Pass `null` to hide entirely.
   */
  reasonHint?: React.ReactNode | null;
}

// ── Component ─────────────────────────────────────────────────────────────

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmVariant = "default",
  onConfirm,
  pending = false,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  reasonField,
  reasonLabel = "Reason",
  reasonPlaceholder = "Add a brief explanation…",
  reasonHint,
}: ConfirmDialogProps) {
  // Internal uncontrolled open state. Only used when the caller didn't
  // pass `open` / `onOpenChange`. We track it ourselves so the reason
  // textarea can be reset when the dialog closes — radix's
  // uncontrolled mode doesn't expose state to us otherwise.
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = openProp !== undefined;
  const isOpen = isControlled ? openProp : internalOpen;

  // Reason textarea state. Reset on close (see effect below) so stale
  // text from a previous open doesn't leak into the next session.
  const [reason, setReason] = React.useState("");

  // Bridge open-state changes: forward to the caller when controlled,
  // update internal state when uncontrolled, and always reset the
  // reason input on close.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) {
        // Closing — clear the textarea so reopens start blank.
        setReason("");
      }
      if (isControlled) {
        onOpenChangeProp?.(next);
      } else {
        setInternalOpen(next);
      }
    },
    [isControlled, onOpenChangeProp],
  );

  // Computed gating: when `required`, block Confirm until min-length met.
  // When `optional`, never block on the textarea. When undefined, the
  // textarea doesn't render and this flag is always `true`.
  const trimmedReason = reason.trim();
  const reasonSatisfied =
    reasonField === "required"
      ? trimmedReason.length >= REQUIRED_REASON_MIN_LENGTH
      : true;

  const confirmDisabled = pending || !reasonSatisfied;

  // Click handler for the confirm button. Calls onConfirm with the
  // trimmed reason (or undefined for omitted / empty optional).
  // SUPPRESSES the AlertDialog's default close-on-action behaviour
  // when an action is pending OR when the reason gate hasn't been
  // satisfied — otherwise the dialog closes immediately and the user
  // loses sight of the loading state / their incomplete input.
  function handleConfirm(e: React.MouseEvent<HTMLButtonElement>) {
    if (confirmDisabled) {
      e.preventDefault();
      return;
    }

    // Resolve the reason value passed back to the caller.
    let reasonArg: string | undefined;
    if (reasonField === "required") {
      reasonArg = trimmedReason;
    } else if (reasonField === "optional") {
      reasonArg = trimmedReason.length > 0 ? trimmedReason : undefined;
    } else {
      reasonArg = undefined;
    }

    // Fire-and-forget — if onConfirm returns a promise we don't await
    // here because radix has already closed the dialog by the time the
    // promise resolves. Callers that need post-confirm state should
    // observe their own transition state, not this handler.
    void onConfirm(reasonArg);
  }

  // Default hint text for the required mode. Only shown when the
  // caller didn't pass an explicit hint or null.
  const defaultRequiredHint =
    reasonField === "required" ? (
      <p className="text-xs text-muted-foreground">
        Minimum {REQUIRED_REASON_MIN_LENGTH} characters. Captured in the
        audit log.
      </p>
    ) : null;

  // Resolve the effective hint, honoring an explicit `null` to mean
  // "no hint at all".
  const effectiveHint =
    reasonHint === undefined ? defaultRequiredHint : reasonHint;

  return (
    <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {/* Reason textarea, when opted in. Re-enable text selection on
            the input itself so the dashboard's no-select policy doesn't
            interfere with typing / pasting. */}
        {reasonField && (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-dialog-reason">
              {reasonLabel}
              {reasonField === "optional" && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  (optional)
                </span>
              )}
            </Label>
            <Textarea
              id="confirm-dialog-reason"
              rows={3}
              maxLength={500}
              placeholder={reasonPlaceholder}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              className="select-text resize-none"
              autoFocus
            />
            {effectiveHint}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>

          {/* Wrap the confirm action in our own Button so we get the
              variant system (destructive vs default) and consistent
              styling. AlertDialogAction is a thin wrapper that we'd
              otherwise have to re-style by hand. Note: we use asChild
              so the Button is the rendered element and AlertDialogAction
              passes its click semantics through. */}
          <AlertDialogAction asChild>
            <Button
              variant={confirmVariant}
              disabled={confirmDisabled}
              onClick={handleConfirm}
            >
              {pending ? `${confirmLabel}…` : confirmLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
