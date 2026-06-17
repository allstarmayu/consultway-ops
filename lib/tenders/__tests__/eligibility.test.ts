/**
 * Integration tests for the `applyToTender` eligibility gate matrix.
 *
 * The action layers six independent gates before letting an application
 * land:
 *
 *   1. Tender status accepts applications (`published` only)
 *   2. Closing date hasn't passed
 *   3. Sector match (if `eligibleSector` set on tender)
 *   4. Geography match (if `eligibleGeography` set)
 *   5. MSME-only match (if `msmeOnly` true)
 *   6. Turnover floor (Day 8): tender minimum vs company `annualTurnover`.
 *      NULL on the company side is a hard refusal when the tender sets
 *      a minimum.
 *
 * Plus the composite-unique duplicate-application guard.
 *
 * Each test exercises one gate in isolation by setting up a tender that
 * fails ONLY that gate, then asserting refusal with the expected message
 * shape. Happy-path tests confirm a fully-eligible applicant lands the
 * row + writes the `tender_applied` audit event.
 *
 * Fixture mirrors the state-machine test file's seed shape.
 *
 * @module lib/tenders/__tests__/eligibility
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
  tenders,
  tenderApplications,
  tenderInvitedCompanies,
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
import { applyToTender } from "../actions";

const mockedReadSession = readSession as MockedFunction<typeof readSession>;

// ── Fixture ───────────────────────────────────────────────────────────────

interface Fixture {
  adminUserId: string;
  /** Applicant company user — Infrastructure / Maharashtra / MSME, ₹5cr turnover. */
  companyUserAId: string;
  /** Non-MSME applicant — Civil Works / Karnataka, ₹20cr turnover. */
  companyUserBId: string;
  /** Applicant with NULL annualTurnover. */
  companyUserCId: string;

  publisherCompanyId: string;
  companyAId: string;
  companyBId: string;
  companyCId: string;
}

let fixture: Fixture;

