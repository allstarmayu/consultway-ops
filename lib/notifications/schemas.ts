/**
 * Zod schemas for the notifications module. Non-"use server" so both the
 * actions and any client caller can import them.
 *
 * @module lib/notifications/schemas
 */
import { z } from "zod";

const uuidSchema = z.string().uuid("Invalid identifier");

/**
 * Query for `listNotifications`. Coerces from URL search params so the
 * notifications page can pass `searchParams` straight through. `filter` is a
 * string enum, NOT a coerced boolean — `z.coerce.boolean("false")` is truthy,
 * which would silently invert an `?filter=...` value.
 */
export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  filter: z.enum(["all", "unread"]).default("all"),
});

export type ListNotificationsQuery = z.infer<
  typeof listNotificationsQuerySchema
>;

/** Single-id schema for `markNotificationRead`. */
export const notificationIdSchema = z.object({ id: uuidSchema });
