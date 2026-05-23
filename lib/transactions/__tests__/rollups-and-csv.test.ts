/**
 * Integration tests for the Chunk-3 surface:
 *
 *   - `getCompanyRollup`  — per-company aggregate, includes no-project rows
 *   - `getProjectRollup`  — per-project aggregate, excludes no-project rows
 *   - `getProjectRecentTransactions` — N most recent rows for a project
 *   - `transactionsToCsv` — RFC-4180 CSV output with header + escape semantics
 *   - `csvFilenameDateStamp` — YYYY-MM-DD shape
 *
 * Fixture for Acme: 2 invoices, 3 payments, 1 expense — all tagged to
 * a project — plus a separate company-level expense (no project) to
 * exercise the per-company vs per-project asymmetry.
 *
 * @module lib/transactions/__tests__/rollups-and-csv
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
  type Transaction,
  type TransactionType,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import {
  getCompanyRollup,
  getProjectRollup,
  getProjectRecentTransactions,
} from "../rollups";
import { transactionsToCsv, csvFilenameDateStamp } from "../csv";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  companyUserAId: string;
  companyAId: string;
  projectAId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const companyAId = newId();
  const adminUserId = newId();
  const companyUserAId = newId();
  const projectAId = newId();

  await db.insert(companies).values([
    {
      id: companyAId,
      name: "Acme Construction",
      sector: "Infrastructure",
      geography: "Maharashtra",
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
  ]);

  // 6 rows tagged to the project: 2 invoices, 3 payments, 1 expense.
  // Plus 1 company-level expense (no project) for the per-company vs
  // per-project asymmetry assertion.
  const rows: Array<{
    type: TransactionType;
    amountPaise: number;
    occurredOn: string;
    withProject: boolean;
    referenceNumber?: string | null;
  }> = [
    { type: "invoice", amountPaise: 100_000_00, occurredOn: "2026-05-01", withProject: true },
    { type: "invoice", amountPaise: 150_000_00, occurredOn: "2026-05-15", withProject: true },
    { type: "payment", amountPaise: 50_000_00, occurredOn: "2026-05-20", withProject: true },
    { type: "payment", amountPaise: 75_000_00, occurredOn: "2026-05-25", withProject: true },
    { type: "payment", amountPaise: 25_000_00, occurredOn: "2026-06-01", withProject: true },
    { type: "expense", amountPaise: 12_500_00, occurredOn: "2026-05-10", withProject: true },
    // Company-level expense — no project tag.
    {
      type: "expense",
      amountPaise: 30_000_00,
      occurredOn: "2026-05-05",
      withProject: false,
      referenceNumber: "OFFICE-RENT-MAY",
    },
  ];

  await db.insert(transactions).values(
    rows.map((r) => ({
      id: newId(),
      type: r.type,
      amountPaise: r.amountPaise,
      currency: "INR",
      companyId: companyAId,
      projectId: r.withProject ? projectAId : null,
      occurredOn: r.occurredOn,
      referenceNumber: r.referenceNumber ?? null,
    })),
  );

  return { adminUserId, companyUserAId, companyAId, projectAId };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [f.adminUserId, f.companyUserAId]) {
    await db
      .delete(auditLog)
      .where(eq(auditLog.actorId, userId))
      .catch(() => {});
  }
  await db.delete(transactions).where(eq(transactions.companyId, f.companyAId));
  await db.delete(projects).where(eq(projects.id, f.projectAId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
}

function loginAs(role: "admin" | "companyA", f: Fixture): void {
  if (role === "admin") {
    mockedReadSession.mockResolvedValue({
      userId: f.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });
  } else {
    mockedReadSession.mockResolvedValue({
      userId: f.companyUserAId,
      role: "company",
      companyId: f.companyAId,
      email: "acme@test.local",
    });
  }
}

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── Per-company rollup ────────────────────────────────────────────────────

describe("getCompanyRollup", () => {
  it("totals every row tagged to the company (including no-project entries)", async () => {
    loginAs("admin", fixture);
    const result = await getCompanyRollup(fixture.companyAId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.rollup;

    expect(r.byType.invoice.count).toBe(2);
    expect(r.byType.invoice.totalPaise).toBe(250_000_00);

    expect(r.byType.payment.count).toBe(3);
    expect(r.byType.payment.totalPaise).toBe(150_000_00);

    // Two expenses: one with project + one without. Both count.
    expect(r.byType.expense.count).toBe(2);
    expect(r.byType.expense.totalPaise).toBe(42_500_00);

    expect(r.byType.advance.count).toBe(0);
    expect(r.byType.advance.totalPaise).toBe(0);
    expect(r.byType.refund.count).toBe(0);

    expect(r.totalCount).toBe(7);
    expect(r.totalPaise).toBe(
      250_000_00 + 150_000_00 + 42_500_00,
    );
  });

  it("refuses a non-admin caller", async () => {
    loginAs("companyA", fixture);
    const result = await getCompanyRollup(fixture.companyAId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });

  it("zero-fills byType for an empty company", async () => {
    loginAs("admin", fixture);
    // A fresh empty company.
    const emptyId = newId();
    await db.insert(companies).values({
      id: emptyId,
      name: "Empty Co",
      sector: "Test",
      geography: "Test",
    });

    const result = await getCompanyRollup(emptyId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rollup.totalPaise).toBe(0);
    expect(result.rollup.totalCount).toBe(0);
    expect(result.rollup.byType.invoice).toEqual({ count: 0, totalPaise: 0 });

    await db.delete(companies).where(eq(companies.id, emptyId));
  });
});

// ── Per-project rollup ────────────────────────────────────────────────────

describe("getProjectRollup", () => {
  it("excludes the company-level no-project expense by construction", async () => {
    loginAs("admin", fixture);
    const result = await getProjectRollup(fixture.projectAId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.rollup;

    expect(r.byType.invoice.count).toBe(2);
    expect(r.byType.invoice.totalPaise).toBe(250_000_00);

    expect(r.byType.payment.count).toBe(3);
    expect(r.byType.payment.totalPaise).toBe(150_000_00);

    // Only the project-tagged expense (12,500); the office-rent expense
    // (30,000) is company-level (NULL project) and excluded here.
    expect(r.byType.expense.count).toBe(1);
    expect(r.byType.expense.totalPaise).toBe(12_500_00);

    expect(r.totalCount).toBe(6);
    expect(r.totalPaise).toBe(250_000_00 + 150_000_00 + 12_500_00);
  });

  it("refuses a non-admin caller", async () => {
    loginAs("companyA", fixture);
    const result = await getProjectRollup(fixture.projectAId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });
});

describe("getProjectRecentTransactions", () => {
  it("returns the latest N rows for the project, occurredOn DESC", async () => {
    loginAs("admin", fixture);
    const result = await getProjectRecentTransactions(fixture.projectAId, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.length).toBe(3);
    const dates = result.rows.map((r) => r.occurredOn);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1] >= dates[i]).toBe(true);
    }
    expect(dates[0]).toBe("2026-06-01"); // newest tagged-to-project row
  });

  it("refuses a non-admin caller", async () => {
    loginAs("companyA", fixture);
    const result = await getProjectRecentTransactions(fixture.projectAId, 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });
});

// ── CSV export ────────────────────────────────────────────────────────────

describe("transactionsToCsv", () => {
  it("produces a header row + correct value formatting (BOM, CRLF)", async () => {
    const rows: Transaction[] = [
      {
        id: "tx1",
        type: "payment",
        amountPaise: 50_000_00,
        currency: "INR",
        companyId: "c1",
        projectId: "p1",
        occurredOn: "2026-05-20",
        referenceNumber: "RCPT-001",
        notes: "Q2 milestone",
        internalNotes: null,
        createdAt: "2026-05-20 10:00:00",
        updatedAt: "2026-05-20 10:00:00",
      },
    ];

    const csv = transactionsToCsv(rows, {
      companyNames: new Map([["c1", "Acme"]]),
      projectNames: new Map([["p1", "Pilot"]]),
    });

    // UTF-8 BOM prefix.
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    // CRLF line endings.
    expect(csv).toMatch(/\r\n/);
    // Header present.
    expect(csv).toContain(
      "Date,Type,Amount,Currency,Company,Project,Reference,Notes",
    );
    // Data row.
    expect(csv).toContain(
      "2026-05-20,payment,50000.00,INR,Acme,Pilot,RCPT-001,Q2 milestone",
    );
  });

  it("escapes embedded commas + double quotes per RFC-4180", async () => {
    const rows: Transaction[] = [
      {
        id: "tx1",
        type: "expense",
        amountPaise: 1_00,
        currency: "INR",
        companyId: "c1",
        projectId: null,
        occurredOn: "2026-05-01",
        referenceNumber: null,
        notes: 'Note with "quote" and, comma',
        internalNotes: null,
        createdAt: "2026-05-01 10:00:00",
        updatedAt: "2026-05-01 10:00:00",
      },
    ];

    const csv = transactionsToCsv(rows, {
      companyNames: new Map([["c1", "Co, Inc."]]),
      projectNames: new Map(),
    });

    // Company name has a comma — quoted.
    expect(csv).toContain('"Co, Inc."');
    // Notes has both an embedded double quote (doubled) and a comma —
    // whole field is quoted.
    expect(csv).toContain('"Note with ""quote"" and, comma"');
    // Empty project field stays empty (not quoted).
    expect(csv).toContain(",,"); // empty project + reference
  });

  it("formats paise as decimal rupees without thousands separators", async () => {
    const rows: Transaction[] = [
      {
        id: "tx1",
        type: "invoice",
        amountPaise: 12345_67,
        currency: "INR",
        companyId: "c1",
        projectId: null,
        occurredOn: "2026-05-01",
        referenceNumber: null,
        notes: null,
        internalNotes: null,
        createdAt: "2026-05-01 10:00:00",
        updatedAt: "2026-05-01 10:00:00",
      },
      {
        id: "tx2",
        type: "payment",
        amountPaise: 7,
        currency: "INR",
        companyId: "c1",
        projectId: null,
        occurredOn: "2026-05-02",
        referenceNumber: null,
        notes: null,
        internalNotes: null,
        createdAt: "2026-05-02 10:00:00",
        updatedAt: "2026-05-02 10:00:00",
      },
    ];

    const csv = transactionsToCsv(rows, {
      companyNames: new Map([["c1", "Acme"]]),
      projectNames: new Map(),
    });

    expect(csv).toContain(",12345.67,");
    expect(csv).toContain(",0.07,");
  });
});

describe("csvFilenameDateStamp", () => {
  it("returns YYYY-MM-DD for a given date", () => {
    const d = new Date("2026-05-23T15:42:00Z");
    expect(csvFilenameDateStamp(d)).toBe("2026-05-23");
  });

  it("defaults to today when no argument is passed", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(csvFilenameDateStamp()).toBe(today);
  });
});
