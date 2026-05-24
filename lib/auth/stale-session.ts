/**
 * Stale-session contract — shared between the preferences action layer (which
 * raises the error) and any client toast handler / Server Component that
 * needs to react to it.
 *
 * Background: a JWT session cookie can outlive the `users` row it points
 * at (local DB reseed, prod row deletion, etc.). The cookie still verifies
 * cleanly in `proxy.ts` because the signature + expiry are intact — but
 * any DB write keyed on `session.userId` will FK-fault. Day-25 Chunk 5
 * added a `userExists` guard in `lib/preferences/actions.ts` that converts
 * this case to `{ ok: false, error: STALE_SESSION_ERROR }`.
 *
 * That guard surfaced a follow-on bug: redirecting a stale-session user
 * to `/login` does NOT work, because `proxy.ts` sees a still-valid cookie
 * heading to an auth page and bounces them back to `/dashboard`. Net
 * effect: clicking Settings (or any module that loads user-FK'd prefs)
 * silently lands the user on the dashboard.
 *
 * The fix is to **clear the cookie** before redirecting to `/login`. Since
 * Server Components can't write cookies, the redirect target is a Route
 * Handler at `/auth/clear-session` which deletes the cookie then forwards
 * to the final destination. This module is the central home for both the
 * error string AND the URL builder, so action authors, settings pages,
 * and toast handlers all agree on the contract.
 *
 * @module lib/auth/stale-session
 */

/**
 * The user-facing message returned by any action that hits the
 * stale-session case. Stable so client callers can detect it via
 * `isStaleSessionError(error)`.
 */
export const STALE_SESSION_ERROR =
  "Your session is no longer valid. Please sign out and sign in again.";

/**
 * The clear-session Route Handler path. Use `buildStaleSessionRedirectUrl`
 * for the redirect target — this constant is only exported so the route
 * handler itself can name its own path without drift.
 */
export const CLEAR_SESSION_PATH = "/auth/clear-session";

/**
 * Predicate for client callers: was this action result a stale-session
 * failure? Matches on the exact error string the action layer produces,
 * so future re-wordings only need to happen in one place (the constant
 * above).
 */
export function isStaleSessionError(error: string | undefined): boolean {
  return error === STALE_SESSION_ERROR;
}

/**
 * Build the URL a stale-session caller should redirect to. Hits the
 * clear-session route handler, which deletes the cookie and then forwards
 * to `/login` (optionally with `from=` preserved so post-login returns
 * the user to where they were headed).
 *
 * @param from The original path the user was trying to reach. Optional —
 *   when omitted, post-login defaults to `/dashboard` (the existing
 *   `safeFromPath` fallback in `lib/auth/actions.ts`).
 */
export function buildStaleSessionRedirectUrl(from?: string): string {
  if (!from) return CLEAR_SESSION_PATH;
  return `${CLEAR_SESSION_PATH}?from=${encodeURIComponent(from)}`;
}
