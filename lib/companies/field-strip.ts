/**
 * Field-strip helper for company-row reads.
 *
 * Companies have two admin/staff-only fields that must never appear in
 * a payload handed to a `company`-role caller:
 *
 *   - `internalNotes`    — staff-side review notes.
 *   - `rejectionReason`  — the WHY behind a rejection (Day 22 column,
 *                          Day 23 strip). Same scoping rationale as
 *                          internalNotes: the company should never see
 *                          internal moderation context, only the fact
 *                          that they were rejected.
 *
 * `getCompany` and `listCompanies` both run their result rows through
 * this helper before returning. Admin / staff callers get the row
 * unchanged.
 *
 * Lives in its own (non-"use server") module so a unit test can import
 * it directly — actions.ts is "use server", which forbids non-async
 * exports. Splitting the helper out keeps the contract testable
 * without spinning up the full action stack.
 *
 * @module lib/companies/field-strip
 */
import type { Company, UserRole } from "@/lib/db/schema";

/**
 * Returns a shallow clone with admin-only fields nulled for company-role
 * callers; returns the row unchanged for admin / staff. Never mutates
 * the input.
 */
export function stripAdminOnlyFields(row: Company, role: UserRole): Company {
  if (role === "company") {
    return { ...row, internalNotes: null, rejectionReason: null };
  }
  return row;
}
