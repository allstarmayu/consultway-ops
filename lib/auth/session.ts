/**
 * Session management — Node-runtime helpers (cookie I/O + DB checks).
 *
 * The edge-safe primitives (JWT sign/verify, cookie name, payload
 * type, signing key) live in `./session-edge.ts`. This file re-exports
 * those for backward-compat with every caller that already imports
 * from `@/lib/auth/session`, then adds the helpers that need
 * `next/headers` or the DB and therefore CAN'T run on Cloudflare's
 * edge runtime.
 *
 * Layer A note: as of session.ts being split (Layer A — first remote
 * deploy via OpenNext-on-Cloudflare), `proxy.ts` runs on the edge
 * runtime and MUST import from `./session-edge` directly. Importing
 * from THIS file in the proxy would drag the `next/headers` + `db`
 * deps into the edge bundle and crash the OpenNext build with
 *   ERROR Node.js middleware is not currently supported.
 *
 * Design:
 *   - Session state lives in a signed JWT inside an httpOnly cookie
 *   - Cookie is scoped to the whole app, SameSite=Lax, Secure in prod
 *   - Payload holds only non-secret identifiers (userId, email, role, companyId)
 *   - 7-day expiry; user must re-authenticate after that
 *
 * Callers:
 *   - lib/auth/actions.ts          - createSession() on successful login
 *   - app/dashboard/page.tsx       - readSession() to personalize UI
 *   - logout Server Action         - destroySession() on sign-out
 *   - Most action modules          - readSession() + assertUserExists()
 *
 * @module lib/auth/session
 */
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { isProd } from "@/lib/env";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
  type SessionPayload,
} from "./session-edge";

// Re-export the edge-safe surface so callers don't have to know which
// module each piece lives in — `@/lib/auth/session` stays the canonical
// import path for everything except `proxy.ts`.
export {
  SESSION_COOKIE,
  signSession,
  verifySession,
  type SessionPayload,
} from "./session-edge";

const log = logger.child({ module: "session" });

/**
 * Create a session for the given user and write the httpOnly cookie.
 * Call this from Server Actions after a successful password check.
 *
 * Must run inside a Server Action or Route Handler (needs cookie write
 * access). Won't work from a Server Component — those can only read.
 */
export async function createSession(payload: SessionPayload): Promise<void> {
  const token = await signSession(payload);
  const cookieStore = await cookies();

  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  log.info("session created", { userId: payload.userId, role: payload.role });
}

/**
 * Read and verify the current request's session cookie.
 * Returns null if no cookie, invalid signature, or expired.
 *
 * Safe to call from Server Components, Route Handlers, and Server Actions.
 * NOT safe from `proxy.ts` (edge runtime) — that file uses
 * `verifySession()` from `./session-edge` directly after reading the
 * cookie via `req.cookies`.
 */
export async function readSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return verifySession(token);
}

/**
 * Destroy the current session by deleting the cookie.
 * Call from a logout Server Action.
 *
 * Note: this is client-side logout only — since we use stateless JWTs,
 * a stolen token remains valid until its natural expiry. Full revocation
 * requires a DB-backed blocklist (deferred to a later phase).
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  log.info("session destroyed");
}

/**
 * Verify the session's userId still maps to a live row in `users`.
 *
 * Use case: defending against a "stale JWT" — the cookie is signed
 * correctly and not expired, but the userId it carries no longer
 * exists in the DB. Common causes:
 *   - Local dev DB was reseeded between issuing the cookie and the
 *     current request.
 *   - The user account was deleted (admin action, GDPR purge) while
 *     the user still had an active session.
 *
 * Without this check, any action that takes the session userId and
 * writes to a child table (e.g. inserting into `user_preferences`)
 * blows up at the FK constraint with `SQLITE_CONSTRAINT_FOREIGNKEY`.
 * Callers should branch on `false` to short-circuit with a friendly
 * `STALE_SESSION_ERROR` (see `lib/auth/stale-session.ts`) and route
 * the user through `/auth/clear-session` so the dead cookie gets
 * deleted before `proxy.ts` can bounce them.
 *
 * One indexed lookup per call — cheap. Returns `false` on any DB
 * error so callers can fail-closed without try/catching every site.
 *
 * @example
 *   const session = await readSession();
 *   if (!session) return { ok: false, error: "Sign in" };
 *   if (!(await assertUserExists(session.userId))) {
 *     return { ok: false, error: STALE_SESSION_ERROR };
 *   }
 *
 * @param userId The session payload's userId.
 * @returns true if a row exists, false otherwise (including on error).
 */
export async function assertUserExists(userId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    // Fail closed — better to surface a stale-session toast than to
    // proceed and FK-fault one query later.
    log.warn("assertUserExists failed, treating as missing", { err, userId });
    return false;
  }
}
