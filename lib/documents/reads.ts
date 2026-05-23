/**
 * Documents module - Read-surface Server Actions.
 *
 * Day 10 Chunk 1 ships three read-side actions, split off from
 * `./actions.ts` so the write-side file (initiate / confirm + upcoming
 * verify / reject / delete in Chunk 2) doesn't get unwieldy.
 *
 *   - listDocumentsForCompany       - role-scoped list with filters + sort
 *   - getDocumentDetail             - single row + joined uploader + reviewer
 *                                     names, with company-role redaction
 *   - generateDocumentDownloadUrl   - presigned GET URL via R2 client
 *
 * Return shape matches the companies/tenders convention:
 *     { ok: true, ...data }
 *   | { ok: false, error: string, field?: string }
 *
 * Role rules (mirror docs/08-rbac-matrix.md "Documents"):
 *
 *   Action                          admin   staff   company
 *   listDocumentsForCompany         any     any     own company only
 *   getDocumentDetail               any     any     own doc only
 *   generateDocumentDownloadUrl     any     any     own doc only
 *
 * All three route through `sessionCanAccessDocumentForCompany` from
 * `./auth.ts` - the pure predicate parked there in Day 9. Cross-company
 * attempts by company-role users surface as "Document not found" /
 * "Company not found" rather than "forbidden", matching the
 * companies/tenders pattern for ID enumeration resistance.
 *
 * Reads are NOT audited at Phase 1 - would be too noisy. If a future
 * compliance need surfaces around "who downloaded what when," reconsider
 * `generateDocumentDownloadUrl` specifically.
 *
 * @module lib/documents/reads
 */
"use server";

import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { documents, users, type Document } from "@/lib/db/schema";
import { readSession } from "@/lib/auth/session";
import { logger } from "@/lib/logger";
import { getPresignedGetUrl } from "@/lib/r2/client";
import { sessionCanAccessDocumentForCompany } from "./auth";
import type { ActionResult } from "@/lib/types/action-result";
import {
  listDocumentsForCompanyQuerySchema,
  documentByIdInputSchema,
  type ListDocumentsForCompanyQuery,
} from "./schemas";

const log = logger.child({ module: "documents-reads" });

// ── listDocumentsForCompany ─────────────────────────────────────────────────

/**
 * Result payload type for `listDocumentsForCompany`. Mirrors the
 * `ListCompaniesPayload` shape minus pagination (deliberately deferred -
 * Phase 1 companies have <20 docs each, see schema comment).
 */
type ListDocumentsForCompanyPayload = {
  rows: Document[];
  total: number;
};

/**
 * Build the Drizzle order-by expression from the validated sort inputs.
 * Lookup table over a switch so a malformed sortBy can't reach here
 * (Zod's enum already gates it).
 */
function buildOrderBy(query: ListDocumentsForCompanyQuery): SQL {
  const column = {
    uploadedAt: documents.uploadedAt,
    expiresAt: documents.expiresAt,
    documentType: documents.documentType,
    status: documents.status,
  }[query.sortBy];

  return query.sortDir === "asc" ? asc(column) : desc(column);
}

/**
 * List documents owned by a single company, role-scoped and filtered.
 *
 * Pipeline:
 *   1. Validate the query payload via Zod
 *   2. Resolve session (auth required)
 *   3. RBAC gate via `sessionCanAccessDocumentForCompany` against the
 *      requested companyId. Failures map to "Company not found" so a
 *      cross-company probe can't tell whether the company exists.
 *   4. Build the WHERE clause: always `companyId = ?`, plus optional
 *      status and documentType filters (AND-composed).
 *   5. Sort + fetch. No LIMIT / OFFSET at Phase 1 scale.
 *   6. Return the rows + total (which equals rows.length without
 *      pagination, but we surface it so the UI can render "N documents"
 *      without re-counting).
 *
 * Failure modes:
 *   - Invalid input          -> ok:false with the first Zod issue
 *   - Not signed in          -> ok:false "must be signed in"
 *   - Cross-company access   -> ok:false "Company not found"
 */
