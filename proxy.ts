/**
 * Next.js proxy — runs on every request that matches the `matcher`.
 *
 * Previously named `middleware.ts` in Next.js 15 and earlier. As of
 * Next.js 16 the file convention is `proxy.ts` with an exported `proxy()`
 * function. The rename clarifies that this file sits at the network
 * boundary (not as request-pipeline middleware in the Express sense),
 * and the framework now runs it on the Node.js runtime instead of Edge.
 *
 * Migration notes (in case we ever roll back or want Edge again):
 *   - Function: was `export async function middleware(req)`, now `proxy(req)`
 *   - Runtime: was Edge, now Node.js (not configurable on proxy.ts)
 *   - Behaviour: identical — same redirects, same matcher, same JWT check
 *
 * Responsibilities:
 *   - Protect `/dashboard/*` from unauthenticated users (→ /login)
 *   - Redirect already-logged-in users away from `/login` (→ /dashboard)
 *   - Pass through everything else untouched
 *
 * The Next.js team advises keeping proxy.ts lightweight — the "thin
 * proxy" pattern. Avoid heavy DB lookups here; route them through
 * Server Components and Server Actions instead. Our current usage
 * (cookie read + JWT verify + redirect) already fits the lightweight
 * profile, so no refactor needed.
 *
 * @module proxy
 */
import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/session";

// ── Config ──────────────────────────────────────────────────────────────────

/** Paths that require an authenticated session. Prefix match. */
const PROTECTED_PREFIXES = ["/dashboard"];

/** Paths that should bounce authenticated users away (no point being here). */
const AUTH_PAGES = ["/login"];

/** Where to send unauthenticated users hitting a protected route. */
const LOGIN_PATH = "/login";

/** Where to send authenticated users hitting an auth page. */
const DEFAULT_AUTHED_PATH = "/dashboard";

// ── Proxy ───────────────────────────────────────────────────────────────────

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  const isAuthPage = AUTH_PAGES.includes(pathname);

  // Fast path: nothing to do for public routes.
  if (!isProtected && !isAuthPage) {
    return NextResponse.next();
  }

  // Verify session from the cookie. jose.verify works in both Node and
  // Edge runtimes; we're on Node now (proxy.ts default) but the call
  // itself is runtime-agnostic.
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);

  // Case 1: hitting a protected route without a valid session → /login
  if (isProtected && !session) {
    const url = request.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    // Preserve where they were headed so we can redirect back after login.
    url.searchParams.set("from", pathname + search);
    return NextResponse.redirect(url);
  }

  // Case 2: hitting an auth page while already logged in → /dashboard
  if (isAuthPage && session) {
    const url = request.nextUrl.clone();
    url.pathname = DEFAULT_AUTHED_PATH;
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Happy path: authenticated visitor on protected route, or
  // unauthenticated visitor on login page. Let it through.
  return NextResponse.next();
}

// ── Matcher ─────────────────────────────────────────────────────────────────

/**
 * Only run this proxy on paths that could possibly need auth logic.
 * Exclude Next internals, static assets, and common public files — there's
 * no reason to verify a JWT for /favicon.ico or /_next/static/*.css.
 *
 * The matcher syntax is identical between middleware.ts and proxy.ts —
 * no migration needed here.
 */
export const config = {
  matcher: [
    /*
     * Match all paths EXCEPT:
     *   - _next/static (static files)
     *   - _next/image  (image optimizer)
     *   - favicon.ico, robots.txt, sitemap.xml
     *   - Anything that has a file extension (.jpg, .svg, .js, .css, ...)
     *     because those are static assets, not app routes
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
