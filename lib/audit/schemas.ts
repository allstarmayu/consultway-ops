/**
 * Audit module - Zod schemas.
 *
 * Co-located with the action layer in `./log.ts` rather than living
 * next to the table definition, matching the convention established by
 * `lib/companies/schemas.ts` and `lib/tenders/schemas.ts`. The action
 * code imports from here at runtime; client code that needs the input
 * shape (none today) would also import from here.
 *
 * Why schemas live in their own file: action files have the
 * `"use server"` pragma, and Next.js turns every export from a
 * "use server" file into a remote-call stub. Non-action values
 * (Zod schemas, types) exported from a "use server" file would
 * silently break at runtime when imported from a Client Component.
 * Keeping schemas in a sibling file avoids this trap entirely.
 *
 * @module lib/audit/schemas
 */
import { z } from "zod";

// -- Shared building blocks -------------------------------------------------

/**
 * UUID validator. Same shape as the companies / tenders modules; we
 * re-declare per-module instead of sharing one source so each module
 * can tune the error message later without coupling.
 */
const uuidSchema = z.string().uuid("Invalid identifier");

/**
 * Closed enum of audit target types. Mirrors the `AuditTargetType`
 * union in `./log.ts`. We re-declare here as a Zod enum (not a
 * generic string) so client-side query construction (e.g. a future
 * "filter the activity feed by entity type" dropdown) gets typed
 * autocomplete and runtime validation in one place.
 *
 * Keep these two in lockstep: adding a target type means editing both
 * `AuditTargetType` in `./log.ts` AND this enum. There is no clever
 * way around the duplication - Zod enums can't be derived from
 * TypeScript unions, and we don't want to invert the relationship
 * (deriving the union from the enum would force every action call
 * site to import a Zod object just to get a type).
 */
export const auditTargetTypeSchema = z.enum([
  "company",
  "user",
  "tender",
  "tender_application",
  "project",
  "transaction",
  "document",
]);

/**
 * Closed enum of audit actions. Same lockstep contract as
 * `auditTargetTypeSchema` - mirrors `AuditAction` in `./log.ts`.
 *
 * Useful for filtering the activity feed by verb (e.g. "show me all
 * reversals last week"). Day 7's dashboard widget will lean on this.
 */
export const auditActionSchema = z.enum([
  "created",
  "updated",
  "deleted",
  "compliance_status_changed",
  "document_uploaded",
  "document_expired",
  "tender_published",
  "tender_applied",
  "tender_reopened",
  "tender_award_retracted",
  "application_reinstated",
  "application_recalled",
]);

// -- listAuditEvents query --------------------------------------------------

/**
 * Query schema for `listAuditEvents`.
 *
 * All filters are optional and compose with AND. The defaults skew
 * toward "give me the recent activity feed":
 *   - `limit` defaults to 50 (one screen of events on the future widget)
 *   - capped at 200 to keep query cost bounded
 *   - `offset` defaults to 0
 *
 * Coerces numeric inputs because URL search params arrive as strings -
 * lets this schema double as a `searchParams` parser if we ever expose
 * the audit log via a route handler.
 *
 * No sort options. Audit events are always returned newest-first
 * (`created_at DESC`) - audit feeds without that default are useless,
 * and exposing the sort would let a caller order by `actor_id` which
 * isn't a query pattern we want to encourage.
 */
export const listAuditEventsQuerySchema = z.object({
  /** Filter to events on one entity type (e.g. just `tender_application`). */
  targetType: auditTargetTypeSchema.optional(),

  /**
   * Filter to events on a specific entity. When combined with
   * `targetType` this hits the `audit_log_target_idx` composite cleanly.
   * Without `targetType` it still works via the same index (target_type
   * is the lead column, so SQLite can use the index for target_id alone
   * if we add an explicit equality - but in practice we always pair
   * the two on the read side).
   */
  targetId: uuidSchema.optional(),

  /**
   * Filter to events performed by one user. Hits the
   * `audit_log_actor_id_idx`. Useful for admin investigation queries.
   */
  actorId: uuidSchema.optional(),

  /** Filter by audit verb (e.g. "all `tender_award_retracted` events"). */
  action: auditActionSchema.optional(),

  // Pagination.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;
