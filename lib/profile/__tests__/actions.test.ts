/**
 * Integration tests for `lib/profile/actions.ts`.
 *
 * Covers:
 *   - Unauthenticated callers get `{ ok: false }`.
 *   - Stale-session (JWT verifies but user row is gone) returns the
 *     friendly error instead of silently UPDATE-affecting 0 rows.
 *   - Happy path: persists the new name and bumps `updatedAt`.
 *   - Validation rejects names that are too short / too long with a
 *     `field: "name"` hint so the UI can highlight the input.
 *   - Unknown extra keys (e.g. a client trying to sneak in `phone`)
 *     are rejected — the schema is strict by design.
 *   - No-op short-circuit: re-saving the same name doesn't write or
 *     audit.
 *   - Audit event is emitted on a real change, with before/after
 *     snapshots scoped to the name column.
 *
 * Pattern mirrors `lib/preferences/__tests__/actions.test.ts` —
 * `vi.mock` with `importOriginal` so `assertUserExists` exercises the
 * real DB while `readSession` stays controllable per test.
 *
 * @module lib/profile/__tests__/actions
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockedFunction,
} from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, users, type UserRole } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    readSession: vi.fn(async () => null),
  };
});

import { readSession } from "@/lib/auth/session";
import { updateProfile } from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Fixture ────────────────────────────────────────────────────────────────

interface Fixture {
  userId: string;
  initialName: string;
}

async function seedFixture(): Promise<Fixture> {
  const userId = newId();
  const initialName = "Profile Test User";
  await db.insert(users).values({
    id: userId,
    email: `profile-${userId}@test.local`,
    passwordHash: "$2a$10$test",
    role: "admin" as UserRole,
    name: initialName,
  });
  return { userId, initialName };
}

async function clearFixture(f: Fixture): Promise<void> {
  // Audit rows reference the user via actorId / targetId without a FK
  // (audit is intentionally a leaf), so delete them explicitly to keep
  // the table tidy across test runs.
  await db
    .delete(auditLog)
    .where(eq(auditLog.actorId, f.userId))
    .catch(() => {});
  await db.delete(users).where(eq(users.id, f.userId));
}

function loginAs(userId: string): void {
  mockedReadSession.mockResolvedValue({
    userId,
    role: "admin",
    companyId: null,
    email: `profile-${userId}@test.local`,
  });
}

let fixture: Fixture;

beforeEach(async () => {
  fixture = await seedFixture();
});

afterEach(async () => {
  await clearFixture(fixture);
  mockedReadSession.mockReset();
  mockedReadSession.mockResolvedValue(null);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("updateProfile", () => {
  it("returns { ok: false } when unauthenticated", async () => {
    const result = await updateProfile({ name: "Anonymous" });
    expect(result.ok).toBe(false);
  });

  it("returns a friendly error when the session points at a missing user", async () => {
    // Simulate the "DB reseeded but cookie still valid" case — the
    // session verifies cleanly but the userId doesn't exist anymore.
    const ghostUserId = newId();
    mockedReadSession.mockResolvedValue({
      userId: ghostUserId,
      role: "admin",
      companyId: null,
      email: "ghost@test.local",
    });
    const result = await updateProfile({ name: "Anything" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/session is no longer valid/i);
  });

  it("persists the new name and bumps updatedAt", async () => {
    loginAs(fixture.userId);

    // First update establishes a baseline updatedAt via the Drizzle
    // $onUpdate hook (ISO format with Z). The seeded row's updatedAt
    // comes from SQLite's `datetime('now')` default (no Z → parsed as
    // local time), which would clash with the $onUpdate ISO string
    // in any non-UTC timezone. Going through $onUpdate twice keeps
    // both timestamps in the same format for a like-for-like compare.
    await updateProfile({ name: "Baseline Name" });
    const [before] = await db
      .select({ updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, fixture.userId));

    // Tick the wall clock so the second $onUpdate visibly moves.
    await new Promise((r) => setTimeout(r, 10));

    const result = await updateProfile({ name: "Renamed User" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe("Renamed User");

    const [after] = await db
      .select({ name: users.name, updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(after!.name).toBe("Renamed User");
    expect(new Date(after!.updatedAt).getTime()).toBeGreaterThan(
      new Date(before!.updatedAt).getTime(),
    );
  });

  it("trims whitespace before persisting", async () => {
    loginAs(fixture.userId);
    const result = await updateProfile({ name: "   Trimmed Name   " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe("Trimmed Name");

    const [row] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(row!.name).toBe("Trimmed Name");
  });

  it("rejects a name that's too short with field: 'name'", async () => {
    loginAs(fixture.userId);
    const result = await updateProfile({ name: "A" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("name");
  });

  it("rejects a name that's too long with field: 'name'", async () => {
    loginAs(fixture.userId);
    const result = await updateProfile({ name: "x".repeat(121) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("name");
  });

  it("rejects unknown extra keys (strict schema)", async () => {
    loginAs(fixture.userId);
    // Cast to bypass the (correct) compile-time rejection — we want to
    // verify the Zod `.strict()` rule also rejects at runtime, since a
    // real client could send arbitrary JSON.
    const result = await updateProfile({
      name: "Legit Name",
      phone: "+91 99999 99999",
    } as unknown as { name: string });
    expect(result.ok).toBe(false);
  });

  it("short-circuits on a no-op (same name) without writing or auditing", async () => {
    loginAs(fixture.userId);

    const result = await updateProfile({ name: fixture.initialName });
    expect(result.ok).toBe(true);

    // No audit rows for this user (the write was skipped).
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, fixture.userId));
    expect(auditRows).toHaveLength(0);
  });

  it("emits an audit event on a real change with before/after snapshots", async () => {
    loginAs(fixture.userId);

    const result = await updateProfile({ name: "New Audited Name" });
    expect(result.ok).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, fixture.userId));
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!;
    expect(row.action).toBe("updated");
    expect(row.targetType).toBe("user");
    expect(row.targetId).toBe(fixture.userId);
    expect(row.actorRole).toBe("admin");
    expect(row.before).toEqual({ name: fixture.initialName });
    expect(row.after).toEqual({ name: "New Audited Name" });
  });
});
