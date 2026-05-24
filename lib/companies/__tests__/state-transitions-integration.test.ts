/**
 * Integration tests for the compliance state-machine + audit-verb
 * contract, exercised against rows shaped like the actual seed.
 *
 * The seed (scripts/seed.ts + scripts/seed-generators.ts) populates
 * `rejected` and `suspended` companies via direct INSERT — the
 * state-machine path is not hit on a normal `pnpm db:seed`. These tests
 * close that gap by setting up rows the same way (one row per starting
 * state) and then exercising real transitions through `updateCompany`,
 * pinning:
 *
 *   - the `compliance_status_changed` audit verb (vs plain `updated`)
 *   - the rejected-as-terminal contract (every outbound transition
 *     refused, row unchanged afterwards)
 *   - the suspended ↔ compliant reversibility from the Day 22 spec
 *   - the before/after snapshot shape on a real state move
 *
 * Distinct from `actions.test.ts` because those tests focus on the
 * narrow Chunk-2 surface (illegal/legal pairs, schema superRefine,
 * company-role strip). This file frames the contract as it'd play out
 * on the real dataset.
 *
 * @module lib/companies/__tests__/state-transitions-integration
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
  // One company per starting status the seed produces.
  pendingCompanyId: string;
  compliantCompanyId: string;
  suspendedCompanyId: string;
  rejectedCompanyId: string;
}

let fixture: Fixture;

/**
 * Mimics the seed's direct-INSERT shape — each company is created with
 * a specific compliance status (rather than being moved there via the
 * action). For `rejected` rows we also populate the rejectionReason,
 * same as the seed's invariant requires.
 */
async function seedFixture(): Promise<Fixture> {
  const adminUserId = newId();
  const pendingCompanyId = newId();
  const compliantCompanyId = newId();
  const suspendedCompanyId = newId();
  const rejectedCompanyId = newId();

  await db.insert(users).values({
    id: adminUserId,
    email: `admin-${adminUserId}@test.local`,
    passwordHash: "$2a$10$test",
    role: "admin" as UserRole,
    name: "Admin",
  });

  await db.insert(companies).values([
    {
      id: pendingCompanyId,
      name: "Pending Pvt Ltd",
      sector: "Infrastructure",
      geography: "Maharashtra",
      complianceStatus: "pending" satisfies ComplianceStatus,
    },
    {
      id: compliantCompanyId,
      name: "Compliant Constructors",
      sector: "Civil Works",
      geography: "Karnataka",
      complianceStatus: "compliant" satisfies ComplianceStatus,
    },
    {
      id: suspendedCompanyId,
      name: "Suspended Solar",
      sector: "Solar EPC",
      geography: "Gujarat",
      complianceStatus: "suspended" satisfies ComplianceStatus,
    },
    {
      id: rejectedCompanyId,
      name: "Rejected Renewables",
      sector: "Solar EPC",
      geography: "Tamil Nadu",
      complianceStatus: "rejected" satisfies ComplianceStatus,
      // Seeded the same way the invariant verifier requires.
      rejectionReason: "Failed background check on directors at intake.",
    },
  ]);

  return {
    adminUserId,
    pendingCompanyId,
    compliantCompanyId,
    suspendedCompanyId,
    rejectedCompanyId,
  };
}

async function clearFixture(f: Fixture): Promise<void> {
  await db
    .delete(auditLog)
    .where(eq(auditLog.actorId, f.adminUserId))
    .catch(() => {});
  await db.delete(users).where(eq(users.id, f.adminUserId));
  for (const id of [
    f.pendingCompanyId,
    f.compliantCompanyId,
    f.suspendedCompanyId,
    f.rejectedCompanyId,
  ]) {
    await db.delete(companies).where(eq(companies.id, id));
  }
}

function loginAsAdmin(f: Fixture): void {
  mockedReadSession.mockResolvedValue({
    userId: f.adminUserId,
    role: "admin",
    companyId: null,
    email: "admin@test.local",
  });
}

/**
 * Most-recent audit row scoped to `targetId` AND verb. Used so we can
 * assert "there IS a compliance_status_changed row" or "there is NO
 * row for that verb" without false-positives from unrelated activity.
 */
