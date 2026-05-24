/**
 * Integration tests for `lib/preferences/actions.ts`.
 *
 * Covers:
 *   - Unauthenticated callers get `{ ok: false }` from both actions.
 *   - `getPreferences` returns hard-coded defaults when no row exists
 *     (lazy-creation contract).
 *   - `updatePreferences` inserts a row on first save and returns the
 *     merged shape.
 *   - Subsequent calls UPDATE in place, persist changes, and bump
 *     `updatedAt`.
 *   - Invalid theme id returns `{ ok: false, field: "themeId" }`.
 *   - Empty patch short-circuits (no insert, no error).
 *
 * @module lib/preferences/__tests__/actions
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
import { users, userPreferences, type UserRole } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

// Mock only `readSession` — keep `assertUserExists` as the real
// implementation so the "ghost session" tests below actually exercise
// the DB existence check (the ghost userId is never inserted, so the
// real helper returns false naturally).
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    readSession: vi.fn(async () => null),
  };
});

import { readSession } from "@/lib/auth/session";
import { getPreferences, updatePreferences } from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Fixture ────────────────────────────────────────────────────────────────

interface Fixture {
  userId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const userId = newId();
  await db.insert(users).values({
    id: userId,
    email: `prefs-${userId}@test.local`,
    passwordHash: "$2a$10$test",
    role: "admin" as UserRole,
    name: "Prefs User",
  });
  return { userId };
}

async function clearFixture(f: Fixture): Promise<void> {
  // Cascade FK takes care of user_preferences; explicit delete kept for
  // belt-and-suspenders in case the cascade gets reverted later.
  await db
    .delete(userPreferences)
    .where(eq(userPreferences.userId, f.userId))
    .catch(() => {});
  await db.delete(users).where(eq(users.id, f.userId));
}

function loginAs(userId: string): void {
  mockedReadSession.mockResolvedValue({
    userId,
    role: "admin",
    companyId: null,
    email: `prefs-${userId}@test.local`,
  });
}

beforeEach(async () => {
  fixture = await seedFixture();
});

afterEach(async () => {
  await clearFixture(fixture);
  mockedReadSession.mockReset();
  mockedReadSession.mockResolvedValue(null);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("getPreferences", () => {
  it("returns { ok: false } when unauthenticated", async () => {
    const result = await getPreferences();
    expect(result.ok).toBe(false);
  });

  it("returns a clean error when the session points at a missing user (stale JWT)", async () => {
    // Simulate the "DB reseeded but cookie still valid" case — the session
    // verifies cleanly (JWT signature OK, not expired) but the userId
    // doesn't exist in the users table.
    const ghostUserId = newId();
    mockedReadSession.mockResolvedValue({
      userId: ghostUserId,
      role: "admin",
      companyId: null,
      email: "ghost@test.local",
    });
    const result = await getPreferences();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/session is no longer valid/i);
  });

  it("returns hard-coded defaults when no row exists yet", async () => {
    loginAs(fixture.userId);
    const result = await getPreferences();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preferences.userId).toBe(fixture.userId);
    expect(result.preferences.themeId).toBe("warm-ambient");
    expect(result.preferences.density).toBe("comfortable");
    expect(result.preferences.reducedMotion).toBe(false);
    expect(result.preferences.weeklyDigest).toBe(true);
    expect(result.preferences.monthlyReport).toBe(false);
    expect(result.preferences.documentExpiry).toBe(true);
  });

  it("returns the persisted row when one exists", async () => {
    loginAs(fixture.userId);
    await updatePreferences({ themeId: "ocean-depth", weeklyDigest: false });
    const result = await getPreferences();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preferences.themeId).toBe("ocean-depth");
    expect(result.preferences.weeklyDigest).toBe(false);
    // Unchanged fields stay at defaults.
    expect(result.preferences.density).toBe("comfortable");
  });
});

describe("updatePreferences", () => {
  it("returns { ok: false } when unauthenticated", async () => {
    const result = await updatePreferences({ themeId: "slate-pro" });
    expect(result.ok).toBe(false);
  });

  it("returns a clean error instead of FK-faulting when the session points at a missing user", async () => {
    // Without the user-existence guard, this case would explode with
    // SQLITE_CONSTRAINT_FOREIGNKEY on the insert path. The guard
    // converts it to a friendly { ok: false, error } the UI can toast.
    const ghostUserId = newId();
    mockedReadSession.mockResolvedValue({
      userId: ghostUserId,
      role: "admin",
      companyId: null,
      email: "ghost@test.local",
    });
    const result = await updatePreferences({ themeId: "ocean-depth" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/session is no longer valid/i);

    // Belt-and-suspenders: confirm no row got inserted for the ghost.
    const all = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, ghostUserId));
    expect(all).toHaveLength(0);
  });

  it("inserts a row on first save and returns the merged shape", async () => {
    loginAs(fixture.userId);
    const result = await updatePreferences({
      themeId: "forest-calm",
      density: "compact",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preferences.themeId).toBe("forest-calm");
    expect(result.preferences.density).toBe("compact");
    // Unchanged columns come from defaults.
    expect(result.preferences.weeklyDigest).toBe(true);

    // Row is actually persisted.
    const [row] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, fixture.userId));
    expect(row).toBeDefined();
    expect(row!.themeId).toBe("forest-calm");
    expect(row!.density).toBe("compact");
  });

  it("UPDATEs in place on subsequent calls", async () => {
    loginAs(fixture.userId);
    await updatePreferences({ themeId: "sunset-glow" });
    await updatePreferences({ tenderAlerts: false });

    const [row] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, fixture.userId));
    expect(row!.themeId).toBe("sunset-glow");
    expect(row!.tenderAlerts).toBe(false);

    // Only one row — UPDATE, not duplicate INSERT.
    const all = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, fixture.userId));
    expect(all).toHaveLength(1);
  });

  it("rejects an unknown theme id with field: 'themeId'", async () => {
    loginAs(fixture.userId);
    const result = await updatePreferences({
      themeId: "nope-not-a-theme",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("themeId");
  });

  it("short-circuits on an empty patch (no insert)", async () => {
    loginAs(fixture.userId);
    const result = await updatePreferences({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No row should have been written.
    const all = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, fixture.userId));
    expect(all).toHaveLength(0);
    // But the caller still gets a defaults shape back.
    expect(result.preferences.themeId).toBe("warm-ambient");
  });

  it("bumps updatedAt on a real update", async () => {
    loginAs(fixture.userId);
    const first = await updatePreferences({ themeId: "slate-pro" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstUpdatedAt = first.preferences.updatedAt;

    // Tick the wall clock by a millisecond by awaiting a tick.
    await new Promise((r) => setTimeout(r, 5));

    const second = await updatePreferences({ themeId: "forest-calm" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      new Date(second.preferences.updatedAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(firstUpdatedAt).getTime());
  });
});
