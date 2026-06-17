/**
 * Loading state for the notifications page. Mirrors the final layout's shape
 * (header strip, filter pill, feed skeleton) so the page doesn't jump when
 * content arrives.
 *
 * @module app/dashboard/notifications/loading
 */
import { Card } from "@/components/ui/card";
import { NotificationsSkeleton } from "./_components/notifications-skeleton";

export default function NotificationsLoading() {
  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="skeleton h-8 w-40" />
          <div className="skeleton h-4 w-72" />
        </div>
        <div className="skeleton h-9 w-32" />
      </div>

      <div className="mb-4">
        <div className="skeleton h-9 w-40" />
      </div>

      <Card className="overflow-hidden p-0">
        <NotificationsSkeleton />
      </Card>
    </>
  );
}
