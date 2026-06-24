/**
 * Notification kinds for the in-app feed. Closed union — the `type` column
 * is plain text (enum-less SQLite) validated against this app-side. Adding a
 * kind is a deliberate change; pair each with the event that raises it.
 *
 * @module lib/notifications/types
 */

/**
 * - `company_verified` / `company_rejected` / `company_suspended` — a
 *   company's compliance status changed (→ that company's users).
 * - `application_shortlisted` / `application_rejected` / `application_awarded`
 *   — a tender application decision (→ the applicant company's users).
 * - `application_not_selected` — a tender was awarded to another bidder; the
 *   other live applicants (→ each non-winning applicant company's users).
 * - `document_expiring` — a document is approaching expiry (→ the company).
 * - `tender_published` — a new tender the recipient is eligible for.
 * - `company_registered` — a new company self-registered (→ admins).
 *
 * (No `user_invited` kind: an invited user can't sign in to see an in-app
 * notification until they've accepted the invite, at which point the message
 * is stale. The invite email carries that onboarding touch instead.)
 */
export type NotificationType =
  | "company_verified"
  | "company_rejected"
  | "company_suspended"
  | "application_shortlisted"
  | "application_rejected"
  | "application_awarded"
  | "application_not_selected"
  | "document_expiring"
  | "tender_published"
  | "company_registered";
