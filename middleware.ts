/**
 * Next.js middleware — runs on every request that matches the `matcher`.
 *
 * Next 16 introduced `proxy.ts` as the new file convention with a
 * function called `proxy()`, BUT `proxy.ts` runs exclusively on the
 * Node.js runtime — no opt-in, no override. OpenNext-on-Cloudflare
 * (the deploy adapter we use) compiles middleware into a separate
 * Cloudflare Worker that MUST run on the edge runtime. Those two
 * constraints are mutually exclusive.
 *
 * The escape (today): Next 16 still supports the legacy `middleware.ts`
 * / `middleware()` shape, and that shape accepts `runtime:
 * 'experimental-edge'` inside the `config` export below. So we're on
 * the deprecated-and-experimental path — Next emits TWO warnings on
 * every build ("middleware file convention is deprecated" + "edge
 * runtime for rendering is currently experimental"), but the build
 * succeeds and OpenNext accepts the resulting bundle.
 *
 * Strategic risk: this path is dead-end long-term. Next is actively
 * moving middleware to Node-only via `proxy.ts`, and OpenNext-on-
 * Cloudflare hasn't yet caught up to support Node middleware bundles.
 * If either side moves further before the other, this file breaks.
 *
 * The durable fix when that day comes: drop the framework-level
 * middleware entirely. Move auth gates into each protected route's
 * Server Component at the top of the file (~15 lines of code added
 * across the ~6 routes under /dashboard). Less elegant than a single
 * matcher but zero runtime-compat surface area.
 *
 * Why edge is safe for this file: the only runtime work we do is a
 * cookie read + a `jose` JWT verify + a `NextResponse.redirect()`.
 * All three are edge-compatible. `jose` is explicitly designed for
 * cross-runtime use; the Web Crypto APIs it depends on exist in both
 * Node and Workers.
 *
 * Responsibilities:
 *   - Protect `/dashboard/*` from unauthenticated users (→ /login)
 *   - Redirect already-logged-in users away from `/login` (→ /dashboard)
 *   - Pass through everything else untouched
 *
 * Keep this file LIGHTWEIGHT — no DB calls, no fat imports. Route
 * heavy work through Server Components and Server Actions instead.
 *
 * @module middleware
 */
import { NextResponse, type NextRequest } from "next/server";
// IMPORTANT: import from session-edge, NOT session — the latter pulls
// in `next/headers` + the DB module, both of which are not available
// in the Cloudflare edge runtime where this middleware runs.
import { verifySession, SESSION_COOKIE } from "@/lib/auth/session-edge";

// ── Config ──────────────────────────────────────────────────────────────────

/** Paths that require an authenticated session. Prefix match. */
const PROTECTED_PREFIXES = ["/dashboard"];

/** Paths that should bounce authenticated users away (no point being here). */
const AUTH_PAGES = ["/login"];

/** Where to send unauthenticated users hitting a protected route. */
const LOGIN_PATH = "/login";

/** Where to send authenticated users hitting an auth page. */
const DEFAULT_AUTHED_PATH = "/dashboard";

// ── Middleware ──────────────────────────────────────────────────────────────

export async function middleware(
  request: NextRequest,
): Promise<NextResponse> {
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
  // Edge runtimes; we're on edge here (per config below), but the call
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

// ── Matcher + runtime ──────────────────────────────────────────────────────

/**
 * Only run this middleware on paths that could possibly need auth logic.
 * Exclude Next internals, static assets, and common public files — there's
 * no reason to verify a JWT for /favicon.ico or /_next/static/*.css.
 *
 * `runtime: 'experimental-edge'` is the Next 16 way to opt into the
 * edge runtime. (Plain `'edge'` was renamed to `'experimental-edge'`
 * to signal that Next no longer treats edge middleware as the
 * preferred path — see module docstring for the strategic
 * implications.) Without it, Next 16 defaults middleware.ts to Node
 * and OpenNext refuses to build the worker.
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
  runtime: "experimental-edge",
};