async function seedFixture(): Promise<Fixture> {
  const publisherCompanyId = newId();
  const companyAId = newId();
  const companyBId = newId();
  const companyCId = newId();
  const adminUserId = newId();
  const companyUserAId = newId();
  const companyUserBId = newId();
  const companyUserCId = newId();

  await db.insert(companies).values([
    {
      id: publisherCompanyId,
      name: "Consultway Infotech",
      sector: "Consulting",
      geography: "Maharashtra",
      contactEmail: "ops@consultway.local",
    },
    {
      id: companyAId,
      name: "Acme Construction",
      sector: "Infrastructure",
      geography: "Maharashtra",
      contactEmail: "acme@example.test",
      isMsme: true,
      annualTurnover: 50_000_000, // ₹5 crore
    },
    {
      id: companyBId,
      name: "BuildRight Engineers",
      sector: "Civil Works",
      geography: "Karnataka",
      contactEmail: "build@example.test",
      isMsme: false,
      annualTurnover: 200_000_000, // ₹20 crore
    },
    {
      id: companyCId,
      name: "Unstated Turnover Co",
      sector: "Infrastructure",
      geography: "Maharashtra",
      contactEmail: "unstated@example.test",
      isMsme: true,
      annualTurnover: null,
    },
  ]);

  await db.insert(users).values([
    {
      id: adminUserId,
      email: `admin-${adminUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "admin" as UserRole,
      name: "Test Admin",
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
      email: `unstated-${companyUserCId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "company" as UserRole,
      companyId: companyCId,
      name: "Unstated Contact",
    },
  ]);

  return {
    adminUserId,
    companyUserAId,
    companyUserBId,
    companyUserCId,
    publisherCompanyId,
    companyAId,
    companyBId,
    companyCId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  for (const userId of [
    f.adminUserId,
    f.companyUserAId,
    f.companyUserBId,
    f.companyUserCId,
  ]) {
    await db.delete(auditLog).where(eq(auditLog.actorId, userId)).catch(() => {});
  }
  await db
    .delete(tenders)
    .where(eq(tenders.publisherCompanyId, f.publisherCompanyId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(users).where(eq(users.id, f.companyUserBId));
  await db.delete(users).where(eq(users.id, f.companyUserCId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
  await db.delete(companies).where(eq(companies.id, f.companyCId));
  await db.delete(companies).where(eq(companies.id, f.publisherCompanyId));
}

// ── Helpers ───────────────────────────────────────────────────────────────

function loginAsCompany(companyUserId: string, companyId: string): void {
  mockedReadSession.mockResolvedValue({
    userId: companyUserId,
    role: "company",
    companyId,
    email: "test@local",
  });
}

async function insertTender(
  f: Fixture,
  status: TenderStatus,
  overrides: Partial<typeof tenders.$inferInsert> = {},
): Promise<string> {
  const id = newId();
  await db.insert(tenders).values({
    id,
    title: `Eligibility test tender ${id.slice(0, 8)}`,
    description: "Eligibility-matrix tender",
    status,
    publisherCompanyId: f.publisherCompanyId,
    sector: "Infrastructure",
    geography: "Maharashtra",
    ...(status === "published"
      ? { publishedAt: new Date().toISOString() }
      : {}),
    ...overrides,
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

// ── Happy path ────────────────────────────────────────────────────────────

describe("applyToTender — happy path", () => {
  it("succeeds for an eligible applicant + writes tender_applied audit", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "published");

    const result = await applyToTender({
      tenderId,
      coverNote: "We have a strong record in highway construction.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applicationId).toMatch(/^[0-9a-f-]{36}$/);

    const appRow = await db
      .select()
      .from(tenderApplications)
      .where(eq(tenderApplications.id, result.applicationId))
      .then((r) => r[0]);
    expect(appRow?.status).toBe("submitted");
    expect(appRow?.companyId).toBe(fixture.companyAId);

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, tenderId));
    expect(events.some((e) => e.action === "tender_applied")).toBe(true);
  });

  it("succeeds when no eligibility filters set on tender", async () => {
    loginAsCompany(fixture.companyUserBId, fixture.companyBId);
    const tenderId = await insertTender(fixture, "published", {
      eligibleSector: null,
      eligibleGeography: null,
      msmeOnly: false,
      minAnnualTurnoverInr: null,
    });

    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(true);
  });
});

// ── Sector / geography / MSME gates ───────────────────────────────────────

describe("applyToTender — sector / geography / MSME gates", () => {
  it("refuses on sector mismatch", async () => {
    loginAsCompany(fixture.companyUserBId, fixture.companyBId);
    // Tender requires Infrastructure; applicant B is Civil Works.
    const tenderId = await insertTender(fixture, "published", {
      eligibleSector: "Infrastructure",
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/sector/i);
    expect(result.error).toMatch(/Infrastructure/);
  });

  it("refuses on geography mismatch", async () => {
    loginAsCompany(fixture.companyUserBId, fixture.companyBId);
    // Tender requires Maharashtra; applicant B is Karnataka.
    const tenderId = await insertTender(fixture, "published", {
      eligibleGeography: "Maharashtra",
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/geography/i);
  });

  it("refuses non-MSME applicant on msmeOnly tender", async () => {
    loginAsCompany(fixture.companyUserBId, fixture.companyBId);
    const tenderId = await insertTender(fixture, "published", {
      msmeOnly: true,
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/MSME/i);
  });

  it("MSME applicant passes the msmeOnly gate", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "published", {
      msmeOnly: true,
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(true);
  });
});

// ── Turnover gate (Day 8) ─────────────────────────────────────────────────

describe("applyToTender — turnover gate (Day 8)", () => {
  it("refuses applicant below the minimum", async () => {
    // Applicant A's turnover = ₹5cr; tender requires ₹10cr.
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "published", {
      minAnnualTurnoverInr: 100_000_000,
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/turnover/i);
    // Surfaces the figure so the company knows the gap.
    expect(result.error).toMatch(/10,00,00,000/);
  });

  it("refuses applicant with NULL annualTurnover (unstated figures unverifiable)", async () => {
    loginAsCompany(fixture.companyUserCId, fixture.companyCId);
    const tenderId = await insertTender(fixture, "published", {
      minAnnualTurnoverInr: 50_000_000,
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("annualTurnover");
    expect(result.error).toMatch(/turnover/i);
  });

  it("admits applicant meeting the minimum exactly", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "published", {
      minAnnualTurnoverInr: 50_000_000, // matches Acme exactly
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(true);
  });

  it("admits applicant above the minimum", async () => {
    loginAsCompany(fixture.companyUserBId, fixture.companyBId);
    const tenderId = await insertTender(fixture, "published", {
      minAnnualTurnoverInr: 100_000_000, // BuildRight has ₹20cr
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(true);
  });

  it("NULL minAnnualTurnoverInr skips the gate even for unstated applicants", async () => {
    loginAsCompany(fixture.companyUserCId, fixture.companyCId);
    const tenderId = await insertTender(fixture, "published", {
      minAnnualTurnoverInr: null,
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(true);
  });
});

// ── Closing-date gate ─────────────────────────────────────────────────────

describe("applyToTender — closing-date gate", () => {
  it("refuses when closingDate has passed", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "published", {
      closingDate: "2020-01-01",
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/closed/i);
  });

  it("admits when closingDate is in the future", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "published", {
      closingDate: "2099-12-31",
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(true);
  });

  it("admits when closingDate is NULL (open-ended)", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "published", {
      closingDate: null,
    });
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(true);
  });
});

// ── Status gate ───────────────────────────────────────────────────────────

describe("applyToTender — status gate", () => {
  it("refuses on draft tender", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "draft");
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not accepting/i);
  });

  it("refuses on closed tender", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "closed");
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
  });

  it("refuses on awarded tender", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "awarded");
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
  });
});

// ── Duplicate guard ───────────────────────────────────────────────────────

describe("applyToTender — duplicate guard", () => {
  it("refuses a second application from the same company", async () => {
    loginAsCompany(fixture.companyUserAId, fixture.companyAId);
    const tenderId = await insertTender(fixture, "published");

    const first = await applyToTender({ tenderId });
    expect(first.ok).toBe(true);

    const second = await applyToTender({ tenderId });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already applied/i);
  });
});

// ── Auth gates ────────────────────────────────────────────────────────────

describe("applyToTender — auth gates", () => {
  it("refuses unauthenticated callers", async () => {
    mockedReadSession.mockResolvedValue(null);
    const tenderId = await insertTender(fixture, "published");
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
  });

  it("refuses admin role (company-only action)", async () => {
    mockedReadSession.mockResolvedValue({
      userId: fixture.adminUserId,
      role: "admin",
      companyId: null,
      email: "admin@test.local",
    });
    const tenderId = await insertTender(fixture, "published");
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/company users/i);
  });
});

// ── Invited tenders ───────────────────────────────────────────────────────

async function inviteCompany(
  tenderId: string,
  companyId: string,
): Promise<void> {
  await db
    .insert(tenderInvitedCompanies)
    .values({ id: newId(), tenderId, companyId });
}

describe("applyToTender — invited tenders", () => {
  it("refuses a company that is not on the invite list", async () => {
    loginAsCompany(fixture.companyUserBId, fixture.companyBId);
    const tenderId = await insertTender(fixture, "published", {
      visibility: "invited",
    });
    await inviteCompany(tenderId, fixture.companyAId); // A invited, not B
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invite list/i);
  });

  it("allows an invited company and bypasses the eligibility filters", async () => {
    // companyB is Civil Works / Karnataka / non-MSME / ₹20cr — it would fail
    // every one of these eligibility gates on an OPEN tender. On an invited
    // tender the allowlist is the sole gate, so the application still lands.
    loginAsCompany(fixture.companyUserBId, fixture.companyBId);
    const tenderId = await insertTender(fixture, "published", {
      visibility: "invited",
      eligibleSector: "Infrastructure",
      eligibleGeography: "Maharashtra",
      msmeOnly: true,
      minAnnualTurnoverInr: 1_000_000_000, // ₹100cr
    });
    await inviteCompany(tenderId, fixture.companyBId);
    const result = await applyToTender({ tenderId });
    expect(result.ok).toBe(true);
  });
});
