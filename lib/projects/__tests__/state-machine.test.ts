/**
 * Integration tests for the project state machine and Chunk-3 actions:
 *
 *   - transitionProjectStatus (admin/staff)
 *   - getProject (audit-history read; row scoping)
 *   - createProjectFromTender → project-detail-page round trip
 *   - projectExistsByTenderId (cheap existence check)
 *
 * Coverage emphasises the legal-transition matrix, terminal-state
 * refusals, RBAC gating, audit before/after capture, optional reason
 * metadata, and the full bridge round-trip.
 *
 * @module lib/projects/__tests__/state-machine
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
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  tenders,
  projects,
  users,
  auditLog,
  type UserRole,
  type TenderStatus,
  type ProjectStatus,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import {
  transitionProjectStatus,
  getProject,
  createProjectFromTender,
  projectExistsByTenderId,
} from "../actions";
import {
  isLegalProjectTransition,
  legalNextStatuses,
  hasAnyLegalTransition,
} from "../state-machine";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Pure state-machine unit tests (no DB) ────────────────────────────────

describe("state machine - isLegalProjectTransition", () => {
  it("planning → active is legal", () => {
    expect(isLegalProjectTransition("planning", "active")).toBe(true);
  });
  it("planning → cancelled is legal", () => {
    expect(isLegalProjectTransition("planning", "cancelled")).toBe(true);
  });
  it("planning → on_hold is illegal", () => {
    expect(isLegalProjectTransition("planning", "on_hold")).toBe(false);
  });
  it("planning → completed is illegal", () => {
    expect(isLegalProjectTransition("planning", "completed")).toBe(false);
  });
  it("active → on_hold / completed / cancelled all legal", () => {
    expect(isLegalProjectTransition("active", "on_hold")).toBe(true);
    expect(isLegalProjectTransition("active", "completed")).toBe(true);
    expect(isLegalProjectTransition("active", "cancelled")).toBe(true);
  });
  it("on_hold → active and cancelled legal; completed illegal", () => {
    expect(isLegalProjectTransition("on_hold", "active")).toBe(true);
    expect(isLegalProjectTransition("on_hold", "cancelled")).toBe(true);
    expect(isLegalProjectTransition("on_hold", "completed")).toBe(false);
  });
  it("completed is terminal", () => {
    const targets: ProjectStatus[] = [
      "planning",
      "active",
      "on_hold",
      "cancelled",
    ];
    for (const t of targets) {
      expect(isLegalProjectTransition("completed", t)).toBe(false);
    }
  });
  it("cancelled is terminal", () => {
    const targets: ProjectStatus[] = [
      "planning",
      "active",
      "on_hold",
      "completed",
    ];
    for (const t of targets) {
      expect(isLegalProjectTransition("cancelled", t)).toBe(false);
    }
  });
  it("legalNextStatuses surfaces the right set per status", () => {
    expect(new Set(legalNextStatuses("planning"))).toEqual(
      new Set<ProjectStatus>(["active", "cancelled"]),
    );
    expect(new Set(legalNextStatuses("active"))).toEqual(
      new Set<ProjectStatus>(["on_hold", "completed", "cancelled"]),
    );
    expect(legalNextStatuses("completed")).toEqual([]);
    expect(legalNextStatuses("cancelled")).toEqual([]);
  });
  it("hasAnyLegalTransition is true except for terminal states", () => {
    expect(hasAnyLegalTransition("planning")).toBe(true);
    expect(hasAnyLegalTransition("active")).toBe(true);
    expect(hasAnyLegalTransition("on_hold")).toBe(true);
    expect(hasAnyLegalTransition("completed")).toBe(false);
    expect(hasAnyLegalTransition("cancelled")).toBe(false);
  });
});

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyUserAId: string;
  publisherCompanyId: string;
  companyAId: string;
  companyBId: string;
  awardedTenderId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const publisherCompanyId = newId();
  const companyAId = newId();
  const companyBId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyUserAId = newId();
  const awardedTenderId = newId();

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
  ]);

  await db.insert(tenders).values({
    id: awardedTenderId,
    title: "Acme infrastructure pilot",
    description: "Pilot consulting engagement.",
    status: "awarded" satisfies TenderStatus,
    publisherCompanyId,
    sector: "Infrastructure",
    geography: "Maharashtra",
    publishedAt: new Date().toISOString(),
    awardedCompanyId: companyAId,
  });

  return {
    adminUserId,
    staffUserId,
    companyUserAId,
    publisherCompanyId,
    companyAId,
    companyBId,
    awardedTenderId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [f.adminUserId, f.staffUserId, f.companyUserAId]) {
    await db.delete(auditLog).where(eq(auditLog.actorId, userId)).catch(() => {});
  }
  await db.delete(projects).where(eq(projects.companyId, f.companyAId));
  await db.delete(projects).where(eq(projects.companyId, f.companyBId));
  await db.delete(projects).where(eq(projects.companyId, f.publisherCompanyId));
  await db
    .delete(tenders)
    .where(eq(tenders.publisherCompanyId, f.publisherCompanyId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
  await db.delete(companies).where(eq(companies.id, f.publisherCompanyId));
}

// ── Login helper ─────────────────────────────────────────────────────────

function loginAs(
  role: "admin" | "staff" | "companyA",
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
  }
}

/**
 * Insert a project at a specific starting status, bypassing the
 * `createProject` action so we can test transitions FROM arbitrary
 * starting points (createProject always forces `planning`).
 */