export async function listDocumentsForCompany(
  rawQuery: unknown,
): Promise<ActionResult<ListDocumentsForCompanyPayload>> {
  // 1. Validate
  const parsed = listDocumentsForCompanyQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid query",
      field: first?.path.join(".") || undefined,
    };
  }
  const query = parsed.data;

  // 2. Session
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  // 3. AuthZ. The predicate already covers all three roles:
  //    admin/staff -> true unconditionally; company-role -> true only if
  //    own company. Cross-company company-role surfaces as "not found"
  //    rather than "forbidden" - same anti-enumeration shape as
  //    initiateDocumentUpload / confirmDocumentUpload in ./actions.ts.
  if (!sessionCanAccessDocumentForCompany(session, query.companyId)) {
    log.warn("documents list refused: cross-company access", {
      userId: session.userId,
      sessionCompanyId: session.companyId,
      requestedCompanyId: query.companyId,
    });
    return { ok: false, error: "Company not found" };
  }

  // 4. WHERE clause. companyId is always present; the other filters are
  //    optional and only join the array when supplied.
  const filters: SQL[] = [eq(documents.companyId, query.companyId)];
  if (query.status) {
    filters.push(eq(documents.status, query.status));
  }
  if (query.documentType) {
    filters.push(eq(documents.documentType, query.documentType));
  }
  const whereClause =
    filters.length === 1 ? filters[0] : and(...filters);

  // 5. Fetch. Single round-trip; total derives from the returned length
  //    (no pagination, so a separate COUNT would be wasted I/O).
  const rows = await db
    .select()
    .from(documents)
    .where(whereClause)
    .orderBy(buildOrderBy(query));

  return {
    ok: true,
    rows,
    total: rows.length,
  };
}

// ── getDocumentDetail ───────────────────────────────────────────────────────

/**
 * Result payload for `getDocumentDetail`. Wraps the document row with
 * the human-friendly names of the uploader (always present) and the
 * reviewer (null when the document hasn't been reviewed yet).
 *
 * For company-role callers `reviewNotes` is stripped to null - reviewer
 * commentary is a staff-only field. See docs/08-rbac-matrix.md.
 */
export interface DocumentDetail {
  document: Document;
  uploaderName: string | null;
  reviewerName: string | null;
}

/**
 * Single-row fetch for the document detail view, with joined actor names
 * and company-role redaction.
 *
 * Implemented as a left-join against the users table for both `uploadedBy`
 * and `reviewedBy`. `uploadedBy` is NOT NULL at the schema level but we
 * still left-join so a deleted-uploader edge case (which the schema's
 * ON DELETE RESTRICT prevents today, but could change) yields `null`
 * instead of dropping the document row entirely. `reviewedBy` is nullable
 * by design (no review yet) and uses ON DELETE SET NULL.
 *
 * Failure modes:
 *   - Invalid input        -> ok:false, malformed UUID
 *   - Not signed in        -> ok:false
 *   - Document not found   -> ok:false (also covers cross-company access
 *                             for company-role to avoid enumeration)
 */
export async function getDocumentDetail(
  rawInput: unknown,
): Promise<ActionResult<DocumentDetail>> {
  // 1. Validate
  const parsed = documentByIdInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: "Invalid document id" };
  }
  const { documentId } = parsed.data;

  // 2. Session
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  // 3. Fetch the row with two aliased left-joins for the actor names.
  //    Drizzle's `alias()` would give us cleaner SQL, but a single
  //    Promise.all of three tiny queries against an indexed primary key
  //    is simpler to read and within Phase 1 budgets.
  const row = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!row) {
    return { ok: false, error: "Document not found" };
  }

  // 4. AuthZ. Same "not found" leak-protection shape as initiate/confirm.
  if (!sessionCanAccessDocumentForCompany(session, row.companyId)) {
    log.warn("document detail refused: cross-company access", {
      userId: session.userId,
      documentId,
      sessionCompanyId: session.companyId,
      documentCompanyId: row.companyId,
    });
    return { ok: false, error: "Document not found" };
  }

  // 5. Resolve actor names. Two separate point reads against the
  //    users-PK index; cheaper than a multi-join here because (a) we've
  //    already loaded the row, (b) reviewedBy is often null, and (c) this
  //    function runs on the detail view which isn't a hot path.
  const [uploader, reviewer] = await Promise.all([
    db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, row.uploadedBy))
      .limit(1)
      .then((r) => r[0] ?? null),
    row.reviewedBy
      ? db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, row.reviewedBy))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  // 6. Strip reviewer notes for company-role callers. Staff-only field.
  const document: Document =
    session.role === "company" ? { ...row, reviewNotes: null } : row;

  return {
    ok: true,
    document,
    uploaderName: uploader?.name ?? null,
    reviewerName: reviewer?.name ?? null,
  };
}

