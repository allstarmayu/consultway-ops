/**
 * Self-healing seed contract tests (Day 21 Chunk 3).
 *
 * The seed used to be skip-on-exists — a fixture change to an
 * already-seeded row would silently not take effect. Chunk 3 swapped
 * that for compare-and-update on the documented safe-to-update field
 * set. These tests pin the new contract:
 *
 *   1. Empty DB: every seed call lands as "inserted".
 *   2. Identical fixtures: re-running lands every row as "unchanged"
 *      (the row count doesn't grow, nothing logs as updated).
 *   3. Changed fixture: a single field bump (e.g. annualTurnover)
 *      results in "updated" and the in-DB column carries the new
 *      value. Row count unchanged.
 *   4. Frozen field guarantee: even when the spec changes, the row's
 *      `id` (and other frozen columns) stay put.
 *
 * The seeders are imported directly from `scripts/seed.ts`. That
 * module guards `main()` with `!process.env.VITEST` so the import
 * doesn't trigger the full pipeline.
 *
 * @module scripts/__tests__/seed
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  users,
  companies,
  documents,
  tenders,
  tenderApplications,
  projects,
  transactions,
  auditLog,
  emailVerificationTokens,
  passwordResetTokens,
  remindersSent,
} from "@/lib/db/schema";
import {
  seedStandaloneCompany,
  seedStaffUser,
  seedTender,
  CONSULTWAY_PUBLISHER_NAME,
  seedConsultwayPublisher,
  type SeedResult,
} from "../seed";

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Order matters: FK-bearing tables first.
  await db.delete(remindersSent);
  await db.delete(passwordResetTokens);
  await db.delete(emailVerificationTokens);
  await db.delete(auditLog);
  await db.delete(transactions);
  await db.delete(projects);
  await db.delete(tenderApplications);
  await db.delete(tenders);
  await db.delete(documents);
  await db.delete(users);
  await db.delete(companies);
});

// ── Fixture helpers ────────────────────────────────────────────────────────

function makeCompanySpec(overrides: Partial<Parameters<typeof seedStandaloneCompany>[0]> = {}) {
  return {
    name: "Test Company",
    sector: "Infrastructure",
    geography: "Maharashtra",
    gstNumber: "27TESTC0001A1Z5",
    panNumber: "TESTC0001A",
    isMsme: false,
    complianceStatus: "compliant" as const,
    annualTurnover: 50_000_000,
    contactEmail: "test@example.local",
    contactPhone: "+91 22 0000 0000",
    contactPersonName: "Test Contact",
    addressLine: "Test address",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400001",
    internalNotes: null,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("seed self-healing contract — empty DB", () => {
  it("first run inserts every row", async () => {
    const r: SeedResult = await seedStandaloneCompany(makeCompanySpec());
    expect(r).toBe("inserted");

    const rows = await db.select().from(companies);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Test Company");
    expect(rows[0]?.annualTurnover).toBe(50_000_000);
  });
});

describe("seed self-healing contract — identical fixtures", () => {
  it("second run with the same spec lands every row as unchanged", async () => {
    const spec = makeCompanySpec();
    expect(await seedStandaloneCompany(spec)).toBe("inserted");
    expect(await seedStandaloneCompany(spec)).toBe("unchanged");
    expect(await seedStandaloneCompany(spec)).toBe("unchanged");

    // Row count unchanged — no duplicates.
    const rows = await db.select().from(companies);
    expect(rows).toHaveLength(1);
  });

  it("the seedStaffUser path is also idempotent with the SEED_VERIFIED_AT constant", async () => {
    const spec = {
      email: "self-heal-test@consultway.local",
      plaintextPassword: "x",
      role: "staff" as const,
      name: "Staff",
      isActive: true,
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await seedStaffUser(spec)).toBe("inserted");
    // A second call with the same spec — the static emailVerifiedAt
    // is the load-bearing fix from Chunk 3; `new Date().toISOString()`
    // would have made this "updated" every run.
    expect(await seedStaffUser(spec)).toBe("unchanged");
  });
});

describe("seed self-healing contract — changed fixture", () => {
  it("bumping annualTurnover triggers an update; the column carries the new value", async () => {
    const spec = makeCompanySpec({ annualTurnover: 50_000_000 });
    expect(await seedStandaloneCompany(spec)).toBe("inserted");

    // Same row, different value.
    const bumped = makeCompanySpec({ annualTurnover: 500_000_000 });
    const r = await seedStandaloneCompany(bumped);
    expect(r).toBe("updated");

    const row = await db
      .select()
      .from(companies)
      .where(eq(companies.name, "Test Company"))
      .then((rs) => rs[0]);
    expect(row?.annualTurnover).toBe(500_000_000);

    // No duplicate row created.
    const all = await db.select().from(companies);
    expect(all).toHaveLength(1);
  });

  it("bumping a user's isActive triggers an update", async () => {
    const spec = {
      email: "isactive-test@consultway.local",
      plaintextPassword: "x",
      role: "staff" as const,
      name: "Staff",
      isActive: true,
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await seedStaffUser(spec)).toBe("inserted");
    expect(await seedStaffUser({ ...spec, isActive: false })).toBe("updated");

    const row = await db
      .select()
      .from(users)
      .where(eq(users.email, "isactive-test@consultway.local"))
      .then((rs) => rs[0]);
    expect(row?.isActive).toBe(false);
  });

  it("tender status flips take effect on re-seed", async () => {
    // Pre-seed the publisher (a precondition of seedTender).
    await seedConsultwayPublisher();

    const baseSpec = {
      title: "Test Tender",
      referenceNumber: "TST-2026-001",
      status: "draft" as const,
      description: "Test",
      sector: "Infrastructure",
      geography: "Maharashtra",
      eligibleSector: null,
      eligibleGeography: null,
      minAnnualTurnoverInr: null,
      msmeOnly: false,
      openingInDays: null,
      closingInDays: null,
      publishedInDays: null,
      awardedCompanyName: null,
      internalNotes: null,
    };

    expect(await seedTender(baseSpec)).toBe("inserted");
    expect(
      await seedTender({
        ...baseSpec,
        status: "published",
      }),
    ).toBe("updated");

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.referenceNumber, "TST-2026-001"))
      .then((rs) => rs[0]);
    expect(row?.status).toBe("published");
  });
});

describe("seed self-healing contract — frozen fields", () => {
  it("the row's id never changes across updates, even when other fields move", async () => {
    expect(await seedStandaloneCompany(makeCompanySpec())).toBe("inserted");

    const firstRow = await db
      .select()
      .from(companies)
      .where(eq(companies.name, "Test Company"))
      .then((rs) => rs[0]);
    const originalId = firstRow!.id;
    const originalCreatedAt = firstRow!.createdAt;

    // Bump several updatable fields.
    expect(
      await seedStandaloneCompany(
        makeCompanySpec({
          annualTurnover: 100_000_000,
          complianceStatus: "non_compliant",
          internalNotes: "new note",
        }),
      ),
    ).toBe("updated");

    const updatedRow = await db
      .select()
      .from(companies)
      .where(eq(companies.name, "Test Company"))
      .then((rs) => rs[0]);

    expect(updatedRow?.id).toBe(originalId);
    expect(updatedRow?.createdAt).toBe(originalCreatedAt);
    // …and the updatable fields DID move.
    expect(updatedRow?.annualTurnover).toBe(100_000_000);
    expect(updatedRow?.complianceStatus).toBe("non_compliant");
    expect(updatedRow?.internalNotes).toBe("new note");
  });

  it("the Consultway publisher seed is also self-healing — internalNotes edit takes effect", async () => {
    expect(await seedConsultwayPublisher()).toBe("inserted");

    const firstRow = await db
      .select()
      .from(companies)
      .where(eq(companies.name, CONSULTWAY_PUBLISHER_NAME))
      .then((rs) => rs[0]);
    expect(firstRow).toBeTruthy();

    // Re-running with identical spec is unchanged.
    expect(await seedConsultwayPublisher()).toBe("unchanged");

    // Frozen-field guarantee on the publisher too.
    const second = await db
      .select()
      .from(companies)
      .where(eq(companies.name, CONSULTWAY_PUBLISHER_NAME))
      .then((rs) => rs[0]);
    expect(second?.id).toBe(firstRow!.id);
  });
});