async function insertProjectAtStatus(
  f: Fixture,
  status: ProjectStatus,
  companyId = f.companyAId,
): Promise<string> {
  const id = newId();
  await db.insert(projects).values({
    id,
    name: `Test project (${status})`,
    companyId,
    status,
  });
  return id;
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── transitionProjectStatus ───────────────────────────────────────────────

describe("transitionProjectStatus - legal transitions", () => {
  it("planning → active succeeds", async () => {
    loginAs("staff", fixture);
    const projectId = await insertProjectAtStatus(fixture, "planning");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "active",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((r) => r[0]);
    expect(row?.status).toBe("active");
  });

  it("active → on_hold succeeds and captures before/after audit", async () => {
    loginAs("staff", fixture);
    const projectId = await insertProjectAtStatus(fixture, "active");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "on_hold",
    });
    expect(result.ok).toBe(true);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "project"),
          eq(auditLog.targetId, projectId),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1)
      .then((r) => r[0]);
    expect(audit?.action).toBe("updated");
    const before = audit?.before as Record<string, unknown>;
    const after = audit?.after as Record<string, unknown>;
    expect(before.status).toBe("active");
    expect(after.status).toBe("on_hold");
    const meta = audit?.metadata as { statusChange?: { from: string; to: string } };
    expect(meta.statusChange).toEqual({ from: "active", to: "on_hold" });
  });

  it("on_hold → active succeeds", async () => {
    loginAs("staff", fixture);
    const projectId = await insertProjectAtStatus(fixture, "on_hold");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "active",
    });
    expect(result.ok).toBe(true);
  });

  it("active → completed succeeds (terminal)", async () => {
    loginAs("staff", fixture);
    const projectId = await insertProjectAtStatus(fixture, "active");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "completed",
    });
    expect(result.ok).toBe(true);
  });

  it("planning → cancelled captures reason metadata when supplied", async () => {
    loginAs("admin", fixture);
    const projectId = await insertProjectAtStatus(fixture, "planning");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "cancelled",
      reason: "Client withdrew funding before kick-off",
    });
    expect(result.ok).toBe(true);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "project"),
          eq(auditLog.targetId, projectId),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(1)
      .then((r) => r[0]);
    const meta = audit?.metadata as { reason?: string };
    expect(meta.reason).toBe("Client withdrew funding before kick-off");
  });
});

