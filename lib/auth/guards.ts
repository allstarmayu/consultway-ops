/**
 * Shared role-gate helpers for Server Actions.
 *
 * The companies module (Day 2) grew a pair of private `requireAdmin` /
 * `requireAdminOrStaff` helpers inline. The users module (Day 33) needs
 * the same gates, so they live here as the canonical, reusable home —
 * any "use server" action can short-circuit on failure with one line:
 *
 *   const auth = await requireAdmin();
 *   if (!auth.ok) return auth;            // ActionResult-compatible
 *   // ...auth.session is now the unwrapped, non-null session
 *
 * The `{ ok: false, error }` shape is intentionally a structural subset
 * of `ActionResult` (`lib/types/action-result.ts`), so an action can
 * `return auth` directly without re-wrapping.
 *
 * NOTE: `lib/companies/actions.ts` still carries its own byte-identical
 * private copies (predates this module). Deduping it to import from here
 * is a safe mechanical follow-up — left out of the Day-33 diff to keep
 * the user-management change focused.
 *
 * @module lib/auth/guards
 */
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "auth-guards" });

/**
 * The session shape, unwrapped from `readSession()`'s nullable return.
 * Re-exported so callers can type a resolved session without re-deriving.
 */
export type Session = NonNullable<Awaited<ReturnType<typeof readSession>>>;

/**
 * Result type for the role-gate helpers. The two-shape return lets a
 * caller short-circuit on failure with a single `if (!r.ok) return r`.
 * The failure arm is `ActionResult`-compatible.
 */
export type AuthCheck =
  | { ok: true; session: Session }
  | { ok: false; error: string };

/**
 * Resolve the current session and confirm the caller is admin or staff.
 * Returns the session on success, or an `ok: false` result the action
 * returns immediately.
 */
export async function requireAdminOrStaff(): Promise<AuthCheck> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }
  if (session.role !== "admin" && session.role !== "staff") {
    log.warn("forbidden access attempt", {
      userId: session.userId,
      role: session.role,
    });
    return { ok: false, error: "You don't have permission to do that" };
  }
  return { ok: true, session };
}

/**
 * Admin-only gate. The whole user-management module gates on this — the
 * route lives under `/dashboard/admin/*` and every mutation (create,
 * update, deactivate, reset password) is admin-only per the RBAC matrix.
 */
export async function requireAdmin(): Promise<AuthCheck> {
  const session = await readSession();
  if (!session) return { ok: false, error: "You must be signed in" };
  if (session.role !== "admin") {
    log.warn("non-admin attempted admin-only action", {
      userId: session.userId,
      role: session.role,
    });
    return { ok: false, error: "Only an administrator can do that" };
  }
  return { ok: true, session };
}
