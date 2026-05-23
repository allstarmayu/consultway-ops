/**
 * Integration tests for `cleanupExpiredTokens`.
 *
 * Covers:
 *   - Helper deletes only expired rows (live tokens untouched)
 *   - Helper handles a fully-empty table cleanly (no throw, zero counts)
 *   - Helper returns the correct per-table delete counts
 *   - Helper composes both table sweeps in one call
 *
 * @module lib/auth/__tests__/token-cleanup
 */
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  users,
  companies,
  emailVerificationTokens,
  passwordResetTokens,
} from "@/lib/db/schema";
import { cleanupExpiredTokens } from "../tokens";

// ── Fixture helpers ────────────────────────────────────────────────────────

const USER_ID = "00000000-0000-0000-0000-00000000c001";
const COMPANY_ID = "00000000-0000-0000-0000-00000000c002";

async function seedUser(): Promise<void> {
  await db.insert(companies).values({
    id: COMPANY_ID,
    name: "C",
    sector: "S",
    geography: "G",
  });
  await db.insert(users).values({
    id: USER_ID,
    email: "cleanup-test@example.local",
    passwordHash: "$2a$10$test",
    role: "company",
    companyId: COMPANY_ID,
    name: "Cleanup Test",
  });
}

/** Insert an email verification token row with an explicit `expiresAt`. */
async function insertVerificationToken(id: string, expiresAt: string) {
  await db.insert(emailVerificationTokens).values({
    id,
    userId: USER_ID,
    // Distinct hash per id so the unique index doesn't conflict.
    tokenHash: `hash-${id}`,
    expiresAt,
  });
}

/** Insert a password reset token row with an explicit `expiresAt`. */
async function insertResetToken(id: string, expiresAt: string) {
  await db.insert(passwordResetTokens).values({
    id,
    userId: USER_ID,
    tokenHash: `reset-hash-${id}`,
    expiresAt,
  });
}

const NOW = "2026-05-23T12:00:00.000Z";
const PAST = "2026-05-22T12:00:00.000Z"; // 24h ago
const FUTURE = "2026-05-24T12:00:00.000Z"; // 24h hence

beforeEach(async () => {
  await db.delete(emailVerificationTokens);
  await db.delete(passwordResetTokens);
  await db.delete(users);
  await db.delete(companies);
  await seedUser();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("cleanupExpiredTokens", () => {
  it("returns zero counts when both token tables are empty", async () => {
    const result = await cleanupExpiredTokens(NOW);
    expect(result).toEqual({ verificationDeleted: 0, resetDeleted: 0 });
  });

  it("deletes only expired verification tokens, leaves live tokens intact", async () => {
    await insertVerificationToken("v-expired-1", PAST);
    await insertVerificationToken("v-expired-2", PAST);
    await insertVerificationToken("v-live-1", FUTURE);

    const result = await cleanupExpiredTokens(NOW);

    expect(result.verificationDeleted).toBe(2);
    expect(result.resetDeleted).toBe(0);

    const remaining = await db
      .select({ id: emailVerificationTokens.id })
      .from(emailVerificationTokens);
    expect(remaining.map((r) => r.id)).toEqual(["v-live-1"]);
  });

  it("deletes only expired reset tokens, leaves live tokens intact", async () => {
    await insertResetToken("r-expired-1", PAST);
    await insertResetToken("r-live-1", FUTURE);
    await insertResetToken("r-live-2", FUTURE);

    const result = await cleanupExpiredTokens(NOW);

    expect(result.verificationDeleted).toBe(0);
    expect(result.resetDeleted).toBe(1);

    const remaining = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens);
    expect(remaining.map((r) => r.id).sort()).toEqual(["r-live-1", "r-live-2"]);
  });

  it("sweeps both tables in one call with correct per-table counts", async () => {
    await insertVerificationToken("v-expired-1", PAST);
    await insertVerificationToken("v-expired-2", PAST);
    await insertVerificationToken("v-live-1", FUTURE);
    await insertResetToken("r-expired-1", PAST);
    await insertResetToken("r-live-1", FUTURE);

    const result = await cleanupExpiredTokens(NOW);

    expect(result).toEqual({ verificationDeleted: 2, resetDeleted: 1 });

    const verificationLeft = await db
      .select({ id: emailVerificationTokens.id })
      .from(emailVerificationTokens);
    const resetLeft = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens);

    expect(verificationLeft.map((r) => r.id)).toEqual(["v-live-1"]);
    expect(resetLeft.map((r) => r.id)).toEqual(["r-live-1"]);
  });
});
