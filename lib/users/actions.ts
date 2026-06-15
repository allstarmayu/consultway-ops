/**
 * Users module — Server Actions (admin user management, Day 33).
 *
 * Every mutation and every read the admin user-management UI needs goes
 * through one of these. They are the **only** place user rows are touched
 * directly for management purposes — the UI calls these, never raw SQL.
 *
 * Return shape (the shared `ActionResult`):
 *     { ok: true, ...data }
 *   | { ok: false, error: string, field?: string }
 *
 * Role rules (per docs/08-rbac-matrix.md § Users):
 *   - **Staff** may LIST and READ *company-role* users only (internal
 *     admin/staff accounts are hidden as not-found), CREATE (invite)
 *     company-role users, and RESEND their invites. Staff manage every
 *     client company (there is no per-staff company assignment), so their
 *     scope is "all company users", not a subset. This is the onboarding
 *     lifecycle.
 *   - **Admin-only** (the management lifecycle): updateUser,
 *     deactivate/reactivate, resetUserPassword. Staff are refused.
 *   - Company-role users have no access here at all (gated at the page +
 *     the guards). "When in doubt, deny."
 *
 * Onboarding model: admin-created users never get a password from the
 * admin. `createUser` mints an unusable random hash, then emails a
 * "set your password" invite link (see lib/auth/tokens.ts::mintInviteToken
 * + lib/auth/actions.ts::acceptInvite). No plaintext password is ever
 * handled by the admin.
 *
 * Audit: every mutation calls `recordAuditEvent` after the DB write with
 * `targetType: "user"`. Per the audit module's verb rule, user lifecycle
 * events fold into `created` / `updated` with specifics in `metadata`
 * rather than earning dedicated verbs (no verb-filtered user feed is
 * needed yet). Reads are not audited (too noisy).
 *
 * @module lib/users/actions
 */
"use server";

import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, like, ne, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, companies, type User } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { recordAuditEvent } from "@/lib/audit/log";
import { requireAdmin, requireAdminOrStaff } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { mintInviteToken, mintPasswordResetToken } from "@/lib/auth/tokens";
import { sendEmail, type SendEmailFn } from "@/lib/email/client";
import { renderUserInviteEmail } from "@/lib/email/templates/user-invite";
import { renderPasswordResetRequestEmail } from "@/lib/email/templates/password-reset-request";
import type { ActionResult } from "@/lib/types/action-result";
import {
  createUserSchema,
  updateUserSchema,
  listUsersQuerySchema,
  userIdSchema,
} from "./schemas";

const log = logger.child({ module: "users-actions" });

// ── Public row shapes ─────────────────────────────────────────────────────────

/** A user row with the password hash stripped — safe to return to the UI. */
export type SafeUser = Omit<User, "passwordHash">;

/** A safe user plus the linked company's display name (NULL for admin/staff). */
export type UserWithCompany = SafeUser & { companyName: string | null };

/** Column projection that omits `passwordHash`. Reused across reads. */
const safeUserColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  companyId: users.companyId,
  phone: users.phone,
  jobTitle: users.jobTitle,
  avatarKey: users.avatarKey,
  isActive: users.isActive,
  emailVerifiedAt: users.emailVerifiedAt,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

/** Sort column lookup — restricted set, mirrors the schema's enum. */
const sortColumns = {
  name: users.name,
  email: users.email,
  role: users.role,
  createdAt: users.createdAt,
  lastLoginAt: users.lastLoginAt,
  updatedAt: users.updatedAt,
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * A bcrypt hash of a random secret. Used as the `passwordHash` of an
 * invited user before they accept — the row exists and is FK-valid, but
 * no password can ever match it, so the account cannot be logged into
 * until `acceptInvite` writes a real hash.
 *
 * 16 bytes → 32 hex chars (128 bits): unguessable, yet short enough that
 * `hashPassword` (which appends the pepper) stays under bcrypt's 72-byte
 * ceiling for the project's pepper lengths. The value is never matched
 * against anyway — the invite gate, not this hash, is the real barrier.
 */
async function unusablePasswordHash(): Promise<string> {
  return hashPassword(randomBytes(16).toString("hex"));
}

/** Build the `/set-password?token=` invite URL from a raw token. */
function buildInviteUrl(token: string): string {
  return `${env.NEXT_PUBLIC_APP_URL}/set-password?token=${encodeURIComponent(token)}`;
}

/**
 * Whether at least one OTHER active admin exists (excluding `excludeUserId`).
 * Backs the last-admin guards: the final active admin must not be demoted
 * or deactivated through the UI, because the admin role is grantable ONLY
 * through this admin-only module — dropping to zero admins would require
 * direct DB surgery to recover.
 */
async function anotherActiveAdminExists(excludeUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: count() })
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        eq(users.isActive, true),
        ne(users.id, excludeUserId),
      ),
    );
  return (row?.value ?? 0) > 0;
}