// ── generateDocumentDownloadUrl ─────────────────────────────────────────────

/**
 * Result payload for `generateDocumentDownloadUrl`. The client needs the
 * URL to navigate to (or fetch), the original filename to suggest as the
 * download attribute, and the mime type for any client-side preview
 * logic (e.g. inlining a PDF preview vs. linking to download).
 *
 * `expiresInSeconds` is echoed so the UI can render "this download link
 * expires in N seconds" if a long-lived UI is showing the URL.
 */
export interface DocumentDownloadUrlResult {
  url: string;
  expiresInSeconds: number;
  fileName: string;
  mimeType: string;
}

/**
 * Mint a presigned GET URL for a document, after RBAC-checking the
 * caller.
 *
 * Pipeline:
 *   1. Validate input
 *   2. Resolve session
 *   3. Load the document row (we need `fileKey` + `fileName` + `mimeType`
 *      + `companyId` for the auth gate)
 *   4. RBAC gate via `sessionCanAccessDocumentForCompany`
 *   5. Status gate: refuse `pending` rows. A `pending` row by definition
 *      has no bytes in R2 yet (confirm hasn't been called) so a
 *      presigned GET would 404. Surface a clearer error instead.
 *   6. Mint the URL via R2 client
 *   7. Return { url, expiresInSeconds, fileName, mimeType }
 *
 * Failure modes:
 *   - Invalid input          -> ok:false
 *   - Not signed in          -> ok:false
 *   - Document not found     -> ok:false (also covers cross-company)
 *   - Document in `pending`  -> ok:false "Upload not yet completed"
 *   - R2 signing fails       -> rethrows (500)
 */
export async function generateDocumentDownloadUrl(
  rawInput: unknown,
): Promise<ActionResult<DocumentDownloadUrlResult>> {
  // 1. Validate
  const parsed = documentByIdInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: "Invalid document id" };
  }
  const { documentId } = parsed.data;

  // 2. Session
  const session = await readSession();
  if (!session) {
    return { ok: false, error: "You must be signed in" };
  }

  // 3. Load the row. Single point-read on the PK index.
  const row = await db
    .select({
      id: documents.id,
      companyId: documents.companyId,
      fileKey: documents.fileKey,
      fileName: documents.fileName,
      mimeType: documents.mimeType,
      status: documents.status,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .then((rows) => rows[0]);

  if (!row) {
    return { ok: false, error: "Document not found" };
  }

  // 4. AuthZ. Same not-found-on-cross-company shape.
  if (!sessionCanAccessDocumentForCompany(session, row.companyId)) {
    log.warn("document download refused: cross-company access", {
      userId: session.userId,
      documentId,
      sessionCompanyId: session.companyId,
      documentCompanyId: row.companyId,
    });
    return { ok: false, error: "Document not found" };
  }

  // 5. Status gate. `pending` means initiate ran but confirm didn't -
  //    there's no object in R2 to download. Returning a presigned GET
  //    would surface as a confusing 404 from R2; surface the actual
  //    state instead.
  if (row.status === "pending") {
    return { ok: false, error: "Upload not yet completed" };
  }

  // 6. Mint the URL. If signing throws, let it bubble - the row is fine,
  //    the caller can retry.
  let presigned;
  try {
    presigned = await getPresignedGetUrl(row.fileKey);
  } catch (err) {
    log.error("generateDocumentDownloadUrl presign failed", {
      err,
      documentId,
      fileKey: row.fileKey,
      actorId: session.userId,
    });
    throw err;
  }

  log.info("document download url minted", {
    documentId,
    actorId: session.userId,
  });

  return {
    ok: true,
    url: presigned.url,
    expiresInSeconds: presigned.expiresInSeconds,
    fileName: row.fileName,
    mimeType: row.mimeType,
  };
}
