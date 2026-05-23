/**
 * Tests for `scripts/seed-invariants.ts::runInvariantChecks`.
 *
 * Each test sets up a controlled DB state (empty, deliberately broken,
 * or fully seeded) and re-runs the checker. The verifier is read-only;
 * tests assert what it reports without expecting side effects.
 *
 * @module scripts/__tests__/seed-invariants
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  auditLog,
  companies,
  documents,
  emailVerificationTokens,
  passwordResetTokens,
  projects,
  remindersSent,
  tenderApplications,
  tenders,
  transactions,
  users,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { runInvariantChecks } from "../seed-invariants";
import {
  seedConsultwayPublisher,
  seedStandaloneCompany,
  seedStaffUser,
  CONSULTWAY_PUBLISHER_NAME,
  SEED_VERIFIED_AT,
} from "../seed";

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.delete(remindersSent);
  await db.delete(passwordResetTokens);
  await db.delete(emailVerificationTokens);
  await db.delete(auditLog);
  await db.delete(transactions);
  await db.delete(projects);
  await db.delete(tenderApplications);
  await db.delete(tenders);
  await db.delete(documents);
  await db.delete(users);
  await db.delete(companies);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("runInvariantChecks", () => {
  it("clean against an empty DB", async () => {
    const result = await runInvariantChecks(db);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("flags transaction.companyId / project.companyId mismatch (cross-FK)", async () => {
    // Two companies, one project owned by company A, one transaction
    // claiming to be FOR company B but pointed at company A's project.
    const companyAId = newId();
    const companyBId = newId();
    await db.insert(companies).values([
      {
        id: companyAId,
        name: "Company A",
        sector: "Infrastructure",
        geography: "Maharashtra",
        complianceStatus: "compliant",
      },
      {
        id: companyBId,
        name: "Company B",
        sector: "Infrastructure",
        geography: "Maharashtra",
        complianceStatus: "compliant",
      },
    ]);
    const projectId = newId();
    await db.insert(projects).values({
      id: projectId,
      name: "A's Project",
      companyId: companyAId,
      status: "active",
    });
    const txnId = newId();
    await db.insert(transactions).values({
      id: txnId,
      // Cross-FK violation: companyId is B but the linked project belongs to A.
      companyId: companyBId,
      projectId,
      type: "invoice",
      amountPaise: 1000,
      currency: "INR",
      occurredOn: "2026-05-01",
    });

    const result = await runInvariantChecks(db);
    expect(result.passed).toBe(false);
    const cross = result.violations.find(
      (v) => v.name === "transactions.cross_fk",
    );
    expect(cross).toBeTruthy();
    expect(cross?.count).toBe(1);
    expect(cross?.sample).toContain(txnId);
  });

  it("flags orphan FK (document.uploadedBy points at non-existent user)", async () => {
    // Insert a company + an admin who CAN upload, then drop the user
    // out from under the document. Since `documents.uploadedBy` uses
    // ON DELETE RESTRICT we have to bypass the cascade by inserting
    // the document with an outright-fake user id (the FK pragma will
    // still let it land if the parent existed at any point — for the
    // purpose of this test we just write the row with a bogus uploader).
    const companyId = newId();
    await db.insert(companies).values({
      id: companyId,
      name: "Some Company",
      sector: "Infrastructure",
      geography: "Maharashtra",
      complianceStatus: "compliant",
    });
    // FK enforcement is ON; do this within a no-fk window so the bogus
    // FK lands. The verifier is meant to catch exactly this kind of
    // data drift even when the DB constraint somehow lets a row through
    // (e.g. via an external SQL session during a demo).
    const sqlite = (globalThis as { __sqlite?: { pragma: (s: string) => unknown } })
      .__sqlite;
    sqlite?.pragma("foreign_keys = OFF");
    try {
      const docId = newId();
      await db.insert(documents).values({
        id: docId,
        companyId,
        documentType: "gst_certificate",
        fileKey: `companies/${companyId}/${docId}/test.pdf`,
        fileName: "test.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1000,
        status: "verified",
        uploadedBy: "00000000-0000-0000-0000-deadbeef0001",
      });
    } finally {
      sqlite?.pragma("foreign_keys = ON");
    }

    const result = await runInvariantChecks(db);
    expect(result.passed).toBe(false);
    const orphan = result.violations.find(
      (v) => v.name === "documents.orphan_uploader",
    );
    expect(orphan).toBeTruthy();
    expect(orphan?.count).toBe(1);
  });

  it("clean against the existing standalone-seeded DB", async () => {
    // The Day-21 fixture set landed cleanly under every invariant
    // (the seed-plan's contract is that the verifier reports nothing on
    // a freshly-seeded DB). Replay enough of the seed to verify here:
    // publisher + one staff user + one standalone company. The cross-FK
    // / rejected-reason / awarded-company / orphan checks all degenerate
    // to "pass" when the relevant rows don't exist, which is exactly
    // the empty-but-not-quite case worth pinning.
    await seedConsultwayPublisher();
    await seedStaffUser({
      email: "admin@invariants-test.local",
      plaintextPassword: "x",
      role: "admin",
      name: "Invariants Admin",
      isActive: true,
      emailVerifiedAt: SEED_VERIFIED_AT,
    });
    await seedStandaloneCompany({
      name: "Invariants Co",
      sector: "Infrastructure",
      geography: "Maharashtra",
      gstNumber: "27INVAR0001A1Z5",
      panNumber: "INVAR0001A",
      isMsme: false,
      complianceStatus: "compliant",
      annualTurnover: 50_000_000,
      contactEmail: null,
      contactPhone: null,
      contactPersonName: null,
      addressLine: null,
      city: null,
      state: null,
      pincode: null,
      internalNotes: null,
    });

    // Sanity: the seeded rows landed.
    const allCompanies = await db.select().from(companies);
    expect(allCompanies.length).toBeGreaterThanOrEqual(2);
    expect(allCompanies.some((c) => c.name === CONSULTWAY_PUBLISHER_NAME)).toBe(true);

    const result = await runInvariantChecks(db);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("flags rejected company missing rejectionReason", async () => {
    const companyId = newId();
    await db.insert(companies).values({
      id: companyId,
      name: "Rejected Co",
      sector: "Infrastructure",
      geography: "Maharashtra",
      complianceStatus: "rejected",
      // rejectionReason intentionally null — the invariant should fire.
    });
    const result = await runInvariantChecks(db);
    expect(result.passed).toBe(false);
    const v = result.violations.find(
      (x) => x.name === "companies.rejected_reason_missing",
    );
    expect(v).toBeTruthy();
    expect(v?.sample).toContain(companyId);
  });
});
