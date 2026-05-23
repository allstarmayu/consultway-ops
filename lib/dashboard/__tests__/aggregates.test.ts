/**
 * Integration tests for `lib/dashboard/aggregates.ts`.
 *
 * Covers:
 *   - `getProjectsByStatus` admin/unscoped breakdown
 *   - `getProjectsByStatus` admin with companyId narrowing
 *   - `getProjectsByStatus` company-role caller (same shape as admin
 *     with scope)
 *   - `getProjectsByStatus` zero-fill on an empty company
 *   - `getTendersByStatus` admin/unscoped breakdown
 *   - `getTendersByStatus` admin with publisher narrowing
 *   - `getTransactionsSummaryThisMonth` admin sees this month only
 *   - `getTransactionsSummaryThisMonth` zero-fill on an empty month
 *   - `getTransactionsSummaryThisMonth` refuses non-admin (staff)
 *   - `getTransactionsSummaryThisMonth` refuses non-admin (company)
 *
 * The fixture seeds 2 companies, 4 projects across the 5 statuses (one
 * duplicate), 3 tenders across statuses, and 7 transactions: 5 this
 * month (pinned via `now`) + 2 last month, so the date filter is
 * exercised meaningfully.
 *
 * @module lib/dashboard/__tests__/aggregates
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
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  tenders,
  projects,
  transactions,
  users,
  auditLog,
  type ProjectStatus,
  type TenderStatus,
  type TransactionType,
  type UserRole,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import {
  getProjectsByStatus,
  getTendersByStatus,
  getTransactionsSummaryThisMonth,
} from "../aggregates";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// Pinned reference date for the month-bounded tests. The fixture inserts
// "this month" rows at 2026-05-XX and "last month" rows at 2026-04-XX,
// so any date in May 2026 (UTC) lands the boundary on May 1 / May 31.
const PINNED_NOW = new Date("2026-05-15T12:00:00Z");

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  staffUserId: string;
  companyUserAId: string;
  publisherCompanyId: string;
  companyAId: string;
  companyBId: string;
  projectIds: string[];
  tenderIds: string[];
  transactionIds: string[];
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const publisherCompanyId = newId();
  const companyAId = newId();
  const companyBId = newId();
  const adminUserId = newId();
  const staffUserId = newId();
  const companyUserAId = newId();

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

  // 4 projects: planning(A), active(A) [duplicate active under A would
  // make 5 — we use one each but seed two active under B to exercise
  // the duplicate-bucket case], completed(A), on_hold(B), active(B).
  const projectRows: Array<{
    id: string;
    name: string;
    companyId: string;
    status: ProjectStatus;
  }> = [
    { id: newId(), name: "Acme P1 (planning)", companyId: companyAId, status: "planning" },
    { id: newId(), name: "Acme P2 (active)", companyId: companyAId, status: "active" },
    { id: newId(), name: "Acme P3 (completed)", companyId: companyAId, status: "completed" },
    { id: newId(), name: "BuildRight P1 (on hold)", companyId: companyBId, status: "on_hold" },
    { id: newId(), name: "BuildRight P2 (active dup)", companyId: companyBId, status: "active" },
  ];
  await db.insert(projects).values(projectRows);

  // 3 tenders by Consultway: 1 draft, 1 published, 1 awarded.
  const tenderRows: Array<{
    id: string;
    title: string;
    publisherCompanyId: string;
    status: TenderStatus;
    sector: string;
    geography: string;
  }> = [
    {
      id: newId(),
      title: "Draft tender",
      publisherCompanyId,
      status: "draft",
      sector: "Infrastructure",
      geography: "Maharashtra",
    },
    {
      id: newId(),
      title: "Published tender",
      publisherCompanyId,
      status: "published",
      sector: "Infrastructure",
      geography: "Maharashtra",
    },
    {
      id: newId(),
      title: "Awarded tender",
      publisherCompanyId,
      status: "awarded",
      sector: "Civil Works",
      geography: "Karnataka",
    },
  ];
  await db.insert(tenders).values(tenderRows);

  // 7 transactions: 5 this month (May 2026) and 2 last month (Apr 2026).
  // Distribution this month: 2 invoices, 2 payments, 1 expense — gives a
  // clean per-type assertion.
  const txRows: Array<{
    id: string;
    type: TransactionType;
    amountPaise: number;
    companyId: string;
    occurredOn: string;
  }> = [
    // This month
    { id: newId(), type: "invoice", amountPaise: 100_000_00, companyId: companyAId, occurredOn: "2026-05-02" },
    { id: newId(), type: "invoice", amountPaise: 50_000_00, companyId: companyAId, occurredOn: "2026-05-10" },
    { id: newId(), type: "payment", amountPaise: 30_000_00, companyId: companyAId, occurredOn: "2026-05-20" },
    { id: newId(), type: "payment", amountPaise: 20_000_00, companyId: companyBId, occurredOn: "2026-05-25" },
    { id: newId(), type: "expense", amountPaise: 5_000_00, companyId: companyBId, occurredOn: "2026-05-31" },
    // Last month — should NOT appear in this-month summary
    { id: newId(), type: "invoice", amountPaise: 999_000_00, companyId: companyAId, occurredOn: "2026-04-15" },
    { id: newId(), type: "refund", amountPaise: 1_00, companyId: companyAId, occurredOn: "2026-04-30" },
  ];
  await db.insert(transactions).values(
    txRows.map((r) => ({ ...r, currency: "INR", projectId: null })),
  );

  return {
    adminUserId,
    staffUserId,
    companyUserAId,
    publisherCompanyId,
    companyAId,
    companyBId,
    projectIds: projectRows.map((p) => p.id),
    tenderIds: tenderRows.map((t) => t.id),
    transactionIds: txRows.map((t) => t.id),
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [f.adminUserId, f.staffUserId, f.companyUserAId]) {
    await db.delete(auditLog).where(eq(auditLog.actorId, userId)).catch(() => {});
  }
  if (f.transactionIds.length > 0) {
    await db
      .delete(transactions)
      .where(inArray(transactions.id, f.transactionIds));
  }
  if (f.projectIds.length > 0) {
    await db.delete(projects).where(inArray(projects.id, f.projectIds));
  }
  if (f.tenderIds.length > 0) {
    await db.delete(tenders).where(inArray(tenders.id, f.tenderIds));
  }
  await db
    .delete(users)
    .where(inArray(users.id, [f.adminUserId, f.staffUserId, f.companyUserAId]));
  await db
    .delete(companies)
    .where(
      inArray(companies.id, [f.publisherCompanyId, f.companyAId, f.companyBId]),
    );
}

function loginAs(
  role: "admin" | "staff" | "companyA" | "anon",
  f: Fixture,
): void {
  if (role === "admin") {
    mockedReadSession.mockResolvedValue({
      userId: f.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });
  } else if (role === "staff") {
    mockedReadSession.mockResolvedValue({
      userId: f.staffUserId,
      role: "staff",
      companyId: null,
      email: "staff@test.local",
    });
  } else if (role === "companyA") {
    mockedReadSession.mockResolvedValue({
      userId: f.companyUserAId,
      role: "company",
      companyId: f.companyAId,
      email: "acme@test.local",
    });
  } else {
    mockedReadSession.mockResolvedValue(null);
  }
}

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── getProjectsByStatus ───────────────────────────────────────────────────

describe("getProjectsByStatus", () => {
  it("returns the full cross-company breakdown for admin/no-scope", async () => {
    loginAs("admin", fixture);
    const result = await getProjectsByStatus({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byStatus.planning).toBe(1);
    expect(result.byStatus.active).toBe(2); // duplicate bucket
    expect(result.byStatus.completed).toBe(1);
    expect(result.byStatus.on_hold).toBe(1);
    expect(result.byStatus.cancelled).toBe(0);
  });

  it("narrows by companyId for admin with scope", async () => {
    loginAs("admin", fixture);
    const result = await getProjectsByStatus({ companyId: fixture.companyAId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Acme: planning(1), active(1), completed(1), no on_hold, no cancelled.
    expect(result.byStatus.planning).toBe(1);
    expect(result.byStatus.active).toBe(1);
    expect(result.byStatus.completed).toBe(1);
    expect(result.byStatus.on_hold).toBe(0);
    expect(result.byStatus.cancelled).toBe(0);
  });

  it("matches the admin-with-scope shape for a company-role caller", async () => {
    loginAs("companyA", fixture);
    const result = await getProjectsByStatus({ companyId: fixture.companyAId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byStatus.planning).toBe(1);
    expect(result.byStatus.active).toBe(1);
    expect(result.byStatus.completed).toBe(1);
    expect(result.byStatus.on_hold).toBe(0);
    expect(result.byStatus.cancelled).toBe(0);
  });

  it("zero-fills every status key for an empty company", async () => {
    loginAs("admin", fixture);
    const emptyId = newId();
    await db.insert(companies).values({
      id: emptyId,
      name: "Empty Co",
      sector: "Test",
      geography: "Test",
    });

    const result = await getProjectsByStatus({ companyId: emptyId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byStatus.planning).toBe(0);
    expect(result.byStatus.active).toBe(0);
    expect(result.byStatus.on_hold).toBe(0);
    expect(result.byStatus.completed).toBe(0);
    expect(result.byStatus.cancelled).toBe(0);

    await db.delete(companies).where(eq(companies.id, emptyId));
  });
});

// ── getTendersByStatus ────────────────────────────────────────────────────

describe("getTendersByStatus", () => {
  it("returns the full breakdown for admin/no-scope", async () => {
    loginAs("admin", fixture);
    const result = await getTendersByStatus({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byStatus.draft).toBe(1);
    expect(result.byStatus.published).toBe(1);
    expect(result.byStatus.awarded).toBe(1);
    expect(result.byStatus.closed).toBe(0);
  });

  it("narrows by publisher company id", async () => {
    loginAs("admin", fixture);
    // The fixture's 3 tenders are all under the publisher — narrowing
    // by publisher returns the same 3. Narrowing by a non-publisher
    // company returns zero across the board.
    const samePublisher = await getTendersByStatus({
      companyId: fixture.publisherCompanyId,
    });
    expect(samePublisher.ok).toBe(true);
    if (!samePublisher.ok) return;
    expect(samePublisher.byStatus.draft).toBe(1);
    expect(samePublisher.byStatus.published).toBe(1);
    expect(samePublisher.byStatus.awarded).toBe(1);

    const otherCompany = await getTendersByStatus({
      companyId: fixture.companyAId,
    });
    expect(otherCompany.ok).toBe(true);
    if (!otherCompany.ok) return;
    expect(otherCompany.byStatus.draft).toBe(0);
    expect(otherCompany.byStatus.published).toBe(0);
    expect(otherCompany.byStatus.closed).toBe(0);
    expect(otherCompany.byStatus.awarded).toBe(0);
  });
});

// ── getTransactionsSummaryThisMonth ───────────────────────────────────────

describe("getTransactionsSummaryThisMonth", () => {
  it("counts only rows whose occurredOn lies in the pinned month (UTC)", async () => {
    loginAs("admin", fixture);
    const result = await getTransactionsSummaryThisMonth(PINNED_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.monthStart).toBe("2026-05-01");
    expect(result.monthEnd).toBe("2026-05-31");

    // 2 invoices @ 100k + 50k = 150k rupees = 15_000_000 paise.
    expect(result.countByType.invoice).toBe(2);
    expect(result.totalPaiseByType.invoice).toBe(150_000_00);

    // 2 payments @ 30k + 20k = 50k = 5_000_000 paise.
    expect(result.countByType.payment).toBe(2);
    expect(result.totalPaiseByType.payment).toBe(50_000_00);

    // 1 expense @ 5k = 500_000 paise.
    expect(result.countByType.expense).toBe(1);
    expect(result.totalPaiseByType.expense).toBe(5_000_00);

    // Last-month invoice (999k) and refund (1) must NOT show up.
    expect(result.countByType.refund).toBe(0);
    expect(result.totalPaiseByType.refund).toBe(0);

    expect(result.totalCount).toBe(5);
    expect(result.totalPaise).toBe(150_000_00 + 50_000_00 + 5_000_00);
  });

  it("zero-fills every type when the pinned month has no rows", async () => {
    loginAs("admin", fixture);
    // A month with no fixture activity.
    const result = await getTransactionsSummaryThisMonth(
      new Date("2027-09-10T00:00:00Z"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.monthStart).toBe("2027-09-01");
    expect(result.monthEnd).toBe("2027-09-30");
    expect(result.totalCount).toBe(0);
    expect(result.totalPaise).toBe(0);
    expect(result.countByType.invoice).toBe(0);
    expect(result.totalPaiseByType.payment).toBe(0);
    expect(result.totalPaiseByType.refund).toBe(0);
  });

  it("refuses a staff caller", async () => {
    loginAs("staff", fixture);
    const result = await getTransactionsSummaryThisMonth(PINNED_NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });

  it("refuses a company-role caller", async () => {
    loginAs("companyA", fixture);
    const result = await getTransactionsSummaryThisMonth(PINNED_NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });
});
