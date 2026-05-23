/**
 * Authentication Server Actions.
 *
 * These are the only place where login/logout logic lives. The login
 * page posts here; the dashboard logout button posts here. They return
 * `{ ok: true } | { ok: false, error: string }` for the client to
 * handle - no throws for expected failures (invalid credentials, etc).
 *
 * Server Actions run on the server only. They're type-safe across the
 * client/server boundary and work without JavaScript (progressive
 * enhancement), though we use react-hook-form on top for UX.
 *
 * Schemas live in ./schemas.ts (not here) because client code can't
 * import non-action values from a "use server" file - Next.js turns
 * those values into remote-call stubs on the client.
 *
 * Day 6: the `login` action now honours an optional `from` field for
 * post-login redirection. `proxy.ts` already sets `?from=<path>` on
 * the redirect URL when bouncing unauthenticated users; this chunk
 * wires the value through the form and back into the post-login
 * redirect. The destination is validated via `safeFromPath()` to defeat
 * open-redirect attacks - anything not recognisably "a path on this
 * site" falls back to `/dashboard`.
 *
 * @module lib/auth/actions
 */
"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { users, companies } from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { recordAuditEvent, SYSTEM_ACTOR_ID } from "@/lib/audit/log";
import { sendEmail, type SendEmailFn } from "@/lib/email/client";
import { renderEmailVerificationEmail } from "@/lib/email/templates/email-verification";
import { mintEmailVerificationToken } from "./tokens";
import { verifyPassword, hashPassword } from "./password";
import { createSession, destroySession } from "./session";
import {
  loginSchema,
  registerCompanySchema,
  resendVerificationSchema,
} from "./schemas";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "auth-actions" });

// -- Result types -----------------------------------------------------------
/**
 * Server Action result. The UI pattern is:
 *   const result = await login(input);
 *   if (!result.ok) setError(result.error);
 * Successful logins don't return - they redirect() mid-function.
 */
export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; field?: "email" | "password" | "form" };

// -- Private: post-login destination validator -----------------------------
/**
 * Coerce a user-supplied `from` value into a safe redirect path.
 *
 * The threat model: a malicious site embeds `/login?from=https://evil.example/phish`
 * in a phishing link. A naive `redirect(from ?? "/dashboard")` would
 * happily bounce the now-authenticated user off-site, where the attacker's
 * page can render content that looks like ours and trick them into
 * disclosing more credentials.
 *
 * The safe rule: only honour paths that look like "a route on this
 * application". Specifically:
 *   - Must start with exactly ONE forward slash. `//evil.example/x` is
 *     a protocol-relative URL that browsers interpret as absolute.
 *   - Must not contain a backslash (Windows path separator that some
 *     parsers normalise to forward slash, defeating prefix checks).
 *   - Must not start with `/api/` - those are RPC endpoints, not pages
 *     a user can land on. A redirect there would 404 or worse.
 *   - Must be reasonably short. A 4 KB `from=` is almost certainly an
 *     attack or a bug.
 *
 * Anything that fails any rule is replaced with `/dashboard`. We do NOT
 * log the rejection as a security event because legitimate users hit
 * this path occasionally (bookmarked URLs from a different deploy, etc.)
 * and we don't want to noise up the security signal.
 */
const MAX_FROM_LENGTH = 512;

function safeFromPath(raw: string | undefined): string {
  const fallback = "/dashboard";
  if (!raw) return fallback;
  if (raw.length > MAX_FROM_LENGTH) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback;
  if (raw.startsWith("/api/")) return fallback;
  return raw;
}

// -- Private: timing-safe dummy hash ---------------------------------------
/**
 * Lazy-computed dummy bcrypt hash. We compare against this when the
 * email doesn't exist in the DB, so the response time matches the
 * "email exists but wrong password" path. Defeats user enumeration
 * via timing analysis.
 *
 * Computed once per server instance - bcrypt at cost 10 is ~100ms,
 * not something we want on every failed-email login.
 */
let dummyHashCache: string | null = null;
async function getDummyHash(): Promise<string> {
  if (dummyHashCache) return dummyHashCache;
  dummyHashCache = await hashPassword("dummy-password-for-timing-safety");
  return dummyHashCache;
}

// -- Public: login ----------------------------------------------------------
/**
 * Verify credentials, create a session, redirect to the post-login
 * destination (or `/dashboard` if none / unsafe).
 *
 * Never reveals whether the failure was "email not found" or "wrong
 * password" - both return the same generic error with the same
 * response time.
 */
