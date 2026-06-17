/**
 * Integration tests for `registerCompany` — the public, unauthenticated
 * registration path that creates a paired (company, user) row.
 *
 * Coverage:
 *   - Happy path: company + user inserted, both audit rows written
 *   - Duplicate email refusal (friendly error, `field: 'userEmail'`)
 *   - Duplicate GST refusal
 *   - Duplicate PAN refusal
 *   - Weak-password Zod refusal (too short, missing letter, missing number)
 *   - Missing acceptedTerms refusal
 *   - Password is bcrypt-hashed not stored plaintext
 *   - New user starts with `emailVerifiedAt: null` and `isActive: true`
 *     (the verification gate is the active barrier, not is_active)
 *   - userEmail defaults to contactEmail when blank
 *   - Invalid GST format refusal
 *
 * Uses the standard in-memory DB substrate (`vitest.setup.ts`). No
 * session mocking — registration is the one action that does NOT take
 * an auth session.
 *
 * @module lib/auth/__tests__/register
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, companies, auditLog, notifications } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { registerCompany } from "../actions";
import { SYSTEM_ACTOR_ID } from "@/lib/audit/log";

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a valid input. Tests override only the fields they care about,
 * keeping the noise per-test low.
 */
function makeInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    companyName: "Acme Construction",
    sector: "Infrastructure",
    geography: "Maharashtra",
    gstNumber: "22AAAAA0000A1Z5",
    panNumber: "AAAAA0000A",
    contactPersonName: "Jane Doe",
    contactPhone: "+919876543210",
    contactEmail: "ops@acme.example",
    userName: "Jane Doe",
    userEmail: "jane@acme.example",
    password: "secret-passw0rd",
    acceptedTerms: true,
    ...overrides,
  };
}

/**
 * Clean both tables before each test. The in-memory DB is shared across
 * tests within a worker — `vitest.setup.ts` migrates once per worker.
 */
beforeEach(async () => {
  await db.delete(notifications);
  await db.delete(auditLog);
  await db.delete(users);
  await db.delete(companies);
});

/** Seed a user with a given role + active flag; returns its id. */
async function seedUser(
  role: "admin" | "staff" | "company",
  isActive = true,
): Promise<string> {
  const id = newId();
  await db.insert(users).values({
    id,
    email: `${role}-${id}@test.local`,
    passwordHash: "$2a$10$test",
    role,
    name: `Test ${role}`,
    isActive,
  });
  return id;
}

