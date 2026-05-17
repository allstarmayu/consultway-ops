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
 * Usage:
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

/**
 * The variant slot of `<Button>` ("default" | "outline" | "destructive"
 * | ...). Derived from the same `buttonVariants` CVA the Button file
 * exports so we never drift if a new variant lands.
 */
type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;

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
   */
  onConfirm: () => void | Promise<void>;

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
  open,
  onOpenChange,
}: ConfirmDialogProps) {
  // Click handler for the confirm button. Calls onConfirm, but
  // SUPPRESSES the AlertDialog's default close-on-action behaviour
  // when an action is pending — otherwise the dialog closes
  // immediately and the user loses sight of the loading state.
  function handleConfirm(e: React.MouseEvent<HTMLButtonElement>) {
    if (pending) {
      e.preventDefault();
      return;
    }
    // Fire-and-forget — if onConfirm returns a promise we don't await
    // here because radix has already closed the dialog by the time the
    // promise resolves. Callers that need post-confirm state should
    // observe their own transition state, not this handler.
    void onConfirm();
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

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
              disabled={pending}
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
