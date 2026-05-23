/**
 * Integration tests for `listTransactions` — Chunk 2 surface.
 *
 * Fixture seeds 2 companies, 1 project per company, and 6 transactions
 * across the five types and a date range so the filters can be
 * exercised individually + in composition.
 *
 * Covers:
 *   - admin sees all 6
 *   - staff refused
 *   - company-role refused
 *   - filter by type narrows correctly
 *   - filter by companyId narrows correctly
 *   - filter by projectId narrows correctly
 *   - date-range filter narrows correctly (inclusive on both ends)
 *   - layered type + company composes correctly
 *   - pagination total matches the SQL-side count
 *   - default sort is occurredOn DESC (newest first)
 *
 * @module lib/transactions/__tests__/list-actions
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
  transactions,
  users,
  auditLog,
  type UserRole,
  type TransactionType,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import { listTransactions, listTransactionsForExport } from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyUserAId: string;
  companyAId: string;
  companyBId: string;
  projectAId: string;
  projectBId: string;
  /** Insert-order ids of the 6 seeded transactions. */
  txIds: {
    invoice_a_may1: string;
    payment_a_may15: string;
    expense_a_apr1: string;
    advance_b_may10: string;
    refund_b_jun5: string;
    expense_a_no_project_jun20: string;
  };
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const companyAId = newId();
  const companyBId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyUserAId = newId();
  const projectAId = newId();
  const projectBId = newId();

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

  await db.insert(projects).values([
    { id: projectAId, name: "Acme pilot", companyId: companyAId },
    { id: projectBId, name: "BuildRight metro spur", companyId: companyBId },
  ]);

  const txIds = {
    invoice_a_may1: newId(),
    payment_a_may15: newId(),
    expense_a_apr1: newId(),
    advance_b_may10: newId(),
    refund_b_jun5: newId(),
    expense_a_no_project_jun20: newId(),
  };

  await db.insert(transactions).values([
    {
      id: txIds.invoice_a_may1,
      type: "invoice" satisfies TransactionType,
      amountPaise: 100_000_00,
      companyId: companyAId,
      projectId: projectAId,
      occurredOn: "2026-05-01",
    },
    {
      id: txIds.payment_a_may15,
      type: "payment" satisfies TransactionType,
      amountPaise: 50_000_00,
      companyId: companyAId,
      projectId: projectAId,
      occurredOn: "2026-05-15",
    },
    {
      id: txIds.expense_a_apr1,
      type: "expense" satisfies TransactionType,
      amountPaise: 12_500_00,
      companyId: companyAId,
      projectId: projectAId,
      occurredOn: "2026-04-01",
    },
    {
      id: txIds.advance_b_may10,
      type: "advance" satisfies TransactionType,
      amountPaise: 75_000_00,
      companyId: companyBId,
      projectId: projectBId,
      occurredOn: "2026-05-10",
    },
    {
      id: txIds.refund_b_jun5,
      type: "refund" satisfies TransactionType,
      amountPaise: 5_000_00,
      companyId: companyBId,
      projectId: projectBId,
      occurredOn: "2026-06-05",
    },
    {
      // Company-level expense — no project, exercises the NULL-project branch.
      id: txIds.expense_a_no_project_jun20,
      type: "expense" satisfies TransactionType,
      amountPaise: 8_000_00,
      companyId: companyAId,
      projectId: null,
      occurredOn: "2026-06-20",
    },
  ]);

  return {
    adminUserId,
    staffUserId,
    companyUserAId,
    companyAId,
    companyBId,
    projectAId,
    projectBId,
    txIds,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [f.adminUserId, f.staffUserId, f.companyUserAId]) {
    await db
      .delete(auditLog)
      .where(eq(auditLog.actorId, userId))
      .catch(() => {});
  }
  await db.delete(transactions).where(eq(transactions.companyId, f.companyAId));
  await db.delete(transactions).where(eq(transactions.companyId, f.companyBId));
  await db.delete(projects).where(eq(projects.id, f.projectAId));
  await db.delete(projects).where(eq(projects.id, f.projectBId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe("listTransactions — visibility", () => {
  it("admin sees all 6 seeded rows", async () => {
    loginAs("admin", fixture);
    const result = await listTransactions({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(6);
    expect(result.rows.length).toBe(6);
  });

  it("staff refused (admin-only module)", async () => {
    loginAs("staff", fixture);
    const result = await listTransactions({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });

  it("company-role refused", async () => {
    loginAs("companyA", fixture);
    const result = await listTransactions({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });
});

describe("listTransactions — filters", () => {
  it("filter by type narrows to that type only", async () => {
    loginAs("admin", fixture);
    const result = await listTransactions({ type: "expense" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(2); // expense_a_apr1, expense_a_no_project_jun20
    expect(result.rows.every((r) => r.type === "expense")).toBe(true);
  });

  it("filter by companyId narrows to that company", async () => {
    loginAs("admin", fixture);
    const result = await listTransactions({
      companyId: fixture.companyAId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Acme has: invoice, payment, expense (with project), expense (no project)
    expect(result.total).toBe(4);
    expect(result.rows.every((r) => r.companyId === fixture.companyAId)).toBe(
      true,
    );
  });

  it("filter by projectId narrows to that project", async () => {
    loginAs("admin", fixture);
    const result = await listTransactions({
      projectId: fixture.projectAId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Acme project: invoice, payment, expense (the no-project expense excluded)
    expect(result.total).toBe(3);
    expect(result.rows.every((r) => r.projectId === fixture.projectAId)).toBe(
      true,
    );
  });

  it("date-range filter is inclusive on both ends", async () => {
    loginAs("admin", fixture);
    // May 1 — May 15 inclusive. Catches invoice_a_may1 and payment_a_may15
    // and advance_b_may10. NOT expense_a_apr1 (before range) or the June ones.
    const result = await listTransactions({
      occurredOnFrom: "2026-05-01",
      occurredOnTo: "2026-05-15",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(3);
    const dates = result.rows.map((r) => r.occurredOn).sort();
    expect(dates).toEqual(["2026-05-01", "2026-05-10", "2026-05-15"]);
  });

  it("layered type + company composes correctly", async () => {
    loginAs("admin", fixture);
    // Acme expenses: 2 rows (with project + without project).
    const result = await listTransactions({
      type: "expense",
      companyId: fixture.companyAId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(2);
    expect(
      result.rows.every(
        (r) => r.type === "expense" && r.companyId === fixture.companyAId,
      ),
    ).toBe(true);
  });
});

describe("listTransactions — sorting + pagination", () => {
  it("default sort is occurredOn DESC (newest first)", async () => {
    loginAs("admin", fixture);
    const result = await listTransactions({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dates = result.rows.map((r) => r.occurredOn);
    // Verify dates are non-increasing.
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1] >= dates[i]).toBe(true);
    }
    // And the first row is the latest (2026-06-20).
    expect(dates[0]).toBe("2026-06-20");
  });

  it("pagination total reflects the full filtered set, not just the page", async () => {
    loginAs("admin", fixture);
    const result = await listTransactions({
      perPage: 2,
      page: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.length).toBe(2);
    expect(result.total).toBe(6);
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(2);
  });
});

// ── Day 20 — export-only perPage ceiling ──────────────────────────────────

describe("listTransactionsForExport — perPage cap", () => {
  it("accepts perPage=1000 (the export route's cap)", async () => {
    loginAs("admin", fixture);
    const result = await listTransactionsForExport({ perPage: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.perPage).toBe(1000);
    // Only 6 rows seeded — but the page is sized to 1000, returning all 6.
    expect(result.rows.length).toBe(6);
  });

  it("the table-facing listTransactions still refuses perPage=1000", async () => {
    loginAs("admin", fixture);
    const result = await listTransactions({ perPage: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The Zod cap-violation surfaces with `perPage` as the field hint.
    expect(result.field).toBe("perPage");
  });
});
