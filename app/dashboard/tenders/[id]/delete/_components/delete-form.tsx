/**
 * Delete-tender confirmation form.
 *
 * Client Component. Owns the type-to-confirm safety pattern:
 *
 *   - Renders a disabled "Delete tender" button by default
 *   - User must type the tender's title verbatim into the input
 *   - When input === title, the button enables
 *   - Click → call `deleteTender` action → redirect to /dashboard/tenders
 *
 * Same shape as the companies delete form (Day 3). The friction is
 * deliberate — deletion is irreversible (we cascade-delete the draft's
 * applications too) and the page-level gate already ensures only
 * admins reach this UI, but a confirmation step prevents a misclick on
 * a row that happens to be in focus.
 *
 * @module app/dashboard/tenders/[id]/delete/_components/delete-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Trash2, X } from "lucide-react";
import { deleteTender } from "@/lib/tenders/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// ── Props ─────────────────────────────────────────────────────────────────

export interface DeleteFormProps {
  /** The tender id being deleted. */
  tenderId: string;
  /** Tender title — typed verbatim by the user to confirm. */
  tenderTitle: string;
}

// ── Component ─────────────────────────────────────────────────────────────

export function DeleteForm({ tenderId, tenderTitle }: DeleteFormProps) {
  const router = useRouter();
  const [confirmInput, setConfirmInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Match the title exactly (trim only — we don't want to be too clever
  // about case or whitespace; if the user types it precisely, they
  // meant it). The companies form uses the same comparison.
  const confirmed = confirmInput.trim() === tenderTitle.trim();
  const disableSubmit = !confirmed || isPending;

  function handleDelete() {
    if (!confirmed) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteTender(tenderId);
      if (!result.ok) {
        setError(result.error ?? "Could not delete tender");
        return;
      }
      // Use replace, not push — we don't want the just-deleted detail
      // URL on the back stack.
      router.replace("/dashboard/tenders");
    });
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>Could not delete</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label
          htmlFor="confirm-input"
          className="text-sm font-medium text-foreground"
        >
          Type the tender title to confirm
        </Label>
        <p className="font-mono text-xs text-muted-foreground">
          {tenderTitle}
        </p>
        <Input
          id="confirm-input"
          type="text"
          value={confirmInput}
          onChange={(e) => setConfirmInput(e.target.value)}
          placeholder="Tender title"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={isPending}
          aria-invalid={
            confirmInput.length > 0 && !confirmed ? true : undefined
          }
        />
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push(`/dashboard/tenders/${tenderId}`)}
          disabled={isPending}
        >
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={handleDelete}
          disabled={disableSubmit}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          {isPending ? "Deleting…" : "Delete tender"}
        </Button>
      </div>
    </div>
  );
}
