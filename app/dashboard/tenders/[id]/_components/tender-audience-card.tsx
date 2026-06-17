/**
 * Tender audience card — surfaces the open/invited model on the detail page.
 *
 * - Open tenders: a one-line "open to all" note (shown to managers only;
 *   company viewers don't need it).
 * - Invited tenders: managers (admin/staff) see the full invite roster as
 *   chips; an invited company viewer sees a friendly "you've been invited"
 *   note (the roster is staff-facing, so it isn't shown to them).
 *
 * Presentational only — the page fetches the roster (admin/staff scope via
 * `listTenderInvitedCompanies`) and passes it in.
 *
 * @module app/dashboard/tenders/[id]/_components/tender-audience-card
 */
import { Globe, Lock } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { TenderVisibility } from "@/lib/db/schema";

export interface TenderAudienceCardProps {
  visibility: TenderVisibility;
  /** Invited companies (id + name). Populated for managers on invited tenders. */
  invitedCompanies: { id: string; name: string }[];
  /** Whether the viewer manages the tender (admin/staff) — gates the roster. */
  canManage: boolean;
}

export function TenderAudienceCard({
  visibility,
  invitedCompanies,
  canManage,
}: TenderAudienceCardProps) {
  const isInvited = visibility === "invited";

  const summary = isInvited
    ? canManage
      ? "Invite-only — visible and open to apply only to the companies below."
      : "You've been invited to this tender. It isn't visible to other companies."
    : "Open — visible to every company; the eligibility filters gate who can apply.";

  return (
    <Card className="mt-4 p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <span
          className={
            isInvited
              ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
              : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          }
        >
          {isInvited ? (
            <Lock className="h-4 w-4" aria-hidden />
          ) : (
            <Globe className="h-4 w-4" aria-hidden />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Audience</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{summary}</p>

          {isInvited && canManage && (
            <div className="mt-3">
              {invitedCompanies.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {invitedCompanies.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-foreground"
                    >
                      {c.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No companies invited yet — add some before publishing.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
