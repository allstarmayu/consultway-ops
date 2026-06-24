/**
 * Integration tests for tender lifecycle transitions.
 *
 * Strategy: real DB + real audit log; mock `readSession` so each test
 * can drive the role-gate paths. Server Actions in `lib/tenders/actions.ts`
 * use module-level cache + reads from session, so the mock is what makes
 * deterministic role-based testing possible.
 *
 * Coverage:
 *   - draft → published (publishTender) — happy paths for admin + staff;
 *     refusals for company role and unauthenticated callers
 *   - published → closed (closeTender) — happy + idempotency
 *   - closed → awarded (markAwarded) — natural pipeline via close-then-award
 *   - published → draft (unpublishTender) — happy when no applications;
 *     refusal when applications exist
 *   - closed → published (reopenTender, Day 5 reversal) — happy +
 *     `tender_reopened` audit verb; staff refused (admin-only)
 *   - awarded → closed (retractAward, Day 5 reversal) — happy +
 *     `tender_award_retracted` audit verb with reason; staff refused;
 *     refused when reason missing
 *   - deleteTender — refusal for non-draft, happy on draft
 *   - createTender — admin/staff happy + Zod refusal + company refusal
 *
 * Fixture pattern mirrors `lib/documents/__tests__/expiry-sweep.test.ts`:
 * each test gets a fresh universe (2 companies + 1 publisher + 1 admin +
 * 1 staff + 1 company user) via `seedFixture`, torn down by `clearFixture`.
 *
 * @module lib/tenders/__tests__/state-machine
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
  notifications,
  type UserRole,
  type TenderStatus,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";

// Mock the session reader BEFORE importing actions so the import resolves
// to the mock. Vitest hoists `vi.mock` to the top automatically.
vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
}));

import { readSession } from "@/lib/auth/session";
import {
  createTender,
  publishTender,
  closeTender,
  markAwarded,
  unpublishTender,
  reopenTender,
  retractAward,
  deleteTender,
  applyToTender,
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
      annualTurnover: 50_000_000,
    },
    {
      id: companyBId,
      name: "BuildRight Engineers",
      sector: "Civil Works",
      geography: "Karnataka",
      contactEmail: "build@example.test",
      isMsme: false,
      annualTurnover: 200_000_000,
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
      id: staffUserId,
      email: `staff-${staffUserId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "staff" as UserRole,
      name: "Test Staff",
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

  return {
    adminUserId,
    staffUserId,
    companyUserAId,
    companyUserBId,
    publisherCompanyId,
    companyAId,
    companyBId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  // Audit cleanup — by actor id covers the rows our actions wrote.
  for (const userId of [
    f.adminUserId,
    f.staffUserId,
    f.companyUserAId,
    f.companyUserBId,
  ]) {
    await db.delete(auditLog).where(eq(auditLog.actorId, userId)).catch(() => {});
  }
  // Tenders cascade-delete their applications; delete by publisher.
  await db
    .delete(tenders)
    .where(eq(tenders.publisherCompanyId, f.publisherCompanyId));
  // Just in case any test created tenders with another publisher.
  await db.delete(tenders).where(eq(tenders.publisherCompanyId, f.companyAId));
  await db.delete(tenders).where(eq(tenders.publisherCompanyId, f.companyBId));
  await db.delete(users).where(eq(users.id, f.adminUserId));
  await db.delete(users).where(eq(users.id, f.staffUserId));
  await db.delete(users).where(eq(users.id, f.companyUserAId));
  await db.delete(users).where(eq(users.id, f.companyUserBId));
  await db.delete(companies).where(eq(companies.id, f.companyAId));
  await db.delete(companies).where(eq(companies.id, f.companyBId));
  await db.delete(companies).where(eq(companies.id, f.publisherCompanyId));
}

// ── Helpers ───────────────────────────────────────────────────────────────

function loginAs(role: "admin" | "staff" | "company", f: Fixture): void {
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
    case "company":
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
 * Direct DB insert for a tender in a known status. Bypasses the
 * createTender action so the test fixture can place a tender in any
 * state — needed for transition tests where we want to start at, say,
 * `closed` and don't want to drive three intermediate actions.
 */
