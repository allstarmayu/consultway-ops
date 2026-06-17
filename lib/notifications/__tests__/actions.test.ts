/**
 * Integration tests for the notifications module.
 *
 * Exercises the real Drizzle client against the in-memory test DB. `readSession`
 * is mocked to a controllable session. Covers the programmatic creator
 * (`notify.ts`) and the user-facing actions: own-user scoping, the unread
 * filter + count, pagination, and mark-read / mark-all-read (including the
 * cross-user guard).
 *
 * @module lib/notifications/__tests__/actions
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, notifications } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { newId } from "@/lib/db/ids";
import { createNotification, createNotificationsForUsers } from "../notify";
import {
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "../actions";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(),
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
}));

import { readSession } from "@/lib/auth/session";
const mockedReadSession = vi.mocked(readSession);

const USER_A = newId();
const USER_B = newId();
const sessionA = {
  userId: USER_A,
  email: "a@test.local",
  role: "staff" as const,
  companyId: null,
};

async function seedUser(id: string, email: string) {
  await db.insert(users).values({
    id,
    email,
    passwordHash: await hashPassword("seed-password-123"),
    name: "Seed User",
    role: "staff",
  });
}

beforeEach(async () => {
  // notifications first — FK child of users.
  await db.delete(notifications);
  await db.delete(users);
  await seedUser(USER_A, "a@test.local");
  await seedUser(USER_B, "b@test.local");
  mockedReadSession.mockResolvedValue(sessionA);
});

// ── creator (notify.ts) ──────────────────────────────────────────────────────

describe("createNotification / createNotificationsForUsers", () => {
  it("creates a single unread notification", async () => {
    await createNotification({
      userId: USER_A,
      type: "company_verified",
      title: "Company verified",
      link: "/dashboard/companies/x",
    });
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, USER_A));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("company_verified");
    expect(rows[0]?.link).toBe("/dashboard/companies/x");
    expect(rows[0]?.readAt).toBeNull();
  });

  it("fans a notification out to many recipients", async () => {
    await createNotificationsForUsers([USER_A, USER_B], {
      type: "tender_published",
      title: "New tender",
    });
    const a = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, USER_A));
    const b = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, USER_B));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("is a no-op for an empty recipient list", async () => {
    await createNotificationsForUsers([], {
      type: "tender_published",
      title: "x",
    });
    const all = await db.select().from(notifications);
    expect(all).toHaveLength(0);
  });
});

// ── listNotifications ────────────────────────────────────────────────────────

describe("listNotifications", () => {
  it("refuses an unauthenticated caller", async () => {
    mockedReadSession.mockResolvedValueOnce(null);
    const r = await listNotifications({});
    expect(r.ok).toBe(false);
  });

  it("returns only the caller's own notifications", async () => {
    await createNotification({ userId: USER_A, type: "company_verified", title: "A1" });
    await createNotification({ userId: USER_B, type: "company_verified", title: "B1" });
    const r = await listNotifications({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.title).toBe("A1");
  });

  it("filters to unread with filter=unread", async () => {
    await createNotification({ userId: USER_A, type: "company_verified", title: "still unread" });
    await createNotification({ userId: USER_A, type: "company_verified", title: "now read" });
    const [toRead] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.title, "now read"));
    await db
      .update(notifications)
      .set({ readAt: new Date().toISOString() })
      .where(eq(notifications.id, toRead!.id));

    const r = await listNotifications({ filter: "unread" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.title).toBe("still unread");
  });

  it("paginates", async () => {
    for (let i = 0; i < 3; i++) {
      await createNotification({ userId: USER_A, type: "company_verified", title: `n${i}` });
    }
    const page1 = await listNotifications({ perPage: "2", page: "1" });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(3);
  });
});

// ── unreadNotificationCount ──────────────────────────────────────────────────

describe("unreadNotificationCount", () => {
  it("counts only the caller's unread notifications", async () => {
    await createNotification({ userId: USER_A, type: "company_verified", title: "a" });
    await createNotification({ userId: USER_A, type: "company_verified", title: "b" });
    await createNotification({ userId: USER_B, type: "company_verified", title: "c" });
    const r = await unreadNotificationCount();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(2);
  });
});

// ── markNotificationRead ─────────────────────────────────────────────────────

describe("markNotificationRead", () => {
  it("marks the caller's own notification read", async () => {
    await createNotification({ userId: USER_A, type: "company_verified", title: "a" });
    const [n] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, USER_A));
    const r = await markNotificationRead(n!.id);
    expect(r.ok).toBe(true);
    const [after] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, n!.id));
    expect(after?.readAt).not.toBeNull();
  });

  it("cannot mark another user's notification read", async () => {
    await createNotification({ userId: USER_B, type: "company_verified", title: "b" });
    const [n] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, USER_B));
    // session is USER_A — the WHERE's user_id scope means this updates nothing.
    const r = await markNotificationRead(n!.id);
    expect(r.ok).toBe(true);
    const [after] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, n!.id));
    expect(after?.readAt).toBeNull();
  });
});

// ── markAllNotificationsRead ─────────────────────────────────────────────────

describe("markAllNotificationsRead", () => {
  it("marks all the caller's unread read and leaves other users untouched", async () => {
    await createNotification({ userId: USER_A, type: "company_verified", title: "a1" });
    await createNotification({ userId: USER_A, type: "company_verified", title: "a2" });
    await createNotification({ userId: USER_B, type: "company_verified", title: "b1" });

    const r = await markAllNotificationsRead();
    expect(r.ok).toBe(true);

    const aUnread = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, USER_A), isNull(notifications.readAt)));
    expect(aUnread).toHaveLength(0);

    const bUnread = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, USER_B), isNull(notifications.readAt)));
    expect(bUnread).toHaveLength(1);
  });
});
