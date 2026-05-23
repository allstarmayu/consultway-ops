/**
 * Integration tests for `lib/transactions/actions.ts` — Chunk 1 surface.
 *
 * Covers:
 *   - createTransaction happy path (with + without project)
 *   - createTransaction refuses unknown companyId / projectId
 *   - createTransaction cross-FK invariant refusal
 *   - createTransaction RBAC (admin only — staff + company + anon all refused)
 *   - createTransaction Zod refusals (negative amount, non-INR currency)
 *   - updateTransaction happy path + cross-FK invariant on patched projectId
 *   - deleteTransaction happy path + full pre-deletion snapshot in audit
 *   - getTransaction admin sees row + refuses non-admin
 *   - listTransactions filters + RBAC
 *
 * Fixture mirrors the projects test files — one Consultway publisher,
 * two real companies (Acme, BuildRight), one project per company, one
 * admin + one staff + two company users.
 *
 * @module lib/transactions/__tests__/actions
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
  projects,
  transactions,
  users,
  auditLog,
  type UserRole,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import {
  createTransaction,
  updateTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
} from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyUserAId: string;
  publisherCompanyId: string;
  companyAId: string;
  companyBId: string;
  /** Project owned by companyA. */
  projectAId: string;
  /** Project owned by companyB — used to assert cross-FK invariant. */
  projectBId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const publisherCompanyId = newId();
  const companyAId = newId();
  const companyBId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyUserAId = newId();
  const projectAId = newId();
  const projectBId = newId();

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

  await db.insert(projects).values([
    {
      id: projectAId,
      name: "Acme pilot",
      companyId: companyAId,
      status: "active",
    },
    {
      id: projectBId,
      name: "BuildRight metro spur",
      companyId: companyBId,
      status: "active",
    },
  ]);

  return {
    adminUserId,
    staffUserId,
    companyUserAId,
    publisherCompanyId,
    companyAId,
    companyBId,
    projectAId,
    projectBId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [f.adminUserId, f.staffUserId, f.companyUserAId]) {
    await db
      .delete(auditLog)
      .where(eq(auditLog.actorId, userId))
      .catch(() => {});
  }
  // Transactions first — they reference companies and projects.
  await db
    .delete(transactions)
    .where(eq(transactions.companyId, f.companyAId))
    .catch(() => {});
  await db
    .delete(transactions)
    .where(eq(transactions.companyId, f.companyBId))
    .catch(() => {});

  await db.delete(projects).where(eq(projects.id, f.projectAId));
  await db.delete(projects).where(eq(projects.id, f.projectBId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
  await db.delete(companies).where(eq(companies.id, f.publisherCompanyId));
}

// ── Login helper ──────────────────────────────────────────────────────────

function loginAs(role: "admin" | "staff" | "companyA", f: Fixture): void {
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

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── createTransaction ─────────────────────────────────────────────────────

describe("createTransaction", () => {
  it("admin succeeds with a project link, inserts the row, writes an audit event", async () => {
    loginAs("admin", fixture);

    const result = await createTransaction({
      type: "payment",
      amountPaise: 50_000_00, // ₹50,000
      currency: "INR",
      companyId: fixture.companyAId,
      projectId: fixture.projectAId,
      occurredOn: "2026-05-15",
      referenceNumber: "RCPT-2026-001",
      notes: "Q2 milestone payment",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

    const row = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, result.id))
      .then((r) => r[0]);
    expect(row).toBeDefined();
    expect(row?.type).toBe("payment");
    expect(row?.amountPaise).toBe(50_000_00);
    expect(row?.currency).toBe("INR");
    expect(row?.companyId).toBe(fixture.companyAId);
    expect(row?.projectId).toBe(fixture.projectAId);
    expect(row?.occurredOn).toBe("2026-05-15");
    expect(row?.referenceNumber).toBe("RCPT-2026-001");

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "transaction"),
          eq(auditLog.targetId, result.id),
        ),
      )
      .then((r) => r[0]);
    expect(audit).toBeDefined();
    expect(audit?.action).toBe("created");
    expect(audit?.actorId).toBe(fixture.adminUserId);
    expect(audit?.actorRole).toBe("admin");
    const meta = audit?.metadata as Record<string, unknown>;
    expect(meta.type).toBe("payment");
    expect(meta.amountPaise).toBe(50_000_00);
    expect(meta.companyId).toBe(fixture.companyAId);
    expect(meta.projectId).toBe(fixture.projectAId);
  });

  it("admin succeeds without a project (company-level expense)", async () => {
    loginAs("admin", fixture);

    const result = await createTransaction({
      type: "expense",
      amountPaise: 12_500_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-05-10",
      notes: "Office rent — May",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, result.id))
      .then((r) => r[0]);
    expect(row?.projectId).toBeNull();
    expect(row?.type).toBe("expense");
    // Currency defaults to INR.
    expect(row?.currency).toBe("INR");
  });

  it("refuses when companyId points to no company (friendly error)", async () => {
    loginAs("admin", fixture);
    const result = await createTransaction({
      type: "invoice",
      amountPaise: 1_000_00,
      companyId: newId(),
      occurredOn: "2026-05-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("companyId");
    expect(result.error).toMatch(/not found/i);
  });

  it("refuses when projectId points to no project (friendly error)", async () => {
    loginAs("admin", fixture);
    const result = await createTransaction({
      type: "invoice",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      projectId: newId(),
      occurredOn: "2026-05-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("projectId");
    expect(result.error).toMatch(/not found/i);
  });

  it("refuses cross-FK invariant: project's companyId must match transaction's companyId", async () => {
    loginAs("admin", fixture);
    // Recording a transaction "on" Acme for BuildRight's project — refused.
    const result = await createTransaction({
      type: "invoice",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      projectId: fixture.projectBId,
      occurredOn: "2026-05-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("projectId");
    expect(result.error).toMatch(/does not belong/i);
  });

  it("refuses a staff caller (admin-only module)", async () => {
    loginAs("staff", fixture);
    const result = await createTransaction({
      type: "payment",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-05-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });

  it("refuses a company-role caller", async () => {
    loginAs("companyA", fixture);
    const result = await createTransaction({
      type: "payment",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-05-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });

  it("refuses an unauthenticated caller", async () => {
    // mockedReadSession defaults to null.
    const result = await createTransaction({
      type: "payment",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-05-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/signed in/i);
  });

  it("refuses amountPaise <= 0 (Zod)", async () => {
    loginAs("admin", fixture);
    const result = await createTransaction({
      type: "payment",
      amountPaise: 0,
      companyId: fixture.companyAId,
      occurredOn: "2026-05-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("amountPaise");
    expect(result.error).toMatch(/greater than zero/i);
  });

  it("refuses currency other than INR (Zod refinement)", async () => {
    loginAs("admin", fixture);
    const result = await createTransaction({
      type: "payment",
      amountPaise: 1_000_00,
      currency: "USD",
      companyId: fixture.companyAId,
      occurredOn: "2026-05-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("currency");
    expect(result.error).toMatch(/INR/);
  });
});

// ── updateTransaction ─────────────────────────────────────────────────────

describe("updateTransaction", () => {
  it("admin patches notes + amount + writes before/after audit", async () => {
    loginAs("admin", fixture);
    const created = await createTransaction({
      type: "invoice",
      amountPaise: 100_000_00,
      companyId: fixture.companyAId,
      projectId: fixture.projectAId,
      occurredOn: "2026-05-01",
      notes: "Initial draft amount",
    });
    if (!created.ok) throw new Error("setup failed");

    const result = await updateTransaction({
      id: created.id,
      amountPaise: 125_000_00,
      notes: "Revised invoice after change order",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, created.id))
      .then((r) => r[0]);
    expect(row?.amountPaise).toBe(125_000_00);
    expect(row?.notes).toBe("Revised invoice after change order");

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "transaction"),
          eq(auditLog.targetId, created.id),
          eq(auditLog.action, "updated"),
        ),
      )
      .then((r) => r[0]);
    expect(audit).toBeDefined();
    const before = audit?.before as Record<string, unknown>;
    const after = audit?.after as Record<string, unknown>;
    expect(before.amountPaise).toBe(100_000_00);
    expect(after.amountPaise).toBe(125_000_00);
  });

  it("refuses cross-FK invariant on patched projectId", async () => {
    loginAs("admin", fixture);
    const created = await createTransaction({
      type: "invoice",
      amountPaise: 100_000_00,
      companyId: fixture.companyAId,
      projectId: fixture.projectAId,
      occurredOn: "2026-05-01",
    });
    if (!created.ok) throw new Error("setup failed");

    // Try to re-tag this Acme transaction to BuildRight's project.
    const result = await updateTransaction({
      id: created.id,
      projectId: fixture.projectBId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("projectId");
    expect(result.error).toMatch(/does not belong/i);
  });

  it("refuses a non-admin caller", async () => {
    loginAs("staff", fixture);
    const result = await updateTransaction({
      id: newId(),
      notes: "anything",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });
});

// ── deleteTransaction ─────────────────────────────────────────────────────

describe("deleteTransaction", () => {
  it("admin deletes the row + audit captures full pre-deletion snapshot", async () => {
    loginAs("admin", fixture);
    const created = await createTransaction({
      type: "payment",
      amountPaise: 75_000_00,
      companyId: fixture.companyAId,
      projectId: fixture.projectAId,
      occurredOn: "2026-04-20",
      referenceNumber: "PAY-2026-077",
      notes: "Q1 closeout",
    });
    if (!created.ok) throw new Error("setup failed");

    const del = await deleteTransaction(created.id, {
      reason: "double-entry — already recorded as PAY-2026-076",
    });
    expect(del.ok).toBe(true);

    // Row is gone.
    const stillThere = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, created.id))
      .then((r) => r[0]);
    expect(stillThere).toBeUndefined();

    // Audit has the full snapshot in `before`.
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "transaction"),
          eq(auditLog.targetId, created.id),
          eq(auditLog.action, "deleted"),
        ),
      )
      .then((r) => r[0]);
    expect(audit).toBeDefined();
    const before = audit?.before as Record<string, unknown>;
    expect(before.type).toBe("payment");
    expect(before.amountPaise).toBe(75_000_00);
    expect(before.companyId).toBe(fixture.companyAId);
    expect(before.projectId).toBe(fixture.projectAId);
    expect(before.referenceNumber).toBe("PAY-2026-077");
    expect(before.notes).toBe("Q1 closeout");

    const meta = audit?.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("double-entry — already recorded as PAY-2026-076");
  });

  it("refuses a non-admin caller", async () => {
    loginAs("companyA", fixture);
    const result = await deleteTransaction(newId());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });
});

// ── getTransaction ────────────────────────────────────────────────────────

describe("getTransaction", () => {
  it("admin sees the row", async () => {
    loginAs("admin", fixture);
    const created = await createTransaction({
      type: "advance",
      amountPaise: 200_000_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-05-05",
    });
    if (!created.ok) throw new Error("setup failed");

    const read = await getTransaction(created.id);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.transaction.type).toBe("advance");
    expect(read.transaction.amountPaise).toBe(200_000_00);
  });

  it("refuses a non-admin caller", async () => {
    loginAs("staff", fixture);
    const result = await getTransaction(newId());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });
});

// ── listTransactions (smoke — Chunk 2's fixture covers the full matrix) ──

describe("listTransactions — smoke", () => {
  it("admin can filter by type", async () => {
    loginAs("admin", fixture);
    await createTransaction({
      type: "invoice",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-05-01",
    });
    await createTransaction({
      type: "payment",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-05-02",
    });

    const result = await listTransactions({ type: "invoice" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].type).toBe("invoice");
  });

  it("admin can filter by occurredOn date range (inclusive)", async () => {
    loginAs("admin", fixture);
    await createTransaction({
      type: "payment",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-04-15",
    });
    await createTransaction({
      type: "payment",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-05-15",
    });
    await createTransaction({
      type: "payment",
      amountPaise: 1_000_00,
      companyId: fixture.companyAId,
      occurredOn: "2026-06-15",
    });

    const result = await listTransactions({
      occurredOnFrom: "2026-05-01",
      occurredOnTo: "2026-05-31",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].occurredOn).toBe("2026-05-15");
  });

  it("refuses a non-admin caller", async () => {
    loginAs("companyA", fixture);
    const result = await listTransactions({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });
});
