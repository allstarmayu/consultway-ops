/**
 * Session management - sign, verify, and manage the session cookie.
 *
 * Uses `jose` (not `jsonwebtoken`) because middleware runs in the Edge
 * runtime which has no Node modules. `jose` works in both Node and Edge.
 *
 * Day 6 note: `proxy.ts` (Next 16's rename of `middleware.ts`) imports
 * `verifySession` and `SESSION_COOKIE` from this file directly. That
 * works because Next 16 runs `proxy.ts` on the Node runtime by default,
 * so the `next/headers` import below doesn't break the proxy bundle.
 * If we ever flip the proxy back to Edge (Next provides no opt-in for
 * that today on `proxy.ts`), we'd need to extract the cookie name,
 * signing key, and `verifySession` into a sibling `./edge.ts` so they
 * can be imported without dragging `next/headers` in.
 *
 * Design:
 *   - Session state lives in a signed JWT inside an httpOnly cookie
 *   - Cookie is scoped to the whole app, SameSite=Lax, Secure in prod
 *   - Payload holds only non-secret identifiers (userId, email, role, companyId)
 *   - 7-day expiry; user must re-authenticate after that
 *
 * Callers:
 *   - lib/auth/actions.ts          - createSession() on successful login
 *   - proxy.ts                     - verifySession() to guard routes
 *   - app/dashboard/page.tsx       - readSession() to personalize UI
 *   - logout Server Action         - destroySession() on sign-out
 *
 * @module lib/auth/session
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { env, isProd } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { UserRole } from "@/lib/db/schema";

const log = logger.child({ module: "session" });

// -- Constants ---------------------------------------------------------------
/** Cookie name. Scoped to this project to avoid collisions on shared domains. */
const SESSION_COOKIE = "cw_session";

/** JWT signing algorithm. HS256 = HMAC-SHA256, symmetric key from env. */
const JWT_ALG = "HS256";

/** Session lifetime. Balance between user friction and stolen-cookie blast radius. */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * JWT signing key, derived once from env.JWT_SECRET.
 * `jose` needs a `Uint8Array`, not a string.
 */
const signingKey = new TextEncoder().encode(env.JWT_SECRET);

// -- Types -------------------------------------------------------------------
/**
 * What we store in the JWT payload. Keep this minimal - JWTs aren't
 * encrypted, only signed. Anything here is readable by whoever has
 * the cookie. Never put sensitive values in this shape.
 */
export interface SessionPayload extends JWTPayload {
  /** User's UUID v7 primary key. Matches users.id in the DB. */
  userId: string;
  /** Lowercased email. Useful for display without a DB lookup. */
  email: string;
  /** Role for quick permission checks without a DB roundtrip. */
  role: UserRole;
  /**
   * Linked company UUID for `company`-role users. NULL for `admin` /
   * `staff`. Cached in the JWT so row-scoped reads (e.g. "my company")
   * don't need a users-table lookup on every request. If the user's
   * company link changes server-side, they'll keep their old scope
   * until the next login - acceptable for our threat model.
   */
  companyId: string | null;
}

// -- Public API --------------------------------------------------------------

/**
 * Sign a session payload into a JWT string. Does NOT set the cookie.
 * Useful when you want the raw token (e.g. tests, API responses).
 */
export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(signingKey);
}

/**
 * Verify a JWT string and return the payload, or null if invalid/expired.
 * Never throws - callers can treat it as a pure boolean-ish check.
 */
export async function verifySession(
  token: string | undefined,
): Promise<SessionPayload | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify<SessionPayload>(token, signingKey, {
      algorithms: [JWT_ALG],
    });
    return payload;
  } catch (err) {
    // Expired, malformed, or signed with a different secret. All "not logged in."
    log.debug("session verification failed", { err });
    return null;
  }
}

/**
 * Create a session for the given user and write the httpOnly cookie.
 * Call this from Server Actions after a successful password check.
 *
 * Must run inside a Server Action or Route Handler (needs cookie write
 * access). Won't work from a Server Component - those can only read.
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
 * NOT safe for callers that don't have cookie-store access (e.g. an Edge-
 * runtime worker would need `verifySession()` directly against a raw
 * token). `proxy.ts` runs on Node so it can use either; today it uses
 * `verifySession` directly after reading the cookie via `req.cookies`.
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
 * Note: this is client-side logout only - since we use stateless JWTs,
 * a stolen token remains valid until its natural expiry. Full revocation
 * requires a DB-backed blocklist (deferred to a later phase).
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  log.info("session destroyed");
}

// -- Exports for proxy.ts ---------------------------------------------------
/**
 * Cookie name - re-exported so proxy.ts can read the raw cookie from
 * the request without re-declaring the constant.
 */
export { SESSION_COOKIE };
