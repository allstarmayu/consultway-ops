/**
 * Integration tests for the email verification flow.
 *
 * Covers:
 *   - Token mint + consume round-trip
 *   - Expired token refusal
 *   - Already-used token refusal
 *   - Unknown token refusal
 *   - registerCompany ends with a token in DB AND sends the email
 *     (via the *Internal DI variant with a stub sendEmail)
 *   - registerCompany returns verificationEmailSent=true on stub success,
 *     verificationEmailSent=false when stub fails
 *   - resendVerificationEmail returns ok for unknown emails (no enumeration)
 *   - resendVerificationEmail no-ops for already-verified accounts
 *   - resendVerificationEmail mints + sends for pending accounts
 *   - login refuses unverified user with field='email' + "verify" copy
 *   - login succeeds after consume flips emailVerifiedAt
 *   - consume marks token used and flips emailVerifiedAt in one go
 *
 * @module lib/auth/__tests__/verification
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  users,
  companies,
  auditLog,
  emailVerificationTokens,
} from "@/lib/db/schema";
import {
  registerCompanyInternal,
  resendVerificationEmailInternal,
  login,
} from "../actions";
import {
  mintEmailVerificationToken,
  consumeEmailVerificationToken,
} from "../tokens";
import type { SendEmailArgs, SendEmailResult } from "@/lib/email/client";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(async () => null),
  // login() doesn't read the session but the module imports createSession;
  // export a stub so the import resolves.
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
}));

// Stub the next/navigation redirect — login() calls it on success.
// Throw a sentinel error that tests can catch to distinguish "redirected"
// from "returned ok:false".
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    const err: Error & { __redirectTo?: string } = new Error("NEXT_REDIRECT");
    err.__redirectTo = path;
    throw err;
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function makeStubSendEmail(
  override?: (args: SendEmailArgs) => Promise<SendEmailResult>,
) {
  return vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
    override ?? (async () => ({ ok: true, id: "stub-test" })),
  );
}

function makeInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    companyName: "Acme Construction",
    sector: "Infrastructure",
    geography: "Maharashtra",
    gstNumber: null,
    panNumber: null,
    contactPersonName: "Jane Doe",
    contactPhone: "+919876543210",
    contactEmail: "ops@acme.example",
    userName: "Jane Doe",
    userEmail: "jane@acme.example",
    password: "secret-passw0rd",
    acceptedTerms: true,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.delete(emailVerificationTokens);
  await db.delete(auditLog);
  await db.delete(users);
  await db.delete(companies);
});

// ── Token mint/consume ────────────────────────────────────────────────────

describe("email verification token round-trip", () => {
  it("mints a token that consume() then accepts and flips emailVerifiedAt", async () => {
    // Seed a user that's not yet verified.
    const userId = "00000000-0000-0000-0000-000000000aaa";
    const companyId = "00000000-0000-0000-0000-000000000bbb";
    await db.insert(companies).values({
      id: companyId,
      name: "C",
      sector: "S",
      geography: "G",
    });
    await db.insert(users).values({
      id: userId,
      email: "user@test.local",
      passwordHash: "$2a$10$test",
      role: "company",
      companyId,
      name: "User",
    });

    const { token } = await mintEmailVerificationToken(userId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const result = await consumeEmailVerificationToken(token);
    expect(result).toEqual({ ok: true, userId });

    const userRow = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .then((r) => r[0]);
    expect(userRow?.emailVerifiedAt).toBeTruthy();
  });

  it("marks the token used so a second consume refuses with already_used", async () => {
    const userId = "00000000-0000-0000-0000-000000000ccc";
    const companyId = "00000000-0000-0000-0000-000000000ddd";
    await db.insert(companies).values({
      id: companyId,
      name: "C",
      sector: "S",
      geography: "G",
    });
    await db.insert(users).values({
      id: userId,
      email: "user2@test.local",
      passwordHash: "$2a$10$test",
      role: "company",
      companyId,
      name: "User",
    });

    const { token } = await mintEmailVerificationToken(userId);
    const first = await consumeEmailVerificationToken(token);
    expect(first.ok).toBe(true);
    const second = await consumeEmailVerificationToken(token);
    expect(second).toEqual({ ok: false, reason: "already_used" });
  });

  it("refuses an unknown token", async () => {
    const result = await consumeEmailVerificationToken(
      "deadbeef".repeat(8), // 64 hex chars, but not in the DB
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses an expired token", async () => {
    const userId = "00000000-0000-0000-0000-000000000eee";
    const companyId = "00000000-0000-0000-0000-000000000fff";
    await db.insert(companies).values({
      id: companyId,
      name: "C",
      sector: "S",
      geography: "G",
    });
    await db.insert(users).values({
      id: userId,
      email: "user3@test.local",
      passwordHash: "$2a$10$test",
      role: "company",
      companyId,
      name: "User",
    });

    const { token } = await mintEmailVerificationToken(userId);
    // Force-expire by rewriting the row's expiresAt.
    await db
      .update(emailVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(emailVerificationTokens.userId, userId));

    const result = await consumeEmailVerificationToken(token);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });
});

// ── registerCompany pipeline ──────────────────────────────────────────────

describe("registerCompany email pipeline", () => {
  it("mints a token row and sends one verification email", async () => {
    const sendEmail = makeStubSendEmail();
    const result = await registerCompanyInternal(makeInput(), { sendEmail });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verificationEmailSent).toBe(true);

    // Exactly one mail with the verification subject.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const call = sendEmail.mock.calls[0]?.[0];
    expect(call?.to).toBe("jane@acme.example");
    expect(call?.subject).toBe("Verify your Consultway account");
    // Verification URL must be in both html and text bodies.
    expect(call?.html).toContain("/auth/verify?token=");
    expect(call?.text).toContain("/auth/verify?token=");

    // Token row exists for the new user.
    const tokenRows = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, result.userId));
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]?.usedAt).toBeNull();
  });

  it("reports verificationEmailSent=false when sendEmail returns ok:false", async () => {
    const sendEmail = makeStubSendEmail(async () => ({
      ok: false,
      error: "smtp down",
    }));
    const result = await registerCompanyInternal(makeInput(), { sendEmail });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verificationEmailSent).toBe(false);

    // But the user IS created — registration didn't roll back.
    const userRow = await db
      .select()
      .from(users)
      .where(eq(users.id, result.userId))
      .then((r) => r[0]);
    expect(userRow).toBeTruthy();
  });

  it("does not propagate when sendEmail throws", async () => {
    const sendEmail = makeStubSendEmail(async () => {
      throw new Error("provider exploded");
    });
    const result = await registerCompanyInternal(makeInput(), { sendEmail });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verificationEmailSent).toBe(false);
  });
});

// ── resendVerificationEmail ───────────────────────────────────────────────

describe("resendVerificationEmail enumeration defence", () => {
  it("returns ok for an unknown email without sending", async () => {
    const sendEmail = makeStubSendEmail();
    const result = await resendVerificationEmailInternal(
      { email: "nobody@example.test" },
      { sendEmail },
    );
    expect(result.ok).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();

    // And no token row was created.
    const tokens = await db.select().from(emailVerificationTokens);
    expect(tokens).toHaveLength(0);
  });

  it("returns ok for an already-verified user without sending", async () => {
    // Seed verified user.
    const userId = "00000000-0000-0000-0000-0000abcd0001";
    const companyId = "00000000-0000-0000-0000-0000abcd0002";
    await db.insert(companies).values({
      id: companyId,
      name: "C",
      sector: "S",
      geography: "G",
    });
    await db.insert(users).values({
      id: userId,
      email: "verified@test.local",
      passwordHash: "$2a$10$test",
      role: "company",
      companyId,
      name: "Verified",
      emailVerifiedAt: new Date().toISOString(),
    });

    const sendEmail = makeStubSendEmail();
    const result = await resendVerificationEmailInternal(
      { email: "verified@test.local" },
      { sendEmail },
    );
    expect(result.ok).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("mints + sends when the email is known and unverified", async () => {
    // Register first (this also mints a token).
    const initialSend = makeStubSendEmail();
    const reg = await registerCompanyInternal(makeInput(), {
      sendEmail: initialSend,
    });
    expect(reg.ok).toBe(true);

    // Now resend.
    const sendEmail = makeStubSendEmail();
    const result = await resendVerificationEmailInternal(
      { email: "jane@acme.example" },
      { sendEmail },
    );
    expect(result.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]?.[0].to).toBe("jane@acme.example");

    // Two tokens for the user now (original + resent).
    if (!reg.ok) return;
    const tokens = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, reg.userId));
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  });
});

// ── login gate ────────────────────────────────────────────────────────────

describe("login verification gate", () => {
  it("refuses an unverified account with field='email' and verify copy", async () => {
    // Register without verifying.
    const sendEmail = makeStubSendEmail();
    const reg = await registerCompanyInternal(makeInput(), { sendEmail });
    expect(reg.ok).toBe(true);

    const result = await login({
      email: "jane@acme.example",
      password: "secret-passw0rd",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("email");
    expect(result.error).toMatch(/verify/i);
  });

  it("succeeds (redirects) after the user verifies via token consume", async () => {
    const sendEmail = makeStubSendEmail();
    const reg = await registerCompanyInternal(makeInput(), { sendEmail });
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;

    // Pull the token straight out of the DB (we don't capture the raw
    // here because the stub doesn't echo it; mint a fresh one for the
    // verify step).
    const fresh = await mintEmailVerificationToken(reg.userId);
    const consumed = await consumeEmailVerificationToken(fresh.token);
    expect(consumed.ok).toBe(true);

    // Now login should redirect. Our mocked next/navigation throws a
    // sentinel error on redirect.
    await expect(
      login({
        email: "jane@acme.example",
        password: "secret-passw0rd",
      }),
    ).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it("verify gate fires AFTER password check (wrong password still returns invalid creds)", async () => {
    const sendEmail = makeStubSendEmail();
    const reg = await registerCompanyInternal(makeInput(), { sendEmail });
    expect(reg.ok).toBe(true);

    const result = await login({
      email: "jane@acme.example",
      password: "wrong-passw0rd",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Generic "invalid email or password" — doesn't reveal verification state.
    expect(result.error).toMatch(/invalid/i);
    expect(result.field).toBe("form");
  });
});
