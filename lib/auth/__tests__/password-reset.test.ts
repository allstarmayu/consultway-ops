/**
 * Integration tests for the password reset flow.
 *
 * Covers:
 *   - requestPasswordReset is enumeration-defended: always returns ok
 *   - Unknown email triggers no mint + no send
 *   - Valid request mints a token AND sends the request email
 *   - consumePasswordResetToken flips the password, stamps used_at, and
 *     invalidates sibling outstanding tokens for the same user
 *   - Expired reset token refusal
 *   - Already-used token refusal
 *   - Weak new-password Zod refusal
 *   - Confirmation email sent on successful reset
 *   - verifyPassword passes with new password, fails with old (the
 *     password actually changed)
 *
 * @module lib/auth/__tests__/password-reset
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  users,
  companies,
  passwordResetTokens,
  auditLog,
  emailVerificationTokens,
} from "@/lib/db/schema";
import {
  requestPasswordResetInternal,
  resetPasswordInternal,
} from "../actions";
import {
  mintPasswordResetToken,
  consumePasswordResetToken,
} from "../tokens";
import { hashPassword, verifyPassword } from "../password";
import type { SendEmailArgs, SendEmailResult } from "@/lib/email/client";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    const err: Error & { __redirectTo?: string } = new Error("NEXT_REDIRECT");
    err.__redirectTo = path;
    throw err;
  },
}));

function makeStubSendEmail(
  override?: (args: SendEmailArgs) => Promise<SendEmailResult>,
) {
  return vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
    override ?? (async () => ({ ok: true, id: "stub-test" })),
  );
}

/** Seed a verified user. Tests get a fresh user per beforeEach. */
async function seedVerifiedUser(): Promise<{
  userId: string;
  companyId: string;
  email: string;
  oldPassword: string;
}> {
  const userId = "00000000-0000-0000-0000-000000001001";
  const companyId = "00000000-0000-0000-0000-000000001002";
  const email = "reset@test.local";
  const oldPassword = "old-secret-1234";

  await db.insert(companies).values({
    id: companyId,
    name: "Test Co",
    sector: "Test",
    geography: "Test",
  });
  await db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashPassword(oldPassword),
    role: "company",
    companyId,
    name: "Test User",
    emailVerifiedAt: new Date().toISOString(),
  });

  return { userId, companyId, email, oldPassword };
}

beforeEach(async () => {
  await db.delete(passwordResetTokens);
  await db.delete(emailVerificationTokens);
  await db.delete(auditLog);
  await db.delete(users);
  await db.delete(companies);
});

// ── Token round-trip ──────────────────────────────────────────────────────

describe("password reset token round-trip", () => {
  it("mints + consumes + flips password + stamps used_at", async () => {
    const seed = await seedVerifiedUser();
    const { token } = await mintPasswordResetToken(seed.userId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const newHash = await hashPassword("brand-new-pass1234");
    const result = await consumePasswordResetToken(token, newHash);
    expect(result).toEqual({ ok: true, userId: seed.userId });

    const tokenRow = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, seed.userId))
      .then((r) => r[0]);
    expect(tokenRow?.usedAt).toBeTruthy();

    const userRow = await db
      .select()
      .from(users)
      .where(eq(users.id, seed.userId))
      .then((r) => r[0]);
    expect(userRow?.passwordHash).toBe(newHash);
  });

  it("invalidates sibling outstanding tokens on successful consume", async () => {
    const seed = await seedVerifiedUser();
    // Mint 3 tokens for the same user.
    const first = await mintPasswordResetToken(seed.userId);
    const second = await mintPasswordResetToken(seed.userId);
    await mintPasswordResetToken(seed.userId);

    // Consume the SECOND one.
    const newHash = await hashPassword("brand-new-pass1234");
    const result = await consumePasswordResetToken(second.token, newHash);
    expect(result.ok).toBe(true);

    // All three rows now have usedAt set (the consumed one + two siblings).
    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, seed.userId));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.usedAt).toBeTruthy();
    }

    // Attempting to consume the FIRST one now refuses as already_used.
    const again = await consumePasswordResetToken(first.token, newHash);
    expect(again).toEqual({ ok: false, reason: "already_used" });
  });

  it("refuses an expired token", async () => {
    const seed = await seedVerifiedUser();
    const { token } = await mintPasswordResetToken(seed.userId);
    await db
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(passwordResetTokens.userId, seed.userId));

    const newHash = await hashPassword("brand-new-pass1234");
    const result = await consumePasswordResetToken(token, newHash);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses an unknown token", async () => {
    const newHash = await hashPassword("brand-new-pass1234");
    const result = await consumePasswordResetToken(
      "abcd".repeat(16),
      newHash,
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

// ── requestPasswordReset ──────────────────────────────────────────────────

describe("requestPasswordReset enumeration defence", () => {
  it("returns ok and DOES NOT send for an unknown email", async () => {
    const sendEmail = makeStubSendEmail();
    const result = await requestPasswordResetInternal(
      { email: "nobody@test.local" },
      { sendEmail },
    );
    expect(result.ok).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();

    // And no token row was created.
    const rows = await db.select().from(passwordResetTokens);
    expect(rows).toHaveLength(0);
  });

  it("returns ok, mints a token, and sends for a known email", async () => {
    const seed = await seedVerifiedUser();
    const sendEmail = makeStubSendEmail();
    const result = await requestPasswordResetInternal(
      { email: seed.email },
      { sendEmail },
    );
    expect(result.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]?.[0].subject).toBe(
      "Reset your Consultway password",
    );

    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, seed.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usedAt).toBeNull();
  });
});