describe("registerCompany happy path", () => {
  it("creates a company + user and writes both audit rows", async () => {
    const result = await registerCompany(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const companyRows = await db
      .select()
      .from(companies)
      .where(eq(companies.id, result.companyId));
    expect(companyRows).toHaveLength(1);
    expect(companyRows[0]?.name).toBe("Acme Construction");
    expect(companyRows[0]?.complianceStatus).toBe("pending");
    expect(companyRows[0]?.contactEmail).toBe("ops@acme.example");

    const userRows = await db
      .select()
      .from(users)
      .where(eq(users.id, result.userId));
    expect(userRows).toHaveLength(1);
    expect(userRows[0]?.email).toBe("jane@acme.example");
    expect(userRows[0]?.role).toBe("company");
    expect(userRows[0]?.companyId).toBe(result.companyId);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorId, SYSTEM_ACTOR_ID));
    const targets = auditRows.map((r) => r.targetType).sort();
    expect(targets).toEqual(["company", "user"]);
    // Every registration audit row is system-actored.
    expect(auditRows.every((r) => r.actorRole === "system")).toBe(true);
  });

  it("starts the user with emailVerifiedAt:null AND isActive:true", async () => {
    const result = await registerCompany(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db
      .select()
      .from(users)
      .where(eq(users.id, result.userId))
      .then((r) => r[0]);
    // Verification gate is the active barrier — not is_active, which is
    // reserved for staff-driven deactivation. Both states are deliberate.
    expect(row?.emailVerifiedAt).toBeNull();
    expect(row?.isActive).toBe(true);
  });

  it("stores a bcrypt hash, not the plaintext password", async () => {
    const plaintext = "secret-passw0rd";
    const result = await registerCompany(makeInput({ password: plaintext }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db
      .select()
      .from(users)
      .where(eq(users.id, result.userId))
      .then((r) => r[0]);
    expect(row?.passwordHash).toBeTruthy();
    expect(row?.passwordHash).not.toBe(plaintext);
    // bcrypt hashes start with $2a$ / $2b$ / $2y$.
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it("defaults userEmail to contactEmail when blank", async () => {
    const result = await registerCompany(
      makeInput({ userEmail: "", contactEmail: "shared@acme.example" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db
      .select()
      .from(users)
      .where(eq(users.id, result.userId))
      .then((r) => r[0]);
    expect(row?.email).toBe("shared@acme.example");
  });

  it("accepts null gstNumber and null panNumber", async () => {
    const result = await registerCompany(
      makeInput({ gstNumber: null, panNumber: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db
      .select()
      .from(companies)
      .where(eq(companies.id, result.companyId))
      .then((r) => r[0]);
    expect(row?.gstNumber).toBeNull();
    expect(row?.panNumber).toBeNull();
  });
});

describe("registerCompany duplicate refusal", () => {
  it("rejects a second registration with the same userEmail", async () => {
    const first = await registerCompany(makeInput());
    expect(first.ok).toBe(true);

    const second = await registerCompany(
      makeInput({
        gstNumber: "22BBBBB0000B1Z5",
        panNumber: "BBBBB0000B",
      }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.field).toBe("userEmail");
    expect(second.error).toMatch(/already exists/i);
  });

  it("rejects a duplicate gstNumber with the right field hint", async () => {
    const first = await registerCompany(makeInput());
    expect(first.ok).toBe(true);

    const second = await registerCompany(
      makeInput({
        userEmail: "other@acme.example",
        panNumber: "BBBBB0000B",
      }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.field).toBe("gstNumber");
    expect(second.error).toMatch(/gst/i);
  });

  it("rejects a duplicate panNumber with the right field hint", async () => {
    const first = await registerCompany(makeInput());
    expect(first.ok).toBe(true);

    const second = await registerCompany(
      makeInput({
        userEmail: "other@acme.example",
        gstNumber: "22BBBBB0000B1Z5",
      }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.field).toBe("panNumber");
    expect(second.error).toMatch(/pan/i);
  });
});

describe("registerCompany schema refusals", () => {
  it("refuses a password shorter than 10 chars", async () => {
    const result = await registerCompany(makeInput({ password: "short1A" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("password");
    expect(result.error).toMatch(/10 characters/i);
  });

  it("refuses a password without any letter", async () => {
    const result = await registerCompany(
      makeInput({ password: "1234567890" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("password");
    expect(result.error).toMatch(/letter/i);
  });

  it("refuses a password without any number", async () => {
    const result = await registerCompany(
      makeInput({ password: "letters-only" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("password");
    expect(result.error).toMatch(/number/i);
  });

  it("refuses missing acceptedTerms", async () => {
    const result = await registerCompany(
      makeInput({ acceptedTerms: false }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("acceptedTerms");
    expect(result.error).toMatch(/terms/i);
  });

  it("refuses a malformed GST number", async () => {
    const result = await registerCompany(
      makeInput({ gstNumber: "NOT-A-GSTIN" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("gstNumber");
  });

  it("refuses when both userEmail is blank AND contactEmail is invalid", async () => {
    const result = await registerCompany(
      makeInput({ userEmail: "", contactEmail: "not-an-email" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("contactEmail");
  });
});

describe("registerCompany → admin notification", () => {
  it("notifies active admins only (not staff, not inactive admins, not the registrant)", async () => {
    const activeAdminId = await seedUser("admin", true);
    const inactiveAdminId = await seedUser("admin", false);
    const staffId = await seedUser("staff", true);

    const result = await registerCompany(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const adminNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, activeAdminId));
    expect(adminNotifs).toHaveLength(1);
    expect(adminNotifs[0]?.type).toBe("company_registered");
    expect(adminNotifs[0]?.link).toBe(
      `/dashboard/companies/${result.companyId}`,
    );
    expect(adminNotifs[0]?.body).toMatch(/Acme Construction/);
    expect(adminNotifs[0]?.readAt).toBeNull();

    // Inactive admin, staff, and the freshly-created company user get nothing.
    const inactiveNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, inactiveAdminId));
    expect(inactiveNotifs).toHaveLength(0);

    const staffNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, staffId));
    expect(staffNotifs).toHaveLength(0);

    const registrantNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, result.userId));
    expect(registrantNotifs).toHaveLength(0);
  });

  it("is a no-op (still ok:true) when there are no active admins", async () => {
    await seedUser("admin", false); // inactive admin only
    await seedUser("staff", true);

    const result = await registerCompany(makeInput());
    expect(result.ok).toBe(true);

    const all = await db.select().from(notifications);
    expect(all).toHaveLength(0);
  });
});
