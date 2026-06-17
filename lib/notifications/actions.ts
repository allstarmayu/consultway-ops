/**
 * Notifications module — user-facing Server Actions (the read + mark-read
 * side of the in-app feed). The programmatic WRITE side lives in `./notify.ts`
 * (`createNotification`), called by domain actions.
 *
 * Every action here is scoped to the calling user — a notification belongs to
 * exactly one recipient, and the RBAC matrix (§ Notifications) grants each
 * role "own notifications" only. There is no admin/staff override: nobody
 * reads or mutates another user's bell feed. Ownership is enforced in the
 * WHERE clause (`user_id = session.userId`), never just the UI.
 *
 * @module lib/notifications/actions
 */
"use server";

import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications, type NotificationRow } from "@/lib/db/schema";
import { readSession } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/types/action-result";
import { listNotificationsQuerySchema, notificationIdSchema } from "./schemas";

/**
 * List the caller's notifications, newest-first, paginated. `filter:
 * "unread"` restricts to unread rows. Always scoped to the session user.
 */
export async function listNotifications(
  rawQuery: unknown,
): Promise<
  ActionResult<{
    rows: NotificationRow[];
    total: number;
    page: number;
    perPage: number;
  }>
> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };

  const parsed = listNotificationsQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid query",
    };
  }
  const query = parsed.data;

  // Ownership scope is non-negotiable; the unread filter is additive.
  const scope = eq(notifications.userId, session.userId);
  const where =
    query.filter === "unread"
      ? and(scope, isNull(notifications.readAt))
      : scope;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage),
    db
      .select({ value: count() })
      .from(notifications)
      .where(where)
      .then((r) => r[0]),
  ]);

  return {
    ok: true,
    rows,
    total: totalRow?.value ?? 0,
    page: query.page,
    perPage: query.perPage,
  };
}

/** Count the caller's unread notifications — backs the sidebar badge. */
export async function unreadNotificationCount(): Promise<
  ActionResult<{ count: number }>
> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };

  // Defensive: the dashboard layout calls this on EVERY page. A query
  // failure (e.g. the migration lagging a deploy) must not 500 the whole
  // dashboard — degrade to "no badge" instead.
  try {
    const [row] = await db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, session.userId),
          isNull(notifications.readAt),
        ),
      );

    return { ok: true, count: row?.value ?? 0 };
  } catch {
    return { ok: true, count: 0 };
  }
}

/**
 * Mark one of the caller's notifications read. Scoped by `user_id` in the
 * WHERE so a caller can never flip another user's row; the `read_at IS NULL`
 * guard makes it a no-op on an already-read row (idempotent).
 */
export async function markNotificationRead(
  rawId: unknown,
): Promise<ActionResult> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };

  const parsed = notificationIdSchema.safeParse({ id: rawId });
  if (!parsed.success) return { ok: false, error: "Invalid notification id" };

  await db
    .update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(
      and(
        eq(notifications.id, parsed.data.id),
        eq(notifications.userId, session.userId),
        isNull(notifications.readAt),
      ),
    );

  return { ok: true };
}

/** Mark all of the caller's unread notifications read. */
export async function markAllNotificationsRead(): Promise<ActionResult> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };

  await db
    .update(notifications)
    .set({ readAt: new Date().toISOString() })
    .where(
      and(
        eq(notifications.userId, session.userId),
        isNull(notifications.readAt),
      ),
    );

  return { ok: true };
}