// ── List ──────────────────────────────────────────────────────────────────────

/**
 * List users with filters, search, pagination, and sorting. Admin-only.
 *
 * Joins the linked company's name so the table can render "Acme Corp"
 * instead of a bare UUID for company-role users. The count query skips the
 * join — every filter is on the `users` table.
 *
 * @returns `{ ok: true, rows, total, page, perPage }` or `{ ok: false, error }`.
 */
export async function listUsers(
  rawQuery: unknown,
): Promise<
  ActionResult<{
    rows: UserWithCompany[];
    total: number;
    page: number;
    perPage: number;
  }>
> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  const parsed = listUsersQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid query",
    };
  }
  const query = parsed.data;

  // Build the WHERE additively — every filter is AND-composed.
  const filters: SQL[] = [];
  // Staff see only company-role accounts (their operational scope) — this
  // overrides any role filter that arrives in the query. Admin honours it.
  if (auth.session.role === "staff") {
    filters.push(eq(users.role, "company"));
  } else if (query.role) {
    filters.push(eq(users.role, query.role));
  }
  if (query.status) {
    filters.push(eq(users.isActive, query.status === "active"));
  }
  if (query.companyId) filters.push(eq(users.companyId, query.companyId));
  if (query.search) {
    const term = `%${query.search}%`;
    const searchClause = or(like(users.name, term), like(users.email, term));
    if (searchClause) filters.push(searchClause);
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const sortColumn = sortColumns[query.sortBy];
  const orderBy = query.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const [rows, totalRow] = await Promise.all([
    db
      .select({ ...safeUserColumns, companyName: companies.name })
      .from(users)
      .leftJoin(companies, eq(users.companyId, companies.id))
      .where(whereClause)
      .orderBy(orderBy)
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage),
    db
      .select({ value: count() })
      .from(users)
      .where(whereClause)
      .then((r) => r[0]),
  ]);

  return {
    ok: true,
    rows,
    total: totalRow?.value ?? 0,
    page: query.page,
    perPage: query.perPage,
  };
}

// ── Read one ───────────────────────────────────────────────────────────────────

/**
 * Fetch a single user by id (password hash stripped, company name joined).
 * Admin-only. Returns `{ ok: false }` for unknown ids so the detail page
 * can `notFound()`.
 */
export async function getUser(
  rawId: unknown,
): Promise<ActionResult<{ user: UserWithCompany }>> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  const parsed = userIdSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid user id" };
  }

  const [user] = await db
    .select({ ...safeUserColumns, companyName: companies.name })
    .from(users)
    .leftJoin(companies, eq(users.companyId, companies.id))
    .where(eq(users.id, parsed.data.id))
    .limit(1);

  if (!user) return { ok: false, error: "User not found" };

  // Staff may only read company-role accounts. Internal admin/staff users
  // are hidden as "not found" so the page can `notFound()` and nothing
  // leaks about the internal team.
  if (auth.session.role === "staff" && user.role !== "company") {
    return { ok: false, error: "User not found" };
  }

  return { ok: true, user };
}

// ── Create (invite) ────────────────────────────────────────────────────────────

/**
 * Result of `createUser`. `inviteEmailSent` mirrors the registration flow:
 * the row is created regardless, and the UI surfaces a "resend invite"
 * affordance when the mail couldn't go out.
 */
export type CreateUserResult = ActionResult<{
  id: string;
  inviteEmailSent: boolean;
}>;

/**
 * Create a user via the admin invite flow. Public wrapper — uses the real
 * `sendEmail`. Tests call `createUserInternal` directly with a stub.
 */
export async function createUser(rawInput: unknown): Promise<CreateUserResult> {
  return createUserInternal(rawInput, { sendEmail });
}

