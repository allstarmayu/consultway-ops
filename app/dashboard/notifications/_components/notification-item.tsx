/**
 * A single notification row (client).
 *
 * The whole row is a button: activating it marks the notification read (if it
 * was unread) and, when the notification carries a deep link, routes there;
 * otherwise it just `router.refresh()`es so the read-state + sidebar badge
 * update. Unread rows get a tinted background + a dot.
 *
 * @module app/dashboard/notifications/_components/notification-item
 */
"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  CheckCircle2,
  XCircle,
  Ban,
  Star,
  Award,
  CircleSlash,
  FileWarning,
  Megaphone,
  Building2,
  type LucideIcon,
} from "lucide-react";
import { markNotificationRead } from "@/lib/notifications/actions";
import { formatRelativeTime } from "@/lib/utils/format-relative-time";
import { cn } from "@/lib/utils";
import type { NotificationRow } from "@/lib/db/schema";

/**
 * type → feed icon. String-keyed so an unrecognised type (e.g. one added
 * server-side before this map) falls back to a bell rather than crashing.
 */
const ICONS: Record<string, LucideIcon> = {
  company_verified: CheckCircle2,
  company_rejected: XCircle,
  company_suspended: Ban,
  application_shortlisted: Star,
  application_rejected: XCircle,
  application_awarded: Award,
  application_not_selected: CircleSlash,
  document_expiring: FileWarning,
  tender_published: Megaphone,
  company_registered: Building2,
};

export interface NotificationItemProps {
  notification: NotificationRow;
}

export function NotificationItem({ notification }: NotificationItemProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const isUnread = notification.readAt === null;
  const Icon = ICONS[notification.type] ?? Bell;

  function handleActivate() {
    startTransition(async () => {
      if (isUnread) await markNotificationRead(notification.id);
      if (notification.link) {
        router.push(notification.link);
      } else {
        // No deep link — refresh so the read-state + sidebar badge update.
        router.refresh();
      }
    });
  }

  return (
    <li>
      <button
        type="button"
        onClick={handleActivate}
        disabled={isPending}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60",
          isUnread && "bg-muted/30",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            isUnread
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-sm text-foreground",
              isUnread ? "font-semibold" : "font-medium",
            )}
          >
            {notification.title}
          </p>
          {notification.body && (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {notification.body}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {formatRelativeTime(notification.createdAt) || "Just now"}
          </p>
        </div>

        {isUnread && (
          <span
            className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
            aria-label="Unread"
          />
        )}
      </button>
    </li>
  );
}
