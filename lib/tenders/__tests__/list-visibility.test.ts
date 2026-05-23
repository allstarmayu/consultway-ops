/**
 * Integration tests for `listTenders` visibility rules and the Day-14
 * SQL OR refactor.
 *
 * Pre-Day-14 the company-role visibility ("non-drafts ∪ own drafts")
 * was applied as a JS post-filter after fetching the page, which made
 * the `total` count an approximation. The refactor folds the rule into
 * the WHERE clause; this file pins the accurate behaviour so a future
 * "we're back to JS-filtering" regression surfaces here first.
 *
 * Coverage:
 *   - admin / staff see every tender regardless of status
 *   - company-role caller sees: non-drafts (always) + own drafts (as
 *     publisher); other-publisher drafts are invisible
 *   - explicit `status=draft` for a company-role caller returns only
 *     own drafts
 *   - `total` matches the actual visible row count exactly (not
 *     approximated)
 *   - layered sector / geography / search filters compose with the
 *     visibility scope correctly
 *   - pagination respects the SQL-side count
 *
 * Fixture layout (one publisher Consultway, two real companies; varied
 * statuses with deterministic counts):
 *
 *     publisher = Consultway Infotech
 *     companyA  = Acme Construction (Infrastructure / MH)
 *     companyB  = BuildRight Engineers (Civil Works / KA)
 *
 *     Tenders seeded:
 *       - Consultway-published:    1 draft, 2 published, 1 closed, 1 awarded
 *       - companyA-published:      1 draft, 1 published
 *       - companyB-published:      1 draft
 *
 *     Visibility totals:
 *       - admin / staff           => 8
 *       - companyA viewer         => 6 (sees own draft, hides Consultway
 *                                       draft + companyB draft)
 *       - companyB viewer         => 6 (sees own draft, hides Consultway
 *                                       draft + companyA draft)
 *
 * @module lib/tenders/__tests__/list-visibility
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
import { listTenders } from "../actions";

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
  // Tender ids - kept on the fixture so per-test assertions can target
  // specific rows without re-querying.
  publisherDraftId: string;
  publisherPublished1Id: string;
  publisherPublished2Id: string;
  publisherClosedId: string;
  publisherAwardedId: string;
  companyADraftId: string;
  companyAPublishedId: string;
  companyBDraftId: string;
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
    {
      id: companyUserBId,
      email: `build-${companyUserBId}@test.local`,
      passwordHash: "$2a$10$test",
      role: "company" as UserRole,
      companyId: companyBId,
      name: "Build Contact",
    },
  ]);

  // Tenders. Sectors / geographies chosen to enable layered-filter tests.
  const publisherDraftId = newId();
  const publisherPublished1Id = newId();
  const publisherPublished2Id = newId();
  const publisherClosedId = newId();
  const publisherAwardedId = newId();
  const companyADraftId = newId();
  const companyAPublishedId = newId();
  const companyBDraftId = newId();

  const publishedAt = new Date().toISOString();

  await db.insert(tenders).values([
    {
      id: publisherDraftId,
      title: "Consultway draft - solar EPC",
      description: "Solar EPC tender (draft)",
      status: "draft" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Solar EPC",
      geography: "Maharashtra",
    },
    {
      id: publisherPublished1Id,
      title: "Consultway published 1 - infrastructure",
      description: "Infrastructure tender 1 (published)",
      status: "published" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt,
    },
    {
      id: publisherPublished2Id,
      title: "Consultway published 2 - civil works",
      description: "Civil works tender (published)",
      status: "published" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Civil Works",
      geography: "Karnataka",
      publishedAt,
    },
    {
      id: publisherClosedId,
      title: "Consultway closed - roads",
      description: "Roads tender (closed)",
      status: "closed" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Roads & Highways",
      geography: "Maharashtra",
      publishedAt,
    },
    {
      id: publisherAwardedId,
      title: "Consultway awarded - infrastructure pilot",
      description: "Infrastructure pilot (awarded)",
      status: "awarded" satisfies TenderStatus,
      publisherCompanyId,
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt,
    },
    {
      id: companyADraftId,
      title: "Acme subcontract - draft",
      description: "Acme subcontracting tender (draft)",
      status: "draft" satisfies TenderStatus,
      publisherCompanyId: companyAId,
      sector: "Infrastructure",
      geography: "Maharashtra",
    },
    {
      id: companyAPublishedId,
      title: "Acme subcontract - published",
      description: "Acme subcontracting tender (published)",
      status: "published" satisfies TenderStatus,
      publisherCompanyId: companyAId,
      sector: "Infrastructure",
      geography: "Maharashtra",
      publishedAt,
    },
    {
      id: companyBDraftId,
      title: "BuildRight subcontract - draft",
      description: "BuildRight subcontracting tender (draft)",
      status: "draft" satisfies TenderStatus,
      publisherCompanyId: companyBId,
      sector: "Civil Works",
      geography: "Karnataka",
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
    publisherDraftId,
    publisherPublished1Id,
    publisherPublished2Id,
    publisherClosedId,
    publisherAwardedId,
    companyADraftId,
    companyAPublishedId,
    companyBDraftId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
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

function loginAs(
  role: "admin" | "staff" | "companyA" | "companyB",
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

describe("listTenders visibility - admin / staff", () => {
  it("admin sees every tender across publishers and statuses", async () => {
    loginAs("admin", fixture);
    const result = await listTenders({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(8);
    expect(result.rows).toHaveLength(8);
  });

  it("staff sees every tender across publishers and statuses", async () => {
    loginAs("staff", fixture);
    const result = await listTenders({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(8);
    expect(result.rows).toHaveLength(8);
  });

  it("admin filtering by status=draft returns all three drafts (no scope)", async () => {
    loginAs("admin", fixture);
    const result = await listTenders({ status: "draft", perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(3);
  });
});

describe("listTenders visibility - company role", () => {
  it("companyA sees non-drafts plus own draft (hides other-publisher drafts)", async () => {
    loginAs("companyA", fixture);
    const result = await listTenders({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Visible: 4 Consultway non-drafts + 1 Acme published + 1 Acme draft = 6
    expect(result.total).toBe(6);
    expect(result.rows).toHaveLength(6);

    const visibleIds = new Set(result.rows.map((r) => r.id));
    // Visible to companyA
    expect(visibleIds.has(fixture.companyADraftId)).toBe(true);
    expect(visibleIds.has(fixture.companyAPublishedId)).toBe(true);
    expect(visibleIds.has(fixture.publisherPublished1Id)).toBe(true);
    expect(visibleIds.has(fixture.publisherAwardedId)).toBe(true);
    // Hidden from companyA
    expect(visibleIds.has(fixture.publisherDraftId)).toBe(false);
    expect(visibleIds.has(fixture.companyBDraftId)).toBe(false);
  });

  it("companyB sees non-drafts plus own draft (hides Consultway + Acme drafts)", async () => {
    loginAs("companyB", fixture);
    const result = await listTenders({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.total).toBe(6);
    expect(result.rows).toHaveLength(6);

    const visibleIds = new Set(result.rows.map((r) => r.id));
    expect(visibleIds.has(fixture.companyBDraftId)).toBe(true);
    expect(visibleIds.has(fixture.companyADraftId)).toBe(false);
    expect(visibleIds.has(fixture.publisherDraftId)).toBe(false);
  });

  it("explicit status=draft for companyA returns only own drafts", async () => {
    loginAs("companyA", fixture);
    const result = await listTenders({ status: "draft", perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.total).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe(fixture.companyADraftId);
  });

  it("explicit status=draft for companyB returns only own drafts", async () => {
    loginAs("companyB", fixture);
    const result = await listTenders({ status: "draft", perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe(fixture.companyBDraftId);
  });

  it("explicit status=published for companyA returns all published (own + Consultway)", async () => {
    loginAs("companyA", fixture);
    const result = await listTenders({ status: "published", perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 2 Consultway published + 1 Acme published = 3
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(3);
  });

  it("strips internalNotes for company-role callers", async () => {
    loginAs("companyA", fixture);
    // Plant an internalNotes string on the published tender directly.
    await db
      .update(tenders)
      .set({ internalNotes: "staff-only working notes" })
      .where(eq(tenders.id, fixture.publisherPublished1Id));

    const result = await listTenders({ perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.rows.find((r) => r.id === fixture.publisherPublished1Id);
    expect(row?.internalNotes).toBeNull();
  });
});

describe("listTenders visibility composes with layered filters", () => {
  it("companyA + sector=Infrastructure: own Infra published + Consultway Infra non-drafts", async () => {
    loginAs("companyA", fixture);
    const result = await listTenders({
      sector: "Infrastructure",
      perPage: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Infra tenders visible:
    //   Consultway published 1 (Infra), Consultway awarded (Infra),
    //   companyA published (Infra), companyA draft (Infra, OWN draft).
    //   = 4 total
    expect(result.total).toBe(4);
    expect(result.rows).toHaveLength(4);

    const ids = new Set(result.rows.map((r) => r.id));
    expect(ids.has(fixture.companyADraftId)).toBe(true);
    // companyB's draft is Civil Works, so excluded by sector anyway; the
    // visibility filter also excludes it. Confirm both layers compose.
    expect(ids.has(fixture.companyBDraftId)).toBe(false);
  });

  it("companyB + geography=Karnataka: visible KA tenders only (own draft + Consultway KA pub)", async () => {
    loginAs("companyB", fixture);
    const result = await listTenders({
      geography: "Karnataka",
      perPage: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // KA tenders visible to companyB:
    //   Consultway published 2 (KA, Civil Works) + companyB draft (KA, OWN)
    //   = 2 total
    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(2);

    const ids = new Set(result.rows.map((r) => r.id));
    expect(ids.has(fixture.companyBDraftId)).toBe(true);
    expect(ids.has(fixture.publisherPublished2Id)).toBe(true);
  });

  it("companyA + search=Acme: matches own published + own draft (title LIKE)", async () => {
    loginAs("companyA", fixture);
    const result = await listTenders({ search: "Acme", perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Both Acme tenders have "Acme" in the title; the draft is visible
    // because companyA is the publisher.
    expect(result.total).toBe(2);
    expect(result.rows).toHaveLength(2);
  });

  it("companyB + search=Acme: still finds zero (Acme draft is invisible)", async () => {
    loginAs("companyB", fixture);
    // companyB cannot see companyA's draft; the published-Acme tender
    // matches the search BUT is visible (it's published, so non-draft).
    // The Acme DRAFT is invisible. Expected: 1 result (the published one).
    const result = await listTenders({ search: "Acme", perPage: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(1);
    expect(result.rows[0]?.id).toBe(fixture.companyAPublishedId);
  });

  it("pagination respects the SQL-side count (perPage=3, page=1 → first 3 of 6)", async () => {
    loginAs("companyA", fixture);
    // 6 visible tenders, perPage=3 → page 1 has 3 rows, total=6.
    // Pre-Day-14 this is exactly the case where the JS post-filter
    // would have produced an off-by-N count (subtracting only the
    // other-publisher drafts that fell on the current page).
    const result = await listTenders({
      perPage: 3,
      page: 1,
      sortBy: "createdAt",
      sortDir: "asc",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total).toBe(6);
    expect(result.rows).toHaveLength(3);
  });
});
