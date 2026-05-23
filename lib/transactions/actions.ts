/**
 * Transactions module — Server Actions.
 *
 * Every mutation (create / update / delete) and every read used by the
 * dashboard goes through one of these. They're the **only** place where
 * the database is touched directly for transaction rows — UI calls
 * these, never raw SQL.
 *
 * **Admin-only forever.** Staff and company-role users cannot read or
 * write transactions — enforced via `requireAdmin` at the action layer
 * and via the page-level auth gate in `app/dashboard/transactions/*`.
 * See `docs/08-rbac-matrix.md § Transactions`.
 *
 * Return shape (same as the rest of the codebase):
 *     { ok: true, ...data }
 *   | { ok: false, error: string, field?: string }
 *
 * Cross-FK invariant (enforced here, not at the DB):
 *
 *   - If `projectId` is set, the referenced project's `companyId` MUST
 *     equal this row's `companyId`. The DB can't express join-key
 *     equality as a constraint; we check it on every create/update.
 *
 * Audit logging: every mutation calls `recordAuditEvent` after the DB
 * write succeeds. Read actions are NOT audited. Audit `targetType` is
 * `"transaction"` — declared in `lib/audit/log.ts` since Day 6.
 *
 * @module lib/transactions/actions
 */
"use server";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  lte,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  companies,
  projects,
  transactions,
  type Transaction,
} from "@/lib/db/schema";
import { newId } from "@/lib/db/ids";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { recordAuditEvent } from "@/lib/audit/log";
import type { ActionResult } from "@/lib/types/action-result";
import {
  createTransactionSchema,
  updateTransactionSchema,
  listTransactionsQuerySchema,
  transactionIdSchema,
  type CreateTransactionInput,
  type UpdateTransactionInput,
  type ListTransactionsQuery,
} from "./schemas";

const log = logger.child({ module: "transactions-actions" });

// ── Authorization helpers ───────────────────────────────────────────────────

type Session = NonNullable<Awaited<ReturnType<typeof readSession>>>;

type AuthCheck =
  | { ok: true; session: Session }
  | { ok: false; error: string };

/**
 * Admin-only gate. The whole transactions module is admin-only — staff
 * and company-role users both refused. Same shape as the companies
 * module's `requireAdmin`, lifted here so the module stays a leaf.
 */
async function requireAdmin(): Promise<AuthCheck> {
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }
  if (session.role !== "admin") {
    log.warn("non-admin attempted transactions action", {
      userId: session.userId,
      role: session.role,
    });
    return { ok: false, error: "Only an administrator can do that" };
  }
  return { ok: true, session };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a partial snapshot of a transaction row, restricted to the
 * named keys. Same shape as the projects / companies modules.
 */
function buildPatchSnapshot(
  row: Transaction,
  keys: string[],
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    snapshot[key] = (row as unknown as Record<string, unknown>)[key];
  }
  return snapshot;
}

/**
 * SQLite reports unique-constraint failures on `transactions.reference_number`
 * as `UNIQUE constraint failed: transactions.reference_number`. Translate
 * to a form-friendly error so the UI can highlight the offending field.
 */
function translateUniqueConflict(
  err: unknown,
): { error: string; field: string } | null {
  if (!(err instanceof Error)) return null;
  if (err.message.includes("transactions.reference_number")) {
    return {
      error: "A transaction with this reference number already exists",
      field: "referenceNumber",
    };
  }
  return null;
}

// ── createTransaction ──────────────────────────────────────────────────────

/**
 * Create a new transaction. Admin only.
 *
 * Pipeline:
 *   1. AuthZ (admin)
 *   2. Schema validation (Zod)
 *   3. Soft existence check on companyId (friendlier than FK error)
 *   4. When projectId set: soft existence check + cross-FK invariant
 *   5. Insert
 *   6. Audit `created` event on `targetType: "transaction"`. The
 *      `metadata` captures companyId / projectId / type / amountPaise so
 *      forensic "what did we record about Acme last quarter" reads
 *      cheaply.
 */
