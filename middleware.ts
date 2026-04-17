/**
 * Next.js middleware — runs on every request that matches the `matcher`.
 *
 * Responsibilities:
 *   - Protect `/dashboard/*` from unauthenticated users (→ /login)
 *   - Redirect already-logged-in users away from `/login` (→ /dashboard)
 *   - Pass through everything else untouched
 *
 * Runs in the Edge runtime, so:
 *   - No Node APIs (no `fs`, no DB)
 *   - No `next/headers` — read cookies from `request.cookies` directly
 *   - Use `jose` (which works in both Node and Edge)
 *
 * Authorization checks beyond "is there a valid session" (e.g., role checks
 * on /admin/*) can be added here by inspecting the verified payload.
 *
 * @module middleware
 */
import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/session";

// ── Config ──────────────────────────────────────────────────────────
/** Paths that require an authenticated session. Prefix match. */
const PROTECTED_PREFIXES = ["/dashboard"];

/** Paths that should bounce authenticated users away (no point being here). */
const AUTH_PAGES = ["/login"];

/** Where to send unauthenticated users hitting a protected route. */
const LOGIN_PATH = "/login";

/** Where to send authenticated users hitting an auth page. */
const DEFAULT_AUTHED_PATH = "/dashboard";

// ── Middleware ──────────────────────────────────────────────────────
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  const isAuthPage = AUTH_PAGES.includes(pathname);

  // Fast path: nothing to do for public routes.
  if (!isProtected && !isAuthPage) {
    return NextResponse.next();
  }

  // Verify session from the cookie. jose.verify works in Edge runtime.
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

// ── Matcher ─────────────────────────────────────────────────────────
/**
 * Only run this middleware on paths that could possibly need auth logic.
 * Exclude Next internals, static assets, and common public files — there's
 * no reason to verify a JWT for /favicon.ico or /_next/static/*.css.
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
