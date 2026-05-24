/**
 * QuickActionsBar — admin/staff convenience row of CTAs at the bottom
 * of the dashboard. Mirrors the Figma reference: Add Company / Add
 * Tender / Add Project / Add Transaction / View Reports.
 *
 * Pure presentation. Server Component. Role-gated by the host:
 *
 *   - admin: all 5 buttons
 *   - staff: 4 buttons (Add Transaction is admin-only)
 *   - company: not rendered (the host skips the section entirely)
 *
 * Each CTA links straight into the relevant create surface — every
 * one of these routes already exists from earlier days. The bar is
 * styled as a Card with a horizontal flex of outline buttons; the
 * leftmost button (Add Company, the most common action) gets the
 * filled primary variant to draw the eye.
 *
 * @module app/dashboard/_components/quick-actions-bar
 */
import Link from "next/link";
import {
  Briefcase,
  Building2,
  FileText,
  PlusCircle,
  Receipt,
  TrendingUp,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export interface QuickActionsBarProps {
  /** When true, render the admin-only "Add Transaction" CTA. */
  canCreateTransactions: boolean;
}

export function QuickActionsBar({ canCreateTransactions }: QuickActionsBarProps) {
  return (
    <Card className="overflow-hidden p-0">
      <header className="flex items-center gap-2 border-b border-border bg-card p-4">
        <PlusCircle className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-base font-semibold text-foreground">
          Quick actions
        </h2>
      </header>

      <div className="flex flex-wrap gap-2 p-4">
        <Button asChild>
          <Link href="/dashboard/companies/new">
            <Building2 className="h-4 w-4" aria-hidden />
            Add company
          </Link>
        </Button>

        <Button asChild variant="outline">
          <Link href="/dashboard/tenders/new">
            <FileText className="h-4 w-4" aria-hidden />
            Add tender
          </Link>
        </Button>

        <Button asChild variant="outline">
          <Link href="/dashboard/projects/new">
            <Briefcase className="h-4 w-4" aria-hidden />
            Add project
          </Link>
        </Button>

        {canCreateTransactions && (
          <Button asChild variant="outline">
            <Link href="/dashboard/transactions/new">
              <Receipt className="h-4 w-4" aria-hidden />
              Add transaction
            </Link>
          </Button>
        )}

        <Button asChild variant="outline">
          <Link href="/dashboard/reports">
            <TrendingUp className="h-4 w-4" aria-hidden />
            View reports
          </Link>
        </Button>
      </div>
    </Card>
  );
}