export async function createTransaction(
  rawInput: unknown,
): Promise<ActionResult<{ id: string }>> {
  // 1. AuthZ
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = createTransactionSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input: CreateTransactionInput = parsed.data;

  // 3. Soft existence check on companyId.
  const companyRow = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!companyRow) {
    return {
      ok: false,
      field: "companyId",
      error: "Company not found",
    };
  }

  // 4. When projectId set: soft existence + cross-FK invariant.
  if (input.projectId) {
    const projectRow = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!projectRow) {
      return {
        ok: false,
        field: "projectId",
        error: "Project not found",
      };
    }

    if (projectRow.companyId !== input.companyId) {
      return {
        ok: false,
        field: "projectId",
        error: "Project does not belong to the selected company",
      };
    }
  }

  // 5. Insert
  const id = newId();
  try {
    await db.insert(transactions).values({
      id,
      type: input.type,
      amountPaise: input.amountPaise,
      currency: input.currency,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      occurredOn: input.occurredOn,
      referenceNumber: input.referenceNumber ?? null,
      notes: input.notes ?? null,
      internalNotes: input.internalNotes ?? null,
    });
  } catch (err) {
    const conflict = translateUniqueConflict(err);
    if (conflict) {
      log.info("createTransaction unique conflict", {
        field: conflict.field,
        actorId: auth.session.userId,
      });
      return { ok: false, ...conflict };
    }
    log.error("createTransaction failed", {
      err,
      actorId: auth.session.userId,
    });
    throw err;
  }

  // 6. Audit. Identity-ish fields land in `after`; the analytical fields
  //    (companyId / projectId / type / amountPaise) are duplicated into
  //    metadata so forensic queries don't have to JSON-walk the after
  //    snapshot.
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "created",
    targetType: "transaction",
    targetId: id,
    after: {
      type: input.type,
      amountPaise: input.amountPaise,
      currency: input.currency,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      occurredOn: input.occurredOn,
    },
    metadata: {
      companyId: input.companyId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      type: input.type,
      amountPaise: input.amountPaise,
    },
  });

  log.info("transaction created", {
    id,
    type: input.type,
    amountPaise: input.amountPaise,
    companyId: input.companyId,
    actorId: auth.session.userId,
  });
  return { ok: true, id };
}

// ── updateTransaction ──────────────────────────────────────────────────────

/**
 * Partial update. Admin only. Same field-by-field patch shape as
 * `updateCompany`.
 *
 * Excludes `companyId` — once recorded, the counterparty doesn't move.
 * Correcting a wrong counterparty means delete + recreate.
 *
 * When the patch changes `projectId`, the cross-FK invariant is
 * re-checked against the merged row state — the new project (if any)
 * must belong to the existing `companyId`.
 */
export async function updateTransaction(
  rawInput: unknown,
): Promise<ActionResult> {
  // 1. AuthZ
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  // 2. Validate
  const parsed = updateTransactionSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first?.path.join(".") || undefined,
    };
  }
  const input: UpdateTransactionInput = parsed.data;

  // 3. Load existing row.
  const existing = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, input.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!existing) {
    return { ok: false, error: "Transaction not found" };
  }

  // 4. Build the patch object.
  const patch: Partial<typeof transactions.$inferInsert> = {};
  if (input.type !== undefined) patch.type = input.type;
  if (input.amountPaise !== undefined) patch.amountPaise = input.amountPaise;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.projectId !== undefined) patch.projectId = input.projectId;
  if (input.occurredOn !== undefined) patch.occurredOn = input.occurredOn;
  if (input.referenceNumber !== undefined) {
    patch.referenceNumber = input.referenceNumber;
  }
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.internalNotes !== undefined) {
    patch.internalNotes = input.internalNotes;
  }

  // 5. Cross-FK invariant against the merged row state. If projectId is
  //    being changed (or unchanged but the existing value is non-null),
  //    the project's companyId must still equal the transaction's
  //    companyId. (companyId itself isn't patchable, so it always equals
  //    `existing.companyId`.)
  const mergedProjectId =
    patch.projectId !== undefined ? patch.projectId : existing.projectId;

  if (mergedProjectId) {
    const projectRow = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, mergedProjectId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!projectRow) {
      return {
        ok: false,
        field: "projectId",
        error: "Project not found",
      };
    }

    if (projectRow.companyId !== existing.companyId) {
      return {
        ok: false,
        field: "projectId",
        error: "Project does not belong to the transaction's company",
      };
    }
  }

  // 6. No-op short-circuit. Treat as idempotent success.
  if (Object.keys(patch).length === 0) {
    return { ok: true };
  }

  // 7. Apply
  try {
    await db
      .update(transactions)
      .set(patch)
      .where(eq(transactions.id, input.id));
  } catch (err) {
    const conflict = translateUniqueConflict(err);
    if (conflict) {
      log.info("updateTransaction unique conflict", {
        field: conflict.field,
        actorId: auth.session.userId,
      });
      return { ok: false, ...conflict };
    }
    log.error("updateTransaction failed", {
      err,
      actorId: auth.session.userId,
    });
    throw err;
  }

  // 8. Audit. Before/after of only the fields the patch touched. When
  //    `type` is changing, capture the from/to under `metadata.typeChange`
  //    — same shape as the `metadata.statusChange` convention on the
  //    tender/project transition actions. Forensic queries against
  //    "show me every type re-tagging" pivot off that field cheaply.
  const touchedKeys = Object.keys(patch);
  const beforeSnapshot = buildPatchSnapshot(existing, touchedKeys);
  const afterSnapshot = buildPatchSnapshot(
    { ...existing, ...patch } as Transaction,
    touchedKeys,
  );
  const typeChanged =
    patch.type !== undefined && patch.type !== existing.type;
  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "updated",
    targetType: "transaction",
    targetId: input.id,
    before: beforeSnapshot,
    after: afterSnapshot,
    ...(typeChanged
      ? {
          metadata: {
            typeChange: { from: existing.type, to: patch.type },
          },
        }
      : {}),
  });

  log.info("transaction updated", {
    id: input.id,
    actorId: auth.session.userId,
    fields: touchedKeys,
  });
  return { ok: true };
}

