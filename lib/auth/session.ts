/**
 * Session management — sign, verify, and manage the session cookie.
 *
 * Uses `jose` (not `jsonwebtoken`) because middleware runs in the Edge
 * runtime which has no Node modules. `jose` works in both Node and Edge.
 *
 * Design:
 *   - Session state lives in a signed JWT inside an httpOnly cookie
 *   - Cookie is scoped to the whole app, SameSite=Lax, Secure in prod
 *   - Payload holds only non-secret identifiers (userId, email, role)
 *   - 7-day expiry; user must re-authenticate after that
 *
 * Callers:
 *   - lib/auth/actions.ts          — createSession() on successful login
 *   - middleware.ts                — readSession() to guard routes
 *   - app/dashboard/page.tsx       — readSession() to personalize UI
 *   - logout Server Action         — destroySession() on sign-out
 *
 * @module lib/auth/session
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { env, isProd } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { UserRole } from "@/lib/db/schema";

const log = logger.child({ module: "session" });

// ── Constants ────────────────────────────────────────────────────────
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

// ── Types ────────────────────────────────────────────────────────────
/**
 * What we store in the JWT payload. Keep this minimal — JWTs aren't
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
}

// ── Public API ──────────────────────────────────────────────────────

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
 * Never throws — callers can treat it as a pure boolean-ish check.
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
 * NOT safe for middleware — middleware uses `verifySession()` directly
 * against the request cookie (see middleware.ts).
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

// ── Exports for edge runtime (middleware) ───────────────────────────
/**
 * Cookie name — re-exported so middleware.ts can read the raw cookie
 * without pulling in the Server-only `next/headers` import.
 */
export { SESSION_COOKIE };