/**
 * Email-DI variant of `createUser`. Exported for tests — same DI shape as
 * `registerCompanyInternal`. Pipeline:
 *   1. Admin-or-staff gate (staff may invite company-role users only).
 *   2. Validate (createUserSchema enforces the role ↔ company invariant).
 *   3. For company-role: verify the company exists (friendly error vs FK
 *      violation). Soft-check the email isn't already taken.
 *   4. Insert with an unusable random hash, `isActive: true`,
 *      `emailVerifiedAt: NULL` — the invite gate is the active barrier.
 *   5. Audit `created`.
 *   6. Mint an invite token + send the set-password email (fail-soft).
 */
export async function createUserInternal(
  rawInput: unknown,
  deps: { sendEmail: SendEmailFn },
): Promise<CreateUserResult> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  const parsed = createUserSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  // Staff may only invite company-role users (RBAC matrix § Users). Admins
  // may create any role. Re-checked server-side regardless of what the form
  // sent — the form hides the role picker for staff, this enforces it.
  if (auth.session.role === "staff" && input.role !== "company") {
    return {
      ok: false,
      error: "Staff can only invite company users",
      field: "role",
    };
  }

  // Company-role users must point at a real company.
  if (input.role === "company" && input.companyId) {
    const [company] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .limit(1);
    if (!company) {
      return {
        ok: false,
        error: "That company no longer exists",
        field: "companyId",
      };
    }
  }

  // Soft duplicate-email check — friendlier than the DB UNIQUE violation.
  const [emailHit] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (emailHit) {
    return {
      ok: false,
      error: "An account with this email already exists",
      field: "email",
    };
  }

  const userId = newId();
  const passwordHash = await unusablePasswordHash();
  try {
    await db.insert(users).values({
      id: userId,
      email: input.email,
      passwordHash,
      role: input.role,
      companyId: input.role === "company" ? input.companyId : null,
      name: input.name,
      phone: input.phone ?? null,
      jobTitle: input.jobTitle ?? null,
      isActive: true,
      // emailVerifiedAt left NULL — flipped when the invite is accepted.
    });
  } catch (err) {
    // Translate the email UNIQUE race to a field hint; rethrow anything else.
    if (err instanceof Error && err.message.includes("users.email")) {
      return {
        ok: false,
        error: "An account with this email already exists",
        field: "email",
      };
    }
    log.error("createUser insert failed", { err });
    throw err;
  }

  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "created",
    targetType: "user",
    targetId: userId,
    after: {
      email: input.email,
      role: input.role,
      companyId: input.role === "company" ? input.companyId : null,
      via: "admin-invite",
    },
  });

  // Mint the invite + send the set-password mail. Fail-soft: the user
  // exists regardless; the caller surfaces a resend affordance.
  let inviteEmailSent = false;
  try {
    const { token } = await mintInviteToken(userId);
    const rendered = renderUserInviteEmail({
      user: { name: input.name, email: input.email },
      inviteUrl: buildInviteUrl(token),
      inviterName: auth.session.email,
      expiresInHours: 72,
    });
    const result = await deps.sendEmail({
      to: input.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    inviteEmailSent = result.ok;
    if (!result.ok) {
      log.warn("invite email send failed at createUser", {
        userId,
        error: result.error,
      });
    }
  } catch (err) {
    log.error("invite email pipeline threw at createUser", { err, userId });
  }

  log.info("admin created user", {
    userId,
    role: input.role,
    actorId: auth.session.userId,
  });

  return { ok: true, id: userId, inviteEmailSent };
}

// ── Update ──────────────────────────────────────────────────────────────────────

/**
 * Update a user's profile / role. Admin-only, patch-style.
 *
 * Guards:
 *   - Self-lockout: an admin cannot change their own role away from admin
 *     (would orphan the only admin path through the UI).
 *   - Role ↔ company invariant re-checked against merged state. Moving a
 *     user to admin/staff clears `companyId`; moving to company requires one.
 */
export async function updateUser(rawInput: unknown): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = updateUserSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.id, input.id))
    .limit(1);
  if (!existing) return { ok: false, error: "User not found" };

  // Self-lockout guard.
  if (
    input.id === auth.session.userId &&
    input.role !== undefined &&
    input.role !== "admin"
  ) {
    return {
      ok: false,
      error: "You cannot change your own role",
      field: "role",
    };
  }

  // Merge role + companyId to validate the invariant against final state.
  const mergedRole = input.role ?? existing.role;
  const mergedCompanyId =
    input.companyId !== undefined ? input.companyId : existing.companyId;

  // Last-admin guard: refuse demoting the final active admin — the
  // multi-actor companion to the self-lockout guard above.
  if (
    existing.role === "admin" &&
    mergedRole !== "admin" &&
    !(await anotherActiveAdminExists(existing.id))
  ) {
    return {
      ok: false,
      error: "At least one active administrator must remain",
      field: "role",
    };
  }

  // The company link only needs (re)validation when the patch actually
  // moves role or company. A pure name/phone/jobTitle edit must NOT be
  // blocked by an orphaned companyId (companies.id is ON DELETE SET NULL,
  // so a deleted company nulls the link without changing the role).
  const movesCompanyState =
    input.role !== undefined || input.companyId !== undefined;

  if (mergedRole === "company" && movesCompanyState) {
    if (!mergedCompanyId) {
      return {
        ok: false,
        error: "A company is required for a company-role user",
        field: "companyId",
      };
    }
    // Verify the (possibly new) company exists.
    const [company] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, mergedCompanyId))
      .limit(1);
    if (!company) {
      return {
        ok: false,
        error: "That company no longer exists",
        field: "companyId",
      };
    }
  }

  // Build the patch from provided fields only.
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.role !== undefined) patch.role = input.role;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.jobTitle !== undefined) patch.jobTitle = input.jobTitle;

  // companyId: clear it whenever the merged role is admin/staff; otherwise
  // honour an explicit value from the patch.
  if (mergedRole !== "company") {
    if (existing.companyId !== null) patch.companyId = null;
  } else if (input.companyId !== undefined) {
    patch.companyId = input.companyId;
  }

  if (Object.keys(patch).length === 0) {
    // Nothing to change — idempotent success.
    return { ok: true };
  }

  await db.update(users).set(patch).where(eq(users.id, input.id));

  // Snapshot only the touched fields for the audit trail.
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  (Object.keys(patch) as (keyof typeof patch)[]).forEach((k) => {
    before[k] = existing[k as keyof User];
    after[k] = patch[k];
  });

  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "updated",
    targetType: "user",
    targetId: input.id,
    before,
    after,
  });

  log.info("admin updated user", {
    userId: input.id,
    fields: Object.keys(patch),
    actorId: auth.session.userId,
  });

  return { ok: true };
}