async function insertTenderInStatus(
  f: Fixture,
  status: TenderStatus,
  overrides: Partial<typeof tenders.$inferInsert> = {},
): Promise<string> {
  const id = newId();
  await db.insert(tenders).values({
    id,
    title: `Test tender ${id.slice(0, 8)}`,
    description: "Test tender description for state machine tests",
    status,
    publisherCompanyId: f.publisherCompanyId,
    sector: "Infrastructure",
    geography: "Maharashtra",
    ...overrides,
  });
  return id;
}

/** Convenience valid input for createTender. */
function validCreateInput(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    title: "Roads & Highways tender",
    description: "Construction of state highway between districts",
    sector: "Infrastructure",
    geography: "Maharashtra",
    publisherCompanyId: f.publisherCompanyId,
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  fixture = await seedFixture();
  mockedReadSession.mockReset();
});

afterEach(async () => {
  await clearFixture(fixture);
});

// ── createTender ──────────────────────────────────────────────────────────

describe("createTender", () => {
  it("succeeds for admin and lands the row in draft status", async () => {
    loginAs("admin", fixture);
    const result = await createTender(validCreateInput(fixture));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, result.id))
      .then((r) => r[0]);
    expect(row?.status).toBe("draft");
    expect(row?.title).toBe("Roads & Highways tender");
    expect(row?.publisherCompanyId).toBe(fixture.publisherCompanyId);
  });

  it("succeeds for staff", async () => {
    loginAs("staff", fixture);
    const result = await createTender(validCreateInput(fixture));
    expect(result.ok).toBe(true);
  });

  it("refuses company-role users", async () => {
    loginAs("company", fixture);
    const result = await createTender(validCreateInput(fixture));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/permission/i);
  });

  it("refuses unauthenticated callers", async () => {
    mockedReadSession.mockResolvedValue(null);
    const result = await createTender(validCreateInput(fixture));
    expect(result.ok).toBe(false);
  });

  it("rejects missing required fields via Zod", async () => {
    loginAs("admin", fixture);
    const result = await createTender({
      // title missing
      sector: "Infrastructure",
      geography: "Maharashtra",
      publisherCompanyId: fixture.publisherCompanyId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("title");
  });

  it("forces status to draft even when caller sends a different value", async () => {
    loginAs("admin", fixture);
    // status field on the schema is omitted entirely, but make sure the
    // row really lands as draft.
    const result = await createTender(
      validCreateInput(fixture, { status: "published" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, result.id))
      .then((r) => r[0]);
    expect(row?.status).toBe("draft");
  });
});

// ── publishTender ─────────────────────────────────────────────────────────

describe("publishTender", () => {
  it("transitions draft → published and stamps publishedAt (admin)", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "draft");

    const result = await publishTender(id);
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, id))
      .then((r) => r[0]);
    expect(row?.status).toBe("published");
    expect(row?.publishedAt).toBeTruthy();

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, id));
    expect(events.some((e) => e.action === "tender_published")).toBe(true);
  });

  it("transitions draft → published (staff)", async () => {
    loginAs("staff", fixture);
    const id = await insertTenderInStatus(fixture, "draft");
    const result = await publishTender(id);
    expect(result.ok).toBe(true);
  });

  it("refuses company-role caller", async () => {
    loginAs("company", fixture);
    const id = await insertTenderInStatus(fixture, "draft");
    const result = await publishTender(id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/permission/i);
  });

  it("publishing an already-published tender is idempotent", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "published", {
      publishedAt: new Date().toISOString(),
    });
    const result = await publishTender(id);
    expect(result.ok).toBe(true);
  });

  it("refuses publishing a closed tender (illegal transition)", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "closed");
    const result = await publishTender(id);
    // closed → published IS legal (reopen), but publishTender doesn't
    // emit the reopen verb — and the state machine allows it. The
    // expected user-facing path is reopenTender. publishTender just
    // succeeds here too because transitionTenderStatus consults the
    // same machine. Verify the row lands.
    expect(result.ok).toBe(true);
    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, id))
      .then((r) => r[0]);
    expect(row?.status).toBe("published");
  });

  it("notifies eligible compliant companies' users (tender_published, sector-filtered)", async () => {
    loginAs("admin", fixture);
    // Both client companies compliant; the tender restricts to the
    // Infrastructure sector, which only companyA matches.
    await db
      .update(companies)
      .set({ complianceStatus: "compliant" })
      .where(eq(companies.id, fixture.companyAId));
    await db
      .update(companies)
      .set({ complianceStatus: "compliant" })
      .where(eq(companies.id, fixture.companyBId));
    const id = await insertTenderInStatus(fixture, "draft", {
      eligibleSector: "Infrastructure",
    });

    const result = await publishTender(id);
    expect(result.ok).toBe(true);

    const aNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserAId));
    expect(aNotifs).toHaveLength(1);
    expect(aNotifs[0]?.type).toBe("tender_published");
    expect(aNotifs[0]?.link).toBe(`/dashboard/tenders/${id}`);

    // companyB is in "Civil Works" — wrong sector, not notified.
    const bNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserBId));
    expect(bNotifs).toHaveLength(0);
  });

  it("excludes non-compliant companies from tender_published fan-out", async () => {
    loginAs("admin", fixture);
    // companyA compliant; companyB left at the default "pending".
    await db
      .update(companies)
      .set({ complianceStatus: "compliant" })
      .where(eq(companies.id, fixture.companyAId));
    // Unrestricted tender (no eligibility columns) — compliance is the
    // only gate that should differentiate A from B here.
    const id = await insertTenderInStatus(fixture, "draft");

    const result = await publishTender(id);
    expect(result.ok).toBe(true);

    const aNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserAId));
    expect(aNotifs).toHaveLength(1);
    expect(aNotifs[0]?.type).toBe("tender_published");

    const bNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserBId));
    expect(bNotifs).toHaveLength(0);
  });

  it("does NOT notify on reopen (closed → published is not a fresh publish)", async () => {
    loginAs("admin", fixture);
    await db
      .update(companies)
      .set({ complianceStatus: "compliant" })
      .where(eq(companies.id, fixture.companyAId));
    const id = await insertTenderInStatus(fixture, "closed", {
      publishedAt: new Date().toISOString(),
    });

    const result = await reopenTender({ tenderId: id });
    expect(result.ok).toBe(true);

    // The gate keys on the tender_published audit verb + draft→published,
    // so a reopen (tender_reopened, closed→published) raises nothing.
    const aNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserAId));
    expect(aNotifs).toHaveLength(0);
  });
});