async function latestAuditForCompanyAndAction(
  companyId: string,
  action: string,
) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "company"),
        eq(auditLog.targetId, companyId),
        eq(auditLog.action, action),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1)
    .then((r) => r[0]);
}

async function readCompany(companyId: string) {
  return db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
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

// ── pending → compliant (intake review passes) ───────────────────────────

describe("seed-rooted transition: pending → compliant", () => {
  it("moves the row and emits compliance_status_changed with snapshots", async () => {
    loginAsAdmin(fixture);

    const result = await updateCompany({
      id: fixture.pendingCompanyId,
      complianceStatus: "compliant",
    });
    expect(result.ok).toBe(true);

    const row = await readCompany(fixture.pendingCompanyId);
    expect(row?.complianceStatus).toBe("compliant");

    const audit = await latestAuditForCompanyAndAction(
      fixture.pendingCompanyId,
      "compliance_status_changed",
    );
    expect(audit).toBeDefined();
    const before = audit?.before as Record<string, unknown>;
    const after = audit?.after as Record<string, unknown>;
    expect(before.complianceStatus).toBe("pending");
    expect(after.complianceStatus).toBe("compliant");
  });
});

// ── compliant → pending (illegal — pending is intake-only) ───────────────

describe("seed-rooted transition: compliant → pending is refused", () => {
  it("returns ok:false with field=complianceStatus; row unchanged", async () => {
    loginAsAdmin(fixture);

    const result = await updateCompany({
      id: fixture.compliantCompanyId,
      complianceStatus: "pending",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("complianceStatus");

    const row = await readCompany(fixture.compliantCompanyId);
    expect(row?.complianceStatus).toBe("compliant");

    // No `compliance_status_changed` audit row should exist.
    const audit = await latestAuditForCompanyAndAction(
      fixture.compliantCompanyId,
      "compliance_status_changed",
    );
    expect(audit).toBeUndefined();
  });
});

// ── rejected → anything is refused; terminal-state contract ──────────────

describe("seed-rooted transition: rejected is terminal", () => {
  const outboundTargets: ComplianceStatus[] = [
    "pending",
    "compliant",
    "non_compliant",
    "expired",
    "suspended",
  ];

  for (const target of outboundTargets) {
    it(`rejected → ${target} returns ok:false; row stays rejected with its reason`, async () => {
      loginAsAdmin(fixture);

      const result = await updateCompany({
        id: fixture.rejectedCompanyId,
        complianceStatus: target,
        // Provide a reason so the schema-layer "rejected ⇒ reason"
        // gate doesn't intercept first — we want the state-machine
        // assertion to be the refusing layer.
        rejectionReason: "Re-evaluation",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.field).toBe("complianceStatus");

      const row = await readCompany(fixture.rejectedCompanyId);
      expect(row?.complianceStatus).toBe("rejected");
      expect(row?.rejectionReason).toBe(
        "Failed background check on directors at intake.",
      );
    });
  }
});

// ── suspended → compliant (Day 22 reversibility spec) ────────────────────

describe("seed-rooted transition: suspended → compliant (reversibility)", () => {
  it("moves the row and audit verb is compliance_status_changed, not updated", async () => {
    loginAsAdmin(fixture);

    const result = await updateCompany({
      id: fixture.suspendedCompanyId,
      complianceStatus: "compliant",
    });
    expect(result.ok).toBe(true);

    const row = await readCompany(fixture.suspendedCompanyId);
    expect(row?.complianceStatus).toBe("compliant");

    // The new verb is present...
    const moveAudit = await latestAuditForCompanyAndAction(
      fixture.suspendedCompanyId,
      "compliance_status_changed",
    );
    expect(moveAudit).toBeDefined();
    const before = moveAudit?.before as Record<string, unknown>;
    const after = moveAudit?.after as Record<string, unknown>;
    expect(before.complianceStatus).toBe("suspended");
    expect(after.complianceStatus).toBe("compliant");

    // ... and we did NOT accidentally write a plain `updated` for this
    // status-only patch.
    const plainUpdatedAudit = await latestAuditForCompanyAndAction(
      fixture.suspendedCompanyId,
      "updated",
    );
    expect(plainUpdatedAudit).toBeUndefined();
  });
});
