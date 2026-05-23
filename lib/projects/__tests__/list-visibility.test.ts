/**
 * Integration tests for `listProjects` — role-aware visibility,
 * scoped totals, and layered filters.
 *
 * Coverage:
 *   - admin / staff see every project regardless of owning company
 *   - company-role users see ONLY their own projects (the
 *     row-scope SQL clause). The `companyId` filter is silently
 *     dropped for them (a no-op overlap).
 *   - `total` matches the actual visible row count (no JS post-filter
 *     drift)
 *   - layered status + search filters compose with the visibility
 *     scope correctly
 *   - pagination respects the SQL-side count
 *   - `internalNotes` stripped on company-role reads
 *
 * Fixture layout (three companies, six projects):
 *
 *     companyA = Acme Construction
 *     companyB = BuildRight Engineers
 *     companyC = Coastal Solar
 *
 *     Projects seeded:
 *       - companyA: 2 (planning, active)
 *       - companyB: 1 (active)
 *       - companyC: 3 (planning, active, completed)
 *
 *     Visibility totals:
 *       - admin / staff       => 6
 *       - companyA viewer     => 2
 *       - companyB viewer     => 1
 *       - companyC viewer     => 3
 *
 * @module lib/projects/__tests__/list-visibility
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
import {
  companies,
  projects,
  users,
  auditLog,
  type UserRole,
  type ProjectStatus,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import { listProjects, listProjectsForExport } from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyUserAId: string;
  companyUserBId: string;
  companyUserCId: string;
  companyAId: string;
  companyBId: string;
  companyCId: string;
  // Project ids for targeted assertions
  acmePlanningId: string;
  acmeActiveId: string;
  buildActiveId: string;
  coastalPlanningId: string;
  coastalActiveId: string;
  coastalCompletedId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const companyAId = newId();
  const companyBId = newId();
  const companyCId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyUserAId = newId();
  const companyUserBId = newId();
  const companyUserCId = newId();

  await db.insert(companies).values([
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
    {
      id: companyCId,
      name: "Coastal Solar",
      sector: "Solar EPC",
      geography: "Gujarat",
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
    {
      id: companyUserCId,
      email: `coast-${companyUserCId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "company" as UserRole,
      companyId: companyCId,
      name: "Coast Contact",
    },
  ]);

  const acmePlanningId = newId();
  const acmeActiveId = newId();
  const buildActiveId = newId();
  const coastalPlanningId = newId();
  const coastalActiveId = newId();
  const coastalCompletedId = newId();

  await db.insert(projects).values([
    {
      id: acmePlanningId,
      name: "Acme Pune fly-over",
      companyId: companyAId,
      status: "planning" satisfies ProjectStatus,
      internalNotes: "Acme planning - staff secret",
    },
    {
      id: acmeActiveId,
      name: "Acme Mumbai metro spur",
      companyId: companyAId,
      status: "active" satisfies ProjectStatus,
    },
    {
      id: buildActiveId,
      name: "BuildRight Bangalore signals",
      companyId: companyBId,
      status: "active" satisfies ProjectStatus,
    },
    {
      id: coastalPlanningId,
      name: "Coastal Surat solar farm",
      companyId: companyCId,
      status: "planning" satisfies ProjectStatus,
    },
    {
      id: coastalActiveId,
      name: "Coastal Bhuj rooftop",
      companyId: companyCId,
      status: "active" satisfies ProjectStatus,
    },
    {
      id: coastalCompletedId,
      name: "Coastal Vadodara pilot",
      companyId: companyCId,
      status: "completed" satisfies ProjectStatus,
    },
  ]);

  return {
    adminUserId,
    staffUserId,
    companyUserAId,
    companyUserBId,
    companyUserCId,
    companyAId,
    companyBId,
    companyCId,
    acmePlanningId,
    acmeActiveId,
    buildActiveId,
    coastalPlanningId,
    coastalActiveId,
    coastalCompletedId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [
    f.adminUserId,
    f.staffUserId,
    f.companyUserAId,
    f.companyUserBId,
    f.companyUserCId,
  ]) {
    await db.delete(auditLog).where(eq(auditLog.actorId, userId)).catch(() => {});
  }
  await db.delete(projects).where(eq(projects.companyId, f.companyAId));
  await db.delete(projects).where(eq(projects.companyId, f.companyBId));
  await db.delete(projects).where(eq(projects.companyId, f.companyCId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(users).where(eq(users.id, f.companyUserBId));
  await db.delete(users).where(eq(users.id, f.companyUserCId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
  await db.delete(companies).where(eq(companies.id, f.companyCId));
}

// ── Login helper ─────────────────────────────────────────────────────────

function loginAs(
  role: "admin" | "staff" | "companyA" | "companyB" | "companyC",
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
    case "companyC":
      mockedReadSession.mockResolvedValue({
        userId: f.companyUserCId,
        role: "company",
        companyId: f.companyCId,
        email: "coast@test.local",
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe("listProjects visibility - admin / staff", () => {
  it("admin sees all six projects across companies", async () => {
    loginAs("admin", fixture);
    const result = await listProjects({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(6);
    expect(result.rows).toHaveLength(6);
  });

  it("staff sees all six projects across companies", async () => {
    loginAs("staff", fixture);
    const result = await listProjects({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(6);
    expect(result.rows).toHaveLength(6);
  });

  it("admin filtering by companyId narrows the result", async () => {
    loginAs("admin", fixture);
    const result = await listProjects({
      companyId: fixture.companyCId,
      perPage: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.companyId === fixture.companyCId)).toBe(true);
  });
});

describe("listProjects visibility - company role", () => {
  it("companyA sees only their two projects", async () => {
    loginAs("companyA", fixture);
    const result = await listProjects({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.companyId === fixture.companyAId)).toBe(
      true,
    );
  });

  it("companyB sees only their one project", async () => {
    loginAs("companyB", fixture);
    const result = await listProjects({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe(fixture.buildActiveId);
  });

  it("companyC sees their three projects across statuses", async () => {
    loginAs("companyC", fixture);
    const result = await listProjects({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(3);
  });

  it("companyA cannot peek into companyB by passing a foreign companyId", async () => {
    loginAs("companyA", fixture);
    // The action silently drops `companyId` from company-role queries.
    // The result still reflects companyA's scope, not the attempted
    // override.
    const result = await listProjects({
      companyId: fixture.companyBId,
      perPage: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(2);
    expect(result.rows.every((r) => r.companyId === fixture.companyAId)).toBe(
      true,
    );
  });

  it("strips internalNotes for company-role callers", async () => {
    loginAs("companyA", fixture);
    const result = await listProjects({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const planningRow = result.rows.find(
      (r) => r.id === fixture.acmePlanningId,
    );
    expect(planningRow?.internalNotes).toBeNull();
  });
});

describe("listProjects layered filters", () => {
  it("companyC + status=planning returns one row", async () => {
    loginAs("companyC", fixture);
    const result = await listProjects({
      status: "planning",
      perPage: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe(fixture.coastalPlanningId);
  });

  it("admin + status=active across all companies returns three rows", async () => {
    loginAs("admin", fixture);
    const result = await listProjects({ status: "active", perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(3);
  });

  it("admin + companyId + status compose correctly", async () => {
    loginAs("admin", fixture);
    const result = await listProjects({
      companyId: fixture.companyCId,
      status: "active",
      perPage: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe(fixture.coastalActiveId);
  });

  it("search filters by name LIKE and respects scope", async () => {
    loginAs("admin", fixture);
    // "Coastal" is in the name of all three Coastal Solar projects.
    const result = await listProjects({ search: "Coastal", perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(3);
  });

  it("search composes with the company-role scope", async () => {
    loginAs("companyA", fixture);
    // The search would match a Coastal name but companyA is scoped
    // out of Coastal's rows entirely — total is zero.
    const result = await listProjects({ search: "Coastal", perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });
});

describe("listProjects pagination", () => {
  it("page 1 of 2 with perPage=2 returns first two rows + correct total", async () => {
    loginAs("admin", fixture);
    const result = await listProjects({
      page: 1,
      perPage: 2,
      sortBy: "createdAt",
      sortDir: "asc",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(6);
    expect(result.rows).toHaveLength(2);
  });

  it("pagination respects the SQL-side count for company-role too", async () => {
    loginAs("companyC", fixture);
    const result = await listProjects({
      page: 1,
      perPage: 2,
      sortBy: "createdAt",
      sortDir: "asc",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(2);
  });
});

// ── Day 20 — export-only perPage ceiling ──────────────────────────────────

describe("listProjectsForExport — perPage cap", () => {
  it("accepts perPage=1000 (the export route's cap)", async () => {
    loginAs("admin", fixture);
    const result = await listProjectsForExport({ perPage: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.perPage).toBe(1000);
    expect(result.rows.length).toBe(6);
  });

  it("the table-facing listProjects still refuses perPage=1000", async () => {
    loginAs("admin", fixture);
    const result = await listProjects({ perPage: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("perPage");
  });
});
