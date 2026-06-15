/**
 * Integration tests for the users-module Server Actions.
 *
 * Exercises the real Drizzle client against the in-memory test DB (migrated
 * in vitest.setup). `readSession` is mocked to a controllable admin session
 * so the `requireAdmin` gate passes; email sends go through the DI stub.
 *
 * Covers: admin gating, the invite-create flow, the role ↔ company
 * invariant + self-lockout guards on update, soft deactivate/reactivate
 * (+ self-deactivate guard), admin password reset, invite resend, and the
 * list/get reads (password hash never returned).
 *
 * @module lib/users/__tests__/actions
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
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { newId } from "@/lib/db/ids";
import type { SendEmailArgs, SendEmailResult } from "@/lib/email/client";
import {
  createUserInternal,
  updateUser,
  deactivateUser,
  reactivateUser,
  resetUserPasswordInternal,
  resendInviteInternal,
  listUsers,
  getUser,
} from "../actions";

vi.mock("@/lib/auth/session", () => ({
  readSession: vi.fn(),
  createSession: vi.fn(async () => {}),
  destroySession: vi.fn(async () => {}),
}));

import { readSession } from "@/lib/auth/session";
const mockedReadSession = vi.mocked(readSession);

// Real UUID v7s — zod 4's `.uuid()` validates version/variant nibbles, so
// the action id guards reject hand-written all-zeros strings.
const ADMIN_ID = newId();
const adminSession = {
  userId: ADMIN_ID,
  email: "admin@consultway.local",
  role: "admin" as const,
  companyId: null,
};

const STAFF_ID = newId();
const staffSession = {
  userId: STAFF_ID,
  email: "staff@consultway.local",
  role: "staff" as const,
  companyId: null,
};

const COMPANY_ID = newId();
const ADA_ID = newId();
const SAM_ID = newId();
const CARA_ID = newId();

function makeStubSendEmail(
  override?: (args: SendEmailArgs) => Promise<SendEmailResult>,
) {
  return vi.fn<(args: SendEmailArgs) => Promise<SendEmailResult>>(
    override ?? (async () => ({ ok: true, id: "stub-test" })),
  );
}

async function seedCompany(id = COMPANY_ID, name = "Acme Corp") {
  await db.insert(companies).values({ id, name, sector: "Infra", geography: "Pan India" });
}

async function seedUser(opts: {
  id: string;
  email: string;
  name?: string;
  role?: "admin" | "staff" | "company";
  companyId?: string | null;
  isActive?: boolean;
  emailVerifiedAt?: string | null;
}) {
  await db.insert(users).values({
    id: opts.id,
    email: opts.email,
    passwordHash: await hashPassword("seed-password-123"),
    name: opts.name ?? "Seed User",
    role: opts.role ?? "staff",
    companyId: opts.companyId ?? null,
    isActive: opts.isActive ?? true,
    emailVerifiedAt: opts.emailVerifiedAt ?? null,
  });
}

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(passwordResetTokens);
  await db.delete(emailVerificationTokens);
  await db.delete(users);
  await db.delete(companies);
  mockedReadSession.mockResolvedValue(adminSession);
});

// ── Admin gating ───────────────────────────────────────────────────────────

describe("createUser auth gating", () => {
  it("refuses an unauthenticated caller", async () => {
    mockedReadSession.mockResolvedValueOnce(null);
    const r = await createUserInternal(
      { email: "x@test.local", name: "Ex", role: "staff" },
      { sendEmail: makeStubSendEmail() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/signed in/i);
  });

  it("refuses a staff caller creating a non-company user", async () => {
    mockedReadSession.mockResolvedValueOnce({ ...adminSession, role: "staff" });
    const r = await createUserInternal(
      { email: "x@test.local", name: "Ex", role: "staff" },
      { sendEmail: makeStubSendEmail() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe("role");
      expect(r.error).toMatch(/company users/i);
    }
  });
});

// ── createUser (invite) ────────────────────────────────────────────────────

describe("createUserInternal", () => {
  it("creates an internal user, mints an invite token, and sends the invite", async () => {
    const sendEmail = makeStubSendEmail();
    const r = await createUserInternal(
      { email: "New.Staff@Test.LOCAL", name: "Nina Staff", role: "staff" },
      { sendEmail },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inviteEmailSent).toBe(true);

    const [row] = await db.select().from(users).where(eq(users.id, r.id));
    expect(row?.email).toBe("new.staff@test.local"); // lowercased
    expect(row?.role).toBe("staff");
    expect(row?.companyId).toBeNull();
    expect(row?.isActive).toBe(true);
    expect(row?.emailVerifiedAt).toBeNull(); // not active until accepted

    // Invite token landed in password_reset_tokens.
    const tokens = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, r.id));
    expect(tokens).toHaveLength(1);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]?.[0].subject).toBe(
      "You've been invited to Consultway",
    );
  });

  it("creates a company-role user linked to an existing company", async () => {
    await seedCompany();
    const r = await createUserInternal(
      {
        email: "cu@test.local",
        name: "Cara Company",
        role: "company",
        companyId: COMPANY_ID,
      },
      { sendEmail: makeStubSendEmail() },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [row] = await db.select().from(users).where(eq(users.id, r.id));
    expect(row?.companyId).toBe(COMPANY_ID);
  });

  it("rejects a company-role user pointing at a missing company", async () => {
    const r = await createUserInternal(
      {
        email: "cu@test.local",
        name: "Cara Company",
        role: "company",
        companyId: COMPANY_ID,
      },
      { sendEmail: makeStubSendEmail() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("companyId");
  });

  it("rejects a duplicate email", async () => {
    await seedUser({ id: newId(), email: "dup@test.local" });
    const r = await createUserInternal(
      { email: "dup@test.local", name: "Dupe", role: "staff" },
      { sendEmail: makeStubSendEmail() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("email");
  });
});

// ── updateUser ─────────────────────────────────────────────────────────────

describe("updateUser", () => {
  const U1 = newId();

  it("renames a user and records an audit event", async () => {
    await seedUser({ id: U1, email: "u1@test.local", name: "Old Name" });
    const r = await updateUser({ id: U1, name: "New Name" });
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, U1));
    expect(row?.name).toBe("New Name");
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, U1));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("refuses an admin changing their own role (self-lockout guard)", async () => {
    await seedUser({ id: ADMIN_ID, email: "me@test.local", role: "admin" });
    const r = await updateUser({ id: ADMIN_ID, role: "staff" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("role");
  });

  it("requires a company when promoting to company role, then accepts one", async () => {
    await seedCompany();
    // Seed as staff (not admin) so the last-admin guard isn't the thing
    // refusing the demotion — this test is about the role↔company invariant.
    await seedUser({ id: U1, email: "u1@test.local", role: "staff" });

    const bad = await updateUser({ id: U1, role: "company" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("companyId");

    const good = await updateUser({
      id: U1,
      role: "company",
      companyId: COMPANY_ID,
    });
    expect(good.ok).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, U1));
    expect(row?.role).toBe("company");
    expect(row?.companyId).toBe(COMPANY_ID);
  });

  it("clears companyId when moving a company user to staff", async () => {
    await seedCompany();
    await seedUser({
      id: U1,
      email: "u1@test.local",
      role: "company",
      companyId: COMPANY_ID,
    });
    const r = await updateUser({ id: U1, role: "staff" });
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, U1));
    expect(row?.companyId).toBeNull();
  });
});

// ── deactivate / reactivate ────────────────────────────────────────────────

describe("deactivate / reactivate", () => {
  const U = newId();

  it("deactivates a user and audits the change", async () => {
    await seedUser({ id: U, email: "u@test.local", isActive: true });
    const r = await deactivateUser(U);
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, U));
    expect(row?.isActive).toBe(false);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, U));
    expect(audit?.metadata).toMatchObject({ action: "deactivated" });
  });

  it("refuses self-deactivation", async () => {
    const r = await deactivateUser(ADMIN_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/your own account/i);
  });

  it("is idempotent when already inactive (no second audit)", async () => {
    await seedUser({ id: U, email: "u@test.local", isActive: false });
    const r = await deactivateUser(U);
    expect(r.ok).toBe(true);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, U));
    expect(audits).toHaveLength(0);
  });

  it("reactivates a disabled user", async () => {
    await seedUser({ id: U, email: "u@test.local", isActive: false });
    const r = await reactivateUser(U);
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, U));
    expect(row?.isActive).toBe(true);
  });
});

// ── admin password reset + invite resend ───────────────────────────────────

describe("resetUserPasswordInternal", () => {
  const U = newId();

  it("mints a reset token and sends the reset email for a known user", async () => {
    // Accepted (verified) + active user — reset now refuses pending/inactive.
    await seedUser({
      id: U,
      email: "u@test.local",
      emailVerifiedAt: new Date().toISOString(),
    });
    const sendEmail = makeStubSendEmail();
    const r = await resetUserPasswordInternal(U, { sendEmail });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.emailSent).toBe(true);
    expect(sendEmail.mock.calls[0]?.[0].subject).toBe(
      "Reset your Consultway password",
    );
    const tokens = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, U));
    expect(tokens).toHaveLength(1);
  });

  it("returns not-found for an unknown user", async () => {
    const r = await resetUserPasswordInternal(newId(), {
      sendEmail: makeStubSendEmail(),
    });
    expect(r.ok).toBe(false);
  });
});

describe("resendInviteInternal", () => {
  const U = newId();

  it("resends to an unaccepted user", async () => {
    await seedUser({ id: U, email: "u@test.local", emailVerifiedAt: null });
    const sendEmail = makeStubSendEmail();
    const r = await resendInviteInternal(U, { sendEmail });
    expect(r.ok).toBe(true);
    expect(sendEmail.mock.calls[0]?.[0].subject).toBe(
      "You've been invited to Consultway",
    );
  });

  it("refuses to resend to an already-activated user", async () => {
    await seedUser({
      id: U,
      email: "u@test.local",
      emailVerifiedAt: new Date().toISOString(),
    });
    const r = await resendInviteInternal(U, { sendEmail: makeStubSendEmail() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already activated/i);
  });
});

// ── reads ──────────────────────────────────────────────────────────────────

describe("listUsers / getUser", () => {
  beforeEach(async () => {
    await seedCompany();
    await seedUser({ id: ADA_ID, email: "ada@test.local", name: "Ada Admin", role: "admin" });
    await seedUser({ id: SAM_ID, email: "sam@test.local", name: "Sam Staff", role: "staff" });
    await seedUser({
      id: CARA_ID,
      email: "cara@test.local",
      name: "Cara Company",
      role: "company",
      companyId: COMPANY_ID,
    });
  });

  it("lists all users with the joined company name", async () => {
    const r = await listUsers({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(3);
    const cara = r.rows.find((u) => u.email === "cara@test.local");
    expect(cara?.companyName).toBe("Acme Corp");
    const ada = r.rows.find((u) => u.email === "ada@test.local");
    expect(ada?.companyName).toBeNull();
  });

  it("filters by role", async () => {
    const r = await listUsers({ role: "company" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.email).toBe("cara@test.local");
  });

  it("searches across name and email", async () => {
    const r = await listUsers({ search: "sam@" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.name).toBe("Sam Staff");
  });

  it("getUser returns a row without the password hash", async () => {
    const r = await getUser(ADA_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.email).toBe("ada@test.local");
    expect("passwordHash" in r.user).toBe(false);
  });

  it("getUser returns not-found for an unknown id", async () => {
    const r = await getUser(newId());
    expect(r.ok).toBe(false);
  });
});

// ── RBAC gate on every action (review must-fix #2) ─────────────────────────

describe("auth gating across actions", () => {
  // Unauthenticated callers are refused everywhere.
  const allCases: Array<[string, () => Promise<{ ok: boolean }>]> = [
    ["listUsers", () => listUsers({})],
    ["getUser", () => getUser(newId())],
    ["updateUser", () => updateUser({ id: newId(), name: "New Name" })],
    ["deactivateUser", () => deactivateUser(newId())],
    ["reactivateUser", () => reactivateUser(newId())],
    [
      "resetUserPassword",
      () => resetUserPasswordInternal(newId(), { sendEmail: makeStubSendEmail() }),
    ],
    [
      "resendInvite",
      () => resendInviteInternal(newId(), { sendEmail: makeStubSendEmail() }),
    ],
    [
      "createUser",
      () =>
        createUserInternal(
          {
            email: "x@test.local",
            name: "Ex",
            role: "company",
            companyId: COMPANY_ID,
          },
          { sendEmail: makeStubSendEmail() },
        ),
    ],
  ];

  // The management-lifecycle actions are admin-only — staff are refused.
  // (List/read/create/resend are open to staff and tested in the staff suite.)
  const adminOnly: Array<[string, () => Promise<{ ok: boolean }>]> = [
    ["updateUser", () => updateUser({ id: newId(), name: "New Name" })],
    ["deactivateUser", () => deactivateUser(newId())],
    ["reactivateUser", () => reactivateUser(newId())],
    [
      "resetUserPassword",
      () => resetUserPasswordInternal(newId(), { sendEmail: makeStubSendEmail() }),
    ],
  ];

  for (const [name, run] of allCases) {
    it(`${name} refuses an unauthenticated caller`, async () => {
      mockedReadSession.mockResolvedValueOnce(null);
      const r = await run();
      expect(r.ok).toBe(false);
    });
  }

  for (const [name, run] of adminOnly) {
    it(`${name} refuses a staff caller`, async () => {
      mockedReadSession.mockResolvedValueOnce({ ...adminSession, role: "staff" });
      const r = await run();
      expect(r.ok).toBe(false);
    });
  }
});

// ── Last-admin guard (review must-fix #1) ──────────────────────────────────

describe("last-admin guard", () => {
  it("refuses deactivating the only active admin", async () => {
    const onlyAdmin = newId();
    await seedUser({ id: onlyAdmin, email: "only@test.local", role: "admin" });
    const r = await deactivateUser(onlyAdmin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/administrator must remain/i);
  });

  it("allows deactivating an admin when another active admin exists", async () => {
    const a1 = newId();
    const a2 = newId();
    await seedUser({ id: a1, email: "a1@test.local", role: "admin" });
    await seedUser({ id: a2, email: "a2@test.local", role: "admin" });
    const r = await deactivateUser(a1);
    expect(r.ok).toBe(true);
  });

  it("refuses demoting the only active admin", async () => {
    const onlyAdmin = newId();
    await seedUser({ id: onlyAdmin, email: "only@test.local", role: "admin" });
    const r = await updateUser({ id: onlyAdmin, role: "staff" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("role");
  });

  it("ignores inactive admins — a deactivated admin doesn't hold the seat", async () => {
    const activeAdmin = newId();
    const inactiveAdmin = newId();
    await seedUser({ id: activeAdmin, email: "active@test.local", role: "admin" });
    await seedUser({
      id: inactiveAdmin,
      email: "inactive-admin@test.local",
      role: "admin",
      isActive: false,
    });
    const r = await deactivateUser(activeAdmin);
    expect(r.ok).toBe(false);
  });
});

// ── listUsers status + companyId filters + pagination ──────────────────────

describe("listUsers status / companyId / pagination", () => {
  it("filters by status (active vs inactive)", async () => {
    await seedUser({ id: newId(), email: "on@test.local", isActive: true });
    await seedUser({ id: newId(), email: "off@test.local", isActive: false });

    const inactive = await listUsers({ status: "inactive" });
    expect(inactive.ok).toBe(true);
    if (!inactive.ok) return;
    expect(inactive.rows).toHaveLength(1);
    expect(inactive.rows[0]?.email).toBe("off@test.local");

    const active = await listUsers({ status: "active" });
    if (!active.ok) return;
    expect(active.rows).toHaveLength(1);
    expect(active.rows[0]?.email).toBe("on@test.local");
  });

  it("filters by companyId", async () => {
    await seedCompany();
    await seedUser({
      id: newId(),
      email: "cu@test.local",
      role: "company",
      companyId: COMPANY_ID,
    });
    await seedUser({ id: newId(), email: "staff-x@test.local", role: "staff" });
    const r = await listUsers({ companyId: COMPANY_ID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.email).toBe("cu@test.local");
  });

  it("paginates and sorts ascending", async () => {
    for (let i = 0; i < 3; i++) {
      await seedUser({ id: newId(), email: `p${i}@test.local`, name: `User ${i}` });
    }
    const page1 = await listUsers({
      perPage: "2",
      page: "1",
      sortBy: "email",
      sortDir: "asc",
    });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = await listUsers({
      perPage: "2",
      page: "2",
      sortBy: "email",
      sortDir: "asc",
    });
    if (!page2.ok) return;
    expect(page2.rows).toHaveLength(1);
  });
});

// ── createUser fail-soft + placeholder hash ────────────────────────────────

describe("createUserInternal fail-soft email + placeholder hash", () => {
  it("still creates the user (with token) when the invite email fails", async () => {
    const sendEmail = makeStubSendEmail(async () => ({
      ok: false,
      error: "smtp down",
    }));
    const r = await createUserInternal(
      { email: "soft@test.local", name: "Soft Fail", role: "staff" },
      { sendEmail },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inviteEmailSent).toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, r.id));
    expect(row).toBeTruthy();
    const tokens = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, r.id));
    expect(tokens).toHaveLength(1);
  });

  it("writes an unusable placeholder hash (no password matches)", async () => {
    const r = await createUserInternal(
      { email: "ph@test.local", name: "Placeholder", role: "staff" },
      { sendEmail: makeStubSendEmail() },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [row] = await db.select().from(users).where(eq(users.id, r.id));
    expect(row).toBeTruthy();
    if (!row) return;
    expect(await verifyPassword("anything-they-might-guess", row.passwordHash)).toBe(
      false,
    );
    expect(row.emailVerifiedAt).toBeNull();
  });
});

// ── updateUser additional branches ─────────────────────────────────────────

describe("updateUser additional branches", () => {
  it("rejects moving to company role with a non-existent companyId", async () => {
    const u = newId();
    await seedUser({ id: u, email: "u@test.local", role: "staff" });
    const r = await updateUser({ id: u, role: "company", companyId: newId() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("companyId");
  });

  it("is a no-op for an empty patch (no audit row)", async () => {
    const u = newId();
    await seedUser({ id: u, email: "u@test.local" });
    const r = await updateUser({ id: u });
    expect(r.ok).toBe(true);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, u));
    expect(audits).toHaveLength(0);
  });

  it("allows a pure profile edit of a company user whose company was deleted", async () => {
    const u = newId();
    await seedCompany();
    await seedUser({
      id: u,
      email: "orphan@test.local",
      role: "company",
      companyId: COMPANY_ID,
    });
    // Orphan the link via ON DELETE SET NULL, then do a name-only edit.
    await db.delete(companies).where(eq(companies.id, COMPANY_ID));
    const r = await updateUser({ id: u, name: "Renamed" });
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, u));
    expect(row?.name).toBe("Renamed");
  });
});

// ── Credential action guards (review should-fix) ───────────────────────────

describe("credential action guards", () => {
  it("reset refuses an un-accepted (invite-pending) user", async () => {
    const u = newId();
    await seedUser({ id: u, email: "pending@test.local", emailVerifiedAt: null });
    const r = await resetUserPasswordInternal(u, { sendEmail: makeStubSendEmail() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/resend invite/i);
  });

  it("reset refuses a deactivated user", async () => {
    const u = newId();
    await seedUser({
      id: u,
      email: "off@test.local",
      isActive: false,
      emailVerifiedAt: new Date().toISOString(),
    });
    const r = await resetUserPasswordInternal(u, { sendEmail: makeStubSendEmail() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/deactivated/i);
  });

  it("resend refuses a deactivated user", async () => {
    const u = newId();
    await seedUser({
      id: u,
      email: "off2@test.local",
      isActive: false,
      emailVerifiedAt: null,
    });
    const r = await resendInviteInternal(u, { sendEmail: makeStubSendEmail() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/deactivated/i);
  });

  it("reset on an active accepted user records correct audit metadata", async () => {
    const u = newId();
    await seedUser({
      id: u,
      email: "ok@test.local",
      emailVerifiedAt: new Date().toISOString(),
    });
    const r = await resetUserPasswordInternal(u, { sendEmail: makeStubSendEmail() });
    expect(r.ok).toBe(true);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, u));
    expect(audit?.metadata).toMatchObject({
      action: "password_reset_requested",
      via: "admin",
    });
  });

  it("resend on a pending user records correct audit metadata", async () => {
    const u = newId();
    await seedUser({ id: u, email: "pend2@test.local", emailVerifiedAt: null });
    const r = await resendInviteInternal(u, { sendEmail: makeStubSendEmail() });
    expect(r.ok).toBe(true);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, u));
    expect(audit?.metadata).toMatchObject({ action: "invite_resent" });
  });
});

// ── Staff path — company accounts only ─────────────────────────────────────
//
// Staff own the onboarding lifecycle of *company-user* accounts only: list +
// read + create (invite) + resend. Internal admin/staff accounts are hidden
// as not-found. The management lifecycle (update/deactivate/reset) is refused.

describe("staff path — company accounts only", () => {
  beforeEach(async () => {
    await seedCompany();
    await seedUser({ id: ADA_ID, email: "ada@test.local", name: "Ada Admin", role: "admin" });
    await seedUser({ id: SAM_ID, email: "sam@test.local", name: "Sam Staff", role: "staff" });
    await seedUser({
      id: CARA_ID,
      email: "cara@test.local",
      name: "Cara Company",
      role: "company",
      companyId: COMPANY_ID,
    });
    mockedReadSession.mockResolvedValue(staffSession);
  });

  it("listUsers returns only company-role users for staff", async () => {
    const r = await listUsers({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.email).toBe("cara@test.local");
  });

  it("listUsers ignores a role=admin filter for staff (still only company)", async () => {
    const r = await listUsers({ role: "admin" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.role).toBe("company");
  });

  it("getUser lets staff read a company user", async () => {
    const r = await getUser(CARA_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.email).toBe("cara@test.local");
  });

  it("getUser hides internal (admin/staff) accounts from staff as not-found", async () => {
    const admin = await getUser(ADA_ID);
    expect(admin.ok).toBe(false);
    const staff = await getUser(SAM_ID);
    expect(staff.ok).toBe(false);
  });

  it("createUser lets staff invite a company user", async () => {
    const r = await createUserInternal(
      {
        email: "newco@test.local",
        name: "New Co",
        role: "company",
        companyId: COMPANY_ID,
      },
      { sendEmail: makeStubSendEmail() },
    );
    expect(r.ok).toBe(true);
  });

  it("createUser refuses staff inviting a staff/admin user", async () => {
    const r = await createUserInternal(
      { email: "newstaff@test.local", name: "New Staff", role: "staff" },
      { sendEmail: makeStubSendEmail() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("role");
  });

  it("resendInvite lets staff resend to a pending company user", async () => {
    const pending = newId();
    await seedUser({
      id: pending,
      email: "pendco@test.local",
      role: "company",
      companyId: COMPANY_ID,
      emailVerifiedAt: null,
    });
    const r = await resendInviteInternal(pending, {
      sendEmail: makeStubSendEmail(),
    });
    expect(r.ok).toBe(true);
  });

  it("resendInvite hides internal accounts from staff as not-found", async () => {
    const pendingStaff = newId();
    await seedUser({
      id: pendingStaff,
      email: "pendstaff@test.local",
      role: "staff",
      emailVerifiedAt: null,
    });
    const r = await resendInviteInternal(pendingStaff, {
      sendEmail: makeStubSendEmail(),
    });
    expect(r.ok).toBe(false);
  });

  it("refuses staff on the admin-only actions (update / deactivate / reset)", async () => {
    const upd = await updateUser({ id: CARA_ID, name: "Renamed" });
    expect(upd.ok).toBe(false);
    const deact = await deactivateUser(CARA_ID);
    expect(deact.ok).toBe(false);
    const reset = await resetUserPasswordInternal(CARA_ID, {
      sendEmail: makeStubSendEmail(),
    });
    expect(reset.ok).toBe(false);
  });
});