export async function login(rawInput: unknown): Promise<ActionResult> {
  // 1. Validate input shape.
  const parsed = loginSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
      field: "form",
    };
  }

  const { email, password, from } = parsed.data;

  // 2. Resolve the safe redirect destination BEFORE password checks.
  //    Doing it up front means a failing login response time isn't
  //    affected by whether `from` parsing is slow (it isn't, but
  //    keeping the security-sensitive work outside the credential-
  //    check timing window is a habit worth keeping).
  const destination = safeFromPath(from);

  // 3. Look up user by email (already lowercased by the schema).
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // 4. If not found, run a dummy hash comparison to match timing.
  //    Same error message regardless - no user enumeration.
  if (!user) {
    await verifyPassword(password, await getDummyHash());
    log.info("login failed: unknown email", { email });
    return { ok: false, error: "Invalid email or password", field: "form" };
  }

  // 5. Check the password.
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    log.info("login failed: wrong password", { email, userId: user.id });
    return { ok: false, error: "Invalid email or password", field: "form" };
  }

  // 6. Refuse deactivated accounts.
  if (!user.isActive) {
    log.info("login failed: account deactivated", { email, userId: user.id });
    return {
      ok: false,
      error: "This account is disabled. Contact support.",
      field: "form",
    };
  }

  // 6b. Refuse unverified accounts. Distinct error message + an `email`
  //     field hint so the login UI can surface a "resend verification"
  //     prompt for exactly this branch (not on other failures — that
  //     would help email enumeration).
  if (!user.emailVerifiedAt) {
    log.info("login failed: email not verified", {
      email,
      userId: user.id,
    });
    return {
      ok: false,
      error: "Verify your email first. We sent you a link when you signed up.",
      field: "email",
    };
  }

  // 7. Issue the session cookie. `companyId` is carried into the JWT
  //    so row-scoped reads (companies, documents, tenders) can authorise
  //    without an extra users-table lookup on every request.
  await createSession({
    userId: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
  });

  // 8. Stamp last_login_at. Non-critical - failure doesn't break login.
  try {
    await db
      .update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, user.id));
  } catch (err) {
    log.warn("failed to update last_login_at", { userId: user.id, err });
  }

  log.info("login succeeded", {
    userId: user.id,
    role: user.role,
    // Log whether we honoured a custom destination or fell back. Helps
    // spot a sudden spike in malicious-looking from= values during
    // incident triage.
    destination,
  });

  // 9. Redirect. MUST be outside any try/catch - Next.js signals
  //    redirects via a thrown special value that we don't want caught.
  redirect(destination);
}

// -- Public: logout ---------------------------------------------------------
/**
 * Clear the session cookie and redirect to /login.
 *
 * Client-side logout only - since we use stateless JWTs, a stolen
 * token stays valid until its natural expiry. Full revocation needs
 * a DB-backed blocklist (deferred).
 */
export async function logout(): Promise<never> {
  await destroySession();
  redirect("/login");
}

// -- Public: registerCompany (Day 15) --------------------------------------

/**
 * Result type for `registerCompany`. Returns the created ids on success
 * and reports whether the verification email actually went out — the
 * /register/check-email landing reads `verificationEmailSent: false` to
 * show a "resend" button rather than pretending the mail was sent.
 */
export type RegisterCompanyResult =
  | {
      ok: true;
      userId: string;
      companyId: string;
      verificationEmailSent: boolean;
    }
  | { ok: false; error: string; field?: string };

/**
 * Create a paired (company, user) row from public registration.
 *
 * Unlike `createCompany` (admin/staff-only), this path is unauthenticated
 * — the caller is by definition a prospect who doesn't yet have an
 * account. We:
 *
 *   1. Validate input via Zod (schema enforces the password policy and
 *      cross-validates userEmail / contactEmail).
 *   2. Soft-check for duplicate user email, GST, and PAN BEFORE the
 *      insert, so the form can surface friendlier errors than the DB
 *      unique-violation surface. These checks are advisory — the actual
 *      INSERT still races with a parallel registration, so we also
 *      translate any post-insert UNIQUE failure to the same field hint.
 *   3. Insert the `companies` row with `complianceStatus: 'pending'`.
 *      The created company is unverified-pending until staff onboard them.
 *   4. Insert the `users` row with `role: 'company'`, the new company id,
 *      `isActive: true`, and `emailVerifiedAt: null`. The verification
 *      gate (Chunk 2) is the active barrier — not `isActive`, which we
 *      reserve for staff-driven deactivation.
 *   5. Audit both inserts with `actorRole: 'system'` and the nil
 *      `SYSTEM_ACTOR_ID` — there is no real actor before this action
 *      runs. Same convention the cron uses.
 *
 * Returns `{ ok: true, userId, companyId }` on success. Chunk 2 picks up
 * from here to mint a verification token and send the email.
 */
