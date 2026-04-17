/**
 * Authentication Server Actions.
 *
 * These are the only place where login/logout logic lives. The login
 * page posts here; the dashboard logout button posts here. They return
 * `{ ok: true } | { ok: false, error: string }` for the client to
 * handle — no throws for expected failures (invalid credentials, etc).
 *
 * Server Actions run on the server only. They're type-safe across the
 * client/server boundary and work without JavaScript (progressive
 * enhancement), though we use react-hook-form on top for UX.
 *
 * Schemas live in ./schemas.ts (not here) because client code can't
 * import non-action values from a "use server" file — Next.js turns
 * those values into remote-call stubs on the client.
 *
 * @module lib/auth/actions
 */
"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { verifyPassword, hashPassword } from "./password";
import { createSession, destroySession } from "./session";
import { loginSchema } from "./schemas";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "auth-actions" });

// ── Result types ────────────────────────────────────────────────────
/**
 * Server Action result. The UI pattern is:
 *   const result = await login(input);
 *   if (!result.ok) setError(result.error);
 * Successful logins don't return — they redirect() mid-function.
 */
export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; field?: "email" | "password" | "form" };

// ── Private: timing-safe dummy hash ─────────────────────────────────
/**
 * Lazy-computed dummy bcrypt hash. We compare against this when the
 * email doesn't exist in the DB, so the response time matches the
 * "email exists but wrong password" path. Defeats user enumeration
 * via timing analysis.
 *
 * Computed once per server instance — bcrypt at cost 10 is ~100ms,
 * not something we want on every failed-email login.
 */
let dummyHashCache: string | null = null;
async function getDummyHash(): Promise<string> {
  if (dummyHashCache) return dummyHashCache;
  dummyHashCache = await hashPassword("dummy-password-for-timing-safety");
  return dummyHashCache;
}

// ── Public: login ───────────────────────────────────────────────────
/**
 * Verify credentials, create a session, redirect to /dashboard.
 *
 * Never reveals whether the failure was "email not found" or "wrong
 * password" — both return the same generic error with the same
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

  const { email, password } = parsed.data;

  // 2. Look up user by email (already lowercased by the schema).
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // 3. If not found, run a dummy hash comparison to match timing.
  //    Same error message regardless — no user enumeration.
  if (!user) {
    await verifyPassword(password, await getDummyHash());
    log.info("login failed: unknown email", { email });
    return { ok: false, error: "Invalid email or password", field: "form" };
  }

  // 4. Check the password.
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    log.info("login failed: wrong password", { email, userId: user.id });
    return { ok: false, error: "Invalid email or password", field: "form" };
  }

  // 5. Refuse deactivated accounts.
  if (!user.isActive) {
    log.info("login failed: account deactivated", { email, userId: user.id });
    return {
      ok: false,
      error: "This account is disabled. Contact support.",
      field: "form",
    };
  }

  // 6. Issue the session cookie.
  await createSession({
    userId: user.id,
    email: user.email,
    role: user.role,
  });

  // 7. Stamp last_login_at. Non-critical — failure doesn't break login.
  try {
    await db
      .update(users)
      .set({ lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, user.id));
  } catch (err) {
    log.warn("failed to update last_login_at", { userId: user.id, err });
  }

  log.info("login succeeded", { userId: user.id, role: user.role });

  // 8. Redirect. MUST be outside any try/catch — Next.js signals
  //    redirects via a thrown special value that we don't want caught.
  redirect("/dashboard");
}

// ── Public: logout ──────────────────────────────────────────────────
/**
 * Clear the session cookie and redirect to /login.
 *
 * Client-side logout only — since we use stateless JWTs, a stolen
 * token stays valid until its natural expiry. Full revocation needs
 * a DB-backed blocklist (deferred).
 */
export async function logout(): Promise<never> {
  await destroySession();
  redirect("/login");
}
