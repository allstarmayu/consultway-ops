/**
 * Notifications feed section — the async-fetching half of the page.
 *
 * Extracted so the feed streams behind a Suspense boundary while the header +
 * filter render immediately. Calls `listNotifications(query)` with the raw URL
 * search params (the action's Zod schema handles coercion + defaults) and
 * renders the error, the empty state, or the list + pagination.
 *
 * @module app/dashboard/notifications/_components/notifications-section
 */
import { Bell } from "lucide-react";
import { listNotifications } from "@/lib/notifications/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/dashboard/pagination";
import { NotificationItem } from "./notification-item";

export interface NotificationsSectionProps {
  /** Raw `searchParams` from the page — passed through unchanged. */
  query: Record<string, string | string[] | undefined>;
}

export async function NotificationsSection({
  query,
}: NotificationsSectionProps) {
  const result = await listNotifications(query);

  if (!result.ok) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertTitle>Couldn&apos;t load notifications</AlertTitle>
        <AlertDescription>{result.error}</AlertDescription>
      </Alert>
    );
  }

  const { rows, total, page, perPage } = result;

  if (rows.length === 0) {
    const unreadOnly = query.filter === "unread";
    return (
      <EmptyState
        icon={Bell}
        title={unreadOnly ? "You're all caught up" : "No notifications yet"}
        description={
          unreadOnly
            ? "You have no unread notifications."
            : "When something needs your attention, it'll show up here."
        }
        className="px-6 py-16"
      />
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <>
      <ul className="divide-y divide-border">
        {rows.map((n) => (
          <NotificationItem key={n.id} notification={n} />
        ))}
      </ul>

      {totalPages > 1 && (
        <div className="flex items-center justify-end border-t border-border bg-card px-4 py-3">
          <Pagination page={page} totalPages={totalPages} />
        </div>
      )}
    </>
  );
}