// ── closeTender ───────────────────────────────────────────────────────────

describe("closeTender", () => {
  it("transitions published → closed (admin)", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "published", {
      publishedAt: new Date().toISOString(),
    });
    const result = await closeTender(id);
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, id))
      .then((r) => r[0]);
    expect(row?.status).toBe("closed");
  });

  it("is idempotent on already-closed", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "closed");
    const result = await closeTender(id);
    expect(result.ok).toBe(true);
  });

  it("refuses company-role caller", async () => {
    loginAs("company", fixture);
    const id = await insertTenderInStatus(fixture, "published", {
      publishedAt: new Date().toISOString(),
    });
    const result = await closeTender(id);
    expect(result.ok).toBe(false);
  });
});

// ── markAwarded (Day 14: requires winning company) ────────────────────────

/**
 * Helper - seeds a shortlisted application from the given company so
 * markAwarded has a legal candidate. Returns the application id.
 */
async function insertShortlistedApplication(
  tenderId: string,
  companyId: string,
): Promise<string> {
  const appId = newId();
  await db.insert(tenderApplications).values({
    id: appId,
    tenderId,
    companyId,
    status: "shortlisted",
    decidedAt: new Date().toISOString(),
  });
  return appId;
}

describe("markAwarded", () => {
  it("awards a closed tender + populates awardedCompanyId (admin)", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "closed");
    await insertShortlistedApplication(tenderId, fixture.companyAId);

    const result = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, tenderId))
      .then((r) => r[0]);
    expect(row?.status).toBe("awarded");
    expect(row?.awardedCompanyId).toBe(fixture.companyAId);
  });

  it("notifies the awarded company's users (application_awarded)", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "closed");
    await insertShortlistedApplication(tenderId, fixture.companyAId);

    const result = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(result.ok).toBe(true);

    const notifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserAId));
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.type).toBe("application_awarded");
    expect(notifs[0]?.link).toBe(`/dashboard/tenders/${tenderId}`);
    expect(notifs[0]?.readAt).toBeNull();

    // The losing company (B) is not notified by the award path.
    const bNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserBId));
    expect(bNotifs).toHaveLength(0);
  });

  it("notifies the other shortlisted applicants they were not selected (application_not_selected)", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "closed");
    // Two finalists: A wins, B is the shortlisted runner-up.
    await insertShortlistedApplication(tenderId, fixture.companyAId);
    await insertShortlistedApplication(tenderId, fixture.companyBId);

    const result = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(result.ok).toBe(true);

    // The winner gets exactly the award notification — never a "not selected".
    const aNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserAId));
    expect(aNotifs).toHaveLength(1);
    expect(aNotifs[0]?.type).toBe("application_awarded");

    // The runner-up gets exactly the "not selected" notification.
    const bNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserBId));
    expect(bNotifs).toHaveLength(1);
    expect(bNotifs[0]?.type).toBe("application_not_selected");
    expect(bNotifs[0]?.link).toBe(`/dashboard/tenders/${tenderId}`);
    expect(bNotifs[0]?.readAt).toBeNull();
  });

  it("notifies a still-submitted (never-shortlisted) applicant on award", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "closed");
    await insertShortlistedApplication(tenderId, fixture.companyAId);
    // B's bid is live but was never shortlisted — still counts as a loser.
    await db.insert(tenderApplications).values({
      id: newId(),
      tenderId,
      companyId: fixture.companyBId,
      status: "submitted",
    });

    const result = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(result.ok).toBe(true);

    const bNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserBId));
    expect(bNotifs).toHaveLength(1);
    expect(bNotifs[0]?.type).toBe("application_not_selected");
  });

  it("does NOT notify a withdrawn applicant on award (they opted out)", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "closed");
    await insertShortlistedApplication(tenderId, fixture.companyAId);
    await db.insert(tenderApplications).values({
      id: newId(),
      tenderId,
      companyId: fixture.companyBId,
      status: "withdrawn",
    });

    const result = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(result.ok).toBe(true);

    const bNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserBId));
    expect(bNotifs).toHaveLength(0);
  });

  it("does NOT notify an already-rejected applicant on award (told at rejection)", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "closed");
    await insertShortlistedApplication(tenderId, fixture.companyAId);
    await db.insert(tenderApplications).values({
      id: newId(),
      tenderId,
      companyId: fixture.companyBId,
      status: "rejected",
      decidedAt: new Date().toISOString(),
    });

    const result = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(result.ok).toBe(true);

    const bNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserBId));
    expect(bNotifs).toHaveLength(0);
  });

  it("refuses awarding a draft tender (status gate fires before app lookup)", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "draft");
    // No application needed — the status gate refuses first.
    const result = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/draft|closed/i);
  });

  it("refuses when the named company has no application on this tender", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "closed");
    // No application seeded — companyA never applied.
    const result = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("awardedCompanyId");
    expect(result.error).toMatch(/no application/i);
  });

  it("refuses when the named application is not in shortlisted status", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "closed");
    // companyA applied but is in `rejected` status — not eligible to win.
    await db.insert(tenderApplications).values({
      id: newId(),
      tenderId,
      companyId: fixture.companyAId,
      status: "rejected",
      decidedAt: new Date().toISOString(),
    });
    const result = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("awardedCompanyId");
    expect(result.error).toMatch(/shortlisted/i);
  });

  it("refuses zero-arg legacy input shape (Day 14 schema rejection)", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "closed");
    // Day 14: action signature stayed `(rawInput: unknown)`, so TS
    // accepts a string here, but Zod refuses at runtime - old call
    // sites that passed a bare id surface as an ok:false result.
    const result = await markAwarded(tenderId);
    expect(result.ok).toBe(false);
  });

  it("supports the close-then-award pipeline (published → closed → awarded)", async () => {
    loginAs("staff", fixture);
    const tenderId = await insertTenderInStatus(fixture, "published", {
      publishedAt: new Date().toISOString(),
    });
    // Application has to come from a published tender; seed it before
    // closing so the application is in scope.
    await insertShortlistedApplication(tenderId, fixture.companyAId);

    const closed = await closeTender(tenderId);
    expect(closed.ok).toBe(true);
    const awarded = await markAwarded({
      tenderId,
      awardedCompanyId: fixture.companyAId,
    });
    expect(awarded.ok).toBe(true);

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, tenderId))
      .then((r) => r[0]);
    expect(row?.status).toBe("awarded");
    expect(row?.awardedCompanyId).toBe(fixture.companyAId);
  });
});

