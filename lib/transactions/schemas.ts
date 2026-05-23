/**
 * Zod schemas for the transactions module.
 *
 * Same conventions as `lib/projects/schemas.ts` — schemas live in a
 * non-"use server" file so both client and server code can import and
 * validate against them. Server Actions in `./actions.ts` re-validate
 * every input — never trust client validation alone.
 *
 * Schemas exported here:
 *   - transactionTypeSchema         — enum mirror of `TransactionType`
 *   - createTransactionSchema       — admin-only create flow
 *   - updateTransactionSchema       — patch shape (excludes `companyId`)
 *   - listTransactionsQuerySchema   — filters + pagination + sort
 *   - transactionIdSchema           — single-id route param validation
 *
 * **Currency gate.** The schema's `currency` field is optional and
 * defaults to `'INR'`; it's refined to literal `'INR'` only in this
 * session. The DB column exists for forward-compat with Phase-3 multi-
 * currency, but anything other than INR is a Zod refusal today.
 *
 * @module lib/transactions/schemas
 */
import { z } from "zod";

// ── Reusable primitive schemas ────────────────────────────────────────────

/** UUID v7 / v4 share the same 8-4-4-4-12 hex shape. */
const uuidSchema = z.string().uuid("Invalid identifier");

/**
 * ISO-8601 date string (YYYY-MM-DD). Same shape as
 * `projects.schemas.ts::isoDateSchema` — duplicated rather than shared
 * to keep the module a leaf with no sideways import.
 */
const isoDateSchema = z
  .string()
  .regex(
    /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/,
    "Enter a valid date (YYYY-MM-DD)",
  );

/**
 * Amount in paise — positive integer only. Refunds and expenses are
 * encoded by `type`, NOT by a negative sign, so a zero or negative
 * amount is always nonsense at the action layer.
 *
 * Max ceiling well below SQLite's INTEGER max — we just don't expect
 * realistic single transactions to land above ~10 trillion paise
 * (~₹10,000 crore in one row).
 */
const amountPaiseSchema = z.coerce
  .number({ error: "Amount is required" })
  .int("Amount must be a whole number of paise")
  .positive("Amount must be greater than zero")
  .max(
    10_000_000_000_000,
    "Amount is unrealistically large",
  );

// ── Type enum (mirrors lib/db/schema.ts TransactionType) ──────────────────

/**
 * Mirrors the `TransactionType` union from the DB schema. Kept in sync
 * manually — if a new value is added to the type in `lib/db/schema.ts`,
 * add it here too. Same pattern as `projectStatusSchema`.
 */
export const transactionTypeSchema = z.enum([
  "invoice",
  "payment",
  "expense",
  "advance",
  "refund",
]);

export type TransactionTypeInput = z.infer<typeof transactionTypeSchema>;

/**
 * Currency. Today the only accepted value is `'INR'`. The column on
 * the table is a free TEXT for forward-compat with multi-currency in
 * Phase 3, but the action layer Zod-refines to literal `'INR'`.
 */
const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((v) => v === "INR", {
    message: "Only INR is supported in Phase 2",
  });

// ── Create transaction ────────────────────────────────────────────────────

/**
 * Input schema for `createTransaction`. Admin only.
 *
 * Design notes:
 *   - `companyId` is required. The action also validates that the id
 *     points to a real company row.
 *   - `projectId` is optional. When set, the action enforces the
 *     cross-FK invariant (project's `companyId` must equal `companyId`).
 *   - `amountPaise` is paise (NOT rupees) — see the column docstring in
 *     `lib/db/schema.ts`. Positive integer only.
 *   - `currency` defaults to `'INR'` and is refined to that literal.
 *   - `occurredOn` is the business date (NOT `createdAt`).
 *   - `referenceNumber` is optional + unique-when-present (NULL-distinct).
 */
export const createTransactionSchema = z.object({
  type: transactionTypeSchema,

  amountPaise: amountPaiseSchema,

  currency: currencySchema.optional().default("INR"),

  companyId: uuidSchema,
  projectId: uuidSchema.optional().nullable(),

  occurredOn: isoDateSchema,

  referenceNumber: z
    .string()
    .trim()
    .min(1, "Reference number cannot be empty if provided")
    .max(120, "Reference number is too long")
    .optional()
    .nullable(),

  notes: z
    .string()
    .trim()
    .min(1, "Notes cannot be empty if provided")
    .max(5000, "Notes are too long")
    .optional()
    .nullable(),

  /** Admin-only field. Kept for symmetry with the rest of the codebase. */
  internalNotes: z.string().trim().max(5000).optional().nullable(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

// ── Update transaction ────────────────────────────────────────────────────

/**
 * Input schema for `updateTransaction`. Admin only.
 *
 * Excludes `companyId` — once recorded, the counterparty doesn't move.
 * Correcting a wrong counterparty means delete + recreate; the audit log
 * can reconstruct the history from the deletion snapshot + the new
 * `created` event.
 *
 * `projectId` IS patchable. When changed to a non-null value, the
 * action re-checks the cross-FK invariant against the merged row state
 * (new projectId's company must still match this transaction's
 * companyId).
 *
 * `type` IS patchable — typos at recording time happen.
 */
export const updateTransactionSchema = z.object({
  id: uuidSchema,

  type: transactionTypeSchema.optional(),

  amountPaise: amountPaiseSchema.optional(),

  currency: currencySchema.optional(),

  projectId: uuidSchema.optional().nullable(),

  occurredOn: isoDateSchema.optional(),

  referenceNumber: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .nullable(),

  notes: z.string().trim().min(1).max(5000).optional().nullable(),

  internalNotes: z.string().trim().max(5000).optional().nullable(),
});

export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;

// ── List query ────────────────────────────────────────────────────────────

/**
 * Sort columns exposed to the UI. Restricted set — `occurredOn` is the
 * default (most-recent first) since that's what an admin scanning the
 * ledger wants by default.
 */
export const transactionSortColumnSchema = z.enum([
  "occurredOn",
  "amountPaise",
  "createdAt",
  "updatedAt",
]);

/**
 * Query schema for `listTransactions`.
 *
 * Coerces strings to numbers for page/perPage because URL search params
 * arrive as strings. Caps `perPage` at 100 to bound query cost.
 *
 * Date-range filter is inclusive on both ends — `occurredOnFrom <= row
 * <= occurredOnTo`. The column is NOT NULL so the inclusive semantics
 * never have to consider NULL rows.
 *
 * No free-text search exposed — transactions don't have a column worth
 * LIKE-ing in Phase 1 / 2.
 */
export const listTransactionsQuerySchema = z.object({
  // Filters — all optional, AND-composed in the query.
  type: transactionTypeSchema.optional(),
  companyId: uuidSchema.optional(),
  projectId: uuidSchema.optional(),
  occurredOnFrom: isoDateSchema.optional(),
  occurredOnTo: isoDateSchema.optional(),

  // Pagination.
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),

  // Sorting. Default is most-recent business date first.
  sortBy: transactionSortColumnSchema.default("occurredOn"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

// ── ID param ──────────────────────────────────────────────────────────────

/**
 * Single-id schema for routes like `/dashboard/transactions/[id]`.
 */
export const transactionIdSchema = z.object({ id: uuidSchema });
