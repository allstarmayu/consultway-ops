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
import { users } from "@/lib/db/schema";
import { verifyPassword, hashPassword } from "./password";
import { createSession, destroySession } from "./session";
import { loginSchema } from "./schemas";
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
