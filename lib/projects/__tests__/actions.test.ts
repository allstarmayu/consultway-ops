/**
 * Integration tests for `lib/projects/actions.ts` — Chunk 1 surface.
 *
 * Covers:
 *   - createProject happy path + RBAC + invalid companyId + date guard
 *   - createProjectFromTender happy path + status gate + missing-winner
 *   - updateProject admin/staff happy path + cross-field date guard
 *   - updateProject company-role: description-only + dropped fields
 *     + cross-company refusal (leak-safe "not found")
 *   - getProject role-scoping + internalNotes strip
 *   - audit-row shape on each mutation
 *
 * Fixture mirrors the other tenders test files — one Consultway
 * publisher, two real companies, one admin / one staff / two company
 * users.
 *
 * @module lib/projects/__tests__/actions
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
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  tenders,
  projects,
  users,
  auditLog,
  type UserRole,
  type TenderStatus,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import {
  createProject,
  createProjectFromTender,
  updateProject,
  getProject,
} from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyUserAId: string;
  companyUserBId: string;
  publisherCompanyId: string;
  companyAId: string;
  companyBId: string;
  awardedTenderId: string;
  closedTenderId: string;
  awardedWithoutWinnerTenderId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const publisherCompanyId = newId();
  const companyAId = newId();
  const companyBId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyUserAId = newId();
  const companyUserBId = newId();
  const awardedTenderId = newId();
  const closedTenderId = newId();
  const awardedWithoutWinnerTenderId = newId();

  await db.insert(companies).values([
    {
      id: publisherCompanyId,
      name: "Consultway Infotech",
      sector: "Consulting",
      geography: "Maharashtra",
    },
    {
      id: companyAId,
      name: "Acme Construction",
      sector: "Infrastructure",
      geography: "Maharashtra",
    },
    {
      id: companyBId,
      name: "BuildRight Engineers",
      sector: "Civil Works",
      geography: "Karnataka",
    },
  ]);

  await db.insert(users).values([
    {
      id: adminUserId,
      email: `admin-${adminUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "admin" as UserRole,
      name: "Admin",
    },
    {
      id: staffUserId,
      email: `staff-${staffUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "staff" as UserRole,
      name: "Staff",
    },
    {
      id: companyUserAId,
      email: `acme-${companyUserAId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "company" as UserRole,
      companyId: companyAId,
      name: "Acme Contact",
    },
    {
      id: companyUserBId,
      email: `build-${companyUserBId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "company" as UserRole,
      companyId: companyBId,
      name: "Build Contact",
    },
  ]);

  // Three test tenders — one fully-awarded (good for the bridge happy
  // path), one closed (refused by the bridge), one in `awarded` status
  // but with NULL awardedCompanyId (a defensive-test case).
  await db.insert(tenders).values([
    {
      id: awardedTenderId,
      title: "Acme infrastructure pilot",
      description: "Roll out a small Infra pilot in MH.",
      status: "awarded" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt: new Date().toISOString(),
      awardedCompanyId: companyAId,
    },
    {
      id: closedTenderId,
      title: "Closed roads tender",
      description: "Pavement repair.",
      status: "closed" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Roads & Highways",
      geography: "Maharashtra",
      publishedAt: new Date().toISOString(),
    },
    {
      id: awardedWithoutWinnerTenderId,
      title: "Broken awarded tender",
      description: "Hand-corrupted: awarded but no winner.",
      status: "awarded" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt: new Date().toISOString(),
      // awardedCompanyId omitted - simulates a corrupted row.
    },
  ]);

  return {
    adminUserId,
    staffUserId,
    companyUserAId,
    companyUserBId,
    publisherCompanyId,
    companyAId,
    companyBId,
    awardedTenderId,
    closedTenderId,
    awardedWithoutWinnerTenderId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [
    f.adminUserId,
    f.staffUserId,
    f.companyUserAId,
    f.companyUserBId,
  ]) {
    await db.delete(auditLog).where(eq(auditLog.actorId, userId)).catch(() => {});
  }
  // Projects first - they reference both companies and tenders.
  await db
    .delete(projects)
    .where(eq(projects.companyId, f.companyAId))
    .catch(() => {});
  await db
    .delete(projects)
    .where(eq(projects.companyId, f.companyBId))
    .catch(() => {});
  await db
    .delete(projects)
    .where(eq(projects.companyId, f.publisherCompanyId))
    .catch(() => {});

  await db
    .delete(tenders)
    .where(eq(tenders.publisherCompanyId, f.publisherCompanyId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(users).where(eq(users.id, f.companyUserBId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
  await db.delete(companies).where(eq(companies.id, f.publisherCompanyId));
}

// ── Login helper ─────────────────────────────────────────────────────────

function loginAs(
  role: "admin" | "staff" | "companyA" | "companyB",
  f: Fixture,
): void {
  switch (role) {
    case "admin":
      mockedReadSession.mockResolvedValue({
        userId: f.adminUserId,
        role: "admin",
        companyId: null,
        email: "admin@test.local",
      });
      return;
    case "staff":
      mockedReadSession.mockResolvedValue({
        userId: f.staffUserId,
        role: "staff",
        companyId: null,
        email: "staff@test.local",
      });
      return;
    case "companyA":
      mockedReadSession.mockResolvedValue({
        userId: f.companyUserAId,
        role: "company",
        companyId: f.companyAId,
        email: "acme@test.local",
      });
      return;
    case "companyB":
      mockedReadSession.mockResolvedValue({
        userId: f.companyUserBId,
        role: "company",
        companyId: f.companyBId,
        email: "build@test.local",
      });
      return;
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── createProject ────────────────────────────────────────────────────────

describe("createProject", () => {
  it("admin succeeds, inserts the row, writes a created audit event", async () => {
    loginAs("admin", fixture);

    const result = await createProject({
      companyId: fixture.companyAId,
      name: "Pune fly-over phase 2",
      description: "Phase 2 of the Pune fly-over consulting engagement.",
      startDate: "2026-06-01",
      endDate: "2026-12-31",
      budgetInr: 50_000_000,
      internalNotes: "Watch the monsoon delay risk.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

    const row = await db
      .select()
      .from(projects)
      .where(eq(projects.id, result.id))
      .then((r) => r[0]);
    expect(row).toBeDefined();
    expect(row?.name).toBe("Pune fly-over phase 2");
    // Status is FORCED to planning regardless of input.
    expect(row?.status).toBe("planning");
    expect(row?.companyId).toBe(fixture.companyAId);
    expect(row?.tenderId).toBeNull();
    expect(row?.startDate).toBe("2026-06-01");
    expect(row?.endDate).toBe("2026-12-31");
    expect(row?.budgetInr).toBe(50_000_000);
    expect(row?.internalNotes).toBe("Watch the monsoon delay risk.");

    // Audit row
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.targetType, "project"), eq(auditLog.targetId, result.id)),
      )
      .then((r) => r[0]);
    expect(audit).toBeDefined();
    expect(audit?.action).toBe("created");
    expect(audit?.actorId).toBe(fixture.adminUserId);
    expect(audit?.actorRole).toBe("admin");
  });

  it("staff succeeds (same allow-list as admin)", async () => {
    loginAs("staff", fixture);
    const result = await createProject({
      companyId: fixture.companyBId,
      name: "BuildRight metro spur",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a company-role caller", async () => {
    loginAs("companyA", fixture);
    const result = await createProject({
      companyId: fixture.companyAId,
      name: "Self-create attempt",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/permission/i);
  });

  it("refuses when companyId points to no company (friendly error)", async () => {
    loginAs("admin", fixture);
    const result = await createProject({
      companyId: newId(), // random uuid, no row exists
      name: "Phantom project",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("companyId");
    expect(result.error).toMatch(/not found/i);
  });

  it("refuses when startDate > endDate (cross-field guard)", async () => {
    loginAs("admin", fixture);
    const result = await createProject({
      companyId: fixture.companyAId,
      name: "Time-travelling project",
      startDate: "2026-12-31",
      endDate: "2026-06-01",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("endDate");
    expect(result.error).toMatch(/on or after the start/i);
  });

  it("refuses unauthenticated caller", async () => {
    // mockedReadSession returns null by default
    const result = await createProject({
      companyId: fixture.companyAId,
      name: "Anonymous attempt",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/signed in/i);
  });
});

// ── createProjectFromTender ───────────────────────────────────────────────

describe("createProjectFromTender", () => {
  it("happy path: populates fields from the tender + writes metadata.fromTenderId", async () => {
    loginAs("staff", fixture);

    const result = await createProjectFromTender({
      tenderId: fixture.awardedTenderId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projectId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await db
      .select()
      .from(projects)
      .where(eq(projects.id, result.projectId))
      .then((r) => r[0]);
    expect(row?.name).toBe("Acme infrastructure pilot");
    expect(row?.description).toBe("Roll out a small Infra pilot in MH.");
    expect(row?.tenderId).toBe(fixture.awardedTenderId);
    expect(row?.companyId).toBe(fixture.companyAId);
    expect(row?.status).toBe("planning");

    // Audit metadata carries the bridge discriminator
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "project"),
          eq(auditLog.targetId, result.projectId),
        ),
      )
      .then((r) => r[0]);
    expect(audit).toBeDefined();
    expect(audit?.action).toBe("created");
    const meta = audit?.metadata as { fromTenderId?: string } | null;
    expect(meta?.fromTenderId).toBe(fixture.awardedTenderId);
  });

  it("refuses when the tender is not in awarded status", async () => {
    loginAs("staff", fixture);
    const result = await createProjectFromTender({
      tenderId: fixture.closedTenderId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/awarded/);
    expect(result.error).toMatch(/closed/);
  });

  it("refuses awarded tender with no awardedCompanyId (defensive)", async () => {
    loginAs("staff", fixture);
    const result = await createProjectFromTender({
      tenderId: fixture.awardedWithoutWinnerTenderId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no awarded company/i);
  });

  it("refuses a company-role caller", async () => {
    loginAs("companyA", fixture);
    const result = await createProjectFromTender({
      tenderId: fixture.awardedTenderId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/permission/i);
  });

  it("refuses unknown tender id", async () => {
    loginAs("staff", fixture);
    const result = await createProjectFromTender({ tenderId: newId() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/i);
  });
});

// ── updateProject ────────────────────────────────────────────────────────

describe("updateProject — admin/staff", () => {
  it("admin patches name + budget + writes before/after audit", async () => {
    loginAs("admin", fixture);
    const created = await createProject({
      companyId: fixture.companyAId,
      name: "Initial name",
      budgetInr: 1_000_000,
    });
    if (!created.ok) throw new Error("setup failed");

    const result = await updateProject({
      id: created.id,
      name: "Renamed project",
      budgetInr: 2_500_000,
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(projects)
      .where(eq(projects.id, created.id))
      .then((r) => r[0]);
    expect(row?.name).toBe("Renamed project");
    expect(row?.budgetInr).toBe(2_500_000);

    // Audit row for the update specifically (most recent on this target)
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "project"),
          eq(auditLog.targetId, created.id),
          eq(auditLog.action, "updated"),
        ),
      )
      .then((r) => r[0]);
    expect(audit).toBeDefined();
    const before = audit?.before as Record<string, unknown>;
    const after = audit?.after as Record<string, unknown>;
    expect(before.name).toBe("Initial name");
    expect(before.budgetInr).toBe(1_000_000);
    expect(after.name).toBe("Renamed project");
    expect(after.budgetInr).toBe(2_500_000);
  });

  it("refuses when merged dates violate startDate ≤ endDate", async () => {
    loginAs("admin", fixture);
    const created = await createProject({
      companyId: fixture.companyAId,
      name: "Date guard project",
      startDate: "2026-06-01",
      endDate: "2026-12-31",
    });
    if (!created.ok) throw new Error("setup failed");

    // Patch ONLY startDate to something after the existing endDate.
    // Schema sees just startDate (no conflict); merged row state
    // catches it.
    const result = await updateProject({
      id: created.id,
      startDate: "2027-01-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("endDate");
  });

  it("no-op patch returns ok without DB write", async () => {
    loginAs("admin", fixture);
    const created = await createProject({
      companyId: fixture.companyAId,
      name: "No-op project",
    });
    if (!created.ok) throw new Error("setup failed");

    const before = await db
      .select()
      .from(projects)
      .where(eq(projects.id, created.id))
      .then((r) => r[0]);

    const result = await updateProject({ id: created.id });
    expect(result.ok).toBe(true);

    const after = await db
      .select()
      .from(projects)
      .where(eq(projects.id, created.id))
      .then((r) => r[0]);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });
});

describe("updateProject — company role", () => {
  it("company can patch own project's description", async () => {
    // Set up: admin creates an Acme project, then companyA patches its
    // description.
    loginAs("admin", fixture);
    const created = await createProject({
      companyId: fixture.companyAId,
      name: "Pilot project",
      description: "Original description.",
    });
    if (!created.ok) throw new Error("setup failed");

    loginAs("companyA", fixture);
    const result = await updateProject({
      id: created.id,
      description: "Updated by the company itself.",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(projects)
      .where(eq(projects.id, created.id))
      .then((r) => r[0]);
    expect(row?.description).toBe("Updated by the company itself.");
  });

  it("company-role patch of staff-only fields silently drops them", async () => {
    loginAs("admin", fixture);
    const created = await createProject({
      companyId: fixture.companyAId,
      name: "Original name",
      budgetInr: 1_000_000,
      internalNotes: "Original staff notes",
    });
    if (!created.ok) throw new Error("setup failed");

    loginAs("companyA", fixture);
    // Patch sends both an allowed field (description) AND staff-only
    // fields (name, budgetInr, internalNotes). The action accepts the
    // description and drops the rest.
    const result = await updateProject({
      id: created.id,
      description: "I edited my description",
      name: "I tried to rename",
      budgetInr: 999_999_999,
      internalNotes: "I tried to write into staff notes",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(projects)
      .where(eq(projects.id, created.id))
      .then((r) => r[0]);
    expect(row?.description).toBe("I edited my description");
    expect(row?.name).toBe("Original name");
    expect(row?.budgetInr).toBe(1_000_000);
    expect(row?.internalNotes).toBe("Original staff notes");
  });

  it("refuses company-role patch of someone else's project (leak-safe)", async () => {
    loginAs("admin", fixture);
    const created = await createProject({
      companyId: fixture.companyAId,
      name: "Acme project",
    });
    if (!created.ok) throw new Error("setup failed");

    loginAs("companyB", fixture);
    const result = await updateProject({
      id: created.id,
      description: "BuildRight trying to edit Acme's project",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Returns "not found" not "forbidden" — don't leak existence.
    expect(result.error).toMatch(/not found/i);
  });
});

// ── getProject — internalNotes strip on company-role ─────────────────────

describe("getProject", () => {
  it("strips internalNotes for the company-role caller on their own project", async () => {
    loginAs("admin", fixture);
    const created = await createProject({
      companyId: fixture.companyAId,
      name: "Notes-bearing project",
      internalNotes: "STAFF SECRET",
    });
    if (!created.ok) throw new Error("setup failed");

    // Admin sees them
    const adminRead = await getProject(created.id);
    expect(adminRead.ok).toBe(true);
    if (!adminRead.ok) return;
    expect(adminRead.project.internalNotes).toBe("STAFF SECRET");

    // Company-role read of OWN project hides them
    loginAs("companyA", fixture);
    const companyRead = await getProject(created.id);
    expect(companyRead.ok).toBe(true);
    if (!companyRead.ok) return;
    expect(companyRead.project.internalNotes).toBeNull();
  });

  it("refuses company-role read of someone else's project (leak-safe)", async () => {
    loginAs("admin", fixture);
    const created = await createProject({
      companyId: fixture.companyAId,
      name: "Acme project",
    });
    if (!created.ok) throw new Error("setup failed");

    loginAs("companyB", fixture);
    const result = await getProject(created.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/i);
  });
});