// ── Deactivate / reactivate (soft-delete) ──────────────────────────────────────

/**
 * Soft-disable a user (`isActive → false`). Admin-only. A disabled user
 * cannot sign in (the login action refuses inactive accounts). Cannot
 * deactivate yourself. Idempotent if already inactive.
 */
export async function deactivateUser(rawId: unknown): Promise<ActionResult> {
  return setActive(rawId, false);
}

/** Re-enable a previously deactivated user (`isActive → true`). Admin-only. */
export async function reactivateUser(rawId: unknown): Promise<ActionResult> {
  return setActive(rawId, true);
}

async function setActive(
  rawId: unknown,
  isActive: boolean,
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = userIdSchema.safeParse({ id: rawId });
  if (!parsed.success) return { ok: false, error: "Invalid user id" };
  const { id } = parsed.data;

  if (!isActive && id === auth.session.userId) {
    return { ok: false, error: "You cannot deactivate your own account" };
  }

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!existing) return { ok: false, error: "User not found" };

  if (existing.isActive === isActive) {
    // Already in the desired state — no-op, no audit.
    return { ok: true };
  }

  // Last-admin guard: don't deactivate the final active admin.
  if (
    !isActive &&
    existing.role === "admin" &&
    !(await anotherActiveAdminExists(id))
  ) {
    return {
      ok: false,
      error: "At least one active administrator must remain",
    };
  }

  await db.update(users).set({ isActive }).where(eq(users.id, id));

  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "updated",
    targetType: "user",
    targetId: id,
    before: { isActive: existing.isActive },
    after: { isActive },
    metadata: { action: isActive ? "reactivated" : "deactivated" },
  });

  log.info(isActive ? "admin reactivated user" : "admin deactivated user", {
    userId: id,
    actorId: auth.session.userId,
  });

  return { ok: true };
}

// ── Admin-triggered password reset ─────────────────────────────────────────────

/** Result of `resetUserPassword` / `resendInvite` — reports mail outcome. */
export type EmailActionResult = ActionResult<{ emailSent: boolean }>;

