/**
 * Integration tests for the Day-19 period-bounded aggregates in
 * `lib/dashboard/aggregates.ts`.
 *
 * Covers:
 *   - `getProjectsByStatusForPeriod` only counts projects created in
 *     `[start, end]`.
 *   - `getProjectsByStatusForPeriod` zero-fills every status on an
 *     empty period.
 *   - `getTendersByStatusForPeriod` filters on `publishedAt` — pinned
 *     by a draft (no `publishedAt`) NOT counting.
 *   - `getTendersByStatusForPeriod` zero-fills.
 *   - `getTransactionsSummaryForPeriod` admin sees the period total.
 *   - `getTransactionsSummaryForPeriod` with a `companyId` narrows.
 *   - `getTransactionsSummaryForPeriod` refuses staff caller.
 *   - `getTransactionsSummaryForPeriod` refuses company-role caller.
 *   - Inclusive bounds on both ends (rows on the `start` and `end`
 *     boundary days both count).
 *
 * Fixture seeds the rows with explicit `createdAt` / `publishedAt`
 * timestamps so the period boundary can be exercised precisely.
 *
 * @module lib/dashboard/__tests__/aggregates-period
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
  getProjectsByStatusForPeriod,
  getTendersByStatusForPeriod,
  getTransactionsSummaryForPeriod,
} from "../aggregates";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// Period under test: full May 2026 (UTC).
const PERIOD_START = "2026-05-01";
const PERIOD_END = "2026-05-31";

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
  draftTenderId: string;
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

  // Projects — 4 in-period + 1 before-period + 1 after-period + 1 on
  // the exact start day + 1 on the exact end day (inclusive-bound
  // boundary cases).
  const projectRows: Array<{
    id: string;
    name: string;
    companyId: string;
    status: ProjectStatus;
    createdAt: string;
  }> = [
    {
      id: newId(),
      name: "April project (before)",
      companyId: companyAId,
      status: "planning",
      createdAt: "2026-04-15 09:00:00",
    },
    {
      id: newId(),
      name: "May start-boundary project",
      companyId: companyAId,
      status: "planning",
      createdAt: "2026-05-01 00:30:00",
    },
    {
      id: newId(),
      name: "Mid-May active",
      companyId: companyAId,
      status: "active",
      createdAt: "2026-05-10 14:00:00",
    },
    {
      id: newId(),
      name: "Mid-May completed",
      companyId: companyBId,
      status: "completed",
      createdAt: "2026-05-15 12:00:00",
    },
    {
      id: newId(),
      name: "May end-boundary on-hold",
      companyId: companyBId,
      status: "on_hold",
      createdAt: "2026-05-31 23:30:00",
    },
    {
      id: newId(),
      name: "June project (after)",
      companyId: companyAId,
      status: "cancelled",
      createdAt: "2026-06-02 10:00:00",
    },
  ];
  await db.insert(projects).values(projectRows);

  // Tenders — 1 draft (no publishedAt) + 3 published-in-period across
  // different statuses + 1 published-before-period.
  const draftTenderId = newId();
  const tenderRows: Array<{
    id: string;
    title: string;
    publisherCompanyId: string;
    status: TenderStatus;
    sector: string;
    geography: string;
    publishedAt: string | null;
    createdAt: string;
  }> = [
    {
      id: draftTenderId,
      title: "Draft tender (never published)",
      publisherCompanyId,
      status: "draft",
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt: null,
      // Created inside the period — but should NOT count because
      // the helper filters on publishedAt, not createdAt.
      createdAt: "2026-05-05 09:00:00",
    },
    {
      id: newId(),
      title: "May published tender 1",
      publisherCompanyId,
      status: "published",
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt: "2026-05-03 10:00:00",
      createdAt: "2026-04-20 09:00:00",
    },
    {
      id: newId(),
      title: "May published tender 2",
      publisherCompanyId,
      status: "closed",
      sector: "Solar EPC",
      geography: "Karnataka",
      publishedAt: "2026-05-20 11:00:00",
      createdAt: "2026-05-15 09:00:00",
    },
    {
      id: newId(),
      title: "May awarded tender",
      publisherCompanyId,
      status: "awarded",
      sector: "Civil Works",
      geography: "Karnataka",
      publishedAt: "2026-05-25 12:00:00",
      createdAt: "2026-05-22 09:00:00",
    },
    {
      id: newId(),
      title: "April published tender (before)",
      publisherCompanyId,
      status: "closed",
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt: "2026-04-15 10:00:00",
      createdAt: "2026-04-10 09:00:00",
    },
  ];
  await db.insert(tenders).values(tenderRows);

  // Transactions — 5 in-period + 2 outside + boundary rows on start
  // and end days.
  const txRows: Array<{
    id: string;
    type: TransactionType;
    amountPaise: number;
    companyId: string;
    occurredOn: string;
  }> = [
    // Start-boundary in-period
    {
      id: newId(),
      type: "invoice",
      amountPaise: 100_000_00,
      companyId: companyAId,
      occurredOn: "2026-05-01",
    },
    {
      id: newId(),
      type: "invoice",
      amountPaise: 50_000_00,
      companyId: companyAId,
      occurredOn: "2026-05-10",
    },
    {
      id: newId(),
      type: "payment",
      amountPaise: 30_000_00,
      companyId: companyAId,
      occurredOn: "2026-05-20",
    },
    {
      id: newId(),
      type: "payment",
      amountPaise: 20_000_00,
      companyId: companyBId,
      occurredOn: "2026-05-25",
    },
    // End-boundary in-period
    {
      id: newId(),
      type: "expense",
      amountPaise: 5_000_00,
      companyId: companyBId,
      occurredOn: "2026-05-31",
    },
    // Out of period
    {
      id: newId(),
      type: "invoice",
      amountPaise: 999_000_00,
      companyId: companyAId,
      occurredOn: "2026-04-30",
    },
    {
      id: newId(),
      type: "refund",
      amountPaise: 1_00,
      companyId: companyAId,
      occurredOn: "2026-06-01",
    },
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
    draftTenderId,
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

// ── getProjectsByStatusForPeriod ──────────────────────────────────────────

describe("getProjectsByStatusForPeriod", () => {
  it("counts only projects created in [start, end] (inclusive bounds)", async () => {
    loginAs("admin", fixture);
    const result = await getProjectsByStatusForPeriod({
      start: PERIOD_START,
      end: PERIOD_END,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // In-period: planning(1: start-boundary), active(1), completed(1),
    // on_hold(1: end-boundary). The April + June rows must NOT appear.
    expect(result.byStatus.planning).toBe(1);
    expect(result.byStatus.active).toBe(1);
    expect(result.byStatus.completed).toBe(1);
    expect(result.byStatus.on_hold).toBe(1);
    expect(result.byStatus.cancelled).toBe(0);

    expect(result.start).toBe(PERIOD_START);
    expect(result.end).toBe(PERIOD_END);
  });

  it("includes a row created on the start day AND a row on the end day", async () => {
    loginAs("admin", fixture);
    // Narrow to a single-day window on the start; expect just the
    // start-boundary planning row.
    const startOnly = await getProjectsByStatusForPeriod({
      start: PERIOD_START,
      end: PERIOD_START,
    });
    expect(startOnly.ok).toBe(true);
    if (!startOnly.ok) return;
    expect(startOnly.byStatus.planning).toBe(1);
    expect(startOnly.byStatus.active).toBe(0);
    expect(startOnly.byStatus.on_hold).toBe(0);

    // Narrow to the end day; expect just the on_hold boundary row.
    const endOnly = await getProjectsByStatusForPeriod({
      start: PERIOD_END,
      end: PERIOD_END,
    });
    expect(endOnly.ok).toBe(true);
    if (!endOnly.ok) return;
    expect(endOnly.byStatus.on_hold).toBe(1);
    expect(endOnly.byStatus.planning).toBe(0);
  });

  it("zero-fills every status when the period has no projects", async () => {
    loginAs("admin", fixture);
    const result = await getProjectsByStatusForPeriod({
      start: "2030-01-01",
      end: "2030-01-31",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byStatus.planning).toBe(0);
    expect(result.byStatus.active).toBe(0);
    expect(result.byStatus.on_hold).toBe(0);
    expect(result.byStatus.completed).toBe(0);
    expect(result.byStatus.cancelled).toBe(0);
  });

  it("narrows by companyId when scope.companyId is set", async () => {
    loginAs("admin", fixture);
    const result = await getProjectsByStatusForPeriod({
      start: PERIOD_START,
      end: PERIOD_END,
      companyId: fixture.companyAId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Acme in-period: 1 planning (start boundary) + 1 active.
    // (Mid-May completed is BuildRight; on_hold end-boundary is BuildRight.)
    expect(result.byStatus.planning).toBe(1);
    expect(result.byStatus.active).toBe(1);
    expect(result.byStatus.completed).toBe(0);
    expect(result.byStatus.on_hold).toBe(0);
  });
});

// ── getTendersByStatusForPeriod ───────────────────────────────────────────

describe("getTendersByStatusForPeriod", () => {
  it("filters on publishedAt — a draft (no publishedAt) does NOT count", async () => {
    loginAs("admin", fixture);
    const result = await getTendersByStatusForPeriod({
      start: PERIOD_START,
      end: PERIOD_END,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // In-period: 1 published + 1 closed + 1 awarded. Draft has
    // publishedAt = NULL and is created in May but MUST be excluded.
    expect(result.byStatus.draft).toBe(0);
    expect(result.byStatus.published).toBe(1);
    expect(result.byStatus.closed).toBe(1);
    expect(result.byStatus.awarded).toBe(1);

    expect(result.start).toBe(PERIOD_START);
    expect(result.end).toBe(PERIOD_END);
  });

  it("zero-fills every status on an empty period", async () => {
    loginAs("admin", fixture);
    const result = await getTendersByStatusForPeriod({
      start: "2030-01-01",
      end: "2030-01-31",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byStatus.draft).toBe(0);
    expect(result.byStatus.published).toBe(0);
    expect(result.byStatus.closed).toBe(0);
    expect(result.byStatus.awarded).toBe(0);
  });
});

// ── getTransactionsSummaryForPeriod ───────────────────────────────────────

describe("getTransactionsSummaryForPeriod", () => {
  it("admin sees the cross-company period total", async () => {
    loginAs("admin", fixture);
    const result = await getTransactionsSummaryForPeriod({
      start: PERIOD_START,
      end: PERIOD_END,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 2 invoices (start-boundary + mid) = 100k + 50k = 150k rupees
    expect(result.countByType.invoice).toBe(2);
    expect(result.totalPaiseByType.invoice).toBe(150_000_00);

    // 2 payments = 30k + 20k = 50k rupees
    expect(result.countByType.payment).toBe(2);
    expect(result.totalPaiseByType.payment).toBe(50_000_00);

    // 1 expense (end-boundary) = 5k rupees
    expect(result.countByType.expense).toBe(1);
    expect(result.totalPaiseByType.expense).toBe(5_000_00);

    // April + June rows must NOT appear.
    expect(result.countByType.refund).toBe(0);
    expect(result.totalPaiseByType.refund).toBe(0);

    expect(result.totalCount).toBe(5);
    expect(result.totalPaise).toBe(150_000_00 + 50_000_00 + 5_000_00);
    expect(result.start).toBe(PERIOD_START);
    expect(result.end).toBe(PERIOD_END);
  });

  it("narrows correctly when scope.companyId is set", async () => {
    loginAs("admin", fixture);
    const acme = await getTransactionsSummaryForPeriod({
      start: PERIOD_START,
      end: PERIOD_END,
      companyId: fixture.companyAId,
    });
    expect(acme.ok).toBe(true);
    if (!acme.ok) return;
    // Acme in-period: 2 invoices + 1 payment. BuildRight rows excluded.
    expect(acme.countByType.invoice).toBe(2);
    expect(acme.countByType.payment).toBe(1);
    expect(acme.countByType.expense).toBe(0);
    expect(acme.totalCount).toBe(3);

    const buildright = await getTransactionsSummaryForPeriod({
      start: PERIOD_START,
      end: PERIOD_END,
      companyId: fixture.companyBId,
    });
    expect(buildright.ok).toBe(true);
    if (!buildright.ok) return;
    // BuildRight in-period: 1 payment + 1 expense.
    expect(buildright.countByType.invoice).toBe(0);
    expect(buildright.countByType.payment).toBe(1);
    expect(buildright.countByType.expense).toBe(1);
    expect(buildright.totalCount).toBe(2);
  });

  it("refuses a staff caller", async () => {
    loginAs("staff", fixture);
    const result = await getTransactionsSummaryForPeriod({
      start: PERIOD_START,
      end: PERIOD_END,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });

  it("refuses a company-role caller", async () => {
    loginAs("companyA", fixture);
    const result = await getTransactionsSummaryForPeriod({
      start: PERIOD_START,
      end: PERIOD_END,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);
  });

  it("includes rows on the start day AND the end day (inclusive bounds)", async () => {
    loginAs("admin", fixture);
    // Single-day window on the start; expect the start-boundary
    // invoice only.
    const startOnly = await getTransactionsSummaryForPeriod({
      start: PERIOD_START,
      end: PERIOD_START,
    });
    expect(startOnly.ok).toBe(true);
    if (!startOnly.ok) return;
    expect(startOnly.totalCount).toBe(1);
    expect(startOnly.countByType.invoice).toBe(1);
    expect(startOnly.totalPaiseByType.invoice).toBe(100_000_00);

    // Single-day window on the end; expect just the expense.
    const endOnly = await getTransactionsSummaryForPeriod({
      start: PERIOD_END,
      end: PERIOD_END,
    });
    expect(endOnly.ok).toBe(true);
    if (!endOnly.ok) return;
    expect(endOnly.totalCount).toBe(1);
    expect(endOnly.countByType.expense).toBe(1);
  });
});