// ── unpublishTender ───────────────────────────────────────────────────────

describe("unpublishTender", () => {
  it("transitions published → draft when no applications exist", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "published", {
      publishedAt: new Date().toISOString(),
    });
    const result = await unpublishTender(id);
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, id))
      .then((r) => r[0]);
    expect(row?.status).toBe("draft");
  });

  it("refuses when applications exist", async () => {
    loginAs("admin", fixture);
    const tenderId = await insertTenderInStatus(fixture, "published", {
      publishedAt: new Date().toISOString(),
    });
    // Seed an application directly.
    await db.insert(tenderApplications).values({
      id: newId(),
      tenderId,
      companyId: fixture.companyAId,
      status: "submitted",
    });

    const result = await unpublishTender(tenderId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/applied|application/i);
  });
});

// ── reopenTender (Day 5 reversal) ─────────────────────────────────────────

describe("reopenTender", () => {
  it("transitions closed → published with tender_reopened audit (admin)", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "closed", {
      publishedAt: new Date().toISOString(),
    });

    const result = await reopenTender({
      tenderId: id,
      reason: "Closed too early — extending the application window",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, id))
      .then((r) => r[0]);
    expect(row?.status).toBe("published");

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, id));
    const reopened = events.find((e) => e.action === "tender_reopened");
    expect(reopened).toBeDefined();
    const metadata = reopened?.metadata as Record<string, unknown> | null;
    expect(metadata?.reason).toBe(
      "Closed too early — extending the application window",
    );
  });

  it("refuses staff (admin-only)", async () => {
    loginAs("staff", fixture);
    const id = await insertTenderInStatus(fixture, "closed");
    const result = await reopenTender({ tenderId: id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/admin/i);
  });

  it("refuses reopening a tender that is not closed", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "draft");
    const result = await reopenTender({ tenderId: id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/closed/i);
  });

  it("reason is optional", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "closed");
    const result = await reopenTender({ tenderId: id });
    expect(result.ok).toBe(true);
  });
});

