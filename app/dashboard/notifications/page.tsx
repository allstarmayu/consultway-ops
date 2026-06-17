/**
 * Notifications page — the user's in-app feed.
 *
 * Server Component shell. Any signed-in user may view their own notifications
 * (the layout guards signed-out visitors; `listNotifications` re-scopes to the
 * session user server-side). Reads `searchParams` for the all/unread filter +
 * pagination and defers the fetch into a Suspense boundary so the header +
 * filter paint immediately. Mirrors the companies/users list-page structure.
 *
 * @module app/dashboard/notifications/page
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { NotificationsSection } from "./_components/notifications-section";
import { NotificationFilter } from "./_components/notification-filter";
import { MarkAllReadButton } from "./_components/mark-all-read-button";
import { NotificationsSkeleton } from "./_components/notifications-skeleton";

export const metadata: Metadata = {
  title: "Notifications",
  description: "Your in-app notifications",
};

interface NotificationsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NotificationsPage({
  searchParams,
}: NotificationsPageProps) {
  const [params, session] = await Promise.all([searchParams, readSession()]);
  if (!session) redirect("/login");

  const filter = params.filter === "unread" ? "unread" : "all";
  const suspenseKey = JSON.stringify(params);

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Updates on companies, tenders, and your account"
        actions={<MarkAllReadButton />}
      />

      <div className="mb-4">
        <NotificationFilter filter={filter} />
      </div>

      <Card className="overflow-hidden p-0">
        <Suspense key={suspenseKey} fallback={<NotificationsSkeleton />}>
          <NotificationsSection query={params} />
        </Suspense>
      </Card>
    </>
  );
}
