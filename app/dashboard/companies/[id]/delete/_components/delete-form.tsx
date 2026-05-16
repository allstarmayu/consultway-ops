/**
 * Delete confirmation form.
 *
 * Client Component. Owns:
 *
 *   - The type-to-confirm input (user types the company name; submit
 *     button stays disabled until exact match — case-sensitive, no
 *     whitespace tolerance)
 *   - The `deleteCompany` Server Action call
 *   - The success redirect to the companies list
 *   - Error display when something goes wrong server-side
 *
 * No react-hook-form here — single input, no validation logic worth
 * formalising. useState is fine.
 *
 * @module app/dashboard/companies/[id]/delete/_components/delete-form
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Trash2, X } from "lucide-react";
import { deleteCompany } from "@/lib/companies/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// ── Props ───────────────────────────────────────────────────────────────────

export interface DeleteFormProps {
  /** UUID of the company to delete — passed to deleteCompany action. */
  companyId: string;

  /** Display name. User must type this exactly to enable the submit button. */
  companyName: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export function DeleteForm({ companyId, companyName }: DeleteFormProps) {
  const router = useRouter();
  const [confirmText, setConfirmText] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Submit gate: button only enables when the typed name matches the
  // real name exactly. Whitespace stripped on both sides so a trailing
  // space doesn't trip a frustrated user. Otherwise strict — case
  // matters, internal whitespace matters.
  const isMatch = confirmText.trim() === companyName.trim();
  const submitDisabled = !isMatch || isPending;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isMatch) return;

    setServerError(null);
    startTransition(async () => {
      const result = await deleteCompany(companyId);

      if (!result.ok) {
        setServerError(result.error);
        return;
      }

      // Success — go back to the list. Use router.replace because
      // the deleted row's URL is invalid now and shouldn't be a
      // valid "back" destination.
      router.replace("/dashboard/companies");
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5">
      {serverError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not delete</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label
          htmlFor="confirm-name"
          className="text-sm font-medium text-foreground"
        >
          Type the company name to confirm
        </Label>
        <p className="text-xs text-muted-foreground">
          To prevent accidental deletion, type{" "}
          <span className="font-mono font-semibold text-foreground">
            {companyName}
          </span>{" "}
          below.
        </p>
        <Input
          id="confirm-name"
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={companyName}
          disabled={isPending}
          aria-invalid={confirmText.length > 0 && !isMatch}
          // Aria-describedby would point at a hint, but the hint is
          // visible above; no need for redundant linkage.
        />
        {confirmText.length > 0 && !isMatch && (
          <p className="text-xs text-muted-foreground">
            Name doesn&apos;t match yet — keep typing.
          </p>
        )}
      </div>

      {/* Action row — Cancel left, Delete right. Not using the
          StickyActionBar primitive here because the page card is
          intentionally narrow and centered; sticky framing would
          stretch across the viewport awkwardly. */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={() => router.push(`/dashboard/companies/${companyId}`)}
        >
          <X className="h-4 w-4" aria-hidden />
          Cancel
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={submitDisabled}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          {isPending ? "Deleting..." : "Delete forever"}
        </Button>
      </div>
    </form>
  );
}