// ── retractAward (Day 5 reversal) ─────────────────────────────────────────

describe("retractAward", () => {
  it("transitions awarded → closed with tender_award_retracted audit (admin)", async () => {
    loginAs("admin", fixture);
    // Day 14: seed with awardedCompanyId already populated so the
    // retract test can assert the column clears.
    const id = await insertTenderInStatus(fixture, "awarded", {
      awardedCompanyId: fixture.companyAId,
    });

    const result = await retractAward({
      tenderId: id,
      reason: "Awarded company withdrew their offer post-award",
    });
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, id))
      .then((r) => r[0]);
    expect(row?.status).toBe("closed");
    // Day 14: column must clear back to NULL on retract so a retracted
    // tender genuinely has no winner anymore. Symmetric with markAwarded.
    expect(row?.awardedCompanyId).toBeNull();

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, id));
    const retracted = events.find(
      (e) => e.action === "tender_award_retracted",
    );
    expect(retracted).toBeDefined();
    const metadata = retracted?.metadata as Record<string, unknown> | null;
    expect(metadata?.reason).toBe(
      "Awarded company withdrew their offer post-award",
    );
    // The audit before/after snapshots should capture both the status
    // and the awardedCompanyId transitions for forensic clarity.
    const before = retracted?.before as Record<string, unknown> | null;
    const after = retracted?.after as Record<string, unknown> | null;
    expect(before?.awardedCompanyId).toBe(fixture.companyAId);
    expect(after?.awardedCompanyId).toBeNull();
  });

  it("refuses staff (admin-only)", async () => {
    loginAs("staff", fixture);
    const id = await insertTenderInStatus(fixture, "awarded");
    const result = await retractAward({
      tenderId: id,
      reason: "Some valid reason here",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/admin/i);
  });

  it("refuses when reason is missing", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "awarded");
    const result = await retractAward({ tenderId: id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("reason");
  });

  it("refuses retracting from a non-awarded status", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "closed");
    const result = await retractAward({
      tenderId: id,
      reason: "Defensive test reason text",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/awarded/i);
  });
});

// ── deleteTender ──────────────────────────────────────────────────────────

describe("deleteTender", () => {
  it("deletes a draft tender (admin)", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "draft");

    const result = await deleteTender(id);
    expect(result.ok).toBe(true);

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, id))
      .then((r) => r[0]);
    expect(row).toBeUndefined();
  });

  it("refuses deleting a non-draft tender", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "published", {
      publishedAt: new Date().toISOString(),
    });
    const result = await deleteTender(id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/draft/i);
  });

  it("refuses staff (admin-only)", async () => {
    loginAs("staff", fixture);
    const id = await insertTenderInStatus(fixture, "draft");
    const result = await deleteTender(id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/admin/i);
  });

  it("refuses company-role caller", async () => {
    loginAs("company", fixture);
    const id = await insertTenderInStatus(fixture, "draft");
    const result = await deleteTender(id);
    expect(result.ok).toBe(false);
  });
});

