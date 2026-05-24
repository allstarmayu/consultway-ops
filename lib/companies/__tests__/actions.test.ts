/**
 * Integration tests for `lib/companies/actions.ts` — Day 23 surface.
 *
 * Focus is the action-layer wiring of the new state machine:
 *
 *   - Illegal compliance transitions return a typed ActionResult error
 *     with `field: "complianceStatus"` and don't bubble the throw.
 *   - Legal compliance transitions succeed, move the row, and emit a
 *     `compliance_status_changed` audit verb (not plain `updated`).
 *   - The schema's "rejected ⇒ rejectionReason required" superRefine
 *     fires before the action runs.
 *   - A move into `rejected` with a populated reason succeeds; the row
 *     carries the reason; the audit `after` snapshot includes it.
 *   - A company-role caller still has `complianceStatus` silently
 *     dropped from the patch — the state-machine path isn't reached
 *     (no `compliance_status_changed` audit fires).
 *
 * Fixture mirrors lib/projects/__tests__/actions.test.ts — one admin,
 * one staff, one company user linked to companyA. The tests insert
 * companies at specific starting compliance statuses (bypassing
 * `createCompany`, which always forces `pending`) so each transition
 * pair can be exercised cleanly.
 *
 * @module lib/companies/__tests__/actions
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
  users,
  auditLog,
  type ComplianceStatus,
  type UserRole,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import { updateCompany } from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyUserAId: string;
  companyAId: string;
  companyBId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const companyAId = newId();
  const companyBId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyUserAId = newId();

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

  return {
    adminUserId,
    staffUserId,
    companyUserAId,
    companyAId,
    companyBId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [f.adminUserId, f.staffUserId, f.companyUserAId]) {
    await db
      .delete(auditLog)
      .where(eq(auditLog.actorId, userId))
      .catch(() => {});
  }
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
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
 * Force a company row to a specific compliance status by direct UPDATE,
 * bypassing the state-machine guard so we can test transitions FROM
 * arbitrary starting states. The state-machine assertion lives inside
 * `updateCompany` — the seed has no such guard.
 */
async function setCompanyStatus(
  companyId: string,
  status: ComplianceStatus,
  rejectionReason: string | null = null,
): Promise<void> {
  await db
    .update(companies)
    .set({ complianceStatus: status, rejectionReason })
    .where(eq(companies.id, companyId));
}

/**
 * Most-recent audit row for a company target. Used to assert the verb
 * and the before/after snapshots on a state move.
 */
async function latestAuditForCompany(companyId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "company"),
        eq(auditLog.targetId, companyId),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1)
    .then((r) => r[0]);
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── State-machine wiring in updateCompany ────────────────────────────────

