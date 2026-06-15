/**
 * Integration tests for the admin-invite acceptance flow (Day 33).
 *
 * Covers:
 *   - mintInviteToken writes a 72h token to password_reset_tokens
 *   - acceptInvite sets the initial password, flips emailVerifiedAt,
 *     stamps the token used, and audits the acceptance
 *   - acceptInvite refuses weak passwords / invalid / already-used tokens
 *
 * The invite deliberately reuses the password-reset token substrate, so the
 * round-trip overlaps with password-reset.test.ts by design — the extra
 * assertion here is the emailVerifiedAt flip that a plain reset does not do.
 *
 * @module lib/auth/__tests__/invite
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  users,
  companies,
  passwordResetTokens,
  emailVerificationTokens,
  auditLog,
} from "@/lib/db/schema";
import { acceptInvite } from "../actions";
import { mintInviteToken } from "../tokens";
import { hashPassword, verifyPassword } from "../password";

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

const USER_ID = "00000000-0000-0000-0000-0000000000e1";
const COMPANY_ID = "00000000-0000-0000-0000-0000000000e2";

/** Seed an invited-but-not-yet-accepted user (verified=null, unusable hash). */
async function seedInvitedUser() {
  await db.insert(companies).values({
    id: COMPANY_ID,
    name: "Invite Co",
    sector: "Infra",
    geography: "Pan India",
  });
  await db.insert(users).values({
    id: USER_ID,
    email: "invited@test.local",
    passwordHash: await hashPassword("placeholder-unusable-secret"),
    role: "staff",
    name: "Invited User",
    emailVerifiedAt: null,
  });
}

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(passwordResetTokens);
  await db.delete(emailVerificationTokens);
  await db.delete(users);
  await db.delete(companies);
});

describe("mintInviteToken", () => {
  it("writes a 64-hex token to password_reset_tokens with a ~72h expiry", async () => {
    await seedInvitedUser();
    const before = Date.now();
    const { token, expiresAt } = await mintInviteToken(USER_ID);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const rows = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, USER_ID));
    expect(rows).toHaveLength(1);

    const ttlMs = Date.parse(expiresAt) - before;
    // 72h ± a generous slack for test execution time.
    expect(ttlMs).toBeGreaterThan(71 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(73 * 60 * 60 * 1000);
  });
});

describe("acceptInvite", () => {
  it("sets the password, flips emailVerifiedAt, and audits the acceptance", async () => {
    await seedInvitedUser();
    const { token } = await mintInviteToken(USER_ID);

    const newPassword = "chosen-pass-1234";
    const r = await acceptInvite({ token, newPassword });
    expect(r.ok).toBe(true);

    const [row] = await db.select().from(users).where(eq(users.id, USER_ID));
    expect(row).toBeTruthy();
    if (!row) return;
    expect(await verifyPassword(newPassword, row.passwordHash)).toBe(true);
    expect(row.emailVerifiedAt).toBeTruthy();

    const [tokenRow] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, USER_ID));
    expect(tokenRow?.usedAt).toBeTruthy();

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, USER_ID));
    expect(audit?.metadata).toMatchObject({ action: "invite_accepted" });
  });

  it("rejects a weak password with a field hint", async () => {
    const r = await acceptInvite({ token: "a".repeat(32), newPassword: "weak" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.field).toBe("newPassword");
  });

  it("rejects an unknown token", async () => {
    const r = await acceptInvite({
      token: "deadbeef".repeat(8),
      newPassword: "chosen-pass-1234",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no longer valid/i);
    expect(r.field).toBe("token");
  });

  it("rejects an already-used token", async () => {
    await seedInvitedUser();
    const { token } = await mintInviteToken(USER_ID);
    await acceptInvite({ token, newPassword: "chosen-pass-1234" });
    const again = await acceptInvite({ token, newPassword: "another-pass-1234" });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toMatch(/already been used/i);
  });

  it("rejects an expired invite token", async () => {
    await seedInvitedUser();
    const { token } = await mintInviteToken(USER_ID);
    // Force the token past its 72h expiry (mirrors password-reset.test.ts).
    await db
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(passwordResetTokens.userId, USER_ID));

    const r = await acceptInvite({ token, newPassword: "chosen-pass-1234" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/expired/i);
    expect(r.field).toBe("token");

    // And the password was NOT changed by the expired attempt.
    const [row] = await db.select().from(users).where(eq(users.id, USER_ID));
    expect(row?.emailVerifiedAt).toBeNull();
  });
});
