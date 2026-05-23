/**
 * Documents-module authorisation predicates.
 *
 * Pure functions - no I/O, no DB, no session reads. They take a session
 * object (which the caller has already resolved via `readSession`) plus
 * a row identity, and return a boolean.
 *
 * Why this lives in its own file:
 *   - Next.js requires every export from a "use server" file to be an
 *     async function. These helpers are synchronous, so they can't sit
 *     in lib/documents/actions.ts.
 *   - Same predicate is used by initiateDocumentUpload + confirmDocument-
 *     Upload (Day 9) and by the eventual list / detail / download /
 *     verify / reject actions (Day 10). One source of truth is better
 *     than five copies.
 *
 * @module lib/documents/auth
 */
import type { readSession } from "@/lib/auth/session";

/**
 * Session shape, unwrapped from `readSession()`'s nullable return.
 * Imported as a type only - this file has no runtime dependency on
 * the session reader.
 */
type Session = NonNullable<Awaited<ReturnType<typeof readSession>>>;

/**
 * Returns true if the given session may VIEW or INITIATE-UPLOAD-FOR a
 * document owned by `documentCompanyId`.
 *
 *   - admin / staff -> always
 *   - company role  -> only when the company matches their own
 *   - anyone else (signed-out, unknown role) -> no
 *
 * This is the predicate behind the "Document not found" responses that
 * cross-company callers receive in the action layer - we return false
 * here, the action turns false into "not found" to avoid leaking the
 * existence of other companies' documents.
 *
 * Note: this is the broadest read/upload predicate. Stricter actions
 * (verify, reject, delete) have their own predicates as they ship.
 */
export function sessionCanAccessDocumentForCompany(
  session: Session | null,
  documentCompanyId: string,
): boolean {
  if (!session) return false;
  if (session.role === "admin" || session.role === "staff") return true;
  if (session.role === "company") {
    return Boolean(
      session.companyId && session.companyId === documentCompanyId,
    );
  }
  return false;
}
