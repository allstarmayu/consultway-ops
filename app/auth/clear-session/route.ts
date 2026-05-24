/**
 * /auth/clear-session — Route Handler that destroys the session cookie
 * and redirects to `/login` (or another safe path).
 *
 * Exists because Server Components can't write cookies — they can only
 * read. So a Server Component that needs to "log this user out and send
 * them to /login" can't do it directly; it redirects HERE, and this
 * handler does the cookie write + the onward redirect.
 *
 * The motivating defect (Day 26): when a session JWT outlives the user
 * row it points at (local DB reset, prod row deletion), `getPreferences`
 * returns a friendly `{ ok: false }`, the settings page calls
 * `redirect("/login")` — and `proxy.ts` bounces the still-valid-looking
 * cookie back to `/dashboard`. The user ends up on the dashboard with
 * no idea why their click on Settings did nothing.
 *
 * Redirecting through this handler breaks the loop: `destroySession()`
 * sends a Set-Cookie header that deletes the cookie, then we issue the
 * `/login` redirect. The follow-up request has no cookie, so `proxy.ts`
 * sees an unauthenticated user heading to `/login` and lets them through.
 *
 * `from=` query is preserved so post-login can return the user to the
 * page they were trying to reach (validated by `safeFromPath` in
 * `lib/auth/actions.ts` once it lands on the login form).
 *
 * Proxy carveout: this route's path doesn't match any prefix in
 * `proxy.ts` (`/dashboard/*` for protected, `/login` for auth pages), so
 * the proxy passes it through unmolested.
 *
 * @module app/auth/clear-session/route
 */
import { NextResponse, type NextRequest } from "next/server";
import { destroySession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "clear-session-route" });

/**
 * `from=` validator — same shape as `safeFromPath` in `lib/auth/actions.ts`
 * but inlined here to keep the route handler a leaf without a circular
 * import on the auth-actions module.
 *
 * A `from` that fails any check is dropped silently — the user still
 * gets logged out + redirected to /login, just without the post-login
 * destination preservation.
 */
const MAX_FROM_LENGTH = 512;

function safeFrom(raw: string | null): string | undefined {
  if (!raw) return undefined;
  if (raw.length > MAX_FROM_LENGTH) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//")) return undefined;
  if (raw.includes("\\")) return undefined;
  if (raw.startsWith("/api/")) return undefined;
  return raw;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  await destroySession();

  const from = safeFrom(request.nextUrl.searchParams.get("from"));

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (from) url.searchParams.set("from", from);

  log.info("session cleared via /auth/clear-session", { from });
  return NextResponse.redirect(url);
}
