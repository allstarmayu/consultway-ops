/**
 * Shared discriminated-union return type for Server Actions.
 *
 * Every domain module's mutation/read actions (companies, tenders,
 * documents) returns one of these so the calling UI can branch on
 * `result.ok` consistently and never has to defensively check for
 * `error` on a successful result.
 *
 * The shape:
 *   - Success:  `{ ok: true, ...data }`
 *   - Failure:  `{ ok: false, error: string, field?: string }`
 *
 * The `field` hint lets a form highlight a specific input on validation
 * failures (e.g. focus the GST field on a unique-conflict refusal,
 * rather than showing a generic banner). It's optional — actions
 * without form context can omit it.
 *
 * ## Why this lives at `lib/types`
 *
 * The four domain modules each declared a structurally identical copy
 * of this type prior to Day 11. Centralising it here removes the
 * duplication while keeping the dependency direction sane — `lib/types`
 * is a leaf module that the domain modules import from, never the
 * reverse.
 *
 * ## Deliberate non-consumers
 *
 * - `lib/auth/actions.ts` declares its own narrower `ActionResult` with
 *   `field?: "email" | "password" | "form"` (a constrained union, not
 *   a free string). The auth form is the only surface where a tighter
 *   `field` type pays for itself, so it stays local rather than being
 *   shoehorned into the generic shape.
 * - `lib/audit/log.ts::AuditReadResult` mirrors the success/failure
 *   shape but intentionally stays local — keeping the audit module a
 *   leaf with zero upward dependency on domain modules. See the
 *   docstring there for the rationale.
 *
 * @module lib/types/action-result
 */

/**
 * Discriminated-union result returned by Server Actions.
 *
 * @template T Extra fields included on success. Use `unknown` (the
 *   default) for actions that succeed with no payload — the `{ ok: true }`
 *   branch then has only the discriminant.
 *
 * @example
 *   // Success-with-payload action
 *   async function createCompany(): Promise<ActionResult<{ id: string }>> {
 *     // ...
 *     return { ok: true, id: "abc-123" };
 *   }
 *
 * @example
 *   // Success-only (no payload) action
 *   async function publishTender(): Promise<ActionResult> {
 *     // ...
 *     return { ok: true };
 *   }
 */
export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string; field?: string };
