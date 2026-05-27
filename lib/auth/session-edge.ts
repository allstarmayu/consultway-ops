/**
 * Edge-safe session primitives.
 *
 * Extracted from `lib/auth/session.ts` so `proxy.ts` (which runs on
 * the Cloudflare edge runtime under OpenNext) can verify a session
 * cookie WITHOUT dragging in:
 *   - `next/headers` (Server-Components-only API)
 *   - `@/lib/db` → `better-sqlite3` (Node-native, edge-incompatible)
 *   - `@/lib/logger` (may depend on Node-only deps)
 *
 * What lives here: the small surface that's pure crypto + types +
 * constants. JWT signing/verification via `jose` (cross-runtime by
 * design), the session payload shape, the cookie name, and the
 * signing key derivation.
 *
 * What lives in `./session.ts`: the Node-only helpers that read /
 * write cookies via `next/headers` (`createSession`, `readSession`,
 * `destroySession`) and DB-touching helpers (`assertUserExists`).
 * That module re-exports everything from here so existing callers
 * (Server Components, Server Actions, tests) keep working with a
 * single import path.
 *
 * Why no `logger.debug` call inside verifySession (vs. the original):
 *   `logger` (`pino`) isn't edge-safe. The debug line was only
 *   surfaced for "expired / wrong-secret JWT" cases, which are normal
 *   user-flow events (cookie aged out, server restarted with a new
 *   secret), not infrastructure incidents. Dropping the log is no
 *   loss of forensic value at the edge — the redirect to `/login`
 *   makes the outcome observable.
 *
 * @module lib/auth/session-edge
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { env } from "@/lib/env";
import type { UserRole } from "@/lib/db/schema";

// -- Constants ---------------------------------------------------------------

/** Cookie name. Scoped to this project to avoid collisions on shared domains. */
export const SESSION_COOKIE = "cw_session";

/** JWT signing algorithm. HS256 = HMAC-SHA256, symmetric key from env. */
export const JWT_ALG = "HS256";

/** Session lifetime. Balance between user friction and stolen-cookie blast radius. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * JWT signing key, derived once from env.JWT_SECRET.
 * `jose` needs a `Uint8Array`, not a string.
 *
 * Exported so the Node-side session module can pass it to the same
 * jose API without re-deriving (cheap, but keeps the secret-handling
 * code in exactly one place).
 */
export const signingKey = new TextEncoder().encode(env.JWT_SECRET);

// -- Types -------------------------------------------------------------------

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
  /**
   * Linked company UUID for `company`-role users. NULL for `admin` /
   * `staff`. Cached in the JWT so row-scoped reads (e.g. "my company")
   * don't need a users-table lookup on every request. If the user's
   * company link changes server-side, they'll keep their old scope
   * until the next login — acceptable for our threat model.
   */
  companyId: string | null;
}

// -- Public API --------------------------------------------------------------

/**
 * Sign a session payload into a JWT string. Does NOT set the cookie.
 * Useful when you want the raw token (e.g. tests, API responses).
 *
 * Edge-safe — `jose` works in both Node and Workers.
 */
export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(signingKey);
}

/**
 * Verify a JWT string and return the payload, or null if invalid /
 * expired. Never throws — callers can treat it as a pure boolean-ish
 * check.
 *
 * Edge-safe — used by `proxy.ts` to gate `/dashboard/*` routes on
 * every request. ~sub-millisecond on warm workers.
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
  } catch {
    // Expired, malformed, or signed with a different secret. All
    // "not logged in." No log call — see module docstring.
    return null;
  }
}
