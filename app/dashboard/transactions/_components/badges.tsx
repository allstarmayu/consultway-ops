/**
 * Transaction-type badge.
 *
 * Same visual language as `app/dashboard/projects/_components/badges.tsx`
 * and the tenders module — one config per type, palette-consistent with
 * the Warm Ambient theme. Lives in `app/dashboard/transactions/_components`
 * so the module stays self-contained.
 *
 * Five values, each tuned to its money-flow direction:
 *
 *   - invoice  — neutral (money owed TO us; not yet received).
 *                Document icon.
 *   - payment  — primary (money received; the happy path).
 *                Inbound-arrow icon.
 *   - expense  — accent muted (money out).
 *                Outbound-arrow icon.
 *   - advance  — accent bordered (money out, against future work).
 *                Hourglass icon.
 *   - refund   — destructive tint (money out, undoing past).
 *                Undo icon.
 *
 * @module app/dashboard/transactions/_components/badges
 */
import {
  ArrowDownLeft,
  ArrowUpRight,
  FileText,
  Hourglass,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TransactionType } from "@/lib/db/schema";

interface TransactionTypeStyle {
  /** Human-readable label. */
  label: string;
  /** Tailwind classes for the pill bg / text / border. */
  classes: string;
  /** Leading icon. */
  icon: LucideIcon;
}

const TRANSACTION_TYPE_STYLES: Record<TransactionType, TransactionTypeStyle> = {
  invoice: {
    label: "Invoice",
    classes: "bg-muted text-muted-foreground border-border",
    icon: FileText,
  },
  payment: {
    label: "Payment",
    classes: "bg-primary text-primary-foreground border-transparent",
    icon: ArrowDownLeft,
  },
  expense: {
    label: "Expense",
    classes: "bg-accent/10 text-accent border-accent/20",
    icon: ArrowUpRight,
  },
  advance: {
    label: "Advance",
    classes: "bg-accent/5 text-accent border-accent/30",
    icon: Hourglass,
  },
  refund: {
    label: "Refund",
    classes: "bg-destructive/10 text-destructive border-destructive/20",
    icon: Undo2,
  },
};

export interface TransactionTypeBadgeProps {
  type: TransactionType;
  iconless?: boolean;
}

export function TransactionTypeBadge({
  type,
  iconless = false,
}: TransactionTypeBadgeProps) {
  const style = TRANSACTION_TYPE_STYLES[type];
  const Icon = style.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        style.classes,
      )}
    >
      {!iconless && <Icon className="h-3 w-3" aria-hidden />}
      {style.label}
    </span>
  );
}

/**
 * The full list of transaction type options. Exported so the filter
 * bar and the form's type select can stay in sync with this single
 * source of truth.
 */
export const TRANSACTION_TYPE_OPTIONS: Array<{
  value: TransactionType;
  label: string;
}> = (Object.keys(TRANSACTION_TYPE_STYLES) as TransactionType[]).map(
  (value) => ({ value, label: TRANSACTION_TYPE_STYLES[value].label }),
);