/**
 * Public wrapper. Uses the production `sendEmail` for verification.
 * Tests should call `registerCompanyInternal` directly with a stub.
 */
export async function registerCompany(
  rawInput: unknown,
): Promise<RegisterCompanyResult> {
  return registerCompanyInternal(rawInput, { sendEmail });
}

/**
 * Email-DI variant of `registerCompany`. Exported for tests — same shape
 * as the cron's expiry-sweep DI pattern (Day 10) and the application-
 * status notifier (Day 14). The production action calls this with the
 * real `sendEmail`.
 */
export async function registerCompanyInternal(
  rawInput: unknown,
  deps: { sendEmail: SendEmailFn },
): Promise<RegisterCompanyResult> {
  // 1. Validate input shape. First failure carries a field hint so the
  //    form can highlight the offender.
  const parsed = registerCompanySchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input = parsed.data;

  // 2. Soft duplicate checks. Friendlier than letting the DB UNIQUE
  //    violation propagate up. Parallel queries — each on an indexed
  //    column so the round-trip is cheap.
  const [emailHit, gstHit, panHit] = await Promise.all([
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.userEmail))
      .limit(1),
    input.gstNumber
      ? db
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.gstNumber, input.gstNumber))
          .limit(1)
      : Promise.resolve([] as { id: string }[]),
    input.panNumber
      ? db
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.panNumber, input.panNumber))
          .limit(1)
      : Promise.resolve([] as { id: string }[]),
  ]);

  if (emailHit.length > 0) {
    return {
      ok: false,
      error: "An account with this email already exists",
      field: "userEmail",
    };
  }
  if (gstHit.length > 0) {
    return {
      ok: false,
      error: "A company with this GST number is already registered",
      field: "gstNumber",
    };
  }
  if (panHit.length > 0) {
    return {
      ok: false,
      error: "A company with this PAN is already registered",
      field: "panNumber",
    };
  }

  // 3. Insert the company row.
  const companyId = newId();
  try {
    await db.insert(companies).values({
      id: companyId,
      name: input.companyName,
      sector: input.sector,
      geography: input.geography,
      gstNumber: input.gstNumber,
      panNumber: input.panNumber,
      isMsme: false,
      isJv: false,
      complianceStatus: "pending",
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      contactPersonName: input.contactPersonName,
    });
  } catch (err) {
    const conflict = translateRegistrationConflict(err);
    if (conflict) {
      log.info("registerCompany unique conflict on company insert", {
        field: conflict.field,
      });
      return { ok: false, ...conflict };
    }
    log.error("registerCompany company insert failed", { err });
    throw err;
  }

  // 4. Insert the user row. Wrap with an attempt to clean up the company
  //    if the user insert fails — neither row is useful on its own.
  const userId = newId();
  const passwordHash = await hashPassword(input.password);
  try {
    await db.insert(users).values({
      id: userId,
      email: input.userEmail,
      passwordHash,
      role: "company",
      companyId,
      name: input.userName,
      isActive: true,
      // emailVerifiedAt left undefined -> NULL on insert. The verification
      // gate (Chunk 2) is the active barrier; isActive=true means the
      // account is not staff-disabled, distinct from "not yet verified".
    });
  } catch (err) {
    // Roll back the company insert. Best-effort — if this fails too, the
    // company row stays orphaned (no linked user) which is acceptable;
    // duplicate-detection above will guide the user to a fresh attempt.
    log.error("registerCompany user insert failed; rolling back company", {
      err,
      companyId,
    });
    try {
      await db.delete(companies).where(eq(companies.id, companyId));
    } catch (cleanupErr) {
      log.error("registerCompany rollback of company failed", {
        cleanupErr,
        companyId,
      });
    }
    const conflict = translateRegistrationConflict(err);
    if (conflict) {
      return { ok: false, ...conflict };
    }
    throw err;
  }

  // 5. Audit both creations. No real actor, so we use the nil SYSTEM
  //    sentinel + role:"system" — same convention the cron uses.
  await recordAuditEvent({
    actorId: SYSTEM_ACTOR_ID,
    actorRole: "system",
    action: "created",
    targetType: "company",
    targetId: companyId,
    after: {
      name: input.companyName,
      sector: input.sector,
      geography: input.geography,
      complianceStatus: "pending",
      via: "public-registration",
    },
  });
  await recordAuditEvent({
    actorId: SYSTEM_ACTOR_ID,
    actorRole: "system",
    action: "created",
    targetType: "user",
    targetId: userId,
    after: {
      email: input.userEmail,
      role: "company",
      companyId,
      via: "public-registration",
    },
  });

  log.info("public registration created company + user", {
    userId,
    companyId,
    companyName: input.companyName,
  });

  // 6. Mint a verification token and send the verification email. Fail-
  //    soft: registration succeeded; if the mail can't go we still return
  //    ok:true so the form lands on /register/check-email — that page
  //    surfaces a "resend" button when `verificationEmailSent` is false.
  let verificationEmailSent = false;
  try {
    const { token } = await mintEmailVerificationToken(userId);
    const verifyUrl = `${env.NEXT_PUBLIC_APP_URL}/auth/verify?token=${encodeURIComponent(token)}`;
    const rendered = renderEmailVerificationEmail({
      user: { name: input.userName, email: input.userEmail },
      verifyUrl,
      expiresInHours: 24,
    });
    const result = await deps.sendEmail({
      to: input.userEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    verificationEmailSent = result.ok;
    if (!result.ok) {
      log.warn("verification email send failed at registration", {
        userId,
        error: result.error,
      });
    }
  } catch (err) {
    log.error("verification email pipeline threw at registration", {
      err,
      userId,
    });
  }

  return { ok: true, userId, companyId, verificationEmailSent };
}

// -- Public: resendVerificationEmail (Day 15) ------------------------------

/**
 * Resend a verification email for an unverified account.
 *
 * Enumeration defence: always returns `{ ok: true }` regardless of whether
 * the email exists. The caller-facing UI (the /register/check-email page's
 * "resend" button) renders the same "if your account exists, we sent a
 * link" copy in both cases. Specifically:
 *
 *   - Unknown email     -> no insert, no send, log at info, return ok:true
 *   - Known + verified  -> no insert, no send, log at info, return ok:true
 *   - Known + pending   -> mint new token, send email, return ok:true
 *
 * The "verified" branch silently no-ops because a successful enumeration
 * here would tell an attacker which addresses already have accounts. The
 * trade-off: a user who already verified and clicks resend gets nothing —
 * we accept that confusion because login already works for them.
 */
export async function resendVerificationEmail(
  rawInput: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return resendVerificationEmailInternal(rawInput, { sendEmail });
}

/** Email-DI variant of `resendVerificationEmail`. Exported for tests. */
export async function resendVerificationEmailInternal(
  rawInput: unknown,
  deps: { sendEmail: SendEmailFn },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = resendVerificationSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { email } = parsed.data;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    log.info("resendVerificationEmail: unknown email (silently ok)", { email });
    return { ok: true };
  }
  if (user.emailVerifiedAt) {
    log.info("resendVerificationEmail: already verified (silently ok)", {
      userId: user.id,
    });
    return { ok: true };
  }

  try {
    const { token } = await mintEmailVerificationToken(user.id);
    const verifyUrl = `${env.NEXT_PUBLIC_APP_URL}/auth/verify?token=${encodeURIComponent(token)}`;
    const rendered = renderEmailVerificationEmail({
      user: { name: user.name, email: user.email },
      verifyUrl,
      expiresInHours: 24,
    });
    const result = await deps.sendEmail({
      to: user.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (!result.ok) {
      log.warn("verification email resend failed", {
        userId: user.id,
        error: result.error,
      });
    }
  } catch (err) {
    log.error("verification email resend threw", { err, userId: user.id });
  }

  // Always return ok:true to the caller — see enumeration-defence note
  // in the docstring above.
  return { ok: true };
}

// -- Private: translate SQLite UNIQUE conflicts to form-friendly errors ---

/**
 * SQLite reports unique conflicts as:
 *   SQLITE_CONSTRAINT: UNIQUE constraint failed: <table>.<column>
 * Translate the three that matter for registration into form-field hints.
 * Anything we don't recognise returns null so the caller rethrows.
 */
function translateRegistrationConflict(
  err: unknown,
): { error: string; field: string } | null {
  if (!(err instanceof Error)) return null;
  const msg = err.message;
  if (msg.includes("users.email")) {
    return {
      error: "An account with this email already exists",
      field: "userEmail",
    };
  }
  if (msg.includes("companies.gst_number")) {
    return {
      error: "A company with this GST number is already registered",
      field: "gstNumber",
    };
  }
  if (msg.includes("companies.pan_number")) {
    return {
      error: "A company with this PAN is already registered",
      field: "panNumber",
    };
  }
  return null;
}