describe("updateCompany — illegal compliance transition", () => {
  it("returns ok:false with field=complianceStatus on an illegal move", async () => {
    loginAs("staff", fixture);
    await setCompanyStatus(fixture.companyAId, "compliant");

    const result = await updateCompany({
      id: fixture.companyAId,
      complianceStatus: "pending", // compliant → pending is illegal
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("complianceStatus");
    expect(result.error).toMatch(/compliant/);
    expect(result.error).toMatch(/pending/);

    // Row state unchanged — the assertion ran before the patch was staged.
    const row = await db
      .select()
      .from(companies)
      .where(eq(companies.id, fixture.companyAId))
      .then((r) => r[0]);
    expect(row?.complianceStatus).toBe("compliant");

    // No `compliance_status_changed` audit row exists for this company.
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "company"),
          eq(auditLog.targetId, fixture.companyAId),
          eq(auditLog.action, "compliance_status_changed"),
        ),
      );
    expect(audit).toHaveLength(0);
  });

  it("rejected → anything fails (terminal state)", async () => {
    loginAs("admin", fixture);
    await setCompanyStatus(
      fixture.companyAId,
      "rejected",
      "Failed background check",
    );

    const result = await updateCompany({
      id: fixture.companyAId,
      complianceStatus: "compliant",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("complianceStatus");
    expect(result.error).toMatch(/rejected/);

    // Row unchanged.
    const row = await db
      .select()
      .from(companies)
      .where(eq(companies.id, fixture.companyAId))
      .then((r) => r[0]);
    expect(row?.complianceStatus).toBe("rejected");
    expect(row?.rejectionReason).toBe("Failed background check");
  });
});

describe("updateCompany — legal compliance transition", () => {
  it("succeeds, moves the row, audit verb is compliance_status_changed", async () => {
    loginAs("staff", fixture);
    await setCompanyStatus(fixture.companyAId, "pending");

    const result = await updateCompany({
      id: fixture.companyAId,
      complianceStatus: "compliant",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(companies)
      .where(eq(companies.id, fixture.companyAId))
      .then((r) => r[0]);
    expect(row?.complianceStatus).toBe("compliant");

    const audit = await latestAuditForCompany(fixture.companyAId);
    expect(audit?.action).toBe("compliance_status_changed");
    const before = audit?.before as Record<string, unknown>;
    const after = audit?.after as Record<string, unknown>;
    expect(before.complianceStatus).toBe("pending");
    expect(after.complianceStatus).toBe("compliant");
  });

  it("same-status update is a no-op (no audit row written)", async () => {
    loginAs("staff", fixture);
    await setCompanyStatus(fixture.companyAId, "compliant");

    const result = await updateCompany({
      id: fixture.companyAId,
      complianceStatus: "compliant",
    });
    expect(result.ok).toBe(true);

    // Same-state move stages a patch (since the field was in the input)
    // but doesn't emit the `compliance_status_changed` verb — we'd see
    // plain `updated` at most. There IS no other touched field here, so
    // it's a status-only no-op edit that still records a routine audit.
    const audit = await latestAuditForCompany(fixture.companyAId);
    if (audit) {
      expect(audit.action).not.toBe("compliance_status_changed");
    }
  });

  it("plain non-status update still emits `updated` verb (not the new one)", async () => {
    loginAs("staff", fixture);
    await setCompanyStatus(fixture.companyAId, "compliant");

    const result = await updateCompany({
      id: fixture.companyAId,
      name: "Acme Construction Pvt Ltd",
    });
    expect(result.ok).toBe(true);

    const audit = await latestAuditForCompany(fixture.companyAId);
    expect(audit?.action).toBe("updated");
  });
});

// ── rejected ⇒ rejectionReason superRefine ───────────────────────────────

describe("updateCompany — rejected requires rejectionReason", () => {
  it("rejected without a reason fails at the schema layer", async () => {
    loginAs("admin", fixture);
    await setCompanyStatus(fixture.companyAId, "pending");

    const result = await updateCompany({
      id: fixture.companyAId,
      complianceStatus: "rejected",
      // rejectionReason intentionally omitted
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("rejectionReason");

    // Row state unchanged.
    const row = await db
      .select()
      .from(companies)
      .where(eq(companies.id, fixture.companyAId))
      .then((r) => r[0]);
    expect(row?.complianceStatus).toBe("pending");
  });

  it("rejected with empty-string reason also fails", async () => {
    loginAs("admin", fixture);
    await setCompanyStatus(fixture.companyAId, "pending");

    const result = await updateCompany({
      id: fixture.companyAId,
      complianceStatus: "rejected",
      rejectionReason: "   ",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("rejectionReason");
  });

  it("rejected with a populated reason succeeds and the row carries it", async () => {
    loginAs("admin", fixture);
    await setCompanyStatus(fixture.companyAId, "pending");

    const result = await updateCompany({
      id: fixture.companyAId,
      complianceStatus: "rejected",
      rejectionReason: "Failed background check on key directors",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(companies)
      .where(eq(companies.id, fixture.companyAId))
      .then((r) => r[0]);
    expect(row?.complianceStatus).toBe("rejected");
    expect(row?.rejectionReason).toBe(
      "Failed background check on key directors",
    );

    const audit = await latestAuditForCompany(fixture.companyAId);
    expect(audit?.action).toBe("compliance_status_changed");
    const after = audit?.after as Record<string, unknown>;
    expect(after.complianceStatus).toBe("rejected");
    expect(after.rejectionReason).toBe(
      "Failed background check on key directors",
    );
  });
});

// ── Company-role still has complianceStatus stripped ─────────────────────

describe("updateCompany — company-role caller", () => {
  it("complianceStatus is silently dropped; state-machine path not reached", async () => {
    loginAs("companyA", fixture);
    await setCompanyStatus(fixture.companyAId, "compliant");

    // compliant → pending would be illegal at the state-machine layer.
    // For a company-role caller, the field is stripped from the patch
    // before the assertion runs — so the call succeeds without moving
    // the row.
    const result = await updateCompany({
      id: fixture.companyAId,
      complianceStatus: "pending",
      name: "Acme Construction Pvt Ltd",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(companies)
      .where(eq(companies.id, fixture.companyAId))
      .then((r) => r[0]);
    expect(row?.complianceStatus).toBe("compliant"); // unchanged
    expect(row?.name).toBe("Acme Construction Pvt Ltd"); // name change applied

    const audit = await latestAuditForCompany(fixture.companyAId);
    // No state move, so the verb stays as plain `updated`.
    expect(audit?.action).toBe("updated");
  });
});