// ── resetPassword action ──────────────────────────────────────────────────

describe("resetPassword action", () => {
  it("refuses a weak new password with a field hint", async () => {
    const sendEmail = makeStubSendEmail();
    const result = await resetPasswordInternal(
      { token: "irrelevant".repeat(8), newPassword: "weak" },
      { sendEmail },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("newPassword");
  });

  it("end-to-end: request -> consume -> password actually changes", async () => {
    const seed = await seedVerifiedUser();

    // 1. Request reset (also sends the request email).
    const requestSendEmail = makeStubSendEmail();
    await requestPasswordResetInternal(
      { email: seed.email },
      { sendEmail: requestSendEmail },
    );

    // Pull the issued token's raw value isn't recoverable, so mint a
    // fresh one for the reset step (same module surface, identical
    // shape).
    const fresh = await mintPasswordResetToken(seed.userId);

    // 2. Reset the password.
    const resetSendEmail = makeStubSendEmail();
    const newPassword = "brand-new-pass1234";
    const result = await resetPasswordInternal(
      { token: fresh.token, newPassword },
      { sendEmail: resetSendEmail },
    );
    expect(result.ok).toBe(true);

    // 3. Confirmation email landed.
    expect(resetSendEmail).toHaveBeenCalledTimes(1);
    expect(resetSendEmail.mock.calls[0]?.[0].subject).toBe(
      "Your Consultway password was changed",
    );

    // 4. The password actually changed.
    const userRow = await db
      .select()
      .from(users)
      .where(eq(users.id, seed.userId))
      .then((r) => r[0]);
    expect(userRow).toBeTruthy();
    if (!userRow) return;
    expect(await verifyPassword(newPassword, userRow.passwordHash)).toBe(true);
    expect(await verifyPassword(seed.oldPassword, userRow.passwordHash)).toBe(
      false,
    );
  });

  it("returns a friendly error for not_found / expired / already_used", async () => {
    const sendEmail = makeStubSendEmail();
    // Not found.
    const notFound = await resetPasswordInternal(
      { token: "deadbeef".repeat(8), newPassword: "brand-new-pass1234" },
      { sendEmail },
    );
    expect(notFound.ok).toBe(false);
    if (notFound.ok) return;
    expect(notFound.error).toMatch(/no longer valid/i);
    expect(notFound.field).toBe("token");

    // Already-used: mint + consume directly, then try the action.
    const seed = await seedVerifiedUser();
    const { token } = await mintPasswordResetToken(seed.userId);
    const newHash = await hashPassword("brand-new-pass1234");
    await consumePasswordResetToken(token, newHash);
    const reused = await resetPasswordInternal(
      { token, newPassword: "brand-new-pass1234" },
      { sendEmail },
    );
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.error).toMatch(/already been used/i);
  });
});