// ── deleteTransaction ──────────────────────────────────────────────────────

/**
 * Delete a transaction. Admin only.
 *
 * Ledger corrections happen — recorded the wrong figure, double-entry,
 * etc. The full pre-deletion row is captured in the audit row's `before`
 * payload, which is the only record once the row is gone.
 *
 * Uses `.returning()` to fetch the deleted row back in one round trip,
 * same pattern as `deleteCompany`.
 */
export async function deleteTransaction(
  rawId: unknown,
  options: { reason?: string } = {},
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = transactionIdSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid transaction id" };
  }

  const result = await db
    .delete(transactions)
    .where(eq(transactions.id, parsed.data.id))
    .returning();

  if (result.length === 0) {
    return { ok: false, error: "Transaction not found" };
  }

  const deletedRow = result[0];

  await recordAuditEvent({
    actorId: auth.session.userId,
    actorRole: auth.session.role,
    action: "deleted",
    targetType: "transaction",
    targetId: parsed.data.id,
    before: {
      type: deletedRow.type,
      amountPaise: deletedRow.amountPaise,
      currency: deletedRow.currency,
      companyId: deletedRow.companyId,
      projectId: deletedRow.projectId,
      occurredOn: deletedRow.occurredOn,
      referenceNumber: deletedRow.referenceNumber,
      notes: deletedRow.notes,
      internalNotes: deletedRow.internalNotes,
      createdAt: deletedRow.createdAt,
    },
    metadata: {
      companyId: deletedRow.companyId,
      ...(deletedRow.projectId ? { projectId: deletedRow.projectId } : {}),
      type: deletedRow.type,
      amountPaise: deletedRow.amountPaise,
      ...(options.reason ? { reason: options.reason } : {}),
    },
  });

  log.info("transaction deleted", {
    id: parsed.data.id,
    actorId: auth.session.userId,
    ...(options.reason ? { reason: options.reason } : {}),
  });
  return { ok: true };
}

// ── getTransaction ─────────────────────────────────────────────────────────

/**
 * Single-row fetch for the detail page. Admin only.
 */
export async function getTransaction(
  rawId: unknown,
): Promise<ActionResult<{ transaction: Transaction }>> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = transactionIdSchema.safeParse({ id: rawId });
  if (!parsed.success) {
    return { ok: false, error: "Invalid transaction id" };
  }

  const row = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, parsed.data.id))
    .limit(1)
    .then((rows) => rows[0]);

  if (!row) return { ok: false, error: "Transaction not found" };

  return { ok: true, transaction: row };
}

// ── listTransactions ───────────────────────────────────────────────────────

type ListTransactionsPayload = {
  rows: Transaction[];
  total: number;
  page: number;
  perPage: number;
};

/**
 * Paginated, filtered, sorted list. Admin only.
 *
 * Filters compose with AND. Date-range filter on `occurredOn` is
 * inclusive on both ends (the column is NOT NULL, so NULL-handling is
 * academic). No free-text search exposed — transactions don't have a
 * column worth LIKE-ing.
 *
 * Default sort is `occurredOn DESC` — newest business date first.
 */
export async function listTransactions(
  rawQuery: unknown,
): Promise<ActionResult<ListTransactionsPayload>> {
  const auth = await requireAdmin();
  if (!auth.ok) return auth;

  const parsed = listTransactionsQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid query",
      field: first?.path.join(".") || undefined,
    };
  }
  const query: ListTransactionsQuery = parsed.data;

  const filters: SQL[] = [];

  if (query.type) filters.push(eq(transactions.type, query.type));
  if (query.companyId) {
    filters.push(eq(transactions.companyId, query.companyId));
  }
  if (query.projectId) {
    filters.push(eq(transactions.projectId, query.projectId));
  }
  if (query.occurredOnFrom) {
    filters.push(gte(transactions.occurredOn, query.occurredOnFrom));
  }
  if (query.occurredOnTo) {
    filters.push(lte(transactions.occurredOn, query.occurredOnTo));
  }

  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  const sortColumn = {
    occurredOn: transactions.occurredOn,
    amountPaise: transactions.amountPaise,
    createdAt: transactions.createdAt,
    updatedAt: transactions.updatedAt,
  }[query.sortBy];
  const orderBy = query.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const offset = (query.page - 1) * query.perPage;

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(transactions)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(query.perPage)
      .offset(offset),
    db
      .select({ value: count() })
      .from(transactions)
      .where(whereClause)
      .then((r) => r[0]),
  ]);

  return {
    ok: true,
    rows,
    total: totalRow?.value ?? 0,
    page: query.page,
    perPage: query.perPage,
  };
}
