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
 *   - Unknown extra keys (e.g. a client trying to sneak in `email`)
 *     are rejected — the schema is strict by design.
 *   - No-op short-circuit: re-saving identical values doesn't write or
 *     audit (covers single-field AND all-three-fields no-ops).
 *   - Audit event is emitted on a real change, with before/after
 *     snapshots scoped to ONLY the columns that changed.
 *   - Phone + jobTitle (Day 28) persist, clear via null, and round-trip
 *     empty strings as null so the form's "user cleared the input"
 *     gesture matches the column shape.
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
    // real client could send arbitrary JSON. Email is the canonical
    // example: deliberately NOT in the schema this round (needs a
    // verify-old + verify-new flow before users can change their auth
    // identifier), so a client trying to sneak it should fail.
    const result = await updateProfile({
      name: "Legit Name",
      email: "newaddress@test.local",
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

  // ── Phone + jobTitle (Day 28) ────────────────────────────────────────────

  it("persists phone and jobTitle when provided", async () => {
    loginAs(fixture.userId);
    const result = await updateProfile({
      name: fixture.initialName,
      phone: "+91 98765 43210",
      jobTitle: "Project Manager",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.phone).toBe("+91 98765 43210");
    expect(result.jobTitle).toBe("Project Manager");

    const [row] = await db
      .select({ phone: users.phone, jobTitle: users.jobTitle })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(row!.phone).toBe("+91 98765 43210");
    expect(row!.jobTitle).toBe("Project Manager");
  });

  it("clears phone + jobTitle to null when passed null", async () => {
    loginAs(fixture.userId);
    // Set them first so the clear has something to undo.
    await updateProfile({
      name: fixture.initialName,
      phone: "+91 98765 43210",
      jobTitle: "Civil Engineer",
    });

    const result = await updateProfile({
      name: fixture.initialName,
      phone: null,
      jobTitle: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.phone).toBeNull();
    expect(result.jobTitle).toBeNull();

    const [row] = await db
      .select({ phone: users.phone, jobTitle: users.jobTitle })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(row!.phone).toBeNull();
    expect(row!.jobTitle).toBeNull();
  });

  it("coerces an empty-string phone to null", async () => {
    loginAs(fixture.userId);
    await updateProfile({
      name: fixture.initialName,
      phone: "+91 98765 43210",
    });

    const result = await updateProfile({
      name: fixture.initialName,
      phone: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.phone).toBeNull();

    const [row] = await db
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(row!.phone).toBeNull();
  });

  it("short-circuits when all three fields match the persisted shape", async () => {
    loginAs(fixture.userId);
    // Seed with non-default phone + jobTitle so we have a non-trivial
    // shape to compare against.
    await updateProfile({
      name: fixture.initialName,
      phone: "+91 99999 99999",
      jobTitle: "Lead Architect",
    });

    // Now re-submit the same shape. Should be a no-op — no audit, no
    // second updatedAt bump.
    const [beforeRow] = await db
      .select({ updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, fixture.userId));

    await new Promise((r) => setTimeout(r, 10));

    const result = await updateProfile({
      name: fixture.initialName,
      phone: "+91 99999 99999",
      jobTitle: "Lead Architect",
    });
    expect(result.ok).toBe(true);

    const [afterRow] = await db
      .select({ updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, fixture.userId));
    // updatedAt didn't move — the UPDATE was skipped.
    expect(afterRow!.updatedAt).toBe(beforeRow!.updatedAt);

    // Exactly one audit row (from the seed), not two.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, fixture.userId));
    expect(auditRows).toHaveLength(1);
  });

  it("scopes the audit snapshot to only the columns that changed", async () => {
    loginAs(fixture.userId);
    // Seed phone + jobTitle so a single-field change has something to
    // contrast against.
    await updateProfile({
      name: fixture.initialName,
      phone: "+91 11111 11111",
      jobTitle: "Engineer",
    });

    // Now change ONLY phone. The audit snapshot should mention phone
    // and nothing else — not name, not jobTitle.
    const result = await updateProfile({
      name: fixture.initialName,
      phone: "+91 22222 22222",
      jobTitle: "Engineer",
    });
    expect(result.ok).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, fixture.userId));
    // Two rows now: the seed audit (which set phone + jobTitle from
    // null) and the phone-only change. The latest is the one we care
    // about — sort by createdAt to pick it deterministically.
    const sorted = [...auditRows].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const latest = sorted[sorted.length - 1]!;
    expect(latest.before).toEqual({ phone: "+91 11111 11111" });
    expect(latest.after).toEqual({ phone: "+91 22222 22222" });
  });

  it("rejects a phone longer than 32 chars with field: 'phone'", async () => {
    loginAs(fixture.userId);
    const result = await updateProfile({
      name: fixture.initialName,
      phone: "1".repeat(33),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("phone");
  });
});
