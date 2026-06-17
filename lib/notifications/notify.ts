/**
 * Notification creator — the programmatic write side of the in-app feed.
 *
 * Mirrors `lib/audit/log.ts::recordAuditEvent`: a plain (non-"use server")
 * module called from other domain actions at the same site that sends the
 * email / records the audit event. NEVER throws — a failed notification must
 * not break the user action that triggered it (the work already succeeded; a
 * missing bell entry is a degraded-but-acceptable outcome). On failure we log
 * via the structured logger and return normally.
 *
 * Not user-facing: there is no auth gate here. The CALLER is a domain action
 * that already authorised the triggering operation; this just records the
 * resulting notification(s) for the given recipient(s).
 *
 * @module lib/notifications/notify
 */
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { logger } from "@/lib/logger";
import type { NotificationType } from "./types";

const log = logger.child({ module: "notifications" });

/** Input for a single notification. `userId` is the recipient. */
export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  /** Optional one-line detail under the title. */
  body?: string | null;
  /** Optional relative deep link, e.g. "/dashboard/companies/<id>". */
  link?: string | null;
}

/**
 * Create one notification for one user. Fail-soft — logs and returns on any
 * error, never throws.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<void> {
  try {
    await db.insert(notifications).values({
      id: newId(),
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      // read_at left NULL (unread); created_at defaults at the DB layer.
    });
  } catch (err) {
    log.error("createNotification failed", {
      err,
      userId: input.userId,
      type: input.type,
    });
  }
}

/**
 * Fan a single notification out to many recipients (e.g. every user at a
 * company when that company's status changes). One multi-row insert; same
 * fail-soft contract. No-op on an empty recipient list.
 */
export async function createNotificationsForUsers(
  userIds: string[],
  notification: Omit<CreateNotificationInput, "userId">,
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await db.insert(notifications).values(
      userIds.map((userId) => ({
        id: newId(),
        userId,
        type: notification.type,
        title: notification.title,
        body: notification.body ?? null,
        link: notification.link ?? null,
      })),
    );
  } catch (err) {
    log.error("createNotificationsForUsers failed", {
      err,
      count: userIds.length,
      type: notification.type,
    });
  }
}
