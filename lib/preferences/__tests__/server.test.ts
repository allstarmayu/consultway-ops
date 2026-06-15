/**
 * Unit tests for `lib/preferences/server.ts::getPreferencesForSSR`.
 *
 * The SSR reader is the layout-side counterpart to `getPreferences()`
 * from the Server Action surface — it takes a userId the caller already
 * resolved, skips the session round-trip, and crucially never throws /
 * never returns null. These three cases cover the contract:
 *
 *   1. Happy path — a row exists; return the persisted row.
 *   2. Missing row — no preferences row for this user; return defaults.
 *   3. DB error — the SELECT throws; swallow + log + return defaults.
 *
 * Case 3 uses `vi.spyOn(db, "select")` to force a one-shot throw rather
 * than mocking the entire db module — keeps the happy + missing cases
 * exercising the real Drizzle query path against the test SQLite.
 *
 * No session mocking here — `getPreferencesForSSR` deliberately doesn't
 * touch `readSession` (that's the caller's job in the layout).
 *
 * @module lib/preferences/__tests__/server
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, userPreferences, type UserRole } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { getPreferencesForSSR } from "../server";

// The db client is a Proxy (lib/db/index.ts) that lazy-resolves the runtime
// adapter, so `vi.spyOn(db, "select")` can't replace its methods (Day-30).
// Instead, mock the module with a pass-through wrapper that throws from
// `select()` only when `mockState.forceError` is set — keeping the happy +
// missing-row tests on the real DB while still exercising the try/catch.
const { mockState } = vi.hoisted(() => ({ mockState: { forceError: false } }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const wrapped = new Proxy(actual.db, {
    get(target, prop, receiver) {
      if (prop === "select" && mockState.forceError) {
        return () => {
          throw new Error("forced db error (test)");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, db: wrapped };
});

// ── Fixture ────────────────────────────────────────────────────────────────

interface Fixture {
  userId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const userId = newId();
  await db.insert(users).values({
    id: userId,
    email: `prefs-ssr-${userId}@test.local`,
    passwordHash: "$2a$10$test",
    role: "admin" as UserRole,
    name: "SSR Prefs User",
  });
  return { userId };
}

async function clearFixture(f: Fixture): Promise<void> {
  // user_preferences cascades on user delete, but the explicit cleanup
  // mirrors the actions.test.ts pattern — belt-and-suspenders if the
  // cascade ever gets reverted.
  await db
    .delete(userPreferences)
    .where(eq(userPreferences.userId, f.userId))
    .catch(() => {});
  await db.delete(users).where(eq(users.id, f.userId));
}

beforeEach(async () => {
  fixture = await seedFixture();
});

afterEach(async () => {
  // Reset the forced-error flag BEFORE cleanup so clearFixture's db
  // calls run normally.
  mockState.forceError = false;
  await clearFixture(fixture);
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("getPreferencesForSSR", () => {
  it("returns hard-coded defaults when no row exists yet", async () => {
    const prefs = await getPreferencesForSSR(fixture.userId);
    expect(prefs.userId).toBe(fixture.userId);
    expect(prefs.themeId).toBe("warm-ambient");
    expect(prefs.density).toBe("comfortable");
    expect(prefs.reducedMotion).toBe(false);
    // Notification defaults too — the layout doesn't read these but the
    // shape contract is the same as the actions-layer defaults.
    expect(prefs.weeklyDigest).toBe(true);
    expect(prefs.monthlyReport).toBe(false);
    expect(prefs.documentExpiry).toBe(true);
    expect(prefs.tenderAlerts).toBe(true);
    expect(prefs.assignmentAlerts).toBe(true);
    expect(prefs.incidentAlerts).toBe(true);
  });

  it("returns the persisted row when one exists", async () => {
    // Seed a non-default row directly so the test doesn't depend on the
    // Server Action surface (this is the SSR-leaf reader's contract:
    // read whatever's in the column, don't synthesise).
    await db.insert(userPreferences).values({
      userId: fixture.userId,
      themeId: "ocean-depth",
      density: "compact",
      reducedMotion: true,
      weeklyDigest: false,
      monthlyReport: true,
      documentExpiry: false,
      tenderAlerts: false,
      assignmentAlerts: false,
      incidentAlerts: true,
    });

    const prefs = await getPreferencesForSSR(fixture.userId);
    expect(prefs.userId).toBe(fixture.userId);
    expect(prefs.themeId).toBe("ocean-depth");
    expect(prefs.density).toBe("compact");
    expect(prefs.reducedMotion).toBe(true);
    expect(prefs.weeklyDigest).toBe(false);
    expect(prefs.monthlyReport).toBe(true);
  });

  // Un-skipped Day-33: the module mock above lets us force `select()` to
  // throw without touching the real DB used by the two tests above. This
  // exercises the try/catch fallback in getPreferencesForSSR.
  it("returns defaults when the DB read throws (never propagates the error)", async () => {
    mockState.forceError = true;
    const prefs = await getPreferencesForSSR(fixture.userId);
    expect(prefs.userId).toBe(fixture.userId);
    expect(prefs.themeId).toBe("warm-ambient");
    expect(prefs.density).toBe("comfortable");
    expect(prefs.reducedMotion).toBe(false);
  });
});