/**
 * Send a password-reset link to a user, triggered by an admin. Public
 * wrapper — uses the real `sendEmail`. Tests call the `*Internal` variant.
 *
 * Distinct from the public `requestPasswordReset` (which is enumeration-
 * defended and self-service): this is admin-initiated, audited, and reports
 * the real not-found / send outcome because the admin is authorised to know.
 */
export async function resetUserPassword(
  rawId: unknown,
): Promise<EmailActionResult> {
  return resetUserPasswordInternal(rawId, { sendEmail });
}

/** Email-DI variant of `resetUserPassword`. Exported for tests. */
export async function resetUserPasswordInternal(
  rawId: unknown,
  deps: { sendEmail: SendEmailFn },
): Promise<EmailActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = userIdSchema.safeParse({ id: rawId });
  if (!parsed.success) return { ok: false, error: "Invalid user id" };

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, parsed.data.id))
    .limit(1);
  if (!user) return { ok: false, error: "User not found" };

  if (!user.isActive) {
    return {
      ok: false,
      error:
        "This account is deactivated. Reactivate it before sending credentials.",
    };
  }
  // A not-yet-accepted user has no real password to reset, and the reset
  // consume would void their outstanding invite token WITHOUT flipping
  // emailVerifiedAt — stranding the account. Steer the admin to Resend
  // invite (the symmetric guard to resendInvite's already-activated check).
  if (!user.emailVerifiedAt) {
    return {
      ok: false,
      error:
        "This user hasn't activated their account yet. Use Resend invite instead.",
    };
  }

  let emailSent = false;
  try {
    const { token } = await mintPasswordResetToken(user.id);
    const resetUrl = `${env.NEXT_PUBLIC_APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    const rendered = renderPasswordResetRequestEmail({
      user: { name: user.name, email: user.email },
      resetUrl,
      expiresInMinutes: 60,
    });
    const result = await deps.sendEmail({
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    emailSent = result.ok;
    if (!result.ok) {
      log.warn("admin password-reset email send failed", {
        userId: user.id,
        error: result.error,
      });
    }
  } catch (err) {
    log.error("admin password-reset pipeline threw", { err, userId: user.id });
  }

  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "updated",
    targetType: "user",
    targetId: user.id,
    metadata: { action: "password_reset_requested", via: "admin", emailSent },
  });

  return { ok: true, emailSent };
}

// ── Resend invite ───────────────────────────────────────────────────────────────

/**
 * Resend the set-password invite to a user who hasn't accepted yet. Public
 * wrapper. Only valid while the account is unaccepted (`emailVerifiedAt`
 * NULL); a user who has activated should use the password-reset flow.
 */
export async function resendInvite(rawId: unknown): Promise<EmailActionResult> {
  return resendInviteInternal(rawId, { sendEmail });
}

/** Email-DI variant of `resendInvite`. Exported for tests. */
export async function resendInviteInternal(
  rawId: unknown,
  deps: { sendEmail: SendEmailFn },
): Promise<EmailActionResult> {
  const auth = await requireAdminOrStaff();
  if (!auth.ok) return auth;

  const parsed = userIdSchema.safeParse({ id: rawId });
  if (!parsed.success) return { ok: false, error: "Invalid user id" };

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, parsed.data.id))
    .limit(1);
  if (!user) return { ok: false, error: "User not found" };

  // Staff may only act on company-user accounts — hide internal users.
  if (auth.session.role === "staff" && user.role !== "company") {
    return { ok: false, error: "User not found" };
  }

  if (!user.isActive) {
    return {
      ok: false,
      error:
        "This account is deactivated. Reactivate it before sending an invite.",
    };
  }

  if (user.emailVerifiedAt) {
    return {
      ok: false,
      error:
        "This user has already activated their account. Use Reset password instead.",
    };
  }

  let emailSent = false;
  try {
    const { token } = await mintInviteToken(user.id);
    const rendered = renderUserInviteEmail({
      user: { name: user.name, email: user.email },
      inviteUrl: buildInviteUrl(token),
      inviterName: auth.session.email,
      expiresInHours: 72,
    });
    const result = await deps.sendEmail({
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    emailSent = result.ok;
    if (!result.ok) {
      log.warn("invite resend send failed", {
        userId: user.id,
        error: result.error,
      });
    }
  } catch (err) {
    log.error("invite resend pipeline threw", { err, userId: user.id });
  }

  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "updated",
    targetType: "user",
    targetId: user.id,
    metadata: { action: "invite_resent", emailSent },
  });

  return { ok: true, emailSent };
}