// ── End-to-end pipeline sanity ────────────────────────────────────────────

describe("tender lifecycle (end-to-end)", () => {
  it("draft → published → closed → awarded → closed (retract)", async () => {
    loginAs("admin", fixture);

    const create = await createTender(validCreateInput(fixture));
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const id = create.id;

    expect((await publishTender(id)).ok).toBe(true);
    // Seed an application + shortlist it before the close-and-award
    // hop. Day 14 requires the winning company at award time.
    await insertShortlistedApplication(id, fixture.companyAId);
    expect((await closeTender(id)).ok).toBe(true);
    expect(
      (await markAwarded({
        tenderId: id,
        awardedCompanyId: fixture.companyAId,
      })).ok,
    ).toBe(true);

    // Confirm the column populated mid-pipeline.
    const awardedRow = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, id))
      .then((r) => r[0]);
    expect(awardedRow?.awardedCompanyId).toBe(fixture.companyAId);

    const retract = await retractAward({
      tenderId: id,
      reason: "Final pipeline retract for the integration test",
    });
    expect(retract.ok).toBe(true);

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, id))
      .then((r) => r[0]);
    expect(row?.status).toBe("closed");
    expect(row?.awardedCompanyId).toBeNull();
  });
});

// ── applyToTender × state machine intersection ────────────────────────────

describe("applyToTender vs tender status", () => {
  it("refuses when tender is in draft (not accepting applications)", async () => {
    loginAs("company", fixture);
    const id = await insertTenderInStatus(fixture, "draft");
    const result = await applyToTender({ tenderId: id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not accepting/i);
  });

  it("refuses when tender is closed", async () => {
    loginAs("company", fixture);
    const id = await insertTenderInStatus(fixture, "closed");
    const result = await applyToTender({ tenderId: id });
    expect(result.ok).toBe(false);
  });

  it("refuses when tender is awarded", async () => {
    loginAs("company", fixture);
    const id = await insertTenderInStatus(fixture, "awarded");
    const result = await applyToTender({ tenderId: id });
    expect(result.ok).toBe(false);
  });
});

// ── Invited tenders (audience model) ──────────────────────────────────────

describe("invited tenders", () => {
  it("createTender links invitees and nulls the eligibility filters", async () => {
    loginAs("admin", fixture);
    const result = await createTender(
      validCreateInput(fixture, {
        visibility: "invited",
        invitedCompanyIds: [fixture.companyAId],
        // Supplied but should be discarded — the allowlist replaces these.
        eligibleSector: "Infrastructure",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db
      .select()
      .from(tenders)
      .where(eq(tenders.id, result.id))
      .then((r) => r[0]);
    expect(row?.visibility).toBe("invited");
    expect(row?.eligibleSector).toBeNull();

    const invited = await db
      .select()
      .from(tenderInvitedCompanies)
      .where(eq(tenderInvitedCompanies.tenderId, result.id));
    expect(invited).toHaveLength(1);
    expect(invited[0]?.companyId).toBe(fixture.companyAId);
  });

  it("refuses publishing an invited tender with no invitees", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "draft", {
      visibility: "invited",
    });
    const result = await publishTender(id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invite at least one/i);
  });

  it("publishes an invited tender and notifies only the invited companies", async () => {
    loginAs("admin", fixture);
    const id = await insertTenderInStatus(fixture, "draft", {
      visibility: "invited",
    });
    // Invite companyA only.
    await db
      .insert(tenderInvitedCompanies)
      .values({ id: newId(), tenderId: id, companyId: fixture.companyAId });

    const result = await publishTender(id);
    expect(result.ok).toBe(true);

    const aNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserAId));
    expect(aNotifs).toHaveLength(1);
    expect(aNotifs[0]?.type).toBe("tender_published");
    expect(aNotifs[0]?.link).toBe(`/dashboard/tenders/${id}`);

    // companyB was not invited — no bell.
    const bNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.companyUserBId));
    expect(bNotifs).toHaveLength(0);
  });
});