describe("transitionProjectStatus - illegal transitions", () => {
  it("planning → completed refuses (must go through active)", async () => {
    loginAs("staff", fixture);
    const projectId = await insertProjectAtStatus(fixture, "planning");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "completed",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("toStatus");
    expect(result.error).toMatch(/active/);
  });

  it("planning → on_hold refuses (nothing to pause)", async () => {
    loginAs("staff", fixture);
    const projectId = await insertProjectAtStatus(fixture, "planning");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "on_hold",
    });
    expect(result.ok).toBe(false);
  });

  it("completed → anything refuses (terminal)", async () => {
    loginAs("staff", fixture);
    const projectId = await insertProjectAtStatus(fixture, "completed");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "active",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/final/i);
  });

  it("cancelled → anything refuses (terminal)", async () => {
    loginAs("staff", fixture);
    const projectId = await insertProjectAtStatus(fixture, "cancelled");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "planning",
    });
    expect(result.ok).toBe(false);
  });

  it("same status returns ok (idempotent no-op)", async () => {
    loginAs("staff", fixture);
    const projectId = await insertProjectAtStatus(fixture, "active");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "active",
    });
    expect(result.ok).toBe(true);
    // No audit row should have been written for the no-op
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "project"),
          eq(auditLog.targetId, projectId),
          eq(auditLog.action, "updated"),
        ),
      );
    expect(audit).toHaveLength(0);
  });
});

describe("transitionProjectStatus - RBAC", () => {
  it("refuses a company-role caller", async () => {
    loginAs("companyA", fixture);
    const projectId = await insertProjectAtStatus(fixture, "planning");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "active",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/permission/i);
  });

  it("refuses an unauthenticated caller", async () => {
    const projectId = await insertProjectAtStatus(fixture, "planning");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "active",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/signed in/i);
  });

  it("admin succeeds", async () => {
    loginAs("admin", fixture);
    const projectId = await insertProjectAtStatus(fixture, "planning");
    const result = await transitionProjectStatus({
      projectId,
      toStatus: "active",
    });
    expect(result.ok).toBe(true);
  });
});

// ── getProject row-scoping ───────────────────────────────────────────────

describe("getProject scoping", () => {
  it("companyA reads own project; foreign-company project returns not-found", async () => {
    const ownId = await insertProjectAtStatus(fixture, "active", fixture.companyAId);
    const foreignId = await insertProjectAtStatus(
      fixture,
      "active",
      fixture.companyBId,
    );

    loginAs("companyA", fixture);
    const own = await getProject(ownId);
    expect(own.ok).toBe(true);

    const foreign = await getProject(foreignId);
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error).toMatch(/not found/i);
  });
});

// ── createProjectFromTender + projectExistsByTenderId round-trip ─────────

describe("createProjectFromTender round-trip", () => {
  it("creates project, sets tenderId pointing back, audits metadata.fromTenderId", async () => {
    loginAs("staff", fixture);

    // Pre-condition: no project exists for this tender yet.
    const before = await projectExistsByTenderId(fixture.awardedTenderId);
    expect(before).toBeNull();

    const result = await createProjectFromTender({
      tenderId: fixture.awardedTenderId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Project row points back to the tender.
    const projectRow = await db
      .select()
      .from(projects)
      .where(eq(projects.id, result.projectId))
      .then((r) => r[0]);
    expect(projectRow?.tenderId).toBe(fixture.awardedTenderId);
    expect(projectRow?.companyId).toBe(fixture.companyAId);

    // Audit row carries the bridge metadata.
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
    const meta = audit?.metadata as { fromTenderId?: string };
    expect(meta.fromTenderId).toBe(fixture.awardedTenderId);

    // projectExistsByTenderId now reports the linkage.
    const after = await projectExistsByTenderId(fixture.awardedTenderId);
    expect(after?.projectId).toBe(result.projectId);
  });
});
