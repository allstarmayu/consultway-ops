/**
 * Transaction detail header — title, type badge, and the admin-only
 * actions (Edit + Delete).
 *
 * Client Component — Delete calls a Server Action via `useTransition`
 * and surfaces errors inline.
 *
 * Delete is wrapped in a `<ConfirmDialog reasonField="required">` —
 * deletion of a transaction is a higher-stakes correction than
 * editing, so we force the admin to capture a brief reason that lands
 * in the audit row's `metadata.reason`. 5-char minimum mirrors the
 * tender award-retraction pattern.
 *
 * The whole transactions module is admin-only, so the "is admin" gate
 * is a tautology at this depth — both buttons render unconditionally.
 *
 * @module app/dashboard/transactions/[id]/_components/transaction-header
 */
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, Pencil, Trash2 } from "lucide-react";
import { deleteTransaction } from "@/lib/transactions/actions";
import type { Transaction } from "@/lib/db/schema";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRupeesFromPaise } from "@/lib/format/inr";
import { TransactionTypeBadge } from "../../_components/badges";

export interface TransactionHeaderProps {
  transaction: Transaction;
}

export function TransactionHeader({ transaction }: TransactionHeaderProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function runDelete(reason?: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteTransaction(transaction.id, {
        reason: reason ?? "",
      });
      if (!result.ok) {
        setError(result.error ?? "Could not delete transaction");
        return;
      }
      router.replace("/dashboard/transactions");
    });
  }

  // Title composes type + amount + date for at-a-glance context that
  // matches the audit-log label convention (see resolve-targets.ts).
  const title = `${transaction.type[0].toUpperCase()}${transaction.type.slice(1)} ${formatRupeesFromPaise(
    transaction.amountPaise,
  )}`;

  return (
    <>
      <header className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <TransactionTypeBadge type={transaction.type} />
            <span className="text-sm text-muted-foreground">
              {transaction.occurredOn}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            asChild
            variant="outline"
            disabled={isPending}
            aria-label="Edit transaction"
          >
            <Link href={`/dashboard/transactions/${transaction.id}/edit`}>
              <Pencil className="h-4 w-4" aria-hidden />
              Edit
            </Link>
          </Button>

          <ConfirmDialog
            trigger={
              <Button
                variant="outline"
                disabled={isPending}
                aria-label="Delete transaction"
                className="border-destructive/40 text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                Delete
              </Button>
            }
            title="Delete this transaction?"
            description="The row will be removed from the ledger. The audit log preserves the full snapshot for reconstruction, but the live row is gone."
            confirmLabel="Delete transaction"
            confirmVariant="destructive"
            reasonField="required"
            reasonLabel="Reason for deletion"
            reasonPlaceholder="e.g. Double-entry — already recorded as PAY-2026-076"
            onConfirm={(reason) => runDelete(reason)}
            pending={isPending}
          />
        </div>
      </header>

      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
